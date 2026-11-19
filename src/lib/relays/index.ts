/**
 * Rules for the relay list a user chooses, and a pre-flight check for a relay
 * a user wants to add. The list itself lives in the engine's settings
 * (Settings.relays, encrypted with the rest). The defaults were
 * chosen after testing each relay with the app's real traffic.
 *
 * The list applies to my own relay lists (kind 10002, 10050), my KeyPackage
 * and groups created from then on. A group keeps the relays it was created
 * with. While none of the chosen relays work, the default relays are used
 * instead unless the user turned that off (Settings.relayAuto).
 */
import { DEFAULT_RELAYS } from '../../contracts'
import { peerRelayUrl } from '../marmot/guard'

export const MIN_RELAYS = 2
export const MAX_RELAYS = 8

/** Below these, Marmot breaks in ways users cannot see (see RelayWarning). */
export const MIN_SUBSCRIPTIONS = 100
export const MIN_MESSAGE_BYTES = 131_072

const INFO_TIMEOUT_MS = 6_000

/**
 * Lowercase scheme and host, no trailing slash. Only wss:// is accepted,
 * except ws:// on localhost for development. Returns null if invalid.
 * Syntax only: a relay I choose must also pass the host rule (chosenRelayUrl).
 */
export function normalizeRelayUrl(input: string): string | null {
  let text = input.trim()
  if (!text) return null
  if (!/^[a-z][a-z0-9+.-]*:\/\//i.test(text)) text = `wss://${text}`
  let url: URL
  try {
    url = new URL(text)
  } catch {
    return null
  }
  const local = url.hostname === 'localhost' || url.hostname === '127.0.0.1' || url.hostname === '[::1]'
  const ipv6 = url.hostname.startsWith('[')
  if (url.protocol !== 'wss:' && !(url.protocol === 'ws:' && local)) return null
  if (url.username || url.password || url.search || url.hash) return null
  if (!url.hostname.includes('.') && !local && !ipv6) return null
  const path = url.pathname === '/' ? '' : url.pathname.replace(/\/+$/, '')
  return `${url.protocol}//${url.host.toLowerCase()}${path}`
}

/**
 * One relay address as I may choose it: normalized, and passing the same host
 * rule as a peer's relays (wss:// only, no user info, no IP
 * address, localhost, .local, .internal, .lan, .home.arpa or .onion, at most 200
 * characters). Null otherwise. An honest peer refuses an invitation to a room on
 * such a relay, so it would only break my connections.
 */
export function chosenRelayUrl(input: unknown): string | null {
  if (typeof input !== 'string') return null
  const url = normalizeRelayUrl(input)
  return url === null ? null : peerRelayUrl(url)
}

/**
 * Normalize a relay list: invalid and repeated addresses are dropped, and so
 * are addresses that fail the peer relay host rule (chosenRelayUrl). Order is
 * kept. Throws 'too-few-relays' / 'too-many-relays'. Returns null when the
 * list equals `defaults` as a set (the defaults are not stored as a choice).
 */
export function cleanRelayList(input: readonly unknown[], defaults: readonly string[]): string[] | null {
  const list = [...new Set(input.map(chosenRelayUrl).filter((v): v is string => v !== null))]
  if (list.length < MIN_RELAYS) throw new Error('too-few-relays')
  if (list.length > MAX_RELAYS) throw new Error('too-many-relays')
  return sameSet(list, defaults) ? null : list
}

/** True when the list is the default relays, in any order. */
export function isDefaultList(relays: readonly string[]): boolean {
  return sameSet(relays, DEFAULT_RELAYS)
}

/**
 * True when the list keeps at least one default relay. Without one, contacts
 * on the defaults reach me only through the indexer relays, which is slower
 * and can miss invitations.
 */
export function sharesDefault(relays: string[]): boolean {
  return relays.some((url) => DEFAULT_RELAYS.includes(url))
}

function sameSet(a: readonly string[], b: readonly string[]): boolean {
  const sa = new Set(a)
  const sb = new Set(b)
  return sa.size === sb.size && [...sa].every((v) => sb.has(v))
}

// ------------------------------------------------------------------ pre-flight

export type RelayWarning =
  /** NIP-11 not reachable: the relay may be down, or just not publish relay info. */
  | 'noInfo'
  /** Fewer than MIN_SUBSCRIPTIONS: some chats would silently stop receiving (one subscription per chat). */
  | 'fewSubscriptions'
  /** Smaller than MIN_MESSAGE_BYTES: large group invitations would be rejected. */
  | 'smallMessages'
  /** AUTH required: invitations cannot be read today, and the app key would be shown to the relay. */
  | 'authRequired'
  /** Paid relay: one-time keys used by Marmot cannot pay, so posts are rejected. */
  | 'paymentRequired'
  /** Writes restricted (allow-list, web of trust): one-time keys are rejected. */
  | 'restrictedWrites'

export interface RelayCheck {
  url: string
  /** NIP-11 was fetched. */
  reachable: boolean
  name: string | null
  software: string | null
  maxSubscriptions: number | null
  maxMessageLength: number | null
  warnings: RelayWarning[]
}

interface Nip11 {
  name?: unknown
  software?: unknown
  limitation?: {
    max_subscriptions?: unknown
    max_message_length?: unknown
    auth_required?: unknown
    payment_required?: unknown
    restricted_writes?: unknown
  }
}

/** The NIP-11 document is served over http(s) at the relay URL; CORS is mandatory (NIP-11). */
function infoUrl(relayUrl: string): string {
  return relayUrl.replace(/^ws(s?):\/\//, 'http$1://')
}

/**
 * Reads the relay's NIP-11 document and turns its limits into warnings.
 * Passing this check does not prove the relay accepts Marmot events: only
 * publishing does, and that is not done here.
 */
export async function checkRelay(url: string, fetchImpl: typeof fetch = fetch): Promise<RelayCheck> {
  const result: RelayCheck = {
    url,
    reachable: false,
    name: null,
    software: null,
    maxSubscriptions: null,
    maxMessageLength: null,
    warnings: [],
  }
  let info: Nip11
  try {
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), INFO_TIMEOUT_MS)
    try {
      const res = await fetchImpl(infoUrl(url), {
        headers: { Accept: 'application/nostr+json' },
        signal: controller.signal,
      })
      if (!res.ok) throw new Error(`HTTP ${res.status}`)
      info = (await res.json()) as Nip11
    } finally {
      clearTimeout(timer)
    }
  } catch {
    result.warnings.push('noInfo')
    return result
  }
  return { ...result, ...assessInfo(info), url, reachable: true }
}

/** Pure part of checkRelay, exported for tests. */
export function assessInfo(info: Nip11): Omit<RelayCheck, 'url' | 'reachable'> {
  const lim = info && typeof info === 'object' ? (info.limitation ?? {}) : {}
  const num = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) ? v : null)
  const maxSubscriptions = num(lim.max_subscriptions)
  const maxMessageLength = num(lim.max_message_length)
  const warnings: RelayWarning[] = []
  if (lim.auth_required === true) warnings.push('authRequired')
  if (lim.payment_required === true) warnings.push('paymentRequired')
  if (lim.restricted_writes === true) warnings.push('restrictedWrites')
  if (maxSubscriptions !== null && maxSubscriptions < MIN_SUBSCRIPTIONS) warnings.push('fewSubscriptions')
  if (maxMessageLength !== null && maxMessageLength < MIN_MESSAGE_BYTES) warnings.push('smallMessages')
  return {
    name: typeof info?.name === 'string' ? info.name.slice(0, 80) : null,
    software: typeof info?.software === 'string' ? info.software.slice(0, 120) : null,
    maxSubscriptions,
    maxMessageLength,
    warnings,
  }
}
