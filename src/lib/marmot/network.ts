import { verifyEvent, type NostrEvent } from 'applesauce-core/helpers/event'
import type { Filter } from 'applesauce-core/helpers/filter'
import { RelayPool } from 'applesauce-relay'
import type { AuthSigner, RelayAuthHandler } from 'applesauce-relay/types'
import {
  getInboxRelays,
  INBOX_RELAY_LIST_KIND,
  type NostrNetworkInterface,
  type PublishResponse,
  type Subscribable,
} from '@internet-privacy/marmot-ts'
import {
  EMPTY,
  Observable,
  ReplaySubject,
  Subscription,
  defer,
  filter,
  lastValueFrom,
  merge,
  repeat,
  retry,
  take,
  takeUntil,
  timer,
  toArray,
} from 'rxjs'
import type { RelayStatus } from '../../contracts'
import { errorText, log } from './log'

const PUBLISH_TIMEOUT_MS = 8_000
const REQUEST_TIMEOUT_MS = 8_000
/** One quick retry for a request that hit a dropped socket. */
const REQUEST_RECONNECT = { count: 1, delay: 400 }
/** After the first relay answered a lookup, how long to wait for the others. */
const LOOKUP_GRACE_MS = 1_000
/** How long an unreachable relay is skipped by one-shot operations. */
const RELAY_DOWN_MS = 10_000
const DEDUP_CAPACITY = 5_000

export type PublishResults = Record<string, PublishResponse>

export interface TolerantRequestResult {
  events: NostrEvent[]
  /** Relays that answered (possibly with nothing). */
  answered: string[]
  /** Relay -> error text for relays that failed or timed out. */
  failed: Record<string, string>
}

function unique(urls: string[]): string[] {
  return [...new Set(urls)]
}

/** One line per relay, for error messages and the smoke script. */
export function describePublish(results: PublishResults): string {
  const lines = Object.values(results).map(
    (r) => `${r.from}: ${r.ok ? 'ok' : `rejected${r.message ? ` (${r.message})` : ''}`}`,
  )
  return lines.length ? lines.join('; ') : 'no relay answered'
}

export function anyAccepted(results: PublishResults): boolean {
  return Object.values(results).some((r) => r.ok)
}

/**
 * marmot-ts network adapter over an applesauce-relay v7 pool.
 *
 * - `publish` returns a per-relay result map and resolves on the first relay
 *   that accepts the event (remaining relays keep going in the background).
 * - `request` rejects when a relay fails, closes the request or times out. An
 *   empty array therefore always means "the relay has nothing".
 * - `subscription` survives disconnects: every relay is re-subscribed forever
 *   with backoff, events are signature-checked and de-duplicated by id.
 * - NIP-42: a relay that answers `auth-required` is authenticated with the
 *   account key for that operation only.
 * - A relay that cannot be reached is skipped by publishes and requests for a
 *   few seconds (they fail at once instead of each waiting for a timeout),
 *   until it connects again. The live subscriptions keep retrying it.
 */
export class RelayNetwork implements NostrNetworkInterface {
  /** Relays used when a call names none, and for relay-list lookups. */
  readonly relays: string[]

  readonly #pool = new RelayPool()
  readonly #onAuthRequired: RelayAuthHandler
  readonly #closed$ = new ReplaySubject<void>(1)
  /** Relay url -> time until which it is treated as unreachable. */
  readonly #down = new Map<string, number>()
  #closed = false

  constructor(relays: string[], signer: AuthSigner) {
    this.relays = unique(relays)
    this.#onAuthRequired = async ({ relay }) => {
      if (this.#closed) throw new Error('transport is stopped')
      const response = await relay.authenticate(signer)
      log('relay asked for NIP-42 auth:', relay.url, response.ok ? 'ok' : 'rejected')
      if (!response.ok) throw new Error(response.message || 'relay authentication rejected')
    }
  }

