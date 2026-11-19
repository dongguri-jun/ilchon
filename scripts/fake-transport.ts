/**
 * Test-only fake of the transport, a virtual clock and a recording KV, so
 * `scripts/check-engine.ts` can run the real engine offline.
 *
 * Nothing under src/ imports this file: the shipped app has no fake
 * transport. The real transport keeps being checked against real relays by
 * scripts/smoke-marmot.ts and scripts/e2e.ts.
 *
 *   createFakeClock   virtual time for EngineDeps.now and EngineDeps.timers
 *   createFakeHub     relays plus every device's Marmot store, with
 *                     'hold'/release, { rejectAfterMs }, send waiting for the start;
 *                     the received-message inbox; the relays' contact list store
 *                     (fetchList, publishList, findList); Welcome sentAt, forgetGroup,
 *                     peerJoined, unreadable rooms in listGroups, the invites record,
 *                     loseGroup, creatorOf; devices and key packages (a second device
 *                     of one key, nowOffsetMs, wipe), dropInvite, inviteFate,
 *                     rotateKeyPackage, injectInvite(s), peakAccepts; thief (a second
 *                     participant with a victim's key); key package references (the
 *                     QR's kp), invitePeer's keyPackageRef and tag, previewInvite,
 *                     kpRefOf, tagOf
 *   createHarnessKV   the engine's plaintext KV, with crash points, hangNext, crash
 *                     generations and a write log
 *
 * Inside a check nothing waits on real I/O, crypto.subtle or real timers, so
 * settle() (two setImmediate turns) always reaches the end of what a step started.
 */
import type {
  GroupHealth,
  IncomingInvite,
  IncomingMessage,
  InviteOptions,
  KV,
  ListCopy,
  ListFetch,
  MarmotModule,
  PubkeyHex,
  RelayStatus,
  Transport,
  TransportOptions,
  Unsub,
  WireMessage,
} from '../src/contracts'
import { APP_NAME } from '../src/contracts'
import type { GenericKeyValueStore } from '@internet-privacy/marmot-ts'
import { createDurableInbox, type DurableInbox, type InboxEntry } from '../src/lib/marmot/durable-inbox'
import { encodeList, type ListBody } from '../src/engine/contact-list'
import { peerRelayUrl, roomShapeOk } from '../src/lib/marmot/guard'
import { npubOf, pubkeyOf, randomHex } from '../src/lib/marmot/keys'
import { listPubkeyOf } from '../src/lib/marmot/list'
import { parseWireMessage } from '../src/lib/marmot/wire'

// ---------------------------------------------------------------- clock

export interface FakeClock {
  now(): number
  timers: { set(fn: () => void, ms: number): unknown; clear(handle: unknown): void }
  /**
   * Runs the timers that come due, in time order (registration order on a tie), one
   * at a time with settle() after each. While one runs, now() is its due time. At the
   * end now() = start + ms.
   */
  advance(ms: number): Promise<void>
  /** Waits two real setImmediate turns so pending promises finish. */
  settle(): Promise<void>
  /** Moves from timer to timer until pred() is true. Rejects once more than maxMs would pass. */
  until(pred: () => boolean, maxMs: number): Promise<void>
}

interface ClockTimer {
  due: number
  seq: number
  fn: () => void
}

export function createFakeClock(startMs: number): FakeClock {
  let t = startMs
  let seq = 0
  const pending = new Set<ClockTimer>()

  function next(limit: number): ClockTimer | undefined {
    let best: ClockTimer | undefined
    for (const x of pending) {
      if (x.due > limit) continue
      if (!best || x.due < best.due || (x.due === best.due && x.seq < best.seq)) best = x
    }
    return best
  }

  const settle = async (): Promise<void> => {
    await new Promise<void>((r) => setImmediate(r))
    await new Promise<void>((r) => setImmediate(r))
  }

  /** Runs one timer. A throwing callback is a bug in the code under test: surface it. */
  function fire(x: ClockTimer): void {
    pending.delete(x)
    t = Math.max(t, x.due)
    x.fn()
  }

  return {
    now: () => t,
    timers: {
      set(fn, ms) {
        const x: ClockTimer = { due: t + Math.max(0, Number.isFinite(ms) ? ms : 0), seq: seq++, fn }
        pending.add(x)
        return x
      },
      clear(handle) {
        pending.delete(handle as ClockTimer)
      },
    },
    async advance(ms) {
      const end = t + Math.max(0, ms)
      await settle()
      for (;;) {
        const x = next(end)
        if (!x) break
        fire(x)
        await settle()
      }
      t = end
      await settle()
    },
    settle,
    async until(pred, maxMs) {
      const end = t + maxMs
      await settle()
      for (;;) {
        if (pred()) return
        const x = next(end)
        if (!x) {
          t = end
          throw new Error(`until: condition not met within ${maxMs} ms`)
        }
        fire(x)
        await settle()
      }
    },
  }
}

// ---------------------------------------------------------------- hub

export interface HubOptions {
  /** Default 20. From upload until delivery to the receiver. */
  latencyMs?: number
  /** Default 30. */
  inviteDelayMs?: number
  /** Default 30. */
  acceptDelayMs?: number
  /** The received-message inbox's bound on stored entries (default INBOX_MAX_ENTRIES). */
  inboxMax?: number
}

export interface Envelope {
  /** Equal for the same WireMessage object, unique otherwise. */
  id: string
  groupId: string
  from: PubkeyHex
  to: PubkeyHex
  /** The uploaded content as is. */
  json: string
  /** `t` of json; '?' when it cannot be read. */
  t: string
  /** Grows per sender. */
  seq: number
  /** Unix seconds (virtual) on the sender device's clock (its setOffset): the rumor time. */
  at: number
  /** Virtual milliseconds. Used by the twin comparison. */
  atMs: number
  /** Put in with hub.inject. */
  injected: boolean
}

/**
 * 'hold': kept back (neither delivered nor dropped) until hub.release; then delivered in
 * the order it was held, as if it arrived then.
 */
export type Fate = 'deliver' | 'drop' | 'duplicate' | 'hold' | { delayMs: number }
/**
 * 'reject': refused at once, nothing uploaded. 'timeout': uploaded and delivered, but the
 * sender gets a rejection. { rejectAfterMs }: nothing uploaded, and the refusal comes
 * that long later; a stop() may come in between. { acceptAfterMs }: a slow
 * relay, the upload and its acceptance come that long later (a stop() in between rejects;
 * a send that a relay takes after the room moved on).
 */
export type SendFailure = false | 'reject' | 'timeout' | { rejectAfterMs: number } | { acceptAfterMs: number }

/**
 * How one relay treats a contact list query or publish. 'ok': answers
 * after the latency. 'reject': answers after the latency with a refusal. 'silent': never
 * answers (a query counts it out after 8 s, a publish after 8 s). Read when the call starts.
 */
export type ListFate = 'ok' | 'reject' | 'silent'

/** One relay's stored copy of one list: plaintext, the hub does not encrypt (check-list does). */
export interface StoredList {
  payload: string
  /** Event created_at, unix seconds. */
  createdAt: number
}

/** One publishList attempt at one relay, written when the relay's verdict comes (or the 8 s run out). */
export interface ListLogEntry {
  relay: string
  listPubkey: PubkeyHex
  payload: string
  createdAt: number
  /** Virtual ms when the attempt started. */
  atMs: number
  accepted: boolean
}

