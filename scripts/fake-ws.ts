/**
 * Test-only fake WebSocket and in-memory Nostr relays.
 * It sits below the real transport (src/lib/marmot): the real RelayNetwork, the
 * applesauce relay pool and marmot-ts run on it unchanged, without a network.
 * scripts/fake-transport.ts is the other fake, above the transport; they do not overlap.
 * Nothing under src/ imports this file.
 *
 *   installFakeWebSocket()   replaces globalThis.WebSocket until restore()
 *   relay(url)               the relay of that host: down()/up(), openDelay, refuse,
 *                            duplicateOk, what it got
 *
 * Hosts starting with "dead" fail at once (error, then an unclean close), like a
 * refused connection. Hosts starting with "silent" never answer: the socket stays
 * CONNECTING until it is closed, like a host that does not respond.
 *
 * The socket imitates only what rxjs `webSocket` uses: readyState, binaryType,
 * onopen/onmessage/onerror/onclose, send, close. Opening, messages and closing each
 * happen on a later macrotask. No signature check, no AUTH.
 */
import type { NostrEvent } from 'applesauce-core/helpers/event'
import { matchFilters, type Filter } from 'applesauce-core/helpers/filter'

export interface FakeRelay {
  /** Close every open socket uncleanly (code 1006) and fail new ones until up(). */
  down(): void
  up(): void
  /** New sockets open only after this many ms (default 0). */
  openDelay(ms: number): void
  /** Answer OK false ('blocked: test') to EVENTs of these kinds. */
  refuse(kinds: number[]): void
  /** OK flag of the answer to an event it already holds ('duplicate: …'). Default true; some relays say false. */
  duplicateOk(ok: boolean): void
  /** Every EVENT received, every REQ's filters, and how many sockets were opened so far. */
  readonly events: NostrEvent[]
  readonly reqs: Filter[][]
  readonly sockets: number
  /** Events stored now (after replacement of replaceable kinds). */
  readonly stored: NostrEvent[]
}

const CONNECTING = 0
const OPEN = 1
const CLOSING = 2
const CLOSED = 3

function later(fn: () => void, ms = 0): void {
  setTimeout(fn, ms)
}

function hostOf(url: string): string {
  try {
    return new URL(url).host.toLowerCase()
  } catch {
    return url.toLowerCase()
  }
}

class RelayState implements FakeRelay {
  readonly host: string
  readonly events: NostrEvent[] = []
  readonly reqs: Filter[][] = []
  sockets = 0
  stored: NostrEvent[] = []
  isDown = false
  delay = 0
  refused = new Set<number>()
  dupOk = true
  readonly open = new Set<FakeSocket>()

  constructor(host: string) {
    this.host = host
  }

  down(): void {
    this.isDown = true
    for (const s of [...this.open]) s.drop(1006)
  }
  up(): void {
    this.isDown = false
  }
  openDelay(ms: number): void {
    this.delay = Math.max(0, ms)
  }
  refuse(kinds: number[]): void {
    this.refused = new Set(kinds)
  }
  duplicateOk(ok: boolean): void {
    this.dupOk = ok
  }

  receive(socket: FakeSocket, msg: unknown): void {
    if (!Array.isArray(msg)) return
    const [type, ...rest] = msg as [string, ...unknown[]]
    if (type === 'EVENT') {
      const event = rest[0] as NostrEvent
      this.events.push(event)
      if (this.refused.has(event.kind)) {
        socket.reply(['OK', event.id, false, 'blocked: test'])
        return
      }
      if (this.stored.some((e) => e.id === event.id)) {
        socket.reply(['OK', event.id, this.dupOk, 'duplicate: already have it'])
        return
      }
      this.store(event)
      socket.reply(['OK', event.id, true, ''])
      for (const s of this.open) {
        for (const [subId, filters] of s.subs) if (matchFilters(filters, event)) s.reply(['EVENT', subId, event])
      }
      return
    }
    if (type === 'REQ') {
      const subId = String(rest[0])
      const filters = rest.slice(1) as Filter[]
      this.reqs.push(filters)
      const out = new Map<string, NostrEvent>()
      for (const f of filters) {
        const matching = this.stored.filter((e) => matchFilters([f], e)).sort((a, b) => b.created_at - a.created_at)
        for (const e of f.limit !== undefined ? matching.slice(0, f.limit) : matching) out.set(e.id, e)
      }
      for (const e of out.values()) socket.reply(['EVENT', subId, e])
      socket.reply(['EOSE', subId])
      socket.subs.set(subId, filters)
      return
    }
    if (type === 'CLOSE') socket.subs.delete(String(rest[0]))
  }

