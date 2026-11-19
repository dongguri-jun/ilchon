import type { Rumor } from 'applesauce-common/helpers/gift-wrap'
import { bytesToHex, getEventHash, type NostrEvent } from 'applesauce-core/helpers/event'
import { PrivateKeySigner } from 'applesauce-signers'
import {
  ADDRESSABLE_KEY_PACKAGE_KIND,
  INBOX_RELAY_LIST_KIND,
  NIP65_RELAY_LIST_KIND,
  MarmotClient,
  createApplicationMessageIntent,
  createInboxRelayListEvent,
  createInviteIntent,
  createNip65RelayListEvent,
  deserializeApplicationData,
  getGroupMemberPubkeys,
  getNip65Relays,
  unixNow,
  type DispositionedIngestResult,
  type ListedKeyPackage,
  type MarmotGroup,
  type UnreadInvite,
  type WelcomePreview,
  type Unsubscribable,
} from '@internet-privacy/marmot-ts'
import {
  APP_NAME,
  ILCHON_KIND,
  type GroupHealth,
  type IncomingInvite,
  type IncomingMessage,
  type InviteOptions,
  type ListFetch,
  type PubkeyHex,
  type RelayStatus,
  type Transport,
  type TransportOptions,
  type Unsub,
  type WireMessage,
} from '../../contracts'
import { createDurableInbox, type DurableInbox } from './durable-inbox'
import { filterPeerRelays, inboxPre, INBOX_SINCE_S, roomShapeOk } from './guard'
import { createInboxPump, type InboxPump } from './inbox'
import { isHex64, pubkeyOf, secretKeyBytes, short } from './keys'
import { fetchCopies, publishListEvent, sealList } from './list'
import { debugEnabled, errorText, log, warn } from './log'
import { RESUBSCRIBE_MAX_MS, RelayNetwork, anyAccepted, describePublish, newestBy, type PublishResults } from './network'
import { loadClientId, profileLockName, storesFrom, type MarmotStores } from './stores'
import { ReorderBuffers } from './reorder'
import { parseWireMessage } from './wire'

type Client = MarmotClient<undefined, undefined>
type Group = MarmotGroup<undefined, undefined>

/** Name of every ilchon group. Lives inside the encrypted group state. */
const GROUP_NAME = APP_NAME
/** Warning phrase and error of a Welcome whose room fails the pre-join check: no values. */
const INVITE_REFUSED_SHAPE = 'invite refused (shape)'

const SEND_TIMEOUT_MS = 30_000
const CATCH_UP_TIMEOUT_MS = 15_000
const SELF_UPDATE_TIMEOUT_MS = 20_000
/** How often and how long to wait for a peer's KeyPackage to show up. */
const KEY_PACKAGE_FETCH_TRIES = 4
/** Welcomes surfaced and not decided yet, at most; the oldest is marked read. */
const INVITES_MAX = 50
/** Welcome ids remembered as already seen in a session, at most (a ring). */
const KNOWN_INVITES_MAX = 5_000
const KEY_PACKAGE_FETCH_DELAY_MS = 1_500
/** Read-back attempts after publishing my own KeyPackage. */
const KEY_PACKAGE_CONFIRM_TRIES = 4
/** Republish a stored KeyPackage older than this (its lifetime is 84 days). */
const KEY_PACKAGE_MAX_AGE_S = 14 * 24 * 60 * 60
/**
 * Private material of a replaced KeyPackage is kept this long, because a
 * Welcome built against it may still be in flight.
 */
const KEY_PACKAGE_GRACE_MS = 10 * 60 * 1000
/** The connect screen reads my KeyPackage back at most this often. */
const KEY_PACKAGE_CHECK_MS = 10 * 60 * 1000
const STARTUP_CLEANUP_DELAY_MS = 3 * 60 * 1000
const SEEN_RUMOR_CAPACITY = 10_000
/*
 * Incoming messages of a group are collected for a moment and handed over sorted by the
 * sender's sequence tag, never held past INGEST_HOLD_MAX_MS while ingests go on: the
 * ReorderBuffers of ./reorder (REORDER_*).
 */
/** Rumor tag carrying the sender's strictly increasing sequence (unix ms). */
const SEQ_TAG = 'seq'
/** Backoff between attempts to connect (backfill + live subscribe) one group. */
const GROUP_CONNECT_RETRY_MS = [2_000, 5_000, 10_000, 30_000]

/** Live subscription of one group, kept until the group is detached or the transport stops. */
interface GroupConnection {
  controller: AbortController
  sub: Unsubscribable | undefined
  pending: boolean
  failures: number
}

/** How long start() waits for another holder of the profile to let go. */
const PROFILE_LOCK_WAIT_MS = 2_000

// ------------------------------------------------------------------ online step

/** Waits after an online attempt no relay answered, by failures in a row. */
export const ONLINE_RETRY_MS = [5_000, 15_000, 30_000, 60_000]
/** A woken wait still lasts this long, and a relay that connected during an attempt retries after it. */
export const ONLINE_RETRY_FLOOR_MS = 2_000
/** The first wait after my relays answered and refused; it doubles up to RESUBSCRIBE_MAX_MS. */
export const ONLINE_REFUSED_FIRST_MS = 60_000
/** A room message waits this long for a socket to one of the room's relays, before anything is encrypted. */
export const SEND_CONNECT_WAIT_MS = 8_000

/** Wait before the next online attempt. `count`: such failures in a row, from 1. */
export function onlineRetryWait(kind: 'unreachable' | 'refused', count: number, connectedDuringAttempt: boolean): number {
  if (kind === 'refused') return Math.min(ONLINE_REFUSED_FIRST_MS * 2 ** (Math.max(1, count) - 1), RESUBSCRIBE_MAX_MS)
  if (connectedDuringAttempt) return ONLINE_RETRY_FLOOR_MS
  return ONLINE_RETRY_MS[Math.min(Math.max(1, count), ONLINE_RETRY_MS.length) - 1]
}

// ------------------------------------------------------------------ room health

/** How often the transport looks at the relays of its rooms. */
export const HEALTH_TICK_MS = 2_000
/** A room whose relays were out of reach this long (visible, online, my relays up) is 'stranded'. */
export const STRANDED_MS = 90_000

/**
 * Time a group's relays have been out of reach while it mattered. Counts only
 * while the page is visible, the browser is online and one of my relays is
 * connected; a connection to any of the group's relays resets it.
 */
export function strandTick(ms: number, elapsedMs: number, v: { visible: boolean; online: boolean; mineUp: boolean; roomUp: boolean }): number {
  if (v.roomUp) return 0
  if (!v.visible || !v.online || !v.mineUp) return ms
  return ms + elapsedMs
}

// ------------------------------------------------------------------ fallback relays

/** None of the chosen relays had a socket this long (visible, online): try the fallback relays. */
export const FALLBACK_SILENT_MS = 20_000
/** Online attempts in a row my relays answered and refused: try the fallback relays. */
export const FALLBACK_REFUSED = 2
/** After a fallback relay answered: the chosen relays get this long to connect first. */
export const FALLBACK_CONFIRM_MS = 3_000
/**
 * At most this many fallback probes in any hour of a session.
 * Each probe shows my app pubkey and IP to every
 * fallback relay, so a relay that keeps connecting and dropping must not make it a
 * steady stream.
 */
export const FALLBACK_PROBES_PER_HOUR = 20
const HOUR_MS = 3_600_000

/**
 * When the next fallback probe may go out, set as a probe starts, whatever it finds.
 * `count`: probes in this session so far, this one included
 * (from 1). `recent`: the start times of the probes of the last hour, oldest first,
 * this one included. The waits are those of onlineRetryWait('unreachable'): 5, 15,
 * 30, 60 s, then 60 s; past FALLBACK_PROBES_PER_HOUR in an hour, the next waits
 * until the oldest of them is an hour old.
 */
export function nextFallbackProbeAt(now: number, count: number, recent: readonly number[]): number {
  const backoff = now + onlineRetryWait('unreachable', count, false)
  if (recent.length < FALLBACK_PROBES_PER_HOUR) return backoff
  return Math.max(backoff, recent[recent.length - FALLBACK_PROBES_PER_HOUR] + HOUR_MS)
}

/**
 * The silent time of the chosen relays after one settlement:
 * like strandTick, only time while the page is visible and online counts, with the
 * same capped `elapsedMs`; a hidden or offline page, or a connected chosen relay,
 * starts it again from zero.
 */
export function silentTick(ms: number, elapsedMs: number, v: { visible: boolean; online: boolean; chosenUp: boolean }): number {
  if (!v.visible || !v.online || v.chosenUp) return 0
  return ms + elapsedMs
}

/**
 * Whether to try the fallback relays. `chosen`: each chosen relay's socket
 * state and counted connection failures. `silentMs`: how long none of them had
 * a socket while the app was visible and online. `refusedInRow`: online
 * attempts in a row that my relays answered and refused.
 */
export function fallbackDue(chosen: { connected: boolean; failures: number }[], silentMs: number, refusedInRow: number): boolean {
  if (refusedInRow >= FALLBACK_REFUSED) return true
  if (!chosen.length || chosen.some((r) => r.connected)) return false
  return chosen.every((r) => r.failures >= 1) || silentMs >= FALLBACK_SILENT_MS
}

function sameSet(a: readonly string[], b: readonly string[]): boolean {
  const sa = new Set(a)
  const sb = new Set(b)
  return sa.size === sb.size && [...sa].every((v) => sb.has(v))
}

/**
 * The clock of the room health ticks. Only scripts/check-boot.ts replaces it, to
 * move time by hand; the app always uses the real one.
 */
export const healthClock = {
  now: (): number => Date.now(),
  /** Calls `tick` every `ms` until the returned function is called. */
  every(ms: number, tick: () => void): () => void {
    const timer = setInterval(tick, ms)
    return () => clearInterval(timer)
  },
}

/** No document (Node): visible. */
function pageVisible(): boolean {
  return typeof document === 'undefined' || document.visibilityState !== 'hidden'
}

/** No navigator or no onLine (Node): online. */
function browserOnline(): boolean {
  return typeof navigator === 'undefined' || (navigator as { onLine?: boolean }).onLine !== false
}

/** One wait of the online loop. */
export class Pause {
  readonly done: Promise<void>
  readonly #wakeable: boolean
  readonly #startedAt = Date.now()
  #end!: () => void
  #timer: ReturnType<typeof setTimeout> | undefined
  #ended = false