export interface FakeHub {
  clock: FakeClock
  /**
   * For EngineDeps.marmot. Only createTransport is fake; the key functions are the
   * real ones of src/lib/marmot/keys.ts. `device` (default 'main') is one device of a
   * key: its own groups, Welcomes, inbox and key packages. A
   * transport of the same key and device is the same device after a reload.
   * `nowOffsetMs` is added to the clock for the Welcome sentAt this device makes (its
   * clock is off; makePeer moves the engine's now by the same amount).
   */
  marmot(device?: string, opts?: { nowOffsetMs?: number }): MarmotModule
  /** The device's clock offset from now on (sentAt of its next Welcomes). */
  setOffset(pubkey: PubkeyHex, device: string, ms: number): void
  /**
   * Forgets this key's device (all devices when left out): groups, Welcomes, inbox, key
   * packages; a running transport stops getting anything. A lost or reset phone.
   */
  wipe(pubkey: PubkeyHex, device?: string): void
  /** The next Welcome for which `match` is true is lost at the relays (never reaches a device). */
  dropInvite(match: (r: InviteRecord) => boolean): void
  /** The next invitePeer of this key delivers the Welcome, then throws and drops its group. */
  inviteFate(pubkey: PubkeyHex, fate: 'deliver-then-throw'): void
  /**
   * The key's device published a new key package and deleted the old ones now, as long
   * after a join elsewhere: a Welcome to an old one waiting for it can no longer be joined.
   */
  rotateKeyPackage(pubkey: PubkeyHex, device?: string): void
  /**
   * A Welcome from `from` (any key, no device: a stranger, or someone holding `from`'s
   * key) to `to`'s newest device. `sentAt` defaults to now. Joining it puts `to` in a
   * group whose other member is `from`. `relays` (default `fake://relay`) and `admins`
   * (default `[from]`) are the room info the Welcome carries: acceptInvite refuses one
   * that fails the pre-join check, as the real transport does.
   */
  injectInvite(from: PubkeyHex, to: PubkeyHex, opts?: { sentAt?: number; relays?: string[]; admins?: PubkeyHex[]; tag?: string }): InviteRecord
  /**
   * The reference (Transport.keyPackageRef) of the newest key package of this key's device
   * (the default device when left out), or null when it has none on the relays.
   */
  kpRefOf(pubkey: PubkeyHex, device?: string): string | null
  /** The tag in a group's description, undefined for none. */
  tagOf(groupId: string): string | undefined
  /** n Welcomes from n random keys (half lower than `to`, half higher) to `to`. */
  injectInvites(n: number, to: PubkeyHex): InviteRecord[]
  /**
   * A thief of `victim`'s secret key: the name of a new device of
   * that key, `thief1`, `thief2`, … The harness runs an engine of its own on it
   * (hub.marmot(device), its own transport and store), as a second participant of the hub.
   */
  thief(victim: PubkeyHex): string
  /** Most acceptInvite calls of this key's devices in flight at once so far (joins are limited to a few at once). */
  peakAccepts(pubkey: PubkeyHex): number
  /** Per receiver, right before a delivery is scheduled. Default 'deliver'. */
  route: (e: Envelope) => Fate
  /**
   * Lets held envelopes go: the one(s) with this envelope id, or every held one when the
   * id is left out. They are delivered in the order they were held, after the usual
   * latency. Returns how many were let go.
   */
  release(envelopeId?: string): number
  /** Ids of the envelopes held now, in the order they were held. */
  held(): string[]
  failSend: (from: PubkeyHex, groupId: string, msg: WireMessage) => SendFailure
  failInvite: (from: PubkeyHex, to: PubkeyHex) => boolean
  /**
   * 'down': sending rejects with Error('offline'), no delivery, every relay
   * reported disconnected, and start() waits: it resolves once
   * 'up' comes, and rejects with 'transport is stopped' if stop() comes first.
   * 'up': what waited is delivered.
   */
  setNetwork(pubkey: PubkeyHex, state: 'up' | 'down'): void
  /**
   * The stored state of this group on this key's devices cannot be read from the
   * next start() on: groupHealth 'unreadable', no delivery, send rejects with
   * 'group-unreadable' (a room whose storage broke). `false` heals it at
   * the next start.
   */
  unreadable(pubkey: PubkeyHex, groupId: string, on?: boolean): void
  /** The group's relays are out of reach for everyone while my relays work: groupHealth 'stranded'. `false` ends it. */
  strand(groupId: string, on?: boolean): void
  /** Uploads any content to a group under `from`'s name (a malicious peer). */
  inject(from: PubkeyHex, groupId: string, json: string): Envelope
  /** Everything uploaded, in order. */
  readonly log: readonly Envelope[]
  /** What the receiving parser (parseWireMessage) threw away. */
  readonly unparsed: readonly Envelope[]
  /** Called synchronously when something is uploaded, before any delivery. */
  onPublish?: (e: Envelope) => void
  /**
   * Stored inbox: ids of the messages in this key's received-message inbox now (stored, not
   * handled yet), lowest seq first. The inbox is the real createDurableInbox over a
   * memory store the hub keeps per key, so it outlives restarts and crashes.
   */
  inbox(pubkey: PubkeyHex): string[]
  /** Stored inbox: the stored entries themselves (leak searches read them as part of the peer's storage). */
  inboxEntries(pubkey: PubkeyHex): InboxEntry[]
  /** groupHealth of the key's running transport, or null when none runs. */
  health(pubkey: PubkeyHex, groupId: string): GroupHealth | null
  /**
   * This key's device forgets the group, as if its stored state were lost: groupHealth
   * 'missing', no more delivery (used by the room-lost scenarios).
   */
  loseGroup(pubkey: PubkeyHex, groupId: string): void
  /** Every Welcome made, in order (the twin assertions read it). */
  readonly invites: readonly InviteRecord[]
  /** Who made the group (INV-CH1); undefined for an id the hub never made. */
  creatorOf(groupId: string): PubkeyHex | undefined
  /**
   * The groups this key's device stores now, readable or not (INV-CH3, S-CH-UNREADABLE).
   * Here and in inbox, inboxEntries, health and loseGroup the device defaults to the one
   * whose transport was made last for the key.
   */
  groupsOf(pubkey: PubkeyHex, device?: string): string[]
  /** The transports' warn() (fixed phrase, values), as the real transport passes it to the support log. */
  onWarn?: (pubkey: PubkeyHex, phrase: string, values: readonly unknown[]) => void

  // Contact list store. Per relay one copy per list key; a fake
  // fetchList, publishList or findList follows the requestEach waiting rules on the
  // virtual clock: done when all answered, 1 s grace after the first answer, then 3 s
  // more for the rest, and a rejection when nobody answered (8 s at most).

  /** Per relay and operation. Default 'ok'. */
  listFate: (relay: string, op: 'publish' | 'fetch') => ListFate
  /**
   * How long keyUsedElsewhere takes on the virtual clock (default 0). The real transport
   * asks the relays, so its answer can come after a contact list fetch.
   */
  elsewhereDelayMs: number
  /** Every key package a device put on the relays, in order (S-BOT-BUFFER-CAP reads it). */
  readonly kpLog: readonly { pubkey: PubkeyHex; device: string; atMs: number }[]
  /** Every publishList attempt, per relay, in the order the verdicts came. */
  readonly listLog: readonly ListLogEntry[]
  /** The list key of a pubkey whose transport (or findList) the hub has seen; undefined otherwise. */
  listKeyOf(owner: PubkeyHex): PubkeyHex | undefined
  /** The relay's copy now, or undefined. */
  listOf(relay: string, listPubkey: PubkeyHex): StoredList | undefined
  /** The relay forgets the copy. */
  loseList(relay: string, listPubkey: PubkeyHex): void
  /** Puts a copy in place, ignoring the replaceable rule (a relay rolled back, an old copy). */
  putList(relay: string, listPubkey: PubkeyHex, payload: string, createdAt: number): void
  /**
   * Someone holding `owner`'s key writes a copy of `owner`'s list (a key
   * thief). `body` is encoded with encodeList unless it is already a string. Goes to
   * `opts.relays` (default: the relays of `owner`'s last transport), with
   * `opts.createdAt` (default: one second past the newest copy there, at least now),
   * overwriting like putList. Not written to listLog. Throws when the hub has not seen
   * `owner`'s list key yet.
   */
  injectListCopy(owner: PubkeyHex, body: ListBody | string, opts?: { relays?: string[]; createdAt?: number }): void
}

/** A memory table the hub keeps per key: the device's stored inbox. */
interface MemTable extends GenericKeyValueStore<InboxEntry> {
  readonly data: Map<string, InboxEntry>
}

function memTable(): MemTable {
  const data = new Map<string, InboxEntry>()
  return {
    data,
    async getItem(key) {
      return data.has(key) ? structuredClone(data.get(key) as InboxEntry) : null
    },
    async setItem(key, value) {
      data.set(key, structuredClone(value))
      return value
    },
    async removeItem(key) {
      data.delete(key)
    },
    async clear() {
      data.clear()
    },
    async keys() {
      return [...data.keys()]
    },
  }
}

