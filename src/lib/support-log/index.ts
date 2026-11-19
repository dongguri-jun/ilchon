/**
 * The support log. No DOM:
 * Node checks run it (scripts/check-support-log.ts, scripts/check-engine.ts).
 *
 * What it is for: a user presses "Copy log" and sends the text when asking for help. It
 * holds technical facts only (app version, device, boot steps and times, relay
 * connections, failures and where they happened) and nothing about trades or people.
 *
 * Rules (this comment is the source of truth for them):
 * - Only the events below make a line. A contact appearing, being renamed or deleted,
 *   matching, offers and trade steps make none. Engine debug events go through
 *   ENGINE_LINES; an event missing from it is dropped.
 * - No value that points at another person, in any shape: pubkeys or a part of one,
 *   npub, names, group ids or a part of one, message ids, invite ids.
 * - 'every' lines: events that happen regardless of contacts (boot, relays, network,
 *   screen errors, a connection the user started). A repeat of the line just before
 *   folds into ` (xN)`; one text makes at most 50 lines a page session, the rest is
 *   only counted (`suppressed`).
 * - 'interval' lines: events that may happen once per message, room or contact (send
 *   failures, room-level transport warnings, task errors). A fixed text without values
 *   or counts, at most one line per text per 10 minutes, never folded. That window is
 *   longer than one message's resend chain (77 s), so a resend that a deleted contact
 *   stops and a live contact keeps hides inside it. "Save failed" is one line a page
 *   session.
 * - Values from outside (screen error messages, locations, the header) are scrubbed
 *   before they are kept; a stored line is already scrubbed. Text a relay or a library
 *   sent never goes in a line: it becomes one of the codes refused, timeout, closed,
 *   auth. Engine and transport error messages (invite, join, task errors, bootError)
 *   are not scrubbed but replaced: only a known head the app's own code wrote is kept
 *   (errorReason), everything after it becomes a code.
 * - Kept in plain text (the one exception to encrypted storage) as the last 1,000 lines in
 *   localStorage `<profile>:supportlog` (src/lib/support-log/browser.ts). It leaves
 *   the device only when the user copies it.
 */

export type Source = 'app' | 'boot' | 'relay' | 'net' | 'engine' | 'link' | 'marmot' | 'ui' | 'lock' | 'storage'
export type Bucket = 'link' | 'other'
export interface StorageLike {
  getItem(k: string): string | null
  setItem(k: string, v: string): void
  removeItem(k: string): void
}

/** Ten minutes: longer than one message's resend chain (SEND_RETRY_MS, 77 s in all). */
export const INTERVAL_MS = 600_000
/** Lines of one text a page session before they are only counted. */
const SAME_TEXT_MAX = 50
const DEFAULT_CAPACITY = 1000
const MAX_TEXT = 240
const MAX_SCREEN_ERROR = 120

// ---------------------------------------------------------------- buckets

/** Message types of linking (and, later, channel re-opening). */
const LINK_TYPES: ReadonlySet<string> = new Set(['hello'])

/** 'hello' (and the linking types channel adds) is 'link'; everything else 'other'. */
export function bucketOf(t: string): Bucket {
  return LINK_TYPES.has(t) ? 'link' : 'other'
}

// ---------------------------------------------------------------- scrub

/** Placeholders hide what an earlier rule produced from the later rules. No ASCII in them. */
const HOLE = ''

/**
 * A relay url as a label: scheme, host and a port that is not the default only. The
 * path, the query, the fragment and user info are dropped: a relay with a path per
 * user (`wss://r.example/<pubkey hex>`, `/npub1…`) would otherwise put that user's
 * key in the log. A host label that looks like a key or an id (bech32,
 * 8+ hex characters) becomes `<redacted>`/`<hex>`. Anything that is not a url
 * becomes `<relay>`.
 */