  /** Replaceable (0, 3, 10000-19999) and addressable (30000-39999) kinds keep the newest only. */
  store(event: NostrEvent): void {
    const k = event.kind
    const replaceable = k === 0 || k === 3 || (k >= 10_000 && k < 20_000)
    const addressable = k >= 30_000 && k < 40_000
    if (replaceable || addressable) {
      const d = (e: NostrEvent) => e.tags.find((t) => t[0] === 'd')?.[1] ?? ''
      this.stored = this.stored.filter((e) => !(e.kind === k && e.pubkey === event.pubkey && (!addressable || d(e) === d(event))))
    }
    this.stored.push(event)
  }
}

const relays = new Map<string, RelayState>()

function relayState(host: string): RelayState {
  let r = relays.get(host)
  if (!r) {
    r = new RelayState(host)
    relays.set(host, r)
  }
  return r
}

class FakeSocket {
  static readonly CONNECTING = CONNECTING
  static readonly OPEN = OPEN
  static readonly CLOSING = CLOSING
  static readonly CLOSED = CLOSED
  readonly CONNECTING = CONNECTING
  readonly OPEN = OPEN
  readonly CLOSING = CLOSING
  readonly CLOSED = CLOSED

  readonly url: string
  readonly protocol = ''
  readyState = CONNECTING
  binaryType = 'blob'
  onopen: ((ev: unknown) => void) | null = null
  onmessage: ((ev: { data: string }) => void) | null = null
  onerror: ((ev: unknown) => void) | null = null
  onclose: ((ev: { code: number; reason: string; wasClean: boolean }) => void) | null = null
  readonly subs = new Map<string, Filter[]>()
  readonly #relay: RelayState

  constructor(url: string) {
    this.url = url
    const host = hostOf(url)
    this.#relay = relayState(host)
    this.#relay.sockets++
    if (host.startsWith('silent')) return
    if (host.startsWith('dead') || this.#relay.isDown) {
      later(() => this.#fail())
      return
    }
    later(() => {
      if (this.readyState !== CONNECTING) return
      if (this.#relay.isDown) return this.#fail()
      this.readyState = OPEN
      this.#relay.open.add(this)
      this.onopen?.({ type: 'open' })
    }, this.#relay.delay)
  }

  #fail(): void {
    if (this.readyState === CLOSED) return
    this.readyState = CLOSED
    this.onerror?.({ type: 'error', message: 'connection refused' })
    this.onclose?.({ code: 1006, reason: '', wasClean: false })
  }

  /** The relay went away (unclean). */
  drop(code: number): void {
    if (this.readyState === CLOSED) return
    this.readyState = CLOSED
    this.#relay.open.delete(this)
    this.subs.clear()
    later(() => this.onclose?.({ code, reason: '', wasClean: false }))
  }

  reply(msg: unknown[]): void {
    const data = JSON.stringify(msg)
    later(() => {
      if (this.readyState === OPEN) this.onmessage?.({ data })
    })
  }

  send(data: string): void {
    if (this.readyState !== OPEN) throw new Error('fake socket is not open')
    let msg: unknown
    try {
      msg = JSON.parse(data)
    } catch {
      return
    }
    later(() => {
      if (this.readyState === OPEN) this.#relay.receive(this, msg)
    })
  }

  close(code = 1000, reason = ''): void {
    if (this.readyState === CLOSED || this.readyState === CLOSING) return
    this.readyState = CLOSED
    this.#relay.open.delete(this)
    this.subs.clear()
    later(() => this.onclose?.({ code, reason, wasClean: true }))
  }

  addEventListener(): void {}
  removeEventListener(): void {}
}

/** Replace globalThis.WebSocket. Hosts starting with "dead" fail at once (error, then close with wasClean false). */
export function installFakeWebSocket(): { relay(url: string): FakeRelay; restore(): void } {
  const g = globalThis as { WebSocket?: unknown }
  const original = g.WebSocket
  g.WebSocket = FakeSocket
  return {
    relay: (url: string) => relayState(hostOf(url)),
    restore: () => {
      g.WebSocket = original
    },
  }
}