interface Group {
  id: string
  /** members[0] made the group. */
  members: [PubkeyHex, PubkeyHex]
  /** The room info its Welcome carries: the maker's relays, admins. */
  relays: string[]
  admins: PubkeyHex[]
  /** The room description: the tag of a room made from a scan. */
  description?: string
  /**
   * The invited member joined it once (its self-update commit raised the epoch). Stays
   * true when that device later forgets the group: the real peerJoined reads my epoch.
   */
  joinedOnce?: boolean
}

interface PendingInvite {
  id: string
  from: PubkeyHex
  groupId: string
  at: number
  /** Unix seconds on the inviter's clock (IncomingInvite.sentAt). */
  sentAt: number
  /** The key package of the receiving device it was made for. */
  kp: number
}

/** One Welcome as the relays saw it, and what the receiving device did with it. */
export interface InviteRecord {
  id: string
  from: PubkeyHex
  /** The inviter's device; '' for an injected Welcome. */
  fromDevice: string
  to: PubkeyHex
  toDevice: string
  groupId: string
  atMs: number
  sentAt: number
  /** The reference of the receiver's key package it was made for (the QR's `kp`). */
  kpRef: string
  accepted: boolean
  /** Virtual ms of the join, when accepted. */
  acceptedAtMs?: number
  /** Ignored, lost at the relays (dropInvite), or made for a key package the device no longer had. */
  dropped: boolean
  /**
   * previewWelcome decryptions of this Welcome by the receiving device: previewInvite (the
   * tag) and the pre-join room-shape check share one, as in the real transport.
   */
  previews: number
}

/** What the hub needs of the transport a device runs now. */
interface LiveTransport extends Transport {
  running(): boolean
  /** False for a group this transport could not load (unreadable). */
  canReceive(groupId: string): boolean
  healthChanged(): void
  /** keyPackageRef() may have changed (a key package was published or replaced). */
  kpChanged(): void
  hasMessageListener(): boolean
  emitMessage(m: IncomingMessage, seq: number): void
  offerInvite(inv: PendingInvite): void
  notifyStatus(): void
  supersede(): void
}

/** One (pubkey, device): what the relays and that device's Marmot store hold. */
interface Device {
  key: string
  pubkey: PubkeyHex
  device: string
  /** Groups this device joined (invitePeer returned or acceptInvite returned). */
  joined: Set<string>
  /** Welcomes not accepted or ignored yet, in arrival order. */
  invites: PendingInvite[]
  accepted: Set<string>
  /** Delivery state of each envelope addressed to this device; kept across restarts. */
  state: Map<Envelope, 'scheduled' | 'held' | 'done'>
  live: LiveTransport | null
  /** Started at least once: its KeyPackage is on the relays. */
  invitable: boolean
  /** Groups whose stored state cannot be read from the next start on (hub.unreadable). */
  unreadable: Set<string>
  /** The stored received-message inbox; kept across restarts and crashes. */
  inbox: MemTable
  /**
   * Key packages this device can still join with: id -> when it is deleted (undefined:
   * kept). The highest id is the newest one on the relays.
   */
  kps: Map<number, number | undefined>
  /**
   * Key packages the relays no longer serve: the device published a newer one into the same
   * addressable slot after a join (or rotateKeyPackage), which replaces the older event. A
   * Welcome built for one is still joined while it is in `kps`, but an invite naming it by
   * reference (the QR's kp) finds nothing, as on the real relays.
   */
  replaced: Set<number>
  /** Added to the clock for this device's Welcome sentAt. */
  offsetMs: number
  /** acceptInvite calls in flight now. */
  accepting: number
}

const STOPPED = 'transport is stopped'
/** A room relay the hub accepts: the host rule of the real transport, or a harness address. */
const hubRelayOk = (url: string): boolean => url.startsWith('fake://') || peerRelayUrl(url) !== null
/** The real transport deletes the previous session's key package 3 minutes after a start (transport.ts). */
const KP_OLD_SESSION_MS = 3 * 60_000
/** And a key package a join used, 10 minutes after that join. */
const KP_USED_MS = 10 * 60_000
/** The real transport's one-relay limits and lookup waits (src/lib/marmot/network.ts). */
const LIST_TIMEOUT_MS = 8_000
const LIST_GRACE_MS = 1_000
const LIST_WAIT_MAX_MS = 3_000