export function relayLabel(url: string): string {
  try {
    const u = new URL(url)
    if (u.hostname === '') return '<relay>'
    // URL already drops a default port (ws 80, wss 443); u.host keeps any other one.
    const host = u.host.replace(BECH32, '<redacted>').replace(HEX, '<hex>')
    return `${u.protocol}//${host}`
  } catch {
    return '<relay>'
  }
}

const BECH32 = /(?<![A-Za-z0-9])(?:(?:nsec|npub|nprofile|nevent|naddr|note|ncryptsec|lnurl|bcrt|bc|tb)1|ln(?:bcrt|tbs|tb|bc)\d*[munp]?1)[02-9ac-hj-np-z]{6,}/gi
const QR = /ilchon:[A-Za-z0-9_-]{20,}={0,2}/g
const WS_URL = /wss?:\/\/[^\s"'<>()]+/gi
const HTTP_URL = /https?:\/\/[^\s"'<>()]+/gi
const ADDRESS = /[A-Za-z0-9._%+-]+@[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)*\.[A-Za-z]{2,}/g
const BASE58 = /\b[123mn][1-9A-HJ-NP-Za-km-z]{25,34}\b/g
const B64 = /[A-Za-z0-9_-]{32,}={0,2}/g
const HEX = /[0-9a-fA-F]{8,}/g
const NUM_GROUP = /\d+(?:[.,-]\d+)+/g
const NUM = /\d{3,}/g
/**
 * Eight or more words of 3 to 8 letters in a row: the 12 words in any case, split by any
 * white space (line breaks, tabs, U+3000), with or without list numbers ("1. leader").
 */
const WORDS = /(?<![A-Za-z])(?:\d{1,2}[.)]\s*)?[A-Za-z]{3,8}(?:\s+(?:\d{1,2}[.)]\s*)?[A-Za-z]{3,8}){7,}(?![A-Za-z])/g

/**
 * Masks what a value from outside may carry (keys, the 12 words, amounts, accounts,
 * lightning addresses, invoices, QR content, urls). Rules in order; what one rule
 * produced (`<…>`, a relay label) is not touched by the later ones.
 * `digits: false` keeps numbers (the user agent: browser versions are the point).
 */
export function scrub(text: string, opts: { digits?: boolean; max?: number } = {}): string {
  const digits = opts.digits ?? true
  const max = opts.max ?? MAX_TEXT
  const kept: string[] = []
  const hold = (s: string) => {
    kept.push(s)
    return HOLE + String.fromCharCode(0xe100 + kept.length - 1) + HOLE
  }
  let s = String(text)
  // Urls first: run after another rule, the url pattern would swallow that rule's
  // placeholder and new URL() would percent-encode it (it can no longer be restored).
  s = s.replace(WS_URL, (u) => hold(relayLabel(u)))
  s = s.replace(HTTP_URL, () => hold('<url>'))
  s = s.replace(BECH32, () => hold('<redacted>'))
  s = s.replace(QR, () => hold('<redacted>'))
  s = s.replace(ADDRESS, () => hold('<address>'))
  s = s.replace(BASE58, () => hold('<redacted>'))
  s = s.replace(B64, () => hold('<b64>'))
  s = s.replace(HEX, () => hold('<hex>'))
  if (digits) {
    s = s.replace(NUM_GROUP, () => hold('<num>'))
    s = s.replace(NUM, () => hold('<num>'))
  }
  s = s.replace(WORDS, () => hold('<words>'))
  s = s.replace(new RegExp(`${HOLE}([\\uE100-\\uEFFF])${HOLE}`, 'g'), (_, c: string) => kept[c.charCodeAt(0) - 0xe100] ?? '')
  // Control characters would break the one-line format.
  s = s.replace(/[\u0000-\u001f\u007f]+/g, ' ')
  return s.length > max ? `${s.slice(0, max - 1)}…` : s
}

// ---------------------------------------------------------------- relay and library text