  #targets(relays: string[]): string[] {
    return unique(relays.length ? relays : this.relays)
  }

  #isDown(url: string): boolean {
    const until = this.#down.get(url)
    if (until === undefined) return false
    if (Date.now() < until && !this.#pool.relay(url).connected) return true
    this.#down.delete(url)
    return false
  }

  /** Called after a failed operation; only a connection failure counts. */
  #noteFailure(url: string): void {
    if (!this.#closed && !this.#pool.relay(url).connected) {
      this.#down.set(url, Date.now() + RELAY_DOWN_MS)
    }
  }

  #publishOne(url: string, event: NostrEvent): Promise<PublishResponse> {
    if (this.#isDown(url)) {
      return Promise.resolve({ from: url, ok: false, message: 'relay unreachable' })
    }
    return Promise.resolve()
      .then(() =>
        this.#pool
          .relay(url)
          .publish(event, { onAuthRequired: this.#onAuthRequired, timeout: PUBLISH_TIMEOUT_MS }),
      )
      .then(
        (response): PublishResponse => ({ from: url, ok: response.ok, message: response.message }),
        (error: unknown): PublishResponse => {
          this.#noteFailure(url)
          return { from: url, ok: false, uncertain: true, message: errorText(error) }
        },
      )
  }

  /** Resolves on the first acceptance, or once every relay has answered. */
  publish(relays: string[], event: NostrEvent): Promise<PublishResults> {
    if (this.#closed) return Promise.reject(new Error('transport is stopped'))
    const targets = this.#targets(relays)
    const results: PublishResults = {}
    return new Promise<PublishResults>((resolve) => {
      const left = new Set(targets)
      if (!left.size) resolve({})
      for (const url of targets) {
        void this.#publishOne(url, event).then((response) => {
          results[url] = response
          left.delete(url)
          if (response.ok || !left.size) resolve({ ...results })
        })
      }
    })
  }

  /** Like {@link publish} but waits for every relay's verdict. */
  async publishAll(relays: string[], event: NostrEvent): Promise<PublishResults> {
    if (this.#closed) throw new Error('transport is stopped')
    const targets = this.#targets(relays)
    const responses = await Promise.all(targets.map((url) => this.#publishOne(url, event)))
    const results: PublishResults = {}
    targets.forEach((url, i) => (results[url] = responses[i]))
    return results
  }

  #requestOne(url: string, filters: Filter | Filter[]): Promise<NostrEvent[]> {
    if (this.#isDown(url)) return Promise.reject(new Error(`relay unreachable: ${url}`))
    const list = Array.isArray(filters) ? filters : [filters]
    // Bound memory against a relay that ignores `limit`.
    const limit = list.every((f) => f.limit !== undefined)
      ? list.reduce((sum, f) => sum + (f.limit ?? 0), 0)
      : Infinity
    return lastValueFrom(
      this.#pool
        .relay(url)
        .request(filters, {
          onAuthRequired: this.#onAuthRequired,
          timeout: REQUEST_TIMEOUT_MS,
          reconnect: REQUEST_RECONNECT,
        })
        .pipe(
          take(limit),
          toArray(),
          // Teardown must reject (EmptyError), never look like an empty relay.
          takeUntil(this.#closed$),
        ),
    ).catch((error: unknown) => {
      this.#noteFailure(url)
      throw error
    })
  }

  /** Strict one-shot query: rejects if any target relay fails. */
  async request(relays: string[], filters: Filter | Filter[]): Promise<NostrEvent[]> {
    if (this.#closed) throw new Error('transport is stopped')
    const targets = this.#targets(relays)
    const pages = await Promise.all(targets.map((url) => this.#requestOne(url, filters)))
    if (this.#closed) throw new Error('transport is stopped')
    return dedupeById(pages.flat())
  }

  /**
   * Lookup query for public events: succeeds when at least one relay answers.
   * Once one has, the others get LOOKUP_GRACE_MS more. Only events with a
   * valid signature are returned.
   */
  requestAny(relays: string[], filters: Filter | Filter[]): Promise<TolerantRequestResult> {
    if (this.#closed) return Promise.reject(new Error('transport is stopped'))
    const targets = this.#targets(relays)
    return new Promise<TolerantRequestResult>((resolve, reject) => {
      const result: TolerantRequestResult = { events: [], answered: [], failed: {} }
      const collected: NostrEvent[] = []
      let pending = targets.length
      let cancelGrace: (() => void) | undefined
      let done = false
      const finish = () => {
        if (done) return
        done = true
        cancelGrace?.()
        if (!result.answered.length) {
          const detail = Object.entries(result.failed)
            .map(([url, message]) => `${url}: ${message}`)
            .join('; ')
          reject(new Error(`no relay answered the request (${detail || 'no relays'})`))
          return
        }
        result.events = dedupeById(collected.filter((event) => safeVerify(event)))
        resolve(result)
      }
      if (!pending) finish()
      for (const url of targets) {
        this.#requestOne(url, filters).then(
          (events) => {
            if (done) return
            result.answered.push(url)
            collected.push(...events)
            if (--pending === 0) finish()
            else if (!cancelGrace) {
              const timer = setTimeout(finish, LOOKUP_GRACE_MS)
              cancelGrace = () => clearTimeout(timer)
            }
          },
          (error: unknown) => {
            if (done) return
            result.failed[url] = errorText(error)
            if (--pending === 0) finish()
          },
        )
      }
    })
  }

  subscription(relays: string[], filters: Filter | Filter[]): Subscribable<NostrEvent> {
    if (this.#closed) return EMPTY
    const targets = this.#targets(relays)
    return new Observable<NostrEvent>((subscriber) => {
      const seen = new Set<string>()
      const inner = merge(...targets.map((url) => this.#live(url, filters)))
        .pipe(takeUntil(this.#closed$))
        .subscribe({
          next: (event) => {
            // Verify before the id may occupy the dedup slot, so a forged copy
            // from one relay cannot censor the genuine event from another.
            if (seen.has(event.id) || !safeVerify(event)) return
            seen.add(event.id)
            if (seen.size > DEDUP_CAPACITY) {
              const oldest = seen.values().next()
              if (!oldest.done) seen.delete(oldest.value)
            }
            subscriber.next(event)
          },
          complete: () => subscriber.complete(),
        })
      return () => inner.unsubscribe()
    })
  }

  /** One relay's live feed, re-subscribed forever after errors and closes. */
  #live(url: string, filters: Filter | Filter[]): Observable<NostrEvent> {
    return defer(() =>
      this.#pool.relay(url).subscription(filters, { onAuthRequired: this.#onAuthRequired }),
    ).pipe(
      filter((message): message is NostrEvent => message !== 'EOSE'),
      retry({
        delay: (_error, count) => {
          this.#noteFailure(url)
          return timer(Math.min(count, 15) * 1000)
        },
        resetOnSuccess: true,
      }),
      repeat({ delay: 2_000 }),
    )
  }

  /**
   * Where `pubkey` receives gift-wrapped Welcomes: its kind 10050 list, looked
   * up on our relays. Falls back to our relays when it has none, which is
   * where every ilchon client listens.
   */
  async getUserInboxRelays(pubkey: string): Promise<string[]> {
    if (this.#closed) throw new Error('transport is stopped')
    try {
      const { events } = await this.requestAny(this.relays, {
        kinds: [INBOX_RELAY_LIST_KIND],
        authors: [pubkey],
      })
      const newest = newestBy(events.filter((event) => event.pubkey === pubkey))
      const inbox = newest ? getInboxRelays(newest) : []
      if (inbox.length) return inbox
    } catch {
      // fall through to our own relays
    }
    return this.relays
  }

  status(): RelayStatus[] {
    return this.relays.map((url) => ({ url, connected: this.#pool.relay(url).connected }))
  }

  /** Calls `cb` with the full status list whenever any relay connects or drops. */
  watchStatus(cb: (status: RelayStatus[]) => void): () => void {
    if (this.#closed) return () => {}
    const subscription = new Subscription()
    let last = ''
    const emit = () => {
      const status = this.status()
      const key = status.map((s) => (s.connected ? '1' : '0')).join('')
      if (key === last) return
      last = key
      cb(status)
    }
    for (const url of this.relays) {
      subscription.add(this.#pool.relay(url).connected$.subscribe(() => emit()))
    }
    return () => subscription.unsubscribe()
  }

  close(): void {
    if (this.#closed) return
    this.#closed = true
    this.#closed$.next()
    this.#closed$.complete()
    this.#pool.close()
  }
}

function safeVerify(event: NostrEvent): boolean {
  try {
    return verifyEvent(event)
  } catch {
    return false
  }
}

function dedupeById(events: NostrEvent[]): NostrEvent[] {
  const seen = new Set<string>()
  return events.filter((event) => (seen.has(event.id) ? false : (seen.add(event.id), true)))
}

export function newestBy(events: NostrEvent[]): NostrEvent | undefined {
  return events.reduce<NostrEvent | undefined>(
    (newest, event) => (!newest || event.created_at > newest.created_at ? event : newest),
    undefined,
  )
}