export function createFakeHub(clock: FakeClock, opts: HubOptions = {}): FakeHub {
  const latencyMs = Math.max(1, opts.latencyMs ?? 20)
  const inviteDelayMs = opts.inviteDelayMs ?? 30
  const acceptDelayMs = opts.acceptDelayMs ?? 30

  const log: Envelope[] = []
  const unparsed: Envelope[] = []
  const inviteLog: InviteRecord[] = []
  const groups = new Map<string, Group>()
  const devices = new Map<string, Device>()
  const network = new Map<PubkeyHex, 'up' | 'down'>()
  const seqOf = new Map<PubkeyHex, number>()
  const ids = new WeakMap<object, string>()
  const stranded = new Set<string>()
  /** Starts waiting for 'up', per pubkey. */
  const upWaiters = new Map<PubkeyHex, Set<() => void>>()
  /** Envelopes a route() held, per receiving device, in the order they were held. */
  const holding: { d: Device; e: Envelope }[] = []
  /** Relay -> list key -> the copy it holds. */
  const listStore = new Map<string, Map<PubkeyHex, StoredList>>()
  const listLog: ListLogEntry[] = []
  const kpLog: { pubkey: PubkeyHex; device: string; atMs: number }[] = []
  /** Pubkey -> its list key, and the relays of its last transport. */
  const listKeys = new Map<PubkeyHex, PubkeyHex>()
  const lastRelays = new Map<PubkeyHex, string[]>()

  const up = (pk: PubkeyHex): boolean => network.get(pk) !== 'down'
  const sleepFor = (ms: number): Promise<void> => new Promise((r) => clock.timers.set(r, ms))

  function deviceOf(pubkey: PubkeyHex, device: string): Device {
    const key = `${pubkey}/${device}`
    let d = devices.get(key)
    if (!d) {
      d = {
        key,
        pubkey,
        device,
        joined: new Set(),
        invites: [],
        accepted: new Set(),
        state: new Map(),
        live: null,
        invitable: false,
        unreadable: new Set(),
        inbox: memTable(),
        kps: new Map(),
        replaced: new Set(),
        offsetMs: 0,
        accepting: 0,
      }
      devices.set(key, d)
    }
    return d
  }

  function devicesOf(pubkey: PubkeyHex): Device[] {
    return [...devices.values()].filter((d) => d.pubkey === pubkey)
  }

  /** Pubkey -> the device whose transport was made last (the helpers' default device). */
  const lastDevice = new Map<PubkeyHex, string>()
  function primary(pubkey: PubkeyHex, device?: string): Device {
    return deviceOf(pubkey, device ?? lastDevice.get(pubkey) ?? 'main')
  }

  let kpSeq = 0
  /** Key package id -> its created_at in ms (the device's clock when it was published). */
  const kpAt = new Map<number, number>()
  /** Key package id -> its reference (64 hex, as an event id of the real transport). */
  const kpRefs = new Map<number, string>()
  const refOf = (id: number): string => {
    let ref = kpRefs.get(id)
    if (!ref) {
      ref = randomHex(32)
      kpRefs.set(id, ref)
    }
    return ref
  }
  /** The device puts a new key package on the relays. */
  function publishKp(d: Device): number {
    const id = ++kpSeq
    d.kps.set(id, undefined)
    kpLog.push({ pubkey: d.pubkey, device: d.device, atMs: clock.now() })
    // Its created_at, on the publishing device's clock (the key-takeover check compares it).
    kpAt.set(id, clock.now() + d.offsetMs)
    return id
  }
  /** The newest key package of the device that can still be joined with, or 0. */
  function newestKp(d: Device): number {
    let best = 0
    for (const [id, until] of d.kps) if ((until === undefined || until > clock.now()) && id > best) best = id
    return best
  }
  function joinable(d: Device, inv: PendingInvite): boolean {
    if (!d.kps.has(inv.kp)) return false
    const until = d.kps.get(inv.kp)
    return until === undefined || until > clock.now()
  }
  /** Deleted after `ms` unless already sooner. */
  function expireKp(d: Device, id: number, ms: number): void {
    if (!d.kps.has(id)) return
    const until = d.kps.get(id)
    const at = clock.now() + ms
    if (until === undefined || until > at) d.kps.set(id, at)
  }

  /** Lost-at-the-relays matchers (dropInvite) and next-invite fates (inviteFate), one use each. */
  const dropMatchers: ((r: InviteRecord) => boolean)[] = []
  const inviteFates = new Map<PubkeyHex, 'deliver-then-throw'>()
  const peak = new Map<PubkeyHex, number>()

  /**
   * One Welcome from `from` to the device of `to` with the newest key package (only that
   * device can join it). Returns the record, or null when `to` has no
   * key package on the relays.
   */
  function deliverInvite(from: PubkeyHex, fromDevice: string, to: PubkeyHex, groupId: string, sentAt: number, only?: { d: Device; kp: number }): InviteRecord | null {
    let target: Device | undefined = only?.d
    let kp = only?.kp ?? 0
    if (!only) {
      for (const d of devicesOf(to)) {
        const k = d.invitable ? newestKp(d) : 0
        if (k > kp) {
          kp = k
          target = d
        }
      }
    }
    if (!target) return null
    const at = clock.now()
    const inv: PendingInvite = { id: randomHex(16), from, groupId, at, sentAt, kp }
    const rec: InviteRecord = { id: inv.id, from, fromDevice, to, toDevice: target.device, groupId, atMs: at, sentAt, kpRef: refOf(kp), accepted: false, dropped: false, previews: 0 }
    inviteLog.push(rec)
    const lost = dropMatchers.findIndex((m) => m(rec))
    if (lost >= 0) {
      dropMatchers.splice(lost, 1)
      rec.dropped = true
      return rec
    }
    target.invites.push(inv)
    pumpInvites(target)
    return rec
  }

  /** A device that is running, online and has callbacks gets deliveries. */
  function receiving(d: Device): LiveTransport | null {
    const t = d.live
    return t && t.running() && up(d.pubkey) ? t : null
  }

  /** `offsetMs`: the sending device's clock offset (setOffset); the rumor time (`at`) is on that clock, like a real rumor's created_at. */
  function publish(from: PubkeyHex, groupId: string, json: string, id: string, injected: boolean, offsetMs = 0): Envelope {
    const g = groups.get(groupId)
    if (!g) throw new Error('unknown group')
    const to = g.members[0] === from ? g.members[1] : g.members[0]
    let t = '?'
    try {
      const v = JSON.parse(json) as { t?: unknown }
      if (v && typeof v === 'object' && typeof v.t === 'string') t = v.t
    } catch {
      // stays '?'
    }
    const seq = (seqOf.get(from) ?? 0) + 1
    seqOf.set(from, seq)
    const now = clock.now()
    const e: Envelope = { id, groupId, from, to, json, t, seq, at: Math.floor((now + offsetMs) / 1000), atMs: now, injected }
    log.push(e)
    hub.onPublish?.(e)
    for (const d of devicesOf(to)) pump(d)
    return e
  }

  /** Schedules every message this device may receive now and has not got yet. */
  function pump(d: Device): void {
    const t = receiving(d)
    if (!t || !t.hasMessageListener()) return
    for (const e of log) {
      if (e.to !== d.pubkey || !d.joined.has(e.groupId) || d.state.has(e) || !t.canReceive(e.groupId)) continue
      const fate = hub.route(e)
      if (fate === 'drop') {
        d.state.set(e, 'done')
        continue
      }
      if (fate === 'hold') {
        d.state.set(e, 'held')
        holding.push({ d, e })
        continue
      }
      d.state.set(e, 'scheduled')
      const extra = typeof fate === 'object' ? Math.max(0, fate.delayMs) : 0
      clock.timers.set(() => deliver(d, e, fate === 'duplicate' ? 2 : 1), latencyMs + extra)
    }
  }

  function deliver(d: Device, e: Envelope, times: number): void {
    const t = receiving(d)
    if (!t || !t.hasMessageListener() || !d.joined.has(e.groupId) || !t.canReceive(e.groupId)) {
      // Not now: it waits for the next start() or 'up'.
      d.state.delete(e)
      return
    }
    d.state.set(e, 'done')
    const msg = parseWireMessage(e.json)
    if (!msg) {
      unparsed.push(e)
      return
    }
    for (let i = 0; i < times; i++) {
      t.emitMessage({ groupId: e.groupId, senderPubkey: e.from, msg, at: e.at, id: e.id }, e.seq)
    }
  }

  /** Surfaces the waiting Welcomes on the running transport. */
  function pumpInvites(d: Device): void {
    const t = receiving(d)
    if (!t) return
    for (const inv of d.invites) t.offerInvite(inv)
  }

  function wake(d: Device): void {
    pump(d)
    pumpInvites(d)
  }

  function storedList(relay: string, listPubkey: PubkeyHex): StoredList | undefined {
    const x = listStore.get(relay)?.get(listPubkey)
    return x ? { ...x } : undefined
  }

  function storeList(relay: string, listPubkey: PubkeyHex, value: StoredList): void {
    let m = listStore.get(relay)
    if (!m) listStore.set(relay, (m = new Map()))
    m.set(listPubkey, { ...value })
  }

  /** The requestEach rules on the virtual clock, every asked relay awaited (waitFor = all). */
  function fakeFetchList(asker: PubkeyHex, relays: string[], listPubkey: PubkeyHex): Promise<ListFetch> {
    const asked = [...new Set(relays)]
    return new Promise<ListFetch>((resolve, reject) => {
      const answered: string[] = []
      const copies: ListCopy[] = []
      const timers: unknown[] = []
      const waiting = new Set(asked)
      let pending = asked.length
      let graceStarted = false
      let graceOver = false
      let done = false
      const later = (fn: () => void, ms: number) => timers.push(clock.timers.set(fn, ms))
      const finish = () => {
        if (done) return
        done = true
        for (const handle of timers) clock.timers.clear(handle)
        if (!answered.length) reject(new Error('no relay answered the request'))
        else resolve({ copies, answered, asked })
      }
      const settle = (url: string) => {
        waiting.delete(url)
        if (--pending === 0 || (graceOver && waiting.size === 0)) finish()
        else if (!graceStarted && answered.length) {
          graceStarted = true
          later(() => {
            graceOver = true
            if (waiting.size === 0) finish()
            else later(finish, LIST_WAIT_MAX_MS)
          }, LIST_GRACE_MS)
        }
      }
      if (!pending) finish()
      const online = up(asker)
      for (const url of asked) {
        const fate: ListFate | 'down' = online ? hub.listFate(url, 'fetch') : 'down'
        if (fate === 'ok') {
          later(() => {
            if (done) return
            answered.push(url)
            const copy = storedList(url, listPubkey)
            if (copy) copies.push({ relay: url, payload: copy.payload, createdAt: copy.createdAt })
            settle(url)
          }, latencyMs)
        } else {
          const ms = fate === 'down' ? 0 : fate === 'reject' ? latencyMs : LIST_TIMEOUT_MS
          later(() => {
            if (!done) settle(url)
          }, ms)
        }
      }
    })
  }

  /** Each relay's verdict on one copy; resolves the relays that took it. */
  async function fakePublishList(from: PubkeyHex, listPubkey: PubkeyHex, payload: string, createdAt: number, relays: string[]): Promise<string[]> {
    const atMs = clock.now()
    const online = up(from)
    const verdicts = await Promise.all(
      [...new Set(relays)].map(
        (relay) =>
          new Promise<boolean>((resolve) => {
            const fate: ListFate | 'down' = online ? hub.listFate(relay, 'publish') : 'down'
            const ms = fate === 'down' ? 0 : fate === 'silent' ? LIST_TIMEOUT_MS : latencyMs
            clock.timers.set(() => {
              let accepted = false
              if (fate === 'ok') {
                // Replaceable: a copy at least as new replaces what the relay holds.
                const cur = listStore.get(relay)?.get(listPubkey)
                accepted = !cur || createdAt >= cur.createdAt
                if (accepted) storeList(relay, listPubkey, { payload, createdAt })
              }
              listLog.push({ relay, listPubkey, payload, createdAt, atMs, accepted })
              resolve(accepted)
            }, ms)
          }),
      ),
    )
    const accepted = [...new Set(relays)].filter((_, i) => verdicts[i])
    if (!accepted.length) throw new Error('list-rejected')
    return accepted
  }

  class FakeTransport implements LiveTransport {
    readonly pubkey: PubkeyHex
    readonly #dev: Device
    readonly #relays: string[]
    readonly #listPubkey: PubkeyHex
    /** Where my contact list is fetched (TransportOptions.listRelays). */
    readonly #listRelays: string[]
    #started = false
    /** Waiting Welcomes this transport decrypted with previewWelcome (once each). */
    readonly #previewed = new WeakSet<PendingInvite>()
    /** start() published this session's key package: keyPackageRef() answers from here on. */
    #kpKnown = false
    /** start() began its local step (it runs once). */
    #begun = false
    #stopped = false
    /** Stored groups this instance could not load (a snapshot of the device's set at start). */
    #unreadable = new Set<string>()
    readonly #healthCbs = new Set<() => void>()
    readonly #kpCbs = new Set<() => void>()
    #stopWaiting: (() => void) | undefined
    /** The local step of start(): send waits for it. Rejected by stop(). */
    readonly #local: { promise: Promise<void>; resolve(): void; reject(e: Error): void }
    readonly #msgCbs = new Set<(m: IncomingMessage) => void | Promise<void>>()
    /** Stored inbox: this instance's view of the device's stored inbox, as the real transport has one. */
    readonly #inbox: DurableInbox
    /** Replayed while no callback listened; handed over by onMessage. */
    #undelivered: IncomingMessage[] = []
    readonly #inviteCbs = new Set<(i: IncomingInvite) => void>()
    readonly #statusCbs = new Set<(s: RelayStatus[]) => void>()
    /** Welcomes already handed to this instance; each restart hands them again. */
    readonly #offered = new Set<string>()
    readonly #inviting = new Map<PubkeyHex, Promise<{ groupId: string }>>()

    constructor(pubkey: PubkeyHex, dev: Device, relays: string[], listPubkey: PubkeyHex, listRelays?: string[]) {
      this.pubkey = pubkey
      this.#dev = dev
      this.#relays = relays.length > 0 ? relays : ['fake://relay']
      this.#listPubkey = listPubkey
      this.#listRelays = listRelays?.length ? [...listRelays] : this.#relays
      let resolve!: () => void
      let reject!: (e: Error) => void
      const promise = new Promise<void>((res, rej) => {
        resolve = res
        reject = rej
      })
      promise.catch(() => {})
      this.#local = { promise, resolve, reject }
      this.#inbox = createDurableInbox(dev.inbox, {
        timers: clock.timers,
        maxEntries: opts.inboxMax,
        warn: (...args: unknown[]) => hub.onWarn?.(pubkey, String(args[0]), args.slice(1)),
      })
    }

    running(): boolean {
      return this.#started && !this.#stopped
    }
    canReceive(groupId: string): boolean {
      return !this.#unreadable.has(groupId)
    }
    healthChanged(): void {
      if (!this.running()) return
      for (const cb of [...this.#healthCbs]) cb()
    }
    kpChanged(): void {
      if (!this.running()) return
      for (const cb of [...this.#kpCbs]) cb()
    }
    hasMessageListener(): boolean {
      return this.#msgCbs.size > 0
    }
    /** Stored inbox: put, the callbacks, then handled, in the order the real transport does it. */
    emitMessage(m: IncomingMessage, seq: number): void {
      this.#inbox.put(m.id, { seq, message: m })
      this.#hand(m)
    }
    #hand(m: IncomingMessage): void {
      if (this.#msgCbs.size === 0) {
        this.#undelivered.push(m)
        return
      }
      const results: Promise<unknown>[] = []
      for (const cb of [...this.#msgCbs]) {
        try {
          results.push(Promise.resolve(cb(m)))
        } catch {
          // a callback that throws at once counts as handled, as in the real transport
        }
      }
      this.#inbox.handled(m.id, Promise.all(results))
    }
    offerInvite(inv: PendingInvite): void {
      if (this.#offered.has(inv.id) || this.#inviteCbs.size === 0) return
      this.#offered.add(inv.id)
      // Always through a virtual timer, never inside the call that caused it.
      clock.timers.set(() => {
        if (!this.running() || !this.#dev.invites.includes(inv)) {
          this.#offered.delete(inv.id)
          return
        }
        if (!joinable(this.#dev, inv)) {
          // Made for a key package this device no longer holds: marked read, never surfaced
          // (the real transport's canJoinInvite).
          this.#dev.invites = this.#dev.invites.filter((x) => x !== inv)
          for (const r of inviteLog) if (r.id === inv.id && r.to === this.pubkey && r.toDevice === this.#dev.device) r.dropped = true
          return
        }
        const out: IncomingInvite = {
          id: inv.id,
          inviterPubkey: inv.from,
          receivedAt: Math.floor(clock.now() / 1000),
          sentAt: inv.sentAt,
        }
        for (const cb of [...this.#inviteCbs]) cb(out)
      }, 1)
    }
    notifyStatus(): void {
      const s = this.relayStatus()
      for (const cb of [...this.#statusCbs]) cb(s)
    }
    /** Stopped by a newer transport of the same device. */
    supersede(): void {
      this.#stopped = true
    }

    async start(): Promise<void> {
      if (this.#stopped) throw new Error(STOPPED)
      const d = this.#dev
      if (!this.#begun) {
        this.#begun = true
        // The local step: the stored groups are loaded (one that cannot be read is skipped).
        if (d.live && d.live !== this) d.live.supersede()
        d.live = this
        this.#unreadable = new Set(d.unreadable)
        // Stored inbox: what the last session received and did not finish goes first, every entry
        // whatever its room, without waiting for the callbacks.
        const replay = await this.#inbox.pending()
        if (this.#stopped) throw new Error(STOPPED)
        for (const { message } of replay) this.#hand(message)
        this.#started = true
        this.#local.resolve()
        this.healthChanged()
      } else {
        await this.#local.promise
      }
      // The online step waits for the network, however long.
      while (!up(this.pubkey)) {
        await new Promise<void>((resolve, reject) => {
          const waiters = upWaiters.get(this.pubkey) ?? new Set()
          upWaiters.set(this.pubkey, waiters)
          const done = () => {
            waiters.delete(done)
            this.#stopWaiting = undefined
            resolve()
          }
          waiters.add(done)
          this.#stopWaiting = () => {
            waiters.delete(done)
            reject(new Error(STOPPED))
          }
        })
        if (this.#stopped) throw new Error(STOPPED)
      }
      if (this.#stopped) throw new Error(STOPPED)
      // A new key package each session; the previous session's go 3 minutes later (the
      // Welcomes waiting for them are still joined at this start).
      for (const id of d.kps.keys()) expireKp(d, id, KP_OLD_SESSION_MS)
      publishKp(d)
      d.invitable = true
      // As the real transport: this instance knows its reference only from here on.
      this.#kpKnown = true
      this.kpChanged()
      // Backlog and Welcomes arrive after start() returned, on virtual timers.
      wake(d)
    }

    async stop(): Promise<void> {
      this.#stopped = true
      this.#healthCbs.clear()
      this.#kpCbs.clear()
      this.#stopWaiting?.()
      this.#local.reject(new Error(STOPPED))
      if (this.#dev.live === this) this.#dev.live = null
      // Stored inbox: no more inbox writes or removals; running ones end (bounded).
      await this.#inbox.close()
    }

    fallingBack(): boolean {
      return false
    }

    groupHealth(groupId: string): GroupHealth {
      if (!this.#started) return 'missing'
      if (this.#unreadable.has(groupId)) return 'unreadable'
      if (!this.#dev.joined.has(groupId)) return 'missing'
      return stranded.has(groupId) ? 'stranded' : 'ok'
    }

    onGroupHealth(cb: () => void): Unsub {
      this.#healthCbs.add(cb)
      return () => this.#healthCbs.delete(cb)
    }

    relayStatus(): RelayStatus[] {
      const connected = this.running() && up(this.pubkey)
      return this.#relays.map((url) => ({ url, connected }))
    }

    onRelayStatus(cb: (s: RelayStatus[]) => void): Unsub {
      this.#statusCbs.add(cb)
      return () => this.#statusCbs.delete(cb)
    }

    keyPackageRef(): string | null {
      // null until this start() reached the relays and published (the real transport's
      // #kpRef starts null in every new instance, and while offline it stays so).
      if (!this.#kpKnown) return null
      const k = this.#dev.invitable ? newestKp(this.#dev) : 0
      return k ? refOf(k) : null
    }

    onKeyPackageRef(cb: () => void): Unsub {
      this.#kpCbs.add(cb)
      return () => this.#kpCbs.delete(cb)
    }

    async checkKeyPackage(): Promise<void> {
      // The hub never loses a published key package.
    }

    /**
     * The key-takeover signal as the real transport reads it: a key package of another device of this key (its
     * own slot) whose created_at is after `sinceSec`. The hub has one slot per device, so a
     * package in my own slot is always mine. Not limited to once per 10 minutes.
     */
    async keyUsedElsewhere(sinceSec: number, kopts: { ownSlotOnly?: boolean } = {}): Promise<boolean> {
      // The hub never overwrites one device's slot from another, so the own-slot check is always false.
      if (hub.elsewhereDelayMs > 0) await sleepFor(hub.elsewhereDelayMs)
      if (this.#stopped || !this.#kpKnown || kopts.ownSlotOnly) return false
      for (const d of devicesOf(this.pubkey)) {
        if (d === this.#dev || !d.invitable) continue
        for (const id of d.kps.keys()) if ((kpAt.get(id) ?? 0) > sinceSec * 1000) return true
      }
      return false
    }

    invitePeer(peerPubkey: PubkeyHex, iopts: InviteOptions = {}): Promise<{ groupId: string }> {
      const same = this.#inviting.get(peerPubkey)
      if (same) return same
      const p = this.#invite(peerPubkey, iopts).finally(() => this.#inviting.delete(peerPubkey))
      this.#inviting.set(peerPubkey, p)
      return p
    }

    async #invite(peer: PubkeyHex, iopts: InviteOptions): Promise<{ groupId: string }> {
      if (!this.running()) throw new Error(STOPPED)
      if (!up(this.pubkey)) throw new Error('offline')
      const refused = hub.failInvite(this.pubkey, peer)
      await sleepFor(inviteDelayMs)
      if (!this.running()) throw new Error(STOPPED)
      // With a reference (the QR's kp): only the device whose newest key package
      // on the relays it is; the real transport looks KEY_PACKAGE_FETCH_TRIES times, 1.5 s
      // apart, before it gives up. Without: the peer's newest one, of whichever device
      // published it last (27).
      let only: { d: Device; kp: number } | undefined
      if (iopts.keyPackageRef !== undefined) {
        if (refused) throw new Error('no key package for this peer')
        // The real transport keeps its key package across restarts (it rotates only after a
        // join); the hub makes a new one each session and keeps the old one joinable for a
        // while, so a reference counts while its key package can still be joined. A key
        // package replaced in its slot by a rotation after a join is no longer served by
        // the relays, so a reference to it finds nothing (Device.replaced).
        const ref = iopts.keyPackageRef
        let found: { d: Device; kp: number } | undefined
        for (const x of devicesOf(peer)) {
          if (!x.invitable) continue
          for (const [id, until] of x.kps) if (refOf(id) === ref && !x.replaced.has(id) && (until === undefined || until > clock.now())) found = { d: x, kp: id }
        }
        if (!found) {
          await sleepFor(3 * 1_500)
          throw new Error('the scanned key package is not published')
        }
        only = found
      } else if (refused || !devicesOf(peer).some((d) => d.invitable && newestKp(d) > 0)) throw new Error('no key package for this peer')
      const groupId = randomHex(32)
      groups.set(groupId, {
        id: groupId,
        members: [this.pubkey, peer],
        relays: [...this.#relays],
        admins: [this.pubkey],
        ...(iopts.tag ? { description: iopts.tag } : {}),
      })
      this.#dev.joined.add(groupId)
      this.healthChanged()
      const sentAt = Math.floor((clock.now() + this.#dev.offsetMs) / 1000)
      deliverInvite(this.pubkey, this.#dev.device, peer, groupId, sentAt, only)
      if (inviteFates.get(this.pubkey) === 'deliver-then-throw') {
        // The Welcome went out to some relays, then the call failed and the group was dropped.
        inviteFates.delete(this.pubkey)
        this.#dev.joined.delete(groupId)
        this.healthChanged()
        throw new Error('Welcome was not delivered')
      }
      return { groupId }
    }

    onInvite(cb: (invite: IncomingInvite) => void): Unsub {
      this.#inviteCbs.add(cb)
      // A late listener still gets what is waiting.
      if (this.running()) pumpInvites(this.#dev)
      return () => this.#inviteCbs.delete(cb)
    }

    /** previewWelcome: the description of a Welcome this device could join; nothing changes. */
    async previewInvite(inviteId: string): Promise<{ tag: string | null }> {
      const inv = this.#dev.invites.find((x) => x.id === inviteId)
      if (!this.running() || !inv || !joinable(this.#dev, inv)) return { tag: null }
      this.#preview(inv)
      return { tag: groups.get(inv.groupId)?.description ?? null }
    }

    /** One previewWelcome per waiting Welcome and transport (the real transport's #previewOnce). */
    #preview(inv: PendingInvite): void {
      if (this.#previewed.has(inv)) return
      this.#previewed.add(inv)
      const d = this.#dev
      for (const r of inviteLog) if (r.id === inv.id && r.to === d.pubkey && r.toDevice === d.device) r.previews++
    }

    async acceptInvite(inviteId: string): Promise<{ groupId: string }> {
      if (!this.running()) throw new Error(STOPPED)
      const d = this.#dev
      const inv = d.invites.find((x) => x.id === inviteId)
      if (!inv) throw new Error(d.accepted.has(inviteId) ? 'invite already accepted' : 'unknown invite')
      d.accepting++
      peak.set(
        d.pubkey,
        Math.max(
          peak.get(d.pubkey) ?? 0,
          devicesOf(d.pubkey).reduce((n, x) => n + x.accepting, 0),
        ),
      )
      try {
        await sleepFor(acceptDelayMs)
      } finally {
        d.accepting--
      }
      if (!this.running()) throw new Error(STOPPED)
      if (d.accepted.has(inviteId) || !d.invites.includes(inv)) throw new Error('invite already accepted')
      if (!joinable(d, inv)) throw new Error('no key package for this Welcome')
      // The pre-join check of the real transport: the inviter
      // the only admin, 1 to 8 relays that pass the host rule, here also `fake://`.
      const room = groups.get(inv.groupId)
      this.#preview(inv)
      if (room && !roomShapeOk({ name: APP_NAME, adminPubkeys: room.admins, relays: room.relays }, inv.from, APP_NAME, hubRelayOk)) {
        d.invites = d.invites.filter((x) => x !== inv)
        for (const r of inviteLog) if (r.id === inviteId && r.to === d.pubkey && r.toDevice === d.device) r.dropped = true
        throw new Error('invite refused (shape)')
      }
      d.accepted.add(inviteId)
      d.invites = d.invites.filter((x) => x !== inv)
      d.joined.add(inv.groupId)
      const g = groups.get(inv.groupId)
      if (g) g.joinedOnce = true
      // The used key package goes 10 minutes later; a new one replaces it in its relay slot
      // (transport.ts), so the relays no longer serve the older ones by reference.
      expireKp(d, inv.kp, KP_USED_MS)
      for (const id of d.kps.keys()) d.replaced.add(id)
      publishKp(d)
      this.kpChanged()
      for (const r of inviteLog) {
        if (r.id === inviteId && r.to === d.pubkey && r.toDevice === d.device) {
          r.accepted = true
          r.acceptedAtMs = clock.now()
        }
      }
      this.healthChanged()
      // Messages of this group uploaded before the join follow now.
      pump(d)
      return { groupId: inv.groupId }
    }

    async ignoreInvite(inviteId: string): Promise<void> {
      const d = this.#dev
      if (!d.invites.some((x) => x.id === inviteId)) return
      d.invites = d.invites.filter((x) => x.id !== inviteId)
      for (const r of inviteLog) if (r.id === inviteId && r.to === d.pubkey && r.toDevice === d.device) r.dropped = true
    }

    async send(groupId: string, msg: WireMessage): Promise<void> {
      if (this.#stopped) throw new Error(STOPPED)
      // Waits for this transport's start() to have run its local step, never for the
      // online step. Unlike the real transport a send
      // does not start the transport itself: whoever owns it calls start().
      await this.#local.promise
      if (!this.running()) throw new Error(STOPPED)
      const health = this.groupHealth(groupId)
      if (health === 'missing' || health === 'unreadable') throw new Error('group-unreadable')
      if (!up(this.pubkey)) throw new Error('offline')
      const failure = hub.failSend(this.pubkey, groupId, msg)
      if (failure === 'reject') throw new Error('no relay accepted the message')
      if (typeof failure === 'object' && failure && 'acceptAfterMs' in failure) {
        // A slow relay: it takes the message that much later.
        await sleepFor(Math.max(0, failure.acceptAfterMs))
        if (!this.running()) throw new Error(STOPPED)
      } else if (typeof failure === 'object' && failure) {
        // Nothing goes up; the relays' refusal arrives later, whatever happens meanwhile.
        await sleepFor(Math.max(0, failure.rejectAfterMs))
        throw new Error('no relay accepted the message')
      }
      let id = ids.get(msg)
      if (!id) {
        id = randomHex(32)
        ids.set(msg, id)
      }
      publish(this.pubkey, groupId, JSON.stringify(msg), id, false, this.#dev.offsetMs)
      // The relay took it but did not answer in time.
      if (failure === 'timeout') throw new Error('timeout')
    }

    onMessage(cb: (m: IncomingMessage) => void | Promise<void>): Unsub {
      this.#msgCbs.add(cb)
      if (this.#undelivered.length) {
        const backlog = this.#undelivered
        this.#undelivered = []
        for (const m of backlog) this.#hand(m)
      }
      // Messages that came while nobody listened are handed over now.
      if (this.running()) pump(this.#dev)
      return () => this.#msgCbs.delete(cb)
    }

    async listGroups(): Promise<{ groupId: string; peerPubkey: PubkeyHex | null }[]> {
      const out: { groupId: string; peerPubkey: PubkeyHex | null }[] = []
      for (const id of this.#dev.joined) {
        if (this.#unreadable.has(id)) continue
        const g = groups.get(id)
        if (g) out.push({ groupId: id, peerPubkey: g.members[0] === this.pubkey ? g.members[1] : g.members[0] })
      }
      // A stored group that could not be loaded: listed without its peer.
      for (const id of this.#unreadable) if (this.#dev.joined.has(id)) out.push({ groupId: id, peerPubkey: null })
      return out
    }

    async fetchList(): Promise<ListFetch> {
      if (this.#stopped) throw new Error(STOPPED)
      return fakeFetchList(this.pubkey, this.#listRelays, this.#listPubkey)
    }

    async publishList(payload: string, createdAt: number, relays: string[]): Promise<string[]> {
      if (this.#stopped) throw new Error(STOPPED)
      if (!relays.length) throw new Error('list-rejected')
      return fakePublishList(this.pubkey, this.#listPubkey, payload, createdAt, relays)
    }

    /** This device drops the group and its unreadable mark; nothing is uploaded. */
    async forgetGroup(groupId: string): Promise<void> {
      if (this.#stopped) throw new Error(STOPPED)
      await this.#local.promise
      const d = this.#dev
      const had = d.joined.delete(groupId)
      d.unreadable.delete(groupId)
      const wasUnreadable = this.#unreadable.delete(groupId)
      if (had || wasUnreadable) this.healthChanged()
    }

    peerJoined(groupId: string): boolean {
      const g = groups.get(groupId)
      if (!g || !this.running() || !this.#dev.joined.has(groupId) || this.#unreadable.has(groupId)) return false
      // Only the maker learns it from the joiner's commit (the joiner made no commit to see).
      return g.members[0] === this.pubkey && g.joinedOnce === true
    }
  }

  let thieves = 0
  const hub: FakeHub = {
    clock,
    marmot(device = 'main', mopts = {}) {
      return {
        createTransport(o: TransportOptions): Transport {
          const pk = pubkeyOf(o.secretKeyHex)
          const listPubkey = listPubkeyOf(o.secretKeyHex)
          listKeys.set(pk, listPubkey)
          lastRelays.set(pk, o.listRelays?.length ? [...o.listRelays] : o.relays.length > 0 ? [...o.relays] : ['fake://relay'])
          lastDevice.set(pk, device)
          // Same key and device name: the same hub state, as after a page reload.
          const d = deviceOf(pk, device)
          if (mopts.nowOffsetMs !== undefined) d.offsetMs = mopts.nowOffsetMs
          return new FakeTransport(pk, d, o.relays, listPubkey, o.listRelays)
        },
        pubkeyOf,
        npubOf,
        // Only opts.relays: the list lives on the list relays only.
        findList(opts) {
          const pk = pubkeyOf(opts.secretKeyHex)
          const listPubkey = listPubkeyOf(opts.secretKeyHex)
          listKeys.set(pk, listPubkey)
          return fakeFetchList(pk, opts.relays, listPubkey)
        },
      }
    },
    route: () => 'deliver',
    release(envelopeId) {
      let n = 0
      for (let i = 0; i < holding.length; ) {
        const { d, e } = holding[i]
        if (envelopeId !== undefined && e.id !== envelopeId) {
          i++
          continue
        }
        holding.splice(i, 1)
        n++
        if (d.state.get(e) !== 'held') continue
        d.state.set(e, 'scheduled')
        // Same latency for all: they come due in the order they were held.
        clock.timers.set(() => deliver(d, e, 1), latencyMs)
      }
      return n
    },
    held: () => holding.map((x) => x.e.id),
    failSend: () => false,
    failInvite: () => false,
    setNetwork(pubkey, state) {
      network.set(pubkey, state)
      if (state === 'up') for (const resume of [...(upWaiters.get(pubkey) ?? [])]) resume()
      for (const d of devicesOf(pubkey)) {
        d.live?.notifyStatus()
        if (state === 'up') wake(d)
      }
    },
    setOffset(pubkey, device, ms) {
      deviceOf(pubkey, device).offsetMs = ms
    },
    wipe(pubkey, device) {
      for (const d of devicesOf(pubkey)) {
        if (device !== undefined && d.device !== device) continue
        d.live?.supersede()
        d.live = null
        for (let i = holding.length - 1; i >= 0; i--) if (holding[i].d === d) holding.splice(i, 1)
        devices.delete(d.key)
        if (lastDevice.get(pubkey) === d.device) lastDevice.delete(pubkey)
      }
    },
    dropInvite(match) {
      dropMatchers.push(match)
    },
    inviteFate(pubkey, fate) {
      inviteFates.set(pubkey, fate)
    },
    rotateKeyPackage(pubkey, device) {
      const d = primary(pubkey, device)
      for (const id of d.kps.keys()) {
        d.kps.set(id, clock.now())
        d.replaced.add(id)
      }
      publishKp(d)
      d.live?.kpChanged()
    },
    injectInvite(from, to, iopts = {}) {
      const groupId = randomHex(32)
      groups.set(groupId, {
        id: groupId,
        members: [from, to],
        relays: iopts.relays ?? ['fake://relay'],
        admins: iopts.admins ?? [from],
        ...(iopts.tag ? { description: iopts.tag } : {}),
      })
      const rec = deliverInvite(from, '', to, groupId, iopts.sentAt ?? Math.floor(clock.now() / 1000))
      if (!rec) throw new Error('injectInvite: the receiver has no key package')
      return rec
    },
    thief(victim) {
      const device = `thief${++thieves}`
      deviceOf(victim, device)
      return device
    },
    injectInvites(n, to) {
      const out: InviteRecord[] = []
      for (let i = 0; i < n; i++) {
        let from = randomHex(32)
        // Half lower than `to` (a first link's inviter), half higher (a request).
        while (i % 2 === 0 ? from >= to : from <= to) from = randomHex(32)
        out.push(hub.injectInvite(from, to))
      }
      return out
    },
    peakAccepts: (pubkey) => peak.get(pubkey) ?? 0,
    kpRefOf(pubkey, device) {
      const d = device === undefined ? primary(pubkey) : devices.get(`${pubkey}/${device}`)
      const k = d?.invitable ? newestKp(d) : 0
      return k ? refOf(k) : null
    },
    tagOf: (groupId) => groups.get(groupId)?.description,
    unreadable(pubkey, groupId, on = true) {
      for (const d of [primary(pubkey), ...devicesOf(pubkey)]) {
        if (on) d.unreadable.add(groupId)
        else d.unreadable.delete(groupId)
      }
    },
    strand(groupId, on = true) {
      if (on) stranded.add(groupId)
      else stranded.delete(groupId)
      for (const d of devices.values()) d.live?.healthChanged()
    },
    inject(from, groupId, json) {
      return publish(from, groupId, json, randomHex(32), true)
    },
    log,
    unparsed,
    inbox(pubkey) {
      return hub.inboxEntries(pubkey).map((e) => e.message.id)
    },
    inboxEntries(pubkey) {
      return [...primary(pubkey).inbox.data.values()].map((e) => structuredClone(e)).sort((a, b) => a.seq - b.seq)
    },
    health(pubkey, groupId) {
      const t = primary(pubkey).live
      return t && t.running() ? t.groupHealth(groupId) : null
    },
    listFate: () => 'ok',
    elsewhereDelayMs: 0,
    kpLog,
    listLog,
    listKeyOf: (owner) => listKeys.get(owner),
    listOf: storedList,
    loseList(relay, listPubkey) {
      listStore.get(relay)?.delete(listPubkey)
    },
    putList(relay, listPubkey, payload, createdAt) {
      storeList(relay, listPubkey, { payload, createdAt })
    },
    injectListCopy(owner, body, opts = {}) {
      const listPubkey = listKeys.get(owner)
      if (!listPubkey) throw new Error('injectListCopy: the hub has not seen this key yet')
      const payload = typeof body === 'string' ? body : encodeList(body)
      const relays = opts.relays ?? lastRelays.get(owner) ?? ['fake://relay']
      for (const relay of relays) {
        const newest = listStore.get(relay)?.get(listPubkey)?.createdAt ?? 0
        const createdAt = opts.createdAt ?? Math.max(Math.floor(clock.now() / 1000), newest + 1)
        storeList(relay, listPubkey, { payload, createdAt })
      }
    },
    loseGroup(pubkey, groupId) {
      const d = primary(pubkey)
      if (d.joined.delete(groupId)) d.live?.healthChanged()
    },
    invites: inviteLog,
    creatorOf: (groupId) => groups.get(groupId)?.members[0],
    groupsOf: (pubkey, device) => [...primary(pubkey, device).joined],
  }
  return hub
}

// ---------------------------------------------------------------- harness KV

export interface KvWrite {
  tag: string
  op: 'set' | 'del'
  key: string
}

export interface HarnessKV {
  /** The handle one engine generation writes through. All handles see one space. Values are structured-cloned. */
  handle(tag: string): KV
  /** A copy of the current value, synchronously. For invariants inside onPublish. */
  peek<T>(key: string): T | undefined
  /**
   * Reads of `key` reject Error('storage-damaged') (an item that fails its authentication)
   * until a write of it replaces the value.
   */
  damage(key: string): void
  /**
   * Writes through a closed handle are not applied. A handle closed by a restart or stop
   * ('stop', the default) finishes them at once and puts them in lateWrites. A handle
   * closed by a crash ('crash') is a generation whose power went off: its writes are
   * neither applied nor ever finished, and are not late writes.
   * A pending crashAfter of that handle is dropped.
   */
  close(tag: string, how?: 'stop' | 'crash'): void
  /**
   * The next write (set or del) of `key`, through any handle, is neither applied nor ever
   * finished; the writes after it go on as usual. One call, one write.
   */
  hangNext(key: string): void
  /**
   * The next write (set or del) of `key`, through any handle, is not applied and rejects
   * (a full or broken browser store); the writes after it go on as usual. One
   * call, one write.
   */
  failNext(key: string): void
  /**
   * Arms the handle that is open now (the last one made and not closed). Of the writes
   * through it from now on, the first n are applied. The moment write n+1 (set or del)
   * comes in, the returned promise resolves; that write and every later one is neither
   * applied nor ever finished. That moment is "the power went off". Closing the handle
   * disarms it. New handles are not armed.
   */
  crashAfter(n: number): Promise<void>
  /**
   * Like crashAfter, but the power goes off at the first write through the open handle
   * for which `pred` is true (that write is not applied). For a crash point named by
   * content rather than by count.
   */
  crashWhen(pred: (w: KvWrite, value: unknown) => boolean): Promise<void>
  /** Every key stored now, synchronously. Leak searches read the whole KV through this. */
  keys(): string[]
  /** Puts a value in place without a handle and without a log entry: the harness's own setup. */
  seed(key: string, value: unknown): void
  /** Applied writes, in order. */
  readonly writes: readonly KvWrite[]
  /** Writes after a restart or stop. A check asserts this stays empty. */
  readonly lateWrites: readonly KvWrite[]
  /** Optional observer of every applied write and its value (finding a write point by content). */
  onWrite?: (w: KvWrite, value: unknown) => void
}

export function createHarnessKV(): HarnessKV {
  const data = new Map<string, unknown>()
  /** Keys whose reads fail as damaged until written (damage). */
  const damaged = new Set<string>()
  const writes: KvWrite[] = []
  const lateWrites: KvWrite[] = []
  const closed = new Map<string, 'stop' | 'crash'>()
  /** Keys whose next write hangs (hangNext), one entry per call. */
  const hangs: string[] = []
  /** Keys whose next write rejects (failNext), one entry per call. */
  const fails: string[] = []
  let openTag: string | null = null
  let armed: {
    tag: string
    left: number
    pred?: (w: KvWrite, value: unknown) => boolean
    fire: () => void
  } | null = null
  const never = new Promise<void>(() => {})

  function write(tag: string, op: 'set' | 'del', key: string, value?: unknown): Promise<void> {
    const w: KvWrite = { tag, op, key }
    const how = closed.get(tag)
    if (how === 'crash') return never
    if (how) {
      lateWrites.push(w)
      return Promise.resolve()
    }
    const hang = hangs.indexOf(key)
    if (hang >= 0) {
      hangs.splice(hang, 1)
      return never
    }
    const fail = fails.indexOf(key)
    if (fail >= 0) {
      fails.splice(fail, 1)
      return Promise.reject(new Error('storage-unavailable'))
    }
    if (armed && armed.tag === tag) {
      // left < 0: the power is already off; nothing through this handle lands any more.
      const off = armed.left < 0 || (armed.pred ? armed.pred(w, value) : armed.left === 0)
      if (off) {
        armed.left = -1
        armed.fire()
        return never
      }
      if (!armed.pred) armed.left--
    }
    damaged.delete(key)
    if (op === 'set') data.set(key, structuredClone(value))
    else data.delete(key)
    writes.push(w)
    kv.onWrite?.(w, op === 'set' ? structuredClone(value) : undefined)
    return Promise.resolve()
  }

  const kv: HarnessKV = {
    handle(tag) {
      if (closed.has(tag)) throw new Error(`handle ${tag} was closed`)
      openTag = tag
      return {
        async get<T>(key: string) {
          if (damaged.has(key)) throw new Error('storage-damaged')
          return data.has(key) ? (structuredClone(data.get(key)) as T) : undefined
        },
        set<T>(key: string, value: T) {
          return write(tag, 'set', key, value)
        },
        del(key: string) {
          return write(tag, 'del', key)
        },
        async keys(prefix = '') {
          return [...data.keys()].filter((k) => k.startsWith(prefix))
        },
      }
    },
    peek<T>(key: string) {
      return data.has(key) ? (structuredClone(data.get(key)) as T) : undefined
    },
    damage(key) {
      damaged.add(key)
    },
    close(tag, how = 'stop') {
      closed.set(tag, how)
      if (armed?.tag === tag) armed = null
      if (openTag === tag) openTag = null
    },
    hangNext(key) {
      hangs.push(key)
    },
    failNext(key) {
      fails.push(key)
    },
    crashAfter(n) {
      const tag = openTag
      if (!tag) return Promise.reject(new Error('crashAfter: no open handle'))
      return new Promise<void>((resolve) => {
        armed = { tag, left: n, fire: resolve }
      })
    },
    crashWhen(pred) {
      const tag = openTag
      if (!tag) return Promise.reject(new Error('crashWhen: no open handle'))
      return new Promise<void>((resolve) => {
        armed = { tag, left: 0, pred, fire: resolve }
      })
    },
    keys() {
      return [...data.keys()]
    },
    seed(key, value) {
      data.set(key, structuredClone(value))
    },
    writes,
    lateWrites,
  }
  return kv
}