/** The fallback lines: fixed phrases, a code-made wait at most. */
const FALLBACK_PHRASES = [
  'relay fallback probe unanswered, retrying in',
  'relay fallback (unreachable)',
  'relay fallback (silent)',
  'relay fallback (refused)',
] as const

/**
 * Transport warnings about one relay (not about a room). Their numbers are code-made
 * (a wait in ms) and kept; a ws(s) url becomes its label; the literal 'ms:' stays ('ms'
 * when nothing follows it); any
 * other string is text a relay or library sent and becomes a code.
 */
const RELAY_PHRASES: ReadonlySet<string> = new Set([
  'relay rejected authentication',
  'relay refused a subscription, retrying in',
  'relay keeps closing a subscription, retrying in',
  'relay list on indexers failed',
  'key package spread failed',
  'KeyPackage rotation failed',
  // The online step of the start: the kind of failure, the wait.
  'relays unreachable, retrying in',
  'relays refused, retrying in',
  // The switch to the default relays: the probe's wait, the switch and why.
  ...FALLBACK_PHRASES,
])

/**
 * Relay-level phrases written under the source 'relay' (the start step and the
 * relays are `boot`/`relay` lines). The others stay under 'marmot'.
 */
const RELAY_SOURCE: ReadonlySet<string> = new Set(['relays unreachable, retrying in', 'relays refused, retrying in', ...FALLBACK_PHRASES])

/**
 * Room-level phrases about relays (a room's relays out of reach):
 * an interval line of the source 'relay', the phrase alone, no values or count.
 */
const RELAY_ROOM_PHRASES: ReadonlySet<string> = new Set(['room relays unreachable'])

/**
 * Transport warnings about the app's own failure (a broken store, a signing failure),
 * never a relay's: written with the app's error key, not a server code, so the line does
 * not read as the relay's fault.
 */
const LOCAL_PHRASES: ReadonlySet<string> = new Set(['online step failed'])

/**
 * Transport warnings for the development console only, never a line: 'inbox
 * replay' says that a message was handled again after a start, a per-message event.
 */
const QUIET_PHRASES: ReadonlySet<string> = new Set(['inbox replay'])

export type ServerCode = 'refused' | 'timeout' | 'closed' | 'auth'

/**
 * Text a relay or a library sent, as one of four codes; never the text itself.
 * NIP-01's machine prefixes decide first:
 * `auth-required:` is auth, any other prefix (`blocked:`, `rate-limited:`,
 * `restricted:`, `invalid:`, `error:` …) refused. Without one: a timeout, a closed
 * socket, or refused for anything else.
 */
export function serverCode(text: string, phrase = ''): ServerCode {
  if (phrase === 'relay rejected authentication') return 'auth'
  const t = text.trim().toLowerCase()
  if (t.startsWith('auth-required:')) return 'auth'
  if (/^[a-z][a-z-]*:/.test(t)) return 'refused'
  if (/time ?out|timed out/.test(t)) return 'timeout'
  if (/clos|disconnect|socket/.test(t)) return 'closed'
  return 'refused'
}

