import { verifyEvent, type NostrEvent } from 'applesauce-core/helpers/event'
import type { Filter } from 'applesauce-core/helpers/filter'
import { RelayLiveness, RelayPool } from 'applesauce-relay'
import type { AuthSigner, RelayAuthHandler } from 'applesauce-relay/types'
import { getInboxRelays, INBOX_RELAY_LIST_KIND, type NostrNetworkInterface, type PublishResponse, type Subscribable } from '@internet-privacy/marmot-ts'
import {
  BehaviorSubject,
  EMPTY,
  Observable,
  ReplaySubject,
  Subject,
  Subscription,
  combineLatest,
  defer,
  filter,
  lastValueFrom,
  map,
  merge,
  race,
  repeat,
  retry,
  switchMap,
  take,
  tap,
  takeUntil,
  timer,
  toArray,
} from 'rxjs'
import type { RelayStatus } from '../../contracts'
import { filterPeerRelays } from './guard'
import { errorText, log, warn } from './log'

const PUBLISH_TIMEOUT_MS = 8_000
const REQUEST_TIMEOUT_MS = 8_000
/** One quick retry for a request that hit a dropped socket. */
const REQUEST_RECONNECT = { count: 1, delay: 400 }
/** After the first relay answered a lookup, how long to wait for the others. */
const LOOKUP_GRACE_MS = 1_000
/** After the grace period, how much longer a `waitFor` relay (an indexer) is awaited. */
const WAIT_FOR_MAX_MS = 3_000
/** How long an unreachable relay is skipped by one-shot operations. */
const RELAY_DOWN_MS = 10_000
const DEDUP_CAPACITY = 5_000
/**
 * A live subscription the relay closed is re-opened after 2 s, doubling up to
 * this cap while the relay keeps closing it without sending anything. Relays
 * that refuse a subscription (auth-required, restricted) otherwise get a
 * request every 2 s, which damus answered with an IP ban during testing.
 */
const RESUBSCRIBE_MIN_MS = 2_000
export const RESUBSCRIBE_MAX_MS = 5 * 60_000
/** A subscription that stayed open this long before a close counts as healthy. */
const HEALTHY_OPEN_MS = 60_000
/**
 * Connection errors: 1 s, 2 s ... up to this, so a dropped network recovers
 * quickly. Also the cap of every relay's own reconnect timer:
 * the library's default grows to 5 minutes, so after a long outage sockets
 * stayed closed for minutes once the internet was back.
 */
export const RECONNECT_MAX_MS = 15_000
/** applesauce-relay errors for a relay that refused the request (CLOSED with a prefix). */
const REFUSAL_ERRORS = new Set(['RelayClosedError', 'AuthRequiredError', 'AuthHandlerError', 'AuthTimeoutError'])

function isRefusal(error: unknown): boolean {
  return error instanceof Error && REFUSAL_ERRORS.has(error.name)
}

export type PublishResults = Record<string, PublishResponse>

export interface RequestAnyOptions {
  /**
   * Relays whose answer is awaited even after the grace period, e.g. indexer
   * relays that are reached cold while my own relays answer at once.
   */
  waitFor?: string[]
  /** Answer a relay's NIP-42 auth request. Default false. */
  auth?: boolean
  /** Skip the recent-failure list (#down): for the fallback probe. */
  ignoreDown?: boolean
}

/** NIP-42 is answered only where the request already shows my pubkey. */
export interface AuthOption {
  /**
   * True only for: my inbox subscription on my relays, publishing my own signed
   * lists and KeyPackage (kind 10002, 10050, 30443) to my relays, and reading
   * back my own events there. Anything else treats an auth request as a refusal:
   * answering would tie my pubkey to a room id or to the peer I invite.
   */
  auth?: boolean
}

export interface SubscriptionOptions extends AuthOption {
  /** Shape check run before the signature check; false drops the event (inboxPre). */
  pre?: (event: NostrEvent) => boolean
}

/** Wait before a relay's next connection attempt: 1.5^n s, at most RECONNECT_MAX_MS (15 s). */
export function reconnectDelay(attempts: number): number {
  return Math.min(1000 * 1.5 ** attempts, RECONNECT_MAX_MS)
}

export interface TolerantRequestResult {
  events: NostrEvent[]
  /** Relays that answered (possibly with nothing). */
  answered: string[]
  /** Relay -> error text for relays that failed or timed out. */
  failed: Record<string, string>
}