  /** `ms` may be Infinity: then only abort() ends it. */
  constructor(ms: number, wakeable: boolean) {
    this.#wakeable = wakeable
    this.done = new Promise<void>((resolve) => (this.#end = resolve))
    if (Number.isFinite(ms)) this.#timer = setTimeout(() => this.#finish(), Math.max(0, ms))
  }

  #finish(): void {
    if (this.#ended) return
    this.#ended = true
    if (this.#timer !== undefined) clearTimeout(this.#timer)
    this.#timer = undefined
    this.#end()
  }

  /** A relay connected: end at once, but not before ONLINE_RETRY_FLOOR_MS after the start. No-op unless wakeable. */
  wake(): void {
    if (!this.#wakeable || this.#ended) return
    const left = this.#startedAt + ONLINE_RETRY_FLOOR_MS - Date.now()
    if (left <= 0) return this.#finish()
    if (this.#timer !== undefined) clearTimeout(this.#timer)
    this.#timer = setTimeout(() => this.#finish(), left)
  }

  /** End now, whatever the kind: a relay switch or stop(). */
  abort(): void {
    this.#finish()
  }
}

/** A network failure of the online step: retried. Any other error there is local. */
class OnlineFailure extends Error {}

interface Deferred<T> {
  promise: Promise<T>
  resolve(value: T): void
  reject(error: unknown): void
}

function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void
  let reject!: (error: unknown) => void
  const promise = new Promise<T>((res, rej) => {
    resolve = res
    reject = rej
  })
  promise.catch(() => {})
  return { promise, resolve, reject }
}

/**
 * My two relay lists (10002, 10050) were taken: each accepted (or already held,
 * `duplicate:`) by one of `relays` at least. Otherwise refused when a relay said
 * no outright, unreachable when none answered.
 */
function listVerdict(results: PublishResults[]): 'accepted' | 'refused' | 'unreachable' {
  const taken = (r: PublishResults) => Object.values(r).some((x) => x.ok || (x.message ?? '').toLowerCase().startsWith('duplicate:'))
  if (results.every(taken)) return 'accepted'
  const refusal = results.some((r) => Object.values(r).some((x) => !x.ok && !x.uncertain && x.message !== 'relay unreachable'))
  return refusal ? 'refused' : 'unreachable'
}

/** The `meta` entry holding my last relay lists my relays took. */
const RELAY_LISTS_KEY = 'relay-lists'

/** My relay lists as last taken by my relays, kept so a start does not sign them again. */
export interface RelayListRecord {
  relays: string[]
  /** The signed kind 10002 and 10050 events, in this order. */
  events: NostrEvent[]
}

/**
 * The stored record (a JSON string in `meta`), or null when it cannot be used:
 * not JSON, `relays` not an array of strings, not exactly two events, an event
 * not mine, or the kinds not 10002 then 10050.
 */
export function parseRelayListRecord(raw: string | null | undefined, pubkey: string): RelayListRecord | null {
  if (typeof raw !== 'string') return null
  let value: unknown
  try {
    value = JSON.parse(raw)
  } catch {
    return null
  }
  if (!value || typeof value !== 'object') return null
  const { relays, events } = value as { relays?: unknown; events?: unknown }
  if (!Array.isArray(relays) || !relays.every((u) => typeof u === 'string')) return null
  if (!Array.isArray(events) || events.length !== 2) return null
  const kinds = [NIP65_RELAY_LIST_KIND, INBOX_RELAY_LIST_KIND]
  for (let i = 0; i < 2; i++) {
    const e = events[i] as Partial<NostrEvent> | null
    if (!e || typeof e !== 'object') return null
    if (e.pubkey !== pubkey || e.kind !== kinds[i]) return null
    if (typeof e.id !== 'string' || typeof e.sig !== 'string' || !Array.isArray(e.tags)) return null
    if (typeof e.created_at !== 'number' || !Number.isFinite(e.created_at)) return null
  }
  return { relays: relays as string[], events: events as NostrEvent[] }
}

/** 'rebroadcast' when the record names the same relays as `relays` (order aside), else 'sign'. */
export function relayListAction(record: RelayListRecord | null, relays: string[]): 'sign' | 'rebroadcast' {
  if (!record) return 'sign'
  const a = new Set(record.relays)
  const b = new Set(relays)
  return a.size === b.size && [...a].every((u) => b.has(u)) ? 'rebroadcast' : 'sign'
}

/**
 * `created_at` for newly signed lists: now, but always after the stored ones and
 * after a pair already signed in this session (`signed`) that never reached the
 * record, so a relay never keeps an older or abandoned list as the newer one when
 * the phone's clock is slow or two lists are signed within the same second.
 */
export function nextListCreatedAt(record: RelayListRecord | null, nowSec: number, signed?: RelayListRecord | null): number {
  const before = [record, signed].flatMap((r) => (r ? r.events.map((e) => e.created_at) : []))
  return before.length ? Math.max(nowSec, Math.max(...before) + 1) : nowSec
}

/**
 * The running transport of each profile in this document. Two transports on
 * the same stores would fork the MLS state, so a new one stops the old one
 * (this also covers a dev hot reload that drops the engine without stopping).
 */
const liveTransports = new Map<string, MarmotTransport>()

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

function withTimeout<T>(promise: Promise<T>, ms: number, what: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`${what} timed out after ${ms} ms`)), ms)
    promise.then(
      (value) => {
        clearTimeout(timer)
        resolve(value)
      },
      (error: unknown) => {
        clearTimeout(timer)
        reject(error)
      },
    )
  })
}

function newestPublished(pkg: ListedKeyPackage): NostrEvent | undefined {
  return newestBy(pkg.published ?? [])
}

/** The most recently published package in this device's slot, used or not. */
function newestInSlot(packages: ListedKeyPackage[], slot: string): ListedKeyPackage | undefined {
  let best: ListedKeyPackage | undefined
  let bestAt = -1
  for (const pkg of packages) {
    if (pkg.identifier !== slot) continue
    const at = newestPublished(pkg)?.created_at ?? -1
    if (at > bestAt) {
      best = pkg
      bestAt = at
    }
  }
  return best
}

function isUsable(pkg: ListedKeyPackage | undefined): pkg is ListedKeyPackage {
  if (!pkg || pkg.used || pkg.nonCurrent) return false
  const event = newestPublished(pkg)
  return !!event && unixNow() - event.created_at < KEY_PACKAGE_MAX_AGE_S
}

/**
 * One turn at a time per room, in call order. take() resolves once the room's turn is
 * mine; the function it gives returns it (once, however often called).
 */
export class RoomTurns {
  readonly #tails = new Map<string, Promise<void>>()

  async take(roomId: string): Promise<() => void> {
    const before = this.#tails.get(roomId) ?? Promise.resolve()
    let give!: () => void
    const mine = new Promise<void>((resolve) => (give = resolve))
    const tail = before.then(() => mine)
    this.#tails.set(roomId, tail)
    await before
    let given = false
    return () => {
      if (given) return
      given = true
      give()
      if (this.#tails.get(roomId) === tail) this.#tails.delete(roomId)
    }
  }
}

/**
 * marmot-ts 0.9.0 does not order an application message it prepares at once (the room
 * is settled) against an ingest of the same room that is applying a commit: the send can
 * store the state it started from over the new epoch. The member then stays an epoch
 * behind and can no longer read the other side (seen in check-boot B-INBOX: the joiner's
 * self-update was being ingested by the inviter while the inviter sent its first
 * messages, and the joiner's later reply was 'unreadable' for good). Every ingest of the
 * room (backfill, live and catch-up: the library's connect drains through group.ingest)
 * therefore takes the same turn as the transport's sends. Returns the undo.
 */
export function guardIngest<G extends { idStr: string; ingest: (...args: never[]) => AsyncGenerator<unknown, unknown, unknown> }>(
  group: G,
  turns: RoomTurns,
  span?: { start(): void; end(): void },
): () => void {
  const original = group.ingest
  const roomId = group.idStr
  const guarded = function (this: G, ...args: Parameters<G['ingest']>) {
    const self = this
    return (async function* () {
      const leave = await turns.take(roomId)
      span?.start()
      try {
        return yield* original.apply(self, args)
      } finally {
        leave()
        span?.end()
      }
    })()
  } as G['ingest']
  group.ingest = guarded
  return () => {
    if (group.ingest === guarded) group.ingest = original
  }
}

class MarmotTransport implements Transport {
  readonly pubkey: PubkeyHex

  /** My relays in use now: `#chosen`, then `#fallback` after a switch (a new array). */
  #relays: string[]
  /** Only for my contact list key (list.ts); everything else signs with #signer. */
  readonly #secretKeyHex: string
  /** The relays of the options (the user's choice or the defaults). */
  readonly #chosen: string[]
  /**
   * The fallback relays of the options through the peer relay host rule;
   * undefined when none are left or they are the chosen ones (no switch then).
   */
  readonly #fallback: string[] | undefined
  #fallingBack = false
  /**
   * How long none of the chosen relays had a socket while visible and online, settled
   * with the room times (silentTick), so time a phone slept is never counted.
   */
  #silentMs = 0
  #probing = false
  /** Fallback probes in this session, and the start times of those of the last hour. */
  #probes = 0
  #probeTimes: number[] = []
  #nextProbeAt = 0
  readonly #signer: PrivateKeySigner
  readonly #network: RelayNetwork
  readonly #stores: MarmotStores
  /** Identifies the stored state: one live transport and one tab at a time. */
  readonly #profile: string
  readonly #durable: boolean
  #releaseProfileLock: (() => void) | undefined

  #client: Client | undefined
  #slot: string | undefined
  /** The event id of my KeyPackage a relay served last (keyPackageRef, the QR's `kp`). */
  #kpRef: string | null = null
  /** When checkKeyPackage last read it back (at most once per KEY_PACKAGE_CHECK_MS). */
  #kpCheckedAt = 0
  /**
   * When keyUsedElsewhere last read my KeyPackages, per mode (at most once per
   * KEY_PACKAGE_CHECK_MS each): the start's full check must not skip the connect screen's
   * own-slot check, nor the other way round.
   */
  #elsewhereCheckedAt = { full: 0, ownSlot: 0 }
  /** Where fetchList asks for my contact list; my relays in use when absent. */
  readonly #contactListRelays: string[] | undefined
  readonly #kpRefCallbacks = new Set<() => void>()
  /** The whole start: local step, then the first successful online attempt. */
  #starting: Promise<Client> | undefined
  /** The local step of the current start attempt (send waits for this only). */
  #local: Promise<Client> | undefined
  #stopped = false