/** The words of a relay-level warning line, or null when the phrase is room-level. */
function relayWarning(phrase: string, values: readonly unknown[]): string | null {
  if (!RELAY_PHRASES.has(phrase)) return null
  const parts: string[] = [phrase]
  let code: ServerCode | null = phrase === 'relay rejected authentication' ? 'auth' : null
  // An Error object or any other string is relay or library text: only its code is kept.
  for (const v of values) {
    if (typeof v === 'number' && Number.isFinite(v)) parts.push(String(Math.round(v)))
    else if (v === 'ms:') parts.push('ms:')
    else if (typeof v === 'string' && /^wss?:\/\//i.test(v)) parts.push(relayLabel(v))
    else if (v instanceof Error) code ??= serverCode(v.message || v.name, phrase)
    else if (v !== undefined && v !== null && String(v) !== '') code ??= serverCode(String(v), phrase)
  }
  if (code) parts.push(`(${code})`)
  // 'ms:' introduces what follows (a relay, a code); with nothing after it the line ends in 'ms'.
  else if (parts[parts.length - 1] === 'ms:') parts[parts.length - 1] = 'ms'
  return parts.join(' ')
}

// ---------------------------------------------------------------- error messages

/**
 * Starts of error messages the app's own code writes (src/lib/marmot/transport.ts,
 * network.ts, src/engine/index.ts). Only these words are kept; whatever follows one
 * (a peer's relay hosts, a relay's reply, a part of a pubkey) is relay or library text.
 */
const ERROR_HEADS: readonly string[] = [
  'transport is stopped',
  'relay unreachable',
  'relay authentication rejected',
  'no relay answered the request',
  'relay list (kind',
  'KeyPackage could not be created',
  'KeyPackage is not available on any relay',
  'peer pubkey must be 64 lowercase hex',
  'cannot invite myself',
  'peer KeyPackage is not eligible',
  'no relay accepted the group commit',
  'Welcome was not delivered',
  'peer is not a member after the invite commit',
  'no KeyPackage found for peer',
  'invite not found',
  'Welcome is not for a two-member group with its inviter',
  'invite refused (shape)',
  'group is ',
  'no relay accepted the message',
  'at least one relay is required',
]

/** Whole messages that are the engine's own error keys. */
const ERROR_KEYS: ReadonlySet<string> = new Set([
  'profile-locked', 'reset-failed', 'halted', 'locked', 'not_ready', 'not-allowed', 'busy',
  'corrupt', 'identity-exists', 'reauth-required', 'invalid-mnemonic', 'not-prepared',
  'wrong-pin', 'pin-wait', 'weak-pin', 'storage-damaged', 'storage-unavailable',
  'invalid-choice', 'invalid_offer', 'invalid_amount', 'no_contact', 'no_offer',
  // Transport send guards.
  'offline', 'group-unreadable',
])

/**
 * The app's own error key among `values` (an Error or its message), or 'other' when none
 * is one: a local failure line carries only a key the app itself writes, never text.
 */
function appErrorKey(values: readonly unknown[]): string {
  for (const v of values) {
    const m = (v instanceof Error ? v.message : typeof v === 'string' ? v : '').trim()
    if (ERROR_KEYS.has(m)) return m
  }
  return 'other'
}

/**
 * An error message as the words a line may carry, with a leading separator:
 * `: <head of the app's own words>` and, when relay or library text followed it, ` (<code>)`;
 * for any other message only ` (<code>)`. The message text itself never goes in.
 */
export function errorReason(message: string): string {
  const m = String(message).trim()
  if (ERROR_KEYS.has(m)) return `: ${m}`
  const head = ERROR_HEADS.find((h) => m.startsWith(h))
  if (head === undefined) return ` (${serverCode(m.replace(WS_URL, ' '))})`
  const label = head === 'relay list (kind' ? 'relay list not accepted' : head === 'group is ' ? 'group not active' : head
  // What follows the head, without urls and the punctuation that joins it.
  const rest = m.slice(head.length).replace(WS_URL, ' ').replace(/^[\s:;,()]+/, '').trim()
  if (rest === '' || head === 'group is ' || head === 'relay unreachable') return `: ${label}`
  return `: ${label} (${serverCode(rest)})`
}

// ---------------------------------------------------------------- engine events

type Info = Record<string, string | number | boolean>
type Kind = 'every' | 'interval' | 'session'
export interface EngineLine {
  kind: Kind
  source: Source
  text: string
  /** Interval lines whose text carries a scrubbed value are limited by this fixed key. */
  key?: string
}

const str = (v: unknown) => (v === undefined || v === null ? '' : String(v))

/**
 * The allow list: engine debug events that make a line, and the fields each line may
 * use. `peer`, `from`, `me`, `key` and `t` themselves never reach a line. An event
 * missing here (rx, tx, tx-dropped, scan, invite, contact, match, ready, round-*,
 * hello-rejected, forget-failed, and every future one) makes no line. To add one:
 * a row here, its kind, and S-LOG-TWIN and S-LOG-REDACT in scripts/check-engine.ts.
 */
const ENGINE_LINES: Record<string, (info: Info) => EngineLine | null> = {
  // First tries only; resends, give-ups and stale drops make no line (a deleted
  // contact's queue goes stale while a live one keeps resending).
  'tx-failed': (i) => ({ kind: 'interval', source: 'engine', text: `send failing (${bucketOf(str(i.t))}), retrying` }),
  'persist-failed': () => ({ kind: 'session', source: 'engine', text: 'save failed' }),
  'task-error': (i) => ({ kind: 'interval', source: 'engine', text: `task error${errorReason(str(i.error))}`, key: 'task error' }),
  // Before the engine looks at who was scanned: the same for a stranger, a contact and a deleted one.
  'link-start': () => ({ kind: 'every', source: 'link', text: 'started' }),
  reconnected: () => ({ kind: 'every', source: 'relay', text: 'reconnected' }),
  // 'already' and every success make no line: they differ for a contact and a deleted one.
  'connect-failed': (i) =>
    i.errorKey === 'already' ? null : { kind: 'every', source: 'link', text: `failed: ${scrub(str(i.errorKey))}` },
  'invite-retry': () => ({ kind: 'every', source: 'link', text: 'invite retry' }),
  'invite-failed': (i) => ({ kind: 'every', source: 'link', text: `invite failed${errorReason(str(i.error))}` }),
  'accept-failed': (i) => ({ kind: 'every', source: 'link', text: `join failed${errorReason(str(i.error))}` }),
  'reset-failed': () => ({ kind: 'every', source: 'engine', text: 'reset failed' }),
  // Lock and storage events. Codes from fixed lists only; never a
  // table name, an entry name, a PIN, a key, a salt or a credential id.
  'unlock-failed': (i) => ({ kind: 'every', source: 'lock', text: `unlock failed: ${UNLOCK_ERRORS.has(str(i.errorKey)) ? str(i.errorKey) : 'other'}` }),
  'storage-damaged': (i) => ({ kind: 'every', source: 'storage', text: `damaged: ${DAMAGE_PLACES.has(str(i.errorKey)) ? str(i.errorKey) : 'app'}` }),
  'storage-unavailable': () => ({ kind: 'interval', source: 'storage', text: 'unavailable' }),
  // One contact's chat item: an event per contact, so a line without values.
  'room-damaged': () => ({ kind: 'interval', source: 'storage', text: 'room item damaged' }),
  // A received message stays in the inbox for the next start: no reason, no count.
  'inbox-kept': () => ({ kind: 'interval', source: 'engine', text: 'inbox kept' }),
  // Answer sessions over their bound were dropped: one sender's flood, so a line
  // without values: no sender, no count.
  'resp-capped': () => ({ kind: 'interval', source: 'engine', text: 'answer sessions capped' }),
  // Channel work: one event per peer, so lines without values. A failed
  // reopen, request or move join; a stranger's Welcome not kept.
  'chan-fail': () => ({ kind: 'interval', source: 'engine', text: 'channel reopen failing' }),
  'invite-buffer-full': () => ({ kind: 'interval', source: 'engine', text: 'invite buffer full' }),
  'invite-unbuffered': () => ({ kind: 'interval', source: 'engine', text: 'invite unbuffered' }),
  // Contact list sync: only the first run when the app opens, and only
  // a failure; no count, no relay, no digest. The runs of a change, retries and successes
  // make no line (they would show when contacts changed).
  'list-sync': (i) => {
    if (i.open !== true) return null
    if (i.result === 'unreachable') return { kind: 'interval', source: 'engine', text: 'contact list sync failed: no relay answered or accepted' }
    if (i.result === 'partial') return { kind: 'interval', source: 'engine', text: 'contact list sync incomplete' }
    if (i.result === 'too-big') return { kind: 'interval', source: 'engine', text: 'contact list too big to save' }
    return null
  },
  'list-copy-invalid': (i) => (i.open === true ? { kind: 'interval', source: 'engine', text: 'contact list copy could not be read' } : null),
  // Never whether a list was found: that tells whether there was any contact.
  'restore-check': (i) => ({ kind: 'every', source: 'engine', text: `restore check: ${RESTORE_CHECKS.has(str(i.result)) ? str(i.result) : 'other'}` }),
  // Bot-defense signals: fixed words, no numbers, from any run.
  'list-elsewhere': () => ({ kind: 'interval', source: 'engine', text: 'list changed elsewhere' }),
  'list-future': () => ({ kind: 'interval', source: 'engine', text: 'list future copy' }),
  'list-single': () => ({ kind: 'interval', source: 'engine', text: 'list single relay' }),
  // Key takeover: this key was restored on another device.
  'key-elsewhere': () => ({ kind: 'interval', source: 'engine', text: 'key used on another device' }),
}

/** restore-check results a line may show. */
const RESTORE_CHECKS: ReadonlySet<string> = new Set(['ok', 'network', 'invalid'])

/** errorKey values an unlock-failed line may show; anything else is 'other'. */
const UNLOCK_ERRORS: ReadonlySet<string> = new Set([
  'wrong-pin', 'pin-wait', 'passkey-cancelled', 'passkey-confirm', 'prf-unsupported', 'corrupt', 'storage-unavailable', 'storage-damaged',
])
/** Where stored data could not be read; anything else is 'app'. */
const DAMAGE_PLACES: ReadonlySet<string> = new Set(['memo', 'identity', 'app', 'lock', 'contact-list'])

/** Lines kept on disk at once (iOS may end the app before the one-second batch). */
const URGENT_EVENTS: ReadonlySet<string> = new Set(['reset-failed'])

/** An engine debug event as a line, or null when it is not on the allow list. */
export function engineLine(event: string, info?: Info): EngineLine | null {
  const row = Object.prototype.hasOwnProperty.call(ENGINE_LINES, event) ? ENGINE_LINES[event] : undefined
  return row ? row(info ?? {}) : null
}

// ---------------------------------------------------------------- the log

export interface SupportLog {
  /** An 'every' line. text is a fixed phrase of the code; only detail is scrubbed. */
  add(source: Source, text: string, detail?: string): void
  /** An 'interval' line. No values. The same key at most once per windowMs (default 10 min). */
  interval(source: Source, text: string, windowMs?: number, key?: string): void
  /** One line a page session. */
  oncePerSession(source: Source, text: string): void
  /** `--- <text>` (the page start mark). */
  marker(text: string): void
  engine(event: string, info?: Info): void
  /** A transport warn(phrase, ...values). */
  marmot(phrase: string, values: readonly unknown[]): void
  /** A screen or global error (120 characters of message). Written to storage at once. */
  error(where: 'screen' | 'error' | 'rejection', e: unknown, location?: string): void
  /** Synchronous: built without any await, so a copy can run inside the tap. */
  dump(header: Record<string, string>): string
  /** Writes the lines to storage now. Does nothing after clear(). */
  flush(): void
  /** Empties memory, removes the storage key and stops saving (a finished reset). */
  clear(): void
  /** Lines as they would be copied (tests). */
  lines(): string[]
  readonly size: number
  readonly suppressed: number
}

interface Entry {
  /** Rendered line without the fold count. */
  base: string
  /** source + text for folding; '' for lines read from storage and interval lines. */
  fold: string
  n: number
}

function iso(ms: number): string {
  return new Date(ms).toISOString().replace(/\.\d{3}Z$/, 'Z')
}

function render(e: Entry): string {
  return e.n > 1 ? `${e.base} (x${e.n})` : e.base
}

export function createSupportLog(opts: {
  capacity?: number
  now?: () => number
  storage?: StorageLike
  storageKey?: string
  onChange?: () => void
} = {}): SupportLog {
  const capacity = Math.max(1, opts.capacity ?? DEFAULT_CAPACITY)
  const now = opts.now ?? (() => Date.now())
  const storage = opts.storage
  const storageKey = opts.storageKey ?? 'supportlog'
  let entries: Entry[] = []
  let suppressed = 0
  let cleared = false
  const sameText = new Map<string, number>()
  const lastInterval = new Map<string, number>()
  const once = new Set<string>()

  const changed = () => {
    if (!cleared) opts.onChange?.()
  }
  const push = (e: Entry) => {
    entries.push(e)
    if (entries.length > capacity) entries = entries.slice(entries.length - capacity)
  }

  // Read once at start. Anything but an array of strings is thrown away.
  if (storage) {
    let raw: string | null = null
    try {
      raw = storage.getItem(storageKey)
    } catch {
      raw = null
    }
    if (raw !== null) {
      let ok = false
      try {
        const v = JSON.parse(raw) as unknown
        if (Array.isArray(v) && v.every((x) => typeof x === 'string')) {
          entries = (v as string[]).slice(-capacity).map((base) => ({ base, fold: '', n: 1 }))
          ok = true
        }
      } catch {
        ok = false
      }
      if (!ok) {
        entries = []
        push({ base: `${iso(now())}  app  support log was unreadable, started over`, fold: '', n: 1 })
      }
    }
  }

  function every(source: Source, text: string): void {
    const fold = `${source}\u0000${text}`
    const last = entries[entries.length - 1]
    if (last && last.fold === fold) {
      last.n++
      changed()
      return
    }
    const count = (sameText.get(fold) ?? 0) + 1
    sameText.set(fold, count)
    if (count > SAME_TEXT_MAX) {
      suppressed++
      return
    }
    push({ base: `${iso(now())}  ${source}  ${text}`, fold, n: 1 })
    changed()
  }

  function interval(source: Source, text: string, windowMs = INTERVAL_MS, key = text): void {
    const k = `${source}\u0000${key}`
    const t = now()
    const last = lastInterval.get(k)
    if (last !== undefined && t - last < windowMs) return
    lastInterval.set(k, t)
    push({ base: `${iso(t)}  ${source}  ${text}`, fold: '', n: 1 })
    changed()
  }

  function flush(): void {
    if (cleared || !storage) return
    const lines = entries.map(render)
    try {
      storage.setItem(storageKey, JSON.stringify(lines))
      return
    } catch {
      // Probably full: drop the older half and try once more.
    }
    entries = entries.slice(Math.floor(entries.length / 2))
    try {
      storage.setItem(storageKey, JSON.stringify(entries.map(render)))
    } catch {
      // Give this save up; the lines stay in memory.
    }
  }

  const log: SupportLog = {
    add(source, text, detail) {
      every(source, detail === undefined ? text : `${text}${scrub(detail)}`)
    },
    interval,
    oncePerSession(source, text) {
      const k = `${source}\u0000${text}`
      if (once.has(k)) return
      once.add(k)
      push({ base: `${iso(now())}  ${source}  ${text}`, fold: '', n: 1 })
      changed()
    },
    marker(text) {
      push({ base: `${iso(now())}  --- ${scrub(text, { digits: false })}`, fold: '', n: 1 })
      changed()
    },
    engine(event, info) {
      const line = engineLine(event, info)
      if (!line) return
      if (line.kind === 'every') every(line.source, line.text)
      else if (line.kind === 'interval') interval(line.source, line.text, INTERVAL_MS, line.key ?? line.text)
      else log.oncePerSession(line.source, line.text)
      if (URGENT_EVENTS.has(event)) flush()
    },
    marmot(phrase, values) {
      const p = String(phrase)
      if (QUIET_PHRASES.has(p)) return
      if (LOCAL_PHRASES.has(p)) {
        every('marmot', `${p}: ${appErrorKey(values)}`)
        return
      }
      if (RELAY_ROOM_PHRASES.has(p)) {
        interval('relay', p)
        return
      }
      const relay = relayWarning(p, values)
      if (relay !== null) every(RELAY_SOURCE.has(p) ? 'relay' : 'marmot', relay)
      // Room-level: the phrase alone (it is a fixed string of the code), no values.
      else interval('marmot', scrub(p, { digits: false }))
    },
    error(where, e, location) {
      const err = e instanceof Error ? e : null
      const name = scrub(err ? err.name || 'Error' : typeof e, { digits: false, max: 40 })
      const message = scrub(err ? err.message : String(e), { max: MAX_SCREEN_ERROR })
      const at = location ? ` (${scrub(location, { digits: false, max: 80 })})` : ''
      const head = where === 'screen' ? 'screen crashed' : where === 'rejection' ? 'unhandled rejection' : 'uncaught error'
      every(where === 'screen' ? 'ui' : 'app', `${head}: ${name}: ${message}${at}`)
      flush()
    },
    dump(header) {
      const h = (k: string, digits = true) => scrub(header[k] ?? 'unknown', { digits })
      const lines = entries.map(render)
      return [
        'ilchon support log',
        `app: ${h('app', false)}`,
        `time: ${h('time', false)}`,
        `browser: ${h('browser', false)}`,
        `installed: ${h('installed')}   lang: ${h('lang')}   online: ${h('online')}   storage persisted: ${h('storage persisted')}`,
        `lock: ${h('lock')}`,
        `boot: ${h('boot')}`,
        `relays: ${h('relays')}`,
        `log: ${lines.length} lines, ${suppressed} suppressed, redaction on`,
        '---',
        ...lines,
      ].join('\n')
    },
    flush,
    clear() {
      entries = []
      cleared = true
      try {
        storage?.removeItem(storageKey)
      } catch {
        // nothing more to do
      }
    },
    lines: () => entries.map(render),
    get size() {
      return entries.length
    },
    get suppressed() {
      return suppressed
    },
  }
  return log
}

// ---------------------------------------------------------------- engine store

interface StoreLike {
  getState(): { boot: string; bootError?: string; relays: readonly { url: string; connected: boolean }[] }
  subscribe(fn: () => void): () => void
}

/**
 * boot, bootError and relay changes as boot and relay lines. Takes the store by its
 * shape and never imports the engine. `sinceMs`: time since the page started.
 */
export function watchEngine(log: SupportLog, store: StoreLike, sinceMs: () => number): () => void {
  let boot = ''
  let bootError: string | undefined
  const relays = new Map<string, boolean>()
  const look = () => {
    const s = store.getState()
    if (s.boot !== boot || (s.boot === 'error' && s.bootError !== bootError)) {
      boot = s.boot
      bootError = s.bootError
      if (s.boot === 'error') {
        log.add('boot', `error${errorReason(s.bootError ?? 'unknown')}`)
        log.flush()
      } else {
        log.add('boot', `${s.boot} (+${Math.max(0, Math.round(sinceMs()))} ms)`)
      }
    }
    for (const r of s.relays) {
      if (relays.get(r.url) === r.connected) continue
      // A relay that first shows up disconnected is not news.
      if (!relays.has(r.url) && !r.connected) {
        relays.set(r.url, false)
        continue
      }
      relays.set(r.url, r.connected)
      log.add('relay', `${relayLabel(r.url)} ${r.connected ? 'connected' : 'disconnected'}`)
    }
  }
  look()
  return store.subscribe(look)
}
