/**
 * ilchon engine: all application logic. No DOM and no React, so the same code
 * runs in the browser and in the Node end-to-end script.
 *
 * Layout of this file
 *   1. persistence   in-memory truth + serialized writes to KV
 *   2. sending       per-group outbox with retries
 *   3. connect       QR handshake (see contracts.ts)
 *   4. matching      private three-round match per contact
 *   5. rooms / contacts / settings
 *   6. boot, stop, reset
 */
import { createStore, type StoreApi } from 'zustand/vanilla'
import {
  CODE_DISPLAY_MS,
  CODE_REDEEM_MS,
  RESPOND_WINDOW_DEMO_MS,
  RESPOND_WINDOW_MS,
  type ChatMessage,
  type ConnectState,
  type Contact,
  type Currency,
  type Engine,
  type EngineDeps,
  type IlchonActions,
  type IlchonState,
  type IncomingInvite,
  type IncomingMessage,
  type Lang,
  type LockChoice,
  type LockedVault,
  MIN_PASSWORD,
  type Match,
  type Offer,
  type OfferInput,
  type PublicOffer,
  type PubkeyHex,
  type Rates,
  type Settings,
  type Side,
  type Transport,
  type Unsub,
  type WireMessage,
} from '../contracts'
import { systemText } from './text'
import { createSerial, randomId, short, sleep } from './util'

// ---------------------------------------------------------------- tuning

/** A Welcome is accepted only from someone I scanned this recently. */
const SCAN_TRUST_MS = 5 * 60_000
/** A Welcome from someone I have not scanned yet waits this long for my scan. */
const INVITE_BUFFER_MS = 5 * 60_000
/** A link that is not complete this long after my scan is abandoned. */
const LINK_TIMEOUT_MS = 120_000
/** Gaps between repeats of the inviter's hello while the link is incomplete. */
const HELLO_RESEND_MS = [6_000, 10_000, 15_000, 30_000]
/** Backoff for a message a relay did not take. After the last one it is dropped. */
const SEND_RETRY_MS = [2_000, 5_000, 10_000, 20_000, 40_000]
const RATES_EVERY_MS = 60_000
const ROOM_CAP = 200
const SEEN_CAP = 500
const ABANDONED_CAP = 200
const RESP_SESSION_TTL_MS = 10 * 60_000
const CHAT_MAX = 2000
const NAME_MAX = 40
/** Demo mode only: how often a refused round is tried again once the window passed. */
const MX_RETRIES = 2
/** How long a reauth (or a fresh unlock/create) lets changeLock, exportBackup and exportKey run. */
const REAUTH_MS = 5 * 60_000

// ---------------------------------------------------------------- public extras

export interface EngineHooks {
  /** Language used until the user picks one. */
  defaultLang?: Lang
  /**
   * Runs at the end of resetAll, after the engine's KV data is gone. The browser
   * wipes the transport stores and reloads here; it rejects when that failed.
   * `pubkey` is the identity being wiped, also known while locked.
   */
  onReset?: (info: { pubkey?: PubkeyHex }) => void | Promise<void>
  /**
   * Another tab of this profile wrote or wiped the identity. The browser reloads
   * here. Without it no cross-tab channel is opened (Node scripts).
   */
  onExternalChange?: () => void
  /** Diagnostics. Never receives keys, labels or offer contents. */
  debug?: (event: string, info?: Record<string, string | number | boolean>) => void
}

export type IlchonEngine = Engine & { store: StoreApi<IlchonState> }

/**
 * Storage namespace of the transport for one identity of a profile. Keyed by
 * identity, so a profile that was reset and got a new key never reads the old
 * identity's groups. Reset uses the same function to find the store to purge.
 */
export function transportNamespace(profileNamespace: string, pubkey: PubkeyHex): string {
  return `${profileNamespace}:${pubkey.slice(0, 12)}`
}

// ---------------------------------------------------------------- private records

interface CodeRec {
  code: string
  createdAt: number
  used: boolean
  usedBy?: PubkeyHex
}

/** One scan of a peer's QR. Doubles as the record of the link in progress. */
interface ScanRec {
  pk: PubkeyHex
  /** The peer's one-time code. */
  code: string
  at: number
  /** True when my pubkey sorts lower, so I create the group. */
  inviter: boolean
  groupId?: string
  /**
   * Invitee only: I verified the inviter's hello and sent my reply. I become a
   * contact only once the inviter shows it accepted that reply.
   */
  replied?: boolean
  /**
   * Re-adding a deleted contact over the group we still share: I sent hello
   * { code: peer's code } and restore the contact only once the peer echoes it,
   * which proves the code was one it issued just now.
   */
  restore?: boolean
}

/** Inviter: a confirmation hello that must reach the invitee, kept across reloads. */
interface PendingConfirm {
  groupId: string
  code: string
  at: number
}

/** A round I may not start yet because the shared round budget with that contact is used. */
interface DeferredRound {
  offerId: string
  retry: boolean
}

interface InitSession {
  sid: string
  contactId: PubkeyHex
  secret: string
  offerId: string
  at: number
  /** A repeat after a refusal. Not counted in matchProgress again. */
  retry?: boolean
}

interface RespSession {
  sid: string
  contactId: PubkeyHex
  pq: string
  /** Null when I answered with a random label. */
  offerId: string | null
  at: number
}

interface Tombstone {
  groupId: string
  at: number
}

type Wire<T extends WireMessage['t']> = Extract<WireMessage, { t: T }>

const ZERO_PROGRESS = { asked: 0, answered: 0 }

function publicOf(o: Offer): PublicOffer {
  return { side: o.side, currency: o.currency, amount: o.amount, feePct: o.feePct, createdAt: o.createdAt }
}

function validAmount(n: unknown): n is number {
  return typeof n === 'number' && Number.isFinite(n) && n > 0
}

function validFee(n: unknown): n is number {
  return typeof n === 'number' && Number.isFinite(n) && n >= -50 && n <= 50
}

/** Wire input is untrusted even from a contact. */
function asSide(v: unknown): Side | null {
  return v === 'buy' || v === 'sell' ? v : null
}

function asCurrency(v: unknown): Currency | null {
  return v === 'KRW' || v === 'USD' ? v : null
}

function parsePublicOffer(v: unknown): PublicOffer | null {
  if (typeof v !== 'object' || v === null) return null
  const raw = v as Record<string, unknown>
  const side = asSide(raw.side)
  const currency = asCurrency(raw.currency)
  const amount = raw.amount
  const feePct = raw.feePct
  const createdAt = raw.createdAt
  if (!side || !currency || !validAmount(amount) || !validFee(feePct)) return null
  return {
    side,
    currency,
    amount,
    feePct,
    createdAt: typeof createdAt === 'number' && Number.isFinite(createdAt) ? createdAt : 0,
  }
}

// ---------------------------------------------------------------- engine