  /** Set once the local step loaded the stored groups (before: every group is 'missing'). */
  #groupsLoaded = false
  /** Stored groups that could not be loaded at start. Only forgetGroup removes one. */
  readonly #unreadable = new Set<string>()
  readonly #healthCallbacks = new Set<() => void>()
  /** Per loaded group: ms its relays were out of reach while it mattered (strandTick). In memory only. */
  readonly #strandMs = new Map<string, number>()
  #lastTick = 0
  /** Page state when the last tick or page event settled the time. */
  #pageSeen = { visible: true, online: true }
  #stopTicks: (() => void) | undefined
  #onlineDone: Deferred<void> | undefined
  #onlineSucceeded = false
  #pause: Pause | undefined
  #attempting = false
  #connectedDuringAttempt = false
  #unreachableInRow = 0
  #refusedInRow = 0
  #unreadChecked = false
  /** My relay lists signed this session, for the relays they name (signed once per list). */
  #signed: RelayListRecord | undefined
  #inboxPump: InboxPump | undefined

  #wired = false
  /** Set once start() reached the point where groups may connect to relays. */
  #connectEnabled = false
  readonly #connections = new Map<string, GroupConnection>()
  #unwatchStatus: (() => void) | undefined
  /** Cancel functions of pending timers. */
  readonly #timers = new Set<() => void>()

  readonly #inviteCallbacks = new Set<(invite: IncomingInvite) => void>()
  readonly #messageCallbacks = new Set<(message: IncomingMessage) => void | Promise<void>>()
  /** Welcomes surfaced but neither accepted nor ignored yet. */
  /**
   * Waiting Welcomes. `preview` is the one previewWelcome of a Welcome (the tag and
   * the pre-join room-shape check read the same decryption, once).
   */
  readonly #invites = new Map<string, { rumor: UnreadInvite; invite: IncomingInvite; preview?: Promise<WelcomePreview | null> }>()
  /** Invite ids already surfaced or dropped in this session; a ring of KNOWN_INVITES_MAX. */
  readonly #knownInvites = new Set<string>()
  readonly #accepting = new Map<string, Promise<{ groupId: string }>>()
  readonly #inviting = new Map<PubkeyHex, Promise<{ groupId: string }>>()

  /** Detach functions for the message listener of each loaded group. */
  readonly #attached = new Map<string, () => void>()
  readonly #seenRumors = new Set<string>()
  /** Per-group reorder buffer for incoming messages (./reorder). */
  readonly #reorder = new ReorderBuffers((message) => this.#deliver(message))
  /** Last sequence number I put on an outgoing message. */
  #lastSeq = 0
  /**
   * The rumor built for each message object. A retry of the same object is
   * the same rumor (same id), so the receiver drops a copy that got through
   * twice.
   */
  readonly #rumors = new WeakMap<WireMessage, Rumor>()
  /** Messages that arrived before any onMessage callback existed. */
  #undelivered: IncomingMessage[] = []
  /** Received messages kept until the engine handled them. */
  readonly #inbox: DurableInbox
  /** The stored inbox was delivered again in this instance (once). */
  #replayed = false
  /** Per-group send chain so messages leave in call order. */
  readonly #sendTails = new Map<string, Promise<void>>()
  /** Turns between my message sends and the library's ingest of each room ({@link guardIngest}). */
  readonly #turns = new RoomTurns()
  #rotation: Promise<void> = Promise.resolve()

  constructor(opts: TransportOptions) {
    if (!opts.relays.length) throw new Error('at least one relay is required')
    this.pubkey = pubkeyOf(opts.secretKeyHex)
    this.#chosen = [...new Set(opts.relays)]
    this.#relays = this.#chosen
    this.#secretKeyHex = opts.secretKeyHex
    const fallback = opts.fallbackRelays ? filterPeerRelays(opts.fallbackRelays) : []
    this.#fallback = fallback.length && !sameSet(fallback, this.#chosen) ? fallback : undefined
    this.#signer = new PrivateKeySigner(secretKeyBytes(opts.secretKeyHex))
    this.#network = new RelayNetwork(this.#relays, this.#signer, opts.lookupRelays ?? [])
    this.#contactListRelays = opts.listRelays?.length ? [...opts.listRelays] : undefined
    this.#stores = storesFrom(opts.tables)
    this.#inbox = createDurableInbox(this.#stores.inbox, { warn })
    this.#profile = profileLockName(opts.namespace, this.pubkey)
    this.#durable = opts.persistence === 'indexeddb'
  }