/** requestEach: each answering relay's signature-checked events, kept apart. */
export interface EachRequestResult {
  /** Relay -> its events (signature-checked, de-duplicated). Only relays in `answered`. */
  byRelay: Record<string, NostrEvent[]>
  /** Relays that answered in time (possibly with nothing). */
  answered: string[]
  /** Every relay the query went to. */
  asked: string[]
  /** Relay -> error text for relays that failed. Relays cut off by the wait rules are in neither list. */
  failed: Record<string, string>
}

function unique(urls: string[]): string[] {
  return [...new Set(urls)]
}

/** The key a relay url is remembered under (case and a trailing slash do not matter). */
function urlKey(url: string): string {
  return url.trim().toLowerCase().replace(/\/+$/, '')
}

/** One line per relay, for error messages and the smoke script. */
export function describePublish(results: PublishResults): string {
  const lines = Object.values(results).map((r) => `${r.from}: ${r.ok ? 'ok' : `rejected${r.message ? ` (${r.message})` : ''}`}`)
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
 *   account key only for an operation that passes `auth: true` (my inbox, my own
 *   signed events); for anything else the request counts as refused.
 * - Every relay reconnects at most 15 s apart, and at once when the page becomes
 *   visible or the browser comes online.
 * - A relay that cannot be reached is skipped by publishes and requests for a
 *   few seconds (they fail at once instead of each waiting for a timeout),
 *   until it connects again. The live subscriptions keep retrying it.
 */
export class RelayNetwork implements NostrNetworkInterface {
  /** Indexer relays, used only for relay-list lookups. */
  readonly lookupRelays: string[]

  // A socket a suspended phone left half-open never reports an error by itself.
  // Closing it ends its subscriptions, so #live opens fresh ones. keepAlive is 0
  // because, with pings on, the relay's message listeners end with a cleanly
  // closed socket but are only rebuilt once keepAlive passes with no subscriber.
  // Anything that rejoins sooner, a #live resubscribe or a one-shot publish or
  // request, keeps the dead listeners and never sees a reply. The next macrotask
  // is late enough for an AUTH retry, which rejoins within microtasks.
  readonly #pool = new RelayPool({ enablePing: true, onUnresponsive: () => 'close', keepAlive: 0 })
  readonly #onAuthRequired: RelayAuthHandler
  readonly #closed$ = new ReplaySubject<void>(1)
  /** Relay url -> time until which it is treated as unreachable. */
  readonly #down = new Map<string, number>()
  /** Fires to make every relay that waits to reconnect try now. */
  readonly #wake$ = new Subject<void>()
  /** My relays in use now (setRelays changes them). */
  readonly #relays$ = new BehaviorSubject<string[]>([])
  /** Relay url key -> when it last answered a publish or a request (ms). */
  readonly #answeredAt = new Map<string, number>()
  readonly #addSub: Subscription
  /**
   * Counts each relay's connection failures, but not while the page is hidden, the
   * browser is offline or within 15 s of coming back. Used for one
   * thing only: whether every chosen relay failed (the fallback rule). Its 'dead'
   * state, backoff and storage are not used.
   */
  readonly #liveness = new RelayLiveness()
  #unlisten: (() => void) | undefined
  #closed = false

  constructor(relays: string[], signer: AuthSigner, lookupRelays: string[] = []) {
    this.#relays$.next(unique(relays))
    this.lookupRelays = unique(lookupRelays)
    // Each relay the pool makes from now on gets the capped reconnect timer that
    // a wake ends early. Set before any relay exists.
    this.#addSub = this.#pool.add$.subscribe((relay) => {
      relay.reconnectTimer = (_error, attempts) => race(timer(reconnectDelay(attempts)), this.#wake$.pipe(map(() => 0)))
    })
    this.#liveness.connectToPool(this.#pool)
    if (typeof window !== 'undefined' && typeof document !== 'undefined') {
      const onOnline = () => this.wake()
      const onVisible = () => {
        if (document.visibilityState !== 'hidden') this.wake()
      }
      window.addEventListener('online', onOnline)
      document.addEventListener('visibilitychange', onVisible)
      this.#unlisten = () => {
        window.removeEventListener('online', onOnline)
        document.removeEventListener('visibilitychange', onVisible)
      }
    }
    this.#onAuthRequired = async ({ relay }) => {
      if (this.#closed) throw new Error('transport is stopped')
      const response = await relay.authenticate(signer)
      if (response.ok) log('relay asked for NIP-42 auth:', relay.url, 'ok')
      else warn('relay rejected authentication', relay.url)
      if (!response.ok) throw new Error(response.message || 'relay authentication rejected')
    }
  }

  /** My relays in use now: used when a call names none, and for relay-list lookups. */
  get relays(): string[] {
    return this.#relays$.value
  }

  /** Replace my relays in use. status() and watchStatus follow. */
  setRelays(relays: string[]): void {
    this.#relays$.next(unique(relays))
  }

  #targets(relays: string[]): string[] {
    return unique(relays.length ? relays : this.relays)
  }

  #noteAnswer(url: string): void {
    this.#answeredAt.set(urlKey(url), Date.now())
  }

  /** True when a socket to any of `urls` is open right now. */
  anyConnected(urls: string[]): boolean {
    if (this.#closed) return false
    return urls.some((url) => this.#pool.relay(url).connected)
  }

  /**
   * Resolves true as soon as a socket to any of `urls` is open, false after `ms`
   * or once the network is closed. Asking opens no socket by itself; the live
   * subscriptions (inbox, rooms) keep the sockets of my relays and room relays.
   */
  waitConnected(urls: string[], ms: number): Promise<boolean> {
    if (this.#closed || !urls.length) return Promise.resolve(false)
    if (this.anyConnected(urls)) return Promise.resolve(true)
    return new Promise<boolean>((resolve) => {
      let done = false
      const end = (value: boolean) => {
        if (done) return
        done = true
        clearTimeout(timeout)
        sub.unsubscribe()
        resolve(value)
      }
      const timeout = setTimeout(() => end(false), ms)
      const sub = new Subscription()
      sub.add(
        combineLatest(unique(urls).map((url) => this.#pool.relay(url).connected$)).subscribe((states) => {
          if (states.some(Boolean)) end(true)
        }),
      )
      sub.add(this.#closed$.subscribe(() => end(false)))
      if (done) sub.unsubscribe()
    })
  }

  /** True when one of `urls` answered a publish or a request at or after `since` (ms). */
  answeredSince(urls: string[], since: number): boolean {
    return urls.some((url) => (this.#answeredAt.get(urlKey(url)) ?? -Infinity) >= since)
  }

  /** Make every relay waiting to reconnect try now. */
  wake(): void {
    if (!this.#closed) this.#wake$.next()
  }

  /** Connection failures RelayLiveness counted for `url` (visible, online, past the return grace). */
  failures(url: string): number {
    return this.#liveness.getState(url)?.failureCount ?? 0
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

  #publishOne(url: string, event: NostrEvent, auth: boolean): Promise<PublishResponse> {
    if (this.#isDown(url)) {
      return Promise.resolve({ from: url, ok: false, message: 'relay unreachable' })
    }
    return Promise.resolve()
      .then(() => this.#pool.relay(url).publish(event, { onAuthRequired: auth ? this.#onAuthRequired : undefined, timeout: PUBLISH_TIMEOUT_MS }))
      .then(
        (response): PublishResponse => {
          // An OK frame, accepting or not: the relay answered.
          this.#noteAnswer(url)
          return { from: url, ok: response.ok, message: response.message }
        },
        (error: unknown): PublishResponse => {
          this.#noteFailure(url)
          return { from: url, ok: false, uncertain: true, message: errorText(error) }
        },
      )
  }

  /** Resolves on the first acceptance, or once every relay has answered. */
  publish(relays: string[], event: NostrEvent, opts: AuthOption = {}): Promise<PublishResults> {
    if (this.#closed) return Promise.reject(new Error('transport is stopped'))
    const targets = this.#targets(relays)
    const results: PublishResults = {}
    return new Promise<PublishResults>((resolve) => {
      const left = new Set(targets)
      if (!left.size) resolve({})
      for (const url of targets) {
        void this.#publishOne(url, event, opts.auth === true).then((response) => {
          results[url] = response
          left.delete(url)
          if (response.ok || !left.size) resolve({ ...results })
        })
      }
    })
  }

  /** Like {@link publish} but waits for every relay's verdict. */
  async publishAll(relays: string[], event: NostrEvent, opts: AuthOption = {}): Promise<PublishResults> {
    if (this.#closed) throw new Error('transport is stopped')
    const targets = this.#targets(relays)
    const responses = await Promise.all(targets.map((url) => this.#publishOne(url, event, opts.auth === true)))
    const results: PublishResults = {}
    targets.forEach((url, i) => (results[url] = responses[i]))
    return results
  }

  #requestOne(url: string, filters: Filter | Filter[], auth = false, ignoreDown = false): Promise<NostrEvent[]> {
    if (!ignoreDown && this.#isDown(url)) return Promise.reject(new Error(`relay unreachable: ${url}`))
    const list = Array.isArray(filters) ? filters : [filters]
    // Bound memory against a relay that ignores `limit`.
    const limit = list.every((f) => f.limit !== undefined) ? list.reduce((sum, f) => sum + (f.limit ?? 0), 0) : Infinity
    return lastValueFrom(
      this.#pool
        .relay(url)
        .request(filters, {
          onAuthRequired: auth ? this.#onAuthRequired : undefined,
          timeout: REQUEST_TIMEOUT_MS,
          reconnect: REQUEST_RECONNECT,
        })
        .pipe(
          take(limit),
          toArray(),
          // Teardown must reject (EmptyError), never look like an empty relay.
          takeUntil(this.#closed$),
        ),
    ).then(
      (events) => {
        this.#noteAnswer(url)
        return events
      },
      (error: unknown) => {
        this.#noteFailure(url)
        throw error
      },
    )
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
   * valid signature are returned. The relays' answers merged: {@link requestEach}.
   */
  async requestAny(relays: string[], filters: Filter | Filter[], options: RequestAnyOptions = {}): Promise<TolerantRequestResult> {
    const each = await this.requestEach(relays, filters, options)
    return { events: dedupeById(Object.values(each.byRelay).flat()), answered: each.answered, failed: each.failed }
  }

  /**
   * Like {@link requestAny} (same waiting rules, same signature check) but keeps each
   * relay's answer apart (the contact list is compared per relay).
   * `asked` is every relay the query went to; one in `asked` but not in `answered`
   * failed or did not answer in time. Rejects when no relay answered.
   */
  requestEach(relays: string[], filters: Filter | Filter[], options: RequestAnyOptions = {}): Promise<EachRequestResult> {
    if (this.#closed) return Promise.reject(new Error('transport is stopped'))
    const targets = this.#targets(relays)
    return new Promise<EachRequestResult>((resolve, reject) => {
      const result: EachRequestResult = { byRelay: {}, answered: [], asked: [...targets], failed: {} }
      const collected = new Map<string, NostrEvent[]>()
      let pending = targets.length
      const waiting = new Set((options.waitFor ?? []).filter((url) => targets.includes(url)))
      let graceOver = false
      let cancelGrace: (() => void) | undefined
      let done = false
      const settle = (url: string) => {
        waiting.delete(url)
        if (--pending === 0 || (graceOver && waiting.size === 0)) finish()
        else if (!cancelGrace && result.answered.length) {
          let cap: ReturnType<typeof setTimeout> | undefined
          const timer = setTimeout(() => {
            graceOver = true
            if (waiting.size === 0) finish()
            // A slow indexer must not add the full request timeout to every lookup.
            else cap = setTimeout(finish, WAIT_FOR_MAX_MS)
          }, LOOKUP_GRACE_MS)
          cancelGrace = () => {
            clearTimeout(timer)
            if (cap !== undefined) clearTimeout(cap)
          }
        }
      }
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
        for (const url of result.answered) {
          result.byRelay[url] = dedupeById((collected.get(url) ?? []).filter((event) => safeVerify(event)))
        }
        resolve(result)
      }
      if (!pending) finish()
      for (const url of targets) {
        this.#requestOne(url, filters, options.auth === true, options.ignoreDown === true).then(
          (events) => {
            if (done) return
            result.answered.push(url)
            collected.set(url, events)
            settle(url)
          },
          (error: unknown) => {
            if (done) return
            result.failed[url] = errorText(error)
            settle(url)
          },
        )
      }
    })
  }

  subscription(relays: string[], filters: Filter | Filter[], opts: SubscriptionOptions = {}): Subscribable<NostrEvent> {
    if (this.#closed) return EMPTY
    const targets = this.#targets(relays)
    const auth = opts.auth === true
    const pre = opts.pre
    return new Observable<NostrEvent>((subscriber) => {
      const seen = new Set<string>()
      const inner = merge(...targets.map((url) => this.#live(url, filters, auth)))
        .pipe(takeUntil(this.#closed$))
        .subscribe({
          next: (event) => {
            // The cheap shape check first, then verify before the id may occupy
            // the dedup slot, so a forged copy from one relay cannot censor the
            // genuine event from another.
            if (pre && !safePre(pre, event)) return
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
  #live(url: string, filters: Filter | Filter[], auth: boolean): Observable<NostrEvent> {
    // Clean closes (CLOSED without a prefix) in a row, each after a short life.
    let quietCloses = 0
    // Connection errors and refusals in a row, without any message in between.
    let failures = 0
    let refusals = 0
    let openedAt = 0
    return defer(() => {
      openedAt = Date.now()
      return this.#pool.relay(url).subscription(filters, { onAuthRequired: auth ? this.#onAuthRequired : undefined })
    }).pipe(
      // Any message, EOSE included, shows the connection works. A refusal
      // streak ends only on a real event or after a healthy open period, so a
      // relay that answers EOSE and then refuses is still asked rarely.
      tap((message) => {
        failures = 0
        if (message !== 'EOSE' || Date.now() - openedAt >= HEALTHY_OPEN_MS) refusals = 0
      }),
      filter((message): message is NostrEvent => message !== 'EOSE'),
      retry({
        delay: (error: unknown) => {
          this.#noteFailure(url)
          if (isRefusal(error)) {
            // The relay said no ('restricted:', 'auth-required:' ...): ask rarely.
            const ms = Math.min(RESUBSCRIBE_MIN_MS * 2 ** refusals, RESUBSCRIBE_MAX_MS)
            refusals++
            warn('relay refused a subscription, retrying in', ms, 'ms:', url, errorText(error))
            return timer(ms)
          }
          // Network trouble: come back quickly once it is over, at once on a wake.
          failures++
          return race(timer(Math.min(failures * 1000, RECONNECT_MAX_MS)), this.#wake$.pipe(map(() => 0)))
        },
      }),
      repeat({
        delay: () => {
          if (Date.now() - openedAt >= HEALTHY_OPEN_MS) quietCloses = 0
          const ms = Math.min(RESUBSCRIBE_MIN_MS * 2 ** quietCloses, RESUBSCRIBE_MAX_MS)
          quietCloses++
          if (quietCloses > 1) warn('relay keeps closing a subscription, retrying in', ms, 'ms:', url)
          return timer(ms)
        },
      }),
    )
  }

  /**
   * Where `pubkey` receives gift-wrapped Welcomes: its kind 10050 list, looked
   * up on our relays and the indexer relays, through filterPeerRelays (wss://
   * public hosts only, the first 4). Falls back to our relays
   * when nothing is left, which is where every ilchon client listens.
   */
  async getUserInboxRelays(pubkey: string): Promise<string[]> {
    if (this.#closed) throw new Error('transport is stopped')
    try {
      const { events } = await this.requestAny(unique([...this.relays, ...this.lookupRelays]), { kinds: [INBOX_RELAY_LIST_KIND], authors: [pubkey] }, { waitFor: this.lookupRelays })
      const newest = newestBy(events.filter((event) => event.pubkey === pubkey))
      const inbox = newest ? filterPeerRelays(getInboxRelays(newest)) : []
      if (inbox.length) return inbox
    } catch {
      // fall through to our own relays
    }
    return this.relays
  }

  status(): RelayStatus[] {
    return this.relays.map((url) => ({ url, connected: this.#pool.relay(url).connected }))
  }

  /**
   * Calls `cb` with the full status list whenever one of my relays connects or
   * drops, or the list itself changes (setRelays).
   */
  watchStatus(cb: (status: RelayStatus[]) => void): () => void {
    if (this.#closed) return () => {}
    let last = ''
    const emit = () => {
      const status = this.status()
      const key = status.map((s) => `${s.url}=${s.connected ? '1' : '0'}`).join('|')
      if (key === last) return
      last = key
      cb(status)
    }
    const subscription = this.#relays$.pipe(switchMap((urls) => (urls.length ? combineLatest(urls.map((url) => this.#pool.relay(url).connected$)) : timer(0)))).subscribe(() => emit())
    return () => subscription.unsubscribe()
  }

  close(): void {
    if (this.#closed) return
    this.#closed = true
    this.#unlisten?.()
    this.#unlisten = undefined
    this.#addSub.unsubscribe()
    this.#liveness.destroy()
    this.#closed$.next()
    this.#closed$.complete()
    this.#wake$.complete()
    this.#pool.close()
  }
}

function safePre(pre: (event: NostrEvent) => boolean, event: NostrEvent): boolean {
  try {
    return pre(event)
  } catch {
    return false
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
  return events.reduce<NostrEvent | undefined>((newest, event) => (!newest || event.created_at > newest.created_at ? event : newest), undefined)
}