export function createEngine(deps: EngineDeps, hooks: EngineHooks = {}): IlchonEngine {
  const { kv, marmot, match, connect } = deps
  const now = deps.now ?? (() => Date.now())
  const debug = hooks.debug ?? (() => {})

  const store = createStore<IlchonState>(() => ({
    boot: 'starting',
    me: null,
    relays: [],
    contacts: [],
    myOffer: null,
    matches: [],
    matchProgress: ZERO_PROGRESS,
    rooms: {},
    connect: { phase: 'idle' },
    rates: {},
    lock: { method: null, passkeySupported: null, backedUp: false, migrated: false },
    // Demo mode weakens the one-round-per-day limit, so it is opt-in (Settings or ?demo=1).
    settings: { lang: hooks.defaultLang ?? 'ko', sort: 'amount', demoMode: false },
  }))
  const get = store.getState
  const set = (patch: Partial<IlchonState>) => store.setState(patch)

  /** The secret key. Lives only in memory, and only after unlock. */
  let sk = ''
  /** The locked key as stored in KV under 'vault'. */
  let vaultRec: LockedVault | null = null
  /** An identity action (create, restore, unlock, change lock) is running. */
  let identityBusy = false
  /** Until when a sensitive action may run without proving the lock again. */
  let reauthUntil = 0
  /** checkBackup's result, so restoreIdentity can start WebAuthn straight from the tap. */
  let pendingRestore: { text: string; password: string; secret: string } | null = null
  /** NIP-49 key-security byte for exported backups (0 once the key sat unencrypted). */
  let ksb: 0 | 1 | 2 = 1
  /** Tells other tabs of this profile that the identity changed. Browser only. */
  const channel: BroadcastChannel | null =
    hooks.onExternalChange && typeof BroadcastChannel !== 'undefined'
      ? new BroadcastChannel(`ilchon-identity:${deps.namespace}`)
      : null
  if (channel) channel.onmessage = () => hooks.onExternalChange?.()
  let me: PubkeyHex = ''
  let transport: Transport | null = null
  /** No more network or timers. */
  let stopped = false
  /** No more writes to KV (reset in progress). */
  let frozen = false

  // State that the UI does not read lives here, not in the store.
  const mem = {
    tombstones: {} as Record<PubkeyHex, Tombstone>,
    /** contact -> id of my offer for which the match with them was verified. */
    verified: {} as Record<PubkeyHex, string>,
    codes: [] as CodeRec[],
    scans: {} as Record<PubkeyHex, ScanRec>,
    init: {} as Record<string, InitSession>,
    resp: {} as Record<string, RespSession>,
    /**
     * pubkey -> when I last used a match round with it, in either role: I
     * answered its round 1, or I completed a round I started. One round per
     * contact per window, whoever starts it, so neither side can probe the
     * other with guessed labels.
     */
    respondLog: {} as Record<PubkeyHex, number>,
    /** contact -> a round of my current offer waiting for the round window to pass. */
    deferred: {} as Record<PubkeyHex, DeferredRound>,
    /** invitee -> my confirmation hello that may not have reached it yet. */
    confirms: {} as Record<PubkeyHex, PendingConfirm>,
    seen: [] as string[],
    abandoned: [] as string[],
  }
  const seenSet = new Set<string>()

  // Timers are tracked by my own ids so nothing here depends on whether the
  // host returns a number (browser) or an object (Node) from setTimeout.
  const timers = new Map<number, () => void>()
  let nextTimerId = 1
  function later(ms: number, fn: () => void): number {
    const id = nextTimerId++
    const handle = setTimeout(() => {
      timers.delete(id)
      if (!stopped) fn()
    }, ms)
    timers.set(id, () => clearTimeout(handle))
    return id
  }
  function cancel(id: number | undefined): void {
    if (id === undefined) return
    timers.get(id)?.()
    timers.delete(id)
  }

  const enqueue = createSerial((key, e) =>
    debug('task-error', { peer: short(key), error: e instanceof Error ? e.message : String(e) }),
  )

  function contactOf(pk: PubkeyHex): Contact | undefined {
    return get().contacts.find((c) => c.id === pk)
  }
  /** The contact, but only when the message came through the group I linked with them. */
  function activeContact(pk: PubkeyHex, groupId: string): Contact | undefined {
    const c = contactOf(pk)
    return c && c.groupId === groupId ? c : undefined
  }

  // ============================================================== 1. persistence

  const snapshots = {
    contacts: () => get().contacts,
    tombstones: () => mem.tombstones,
    offer: () => get().myOffer,
    matches: () => get().matches,
    verified: () => mem.verified,
    progress: () => get().matchProgress,
    rooms: () => get().rooms,
    settings: () => get().settings,
    codes: () => mem.codes,
    scans: () => mem.scans,
    init: () => mem.init,
    resp: () => mem.resp,
    respondLog: () => mem.respondLog,
    deferred: () => mem.deferred,
    confirms: () => mem.confirms,
    seen: () => mem.seen,
    abandoned: () => mem.abandoned,
  } satisfies Record<string, () => unknown>
  type StoreKey = keyof typeof snapshots

  let writeChain: Promise<void> = Promise.resolve()
  const queuedWrites = new Map<StoreKey, Promise<boolean>>()

  /**
   * Write the current value of `key`. Writes run one at a time, and a write
   * that has not started yet absorbs later requests for the same key.
   * Never rejects; resolves false when the value did not reach storage.
   */
  function save(key: StoreKey): Promise<boolean> {
    if (frozen) return Promise.resolve(false)
    const queued = queuedWrites.get(key)
    if (queued) return queued
    const p = writeChain.then(async () => {
      queuedWrites.delete(key)
      if (frozen) return false
      try {
        await kv.set(key, snapshots[key]())
        return true
      } catch {
        debug('persist-failed', { key })
        return false
      }
    })
    writeChain = p.then(() => {})
    queuedWrites.set(key, p)
    return p
  }

  async function load(): Promise<void> {
    const t = now()
    const contacts = (await kv.get<Contact[]>('contacts')) ?? []
    const offer = (await kv.get<Offer | null>('offer')) ?? null
    const matches = (await kv.get<Match[]>('matches')) ?? []
    const progress = (await kv.get<IlchonState['matchProgress']>('progress')) ?? ZERO_PROGRESS
    const rooms = (await kv.get<IlchonState['rooms']>('rooms')) ?? {}
    // The outbox lives in memory: a message still 'sending' at the last stop was never delivered.
    for (const [pk, list] of Object.entries(rooms)) {
      if (list.some((x) => x.status === 'sending')) {
        rooms[pk] = list.map((x) => (x.status === 'sending' ? { ...x, status: 'failed' as const } : x))
      }
    }
    const settings = await kv.get<Partial<Settings>>('settings')

    mem.tombstones = (await kv.get<Record<PubkeyHex, Tombstone>>('tombstones')) ?? {}
    mem.verified = (await kv.get<Record<PubkeyHex, string>>('verified')) ?? {}
    mem.codes = ((await kv.get<CodeRec[]>('codes')) ?? []).filter((c) => t - c.createdAt <= CODE_REDEEM_MS * 2)
    mem.scans = (await kv.get<Record<PubkeyHex, ScanRec>>('scans')) ?? {}
    mem.init = (await kv.get<Record<string, InitSession>>('init')) ?? {}
    mem.resp = (await kv.get<Record<string, RespSession>>('resp')) ?? {}
    mem.respondLog = (await kv.get<Record<PubkeyHex, number>>('respondLog')) ?? {}
    mem.deferred = (await kv.get<Record<PubkeyHex, DeferredRound>>('deferred')) ?? {}
    mem.confirms = (await kv.get<Record<PubkeyHex, PendingConfirm>>('confirms')) ?? {}
    mem.seen = (await kv.get<string[]>('seen')) ?? []
    mem.abandoned = (await kv.get<string[]>('abandoned')) ?? []
    seenSet.clear()
    for (const id of mem.seen) seenSet.add(id)

    // Sessions of an offer that no longer exists can never complete.
    for (const [sid, s] of Object.entries(mem.init)) if (!offer || s.offerId !== offer.id) delete mem.init[sid]
    for (const [pk, d] of Object.entries(mem.deferred)) if (!offer || d.offerId !== offer.id) delete mem.deferred[pk]
    pruneRespSessions(t)

    set({
      contacts,
      myOffer: offer,
      matches,
      matchProgress: progress,
      rooms,
      settings: { ...get().settings, ...settings },
    })
  }

  function remember(id: string): void {
    seenSet.add(id)
    mem.seen.push(id)
    if (mem.seen.length > SEEN_CAP) {
      for (const old of mem.seen.splice(0, mem.seen.length - SEEN_CAP)) seenSet.delete(old)
    }
    void save('seen')
  }

  function abandon(groupId: string): void {
    if (mem.abandoned.includes(groupId)) return
    mem.abandoned.push(groupId)
    if (mem.abandoned.length > ABANDONED_CAP) mem.abandoned.splice(0, mem.abandoned.length - ABANDONED_CAP)
    void save('abandoned')
    debug('group-abandoned')
  }

  // ============================================================== 2. sending

  interface SendOpts {
    /** The peer of the group. With it, the message is checked again right before every attempt. */
    peer?: PubkeyHex
    /** m3 only: the offer the round was for. */
    offerId?: string
    /** Called once: true when a relay took the message, false when it was dropped. */
    settle?: (ok: boolean) => void
  }
  interface OutItem extends SendOpts {
    msg: WireMessage
    tries: number
  }
  interface Outbox {
    items: OutItem[]
  }
  /** Groups that have a message waiting for a retry. Later messages queue behind it. */
  const outbox = new Map<string, Outbox>()

  function sameOffer(a: PublicOffer, b: PublicOffer): boolean {
    return (
      a.side === b.side &&
      a.currency === b.currency &&
      a.amount === b.amount &&
      a.feePct === b.feePct &&
      a.createdAt === b.createdAt
    )
  }

  /**
   * Whether a queued message may still go out. A retry can run long after the
   * message was made; by then the contact may be deleted, the round dead or my
   * offer changed, and none of that may leak through a late send.
   */
  function stillValid(groupId: string, it: OutItem): boolean {
    const pk = it.peer
    if (!pk) return true
    const msg = it.msg
    const live = activeContact(pk, groupId) !== undefined
    const ghost = !live && mem.tombstones[pk]?.groupId === groupId
    switch (msg.t) {
      case 'hello':
        return !ghost || mem.scans[pk]?.restore === true
      case 'm1': {
        const s = mem.init[msg.sid]
        return live && s !== undefined && s.contactId === pk && get().myOffer?.id === s.offerId
      }
      case 'm2':
        // Also the random-label answers to a deleted contact: their session lives on.
        return mem.resp[`${pk}:${msg.sid}`] !== undefined
      case 'm3':
        return live && it.offerId !== undefined && get().myOffer?.id === it.offerId
      case 'offer': {
        const cur = get().myOffer
        return live && !!cur && mem.verified[pk] === cur.id && sameOffer(msg.offer, publicOf(cur))
      }
      case 'mx':
      case 'withdraw':
        // A deleted contact keeps getting these, so the delete stays invisible.
        return true
      default:
        return live
    }
  }

  function dropItem(it: OutItem, why: string): void {
    debug('tx-dropped', { t: it.msg.t, why })
    it.settle?.(false)
  }

  /**
   * Send one message. Never throws. Returns false when the message was not
   * accepted right now; it then waits in the outbox and is retried in order.
   */
  async function send(groupId: string, msg: WireMessage, opts: SendOpts = {}): Promise<boolean> {
    const t = transport
    const item: OutItem = { ...opts, msg, tries: 0 }
    if (!t || stopped || mem.abandoned.includes(groupId)) {
      opts.settle?.(false)
      return false
    }
    const waiting = outbox.get(groupId)
    if (waiting) {
      waiting.items.push(item)
      return false
    }
    if (!stillValid(groupId, item)) {
      dropItem(item, 'stale')
      return false
    }
    try {
      await t.send(groupId, msg)
      debug('tx', { t: msg.t })
      opts.settle?.(true)
      return true
    } catch {
      debug('tx-failed', { t: msg.t })
      item.tries = 1
      const box = outbox.get(groupId)
      if (box) {
        box.items.push(item)
      } else {
        outbox.set(groupId, { items: [item] })
        later(SEND_RETRY_MS[0], () => void flush(groupId))
      }
      return false
    }
  }

  async function flush(groupId: string): Promise<void> {
    const box = outbox.get(groupId)
    if (!box) return
    while (box.items.length > 0) {
      const t = transport
      if (!t || stopped || mem.abandoned.includes(groupId)) {
        outbox.delete(groupId)
        for (const it of box.items.splice(0)) dropItem(it, 'closed')
        return
      }
      const head = box.items[0]
      if (!stillValid(groupId, head)) {
        box.items.shift()
        dropItem(head, 'stale')
        continue
      }
      try {
        await t.send(groupId, head.msg)
        debug('tx', { t: head.msg.t, retried: true })
        box.items.shift()
        head.settle?.(true)
      } catch {
        head.tries++
        if (head.tries > SEND_RETRY_MS.length) {
          box.items.shift()
          dropItem(head, 'retries')
          continue
        }
        later(SEND_RETRY_MS[head.tries - 1], () => void flush(groupId))
        return
      }
    }
    outbox.delete(groupId)
  }

  /** Queue a send behind whatever is in progress with this contact. */
  function sendLater(
    contactId: PubkeyHex,
    groupId: string,
    make: () => WireMessage | null,
    settle?: (ok: boolean) => void,
  ): void {
    void enqueue(contactId, async () => {
      const msg = make()
      if (msg) await send(groupId, msg, { peer: contactId, settle })
      else settle?.(false)
    })
  }

  // ============================================================== 3. connect

  const linkTimers = new Map<PubkeyHex, number>()
  const buffered = new Map<PubkeyHex, { invite: IncomingInvite; timer: number }>()
  const handledInvites = new Set<string>()
  /** code -> how often a hello carrying it was echoed to a contact (caps a hello loop). */
  const echoes = new Map<string, number>()
  const ECHO_MAX = 4

  function setConnect(patch: Partial<ConnectState>): void {
    set({ connect: { ...get().connect, ...patch } })
  }

  function failConnect(errorKey: NonNullable<ConnectState['errorKey']>): void {
    setConnect({ phase: 'failed', errorKey })
    debug('connect-failed', { errorKey })
  }

  /** Fail the visible flow, but only if it is still about this peer. */
  function failLink(pk: PubkeyHex, errorKey: NonNullable<ConnectState['errorKey']>): void {
    const c = get().connect
    if (c.peerPubkey === pk && (c.phase === 'scanned' || c.phase === 'linking')) failConnect(errorKey)
  }

  function markLinking(pk: PubkeyHex): void {
    const c = get().connect
    if (c.peerPubkey === pk && c.phase === 'scanned') setConnect({ phase: 'linking' })
  }

  function issueCode(): { myPayload: string; myCodeExpiresAt: number } {
    const t = now()
    // Used codes are kept a little longer so a repeated hello is recognised.
    mem.codes = mem.codes.filter((c) => t - c.createdAt <= CODE_REDEEM_MS * 2)
    const code = connect.newCode()
    mem.codes.push({ code, createdAt: t, used: false })
    void save('codes')
    const exp = t + CODE_DISPLAY_MS
    return { myPayload: connect.encodePayload({ v: 1, pk: me, code, exp }), myCodeExpiresAt: exp }
  }

  function startConnect(): void {
    if (!me) return
    set({ connect: { phase: 'showing', ...issueCode() } })
  }

  function rotateConnectCode(): void {
    const phase = get().connect.phase
    if (!me || (phase !== 'showing' && phase !== 'scanned' && phase !== 'linking')) return
    setConnect(issueCode())
  }

  function cancelConnect(): void {
    // A link already in flight finishes or times out in the background.
    set({ connect: { phase: 'idle' } })
  }

  function ignoreInvite(id: string): void {
    const t = transport
    if (t) void t.ignoreInvite(id).catch(() => {})
  }

  function dropBuffered(pk: PubkeyHex): IncomingInvite | undefined {
    const b = buffered.get(pk)
    if (!b) return undefined
    cancel(b.timer)
    buffered.delete(pk)
    return b.invite
  }

  function armLinkTimeout(pk: PubkeyHex, at: number): void {
    cancel(linkTimers.get(pk))
    linkTimers.set(
      pk,
      later(Math.max(0, at + LINK_TIMEOUT_MS - now()), () => expireLink(pk, at)),
    )
  }

  function expireLink(pk: PubkeyHex, at: number): void {
    const scan = mem.scans[pk]
    if (!scan || scan.at !== at) return
    delete mem.scans[pk]
    linkTimers.delete(pk)
    // A failed restore keeps the deleted contact's group: it still gets random-label answers.
    if (scan.groupId && !scan.restore) abandon(scan.groupId)
    void save('scans')
    failLink(pk, 'timeout')
  }

  async function submitScan(text: string): Promise<void> {
    if (!transport || !me || get().boot !== 'ready') {
      failConnect('network')
      return
    }
    const p = connect.decodePayload(text.trim())
    if (!p) return failConnect('invalid')
    const pk = p.pk
    if (pk === me) return failConnect('self')
    if (p.exp < now()) return failConnect('expired')
    if (contactOf(pk)) return failConnect('already')

    const base = get().connect
    const tomb = mem.tombstones[pk]
    if (tomb) {
      // I deleted this contact before. The group still exists and the peer was
      // never told, so scanning them again in person undoes the delete, once
      // the peer echoes the fresh code of the QR I scanned (see onHello).
      const stale = dropBuffered(pk)
      if (stale) ignoreInvite(stale.id)
      const scan: ScanRec = { pk, code: p.code, at: now(), inviter: false, groupId: tomb.groupId, restore: true }
      mem.scans[pk] = scan
      void save('scans')
      armLinkTimeout(pk, scan.at)
      set({ connect: { ...base, phase: 'linking', peerPubkey: pk, errorKey: undefined, contactId: undefined } })
      await enqueue(pk, () => send(tomb.groupId, { t: 'hello', v: 1, code: scan.code }, { peer: pk }).then(() => {}))
      resendHello(scan, tomb.groupId, 0)
      return
    }

    const inviter = me < pk
    const prev = mem.scans[pk]
    if (!inviter && prev?.replied && prev.groupId) {
      // I already answered this peer's hello; only its confirmation is missing.
      set({ connect: { ...base, phase: 'linking', peerPubkey: pk, errorKey: undefined, contactId: undefined } })
      return
    }
    // A fresh scan by the inviter starts over with a fresh group.
    if (prev?.groupId && inviter) abandon(prev.groupId)
    const scan: ScanRec = { pk, code: p.code, at: now(), inviter, groupId: inviter ? undefined : prev?.groupId }
    mem.scans[pk] = scan
    void save('scans')
    armLinkTimeout(pk, scan.at)
    set({
      connect: {
        ...base,
        phase: scan.groupId ? 'linking' : 'scanned',
        peerPubkey: pk,
        errorKey: undefined,
        contactId: undefined,
      },
    })
    debug('scan', { peer: short(pk), inviter })

    if (inviter) {
      await enqueue(pk, () => inviteFlow(scan))
    } else {
      // The peer may have scanned me first; its Welcome is then already waiting.
      const invite = dropBuffered(pk)
      if (invite) await enqueue(pk, () => acceptFlow(invite))
    }
  }

  async function inviteFlow(scan: ScanRec): Promise<void> {
    const t = transport
    const pk = scan.pk
    if (!t || mem.scans[pk] !== scan || scan.groupId || contactOf(pk)) return
    let groupId: string
    try {
      try {
        groupId = (await t.invitePeer(pk)).groupId
      } catch {
        // The peer's KeyPackage may not have reached the relays yet. One more try.
        debug('invite-retry', { peer: short(pk) })
        await sleep(1500)
        groupId = (await t.invitePeer(pk)).groupId
      }
    } catch (e) {
      debug('invite-failed', { peer: short(pk), error: e instanceof Error ? e.message : String(e) })
      if (mem.scans[pk] === scan) {
        delete mem.scans[pk]
        cancel(linkTimers.get(pk))
        linkTimers.delete(pk)
        void save('scans')
      }
      failLink(pk, 'network')
      return
    }
    if (mem.scans[pk] !== scan) {
      // Timed out or scanned again while the group was being created.
      abandon(groupId)
      return
    }
    scan.groupId = groupId
    void save('scans')
    markLinking(pk)
    await send(groupId, { t: 'hello', v: 1, code: scan.code }, { peer: pk })
    resendHello(scan, groupId, 0)
  }

  /** The first hello can be published before the peer has joined. Repeating it is harmless. */
  function resendHello(scan: ScanRec, groupId: string, i: number): void {
    if (i >= HELLO_RESEND_MS.length) return
    later(HELLO_RESEND_MS[i], () => {
      if (mem.scans[scan.pk] !== scan || scan.groupId !== groupId) return
      void send(groupId, { t: 'hello', v: 1, code: scan.code }, { peer: scan.pk })
      resendHello(scan, groupId, i + 1)
    })
  }

  function onInvite(invite: IncomingInvite): void {
    if (stopped || handledInvites.has(invite.id)) return
    handledInvites.add(invite.id)
    const from = invite.inviterPubkey
    debug('invite', { from: short(from) })
    // A current or deleted contact already shares a group with me and has no
    // reason to invite. Leave such a Welcome untouched: after a reload it may be
    // a repeat of the one I joined, and that one must not be dropped.
    if (contactOf(from) || mem.tombstones[from]) return
    // Only the lower pubkey ever invites.
    if (from === me || from > me) {
      ignoreInvite(invite.id)
      return
    }
    const scan = mem.scans[from]
    if (scan && now() - scan.at <= SCAN_TRUST_MS) {
      void enqueue(from, () => acceptFlow(invite))
      return
    }
    // Not scanned (yet). The peer may simply have scanned me first, so keep
    // the Welcome for a while without joining anything.
    const older = dropBuffered(from)
    if (older) ignoreInvite(older.id)
    const timer = later(INVITE_BUFFER_MS, () => {
      if (buffered.get(from)?.invite.id !== invite.id) return
      buffered.delete(from)
      ignoreInvite(invite.id)
    })
    buffered.set(from, { invite, timer })
  }

  async function acceptFlow(invite: IncomingInvite): Promise<void> {
    const t = transport
    const from = invite.inviterPubkey
    const scan = mem.scans[from]
    if (!t || !scan || scan.inviter || contactOf(from) || now() - scan.at > SCAN_TRUST_MS) {
      ignoreInvite(invite.id)
      return
    }
    let groupId: string
    try {
      groupId = (await t.acceptInvite(invite.id)).groupId
    } catch (e) {
      debug('accept-failed', { from: short(from), error: e instanceof Error ? e.message : String(e) })
      // A repeat of a Welcome I already joined fails here; that is not a failed link.
      if (!scan.groupId) failLink(from, 'network')
      return
    }
    if (mem.scans[from] !== scan) {
      abandon(groupId)
      return
    }
    // A second Welcome means the inviter started over; the earlier group is dead.
    if (scan.groupId && scan.groupId !== groupId) abandon(scan.groupId)
    scan.groupId = groupId
    void save('scans')
    markLinking(from)
  }

  /**
   * Hellos of one link, in order:
   *   inviter -> invitee   { code: invitee's code }   (repeated until answered)
   *   invitee -> inviter   { code: inviter's code }   reply; invitee is not a contact yet
   *   inviter -> invitee   { code: inviter's code }   confirm; the inviter made the contact
   * The invitee also takes any later message from the inviter in that group as
   * the confirmation. So a contact never exists on one side only because the
   * other side rejected or timed out.
   */
  async function onHello(m: IncomingMessage, msg: Wire<'hello'>): Promise<void> {
    const from = m.senderPubkey
    if (typeof msg.code !== 'string') return
    const rec = mem.codes.find((c) => c.code === msg.code)
    const fresh = rec !== undefined && !rec.used && now() - rec.createdAt <= CODE_REDEEM_MS

    if (contactOf(from)) {
      if (!activeContact(from, m.groupId)) return
      // Echo a hello back when it carries a code of mine that this contact redeemed:
      //  - inviter: the invitee repeats its reply until it has seen my confirmation
      //    (also after I reloaded, from the persisted confirmation or code record);
      //  - a contact that deleted me scanned my fresh QR to restore me.
      const pending = mem.confirms[from]
      const repeat = rec?.usedBy === from || (pending?.groupId === m.groupId && pending.code === msg.code)
      if (!repeat && !fresh) return
      if (fresh && rec) {
        rec.used = true
        rec.usedBy = from
        void save('codes')
      }
      const n = echoes.get(msg.code) ?? 0
      if (n >= ECHO_MAX) return
      echoes.set(msg.code, n + 1)
      await send(m.groupId, { t: 'hello', v: 1, code: msg.code }, { peer: from })
      return
    }

    const scan = mem.scans[from]
    if (!scan || scan.groupId !== m.groupId) return

    if (scan.restore) {
      // The peer echoed the code of its QR I scanned: restore. Or the peer deleted
      // me too and is restoring with my fresh code: restore and echo it back.
      if (msg.code !== scan.code && !fresh) return
      if (fresh && rec) {
        rec.used = true
        rec.usedBy = from
        void save('codes')
      }
      createContact(from, m.groupId)
      if (fresh) await send(m.groupId, { t: 'hello', v: 1, code: msg.code }, { peer: from })
      return
    }

    if (!scan.inviter && scan.replied) {
      // The inviter's confirmation echoes its own code, which I sent it.
      if (msg.code === scan.code) {
        createContact(from, m.groupId)
        return
      }
      // A repeat of the inviter's first hello: my reply has not reached it yet.
      if (rec?.usedBy === from) await send(m.groupId, { t: 'hello', v: 1, code: scan.code }, { peer: from })
      return
    }

    // The inviter's own displayed code may have rotated out while the invitee
    // joined; age it from my scan, which started this link, not from now.
    const ref = scan.inviter ? scan.at : now()
    if (!rec || rec.used || ref - rec.createdAt > CODE_REDEEM_MS) {
      debug('hello-rejected', { from: short(from) })
      return
    }
    rec.used = true
    rec.usedBy = from
    void save('codes')

    if (scan.inviter) {
      createContact(from, m.groupId)
      // Kept until the invitee shows it is a contact, so a reload cannot lose it.
      mem.confirms[from] = { groupId: m.groupId, code: msg.code, at: now() }
      await save('confirms')
      echoes.set(msg.code, 0)
      await send(m.groupId, { t: 'hello', v: 1, code: msg.code }, { peer: from })
      return
    }

    // Invitee: reply, and wait for the inviter's confirmation. The link gets a
    // fresh deadline so the confirmation has as long as the inviter had.
    scan.replied = true
    scan.at = now()
    void save('scans')
    armLinkTimeout(from, scan.at)
    await send(m.groupId, { t: 'hello', v: 1, code: scan.code }, { peer: from })
    resendHello(scan, m.groupId, 0)
  }

  /** Invitee: any non-hello message from the inviter in our group means it made the contact. */
  function promoteOnTraffic(m: IncomingMessage): void {
    const scan = mem.scans[m.senderPubkey]
    if (!scan || scan.inviter || !scan.replied || scan.groupId !== m.groupId || contactOf(m.senderPubkey)) return
    createContact(m.senderPubkey, m.groupId)
  }

  function createContact(pk: PubkeyHex, groupId: string): void {
    if (contactOf(pk)) return
    const contact: Contact = { id: pk, pubkey: pk, groupId, name: '', createdAt: now() }
    delete mem.scans[pk]
    delete mem.tombstones[pk]
    cancel(linkTimers.get(pk))
    linkTimers.delete(pk)
    set({ contacts: [...get().contacts, contact] })
    void save('contacts')
    void save('scans')
    void save('tombstones')
    const c = get().connect
    if (c.peerPubkey === pk && c.phase !== 'idle') {
      setConnect({ phase: 'done', contactId: pk, errorKey: undefined })
    }
    debug('contact', { peer: short(pk) })
    const offer = get().myOffer
    if (offer) startRound(pk, offer.id, false)
  }

  // ============================================================== 4. matching

  /** contact -> repeats used for the current offer after a refusal (demo mode). */
  const mxRetries = new Map<PubkeyHex, number>()

  /**
   * Which contacts matchProgress counted for the current offer, so a deleted
   * contact can be taken out again. Memory only: after a reload it is rebuilt
   * from the pending round sessions (see dropProgress).
   */
  const progressOf = new Map<PubkeyHex, 'asked' | 'answered'>()
  /** True once progressOf covers every count of the current offer. */
  let progressKnown = false

  function resetProgress(): void {
    progressOf.clear()
    progressKnown = true
  }

  function bump(field: 'asked' | 'answered', contactId: PubkeyHex): void {
    const p = get().matchProgress
    set({ matchProgress: { ...p, [field]: p[field] + 1 } })
    progressOf.set(contactId, field)
    void save('progress')
  }

  /** Take a deleted contact out of matchProgress so the line can still finish. Call before its sessions are dropped. */
  function dropProgress(contactId: PubkeyHex): void {
    const offer = get().myOffer
    if (!offer) return
    let state = progressOf.get(contactId)
    if (state === undefined && !progressKnown) {
      const d = mem.deferred[contactId]
      const pending =
        Object.values(mem.init).some((s) => s.contactId === contactId && s.offerId === offer.id && !s.retry) ||
        (d !== undefined && d.offerId === offer.id && !d.retry)
      state = pending ? 'asked' : 'answered'
    }
    progressOf.delete(contactId)
    if (state === undefined) return
    const p = get().matchProgress
    const asked = Math.max(0, p.asked - 1)
    const answered = Math.min(asked, Math.max(0, p.answered - (state === 'answered' ? 1 : 0)))
    if (asked === p.asked && answered === p.answered) return
    set({ matchProgress: { asked, answered } })
    void save('progress')
  }

  function pruneRespSessions(t: number): void {
    for (const [key, s] of Object.entries(mem.resp)) if (t - s.at > RESP_SESSION_TTL_MS) delete mem.resp[key]
  }

  /** Tell everyone who saw my offer that it is gone, and forget who matched. */
  function retract(): void {
    for (const pk of Object.keys(mem.verified)) {
      const c = contactOf(pk)
      if (c) sendLater(pk, c.groupId, () => ({ t: 'withdraw' }))
    }
    mem.verified = {}
    mem.init = {}
    mem.deferred = {}
    for (const id of deferTimers.values()) cancel(id)
    deferTimers.clear()
    void save('deferred')
    mxRetries.clear()
  }

  function roundWindow(): number {
    return get().settings.demoMode ? RESPOND_WINDOW_DEMO_MS : RESPOND_WINDOW_MS
  }

  /** When the shared round budget with `pk` frees up; 0 when it is free now. */
  function budgetFreeAt(pk: PubkeyHex): number {
    const last = mem.respondLog[pk]
    if (last === undefined) return 0
    const until = last + roundWindow()
    return until > now() ? until : 0
  }

  /** Spend the shared round budget with `pk`. False when that could not be stored: then do not go on. */
  async function spendBudget(pk: PubkeyHex): Promise<boolean> {
    mem.respondLog[pk] = now()
    return save('respondLog')
  }

  const deferTimers = new Map<PubkeyHex, number>()
  /** Slack after the window, so the peer's own window (spent a moment after mine) has passed too. */
  const DEFER_SLACK_MS = 5_000

  /** Start this round once the window passed. Kept across reloads (see armDeferred). */
  function armDeferred(pk: PubkeyHex, d: DeferredRound, at: number): void {
    cancel(deferTimers.get(pk))
    deferTimers.set(
      pk,
      later(Math.max(0, at - now()) + DEFER_SLACK_MS, () => {
        deferTimers.delete(pk)
        if (mem.deferred[pk] !== d) return
        delete mem.deferred[pk]
        void save('deferred')
        startRound(pk, d.offerId, d.retry, true)
      }),
    )
  }

  /**
   * `asked`: matchProgress already counts this contact (a deferred round is
   * counted when it is deferred, so the progress line shows it is waiting).
   */
  function startRound(contactId: PubkeyHex, offerId: string, retry: boolean, asked = false): void {
    void enqueue(contactId, async () => {
      const offer = get().myOffer
      const c = contactOf(contactId)
      if (!offer || offer.id !== offerId || !c) return
      const freeAt = budgetFreeAt(contactId)
      if (freeAt) {
        // I already used a round with this contact in the window (either role).
        const d: DeferredRound = { offerId, retry }
        mem.deferred[contactId] = d
        void save('deferred')
        if (!retry && !asked) bump('asked', contactId)
        armDeferred(contactId, d, freeAt)
        debug('round-deferred', { peer: short(contactId) })
        return
      }
      const sid = randomId()
      const label = match.labelFor({ context: c.groupId, myPubkey: me, peerPubkey: c.pubkey, offer })
      const { secret, p } = match.round1(label)
      const session: InitSession = { sid, contactId, secret, offerId, at: now() }
      if (retry) session.retry = true
      mem.init[sid] = session
      await save('init')
      if (get().myOffer?.id !== offerId || mem.init[sid] !== session) return
      if (!retry && !asked) bump('asked', contactId)
      await send(c.groupId, { t: 'm1', sid, p }, { peer: contactId })
    })
  }

  async function onM1(m: IncomingMessage, msg: Wire<'m1'>): Promise<void> {
    const from = m.senderPubkey
    if (typeof msg.sid !== 'string' || msg.sid.length > 64 || typeof msg.p !== 'string') return
    const active = activeContact(from, m.groupId) !== undefined
    // A deleted contact is still answered, with a random label, so it cannot tell.
    const ghost = !active && mem.tombstones[from]?.groupId === m.groupId
    if (!active && !ghost) return

    const t = now()
    if (budgetFreeAt(from)) {
      await send(m.groupId, { t: 'mx', sid: msg.sid }, { peer: from })
      return
    }
    // Answer only once the spent budget is stored, or a reload would let the peer ask again.
    if (!(await spendBudget(from))) return

    const offer = active ? get().myOffer : null
    let q: string
    let pq: string
    try {
      const label = match.labelFor({ context: m.groupId, myPubkey: me, peerPubkey: from, offer })
      ;({ q, pq } = match.round2(label, msg.p))
    } catch {
      return
    }
    pruneRespSessions(t)
    mem.resp[`${from}:${msg.sid}`] = { sid: msg.sid, contactId: from, pq, offerId: offer ? offer.id : null, at: t }
    await save('resp')
    await send(m.groupId, { t: 'm2', sid: msg.sid, q, pq }, { peer: from })
  }

  async function onM2(m: IncomingMessage, msg: Wire<'m2'>): Promise<void> {
    const from = m.senderPubkey
    if (typeof msg.sid !== 'string' || typeof msg.q !== 'string' || typeof msg.pq !== 'string') return
    const s = mem.init[msg.sid]
    if (!s || s.contactId !== from) return
    delete mem.init[msg.sid]
    void save('init')

    const c = activeContact(from, m.groupId)
    const offer = get().myOffer
    // My offer changed since round 1: the answer no longer means anything.
    if (!c || !offer || offer.id !== s.offerId) return
    if (!s.retry) bump('answered', from)
    // Completing a round spends the budget with this contact, like answering one.
    if (!(await spendBudget(from))) return

    let matched: boolean
    let qp: string
    try {
      ;({ matched, qp } = match.round3(s.secret, msg.q, msg.pq))
    } catch {
      return
    }
    if (matched) {
      mem.verified[from] = offer.id
      await save('verified')
    }
    await send(c.groupId, { t: 'm3', sid: msg.sid, qp }, { peer: from, offerId: s.offerId })
    if (!matched) return
    const current = get().myOffer
    if (current && current.id === s.offerId && mem.verified[from] === current.id) {
      await send(c.groupId, { t: 'offer', offer: publicOf(current) }, { peer: from })
    }
  }

  async function onM3(m: IncomingMessage, msg: Wire<'m3'>): Promise<void> {
    const from = m.senderPubkey
    if (typeof msg.sid !== 'string' || typeof msg.qp !== 'string') return
    const key = `${from}:${msg.sid}`
    const s = mem.resp[key]
    if (!s) return
    delete mem.resp[key]
    void save('resp')

    let matched = false
    try {
      matched = match.finish(s.pq, msg.qp)
    } catch {
      matched = false
    }
    // Nothing is kept about a round that did not match.
    if (!matched) return
    const c = activeContact(from, m.groupId)
    const offer = get().myOffer
    if (!c || !offer || s.offerId === null || offer.id !== s.offerId) return
    mem.verified[from] = offer.id
    await save('verified')
    const cur = get().myOffer
    if (cur && cur.id === s.offerId) await send(c.groupId, { t: 'offer', offer: publicOf(cur) }, { peer: from })
  }

  function onMx(m: IncomingMessage, msg: Wire<'mx'>): void {
    const from = m.senderPubkey
    if (typeof msg.sid !== 'string') return
    const s = mem.init[msg.sid]
    if (!s || s.contactId !== from) return
    delete mem.init[msg.sid]
    void save('init')
    const offer = get().myOffer
    if (!offer || offer.id !== s.offerId) return
    if (!s.retry) bump('answered', from)

    // Demo mode: the peer's window is short, so ask once more after it passed.
    // Without this a re-posted offer in a live demo would silently find nobody.
    if (!get().settings.demoMode) return
    const used = mxRetries.get(from) ?? 0
    if (used >= MX_RETRIES) return
    mxRetries.set(from, used + 1)
    const offerId = offer.id
    later(RESPOND_WINDOW_DEMO_MS + 1500, () => {
      if (get().myOffer?.id !== offerId || mem.verified[from] !== undefined) return
      startRound(from, offerId, true)
    })
  }

  function onOffer(m: IncomingMessage, msg: Wire<'offer'>): void {
    const from = m.senderPubkey
    const c = activeContact(from, m.groupId)
    const mine = get().myOffer
    // An offer counts only from someone whose match with my current offer I verified myself.
    if (!c || !mine || mem.verified[from] !== mine.id) return
    const theirs = parsePublicOffer(msg.offer)
    if (!theirs || theirs.currency !== mine.currency || theirs.side === mine.side) return

    const matches = get().matches
    const prev = matches.find((x) => x.contactId === from)
    const next: Match = { contactId: from, offer: theirs, matchedAt: prev?.matchedAt ?? now() }
    set({ matches: prev ? matches.map((x) => (x === prev ? next : x)) : [...matches, next] })
    void save('matches')
    if (!prev) {
      debug('match', { peer: short(from) })
      addRoomMessage({
        id: randomId(),
        contactId: from,
        mine: false,
        kind: 'system',
        text: systemText.matched(get().settings.lang),
        at: now(),
      })
    }
  }

  function onWithdraw(m: IncomingMessage): void {
    const from = m.senderPubkey
    if (!activeContact(from, m.groupId)) return
    if (mem.verified[from] !== undefined) {
      delete mem.verified[from]
      void save('verified')
    }
    const matches = get().matches
    if (matches.some((x) => x.contactId === from)) {
      set({ matches: matches.filter((x) => x.contactId !== from) })
      void save('matches')
    }
  }

  async function postOffer(input: OfferInput): Promise<void> {
    if (!me || get().boot !== 'ready') throw new Error('not_ready')
    const { side, currency, amount, feePct } = input
    const sideOk = side === 'buy' || side === 'sell'
    const currencyOk = currency === 'KRW' || currency === 'USD'
    if (!sideOk || !currencyOk || !validAmount(amount) || !validFee(feePct)) throw new Error('invalid_offer')

    const prev = get().myOffer
    if (prev && prev.side === side && prev.currency === currency) {
      // Same direction and currency: an edit. Whoever matched just gets the new numbers.
      set({ myOffer: { ...prev, amount, feePct } })
      await save('offer')
      for (const pk of Object.keys(mem.verified)) {
        const c = contactOf(pk)
        if (!c) continue
        sendLater(pk, c.groupId, () => {
          const cur = get().myOffer
          return cur && mem.verified[pk] === cur.id ? { t: 'offer', offer: publicOf(cur) } : null
        })
      }
      return
    }

    retract()
    const offer: Offer = { id: randomId(), side, currency, amount, feePct, createdAt: now() }
    resetProgress()
    set({ myOffer: offer, matches: [], matchProgress: ZERO_PROGRESS })
    await Promise.all([save('offer'), save('matches'), save('progress'), save('verified'), save('init')])
    for (const c of get().contacts) startRound(c.id, offer.id, false)
  }

  async function withdrawOffer(): Promise<void> {
    if (!get().myOffer) return
    retract()
    resetProgress()
    set({ myOffer: null, matches: [], matchProgress: ZERO_PROGRESS })
    await Promise.all([save('offer'), save('matches'), save('progress'), save('verified'), save('init')])
  }

  // ============================================================== 5. rooms, contacts, settings

  function addRoomMessage(msg: ChatMessage): void {
    const rooms = get().rooms
    const list = [...(rooms[msg.contactId] ?? []), msg]
    set({ rooms: { ...rooms, [msg.contactId]: list.length > ROOM_CAP ? list.slice(-ROOM_CAP) : list } })
    void save('rooms')
  }

  /** Sender-claimed seconds, but never in my future. */
  function receivedAt(m: IncomingMessage): number {
    const t = now()
    return m.at > 0 ? Math.min(m.at * 1000, t) : t
  }

  function onChat(m: IncomingMessage, msg: Wire<'chat'>): void {
    const from = m.senderPubkey
    if (!activeContact(from, m.groupId) || typeof msg.text !== 'string' || msg.text.length === 0) return
    addRoomMessage({
      id: m.id,
      contactId: from,
      mine: false,
      kind: 'text',
      text: msg.text.slice(0, CHAT_MAX),
      at: receivedAt(m),
    })
  }

  function onDone(m: IncomingMessage, msg: Wire<'done'>): void {
    const from = m.senderPubkey
    const currency = asCurrency(msg.currency)
    if (!activeContact(from, m.groupId) || !validAmount(msg.amount) || !currency) return
    addRoomMessage({
      id: m.id,
      contactId: from,
      mine: false,
      kind: 'system',
      text: systemText.doneTheirs(get().settings.lang, msg.amount, currency),
      at: receivedAt(m),
    })
  }

  async function sendChat(contactId: PubkeyHex, text: string): Promise<void> {
    const c = contactOf(contactId)
    const body = text.trim().slice(0, CHAT_MAX)
    if (!c || body.length === 0) return
    const id = randomId()
    addRoomMessage({ id, contactId, mine: true, kind: 'text', text: body, at: now(), status: 'sending' })
    sendLater(contactId, c.groupId, () => ({ t: 'chat', text: body }), (ok) => setChatStatus(contactId, id, ok))
  }

  function setChatStatus(contactId: PubkeyHex, id: string, ok: boolean): void {
    const status: ChatMessage['status'] = ok ? 'sent' : 'failed'
    const rooms = get().rooms
    const list = rooms[contactId]
    const i = list ? list.findIndex((x) => x.id === id) : -1
    if (!list || i < 0 || list[i].status === status) return
    const next = list.slice()
    next[i] = { ...list[i], status }
    set({ rooms: { ...rooms, [contactId]: next } })
    void save('rooms')
  }

  async function retryChat(contactId: PubkeyHex, messageId: string): Promise<void> {
    const c = contactOf(contactId)
    const list = get().rooms[contactId]
    const i = list ? list.findIndex((x) => x.id === messageId) : -1
    if (!c || !list || i < 0) return
    const msg = list[i]
    if (!msg.mine || msg.kind !== 'text' || msg.status !== 'failed') return
    const next = list.slice()
    next[i] = { ...msg, status: 'sending' }
    set({ rooms: { ...get().rooms, [contactId]: next } })
    void save('rooms')
    const text = msg.text
    sendLater(contactId, c.groupId, () => ({ t: 'chat', text }), (ok) => setChatStatus(contactId, messageId, ok))
  }

  async function markDone(contactId: PubkeyHex, amount: number): Promise<void> {
    const c = contactOf(contactId)
    const offer = get().myOffer
    if (!c) throw new Error('no_contact')
    if (!offer) throw new Error('no_offer')
    if (!validAmount(amount)) throw new Error('invalid_amount')
    const currency = offer.currency
    sendLater(contactId, c.groupId, () => ({ t: 'done', amount, currency }))
    addRoomMessage({
      id: randomId(),
      contactId,
      mine: true,
      kind: 'system',
      text: systemText.doneMine(get().settings.lang, amount, currency),
      at: now(),
    })
    const remaining = offer.amount - amount
    if (remaining <= 0) await withdrawOffer()
    else await postOffer({ side: offer.side, currency, amount: remaining, feePct: offer.feePct })
  }

  async function renameContact(id: PubkeyHex, name: string): Promise<void> {
    if (!contactOf(id)) return
    const clean = name.trim().slice(0, NAME_MAX)
    set({ contacts: get().contacts.map((c) => (c.id === id ? { ...c, name: clean } : c)) })
    await save('contacts')
  }

  async function deleteContact(id: PubkeyHex): Promise<void> {
    const c = contactOf(id)
    if (!c) return
    // Looks to the peer exactly like me taking my offer down.
    if (mem.verified[id] !== undefined) sendLater(id, c.groupId, () => ({ t: 'withdraw' }))
    mem.tombstones[id] = { groupId: c.groupId, at: now() }
    dropProgress(id)
    delete mem.verified[id]
    for (const [sid, s] of Object.entries(mem.init)) if (s.contactId === id) delete mem.init[sid]
    for (const [key, s] of Object.entries(mem.resp)) if (s.contactId === id) delete mem.resp[key]
    delete mem.deferred[id]
    cancel(deferTimers.get(id))
    deferTimers.delete(id)
    delete mem.confirms[id]
    mxRetries.delete(id)
    const rooms = { ...get().rooms }
    delete rooms[id]
    set({
      contacts: get().contacts.filter((x) => x.id !== id),
      matches: get().matches.filter((x) => x.contactId !== id),
      rooms,
    })
    await Promise.all([
      save('tombstones'),
      save('contacts'),
      save('matches'),
      save('rooms'),
      save('verified'),
      save('init'),
      save('resp'),
      save('deferred'),
      save('confirms'),
    ])
  }

  async function setSettings(patch: Partial<Settings>): Promise<void> {
    const cur = get().settings
    set({
      settings: {
        lang: patch.lang === 'ko' || patch.lang === 'en' ? patch.lang : cur.lang,
        sort: patch.sort === 'amount' || patch.sort === 'fee' ? patch.sort : cur.sort,
        demoMode: typeof patch.demoMode === 'boolean' ? patch.demoMode : cur.demoMode,
      },
    })
    await save('settings')
  }

  function exportKey(): string {
    if (!sk) throw new Error('not_ready')
    if (!reauthOk()) throw new Error('reauth-required')
    return marmot.nsecOf(sk)
  }

  // ============================================================== 5b. identity and lock

  const HEX64 = /^[0-9a-f]{64}$/

  /** KV write outside the snapshot table, ordered with the other writes. Rejects on failure. */
  function writeNow(key: string, value: unknown): Promise<void> {
    const p = writeChain.then(async () => {
      if (frozen) return
      await kv.set(key, value)
    })
    writeChain = p.catch(() => {})
    return p
  }

  function delNow(key: string): Promise<void> {
    const p = writeChain.then(async () => {
      if (frozen) return
      await kv.del(key)
    })
    writeChain = p.catch(() => {})
    return p
  }

  function announce(): void {
    try {
      channel?.postMessage('identity')
    } catch {
      // closed
    }
  }

  /** Only ever lowers the backup's key-security claim: 0 (insecure) wins, then 2 (unknown). */
  async function degradeKsb(n: 0 | 1 | 2): Promise<void> {
    const next: 0 | 1 | 2 = n === 0 || ksb === 0 ? 0 : n === 2 || ksb === 2 ? 2 : 1
    if (next === ksb) return
    ksb = next
    await writeNow('ksb', next)
  }

  function reauthOk(): boolean {
    return vaultRec?.method === 'none' || now() < reauthUntil
  }

  /** Serialises identity writes across tabs of this profile (Web Locks where present). */
  function identityLock<T>(fn: () => Promise<T>): Promise<T> {
    const locks = (globalThis as { navigator?: { locks?: LockManager } }).navigator?.locks
    if (!locks?.request) return fn()
    return locks.request(`ilchon-identity:${deps.namespace}`, fn) as Promise<T>
  }

  /** Stores a brand-new identity unless another tab stored one first. */
  async function storeFirstVault(v: LockedVault): Promise<void> {
    await identityLock(async () => {
      if ((await kv.get<LockedVault>('vault')) != null) throw new Error('identity-exists')
      await storeVault(v)
    })
  }

  function setLock(patch: Partial<IlchonState['lock']>): void {
    set({ lock: { ...get().lock, ...patch } })
  }

  function checkChoice(choice: LockChoice): void {
    if (!choice || (choice.method !== 'passkey' && choice.method !== 'password' && choice.method !== 'none')) {
      throw new Error('invalid-choice')
    }
    if (choice.method === 'password' && (typeof choice.password !== 'string' || choice.password.length < MIN_PASSWORD)) {
      throw new Error('weak-password')
    }
  }

  async function lockWith(secret: string, choice: LockChoice): Promise<LockedVault> {
    if (choice.method === 'none') return { v: 1, method: 'none', sk: secret }
    if (!deps.vault) throw new Error('no-vault')
    const label = `ilchon ${marmot.npubOf(marmot.pubkeyOf(secret)).slice(0, 16)}`
    return deps.vault.lockSecret(secret, choice, label)
  }

  async function storeVault(v: LockedVault): Promise<void> {
    await writeNow('vault', v)
    vaultRec = v
    if (v.method === 'none') await degradeKsb(0)
    if (get().lock.migrated) await delNow('migrated').catch(() => {})
    setLock({ method: v.method, migrated: false })
    announce()
    // A plaintext key from before the vault must never outlive it.
    await purgeLegacyKey()
  }

  /** Deletes the pre-vault plaintext key and checks it is gone. Rejects with 'cleanup-failed'. */
  async function purgeLegacyKey(): Promise<void> {
    try {
      await delNow('sk')
      if ((await kv.get<string>('sk')) === undefined) return
    } catch {
      // reported below
    }
    debug('sk-cleanup-failed')
    throw new Error('cleanup-failed')
  }

  /** Runs `fn` unless another identity action is in flight. */
  async function exclusive<T>(phase: IlchonState['boot'], fn: () => Promise<T>): Promise<T> {
    if (get().boot !== phase) throw new Error('not-allowed')
    if (identityBusy) throw new Error('busy')
    identityBusy = true
    try {
      return await fn()
    } finally {
      identityBusy = false
    }
  }

  /** A key made for createIdentity whose lock failed; reused so a passkey retry keeps its label. */
  let pendingNew = ''

  function createIdentity(choice: LockChoice): Promise<void> {
    return exclusive('setup', async () => {
      checkChoice(choice)
      // Nothing may await before lockWith: a passkey create() needs the tap's user activation.
      const secret = (pendingNew ||= marmot.generateSecretKeyHex())
      const locked = await lockWith(secret, choice)
      await storeFirstVault(locked)
      pendingNew = ''
      reauthUntil = now() + REAUTH_MS
      await openIdentity(secret)
    })
  }

  function backupText(ncryptsec: unknown): string {
    const text = typeof ncryptsec === 'string' ? ncryptsec.trim() : ''
    if (!text) throw new Error('invalid-ncryptsec')
    return text
  }

  function checkBackup(ncryptsec: string, password: string): Promise<void> {
    return exclusive('setup', async () => {
      if (!deps.vault) throw new Error('no-vault')
      const text = backupText(ncryptsec)
      pendingRestore = null
      const secret = await deps.vault.fromNcryptsec(text, password ?? '')
      if (!HEX64.test(secret)) throw new Error('invalid-ncryptsec')
      pendingRestore = { text, password: password ?? '', secret }
    })
  }

  function restoreIdentity(ncryptsec: string, password: string, choice: LockChoice): Promise<void> {
    return exclusive('setup', async () => {
      checkChoice(choice)
      if (!deps.vault) throw new Error('no-vault')
      const text = backupText(ncryptsec)
      const p = pendingRestore
      let secret: string
      if (p && p.text === text && p.password === (password ?? '')) {
        // Decrypted on the previous step: the passkey ceremony starts from this tap.
        secret = p.secret
      } else {
        secret = await deps.vault.fromNcryptsec(text, password ?? '')
        if (!HEX64.test(secret)) throw new Error('invalid-ncryptsec')
      }
      const locked = await lockWith(secret, choice)
      await storeFirstVault(locked)
      pendingRestore = null
      const backupKsb = deps.vault.ncryptsecKeySecurity?.(text)
      if (backupKsb === 0 || backupKsb === 2) await degradeKsb(backupKsb)
      // The user holds a backup of this key already.
      await writeNow('backedUp', true)
      setLock({ backedUp: true })
      reauthUntil = now() + REAUTH_MS
      await openIdentity(secret)
    })
  }

  function unlock(password?: string): Promise<void> {
    return exclusive('locked', async () => {
      const v = vaultRec
      if (!v) throw new Error('corrupt')
      let secret: string
      if (v.method === 'none') secret = v.sk
      else {
        if (!deps.vault) throw new Error('no-vault')
        if (v.method === 'password' && !password) throw new Error('wrong-password')
        secret = await deps.vault.unlockSecret(v, password)
      }
      if (!HEX64.test(secret)) throw new Error('corrupt')
      reauthUntil = now() + REAUTH_MS
      await openIdentity(secret)
    })
  }

  /** Proves the current lock again. The passkey get() runs straight from the tap. */
  function reauth(password?: string): Promise<void> {
    return exclusive('ready', async () => {
      const v = vaultRec
      if (!v || !sk) throw new Error('not-allowed')
      if (v.method !== 'none') {
        if (!deps.vault) throw new Error('no-vault')
        if (v.method === 'password' && !password) throw new Error('wrong-password')
        const got = await deps.vault.unlockSecret(v, password)
        if (got !== sk) throw new Error(v.method === 'password' ? 'wrong-password' : 'corrupt')
      }
      reauthUntil = now() + REAUTH_MS
    })
  }

  function reauthed(): boolean {
    return get().boot === 'ready' && !!sk && reauthOk()
  }

  function changeLock(choice: LockChoice): Promise<void> {
    return exclusive('ready', async () => {
      checkChoice(choice)
      if (!sk) throw new Error('not-allowed')
      if (!reauthOk()) throw new Error('reauth-required')
      await storeVault(await lockWith(sk, choice))
      reauthUntil = now() + REAUTH_MS
    })
  }

  async function exportBackup(password: string): Promise<string> {
    if (get().boot !== 'ready' || !sk) throw new Error('not-allowed')
    if (!reauthOk()) throw new Error('reauth-required')
    if (typeof password !== 'string' || password.length < MIN_PASSWORD) throw new Error('weak-password')
    if (!deps.vault) throw new Error('no-vault')
    // backedUp is set only once the user copies or confirms it (markBackedUp).
    return deps.vault.toNcryptsec(sk, password, 16, ksb)
  }

  async function markBackedUp(): Promise<void> {
    if (get().boot !== 'ready' || !sk) throw new Error('not-allowed')
    await writeNow('backedUp', true)
    setLock({ backedUp: true })
  }

  // ============================================================== 6. incoming, boot, stop, reset

  function onMessage(m: IncomingMessage): void {
    if (stopped || m.senderPubkey === me) return
    if (seenSet.has(m.id)) return
    remember(m.id)
    if (mem.abandoned.includes(m.groupId)) return
    void enqueue(m.senderPubkey, () => handle(m))
  }

  async function handle(m: IncomingMessage): Promise<void> {
    const msg = m.msg
    debug('rx', { t: String(msg.t), from: short(m.senderPubkey) })
    if (msg.t !== 'hello') {
      promoteOnTraffic(m)
      // Only a contact sends anything but hello, so the invitee has my confirmation.
      if (mem.confirms[m.senderPubkey]?.groupId === m.groupId) {
        delete mem.confirms[m.senderPubkey]
        void save('confirms')
      }
    }
    switch (msg.t) {
      case 'hello':
        return onHello(m, msg)
      case 'm1':
        return onM1(m, msg)
      case 'm2':
        return onM2(m, msg)
      case 'm3':
        return onM3(m, msg)
      case 'mx':
        return onMx(m, msg)
      case 'offer':
        return onOffer(m, msg)
      case 'withdraw':
        return onWithdraw(m)
      case 'chat':
        return onChat(m, msg)
      case 'done':
        return onDone(m, msg)
      default:
        return
    }
  }

  async function refreshRates(): Promise<void> {
    let fresh: Rates
    try {
      fresh = await deps.rates.fetch()
    } catch {
      return
    }
    if (stopped) return
    // Replace, never merge: the source drops a currency whose last good price
    // is too old, and screens must stop converting with it.
    const next: Rates = {}
    if (typeof fresh.KRW === 'number' && fresh.KRW > 0) next.KRW = fresh.KRW
    if (typeof fresh.USD === 'number' && fresh.USD > 0) next.USD = fresh.USD
    if (next.KRW !== undefined || next.USD !== undefined) {
      next.at = typeof fresh.at === 'number' ? fresh.at : now()
    }
    set({ rates: next })
  }

  const unsubs: Unsub[] = []
  let stopRates: (() => void) | undefined
  let starting: Promise<void> | null = null

  let passkeyChecked = false

  /**
   * Loads stored data and the locked key. Stops in 'setup' (no identity yet)
   * or 'locked' (waiting for unlock); otherwise continues into openIdentity.
   */
  async function boot(): Promise<void> {
    stopped = false
    set({ boot: 'starting', bootError: undefined })
    if (!passkeyChecked) {
      passkeyChecked = true
      const v = deps.vault
      if (!v) setLock({ passkeySupported: false })
      else
        void v
          .passkeySupported()
          .catch(() => false)
          .then((ok) => setLock({ passkeySupported: ok }))
    }
    let secret = ''
    try {
      await load()
      setLock({
        backedUp: (await kv.get<boolean>('backedUp')) === true,
        migrated: (await kv.get<boolean>('migrated')) === true,
      })
      const storedKsb = await kv.get<number>('ksb')
      ksb = storedKsb === 0 || storedKsb === 2 ? storedKsb : 1

      let stored = (await kv.get<LockedVault>('vault')) ?? null
      if (stored) {
        // A legacy plaintext key left behind by an interrupted migration or a
        // failed cleanup. Retried on every boot; boot stops in 'error' until it is gone.
        await purgeLegacyKey()
      } else {
        // Before the vault existed the key sat in KV as plain hex.
        const legacy = await kv.get<string>('sk')
        if (legacy) {
          stored = { v: 1, method: 'none', sk: legacy }
          // The user never chose 'none': the app asks once for a lock and a backup.
          await writeNow('migrated', true)
          await writeNow('ksb', 0)
          ksb = 0
          setLock({ migrated: true })
          await writeNow('vault', stored)
          await purgeLegacyKey()
        } else if (deps.autoIdentity) {
          stored = { v: 1, method: 'none', sk: marmot.generateSecretKeyHex() }
          await writeNow('vault', stored)
        }
      }
      vaultRec = stored
      setLock({ method: stored?.method ?? null })
      if (!stored) {
        set({ boot: 'setup' })
        return
      }
      if (stored.method !== 'none') {
        set({ boot: 'locked' })
        return
      }
      if (!HEX64.test(stored.sk)) throw new Error('corrupt')
      secret = stored.sk
    } catch (e) {
      return fail(e)
    }
    await openIdentity(secret)
  }

  async function fail(e: unknown): Promise<never> {
    await shutdown()
    set({ boot: 'error', bootError: e instanceof Error ? e.message : String(e) })
    starting = null
    throw e
  }

  /** The rest of boot once the secret key is in memory: transport, listeners, start. */
  async function openIdentity(secret: string): Promise<void> {
    stopped = false
    set({ boot: 'starting', bootError: undefined })
    try {
      sk = secret
      me = marmot.pubkeyOf(sk)
      set({ me: { pubkey: me, npub: marmot.npubOf(me) } })

      const t = marmot.createTransport({
        secretKeyHex: sk,
        relays: deps.relays,
        namespace: transportNamespace(deps.namespace, me),
        persistence: deps.persistence,
      })
      transport = t
      // Listeners go on before start so relay backfill is not missed.
      unsubs.push(
        t.onRelayStatus((relays) => set({ relays })),
        t.onInvite(onInvite),
        t.onMessage(onMessage),
      )
      for (const scan of Object.values(mem.scans)) armLinkTimeout(scan.pk, scan.at)

      void refreshRates()
      const ticker = setInterval(() => void refreshRates(), RATES_EVERY_MS)
      stopRates = () => clearInterval(ticker)

      await t.start()
      set({ boot: 'ready', relays: t.relayStatus() })
      debug('ready', { me: short(me) })
      // Public anyway; lets a reset before unlock find this identity's transport stores.
      if ((await kv.get<string>('pubkey').catch(() => undefined)) !== me) await writeNow('pubkey', me).catch(() => {})
      resumeAfterBoot()
    } catch (e) {
      return fail(e)
    }
  }

  /** Work that was waiting in memory when the app last stopped. */
  function resumeAfterBoot(): void {
    const t = now()
    let changed = false
    for (const [pk, c] of Object.entries(mem.confirms)) {
      if (t - c.at > LINK_TIMEOUT_MS || !activeContact(pk, c.groupId)) {
        delete mem.confirms[pk]
        changed = true
        continue
      }
      // The invitee may still be waiting for it; a repeat is harmless.
      sendLater(pk, c.groupId, () => ({ t: 'hello', v: 1, code: c.code }))
    }
    if (changed) void save('confirms')
    const offer = get().myOffer
    for (const [pk, d] of Object.entries(mem.deferred)) {
      if (offer && offer.id === d.offerId && contactOf(pk)) armDeferred(pk, d, budgetFreeAt(pk) || t)
    }
  }

  async function shutdown(): Promise<void> {
    stopped = true
    for (const stopTimer of timers.values()) stopTimer()
    timers.clear()
    linkTimers.clear()
    deferTimers.clear()
    buffered.clear()
    const pendingOut = [...outbox.values()].flatMap((b) => b.items)
    outbox.clear()
    for (const it of pendingOut) it.settle?.(false)
    stopRates?.()
    stopRates = undefined
    for (const u of unsubs.splice(0)) u()
    const t = transport
    transport = null
    if (t) {
      try {
        await t.stop()
      } catch {
        // already gone
      }
    }
  }

  let resetPubkey: PubkeyHex | undefined

  async function resetAll(): Promise<void> {
    frozen = true
    await shutdown()
    await writeChain.catch(() => {})
    sk = ''
    vaultRec = null
    pendingRestore = null
    pendingNew = ''
    reauthUntil = 0
    // While locked `me` is unknown; the stored pubkey still names the transport stores.
    const stored = me || resetPubkey || (await kv.get<string>('pubkey').catch(() => undefined))
    const pubkey = typeof stored === 'string' && HEX64.test(stored) ? stored : undefined
    // A retry after a failed reset no longer finds it in KV.
    resetPubkey = pubkey
    let ok = true
    try {
      await identityLock(async () => {
        for (const key of await kv.keys()) await kv.del(key)
        if ((await kv.keys()).length > 0) throw new Error('left-over keys')
      })
    } catch {
      ok = false
    }
    announce()
    if (!ok) {
      debug('reset-failed')
      throw new Error('reset-failed')
    }
    try {
      await hooks.onReset?.({ pubkey })
    } catch {
      debug('reset-failed')
      throw new Error('reset-failed')
    }
  }

  const actions: IlchonActions = {
    postOffer,
    withdrawOffer,
    startConnect,
    rotateConnectCode,
    submitScan,
    cancelConnect,
    renameContact,
    deleteContact,
    sendChat,
    retryChat,
    markDone,
    setSettings,
    exportKey,
    resetAll,
    createIdentity,
    checkBackup,
    restoreIdentity,
    unlock,
    reauth,
    reauthed,
    changeLock,
    exportBackup,
    markBackedUp,
  }

  return {
    store,
    actions,
    start: () => (starting ??= boot()),
    async stop() {
      channel?.close()
      await shutdown()
      await writeChain.catch(() => {})
      starting = null
    },
  }
}