  /** My relays plus indexer relays: where my relay lists go and where peers' lists are looked up. */
  get #listRelays(): string[] {
    return [...new Set([...this.#relays, ...this.#network.lookupRelays])]
  }

  // ------------------------------------------------------------ lifecycle

  start(): Promise<void> {
    return this.#ready().then(() => undefined)
  }

  /** Starts once; a failed start can be retried by calling start() again. */
  #ready(): Promise<Client> {
    if (this.#stopped) return Promise.reject(new Error('transport is stopped'))
    if (!this.#starting) {
      const attempt = this.#start()
      this.#starting = attempt
      attempt.catch(() => {
        if (this.#starting === attempt) this.#starting = undefined
      })
    }
    return this.#starting
  }

  /** The stored groups are loaded (the local step is done). Starts the transport if needed. */
  #loaded(): Promise<Client> {
    void this.#ready().catch(() => {})
    return this.#local ?? Promise.reject(new Error('transport is stopped'))
  }

  /**
   * Local step, then the online loop until its first success.
   * Network trouble never rejects; local failures do.
   */
  #start(): Promise<Client> {
    const t0 = Date.now()
    // Made before anything awaits, so a stop() at any point of the local step (or
    // between its end and the online loop) has a wait to end.
    const done = (this.#onlineDone = deferred<void>())
    const local = this.#startLocal()
    this.#local = local
    local.catch(() => {})
    return local.then(async (client) => {
      this.#assertRunning()
      const slot = this.#slot as string
      void this.#runOnline(client, slot)
      await done.promise
      this.#assertRunning()
      log('started', 'ms:', Date.now() - t0)
      return client
    })
  }

  async #startLocal(): Promise<Client> {
    const previous = liveTransports.get(this.#profile)
    if (previous && previous !== this) await previous.stop()
    liveTransports.set(this.#profile, this)
    await this.#lockProfile()
    this.#assertRunning()

    const slot = (this.#slot ??= await loadClientId(this.#stores.meta))
    const client = (this.#client ??= new MarmotClient<undefined, undefined>({
      signer: this.#signer,
      network: this.#network,
      clientId: slot,
      groupStateStore: this.#stores.groups,
      keyPackageStore: this.#stores.keyPackages,
      inviteStore: this.#stores.invites,
      ingestStateStore: this.#stores.ingest,
      rewindStore: this.#stores.rewind,
      removedMarkerStore: this.#stores.removed,
    }))
    this.#wire(client)

    // Group listeners are attached by the `loaded` event before any relay
    // traffic is ingested, so backfilled messages are not missed. One group at
    // a time: a stored room that cannot be read is skipped (groupHealth
    // 'unreadable'), never the start. It is neither deleted nor
    // subscribed; the next start tries it again. No id, count or error text in
    // the log. listIds() itself failing is a broken store: local.
    const ids = await client.groups.listIds()
    const settled = await Promise.allSettled(ids.map((id) => client.groups.get(id)))
    this.#assertRunning()
    const groups: Group[] = []
    let skipped = false
    settled.forEach((result, i) => {
      if (result.status === 'fulfilled') return void groups.push(result.value)
      this.#unreadable.add(bytesToHex(ids[i]))
      skipped = true
    })
    if (skipped) warn('stored room could not be loaded')
    for (const group of groups) {
      this.#attach(group)
      if (group.status !== 'active') continue
      if (getGroupMemberPubkeys(group.state).length < 2) {
        // Left behind by an invite that never completed.
        await client.groups.destroy(group.id).catch((error: unknown) => {
          warn('could not remove unfinished group', errorText(error))
        })
        continue
      }
      // Finish a commit whose publication was interrupted by a reload.
      void group.retryPendingPublication().catch((error: unknown) => {
        warn('pending publication retry failed', errorText(error))
      })
    }
    this.#groupsLoaded = true
    // What the last session received and did not finish goes first, before any relay
    // traffic: the rooms are loaded, none is connected yet.
    await this.#replayInbox()
    this.#assertRunning()
    // Each group is connected by the transport itself and retried until it is
    // live: one failed backfill must not leave a contact deaf for the session.
    this.#connectEnabled = true
    for (const group of client.groups.loaded) this.#connectGroup(group)
    this.#unwatchStatus ??= this.#network.watchStatus((status) => {
      if (!status.some((relay) => relay.connected)) return
      this.#retryConnections()
      if (this.#attempting) this.#connectedDuringAttempt = true
      else this.#pause?.wake()
    })
    if (!this.#stopTicks) {
      this.#lastTick = healthClock.now()
      this.#pageSeen = { visible: pageVisible(), online: browserOnline() }
      const stopTicks = healthClock.every(HEALTH_TICK_MS, () => this.#tick())
      const stopWatch = this.#watchPage()
      this.#stopTicks = () => {
        stopTicks()
        stopWatch()
      }
      this.#timers.add(this.#stopTicks)
    }
    this.#healthChanged()
    return client
  }

  // ------------------------------------------------------------ online step

  /**
   * Repeats online attempts until the first succeeds (that resolves start()),
   * then waits for a relay switch or stop(). Network failures wait and
   * retry; a local failure before the first success rejects start().
   */
  async #runOnline(client: Client, slot: string): Promise<void> {
    for (;;) {
      if (this.#stopped) return
      const relays = this.#relays
      const startedAt = Date.now()
      this.#attempting = true
      this.#connectedDuringAttempt = false
      let result: 'ok' | 'stale' | 'local' | 'unreachable' | 'refused'
      try {
        result = await this.#onlineAttempt(client, slot, relays)
      } catch (error) {
        this.#attempting = false
        if (this.#stopped) return
        if (!(error instanceof OnlineFailure)) {
          if (!this.#onlineSucceeded) {
            this.#onlineDone?.reject(error)
            return
          }
          warn('online step failed', errorText(error))
          result = 'local'
        } else {
          result = this.#network.answeredSince(relays, startedAt) ? 'refused' : 'unreachable'
        }
      }
      this.#attempting = false
      if (this.#stopped) return
      if (this.#relays !== relays) continue
      switch (result) {
        case 'ok':
          this.#unreachableInRow = this.#refusedInRow = 0
          if (!this.#onlineSucceeded) {
            this.#onlineSucceeded = true
            this.#onlineDone?.resolve()
            this.#scheduleStartupCleanup(client, slot)
          }
          await this.#pauseFor(Infinity, false)
          break
        case 'stale':
          break
        case 'local':
          await this.#pauseFor(Infinity, false)
          break
        case 'unreachable': {
          this.#refusedInRow = 0
          const n = ++this.#unreachableInRow
          const ms = onlineRetryWait('unreachable', n, this.#connectedDuringAttempt)
          warn('relays unreachable, retrying in', ms, 'ms:')
          await this.#pauseFor(ms, true)
          break
        }
        case 'refused': {
          this.#unreachableInRow = 0
          const n = ++this.#refusedInRow
          const ms = onlineRetryWait('refused', n, false)
          warn('relays refused, retrying in', ms, 'ms:')
          await this.#pauseFor(ms, false)
          break
        }
      }
    }
  }

  async #pauseFor(ms: number, wakeable: boolean): Promise<void> {
    if (this.#stopped) return
    const pause = new Pause(ms, wakeable)
    this.#pause = pause
    await pause.done
    if (this.#pause === pause) this.#pause = undefined
  }

  /**
   * One online attempt on `relays` (the array in use when it began): listen to my
   * inbox, then get my relay lists and KeyPackage taken. 'stale' when the relays
   * were switched meanwhile.
   */
  async #onlineAttempt(client: Client, slot: string, relays: string[]): Promise<'ok' | 'stale'> {
    if (!this.#inboxPump) {
      const inbox = this.#listenInbox(client, relays)
      if (this.#stopped || this.#relays !== relays) {
        inbox.stop()
        return 'stale'
      }
      this.#inboxPump = inbox
    }
    if (!this.#unreadChecked) {
      this.#unreadChecked = true
      for (const rumor of await client.invites.getUnread()) void this.#onWelcome(rumor)
      this.#assertRunning()
    }
    await Promise.all([this.#ensureRelayLists(relays), this.#keyPackageInChain(client, slot)])
    this.#assertRunning()
    return this.#relays !== relays ? 'stale' : 'ok'
  }

  /**
   * My inbox, read by the app instead of the library's invites.listen:
   * kind 1059 for me on my relays, since a fixed 8 days, shape-checked before
   * the signature check, ingested one at a time, decrypted in one flight.
   */
  #listenInbox(client: Client, relays: string[]): InboxPump & { unsubscribe(): void } {
    const pump = createInboxPump(client.invites, {
      onError: (error) => log('invite could not be read:', errorText(error)),
    })
    const me = this.pubkey
    let dropped = { size: false, time: false, tags: false }
    let droppedAny = false
    const pre = (event: NostrEvent): boolean => {
      const nowS = unixNow()
      if (inboxPre(event, me, nowS)) return true
      // Which rule refused it, for the support log's line (names only).
      if (typeof event?.content === 'string' && event.content.length > 88_000) dropped.size = true
      else if (typeof event?.created_at === 'number' && (event.created_at > nowS + 600 || event.created_at < nowS - INBOX_SINCE_S - 3_600)) dropped.time = true
      else dropped.tags = true
      if (!droppedAny) {
        droppedAny = true
        // One interval line per batch; the reasons that happened, no counts.
        this.#later(1_000, async () => {
          const names = (Object.keys(dropped) as (keyof typeof dropped)[]).filter((k) => dropped[k])
          warn(`inbox dropped (${names.join(', ')})`)
          dropped = { size: false, time: false, tags: false }
          droppedAny = false
        })
      }
      return false
    }
    const sub = this.#network.subscription(relays, { kinds: [1059], '#p': [me], since: unixNow() - INBOX_SINCE_S }, { pre, auth: true }).subscribe({ next: (event) => pump.push(event) })
    pump.resume()
    return {
      push: pump.push,
      resume: pump.resume,
      stop: () => {
        pump.stop()
        sub.unsubscribe()
      },
      unsubscribe: () => {
        pump.stop()
        sub.unsubscribe()
      },
    }
  }

  /** The KeyPackage check rides the rotation chain so it never overlaps a rotation after a join. */
  #keyPackageInChain(client: Client, slot: string): Promise<void> {
    const run = this.#rotation.then(() => this.#ensureKeyPackage(client, slot, false))
    this.#rotation = run.catch(() => {})
    return run
  }

  /** Something may have changed groupHealth for some group. */
  #healthChanged(): void {
    for (const cb of this.#healthCallbacks) this.#call(cb, undefined)
  }

  fallingBack(): boolean {
    return this.#fallingBack
  }

  groupHealth(groupId: string): GroupHealth {
    if (this.#unreadable.has(groupId)) return 'unreadable'
    const client = this.#client
    if (!this.#groupsLoaded || !client) return 'missing'
    const group = client.groups.loaded.find((candidate) => candidate.idStr === groupId)
    if (!group || group.status !== 'active') return 'missing'
    if ((this.#strandMs.get(groupId) ?? 0) >= STRANDED_MS) return 'stranded'
    return 'ok'
  }

  /**
   * Every HEALTH_TICK_MS: the rooms' out-of-reach time with the page state now, then
   * the fallback watch.
   */
  #tick(): void {
    if (this.#stopped || !this.#client) return
    const page = { visible: pageVisible(), online: browserOnline() }
    this.#settle(page)
    this.#pageSeen = page
    this.#watchFallback(healthClock.now(), page)
  }

  /**
   * The page was hidden or shown, or the browser went offline or online: the time up to
   * now is settled with the state it had until now, and the next tick counts from here.
   * Without this, the first tick after a phone comes back (its timers slept) would add
   * the time it was hidden as visible time.
   */
  #onPageChange(): void {
    if (this.#stopped || !this.#client) return
    this.#settle(this.#pageSeen)
    this.#pageSeen = { visible: pageVisible(), online: browserOnline() }
  }

  /** Listens for page and network changes (none in Node). Returns the remover. */
  #watchPage(): () => void {
    const onChange = () => this.#onPageChange()
    const doc = typeof document !== 'undefined' && typeof document.addEventListener === 'function' ? document : undefined
    const win = typeof window !== 'undefined' && typeof window.addEventListener === 'function' ? window : undefined
    doc?.addEventListener('visibilitychange', onChange)
    win?.addEventListener('online', onChange)
    win?.addEventListener('offline', onChange)
    return () => {
      doc?.removeEventListener('visibilitychange', onChange)
      win?.removeEventListener('online', onChange)
      win?.removeEventListener('offline', onChange)
    }
  }

  /**
   * Adds the time since the last settlement (at most two ticks' worth, so a phone that
   * slept is not charged for its sleep) to every loaded, active group whose relays
   * are out of reach, counted with `page` (the state over that time), and tells
   * onGroupHealth when a group enters or leaves 'stranded'. The rooms are counted
   * alike whoever the peer is. The silent time of the chosen relays (fallback watch)
   * is settled here too, the same way.
   */
  #settle(page: { visible: boolean; online: boolean }): void {
    const client = this.#client
    if (this.#stopped || !client) return
    const now = healthClock.now()
    const elapsed = Math.max(0, Math.min(now - this.#lastTick, 2 * HEALTH_TICK_MS))
    this.#lastTick = now
    const { visible, online } = page
    if (this.#fallback && !this.#fallingBack) {
      this.#silentMs = silentTick(this.#silentMs, elapsed, { visible, online, chosenUp: this.#network.anyConnected(this.#chosen) })
    }
    const mineUp = this.#network.anyConnected(this.#relays)
    let changed = false
    let entered = false
    for (const group of client.groups.loaded) {
      if (group.status !== 'active') continue
      const id = group.idStr
      const before = this.#strandMs.get(id) ?? 0
      const relays = group.relays?.length ? group.relays : this.#relays
      const after = strandTick(before, elapsed, { visible, online, mineUp, roomUp: this.#network.anyConnected(relays) })
      if (after) this.#strandMs.set(id, after)
      else this.#strandMs.delete(id)
      const was = before >= STRANDED_MS
      const is = after >= STRANDED_MS
      if (was !== is) changed = true
      if (is && !was) entered = true
    }
    // An interval line of the support log: no room id, no count.
    if (entered) warn('room relays unreachable')
    if (changed) this.#healthChanged()
  }

  /**
   * The fallback watch, only while there are fallback relays and no
   * switch yet: when the chosen relays look gone (fallbackDue), ask a fallback relay
   * for my relay list. One answering means the internet works and only the chosen
   * relays do not.
   */
  #watchFallback(now: number, page: { visible: boolean; online: boolean }): void {
    const fallback = this.#fallback
    if (!fallback || this.#fallingBack || this.#stopped) return
    // #settle has just counted the silent time (zero while hidden or offline).
    if (!page.visible || !page.online) return
    if (this.#probing || now < this.#nextProbeAt) return
    const chosen = this.#chosen.map((url) => ({
      connected: this.#network.anyConnected([url]),
      failures: this.#network.failures(url),
    }))
    if (!fallbackDue(chosen, this.#silentMs, this.#refusedInRow)) return
    const reason: 'refused' | 'unreachable' | 'silent' = this.#refusedInRow >= FALLBACK_REFUSED ? 'refused' : chosen.every((r) => r.failures >= 1) ? 'unreachable' : 'silent'
    void this.#probeFallback(fallback, reason)
  }

  /**
   * One probe: asks every fallback relay for my relay list, which shows
   * them my app pubkey and IP. The next probe's time is set before it goes out, whether
   * it is answered or not (nextFallbackProbeAt): a chosen relay that connects and drops
   * again and again gets waits of 5, 15, 30, 60 s, at most FALLBACK_PROBES_PER_HOUR an
   * hour, instead of a probe every few seconds.
   */
  async #probeFallback(fallback: string[], reason: 'refused' | 'unreachable' | 'silent'): Promise<void> {
    this.#probing = true
    const at = healthClock.now()
    this.#probeTimes = [...this.#probeTimes.filter((t) => t > at - HOUR_MS), at]
    this.#nextProbeAt = nextFallbackProbeAt(at, ++this.#probes, this.#probeTimes)
    const waitMs = this.#nextProbeAt - at
    try {
      let answered = false
      try {
        // auth false: the probe reads a public list and shows no more than a lookup.
        await this.#network.requestAny(fallback, { kinds: [NIP65_RELAY_LIST_KIND], authors: [this.pubkey], limit: 1 }, { ignoreDown: true })
        answered = true
      } catch {
        // no fallback relay answered either
      }
      if (this.#stopped || this.#fallingBack) return
      if (!answered) {
        // My own internet: stay, and probe again at #nextProbeAt.
        warn('relay fallback probe unanswered, retrying in', waitMs, 'ms:')
        return
      }
      if (reason !== 'refused') {
        // The internet may have come back this moment: the chosen relays first.
        this.#network.wake()
        await this.#wait(FALLBACK_CONFIRM_MS)
        if (this.#stopped || this.#fallingBack) return
        if (this.#network.anyConnected(this.#chosen)) {
          // Back: no switch. The next probe still waits for #nextProbeAt.
          this.#silentMs = 0
          return
        }
      }
      this.#switchToFallback(reason)
    } finally {
      this.#probing = false
    }
  }

  /**
   * From now until stop(), my relays are the fallback relays: status, my lists, my
   * KeyPackage, the inbox and new rooms. Existing rooms keep their relays. Not stored:
   * the next start begins with the chosen relays again.
   */
  #switchToFallback(reason: 'refused' | 'unreachable' | 'silent'): void {
    const fallback = this.#fallback
    if (!fallback || this.#fallingBack || this.#stopped) return
    this.#fallingBack = true
    // A new array: an online attempt still on the old one sees it is stale.
    this.#relays = [...fallback]
    this.#network.setRelays(this.#relays)
    this.#inboxPump?.stop()
    this.#inboxPump = undefined
    this.#resyncAfterSwitch()
    warn(`relay fallback (${reason})`)
  }

  /**
   * After #relays changed (the switch): my relay list events, my KeyPackage and my
   * inbox are brought onto the new relays. The online loop does that (#onlineAttempt:
   * #ensureRelayLists and the KeyPackage check on the new array), so it runs again
   * now, whatever it was waiting for. The one place a relay change asks for it.
   */
  #resyncAfterSwitch(): void {
    this.#pause?.abort()
  }

  /** Resolves after `ms`, or at once on stop(). */
  #wait(ms: number): Promise<void> {
    return new Promise<void>((resolve) => {
      const done = () => {
        clearTimeout(timer)
        this.#timers.delete(done)
        resolve()
      }
      const timer = setTimeout(done, ms)
      this.#timers.add(done)
    })
  }

  onGroupHealth(cb: () => void): Unsub {
    this.#healthCallbacks.add(cb)
    return () => {
      this.#healthCallbacks.delete(cb)
    }
  }

  #assertRunning(): void {
    if (this.#stopped) throw new Error('transport is stopped')
  }

  /**
   * Hold a Web Lock for the stored profile while running, so a second browser
   * tab on the same profile fails to start instead of corrupting the state.
   */
  async #lockProfile(): Promise<void> {
    if (!this.#durable || this.#releaseProfileLock) return
    if (typeof navigator === 'undefined' || !navigator.locks) return
    const locks = navigator.locks
    const waiting = new AbortController()
    const giveUp = setTimeout(() => waiting.abort(), PROFILE_LOCK_WAIT_MS)
    try {
      await new Promise<void>((resolve, reject) => {
        locks
          .request(`ilchon-marmot:${this.#profile}`, { signal: waiting.signal }, () => {
            resolve()
            // Held until stop() calls the release function.
            return new Promise<void>((release) => {
              this.#releaseProfileLock = release
            })
          })
          .catch(reject)
      })
    } catch {
      // Stable message: the boot screen maps it to a localized explanation.
      throw new Error('profile-locked')
    } finally {
      clearTimeout(giveUp)
    }
    if (this.#stopped) this.#unlockProfile()
  }

  #unlockProfile(): void {
    this.#releaseProfileLock?.()
    this.#releaseProfileLock = undefined
  }

  /** Library event wiring; done once per transport. */
  #wire(client: Client): void {
    if (this.#wired) return
    this.#wired = true
    client.groups.on('loaded', this.#attach)
    client.groups.on('created', this.#attach)
    client.groups.on('joined', this.#attach)
    client.groups.on('imported', this.#attach)
    client.groups.on('unloaded', this.#detach)
    client.groups.on('destroyed', this.#detach)
    client.groups.on('left', this.#disconnect)
    client.groups.on('removed', this.#disconnect)
    client.groups.on('disbanded', this.#disconnect)
    // Room-level: no room id or reason in the warning (the support log keeps the phrase only).
    client.groups.on('unreadable', () => warn('group event could not be read'))
    client.groups.on('rejected', () => warn('group event rejected'))
    client.groups.on('ingestResult', (groupId, result) => {
      if (!debugEnabled()) return
      const detail = result.kind === 'processed' ? result.result.kind : 'reason' in result ? String(result.reason) : ''
      log('ingest', short(this.pubkey), short(bytesToHex(groupId)), result.kind, detail)
    })
    client.invites.on('decrypted', (rumor) => void this.#onWelcome(rumor))
    client.invites.on('error', (error) => log('invite could not be read:', error.message))
  }

  async stop(): Promise<void> {
    if (this.#stopped) return
    this.#stopped = true
    this.#healthCallbacks.clear()
    this.#onlineDone?.reject(new Error('transport is stopped'))
    this.#pause?.abort()
    for (const cancel of this.#timers) cancel()
    this.#timers.clear()
    this.#inboxPump?.stop()
    this.#inboxPump = undefined
    // The merged `__seen` write goes now, before the store may lose its key.
    void this.#stores.invites.flush().catch(() => {})
    this.#unwatchStatus?.()
    this.#unwatchStatus = undefined
    for (const conn of this.#connections.values()) this.#closeConnection(conn)
    this.#connections.clear()
    for (const detach of this.#attached.values()) detach()
    this.#attached.clear()
    this.#reorder.clear()
    const client = this.#client
    if (client) {
      client.groups.removeAllListeners()
      client.invites.removeAllListeners()
      for (const group of client.groups.loaded) group.dispose()
    }
    this.#network.close()
    this.#inviteCallbacks.clear()
    this.#messageCallbacks.clear()
    this.#unlockProfile()
    if (liveTransports.get(this.#profile) === this) liveTransports.delete(this.#profile)
    // Writes of the inbox end first (bounded): what was not handled stays for the next start.
    await this.#inbox.close()
  }

  relayStatus(): RelayStatus[] {
    return this.#network.status()
  }

  onRelayStatus(cb: (s: RelayStatus[]) => void): Unsub {
    return this.#network.watchStatus(cb)
  }

  // ------------------------------------------------------------ identity on relays

  /**
   * Kind 10002 (where my KeyPackage lives) and 10050 (where Welcomes go), taken
   * by `relays`. Signed only when the relays change: the pair my
   * relays last took is kept in `meta` and put again on every start, so the
   * lists' time does not show when the app was opened. A new pair is signed when
   * the stored one names other relays, cannot be read, or my relays refuse it
   * (another device may have put a newer one); at most once per relay list in a
   * session, and always dated after the stored pair. The indexers get the pair
   * only after my relays took it and only while those relays are still in use,
   * so a list no relay of mine took never reaches them.
   */
  async #ensureRelayLists(relays: string[]): Promise<void> {
    const record = parseRelayListRecord(await this.#stores.meta.getItem(RELAY_LISTS_KEY), this.pubkey)
    let events: NostrEvent[] | undefined
    if (relayListAction(record, relays) === 'rebroadcast' && record) {
      const verdict = await this.#putRelayLists(record.events, relays)
      log('relay list rebroadcast:', verdict)
      if (verdict === 'unreachable') throw new OnlineFailure('relay list was not accepted: unreachable')
      if (verdict === 'accepted') events = record.events
    }
    if (!events) {
      if (!this.#signed || relayListAction(this.#signed, relays) !== 'rebroadcast') {
        const created_at = nextListCreatedAt(record, unixNow(), this.#signed)
        const drafts = [
          { ...createNip65RelayListEvent({ pubkey: this.pubkey, relays }), created_at },
          { ...createInboxRelayListEvent({ pubkey: this.pubkey, relays }), created_at },
        ]
        const signed = await Promise.all(drafts.map((draft) => this.#signer.signEvent(draft)))
        this.#signed = { relays: [...relays], events: signed }
        log('relay list signed')
      }
      events = this.#signed.events
      const verdict = await this.#putRelayLists(events, relays)
      if (verdict !== 'accepted') throw new OnlineFailure(`relay list (kind ${events[0].kind}) was not accepted: ${verdict}`)
      if (this.#relays !== relays || this.#stopped) return
      await this.#stores.meta.setItem(RELAY_LISTS_KEY, JSON.stringify({ relays: [...relays], events }))
    }
    if (this.#relays !== relays || this.#stopped) return
    const indexers = this.#network.lookupRelays.filter((url) => !relays.includes(url))
    for (const event of indexers.length ? events : []) {
      void this.#network.publishAll(indexers, event).then(
        (results) => log('relay list', event.kind, 'on indexers:', describePublish(results)),
        (error: unknown) => warn('relay list on indexers failed', errorText(error)),
      )
    }
  }

  /**
   * Both lists to `relays` (signed by me: NIP-42 may be answered). Each resolves
   * at its first acceptance, so a relay that hangs does not hold the start; the
   * rest keep going in the background.
   */
  async #putRelayLists(events: NostrEvent[], relays: string[]): Promise<'accepted' | 'refused' | 'unreachable'> {
    const results = await Promise.all(events.map((event) => this.#network.publish(relays, event, { auth: true })))
    for (let i = 0; i < events.length; i++) log('relay list', events[i].kind, describePublish(results[i]))
    return listVerdict(results)
  }

  /**
   * Make sure one reusable KeyPackage for this device's slot is on the relays.
   * `fresh` forces a new package (rotation after a join).
   */
  async #ensureKeyPackage(client: Client, slot: string, fresh: boolean): Promise<void> {
    let pkg = fresh ? undefined : newestInSlot(await client.keyPackages.list(), slot)
    if (!isUsable(pkg)) {
      // Same slot: the relay replaces the previous event. The old private
      // material stays for a while (see #retireKeyPackages).
      const created = await client.keyPackages.create({ relays: [...this.#relays], identifier: slot })
      const ref = bytesToHex(created.keyPackageRef)
      pkg = (await client.keyPackages.list()).find((p) => bytesToHex(p.keyPackageRef) === ref)
    }
    const event = pkg ? newestPublished(pkg) : undefined
    if (!event) throw new Error('KeyPackage could not be created')
    // The QR names this one from now on (a rotation after a join replaces the previous
    // event on the relays: a QR naming that one could no longer be invited).
    this.#setKpRef(event.id)
    await this.#confirmKeyPackage(event, slot)
  }

  /**
   * Make sure every one of my relays holds the KeyPackage, not just the one
   * that answered first. After the relay list changes (an upgrade or a saved
   * custom list), an existing package may sit on only one of them. Relays that
   * already have it answer 'duplicate', which costs nothing.
   */
  #spreadKeyPackage(event: NostrEvent): void {
    void this.#network.publishAll(this.#relays, event, { auth: true }).then(
      (results) => log('key package on all relays:', describePublish(results)),
      (error: unknown) => warn('key package spread failed', errorText(error)),
    )
  }

  /**
   * marmot-ts records a KeyPackage as published even if every relay refused
   * it, so read it back and republish until a relay serves it.
   */
  async #confirmKeyPackage(event: NostrEvent, slot: string): Promise<void> {
    let problem = 'not found on any relay'
    for (let attempt = 0; attempt < KEY_PACKAGE_CONFIRM_TRIES; attempt++) {
      this.#assertRunning()
      try {
        const { events } = await this.#network.requestAny(this.#relays, { kinds: [ADDRESSABLE_KEY_PACKAGE_KIND], authors: [this.pubkey], '#d': [slot] }, { auth: true })
        if (events.some((found) => found.id === event.id)) {
          log('key package confirmed on relay', short(event.id))
          this.#setKpRef(event.id)
          this.#spreadKeyPackage(event)
          return
        }
      } catch (error) {
        problem = errorText(error)
      }
      try {
        const results = await this.#network.publishAll(this.#relays, event, { auth: true })
        log('key package publish:', describePublish(results))
        if (!anyAccepted(results)) problem = describePublish(results)
      } catch (error) {
        problem = errorText(error)
      }
      await sleep(400 * (attempt + 1))
    }
    // The last publish may have landed: read back once more before giving up.
    this.#assertRunning()
    try {
      const { events } = await this.#network.requestAny(this.#relays, { kinds: [ADDRESSABLE_KEY_PACKAGE_KIND], authors: [this.pubkey], '#d': [slot] }, { auth: true })
      if (events.some((found) => found.id === event.id)) {
        log('key package confirmed on relay', short(event.id))
        this.#setKpRef(event.id)
        return
      }
    } catch (error) {
      problem = errorText(error)
    }
    throw new OnlineFailure(`KeyPackage is not available on any relay: ${problem}`)
  }

  /** After a join consumed my package: publish a fresh one, retire the old later. */
  #rotateKeyPackage(): Promise<void> {
    const run = this.#rotation.then(async () => {
      const client = this.#client
      const slot = this.#slot
      if (this.#stopped || !client || !slot) return
      const before = await client.keyPackages.list()
      if (!newestInSlot(before, slot)?.used) return
      await this.#ensureKeyPackage(client, slot, true)
      this.#retireKeyPackages(
        client,
        before.map((pkg) => pkg.keyPackageRef),
        KEY_PACKAGE_GRACE_MS,
      )
    })
    this.#rotation = run.catch((error: unknown) => {
      warn('KeyPackage rotation failed', errorText(error))
    })
    return this.#rotation
  }

  /** Delete replaced private key material after `delayMs`. */
  #retireKeyPackages(client: Client, refs: Uint8Array[], delayMs: number): void {
    if (!refs.length) return
    this.#later(delayMs, async () => {
      for (const ref of refs) {
        await client.keyPackages.remove(ref).catch(() => {})
      }
    })
  }

  /** Packages replaced in an earlier session are retired once invites settled. */
  #scheduleStartupCleanup(client: Client, slot: string): void {
    void client.keyPackages
      .list()
      .then((packages) => {
        const current = newestInSlot(packages, slot)
        const stale = packages.filter((pkg) => pkg !== current).map((pkg) => pkg.keyPackageRef)
        this.#retireKeyPackages(client, stale, STARTUP_CLEANUP_DELAY_MS)
      })
      .catch(() => {})
  }

  #later(delayMs: number, work: () => Promise<void>): void {
    if (this.#stopped) return
    const cancel = () => clearTimeout(timer)
    const timer = setTimeout(() => {
      this.#timers.delete(cancel)
      if (!this.#stopped) void work().catch(() => {})
    }, delayMs)
    this.#timers.add(cancel)
  }

  // ------------------------------------------------------------ inviting

  keyPackageRef(): string | null {
    return this.#kpRef
  }

  onKeyPackageRef(cb: () => void): Unsub {
    this.#kpRefCallbacks.add(cb)
    return () => this.#kpRefCallbacks.delete(cb)
  }

  #setKpRef(id: string): void {
    if (this.#kpRef === id) return
    this.#kpRef = id
    for (const cb of this.#kpRefCallbacks) this.#call(cb, undefined)
  }

  /**
   * The connect screen: my KeyPackage must be readable by its reference (the QR's `kp`)
   * on my relays; #ensureKeyPackage reads it back and publishes it again when none
   * serves it. At most once per KEY_PACKAGE_CHECK_MS; never rejects.
   */
  async checkKeyPackage(): Promise<void> {
    const client = this.#client
    const slot = this.#slot
    if (!client || !slot || this.#stopped || Date.now() - this.#kpCheckedAt < KEY_PACKAGE_CHECK_MS) return
    this.#kpCheckedAt = Date.now()
    await this.#keyPackageInChain(client, slot).catch((error: unknown) => warn('KeyPackage check failed', errorText(error)))
  }

  async keyUsedElsewhere(sinceSec: number, opts: { ownSlotOnly?: boolean } = {}): Promise<boolean> {
    const client = this.#client
    const slot = this.#slot
    const mode = opts.ownSlotOnly ? 'ownSlot' : 'full'
    if (!client || !slot || this.#stopped || Date.now() - this.#elsewhereCheckedAt[mode] < KEY_PACKAGE_CHECK_MS) return false
    this.#elsewhereCheckedAt[mode] = Date.now()
    try {
      const mine = await client.keyPackages.list()
      // Every event this device published, and the newest one in its own slot.
      const madeHere = new Set(mine.flatMap((pkg) => (pkg.published ?? []).map((event) => event.id)))
      const own = newestInSlot(mine, slot)
      const ownAt = own ? (newestPublished(own)?.created_at ?? 0) : 0
      const { events } = await this.#network.requestAny(this.#relays, { kinds: [ADDRESSABLE_KEY_PACKAGE_KIND], authors: [this.pubkey], limit: 20 }, { auth: true })
      for (const event of events) {
        // Signatures were checked by the network; only my own key's packages count.
        if (event.pubkey !== this.pubkey || event.kind !== ADDRESSABLE_KEY_PACKAGE_KIND) continue
        const d = event.tags.find((tag) => tag[0] === 'd')?.[1]
        if (!d) continue
        if (d !== slot && !opts.ownSlotOnly && event.created_at > sinceSec) return true
        // My own slot holds a newer package this device never made.
        if (d === slot && !madeHere.has(event.id) && event.created_at > ownAt) return true
      }
      return false
    } catch (error) {
      log('key elsewhere check failed', errorText(error))
      return false
    }
  }

  invitePeer(peerPubkey: PubkeyHex, opts: InviteOptions = {}): Promise<{ groupId: string }> {
    if (!isHex64(peerPubkey)) return Promise.reject(new Error('peer pubkey must be 64 lowercase hex'))
    if (peerPubkey === this.pubkey) return Promise.reject(new Error('cannot invite myself'))
    if (opts.keyPackageRef !== undefined && !isHex64(opts.keyPackageRef)) return Promise.reject(new Error('key package reference must be 64 lowercase hex'))
    if (opts.tag !== undefined && !/^[0-9a-f]{32}$/.test(opts.tag)) return Promise.reject(new Error('tag must be 32 lowercase hex'))
    const running = this.#inviting.get(peerPubkey)
    if (running) return running
    const invite = this.#invitePeer(peerPubkey, opts).finally(() => {
      if (this.#inviting.get(peerPubkey) === invite) this.#inviting.delete(peerPubkey)
    })
    this.#inviting.set(peerPubkey, invite)
    return invite
  }

  async #invitePeer(peer: PubkeyHex, opts: InviteOptions): Promise<{ groupId: string }> {
    const client = await this.#ready()
    const candidates = await this.#fetchKeyPackages(peer, opts.keyPackageRef)

    // The tag rides in the encrypted group info (group.profile description), which the
    // peer reads before joining with previewWelcome.
    const group = await client.groups.create(GROUP_NAME, {
      relays: [...this.#relays],
      adminPubkeys: [this.pubkey],
      ...(opts.tag ? { description: opts.tag } : {}),
    })
    const groupId = group.idStr
    this.#hold(groupId)
    try {
      const reasons = new Set<string>()
      let chosen: NostrEvent | undefined
      for (const candidate of candidates) {
        const verdict = group.evaluateKeyPackage(candidate)
        if (verdict.eligible) {
          chosen = candidate
          break
        }
        for (const reason of verdict.reasons) reasons.add(reason)
      }
      if (!chosen) {
        throw new Error(`peer KeyPackage is not eligible: ${[...reasons].join('; ') || 'unknown reason'}`)
      }

      // One commit that adds the peer. The Welcome is gift-wrapped to the
      // peer's inbox relays only after a relay acknowledged the commit.
      const results = await client.groups.send(group.id, createInviteIntent({ keyPackageEvent: chosen, actorPubkey: this.pubkey }))
      if (!results.some((result) => anyAccepted(result.response))) {
        throw new Error('no relay accepted the group commit')
      }
      const outcomes = results.flatMap((result) => (result.welcomeDelivery.kind === 'attempted' ? result.welcomeDelivery.outcomes : []))
      const failures = outcomes.flatMap((outcome) => (outcome.kind === 'failed' ? [outcome.error] : []))
      const delivered = outcomes.some((outcome) => outcome.kind === 'succeeded' && anyAccepted(outcome.response))
      if (failures.length || !delivered) {
        throw new Error(`Welcome was not delivered: ${failures.join('; ') || 'no relay accepted it'}`)
      }
      if (!getGroupMemberPubkeys(group.state).includes(peer)) {
        throw new Error('peer is not a member after the invite commit')
      }
      log('invited', short(peer), 'into', short(groupId))
      this.#release(groupId)
      return { groupId }
    } catch (error) {
      this.#discard(groupId)
      await client.groups.destroy(group.id).catch(() => {})
      throw error
    }
  }

  /** The peer's kind 10002 write relays, or mine when it published none. */
  async #peerKeyPackageRelays(peer: PubkeyHex): Promise<string[]> {
    try {
      const { events } = await this.#network.requestAny(this.#listRelays, { kinds: [NIP65_RELAY_LIST_KIND], authors: [peer] }, { waitFor: this.#network.lookupRelays })
      const newest = newestBy(events.filter((event) => event.pubkey === peer))
      // A peer's list goes through the host rule first.
      const write = newest ? filterPeerRelays(getNip65Relays(newest, 'write')) : []
      if (write.length) return write
    } catch (error) {
      log('relay list lookup failed for', short(peer), errorText(error))
    }
    return this.#relays
  }

  /**
   * Always fetched from the relays at invite time. Newest first. With `ref` only the
   * event with that id (the QR's `kp`): a newer KeyPackage of the same key is never
   * taken instead, and none found after KEY_PACKAGE_FETCH_TRIES rejects.
   */
  async #fetchKeyPackages(peer: PubkeyHex, ref?: string): Promise<NostrEvent[]> {
    let problem = 'none published'
    for (let attempt = 0; attempt < KEY_PACKAGE_FETCH_TRIES; attempt++) {
      this.#assertRunning()
      if (attempt) await sleep(KEY_PACKAGE_FETCH_DELAY_MS)
      const relays = await this.#peerKeyPackageRelays(peer)
      try {
        const { events } = await this.#network.requestAny(relays, {
          kinds: [ADDRESSABLE_KEY_PACKAGE_KIND],
          authors: [peer],
        })
        const own = events
          .filter((event) => event.pubkey === peer && event.kind === ADDRESSABLE_KEY_PACKAGE_KIND)
          .filter((event) => ref === undefined || event.id === ref)
          .sort((a, b) => b.created_at - a.created_at)
        if (own.length) return own
        problem = ref === undefined ? 'none published' : 'the scanned one is not published'
      } catch (error) {
        problem = errorText(error)
      }
    }
    throw new Error(`no KeyPackage found for peer ${short(peer)}: ${problem}`)
  }

  // ------------------------------------------------------------ being invited

  onInvite(cb: (invite: IncomingInvite) => void): Unsub {
    this.#inviteCallbacks.add(cb)
    // A late subscriber still learns about Welcomes that are waiting.
    const waiting = [...this.#invites.values()].map((entry) => entry.invite)
    if (waiting.length) {
      queueMicrotask(() => {
        if (!this.#inviteCallbacks.has(cb)) return
        for (const invite of waiting) if (this.#invites.has(invite.id)) this.#call(cb, invite)
      })
    }
    return () => {
      this.#inviteCallbacks.delete(cb)
    }
  }

  async #onWelcome(rumor: UnreadInvite): Promise<void> {
    const client = this.#client
    if (!client || this.#stopped || this.#knownInvites.has(rumor.id)) return
    this.#knowInvite(rumor.id)
    if (!(await client.canJoinInvite(rumor))) {
      // Addressed to a KeyPackage this device no longer holds.
      log('dropping a Welcome that cannot be joined')
      await client.invites.markAsRead(rumor.id).catch(() => {})
      return
    }
    const invite: IncomingInvite = {
      id: rumor.id,
      inviterPubkey: rumor.pubkey,
      receivedAt: Date.now(),
      // Inside the seal, so authenticated like the inviter.
      sentAt: rumor.created_at,
    }
    // At most INVITES_MAX waiting: the oldest is marked read, as the engine's ignore does.
    while (this.#invites.size >= INVITES_MAX) {
      const oldest = this.#invites.keys().next().value as string
      this.#invites.delete(oldest)
      void client.invites.markAsRead(oldest).catch(() => {})
    }
    this.#invites.set(rumor.id, { rumor, invite })
    log('invite from', short(rumor.pubkey))
    for (const cb of this.#inviteCallbacks) this.#call(cb, invite)
  }

  /**
   * The tag of a waiting Welcome, read without joining: previewWelcome
   * decrypts the group info only; nothing is stored, published or consumed. A Welcome
   * that is gone, cannot be read or has no description has no tag.
   */
  async previewInvite(inviteId: string): Promise<{ tag: string | null }> {
    const client = this.#client
    const entry = this.#invites.get(inviteId)
    if (!client || !entry || this.#stopped) return { tag: null }
    const preview = await this.#previewOnce(client, entry)
    const description = preview?.group?.description
    return { tag: typeof description === 'string' && /^[0-9a-f]{32}$/.test(description) ? description : null }
  }

  /**
   * previewWelcome of a waiting Welcome, decrypted at most once: previewInvite (the tag) and
   * the pre-join room-shape check of acceptInvite share it. A Welcome that
   * is not waiting (read from the store) is previewed on its own.
   */
  #previewOnce(client: Client, entry: { rumor: UnreadInvite; preview?: Promise<WelcomePreview | null> }): Promise<WelcomePreview | null> {
    entry.preview ??= client.previewWelcome(entry.rumor).catch(() => null)
    return entry.preview
  }

  #knowInvite(id: string): void {
    this.#knownInvites.add(id)
    if (this.#knownInvites.size > KNOWN_INVITES_MAX) this.#knownInvites.delete(this.#knownInvites.values().next().value as string)
  }

  acceptInvite(inviteId: string): Promise<{ groupId: string }> {
    const running = this.#accepting.get(inviteId)
    if (running) return running
    const accept = this.#acceptInvite(inviteId).finally(() => {
      if (this.#accepting.get(inviteId) === accept) this.#accepting.delete(inviteId)
    })
    this.#accepting.set(inviteId, accept)
    return accept
  }

  async #acceptInvite(inviteId: string): Promise<{ groupId: string }> {
    const client = await this.#ready()
    const waiting = this.#invites.get(inviteId)
    const rumor = waiting?.rumor ?? (await client.invites.getUnread()).find((entry) => entry.id === inviteId)
    if (!rumor) throw new Error('invite not found')

    // Before joining: the room the Welcome describes, read
    // from its encrypted group info (never the outer relays tag), must have the inviter
    // as its only admin, the app's name and 1 to 8 relays that pass the host rule.
    // Otherwise it is not joined, so I never connect to relays outside that rule.
    const preview = await (waiting ? this.#previewOnce(client, waiting) : client.previewWelcome(rumor).catch(() => null))
    if (!roomShapeOk(preview?.group, rumor.pubkey, GROUP_NAME)) {
      this.#invites.delete(inviteId)
      this.#knowInvite(inviteId)
      await client.invites.markAsRead(rumor.id).catch(() => {})
      warn(INVITE_REFUSED_SHAPE)
      throw new Error(INVITE_REFUSED_SHAPE)
    }

    const { group } = await client.joinGroupFromWelcome({ welcomeRumor: rumor })
    const groupId = group.idStr
    // Nothing has been ingested yet; hold what arrives until the caller has
    // the group id.
    this.#hold(groupId)
    try {
      this.#invites.delete(inviteId)
      await client.invites.markAsRead(rumor.id)

      const others = getGroupMemberPubkeys(group.state).filter((member) => member !== this.pubkey)
      if (others.length !== 1 || others[0] !== rumor.pubkey) {
        await client.groups.destroy(group.id).catch(() => {})
        throw new Error('Welcome is not for a two-member group with its inviter')
      }

      // Catch up first so messages the inviter sent right after the Welcome
      // are read in the epoch they were sent in, then rotate my leaf key.
      await this.#catchUp(client, group)
      await withTimeout(group.selfUpdate(), SELF_UPDATE_TIMEOUT_MS, 'self-update').catch((error: unknown) => warn('self-update after join failed', errorText(error)))
      // The consumed KeyPackage is reusable, so I stay invitable meanwhile.
      void this.#rotateKeyPackage()

      log('joined', short(groupId), 'invited by', short(rumor.pubkey))
      this.#release(groupId)
      return { groupId }
    } catch (error) {
      this.#discard(groupId)
      throw error
    }
  }

  /** Backfill one group now. {@link #connectGroup} keeps the live subscription. */
  async #catchUp(client: Client, group: Group): Promise<void> {
    const connecting = client.groups.connect(group.id, { fallbackRelays: this.#relays })
    connecting.then(
      (connection) => connection.unsubscribe(),
      () => {},
    )
    await withTimeout(connecting, CATCH_UP_TIMEOUT_MS, 'group backfill').catch((error: unknown) => warn('group backfill after join failed', errorText(error)))
  }

  async ignoreInvite(inviteId: string): Promise<void> {
    const client = await this.#ready()
    this.#invites.delete(inviteId)
    this.#knowInvite(inviteId)
    // Local only: nothing is published, the inviter learns nothing.
    await client.invites.markAsRead(inviteId)
  }

  // ------------------------------------------------------------ messages

  async send(groupId: string, msg: WireMessage): Promise<void> {
    // The stored groups, not the online step: a room message needs neither my
    // lists nor my KeyPackage.
    const client = await this.#loaded()
    const health = this.groupHealth(groupId)
    if (health === 'missing' || health === 'unreadable') throw new Error('group-unreadable')
    const group = client.groups.loaded.find((candidate) => candidate.idStr === groupId)
    if (!group) throw new Error('group-unreadable')
    const previous = this.#sendTails.get(groupId) ?? Promise.resolve()
    const sending = previous.then(() => this.#send(client, group, msg))
    this.#sendTails.set(
      groupId,
      sending.catch(() => {}),
    )
    return sending
  }

  async #send(client: Client, group: Group, msg: WireMessage): Promise<void> {
    this.#assertRunning()
    // Every encryption uses up a step of the sender ratchet, published or not:
    // nothing is encrypted until a socket to one of the room's relays is open.
    const relays = group.relays?.length ? group.relays : this.#relays
    if (!(await this.#network.waitConnected(relays, SEND_CONNECT_WAIT_MS))) throw new Error('offline')
    this.#assertRunning()
    if (group.status !== 'active') throw new Error(`group is ${group.status}`)
    let rumor = this.#rumors.get(msg)
    if (!rumor) {
      // Strictly increasing, also across restarts. It orders my messages for the
      // receiver and keeps identical messages sent in one second distinct.
      const seq = (this.#lastSeq = Math.max(this.#lastSeq + 1, Date.now()))
      rumor = {
        id: '',
        kind: ILCHON_KIND,
        pubkey: this.pubkey,
        created_at: unixNow(),
        content: JSON.stringify(msg),
        tags: [[SEQ_TAG, String(seq)]],
      }
      rumor.id = getEventHash(rumor)
      this.#rumors.set(msg, rumor)
    }
    // The library queues the message until the group has settled, and throws
    // when no group relay acknowledged it. A send the library makes now (settled)
    // holds the room's turn, so no ingest of that room runs while it encrypts
    // (guardIngest). A queued one does not hold it: settling may need an ingest.
    const leave = await this.#turns.take(group.idStr)
    let results: Awaited<ReturnType<Client['groups']['send']>>
    try {
      this.#assertRunning()
      if (group.convergenceStatus !== 'Settled' || group.lifecycle !== 'Stable') leave()
      results = await withTimeout(client.groups.send(group.id, createApplicationMessageIntent(rumor)), SEND_TIMEOUT_MS, 'send')
    } finally {
      leave()
    }
    if (!results.some((result) => anyAccepted(result.response))) {
      throw new Error('no relay accepted the message')
    }
  }

  onMessage(cb: (m: IncomingMessage) => void | Promise<void>): Unsub {
    this.#messageCallbacks.add(cb)
    if (this.#undelivered.length) {
      const backlog = this.#undelivered
      this.#undelivered = []
      queueMicrotask(() => {
        for (const message of backlog) this.#deliver(message)
      })
    }
    return () => {
      this.#messageCallbacks.delete(cb)
    }
  }

  async listGroups(): Promise<{ groupId: string; peerPubkey: PubkeyHex | null }[]> {
    const client = await this.#ready()
    const groups: { groupId: string; peerPubkey: PubkeyHex | null }[] = []
    for (const group of client.groups.loaded) {
      if (group.status !== 'active') continue
      const others = getGroupMemberPubkeys(group.state).filter((member) => member !== this.pubkey)
      if (others.length === 1) groups.push({ groupId: group.idStr, peerPubkey: others[0] })
    }
    // Stored rooms that could not be loaded: their peer is unknown.
    for (const groupId of this.#unreadable) groups.push({ groupId, peerPubkey: null })
    return groups
  }

  // ------------------------------------------------------------ my contact list

  /**
   * My list on my list relays, or on my relays in use now (this.#relays)
   * when none were given; every one of them awaited. No auth.
   */
  fetchList(): Promise<ListFetch> {
    if (this.#stopped) return Promise.reject(new Error('transport is stopped'))
    return fetchCopies(this.#network, this.#contactListRelays ?? this.#relays, this.#secretKeyHex)
  }

  async publishList(payload: string, createdAt: number, relays: string[]): Promise<string[]> {
    this.#assertRunning()
    if (!relays.length) throw new Error('list-rejected')
    const event = await sealList(this.#secretKeyHex, payload, createdAt)
    this.#assertRunning()
    const results = await publishListEvent(this.#network, relays, event)
    // Dev console only: the support log gets nothing from here.
    log('contact list publish:', describePublish(results))
    // The relays as asked (the result's `from` may be the pool's normalized url): the engine
    // compares them with the urls it asked and fetched.
    const accepted = Object.entries(results)
      .filter(([, result]) => result.ok)
      .map(([url]) => url)
    if (!accepted.length) throw new Error('list-rejected')
    return accepted
  }

  /**
   * This device only: a room that could not be loaded is removed from the
   * stores directly (loading it again would fail the same way); any other goes through
   * destroy(), which loads it if needed and fires `destroyed` (#detach ends its
   * subscription and send chain). Nothing is published.
   */
  async forgetGroup(groupId: string): Promise<void> {
    const client = await this.#ready()
    if (this.#unreadable.has(groupId)) {
      const mine = (key: string) => key === groupId || key.startsWith(`${groupId}/`)
      const s = this.#stores
      const tables: { keys(): Promise<string[]>; removeItem(key: string): Promise<void> }[] = [s.groups, s.removed, s.rewind, s.ingest]
      for (const table of tables) {
        for (const key of await table.keys()) if (mine(key)) await table.removeItem(key)
      }
      this.#unreadable.delete(groupId)
      this.#healthChanged()
      return
    }
    this.#discard(groupId)
    await client.groups.destroy(groupId).catch(() => {})
  }

  peerJoined(groupId: string): boolean {
    const group = this.#client?.groups.loaded.find((candidate) => candidate.idStr === groupId)
    // create = epoch 0, my invite commit = 1; the joiner's self-update makes 2.
    return !!group && group.state.groupContext.epoch >= 2n
  }

  // ------------------------------------------------------------ incoming plumbing

  readonly #attach = (group: Group): void => {
    const groupId = group.idStr
    if (this.#stopped || this.#attached.has(groupId)) return
    // Not the `applicationMessage` event: marmot-ts 0.9.0 does not emit it for
    // messages it set aside while one of my own commits was being published
    // and processed afterwards. `ingestResult` reports every delivered message.
    const onIngestResult = (result: DispositionedIngestResult) => {
      if (result.kind === 'processed' && result.result.kind === 'applicationMessage') {
        this.#onApplicationMessage(groupId, result.result.message)
      }
    }
    group.on('ingestResult', onIngestResult)
    // A batch the library ingests is handed over whole, sorted (REORDER_*).
    const unguard = guardIngest(group, this.#turns, {
      start: () => this.#reorder.ingestStart(groupId),
      end: () => this.#reorder.ingestEnd(groupId),
    })
    this.#attached.set(groupId, () => {
      group.off('ingestResult', onIngestResult)
      unguard()
    })
    this.#connectGroup(group)
    if (this.#groupsLoaded) this.#healthChanged()
  }

  /** Backfill and live-subscribe one group; on failure retry with backoff. */
  #connectGroup(group: Group): void {
    const client = this.#client
    if (this.#stopped || !this.#connectEnabled || !client) return
    const groupId = group.idStr
    let conn = this.#connections.get(groupId)
    if (conn && (conn.pending || conn.sub)) return
    if (!conn) {
      conn = { controller: new AbortController(), sub: undefined, pending: false, failures: 0 }
      this.#connections.set(groupId, conn)
    }
    const current = conn
    current.pending = true
    client.groups.connect(group.id, { fallbackRelays: this.#relays, signal: current.controller.signal }).then(
      (sub) => {
        current.pending = false
        if (current.controller.signal.aborted || this.#connections.get(groupId) !== current) {
          sub.unsubscribe()
          return
        }
        current.sub = sub
        current.failures = 0
      },
      (error: unknown) => {
        current.pending = false
        if (current.controller.signal.aborted || this.#connections.get(groupId) !== current) return
        current.failures++
        const delay = GROUP_CONNECT_RETRY_MS[Math.min(current.failures, GROUP_CONNECT_RETRY_MS.length) - 1]
        warn('group connect failed, retrying in', delay, 'ms:', short(groupId), errorText(error))
        this.#later(delay, async () => {
          if (this.#connections.get(groupId) !== current || current.sub || current.pending) return
          const live = client.groups.loaded.find((candidate) => candidate.idStr === groupId)
          if (live) this.#connectGroup(live)
        })
      },
    )
  }

  /** A relay came back: try every group that is not connected right away. */
  #retryConnections(): void {
    const client = this.#client
    if (this.#stopped || !this.#connectEnabled || !client) return
    for (const group of client.groups.loaded) {
      const conn = this.#connections.get(group.idStr)
      if (conn && !conn.sub && !conn.pending) this.#connectGroup(group)
    }
  }

  /** The group can no longer receive: stop its connection and its retries. */
  readonly #disconnect = (groupIdBytes: Uint8Array): void => {
    const groupId = bytesToHex(groupIdBytes)
    const conn = this.#connections.get(groupId)
    if (!conn) return
    this.#closeConnection(conn)
    this.#connections.delete(groupId)
  }

  #closeConnection(conn: GroupConnection): void {
    conn.controller.abort()
    conn.sub?.unsubscribe()
    conn.sub = undefined
  }

  readonly #detach = (groupIdBytes: Uint8Array): void => {
    const groupId = bytesToHex(groupIdBytes)
    this.#attached.get(groupId)?.()
    this.#attached.delete(groupId)
    this.#disconnect(groupIdBytes)
    this.#discard(groupId)
    this.#sendTails.delete(groupId)
    this.#strandMs.delete(groupId)
    this.#healthChanged()
  }

  /** `bytes` is a decrypted rumor whose author MLS already authenticated. */
  #onApplicationMessage(groupId: string, bytes: Uint8Array): void {
    let rumor: Rumor
    try {
      rumor = deserializeApplicationData(bytes)
    } catch {
      return
    }
    if (rumor.kind !== ILCHON_KIND || rumor.pubkey === this.pubkey) return
    if (this.#seenRumors.has(rumor.id)) return
    log('message', short(this.pubkey), short(groupId), short(rumor.id))
    this.#seenRumors.add(rumor.id)
    if (this.#seenRumors.size > SEEN_RUMOR_CAPACITY) {
      const oldest = this.#seenRumors.values().next()
      if (!oldest.done) this.#seenRumors.delete(oldest.value)
    }
    const msg = parseWireMessage(rumor.content)
    if (!msg) {
      warn('dropped a message that could not be read')
      return
    }
    const message: IncomingMessage = {
      groupId,
      senderPubkey: rumor.pubkey,
      msg,
      at: rumor.created_at,
      id: rumor.id,
    }
    const tagged = Number(rumor.tags.find((tag) => tag[0] === SEQ_TAG)?.[1])
    const seq = Number.isFinite(tagged) ? tagged : rumor.created_at * 1000
    // Kept until the engine handled it; not awaited.
    if (!this.#stopped) this.#inbox.put(rumor.id, { seq, message })
    this.#reorder.put(groupId, seq, message)
  }

  /**
   * Hands a message to every callback. Once all of them returned (or their promises
   * fulfilled) its inbox entry goes; a rejection keeps it for the next start. A
   * callback that throws at once is logged and counts as handled, so a broken message
   * does not come back at every start.
   */
  #deliver(message: IncomingMessage): void {
    if (this.#stopped) return
    if (!this.#messageCallbacks.size) {
      this.#undelivered.push(message)
      return
    }
    const results: Promise<unknown>[] = []
    for (const cb of this.#messageCallbacks) {
      try {
        results.push(Promise.resolve(cb(message)))
      } catch (error) {
        console.error('[marmot] listener threw', error)
      }
    }
    this.#inbox.handled(message.id, Promise.all(results))
  }

  /**
   * The inbox of the last session, delivered again before anything new.
   * Once per instance. Waits for the read only, never for the callbacks: a callback
   * that sends waits for this start's local step. Entries of an unreadable room are
   * delivered too (they are plain already); the engine handles or drops them.
   */
  async #replayInbox(): Promise<void> {
    if (this.#replayed) return
    this.#replayed = true
    const entries = await this.#inbox.pending()
    let n = 0
    for (const { message } of entries) {
      if (this.#stopped) return
      if (this.#seenRumors.has(message.id)) continue
      this.#seenRumors.add(message.id)
      this.#deliver(message)
      n++
    }
    // Development console only: the support log drops this phrase.
    if (n > 0) warn('inbox replay')
  }

  /** Keep a group's messages back until {@link #release}. */
  #hold(groupId: string): void {
    this.#reorder.hold(groupId)
  }

  /**
   * Deliver held messages on the next task, i.e. after the promise that hands
   * the group id to the caller has resolved.
   */
  #release(groupId: string): void {
    this.#reorder.release(groupId)
  }

  #discard(groupId: string): void {
    this.#reorder.discard(groupId)
  }

  #call<T>(cb: (value: T) => void, value: T): void {
    try {
      cb(value)
    } catch (error) {
      console.error('[marmot] listener threw', error)
    }
  }
}

export function createTransport(opts: TransportOptions): Transport {
  return new MarmotTransport(opts)
}
