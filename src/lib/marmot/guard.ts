/**
 * Shape checks for what comes in from relays and peers, before anything costly
 * (signature check, decryption, storage). No DOM, no memory: pure functions, so
 * Node checks run them (scripts/check-guard.ts).
 */
import type { NostrEvent } from 'applesauce-core/helpers/event'

/**
 * How far back the inbox subscription asks (seconds), fixed. Longer than
 * channel's longest reopen interval (7 days) plus the gift wrap's random
 * back-dating (up to 2 days in NIP-59, an hour in the library) and a margin.
 * A remembered "last seen" time is not used: a relay I was not connected to
 * would then never send what it alone got.
 */
export const INBOX_SINCE_S = 8 * 24 * 60 * 60
/**
 * The largest content a NIP-44 gift wrap can have: the 65,535-byte plaintext
 * limit encrypted and base64'd is 87,472 characters; anything larger cannot be
 * well-formed.
 */
export const INBOX_MAX_CONTENT = 88_000
/** A wrap may claim a time up to this far in the future (clock skew). */
const INBOX_FUTURE_S = 600
/** A wrap may be this much older than INBOX_SINCE_S (back-dating). */
const INBOX_PAST_SLACK_S = 3_600

const HEX64 = /^[0-9a-f]{64}$/

/**
 * Whether a kind 1059 event for my inbox is worth checking at all. Runs before
 * the signature check and keeps no memory (duplicates are the network's job).
 */
export function inboxPre(event: NostrEvent, me: string, nowS: number): boolean {
  if (!event || event.kind !== 1059 || typeof event.id !== 'string' || !HEX64.test(event.id)) return false
  if (!Array.isArray(event.tags)) return false
  const p = event.tags.filter((tag) => Array.isArray(tag) && tag[0] === 'p')
  if (p.length !== 1 || p[0][1] !== me) return false
  if (typeof event.content !== 'string' || event.content.length > INBOX_MAX_CONTENT) return false
  const at = event.created_at
  if (typeof at !== 'number' || !Number.isFinite(at)) return false
  return at >= nowS - INBOX_SINCE_S - INBOX_PAST_SLACK_S && at <= nowS + INBOX_FUTURE_S
}

/** Host names that never belong to a public relay. */
const PRIVATE_SUFFIXES = ['.local', '.internal', '.lan', '.home.arpa', '.onion']
const MAX_URL = 200

/** True when `host` (a URL hostname) is an IP address, IPv4 or IPv6. */
function isIpHost(host: string): boolean {
  if (host.startsWith('[')) return true
  return /^\d{1,3}(\.\d{1,3}){3}$/.test(host) || (host.includes(':') && /^[0-9a-f:]+$/i.test(host))
}

/**
 * One relay address a peer (or a setting) gave, normalized, or null when it
 * fails the host rule: wss:// only, no user info, query or fragment, no IP
 * address, localhost or private suffix, at most 200 characters.
 */
export function peerRelayUrl(input: unknown): string | null {
  if (typeof input !== 'string' || input.length > MAX_URL) return null
  let url: URL
  try {
    url = new URL(input.trim())
  } catch {
    return null
  }
  if (url.protocol !== 'wss:') return null
  if (url.username || url.password || url.search || url.hash) return null
  const host = url.hostname.toLowerCase()
  if (!host || !host.includes('.') || isIpHost(host) || host === 'localhost' || host.endsWith('.localhost')) return null
  if (PRIVATE_SUFFIXES.some((s) => host.endsWith(s))) return null
  const path = url.pathname === '/' ? '' : url.pathname.replace(/\/+$/, '')
  const out = `wss://${url.host.toLowerCase()}${path}`
  return out.length <= MAX_URL ? out : null
}

/**
 * The relays of a peer's kind 10050 or 10002 list I am willing to use: those
 * that pass {@link peerRelayUrl}, without repeats, the first `max`. A list with
 * nothing left is empty; the caller then uses my own relays.
 */
export function filterPeerRelays(urls: readonly unknown[], max = 4): string[] {
  const out: string[] = []
  for (const u of urls) {
    const ok = peerRelayUrl(u)
    if (ok && !out.includes(ok)) out.push(ok)
    if (out.length >= max) break
  }
  return out
}

/** A room may list this many relays at most (as many as my own relay setting holds). */
export const ROOM_RELAYS_MAX = 8

/** What a Welcome says of its room, read before joining (marmot-ts previewWelcome's `group`). */
export interface RoomShape {
  name: string
  adminPubkeys: readonly string[]
  relays: readonly string[]
}

/**
 * Whether a Welcome's room looks like one an honest ilchon app makes, before joining
 * it: the inviter is its only admin, its name is `appName`,
 * and it lists 1 to {@link ROOM_RELAYS_MAX} relays that each pass the host rule of
 * {@link filterPeerRelays}. A room that fails is never joined, so my device never
 * connects to relays a peer picked outside that rule. `relayOk` replaces the host rule
 * (the test hub's `fake://` addresses).
 */
export function roomShapeOk(room: RoomShape | null | undefined, inviter: string, appName: string, relayOk: (url: string) => boolean = (url) => peerRelayUrl(url) !== null): boolean {
  if (!room || room.name !== appName) return false
  if (!Array.isArray(room.adminPubkeys) || room.adminPubkeys.length !== 1 || room.adminPubkeys[0] !== inviter) return false
  if (!Array.isArray(room.relays) || room.relays.length < 1 || room.relays.length > ROOM_RELAYS_MAX) return false
  return room.relays.every((url) => typeof url === 'string' && relayOk(url))
}
