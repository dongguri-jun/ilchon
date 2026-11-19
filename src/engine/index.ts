/**
 * ilchon engine: all application logic. No DOM and no React, so the same code
 * runs in the browser and in the Node end-to-end script.
 *
 * Layout of this file
 *   1. persistence   in-memory truth + serialized writes to KV
 *   2. sending       per-group retries, pending state signals (told), resend
 *   3. connect       QR handshake (see contracts.ts)
 *   4. matching      private three-round match per contact
 *   5. rooms / contacts / settings
 *   6. boot, stop, reset
 */
import { createStore, type StoreApi } from 'zustand/vanilla'
import { sha256 } from '@noble/hashes/sha2.js'
import { bytesToHex, utf8ToBytes } from '@noble/hashes/utils.js'
import {
  CHAT_MAX,
  CODE_DISPLAY_MS,
  CURRENCIES,
  CODE_REDEEM_MS,
  DEFAULT_RELOCK_MINUTES,
  LANGS,
  MATCH_WINDOW_MS,
  RELOCK_MINUTES,
  TRADE_STEPS,
  type ChannelFields,
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
  type InviteOptions,
  type KV,
  type Lang,
  type ListFetch,
  type LockChoice,
  type LockStatus,
  type Match,
  type MatchPair,
  type Memo,
  type Offer,
  type OfferInput,
  type PayMethod,
  type PublicOffer,
  type PubkeyHex,
  type Rates,
  type ReopenWait,
  type RelockMinutes,
  type Settings,
  type Side,
  type Tables,
  type TradeStep,
  type Transport,
  type Unsub,
  type WireMessage,
} from '../contracts'
import { EXPIRING_SOON_SECONDS, secondsLeft } from '../lib/bolt11'
import { isPair, isSid } from '../lib/marmot/wire'
import { canonicalMethods, commonMethods } from '../lib/match'
import { isCurrency, isMinor, requestSats } from '../lib/money'
import { bip21, parseAddress } from '../lib/onchain'
import { hasPayRef, payRefOf, splitText } from '../lib/pay'
import { cleanRelayList } from '../lib/relays'
import { newMnemonic, normalizeWords, secretFromMnemonic } from '../lib/seed'
import {
  EMPTY_DIGEST,
  applyPlanTo,
  decodeList,
  digest,
  emptyPlan,
  encodeList,
  mergeInto,
  projection,
  type ListBody,
  type ListView,
  type MergePlan,
} from './contact-list'
import { tradeBounds, tradeView } from './trade'
import { NAME_MAX, createSerial, randomId, short } from './util'

/**
 * Format of the stored data, kept beside the lock record (src/lib/store: written by
 * create, checked by status before anything is read). Only a change that alters the shape
 * or meaning of a key already stored raises it by one. A new key or optional field
 * that reads with a default does not. No code reads old values: boot
 * wipes data of another format and starts over (wipe('format')). Once real users
 * keep data, the format is fixed; after that a change migrates old values and the silent wipe
 * stays in development builds only.
 * 3: amounts are integers in minor units (`amountMinor`).
 * 4: `contacts` and `tombstones` carry the channel fields.
 * 5: offers and matches carry `methods`; match sessions hold one value per slot
 *    (`init.p`, `resp.pq` pairs, an 86-character `secret`).
 */
export const STORE_FORMAT = 5

// ---------------------------------------------------------------- tuning

/** A Welcome is accepted only from someone I scanned this recently. */
const SCAN_TRUST_MS = 5 * 60_000
/** A Welcome from someone I have not scanned yet waits this long for my scan. */
const INVITE_BUFFER_MS = 5 * 60_000
/** A link that is not complete this long after my scan is abandoned. */
const LINK_TIMEOUT_MS = 120_000
/**
 * Invitee after replying, and inviter's confirmation: kept this long. The
 * inviter already made the contact when it got my reply, so giving up after
 * LINK_TIMEOUT_MS would leave a contact on one side only whenever my app was
 * closed or asleep when the confirmation came.
 */
const REPLIED_LINK_TTL_MS = 7 * 24 * 3_600_000
/**
 * Re-sends of a waiting link's hello (reply or confirmation) at boot or on a
 * rescan. Each shows the peer and the relays that my app is online, so they
 * stop after this many even while the link may still complete.
 */
const LINK_RESEND_MAX = 10
/** A hello is echoed at most ECHO_MAX times per this window and code. */
const ECHO_WINDOW_MS = 60_000
/** Gaps between repeats of the inviter's hello while the link is incomplete. */
const HELLO_RESEND_MS = [6_000, 10_000, 15_000, 30_000]
/** Second retry of a round the contact left unanswered; each later one doubles. */
const SILENT_RETRY_BASE_MS = 15_000
const SILENT_RETRY_MAX_MS = 15 * 60_000
/** Returning to the app re-arms a contact's waiting round at most this often. */
const RETURN_REARM_FLOOR_MS = 60_000
/** Backoff for a message a relay did not take. After the last one it is dropped. */
const SEND_RETRY_MS = [2_000, 5_000, 10_000, 20_000, 40_000]
/**
 * The resend of pending state signals (told): first after this long, then
 * twice as long each time up to RESEND_MAX_MS. A success, a start and a return reset it.
 * The cap is the support log's interval (10 min), so a failure line never stands for
 * one resend.
 */
const RESEND_BASE_MS = 60_000
const RESEND_MAX_MS = 10 * 60_000
/** A verified match waits this long for the contact's offer, then one reconfirm round. */
const MATCH_ECHO_WAIT_MS = 30_000
/** Reconfirm rounds with one contact at boot or return: at most one per this long. */
const RECONFIRM_FLOOR_MS = 10 * 60_000
const RATES_EVERY_MS = 60_000
/** After my relays come back (none connected, then one), wait this long, then onReconnected once. */
const RECONNECT_SETTLE_MS = 2_500
const ROOM_CAP = 200
/** Records of the current trade (cards, completion and system lines) kept beside ROOM_CAP. */
const TRADE_KEEP = 50
/**
 * The contact's newest plain texts that the room's limit never drops before my own lines:
 * a room full of my texts keeps what just came in.
 */
const ROOM_PEER_FLOOR = 50
const SEEN_CAP = 500
const RESP_SESSION_TTL_MS = 10 * 60_000
/** Answer sessions kept per sender pubkey and in all; the oldest go first. */
const RESP_PER_PEER = 3
const RESP_MAX = 60
/** Writes of the answer sessions are merged over this long. */
const RESP_SAVE_MS = 1_000
/** One write that has not finished in this long counts as failed. */
const WRITE_WAIT_MS = 10_000
/**
 * Tasks waiting per contact (or sender) at most. A received message that does not fit
 * stays in the transport's inbox for the next start.
 */
const QUEUE_MAX = 1_000
/** How long a reauth (or a fresh unlock/create) lets changeLock and revealMnemonic run. */
export const REAUTH_MS = 5 * 60_000
/** A change of the contact list is uploaded this long after it, gathering changes that come together. */
const LIST_CHANGE_MS = 2_000
/** Retries of a contact list sync that did not finish; then it waits for the next open, change or return. */
const LIST_RETRY_MS = [5_000, 15_000, 60_000, 5 * 60_000]
/** A copy dated later than now + this is not taken, and no upload is dated later. */
const LIST_AHEAD_S = 24 * 3_600
/** Relays that must hold the current list before it counts as uploaded. */
const LIST_HOLDERS_MIN = 2

// Channels. Contacts and tombstones go by the same values.
const HOUR_MS = 3_600_000
/** Room changes with one peer in CHANNEL_WINDOW_MS at most. */
const CHANNEL_MOVES_MAX = 2
const CHANNEL_WINDOW_MS = 24 * HOUR_MS
/** The lower key makes a new room for one peer at most this often (from binding the current one). */
const CHANNEL_MIN_GAP_MS = 60_000
/** After the n-th attempt in a row, the next one waits [n-1]; the last value repeats. */
const CHANNEL_RETRY_MS = [60_000, 10 * 60_000, HOUR_MS, 6 * HOUR_MS, 6 * HOUR_MS, 6 * HOUR_MS, 24 * HOUR_MS]
/** A room I made that the peer has not joined: made again after this long, then every PENDING_NEXT_MS. */
const PENDING_FIRST_MS = 24 * HOUR_MS
const PENDING_NEXT_MS = 7 * 24 * HOUR_MS
const CHANNEL_CHECK_MS = 10 * 60_000
/**
 * Attempts in a row (my requests as H, my rooms as L) after which the room's reconnect
 * status also says that meeting and scanning each other reconnects at once.
 * The third comes 11 minutes after the first.
 */
const REOPEN_SCAN_TRIES = 3
/** First ensureChannels after boot: the waiting Welcomes come in first. */
const CHANNEL_BOOT_DELAY_MS = 15_000
/** One ensureChannels starts the work of one peer after another, this far apart (pubkey order). */
const CHANNEL_PACE_MS = 500
/** groupHealth changes are gathered this long into one ensureChannels. */
const HEALTH_BATCH_MS = 5_000
/** Welcomes of one lower key are gathered this long; only the newest is joined. */
const MOVE_BATCH_MS = 1_000
/** A Welcome made more than this many seconds ahead of my clock is ignored. */
const FUTURE_SENT_S = 600
/** A stranger's Welcome is kept only while I showed a code this recently. */
const CODE_RECENT_MS = 10 * 60_000
/**
 * A contact's records that come in no more than this apart are one catch-up batch, ordered
 * among themselves by the contact's claimed time (placeOf). Above the transport's
 * INGEST_HOLD_MAX_MS (5 s): a long catch-up comes in sorted parts that far apart at most.
 */
const CATCHUP_JOIN_MS = 6_000
/** Senders whose Welcome waits for my scan, at most; the oldest goes first. */
const INVITE_BUFFER_MAX = 20
/** Welcome ids already looked at, remembered in memory (a ring). */
const HANDLED_INVITES_MAX = 5_000
/** Rumor ids of Welcomes I joined for a move, stored (a ring); a repeat is marked read. */
const JOINED_INVITES_MAX = 200
/**
 * Scanning a contact (interim values; EngineDeps.tuning.holderPairMs in
 * e2e): a proof of the peer within this long before or after my scan shows our room is the
 * same, and my scan + this long is the deadline after which L makes a new room.
 */
export const HOLDER_PAIR_MS = 5 * 60_000
/** A holder scan lives this long for a pairing window of `pairMs` (2 × it + 60 s). */
export function holderScanTtl(pairMs: number): number {
  return 2 * pairMs + 60_000
}
/** The life of a holder scan, 11 minutes. */
export const HOLDER_SCAN_TTL_MS = holderScanTtl(HOLDER_PAIR_MS)
/** A code of mine counts in a holder proof up to this age (B), and is kept as long: 13 minutes. */
export const HOLDER_CODE_MS = HOLDER_SCAN_TTL_MS + CODE_REDEEM_MS
/** A holder may judge a deadline it missed (the app was away) at most this long after it. */
const HOLDER_LATE_MS = 60_000
/** Back from a stop, the backlog is given this long before holder scans and codes end. */
const HOLDER_RESUME_GRACE_MS = 15_000
/**
 * A return window (resumeUntil) closes at most this long after the first signal of the
 * return (backAt), however many signals follow. Each signal gives the
 * backlog its full HOLDER_RESUME_GRACE_MS, so a single reconnect late in a return is not
 * cut short, but a flapping relay cannot keep the window open: holder deadlines are
 * judged, holder scans end, codes are pruned and a peer's own time stops standing in for
 * now when it closes.
 */
export const RESUME_WINDOW_MAX_MS = 60_000
/**
 * A holder timer that fires this much after its time ran in a frozen or throttled tab: the
 * app is back from the background, and that return counts as a start.
 */
const LATE_TIMER_MS = 5_000
/** A channel proved by both scans in a room bound by a move, a tag or the scan is pinned this long. */
const PIN_MS = 7 * 24 * HOUR_MS
/** A lacking higher key asks the lower key for a link room when none came this long after the scan. */
const REQUEST_AFTER_MS = [10_000, 40_000]

// ---------------------------------------------------------------- public extras

export interface EngineHooks {
  /** Language used until the user picks one. */
  defaultLang?: Lang
  /**
   * Runs at the end of a wipe, after the profile's whole store is deleted. The
   * browser reloads here. `reason`: 'user' is the reset the user asked for
   * (resetAll); 'format': the stored data was written by another format, and the
   * browser keeps the support log.
   */
  onReset?: (info: { reason: 'user' | 'format' }) => void | Promise<void>
  /**
   * Another tab of this profile wrote or wiped the identity. The browser reloads
   * here. Without it no cross-tab channel is opened (Node scripts).
   */
  onExternalChange?: () => void
  /** Diagnostics. Never receives keys, labels or offer contents. */
  debug?: (event: string, info?: Record<string, string | number | boolean>) => void
}

export type IlchonEngine = Engine & {
  store: StoreApi<IlchonState>
  /** The app is back in view or reconnected: re-send pending signals, reconfirm matched contacts, re-arm waiting rounds. */
  rearmRounds(): void
  /**
   * Tests only: sizes of in-memory state, never its contents (buffered; candidates;
   * notices: "channel reopened" lines due).
   */
  sizes(): { resp: number; respPerSender: number; buffered: number; candidates: number; notices: number }
}

/** The engine's KV before unlock: every call rejects Error('locked'). */
const lockedCall = () => Promise.reject(new Error('locked'))
const LOCKED_KV: KV = { get: lockedCall, set: lockedCall, del: lockedCall, keys: lockedCall }

/** The engine KV key of one contact's chat: one item per contact. */
const roomKey = (pk: PubkeyHex) => `room:${pk}`

/**
 * What the identity item holds: the secret key, and the normalized 12 words it came
 * from when this app made it. A restored identity keeps no words.
 */
type Identity = { sk: string; words?: string; createdAt?: number }

/**
 * The stored identity item, checked. Anything else is Error('storage-damaged'). The
 * words are checked for shape only (normalized, 12 of them): `sk` is stored beside them
 * so unlocking never runs the BIP-39 key derivation again.
 */
function readIdentity(v: unknown): Identity {
  const r = v as { v?: unknown; sk?: unknown; words?: unknown } | null
  if (typeof r !== 'object' || r === null || r.v !== 1 || typeof r.sk !== 'string' || !/^[0-9a-f]{64}$/.test(r.sk)) {
    throw new Error('storage-damaged')
  }
  // When this device made or restored the key (unix seconds): optional, for the key-takeover check.
  const at = (r as { createdAt?: unknown }).createdAt
  const createdAt = typeof at === 'number' && Number.isFinite(at) && at >= 0 ? at : undefined
  const base = createdAt === undefined ? { sk: r.sk } : { sk: r.sk, createdAt }
  if (r.words === undefined) return base
  if (typeof r.words !== 'string' || normalizeWords(r.words) !== r.words || r.words.split(' ').length !== 12) {
    throw new Error('storage-damaged')
  }
  return { ...base, words: r.words }
}

/**
 * What of my contact list the relays answered: one readable copy per relay (or none).
 * A recovery-only shape: the list found before this device had any identity.
 */
type ParsedCopy = { relay: string; body: ListBody; createdAt: number }

/**
 * Per relay of my list relays, whether its copy was merged once since the last restore.
 * `pending`: relays that did not answer at the restore (or at a rebuild of the list);
 * empty or absent means every relay was merged.
 */
type ListSync = { merged: Record<string, true>; pending: string[] }

function readListSync(v: unknown): ListSync {
  const r = v as { merged?: unknown; pending?: unknown } | null
  if (typeof r !== 'object' || r === null || !Array.isArray(r.pending)) return { merged: {}, pending: [] }
  const merged: Record<string, true> = {}
  if (typeof r.merged === 'object' && r.merged !== null) for (const k of Object.keys(r.merged)) merged[k] = true
  return { merged, pending: r.pending.filter((x): x is string => typeof x === 'string') }
}

const errCode = (e: unknown) => (e instanceof Error ? e.message : String(e))

// ---------------------------------------------------------------- private records

interface CodeRec {
  code: string
  createdAt: number
  used: boolean
  usedBy?: PubkeyHex
  /** Holder proofs with this code, per sender: the room and moment of the latest one. */
  holderUses?: Record<PubkeyHex, { in: string; at: number }>
}

/** One scan of a peer's QR. Doubles as the record of the link in progress. */
interface ScanRec {
  pk: PubkeyHex
  /** The peer's one-time code. */
  code: string
  at: number
  /** True when my pubkey sorts lower, so I create the group. */
  inviter: boolean
  /** The room of this link. */
  groupId?: string
  /** The link room's roomSentAt, kept for completeLink. */
  sentAt?: number
  /**
   * Invitee only: I verified the inviter's hello and sent my reply. I become a
   * contact only once the inviter shows it accepted that reply.
   */
  replied?: boolean
  /** Invitee, replied: how often the reply was re-sent at boot. */
  resends?: number
  /** Lacking side: the direct-scan exception (it skips the move time compare and the move limit) was used for this scan. */
  bypassUsed?: boolean
  /** The KeyPackage reference in the peer's QR: a room made from this scan invites only it. */
  kp?: string
  /**
   * I already had this peer as a contact when I scanned (5.3): the screen
   * says 'already' and no link starts. My proof goes into our room, the peer's proof is
   * paired within HOLDER_PAIR_MS of my scan, and at the deadline L makes a new room.
   */
  holder?: boolean
  /** Holder: the room my proof hello went to last. */
  provedIn?: string
  /** Holder: the peer echoed my proof in `provedIn`; the proof stops repeating. */
  acked?: true
  /** Holder: when the peer's proof was counted. The deadline does nothing then. */
  proofSeenAt?: number
  /** Holder: the deadline (or a request) was handled. */
  fired?: true
  /** Holder: the room this scan bound (the deadline's room, or a candidate): a proof in it pins. */
  boundIn?: string
  /**
   * Lacking H over a tombstone whose room a move bound within HOLDER_PAIR_MS (kept):
   * the link runs in that room in a holder's shape, so the peer sees what a
   * holder would send. The holder rules apply to it in full (proof, ack,
   * pairing, pin, deadline, candidates, life), and the link completes once both the peer's
   * proof of my code (`replied`) and its echo of my proof (`acked`) came. Then the
   * scan becomes a holder scan (completeLink).
   */
  shaped?: true
  /** Shaped: the link gave up (linkTimeoutMs); the scan lives on as a holder's, never completing. */
  lapsed?: true
  /** How the peer's code reached me; completeLink keeps it on the contact. */
  via?: 'camera' | 'paste'
}

/** A holder scan, or a shaped link that follows the holder rules on the wire. */
function holderLike(s: ScanRec | undefined): boolean {
  return !!s && (s.holder === true || s.shaped === true)
}

/** Inviter: a confirmation hello that must reach the invitee, kept across reloads. */
interface PendingConfirm {
  groupId: string
  code: string
  at: number
  /** How often it was re-sent at boot. */
  resends?: number
}

/** A round I may not start yet because the shared round budget with that contact is used. */
interface DeferredRound {
  offerId: string
  retry: boolean
  /** A reconfirm round: it runs while the match with this offer stands. */
  force?: true
}

/**
 * What a contact may hold of my offer. `ok`: a relay took exactly this one.
 * `id`: the id of my offer it was sent for, so a first send goes once per offer.
 */
interface Told {
  id: string
  offer: PublicOffer
  ok: boolean
}

interface InitSession {
  /** Original points for resending a crossed start without changing its secret. */
  p?: MatchPair
  sid: string
  contactId: PubkeyHex
  secret: string
  offerId: string
  at: number
  /** A repeat after a refusal. Not counted in matchProgress again. */
  retry?: boolean
  /** A reconfirm round: a repeat of it stays one. */
  force?: true
}

interface RespSession {
  sid: string
  contactId: PubkeyHex
  pq: MatchPair
  /** Null when I answered with random labels. */
  offerId: string | null
  at: number
}

/** A deleted contact: every channel field it had, kept, so its channel behaves as before. */
interface Tombstone extends ChannelFields {
  at: number
}

type Relation = 'contact' | 'tomb' | 'none'

type Wire<T extends WireMessage['t']> = Extract<WireMessage, { t: T }>

const ZERO_PROGRESS = { asked: 0, answered: 0 }

function publicOf(o: Offer): PublicOffer {
  // `rev` is local only and never sent.
  return {
    side: o.side,
    currency: o.currency,
    amountMinor: o.amountMinor,
    feePct: o.feePct,
    methods: [...o.methods],
    createdAt: o.createdAt,
  }
}

function validFee(n: unknown): n is number {
  return typeof n === 'number' && Number.isFinite(n) && n >= -50 && n <= 50
}

/** Wire input is untrusted even from a contact. */
function asSide(v: unknown): Side | null {
  return v === 'buy' || v === 'sell' ? v : null
}

function asCurrency(v: unknown): Currency | null {
  return isCurrency(v) ? v : null
}

/** A language this build knows; anything else (an older or newer build's value) is dropped. */
function asLang(v: unknown): Lang | null {
  return (LANGS as readonly unknown[]).includes(v) ? (v as Lang) : null
}

/** One of the auto-lock choices; anything else is dropped. */
function asRelockMinutes(v: unknown): RelockMinutes | null {
  return (RELOCK_MINUTES as readonly unknown[]).includes(v) ? (v as RelockMinutes) : null
}

function parsePublicOffer(v: unknown): PublicOffer | null {
  if (typeof v !== 'object' || v === null) return null
  const raw = v as Record<string, unknown>
  const side = asSide(raw.side)
  const currency = asCurrency(raw.currency)
  const amountMinor = raw.amountMinor
  const feePct = raw.feePct
  const createdAt = raw.createdAt
  const methods = canonicalMethods(raw.methods)
  if (!side || !currency || !isMinor(amountMinor) || !validFee(feePct) || !methods) return null
  return {
    side,
    currency,
    amountMinor,
    feePct,
    methods,
    createdAt: typeof createdAt === 'number' && Number.isFinite(createdAt) ? createdAt : 0,
  }
}

// ---------------------------------------------------------------- engine

export function createEngine(deps: EngineDeps, hooks: EngineHooks = {}): IlchonEngine {
  const { marmot, match, connect, storage } = deps
  const now = deps.now ?? (() => Date.now())
  const timerApi: NonNullable<EngineDeps['timers']> = deps.timers ?? {
    set: (fn, ms) => setTimeout(fn, ms),
    clear: (h) => clearTimeout(h as ReturnType<typeof setTimeout>),
  }
  const debug = hooks.debug ?? (() => {})

  const store = createStore<IlchonState>(() => ({
    boot: 'starting',
    me: null,
    hasWords: false,
    relays: [],
    fallingBack: false,
    contacts: [],
    myOffer: null,
    matches: [],
    matchProgress: ZERO_PROGRESS,
    rooms: {},
    tradeSteps: {},
    reopening: {},
    connect: { phase: 'idle' },
    rates: {},
    lock: { method: null, passkeySupported: null, waitUntil: 0 },
    settings: { lang: hooks.defaultLang ?? 'ko', sort: 'amount', relockMinutes: DEFAULT_RELOCK_MINUTES, relays: null, relayAuto: true, lnAddress: null },
  }))
  const get = store.getState
  const set = (patch: Partial<IlchonState>) => store.setState(patch)

  /** The secret key. Lives only in memory, and only after unlock. */
  let sk = ''
  /** The 12 words of an identity this app made; '' for a restored one. Same life as `sk`. */
  let words = ''
  /** When this device made or restored the key (unix s); the key-takeover check compares with it. */
  let identityAt = 0
  /** The engine's own table; LOCKED_KV until unlock. */
  let kv: KV = LOCKED_KV
  /** The profile's tables once unlocked: the engine KV and the transport tables. */
  let tables: Tables | null = null
  /** The store is open. Nothing reads or writes the engine KV before. */
  let unlocked = false
  /** An identity action (create, restore, unlock, change lock) is running. */
  let identityBusy = false
  /** Until when a sensitive action may run without proving the lock again. */
  let reauthUntil = 0
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
  /** stop() finished; nothing may reach KV until the next boot or unlock. */
  let halted = false
  /**
   * Grows at every stop. Work of one session never goes on in the next one, also when
   * the same engine starts again at once: a send that comes back after a stop is not
   * queued again, and a received message is handled only in the session it came in
   * (it stays in the inbox and the next session gets it again).
   */
  let session = 0

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
    /**
     * pubkey -> the round that holds this window's budget: 'i:<sid>' (I started
     * it) or 'r:<sid>' (I answered it). Only that round may send m2/m3 or finish.
     */
    roundOwner: {} as Record<PubkeyHex, string>,
    /** contact -> a round of my current offer waiting for the round window to pass. */
    deferred: {} as Record<PubkeyHex, DeferredRound>,
    /** invitee -> my confirmation hello that may not have reached it yet. */
    confirms: {} as Record<PubkeyHex, PendingConfirm>,
    /**
     * contact (or deleted contact) -> the offer it may hold of mine, and whether a relay
     * took exactly that one. Present = it may show my offer: written before
     * an offer goes, removed only once a withdraw was taken, its withdraw came, or a
     * round showed no match. Never sent anywhere.
     */
    told: {} as Record<PubkeyHex, Told>,
    /** Rumor ids of the Welcomes I joined for a move, newest last, at most JOINED_INVITES_MAX. */
    joinedInvites: [] as string[],
    seen: [] as string[],
    /** Small values of the screens (Engine.memo). */
    memo: {} as Record<string, unknown>,
    /** The largest created_at (s) of a list copy this device published or took in. */
    listAt: 0,
    /** Which list relays were merged once since the last restore. */
    listSync: { merged: {}, pending: [] } as ListSync,
  }
  const seenSet = new Set<string>()
  /** When I last showed a connection code (unix ms); a stranger's Welcome is kept only shortly after. */
  let lastCodeAt = 0

  // Timers are tracked by my own ids so nothing here depends on whether the
  // host returns a number (browser) or an object (Node) from setTimeout.
  const timers = new Map<number, () => void>()
  let nextTimerId = 1
  function later(ms: number, fn: () => void): number {
    const id = nextTimerId++
    const handle = timerApi.set(() => {
      timers.delete(id)
      if (!stopped) fn()
    }, ms)
    timers.set(id, () => timerApi.clear(handle))
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
  function activeContact(pk: PubkeyHex, groupId: string): (Contact & { groupId: string }) | undefined {
    const c = contactOf(pk)
    return c && c.groupId === groupId ? (c as Contact & { groupId: string }) : undefined
  }

  // Channel judgements. Contacts and tombstones go through the same ones.

  function relationOf(pk: PubkeyHex): Relation {
    return contactOf(pk) ? 'contact' : mem.tombstones[pk] ? 'tomb' : 'none'
  }
  /** The channel record of a contact or tombstone. Same shape, same rules for both. */
  function chanOf(pk: PubkeyHex): ChannelFields | undefined {
    return contactOf(pk) ?? mem.tombstones[pk]
  }
  /** The room cannot carry messages now (Transport.groupHealth). The only such test. */
  function roomUnusable(groupId: string | null | undefined): boolean {
    return !groupId || !transport || transport.groupHealth(groupId) !== 'ok'
  }
  /** The channel needs a new room: unfinished move, no room, or an unusable one ('stranded' included). */
  function channelBroken(ch: ChannelFields): boolean {
    return ch.moving !== undefined || roomUnusable(ch.groupId)
  }
  /** A room this peer's messages may come from or go to: its channel room, or its link room in progress. */
  function isLiveRoom(pk: PubkeyHex, groupId: string): boolean {
    return chanOf(pk)?.groupId === groupId || mem.scans[pk]?.groupId === groupId || !!candidates.get(pk)?.rooms.some((r) => r.groupId === groupId)
  }
  /** Some contact, tombstone, link or candidate room of a holder scan still uses this room. */
  function roomReferenced(groupId: string): boolean {
    return (
      get().contacts.some((c) => c.groupId === groupId) ||
      Object.values(mem.tombstones).some((tb) => tb.groupId === groupId) ||
      Object.values(mem.scans).some((s) => s.groupId === groupId) ||
      [...candidates.values()].some((c) => c.rooms.some((r) => r.groupId === groupId))
    )
  }
  /**
   * When my move limit for this peer lets the next room change happen. A fresh scan
   * of mine (5 minutes, not replied) lifts it once (`bypassUsed`).
   */
  function windowOpenAt(pk: PubkeyHex, ch: ChannelFields, t: number): number {
    const scan = mem.scans[pk]
    // A holder scan never uses the exception, nor a shaped link.
    if (scan && !holderLike(scan) && !scan.replied && !scan.bypassUsed && t - scan.at <= SCAN_TRUST_MS) return t
    const recent = (ch.moves ?? []).filter((m) => t - m < CHANNEL_WINDOW_MS)
    return recent.length < CHANNEL_MOVES_MAX ? t : recent[0] + CHANNEL_WINDOW_MS
  }
  /**
   * When L may answer the peer's room request with a new room: answers have
   * their own limit of CHANNEL_MOVES_MAX in 24 hours, counted apart from my own moves, so a
   * peer asking again and again changes the room at most twice a day on top of my two. Only
   * answers read `answered`: a move limit that anything else reads (my reopening, the room's
   * status line) counts `moves` alone, the same in a world where the peer deleted me and
   * asked and one where it kept me.
   */
  function answerOpenAt(pk: PubkeyHex, ch: ChannelFields, t: number): number {
    return windowOpenAt(pk, { ...ch, moves: ch.answered ?? [] }, t)
  }
  /** When the next attempt may run after `tries` attempts in a row (CHANNEL_RETRY_MS). */
  function retryAt(ch: ChannelFields, t: number): number {
    const n = ch.tries ?? 0
    if (!n || ch.triedAt === undefined) return t
    return ch.triedAt + CHANNEL_RETRY_MS[Math.min(n, CHANNEL_RETRY_MS.length) - 1]
  }
  /** The record with these channel fields changed; an undefined value removes the field. */
  function withChan<T extends ChannelFields>(ch: T, patch: Partial<ChannelFields>): T {
    const next = { ...ch } as Record<string, unknown>
    for (const [k, v] of Object.entries(patch)) {
      if (v === undefined) delete next[k]
      else next[k] = v
    }
    return next as T
  }
  /**
   * Changes channel fields of the contact or tombstone of `pk` and stores that one key
   * (the record, its room and its metadata in one write). false when there
   * is no record or the write failed.
   */
  function setChan(pk: PubkeyHex, patch: Partial<ChannelFields>): Promise<boolean> {
    if (contactOf(pk)) {
      set({ contacts: get().contacts.map((c) => (c.id === pk ? withChan(c, patch) : c)) })
      return save('contacts')
    }
    const tb = mem.tombstones[pk]
    if (!tb) return Promise.resolve(false)
    mem.tombstones = { ...mem.tombstones, [pk]: withChan(tb, patch) }
    return save('tombstones')
  }

  // ============================================================== 1. persistence

  const snapshots = {
    contacts: () => get().contacts,
    tombstones: () => mem.tombstones,
    offer: () => get().myOffer,
    matches: () => get().matches,
    verified: () => mem.verified,
    progress: () => get().matchProgress,
    settings: () => get().settings,
    codes: () => mem.codes,
    scans: () => mem.scans,
    init: () => mem.init,
    resp: () => mem.resp,
    respondLog: () => mem.respondLog,
    roundOwner: () => mem.roundOwner,
    deferred: () => mem.deferred,
    confirms: () => mem.confirms,
    told: () => mem.told,
    joinedInvites: () => mem.joinedInvites,
    seen: () => mem.seen,
    memo: () => mem.memo,
    tradeSteps: () => get().tradeSteps,
    listAt: () => mem.listAt,
    listSync: () => mem.listSync,
  } satisfies Record<string, () => unknown>
  type StoreKey = keyof typeof snapshots

  let writeChain: Promise<void> = Promise.resolve()
  const queuedWrites = new Map<string, Promise<boolean>>()
  /** Writes that failed or ran out of time. A received message is kept when this moved while it was handled. */
  let persistFails = 0

  /** Writes may reach the store: unlocked, no reset in progress, not stopped. */
  const writable = () => !frozen && !halted && unlocked

  /**
   * Runs `write` for `key` in turn. Writes run one at a time, and a write that has
   * not started yet absorbs later requests for the same key. Never rejects;
   * resolves false when the value did not reach storage.
   */
  function persist(key: string, logKey: string, write: () => Promise<void>): Promise<boolean> {
    if (!writable()) return Promise.resolve(false)
    const queued = queuedWrites.get(key)
    if (queued) return queued
    const p = writeChain.then(async () => {
      queuedWrites.delete(key)
      if (!writable()) return false
      // One write may not hold up the chain: a store that never answers (IndexedDB
      // after an iOS resume) costs WRITE_WAIT_MS per write, never the session.
      // The timer is the engine's own, so it runs on virtual time in checks
      // and also after stop().
      let timer: unknown
      const timeout = new Promise<'timeout'>((resolve) => {
        timer = timerApi.set(() => resolve('timeout'), WRITE_WAIT_MS)
      })
      try {
        const r = await Promise.race([write().then(() => 'ok' as const), timeout])
        if (r === 'ok') return true
        debug('persist-failed', { key: logKey })
      } catch {
        debug('persist-failed', { key: logKey })
      } finally {
        timerApi.clear(timer)
      }
      persistFails++
      return false
    })
    writeChain = p.then(() => {})
    queuedWrites.set(key, p)
    return p
  }

  /** Write the current value of `key`. */
  function save(key: StoreKey): Promise<boolean> {
    return persist(key, key, () => kv.set(key, snapshots[key]()))
  }

  /** Write one contact's chat as it is now; a contact without a room loses its item. */
  function saveRoom(pk: PubkeyHex): Promise<boolean> {
    return persist(roomKey(pk), 'room', async () => {
      const list = get().rooms[pk]
      if (list) await kv.set(roomKey(pk), list)
      else await kv.del(roomKey(pk))
    })
  }

  /**
   * One contact's chat. A damaged item loses that chat only and the app opens
   * (the next save writes over it); storage-unavailable stops the boot.
   */
  async function loadRoom(pk: PubkeyHex): Promise<ChatMessage[] | undefined> {
    try {
      const list = await kv.get<ChatMessage[]>(roomKey(pk))
      return Array.isArray(list) ? list : undefined
    } catch (e) {
      if (errCode(e) !== 'storage-damaged') throw e
      debug('room-damaged')
      return undefined
    }
  }

  async function load(): Promise<void> {
    const t = now()
    // The list sync's own records: new keys that read with a default.
    const at = await kv.get<number>('listAt')
    mem.listAt = typeof at === 'number' && Number.isFinite(at) && at >= 0 ? at : 0
    mem.listSync = readListSync(await kv.get('listSync'))
    // A damaged contacts item does not stop the app: the list opens empty and every
    // list relay is merged once more, as after a restore, which brings the contacts
    // and the tombstones back from the relays' copies.
    let storedContacts: Contact[]
    let rebuild = false
    try {
      storedContacts = (await kv.get<Contact[]>('contacts')) ?? []
    } catch (e) {
      if (errCode(e) !== 'storage-damaged') throw e
      debug('storage-damaged', { errorKey: 'contact-list' })
      storedContacts = []
      rebuild = true
    }
    // A damaged tombstones item takes the same path: the deleted records live in
    // the same relay copies, so they come back by the same merge. The contacts stay.
    const damagedContacts = rebuild
    let damagedTombs = false
    try {
      mem.tombstones = (await kv.get<Record<PubkeyHex, Tombstone>>('tombstones')) ?? {}
    } catch (e) {
      if (errCode(e) !== 'storage-damaged') throw e
      if (!damagedContacts) debug('storage-damaged', { errorKey: 'contact-list' })
      mem.tombstones = {}
      damagedTombs = true
      rebuild = true
    }
    if (rebuild) {
      mem.listSync = { merged: {}, pending: [...(deps.listRelays ?? [])] }
      if (damagedContacts) await kv.set('contacts', [])
      if (damagedTombs) await kv.set('tombstones', {})
      await kv.set('listSync', mem.listSync)
    }
    // A stop between the two writes of a delete (tombstones first) or of a link
    // (contacts first, completeLink) leaves one pubkey in both. The later record wins:
    // a delete writes tomb.at = now, a link createdAt = now.
    const dropped: PubkeyHex[] = []
    let tombsFixed = false
    const contacts = storedContacts.filter((c) => {
      const tb = mem.tombstones[c.id]
      if (!tb) return true
      if (c.createdAt >= tb.at) {
        delete mem.tombstones[c.id]
        tombsFixed = true
        return true
      }
      dropped.push(c.id)
      return false
    })
    // A currency this build does not know (a newer build was rolled back) is refused, not migrated.
    const storedOffer = (await kv.get<Offer | null>('offer')) ?? null
    const offer =
      storedOffer && isCurrency(storedOffer.currency) && canonicalMethods(storedOffer.methods) ? storedOffer : null
    const storedMatches = ((await kv.get<Match[]>('matches')) ?? []).filter(
      (x) => isCurrency(x.offer?.currency) && canonicalMethods(x.offer?.methods) !== null,
    )
    const progress = (await kv.get<IlchonState['matchProgress']>('progress')) ?? ZERO_PROGRESS
    const rooms: IlchonState['rooms'] = {}
    for (const c of contacts) {
      const list = await loadRoom(c.id)
      if (list) rooms[c.id] = list
    }
    // The outbox lives in memory: a message still 'sending' at the last stop was never delivered.
    // Only records that carry a status: my texts (sent again by the user) and my completions
    // (sent again by resendPending at the end of boot).
    const sending = (x: ChatMessage) => 'status' in x && x.status === 'sending'
    for (const [pk, list] of Object.entries(rooms)) {
      if (list.some(sending)) {
        rooms[pk] = list.map((x) => (sending(x) ? ({ ...x, status: 'failed' } as ChatMessage) : x))
      }
    }
    const settings = await kv.get<Partial<Settings>>('settings')
    // A new key that reads as {} (no format change). Steps of contacts no longer here are dropped.
    const storedSteps = (await kv.get<IlchonState['tradeSteps']>('tradeSteps')) ?? {}
    const tradeSteps: IlchonState['tradeSteps'] = {}
    for (const c of contacts) if (storedSteps[c.id]) tradeSteps[c.id] = storedSteps[c.id]

    mem.verified = (await kv.get<Record<PubkeyHex, string>>('verified')) ?? {}
    // A match stands only on a verified match with my current offer. Where two keys are
    // written one after the other (onWithdraw: verified, then matches) a stop in between
    // leaves a match that no longer stands; it goes here.
    const matches = storedMatches.filter((x) => !!offer && mem.verified[x.contactId] === offer.id)
    const storedCodes = (await kv.get<CodeRec[]>('codes')) ?? []
    lastCodeAt = Math.max(0, ...storedCodes.map((c) => c.createdAt))
    // All kept until the backlog after this start was handled; pruneCodes then.
    mem.codes = storedCodes
    mem.joinedInvites = (await kv.get<string[]>('joinedInvites')) ?? []
    mem.scans = (await kv.get<Record<PubkeyHex, ScanRec>>('scans')) ?? {}
    // A link scan of someone who is a contact now is left over from a stop inside
    // completeLink; a holder scan is only of a contact. Its life ends
    // at its timer, after the backlog of this start. `moving` is not touched here.
    let scansFixed = false
    for (const [pk, s] of Object.entries(mem.scans)) {
      const isContact = contacts.some((c) => c.id === pk)
      if (s.holder ? isContact : !isContact) continue
      delete mem.scans[pk]
      scansFixed = true
    }
    mem.init = (await kv.get<Record<string, InitSession>>('init')) ?? {}
    mem.resp = (await kv.get<Record<string, RespSession>>('resp')) ?? {}
    mem.respondLog = (await kv.get<Record<PubkeyHex, number>>('respondLog')) ?? {}
    mem.roundOwner = (await kv.get<Record<PubkeyHex, string>>('roundOwner')) ?? {}
    mem.deferred = (await kv.get<Record<PubkeyHex, DeferredRound>>('deferred')) ?? {}
    mem.confirms = (await kv.get<Record<PubkeyHex, PendingConfirm>>('confirms')) ?? {}
    mem.told = (await kv.get<Record<PubkeyHex, Told>>('told')) ?? {}
    mem.seen = (await kv.get<string[]>('seen')) ?? []
    // The screens' small values: a damaged item starts empty.
    try {
      const m = await kv.get<Record<string, unknown>>('memo')
      mem.memo = typeof m === 'object' && m !== null && !Array.isArray(m) ? m : {}
    } catch (e) {
      if (errCode(e) !== 'storage-damaged') throw e
      mem.memo = {}
      debug('storage-damaged', { errorKey: 'memo' })
    }
    seenSet.clear()
    for (const id of mem.seen) seenSet.add(id)

    // Migrate ownerless sessions before pruning: never erase their spent budget. A round I
    // started is open only while it owns the budget with that contact: startRound writes the
    // round and its budget side by side, so a stop between the two leaves a round beside an
    // older owner (reachable by a re-add). That round never sent
    // its round 1 (it goes only after both writes); it is closed here and runs again once
    // the budget is free, like an ownerless one (INV-M4 at every stop).
    for (const sessions of [mem.init, mem.resp]) {
      for (const [key, session] of Object.entries(sessions)) {
        const owner = mem.roundOwner[session.contactId]
        if (sessions === mem.init ? owner === `i:${key}` : owner) continue
        delete sessions[key]
        if (offer && contacts.some((c) => c.pubkey === session.contactId)) {
          // A reconfirm round stays one.
          const force = 'force' in session && session.force === true
          mem.deferred[session.contactId] = { offerId: offer.id, retry: true, ...(force ? { force } : {}) }
        }
      }
    }
    await Promise.all([save('init'), save('resp'), save('deferred')])

    // Sessions of an offer that no longer exists can never complete.
    // Their reservation is released: such a round never sent m3, so it revealed nothing.
    for (const [sid, s] of Object.entries(mem.init)) {
      if (offer && s.offerId === offer.id) continue
      delete mem.init[sid]
      if (mem.roundOwner[s.contactId] === `i:${sid}`) {
        delete mem.roundOwner[s.contactId]
        delete mem.respondLog[s.contactId]
      }
    }
    for (const [pk, d] of Object.entries(mem.deferred)) if (!offer || d.offerId !== offer.id) delete mem.deferred[pk]
    pruneRespSessions(t)

    // An unknown stored language is ignored and the language in memory stays.
    const cur = get().settings
    const lang = asLang(settings?.lang) ?? cur.lang
    const sort = settings?.sort ?? cur.sort
    // Only one of the choices; a missing or unknown value is the default.
    const relockMinutes = asRelockMinutes(settings?.relockMinutes) ?? DEFAULT_RELOCK_MINUTES
    // The relay choice is checked again as setSettings checks it: a
    // list that no longer passes means the defaults.
    let relays: string[] | null = null
    try {
      relays = Array.isArray(settings?.relays) ? cleanRelayList(settings.relays, deps.relays) : null
    } catch {
      relays = null
    }
    const relayAuto = settings?.relayAuto !== false
    // Only an address the lookup module still reads as one; anything else is none.
    const lnAddress = typeof settings?.lnAddress === 'string' ? deps.lnurl.parseAddress(settings.lnAddress) : null
    set({
      contacts,
      myOffer: offer,
      matches,
      matchProgress: progress,
      rooms,
      tradeSteps,
      settings: { lang, sort, relockMinutes, relays, relayAuto, lnAddress },
    })
    if (matches.length !== storedMatches.length) await save('matches')
    if (tombsFixed || dropped.length > 0) {
      await save('tombstones')
      await save('contacts')
    }
    // What a stop inside removeContact left of a deleted contact: its chat item, its
    // screen values and its guide step (removeContact writes them after the tombstone;
    // the steps of contacts no longer here were already left out of tradeSteps above).
    const gone = new Set([...dropped, ...Object.keys(mem.tombstones)])
    const roomsLeft = (await kv.keys(roomKey(''))).map((k) => k.slice(roomKey('').length)).filter((pk) => gone.has(pk))
    const memoLeft = dropMemoOf(gone)
    const stepsLeft = Object.keys(storedSteps).some((pk) => !(pk in tradeSteps))
    if (roomsLeft.length || memoLeft || stepsLeft) {
      await Promise.all([
        ...roomsLeft.map((pk) => saveRoom(pk)),
        ...(memoLeft ? [save('memo')] : []),
        ...(stepsLeft ? [save('tradeSteps')] : []),
      ])
    }
    if (scansFixed) await save('scans')
    // load() runs right after unlock: a language picked before (the first screen of a new
    // profile) is kept now. Nothing about settings is written before unlock.
    await save('settings')
  }

  /**
   * Drops the screen values about these contacts from mem.memo (not saved here): keys
   * ending with `:<contactId>` (draft:, nostr:) and the room of memo.place, which goes
   * back to the tab. True when anything changed.
   */
  function dropMemoOf(gone: ReadonlySet<string>): boolean {
    const keys = Object.keys(mem.memo).filter((k) => k.includes(':') && gone.has(k.slice(k.lastIndexOf(':') + 1)))
    const place = mem.memo.place
    const room = typeof place === 'object' && place !== null ? (place as { room?: unknown }).room : undefined
    const placeLeft = typeof room === 'string' && gone.has(room)
    if (!keys.length && !placeLeft) return false
    const next = { ...mem.memo }
    for (const k of keys) delete next[k]
    if (placeLeft) next.place = { ...(place as object), room: null }
    mem.memo = next
    return true
  }

  function remember(id: string): void {
    seenSet.add(id)
    mem.seen.push(id)
    if (mem.seen.length > SEEN_CAP) {
      for (const old of mem.seen.splice(0, mem.seen.length - SEEN_CAP)) seenSet.delete(old)
    }
    void save('seen')
  }

  /**
   * Drop a room from this device once no contact, tombstone or link uses it.
   * Call it after the record that let go of the room changed in memory.
   */
  function forget(groupId: string | null | undefined): void {
    if (!groupId || roomReferenced(groupId)) return
    void transport?.forgetGroup(groupId).catch(() => debug('forget-failed'))
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
      a.amountMinor === b.amountMinor &&
      a.feePct === b.feePct &&
      a.methods.join() === b.methods.join() &&
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
    switch (msg.t) {
      case 'hello':
        // Links, echoes and confirmations: the same for a contact and a tombstone.
        return isLiveRoom(pk, groupId)
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
    if (why === 'retries' && it.peer) {
      const owner = mem.roundOwner[it.peer]
      if (owner?.startsWith('i:') && ['m1', 'm3', 'offer'].includes(it.msg.t)) {
        const sid = owner.slice(2)
        if ((it.msg.t === 'm1' || it.msg.t === 'm3') && it.msg.sid !== sid) return
        // A relay that keeps refusing: the round comes again with the gaps of an
        // unanswered one (15 s to 15 min), not at once.
        const silent = (silentRounds.get(it.peer) ?? 0) + 1
        silentRounds.set(it.peer, silent)
        recoverInit(it.peer, sid, silentRetryDelay(silent))
      }
    }
  }

  /** Backoff of a refused send; a check may shorten it. An empty list: no retry. */
  const sendRetryMs = deps.tuning?.sendRetryMs ?? SEND_RETRY_MS

  /**
   * Send one message. Never throws. Returns false when the message was not
   * accepted right now; it then waits in the outbox and is retried in order.
   */
  async function send(groupId: string, msg: WireMessage, opts: SendOpts = {}): Promise<boolean> {
    const t = transport
    const item: OutItem = { ...opts, msg, tries: 0 }
    // A room no record of the peer uses any more is closed.
    if (!t || stopped || (opts.peer !== undefined && !isLiveRoom(opts.peer, groupId))) {
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
    const s = session
    try {
      await t.send(groupId, msg)
      debug('tx', { t: msg.t })
      opts.settle?.(true)
      return true
    } catch {
      debug('tx-failed', { t: msg.t })
      // Stopped meanwhile: no retry is scheduled after a stop, so a queued item would
      // block this room's sends of the next start for good. A send of the
      // last session is not retried in the next one either.
      if (stopped || s !== session) {
        opts.settle?.(false)
        return false
      }
      item.tries = 1
      const box = outbox.get(groupId)
      if (box) {
        box.items.push(item)
      } else if (sendRetryMs.length === 0) {
        dropItem(item, 'retries')
      } else {
        outbox.set(groupId, { items: [item] })
        later(sendRetryMs[0], () => void flush(groupId))
      }
      return false
    }
  }

  async function flush(groupId: string): Promise<void> {
    const box = outbox.get(groupId)
    if (!box) return
    const s = session
    while (box.items.length > 0) {
      const t = transport
      // A closed room (no record of the peer uses it) is dropped per item below.
      if (!t || stopped || s !== session) {
        if (outbox.get(groupId) === box) outbox.delete(groupId)
        for (const it of box.items.splice(0)) dropItem(it, 'closed')
        return
      }
      const head = box.items[0]
      if (head.peer !== undefined && !isLiveRoom(head.peer, groupId)) {
        box.items.shift()
        dropItem(head, 'closed')
        continue
      }
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
        // Stopped meanwhile (shutdown() emptied the outbox): no retry.
        if (stopped || s !== session) {
          head.settle?.(false)
          return
        }
        head.tries++
        if (head.tries > sendRetryMs.length) {
          box.items.shift()
          dropItem(head, 'retries')
          continue
        }
        later(sendRetryMs[head.tries - 1], () => void flush(groupId))
        return
      }
    }
    if (outbox.get(groupId) === box) outbox.delete(groupId)
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

  // ---------------------------------------------------------------- 2b. state signals (told)

  const resendBaseMs = deps.tuning?.resendBaseMs ?? RESEND_BASE_MS
  /** Contacts with a told send in flight (one at a time each), and those that want one more after it. */
  const syncing = new Set<PubkeyHex>()
  const again = new Set<PubkeyHex>()
  let resendDelay = resendBaseMs
  let resendTimer: number | undefined

  /**
   * What `pk` should hold of my offer now. Nothing (null) unless it is a
   * living contact whose match with exactly my current offer I verified. Then my current
   * offer once its valid offer came (it is in matches). Before that, nothing new
   * (undefined: leave told as it is): only a first send of this very offer that a relay
   * has not taken yet goes again, so an edit or a reconfirm never reaches a contact that
   * matched without showing its own offer, and no withdraw comes from waiting either.
   */
  function wantFor(pk: PubkeyHex): PublicOffer | null | undefined {
    const cur = get().myOffer
    if (!cur || !contactOf(pk) || mem.verified[pk] !== cur.id) return null
    const value = publicOf(cur)
    if (get().matches.some((x) => x.contactId === pk)) return value
    const have = mem.told[pk]
    return have && have.id === cur.id && sameOffer(have.offer, value) ? value : undefined
  }

  /**
   * The room a state signal for `pk` goes through: the channel room of the contact or of
   * the deleted contact (chanOf). Never a link room in progress.
   */
  function roomOf(pk: PubkeyHex): string | null {
    return chanOf(pk)?.groupId ?? null
  }

  /**
   * Brings `pk` to what it should hold of my offer: sends my offer (told written first)
   * or a withdraw, or nothing when it already holds the right thing. `force` sends the
   * offer again even then. A failure is retried by armResend until it lands, also across
   * restarts (told is stored). Runs in the contact's queue.
   */
  function syncOffer(pk: PubkeyHex, force = false): void {
    const s = session
    void enqueue(pk, async () => {
      // The change that called for this signal reaches storage first (withdrawOffer
      // queues its writes right after this call): a withdraw never goes out while the
      // stored offer and match still say otherwise, or a restart would think the
      // contact still holds my offer.
      await writeChain
      if (stopped || s !== session) return
      if (syncing.has(pk)) {
        if (force) again.add(pk)
        return
      }
      // No room (yet): told stays, and resendPending sends once there is one.
      const groupId = roomOf(pk)
      if (!groupId) return
      // A room that cannot carry messages now: nothing is written or sent, the
      // signal stays owed, and the resend timer tries again.
      if (roomUnusable(groupId)) return armResend()
      const have = mem.told[pk]
      const want = wantFor(pk)
      // Nothing new before the contact's offer came.
      if (want === undefined) return
      const cur = get().myOffer
      let msg: Wire<'offer'> | Wire<'withdraw'>
      if (want && cur) {
        if (!force && have?.ok && have.id === cur.id && sameOffer(have.offer, want)) return
        mem.told[pk] = { id: cur.id, offer: want, ok: false }
        // Written before the offer goes: a stop after the send still knows what is owed.
        if (!(await save('told'))) return armResend()
        if (s !== session) return
        msg = { t: 'offer', offer: want }
      } else if (have) {
        msg = { t: 'withdraw' }
      } else return
      syncing.add(pk)
      const sentFor = mem.told[pk]
      // A room that turned unusable meanwhile is refused by the transport before anything
      // is encrypted; armResend goes on from there.
      await send(groupId, msg, { peer: pk, settle: (ok) => s === session && toldSettled(pk, msg, ok, sentFor) })
    })
  }

  /** `sentFor`: the told record the message was sent for. */
  function toldSettled(pk: PubkeyHex, msg: Wire<'offer'> | Wire<'withdraw'>, ok: boolean, sentFor?: Told): void {
    syncing.delete(pk)
    const have = mem.told[pk]
    if (ok && have) {
      // A first send written meanwhile is not what this withdraw took back.
      if (msg.t === 'withdraw') {
        if (have === sentFor) delete mem.told[pk]
      }
      else if (sameOffer(have.offer, msg.offer)) have.ok = true
      void save('told')
    }
    if (ok) resendDelay = resendBaseMs
    const force = again.delete(pk)
    const want = wantFor(pk)
    // Nothing new may go before the contact's offer came; its arrival syncs again.
    if (want === undefined) return
    const same = msg.t === 'offer' ? want !== null && sameOffer(want, msg.offer) : want === null
    if (!ok && same && !force) armResend()
    else syncOffer(pk, force)
  }

  /**
   * Every pending signal goes again: told and verified contacts, and my completion
   * records a relay has not taken. A record still 'sending' is in
   * flight and waits; one 'sending' at the last stop was read back as 'failed' (load).
   * Texts are never re-sent here: the user sends a failed one again.
   */
  function resendPending(): void {
    if (stopped || get().boot !== 'ready') return
    for (const pk of new Set([...Object.keys(mem.told), ...Object.keys(mem.verified)])) syncOffer(pk)
    for (const [pk, list] of Object.entries(get().rooms)) {
      for (const m of list) if (m.mine && m.kind === 'done' && m.status === 'failed') resendRecord(pk, m.id)
    }
  }

  /** The wire form of a room record of mine, under its own id (9). */
  function wireOf(rec: ChatMessage): WireMessage | null {
    if (rec.kind === 'done') return { t: 'done', id: rec.id, amountMinor: rec.amountMinor, currency: rec.currency }
    if (rec.kind === 'text') return { t: 'chat', id: rec.id, text: rec.text }
    return null
  }

  /**
   * One failed completion record goes again, under the same id (the receiver keeps one).
   * Only while the record is still there, still 'failed', and the contact has a room;
   * otherwise it stays 'failed' and the next resendPending looks again. 'sending' is set
   * before the send, so overlapping resendPending calls send it once.
   */
  function resendRecord(pk: PubkeyHex, id: string): void {
    const rec = get().rooms[pk]?.find((x) => x.id === id)
    if (!rec || !rec.mine || rec.kind !== 'done' || rec.status !== 'failed') return
    const groupId = contactOf(pk)?.groupId
    if (!groupId) return
    // A room that cannot carry messages now: nothing is encrypted (no ratchet step), the
    // record stays 'failed' and the resend timer tries again, as syncOffer does.
    if (roomUnusable(groupId)) return armResend()
    setRecordStatus(pk, id, 'sending')
    // A result that comes back after a stop belongs to the last session: the next start
    // read the record back from storage and goes on from there (as syncOffer).
    const s = session
    sendLater(pk, groupId, () => wireOf(rec), (ok) => s === session && recordSettled(pk, id, ok, groupId))
  }

  /**
   * The send of one of my records ended: its status follows; a completion that failed goes
   * again later. `room`: the room it was sent into, taken when it was sent.
   */
  function recordSettled(pk: PubkeyHex, id: string, ok: boolean, room?: string): void {
    // A record of mine a relay took: the room it went into carries messages (lastTextFailed).
    // That room, not the contact's room now: a send into the old room that a relay
    // takes after a move says nothing of the new one.
    if (ok && room) roomWorked.set(room, now())
    setChatStatus(pk, id, ok)
    const rec = get().rooms[pk]?.find((x) => x.id === id)
    if (rec?.kind !== 'done') return
    if (ok) resendDelay = resendBaseMs
    else armResend()
  }

  /** One engine timer for the resend; the gap doubles up to RESEND_MAX_MS. No limit on tries. */
  function armResend(): void {
    if (stopped || resendTimer !== undefined) return
    resendTimer = later(resendDelay, () => {
      resendTimer = undefined
      resendDelay = Math.min(resendDelay * 2, RESEND_MAX_MS)
      resendPending()
    })
  }

  // ============================================================== 3. connect

  const linkTimeoutMs = deps.tuning?.linkTimeoutMs ?? LINK_TIMEOUT_MS
  const repliedLinkTtlMs = deps.tuning?.repliedLinkTtlMs ?? REPLIED_LINK_TTL_MS
  const linkTimers = new Map<PubkeyHex, number>()
  // Holder scans. The life of a holder scan is 2 x the pairing window + 60 s, and a
  // code of mine counts in a holder proof up to that + CODE_REDEEM_MS old (and is kept as long).
  const holderPairMs = deps.tuning?.holderPairMs ?? HOLDER_PAIR_MS
  const holderScanTtlMs = holderScanTtl(holderPairMs)
  const holderCodeMs = holderScanTtlMs + CODE_REDEEM_MS
  /** One deadline timer per holder scan. */
  const deadlineTimers = new Map<PubkeyHex, number>()
  /** One timer per channel whose "channel reopened" line waits for its decision. */
  const noticeTimers = new Map<PubkeyHex, number>()
  /**
   * Candidate rooms of a living holder scan: joined from a tagged move, not
   * bound. Memory only: after a reload the boot cleanup removes them.
   */
  const candidates = new Map<PubkeyHex, { scan: ScanRec; rooms: { groupId: string; sentAt: number }[] }>()
  /** Until then the backlog of the last start or return is being handled. */
  let resumeUntil = 0
  /**
   * The moment of the last start or return to the app (a start, back in view or
   * reconnected, a holder timer that fired late): the first signal of one return, not
   * the later ones while its window (resumeUntil) is open. A missed deadline's
   * one-minute limit is measured from it, not from the later judgment after the backlog.
   */
  let backAt = 0
  /** Prunes the codes a return window kept, when it closes. */
  let returnTimer: number | undefined
  /**
   * When the return window before this one closed (0 after a start): a peer's own time
   * older than that had its chance in that window and stands in for now no further than
   * this (a flapping relay that opens one window after another).
   */
  let trustFrom = 0
  /** "Channel reopened" lines found due (the screen draws them; tests read the count). */
  let noticesDue = 0
  const buffered = new Map<PubkeyHex, { invite: IncomingInvite; timer: number }>()
  /** Welcome ids looked at in this engine, oldest first in insertion order; a ring of HANDLED_INVITES_MAX. */
  const handledInvites = new Set<string>()
  function markHandled(id: string): void {
    handledInvites.add(id)
    if (handledInvites.size > HANDLED_INVITES_MAX) handledInvites.delete(handledInvites.values().next().value as string)
  }
  /**
   * My codes a shaped link redeemed from the peer's holder proof (shapedHello). The peer's
   * repeats of that proof are holder proofs, kept and counted as a holder would,
   * not the repeats of a link reply. Memory only: lost on a reload, after which they go
   * unrecorded (the pairing was counted already).
   */
  const shapedCodes = new Set<string>()
  /** code -> how often a hello carrying it was echoed to a contact (caps a hello loop). */
  const echoes =new Map<string, { n: number; since: number; total: number }>()
  /** An honest peer re-sends a hello at most LINK_RESEND_MAX times plus its first burst. */
  const ECHO_TOTAL_MAX = 3 * LINK_RESEND_MAX
  /** Counts one echo for `key`; false once ECHO_MAX were sent in the current window, or too many overall. */
  function mayEcho(key: string): boolean {
    const t = now()
    const e = echoes.get(key) ?? { n: 0, since: t, total: 0 }
    if (e.total >= ECHO_TOTAL_MAX) return false
    if (t - e.since > ECHO_WINDOW_MS) {
      e.n = 0
      e.since = t
    }
    if (e.n >= ECHO_MAX) return false
    e.n++
    e.total++
    echoes.set(key, e)
    return true
  }
  const ECHO_MAX = 4

  function setConnect(patch: Partial<ConnectState>): void {
    set({ connect: { ...get().connect, ...patch } })
  }

  function failConnect(errorKey: NonNullable<ConnectState['errorKey']>): void {
    setConnect({ phase: 'failed', errorKey })
    debug('connect-failed', { errorKey })
  }

  /**
   * Fail the visible flow, but only if it is still about this peer. A link over a tombstone
   * (re-adding someone I deleted) fails without a support log line: in the twin where that
   * peer is a contact my scan is a holder's, which never fails, and the log must be the same
   * (twin assertion 2).
   */
  function failLink(pk: PubkeyHex, errorKey: NonNullable<ConnectState['errorKey']>): void {
    const c = get().connect
    if (c.peerPubkey !== pk || (c.phase !== 'scanned' && c.phase !== 'linking')) return
    if (relationOf(pk) === 'tomb') setConnect({ phase: 'failed', errorKey, waitingPeer: undefined })
    else failConnect(errorKey)
  }

  function markLinking(pk: PubkeyHex): void {
    const c = get().connect
    if (c.peerPubkey === pk && c.phase === 'scanned') setConnect({ phase: 'linking' })
  }

  /**
   * Codes are kept as long as a hello carrying one may still be echoed or a
   * holder proof with it may still be paired, and all of them while the
   * backlog of a start is handled.
   */
  function pruneCodes(): void {
    const t = now()
    if (t < resumeUntil) return
    const keep = (c: CodeRec) => t - c.createdAt <= holderCodeMs || Object.values(c.holderUses ?? {}).some((u) => t - u.at <= holderPairMs)
    if (mem.codes.every(keep)) return
    mem.codes = mem.codes.filter(keep)
    void save('codes')
  }

  /**
   * A new code and the QR text for it. My KeyPackage reference goes in: a room made
   * from a scan of this QR invites only that KeyPackage, and the scanner has no fallback to
   * a newer one. So while the transport has none on a relay yet (every
   * start until its KeyPackage is confirmed, and while offline) no QR is made at all: a QR
   * without a real reference would look valid and fail every scan. No code is used up
   * then; refreshQrKp issues the QR the moment the reference appears.
   */
  function issueCode(): { myPayload: string | undefined; myCodeExpiresAt: number | undefined } {
    const kp = transport?.keyPackageRef() ?? null
    if (!kp) return { myPayload: undefined, myCodeExpiresAt: undefined }
    const t = now()
    pruneCodes()
    const code = connect.newCode()
    mem.codes.push({ code, createdAt: t, used: false })
    lastCodeAt = t
    void save('codes')
    const exp = t + CODE_DISPLAY_MS
    return { myPayload: connect.encodePayload({ v: 2, pk: me, code, exp, kp }), myCodeExpiresAt: exp }
  }

  /**
   * `sentS` (the peer's claimed seconds) lies within the life of a code of mine, from its
   * making to CODE_REDEEM_MS after, with the two-clock tolerance FUTURE_SENT_S either way:
   * a request made then may be the peer's scan of my QR. Judged
   * on the request's own time, so a request handed over late (my page frozen) counts too.
   * The codes kept (pruneCodes) and the newest one count.
   */
  function codeShownNear(sentS: number): boolean {
    const t = sentS * 1000
    const tol = FUTURE_SENT_S * 1000
    return [lastCodeAt, ...mem.codes.map((c) => c.createdAt)].some((at) => at > 0 && t >= at - tol && t <= at + CODE_REDEEM_MS + tol)
  }

  /** The phases in which my QR is on the connect screen. */
  function qrPhase(phase: ConnectState['phase']): boolean {
    return phase === 'showing' || phase === 'scanned' || phase === 'linking' || phase === 'already'
  }

  function startConnect(): void {
    if (!me) return
    set({ connect: { phase: 'showing', ...issueCode() } })
    // The KeyPackage my QR names must be readable on my relays. The
    // transport reads it back at most once per 10 minutes and publishes it again if gone.
    void transport?.checkKeyPackage().catch(() => {})
    // My own slot holding a package this device did not make is a key takeover too.
    void checkElsewhere(true)
  }

  /**
   * My KeyPackage reference changed. The first one after a start: a connect screen waiting
   * without a QR gets its first code now. A rotation after a join: the relays replace my
   * KeyPackage, so a QR still naming the old one could not be invited from any more
   * (a scanned room invites only the QR's kp). A QR on screen gets the new reference at
   * once, with the same code and expiry: no new code is issued.
   */
  function refreshQrKp(): void {
    const t = transport
    const c = get().connect
    const kp = t?.keyPackageRef()
    if (!me || !kp || !qrPhase(c.phase)) return
    if (!c.myPayload) {
      setConnect(issueCode())
      return
    }
    const p = connect.decodePayload(c.myPayload)
    if (!p || p.kp === kp) return
    setConnect({ myPayload: connect.encodePayload({ ...p, kp }) })
  }

  function rotateConnectCode(): void {
    // 'already' keeps my QR on screen: the peer may still need to scan it.
    if (!me || !qrPhase(get().connect.phase)) return
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

  /**
   * The life of a scan. A holder scan, and a shaped link (which looks like
   * one on the wire), lives holderScanTtlMs and, after a start, at least until the backlog
   * had its chance; a shaped link itself gives up after linkTimeoutMs on screen.
   * A lacking scan lives 2 minutes, 7 days once replied.
   */
  function armLinkTimeout(pk: PubkeyHex, at: number): void {
    cancel(linkTimers.get(pk))
    const scan = mem.scans[pk]
    if (holderLike(scan)) {
      const wait = Math.max(0, at + holderScanTtlMs - now(), resumeUntil - now())
      const due = now() + wait
      linkTimers.set(
        pk,
        later(wait, () => {
          noteLate(due)
          expireLink(pk, at)
        }),
      )
      if (scan?.shaped && !scan.lapsed) {
        // The screen stops looking busy after linkTimeoutMs, as for a replied invitee; the
        // link may complete while my scan is fresh (SCAN_TRUST_MS).
        later(Math.max(0, at + linkTimeoutMs - now()), () => {
          const c = get().connect
          if (mem.scans[pk] === scan && c.peerPubkey === pk && c.phase === 'linking') setConnect({ waitingPeer: true })
        })
        later(Math.max(0, at + SCAN_TRUST_MS - now()), () => lapseShaped(pk, scan))
      }
      return
    }
    const repliedInvitee = scan?.replied === true && !scan.inviter
    const ttl = repliedInvitee ? repliedLinkTtlMs : linkTimeoutMs
    linkTimers.set(
      pk,
      later(Math.max(0, at + ttl - now()), () => expireLink(pk, at)),
    )
    if (repliedInvitee) {
      // The screen stops looking busy; the link itself stays open in the background.
      later(Math.max(0, at + linkTimeoutMs - now()), () => {
        const c = get().connect
        if (mem.scans[pk] === scan && c.peerPubkey === pk && c.phase === 'linking') setConnect({ waitingPeer: true })
      })
    }
  }

  /** The end of a scan's life. */
  function expireLink(pk: PubkeyHex, at: number): void {
    const scan = mem.scans[pk]
    if (!scan || scan.at !== at) return
    // Back from a stop, the backlog is handled first (the scan may still bind).
    if (holderLike(scan) && now() < resumeUntil) {
      // Waiting for the window's close is a holder timer too: if it fires late (the tab
      // froze inside the window), that is a return first, so the scan is not deleted
      // before the backlog of that return.
      const due = resumeUntil
      linkTimers.set(
        pk,
        later(due - now(), () => {
          noteLate(due)
          expireLink(pk, at)
        }),
      )
      return
    }
    delete mem.scans[pk]
    linkTimers.delete(pk)
    cancel(deadlineTimers.get(pk))
    deadlineTimers.delete(pk)
    void save('scans')
    if (holderLike(scan)) {
      // A holder scan ends silently: the screen never changed. Its candidate rooms are
      // settled: one is taken by its tag unless the channel is pinned.
      settleCandidates(pk, scan)
      if (scan.shaped) quietFail(pk)
      return
    }
    // A link room nothing else uses goes; a tombstone's room stays (the peer may have
    // moved there already), forget() keeps a room a record still uses.
    forget(scan.groupId)
    failLink(pk, 'timeout')
  }

  /**
   * A shaped link that did not complete while my scan was fresh (SCAN_TRUST_MS):
   * it never completes now, and the scan goes on as the holder scan it looked like on the
   * wire until its life ends, so the peer sees exactly what a holder sends.
   * The screen says so, without a support log line: a holder's scan leaves none either, and
   * the log must not tell a deleted contact from a living one (twin assertion 2).
   */
  function lapseShaped(pk: PubkeyHex, scan: ScanRec | undefined): void {
    if (!scan || mem.scans[pk] !== scan || !scan.shaped || scan.lapsed) return
    scan.lapsed = true
    void save('scans')
    quietFail(pk)
  }

  /** The visible flow about this peer ends in 'timeout', with no support log line (lapseShaped). */
  function quietFail(pk: PubkeyHex): void {
    const c = get().connect
    if (c.peerPubkey === pk && (c.phase === 'scanned' || c.phase === 'linking')) setConnect({ phase: 'failed', errorKey: 'timeout', waitingPeer: undefined })
  }

  /**
   * A scanned QR. After the checks of the code itself, the relation decides:
   * a contact ('already', a holder scan), nobody (a first link), or a tombstone (a link
   * from scratch over the channel of the tombstone). `via`: camera or paste,
   * kept on the contact only.
   */
  async function submitScan(text: string, via?: 'camera' | 'paste'): Promise<void> {
    if (!transport || !me || get().boot !== 'ready') {
      failConnect('network')
      return
    }
    const p = connect.decodePayload(text.trim())
    if (!p) return failConnect('invalid')
    // Before anything about who it is: the support log line must not depend on it.
    debug('link-start')
    const pk = p.pk
    if (pk === me) return failConnect('self')
    if (p.exp < now()) return failConnect('expired')
    const base = get().connect
    const rel = relationOf(pk)
    const inviter = me < pk
    const prev = mem.scans[pk]
    const how = via === 'camera' || via === 'paste' ? { via } : {}
    const scan: ScanRec =
      rel === 'contact' ? { pk, code: p.code, at: now(), inviter, kp: p.kp, holder: true } : { pk, code: p.code, at: now(), inviter, kp: p.kp, ...how }
    mem.scans[pk] = scan
    // A rescan starts over: the earlier scan's link room and candidate rooms
    // go, unless a record keeps them (forget() checks).
    cancel(deadlineTimers.get(pk))
    deadlineTimers.delete(pk)
    dropCandidates(pk)
    forget(prev?.groupId)
    void save('scans')
    armLinkTimeout(pk, scan.at)

    if (rel === 'contact') {
      // No link starts, my QR stays. Silently: my proof into our room,
      // the pairing with the peer's proof, and at the deadline a new room if I am L and
      // none was counted.
      set({ connect: { ...base, phase: 'already', peerPubkey: pk, errorKey: undefined, contactId: undefined, waitingPeer: undefined } })
      holderStart(scan, contactOf(pk)?.groupId ?? null)
      return
    }

    const tomb = rel === 'tomb' ? mem.tombstones[pk] : undefined
    if (tomb && !inviter && tomb.groupId && movedRecently(tomb, scan.at) && !roomUnusable(tomb.groupId)) {
      // Lacking H over a tombstone: the channel room was bound in the last 5 minutes (the
      // holder may have moved us there for this very scan); it is the link's room.
      scan.groupId = tomb.groupId
      scan.sentAt = tomb.roomSentAt
      scan.shaped = true
      void save('scans')
      // A holder's life, and the link's own 2 minutes on screen.
      armLinkTimeout(pk, scan.at)
    }
    set({
      connect: {
        ...base,
        phase: scan.groupId ? 'linking' : 'scanned',
        peerPubkey: pk,
        errorKey: undefined,
        contactId: undefined,
        waitingPeer: undefined,
      },
    })
    debug('scan', { peer: short(pk), inviter })
    if (scan.shaped && scan.groupId) {
      // A holder would do all of this now: so does the shaped link,
      // once the scan that allows it is stored. Its stored proof (5.4) is the
      // peer's proof that came before my scan (the peer scanned first).
      await save('scans')
      if (mem.scans[pk] !== scan || !scan.groupId) return
      const stored = storedProof(pk, scan.groupId)
      if (stored) {
        stored.used = true
        stored.usedBy = pk
        shapedCodes.add(stored.code)
        void save('codes')
        scan.replied = true
      }
      holderStart(scan, scan.groupId)
      return
    }

    if (inviter) {
      await enqueue(pk, () => (tomb ? relinkFlow(scan) : inviteFlow(scan)))
      return
    }
    // H: L makes the room. Ask for one if none came (REQUEST_AFTER_MS).
    armRequests(scan)
    if (!tomb) {
      // The peer may have scanned me first; its Welcome is then already waiting.
      const invite = dropBuffered(pk)
      if (invite) await enqueue(pk, () => acceptFlow(invite))
    }
  }

  /**
   * The channel's room was bound by a move (bindRoom, which records it in `moves`) within
   * HOLDER_PAIR_MS before `at`. A room completeLink made for a first link is not in
   * `moves`. A lacking H over a tombstone links in such a room.
   */
  function movedRecently(ch: ChannelFields, at: number): boolean {
    return ch.roomAt !== undefined && at - ch.roomAt <= holderPairMs && [...(ch.moves ?? []), ...(ch.answered ?? [])].includes(ch.roomAt)
  }

  /**
   * The REQUEST_AFTER_MS points of a lacking H's scan, counted from the stored scan time, so
   * a reload or a killed tab inside them arms what is left (resumeAfterBoot). Points that
   * passed while the app was away are made up for by one request now; requestForScan itself
   * checks that the scan still has no room.
   */
  function armRequests(scan: ScanRec): void {
    if (holderLike(scan) || scan.inviter || scan.replied || scan.groupId) return
    let missed = false
    for (const ms of REQUEST_AFTER_MS) {
      const wait = scan.at + ms - now()
      if (wait > 0) later(wait, () => void enqueue(scan.pk, () => requestForScan(scan)))
      else missed = true
    }
    if (missed) later(0, () => void enqueue(scan.pk, () => requestForScan(scan)))
  }

  /**
   * A lacking H asks L for the room of this link: a Welcome L never joins,
   * its group forgotten at once. Only while this scan is the peer's and has no room yet.
   */
  async function requestForScan(scan: ScanRec): Promise<void> {
    const t = transport
    if (!t || stopped || mem.scans[scan.pk] !== scan || holderLike(scan) || scan.groupId) return
    try {
      const { groupId } = await t.invitePeer(scan.pk)
      await t.forgetGroup(groupId).catch(() => debug('forget-failed'))
    } catch {
      debug('chan-fail')
    }
  }

  // ---------------------------------------------------------------- 3a. holder scans
  //
  // A holder scan (`holder`), and a shaped link that looks like one on the wire (`shaped`),
  // follow the same rules whether the peer is a contact or a tombstone.

  /** The pairing lookback in our room, my proof into it, the deadline. */
  function holderStart(scan: ScanRec, room: string | null): void {
    const pk = scan.pk
    // I scanned this peer, so a pending "channel reopened" line is not drawn.
    if (chanOf(pk)?.noticeAfter !== undefined) void setChan(pk, { noticeAfter: undefined })
    if (room) {
      holderLookback(scan, room)
      holderProof(scan, room)
    }
    armDeadline(scan)
    void save('scans')
  }

  /**
   * My proof hello { code: the peer's code } into this room, repeated on the hello
   * schedule until the peer echoed it (`acked`) or another room got my proof. It does not
   * stop for the peer's own proof: only the echo shows mine arrived.
   */
  function holderProof(scan: ScanRec, groupId: string): void {
    scan.provedIn = groupId
    delete scan.acked
    void save('scans')
    const proof = (i: number): void => {
      if (stopped || mem.scans[scan.pk] !== scan || scan.provedIn !== groupId || scan.acked) return
      void send(groupId, { t: 'hello', v: 1, code: scan.code }, { peer: scan.pk })
      if (i < HELLO_RESEND_MS.length) later(HELLO_RESEND_MS[i], () => proof(i + 1))
    }
    proof(0)
  }

  /** The newest moment `pk`'s proof (a hello with a code of mine) reached `room` at or after `since`. */
  function proofIn(pk: PubkeyHex, room: string, since: number): number | undefined {
    let best: number | undefined
    for (const c of mem.codes) {
      const u = c.holderUses?.[pk]
      if (u && u.in === room && u.at >= since && (best === undefined || u.at > best)) best = u.at
    }
    return best
  }

  /** A proof of the peer that reached `room` up to holderPairMs before my scan. */
  function holderLookback(scan: ScanRec, room: string): void {
    const at = proofIn(scan.pk, room, scan.at - holderPairMs)
    if (at !== undefined) countProof(scan, room, at)
  }

  /**
   * The peer's proof reached `room` at `at`. It counts when it came within the
   * pairing window, or in a room bound from this scan. Counting ends the deadline;
   * the channel is pinned (PIN_MS) when the room was bound from this scan, or by a move or a
   * tag in the last 7 days and the proof paired.
   */
  function countProof(scan: ScanRec, room: string, at: number): void {
    const inWindow = at - scan.at <= holderPairMs && scan.at - at <= holderPairMs
    if (!inWindow && scan.boundIn !== room) return
    if (scan.proofSeenAt === undefined || at > scan.proofSeenAt) scan.proofSeenAt = at
    cancel(deadlineTimers.get(scan.pk))
    deadlineTimers.delete(scan.pk)
    void save('scans')
    const ch = chanOf(scan.pk)
    if (!ch || ch.groupId !== room) return
    const fresh = ch.boundBy !== undefined && ch.roomAt !== undefined && now() - ch.roomAt <= PIN_MS
    if (scan.boundIn === room || (inWindow && fresh)) void setChan(scan.pk, { pinnedUntil: now() + PIN_MS })
  }

  /**
   * The deadline scan.at + holderPairMs. After a start it is judged once the
   * backlog had its chance (resumeUntil); later than a minute past it, never.
   */
  function armDeadline(scan: ScanRec): void {
    const pk = scan.pk
    cancel(deadlineTimers.get(pk))
    deadlineTimers.delete(pk)
    if (scan.fired || scan.proofSeenAt !== undefined) return
    const at = Math.max(scan.at + holderPairMs, judgeBy())
    const due = Math.max(at, now())
    deadlineTimers.set(
      pk,
      later(due - now(), () => {
        deadlineTimers.delete(pk)
        // Back from the background (a frozen or throttled tab fires this late, maybe before
        // the visibility event): the peer's proof may be waiting in the backlog, so the
        // deadline is judged once the backlog had its chance, as after a start.
        noteLate(due)
        if (now() < judgeBy()) {
          if (mem.scans[pk] === scan) armDeadline(scan)
          return
        }
        void enqueue(pk, () => holderDeadline(scan))
      }),
    )
  }

  /**
   * Until when a holder deadline waits for the backlog: the return window (resumeUntil).
   * Every reconnect gives the backlog its full grace, and noteReturn bounds the window at
   * backAt + RESUME_WINDOW_MAX_MS, so repeated reconnects (a flapping relay) cannot slide
   * the judgment (and the room a late return opens) further.
   */
  function judgeBy(): number {
    return resumeUntil
  }

  /**
   * A signal that the app is back (a start, a holder timer that fired late, back in view,
   * reconnected). The first one while no return window is open starts a return (backAt);
   * every one gives the backlog HOLDER_RESUME_GRACE_MS from now, but the window never
   * reaches past backAt + RESUME_WINDOW_MAX_MS. A signal at the very moment
   * a window closed at that bound does not reopen it, so its closing work below runs. A
   * later signal starts a new return; what the closed window let expire is gone by then,
   * and a peer's time older than its close no longer stands in for now (trustFrom).
   * When the window closes, the codes it kept are pruned (expireLink, armDeadline and
   * armNotice wait for resumeUntil on their own).
   */
  function noteReturn(fresh = false): void {
    const t = now()
    if (fresh || t > resumeUntil) {
      trustFrom = fresh ? 0 : resumeUntil
      backAt = t
    }
    const until = Math.min(backAt + RESUME_WINDOW_MAX_MS, Math.max(fresh ? 0 : resumeUntil, t + HOLDER_RESUME_GRACE_MS))
    if (until <= resumeUntil && !fresh) return
    resumeUntil = until
    cancel(returnTimer)
    // A close that fires late (the tab froze inside the window) is itself a return: it
    // opens a new window first, so the codes the backlog may still prove stay.
    const due = resumeUntil
    returnTimer = later(resumeUntil - t, () => {
      noteLate(due)
      pruneCodes()
    })
  }

  /**
   * A timer that should have fired at `due` fires only now: the tab was frozen or throttled.
   * The return gives the backlog HOLDER_RESUME_GRACE_MS, as rearmRounds does on the
   * visibility event, whichever comes first.
   */
  function noteLate(due: number): void {
    if (now() - due <= LATE_TIMER_MS) return
    // The first signal of a return marks it; later ones of the same return keep it.
    noteReturn()
  }

  /**
   * No proof of the peer was counted. `fired` first; then L makes a new room for
   * the key package of the peer's QR, tagged, without gap, time compare or limit (once per
   * scan); H does nothing (a request of H could be answered by a thief of L's key).
   */
  async function holderDeadline(scan: ScanRec): Promise<void> {
    const pk = scan.pk
    if (stopped || mem.scans[pk] !== scan || scan.fired || scan.proofSeenAt !== undefined) return
    scan.fired = true
    await save('scans')
    // Back more than a minute after the deadline: this scan no longer opens anything. The
    // minute runs to the moment the app came back when that was after the deadline (the
    // judgment itself waits for the backlog, resumeUntil); otherwise to now.
    const deadline = scan.at + holderPairMs
    const from = backAt > deadline ? Math.min(backAt, now()) : now()
    if (from - deadline > HOLDER_LATE_MS) return
    if (!scan.inviter) return
    await openScanRoom(scan)
  }

  /**
   * A room request of the peer while my holder scan lives and counted nothing: the
   * deadline comes now. Anything else is ignored (not put in `requested`).
   */
  async function answerRequest(scan: ScanRec): Promise<void> {
    const pk = scan.pk
    if (stopped || mem.scans[pk] !== scan || scan.fired || scan.proofSeenAt !== undefined) return
    scan.fired = true
    cancel(deadlineTimers.get(pk))
    deadlineTimers.delete(pk)
    await save('scans')
    if (scan.inviter) await openScanRoom(scan)
  }

  /**
   * L makes a room from this scan. Only the key package of the
   * peer's QR (kp) is invited, the room carries the tag of the peer's code, and neither the
   * gap, the time compare nor the limit applies. When the kp cannot be found it quietly
   * stops. bindRoom sends my proof into it.
   */
  async function openScanRoom(scan: ScanRec): Promise<void> {
    const t = transport
    const s = session
    const pk = scan.pk
    const ch = chanOf(pk)
    if (!t || !ch || !scan.kp) return
    const sec = Math.floor(now() / 1000)
    if (ch.roomSentAt === sec) {
      await pause((sec + 1) * 1000 - now())
      if (stopped || s !== session) return
    }
    // `moving` first, as openRoom: a stop from here on makes the channel steps open again.
    // This room comes from my scan, not from the peer's request: an answer under way ends
    // with it (answerEnd), and comes back if it fails.
    const mark = now()
    const before = chanOf(pk)
    const wasMoving = before?.moving
    const wasAnswer = before && answerOf(before) ? { answerFrom: before.answerFrom, tries: before.tries, triedAt: before.triedAt } : {}
    await setChan(pk, { ...(before ? answerEnd(before) : {}), moving: mark })
    if (stopped || s !== session) return
    let groupId: string
    try {
      groupId = (await t.invitePeer(pk, { keyPackageRef: scan.kp, tag: tagOf(scan.code) })).groupId
    } catch {
      debug('chan-fail')
      // Quietly given up: the channel is as it was before this attempt.
      if (!stopped && s === session && chanOf(pk)?.moving === mark) await setChan(pk, { moving: wasMoving, ...wasAnswer })
      return
    }
    if (stopped || s !== session || transport !== t) return
    if (relationOf(pk) === 'none') {
      void t.forgetGroup(groupId).catch(() => debug('forget-failed'))
      return
    }
    if (mem.scans[pk] === scan) {
      scan.boundIn = groupId
      void save('scans')
    }
    await bindRoom(pk, groupId, Math.floor(now() / 1000), true)
  }

  /** The tag of a code, the first 16 bytes of its SHA-256, hex. */
  function tagOf(code: string): string {
    return bytesToHex(sha256(utf8ToBytes(code)).slice(0, 16))
  }

  /** A tag made from one of my codes of at most holderCodeMs old at `at`. */
  function tagMatches(tag: string | null, at: number): boolean {
    return tag !== null && mem.codes.some((c) => at - c.createdAt <= holderCodeMs && tagOf(c.code) === tag)
  }

  /**
   * While the backlog after a start is handled, ages and "the scan lives" are
   * measured at the moment the Welcome or hello was made (never past now), not at now.
   * Only inside a return window (closed at most RESUME_WINDOW_MAX_MS after it began), and
   * never earlier than the close of the window before it (trustFrom).
   */
  function evTime(sec: number): number {
    const t = now()
    return t < resumeUntil ? Math.min(t, Math.max(sec * 1000, trustFrom)) : t
  }

  /** The holder scan (or shaped link) of `pk` that lives at `at`. */
  function liveHolder(pk: PubkeyHex, at = now()): ScanRec | undefined {
    const s = mem.scans[pk]
    return s && holderLike(s) && at - s.at <= holderScanTtlMs ? s : undefined
  }

  /** The candidate room `groupId` of the living holder scan of `pk`. */
  function candidateOf(pk: PubkeyHex, groupId: string): { groupId: string; sentAt: number } | undefined {
    const c = candidates.get(pk)
    return c && mem.scans[pk] === c.scan ? c.rooms.find((r) => r.groupId === groupId) : undefined
  }

  /** The candidate rooms of `pk` go (a rescan, a delete); a record that uses one keeps it. */
  function dropCandidates(pk: PubkeyHex): void {
    const c = candidates.get(pk)
    if (!c) return
    candidates.delete(pk)
    for (const r of c.rooms) forget(r.groupId)
  }

  /**
   * The end of a holder scan with candidate rooms left: a pinned channel
   * keeps its room and they go; otherwise the newest one is bound by its tag.
   */
  function settleCandidates(pk: PubkeyHex, scan: ScanRec): void {
    const c = candidates.get(pk)
    if (!c || c.scan !== scan) return
    candidates.delete(pk)
    const ch = chanOf(pk)
    const rooms = [...c.rooms].sort((x, y) => y.sentAt - x.sentAt)
    const keep = ch && (ch.pinnedUntil ?? 0) <= now() ? rooms.shift() : undefined
    if (keep) {
      // Still referenced by nothing: bindRoom takes it as the channel before forget runs.
      void enqueue(pk, async () => {
        if (chanOf(pk)) await bindRoom(pk, keep.groupId, keep.sentAt, false, { by: 'tag' })
        else forget(keep.groupId)
      })
    }
    for (const r of rooms) forget(r.groupId)
  }

  /**
   * A tagged move while my holder scan lives: joined (one join at a time) but
   * not bound. A proof of the peer in it binds it (bindCandidate).
   */
  async function joinCandidate(scan: ScanRec, invite: IncomingInvite): Promise<void> {
    const t = transport
    const s = session
    const from = invite.inviterPubkey
    if (!t || !chanOf(from)) return ignoreInvite(invite.id)
    let groupId: string
    try {
      groupId = (await joinLine(() => t.acceptInvite(invite.id))).groupId
    } catch {
      ignoreInvite(invite.id)
      debug('chan-fail')
      return
    }
    if (stopped || s !== session || transport !== t) return
    noteJoined(invite.id)
    if (relationOf(from) === 'none') {
      void t.forgetGroup(groupId).catch(() => debug('forget-failed'))
      return
    }
    if (mem.scans[from] !== scan) {
      // The scan ended meanwhile: settled as at its end, now.
      if ((chanOf(from)?.pinnedUntil ?? 0) > now()) void t.forgetGroup(groupId).catch(() => debug('forget-failed'))
      else await bindRoom(from, groupId, invite.sentAt, false, { by: 'tag' })
      return
    }
    const c = candidates.get(from)
    const entry = { groupId, sentAt: invite.sentAt }
    if (c && c.scan === scan) c.rooms.push(entry)
    else candidates.set(from, { scan, rooms: [entry] })
    // A proof of the peer already in it (handled before this join was recorded).
    if (proofIn(from, groupId, 0) !== undefined) await bindCandidate(scan, entry)
  }

  /**
   * A proof of the peer in a candidate room: that room is bound without the ordinary move checks
   * (older room, move limit, pin), moved into `moves`, pinned for 7 days; the other candidates go.
   */
  async function bindCandidate(scan: ScanRec, cand: { groupId: string; sentAt: number }): Promise<void> {
    const pk = scan.pk
    const c = candidates.get(pk)
    if (!c || c.scan !== scan) return
    candidates.delete(pk)
    scan.boundIn = cand.groupId
    void save('scans')
    await bindRoom(pk, cand.groupId, cand.sentAt, false)
    if (mem.scans[pk] === scan) countProof(scan, cand.groupId, now())
    for (const r of c.rooms) if (r !== cand) forget(r.groupId)
  }

  /**
   * A tagged move with no holder scan of mine (I did not scan, the peer did): bound
   * at once, without the ordinary move checks (older room, move limit, pin), `boundBy = 'tag'`, not pinned, recorded in
   * `answered` rather than `moves`. Tombstones alike.
   */
  async function acceptTagged(invite: IncomingInvite): Promise<void> {
    const t = transport
    const s = session
    const from = invite.inviterPubkey
    if (!t || !chanOf(from)) return ignoreInvite(invite.id)
    let groupId: string
    try {
      groupId = (await joinLine(() => t.acceptInvite(invite.id))).groupId
    } catch {
      ignoreInvite(invite.id)
      debug('chan-fail')
      return
    }
    if (stopped || s !== session || transport !== t) return
    noteJoined(invite.id)
    if (relationOf(from) === 'none') {
      void t.forgetGroup(groupId).catch(() => debug('forget-failed'))
      return
    }
    // Not my move: the peer scanned my QR and made this room,
    // at once over a tombstone of me (relinkFlow) or at its holder deadline while it keeps
    // me, so its time differs between those worlds by up to holderPairMs. Kept in `answered`
    // like an answer, out of the move limit that my reopening and the status line read.
    await bindRoom(from, groupId, invite.sentAt, false, { by: 'tag', answer: true })
  }

  /** The rumor id of a Welcome joined for a move: a repeat of it is marked read. */
  function noteJoined(id: string): void {
    mem.joinedInvites.push(id)
    if (mem.joinedInvites.length > JOINED_INVITES_MAX) mem.joinedInvites.splice(0, mem.joinedInvites.length - JOINED_INVITES_MAX)
    void save('joinedInvites')
  }

  /**
   * Invitee: repeat my reply in a replied link's group. If the inviter made the
   * contact, it answers with its confirmation. Limited by LINK_RESEND_MAX.
   */
  function askAgain(scan: ScanRec, groupId: string, code: string): void {
    if ((scan.resends ?? 0) >= LINK_RESEND_MAX) return
    scan.resends = (scan.resends ?? 0) + 1
    void save('scans')
    sendLater(scan.pk, groupId, () => (mem.scans[scan.pk] === scan ? { t: 'hello', v: 1, code } : null))
  }

  /** The inviter's invite, with one more try after 1.5 s (the key package may not be on the relays yet). */
  async function inviteOnce(t: Transport, pk: PubkeyHex, opts?: InviteOptions): Promise<string> {
    try {
      return (await t.invitePeer(pk, opts)).groupId
    } catch {
      // Not later(): it drops its callback once stopped, which would block this
      // contact's queue for good.
      debug('invite-retry', { peer: short(pk) })
      await new Promise<void>((r) => timerApi.set(r, 1500))
      return (await t.invitePeer(pk, opts)).groupId
    }
  }

  /** The room of a link I make from a scan: the QR's key package only, tagged (11). */
  function scanInvite(scan: ScanRec): InviteOptions {
    return { keyPackageRef: scan.kp, tag: tagOf(scan.code) }
  }

  /** A failed first step of a link: the scan goes, the screen says so. */
  function dropScan(scan: ScanRec, e: unknown): void {
    const pk = scan.pk
    debug('invite-failed', { peer: short(pk), error: e instanceof Error ? e.message : String(e) })
    if (mem.scans[pk] === scan) {
      delete mem.scans[pk]
      cancel(linkTimers.get(pk))
      linkTimers.delete(pk)
      void save('scans')
    }
    failLink(pk, 'network')
  }

  /**
   * L of a first link (relation none): a new room for the key package of the peer's QR
   * only, then hello { code: the peer's code }.
   */
  async function inviteFlow(scan: ScanRec): Promise<void> {
    const t = transport
    const pk = scan.pk
    if (!t || mem.scans[pk] !== scan || scan.groupId || relationOf(pk) !== 'none') return
    let groupId: string
    try {
      groupId = await inviteOnce(t, pk, scanInvite(scan))
    } catch (e) {
      dropScan(scan, e)
      return
    }
    if (mem.scans[pk] !== scan) {
      // Timed out or scanned again while the group was being created.
      forget(groupId)
      return
    }
    scan.groupId = groupId
    // My own clock right after inviting (roomSentAt of a room I made).
    scan.sentAt = Math.floor(now() / 1000)
    void save('scans')
    markLinking(pk)
    await send(groupId, { t: 'hello', v: 1, code: scan.code }, { peer: pk })
    resendHello(scan, groupId, 0)
  }

  /**
   * L over a tombstone: the channel moves to a room I make
   * now, like openRoom (the same second avoided, `moving` first) but without the gap and
   * the limit (a fresh scan), for the key package of the peer's QR only and tagged, so the
   * holder binds it by its tag. bindRoom makes it this link's room; then the
   * link hello.
   */
  async function relinkFlow(scan: ScanRec): Promise<void> {
    const t = transport
    const s = session
    const pk = scan.pk
    const tb = mem.tombstones[pk]
    if (!t || !tb || mem.scans[pk] !== scan || scan.groupId) return
    const sec = Math.floor(now() / 1000)
    if (tb.roomSentAt === sec) {
      await pause((sec + 1) * 1000 - now())
      if (stopped || s !== session) return
    }
    // `moving` first: a failure or a stop from here on leaves the channel
    // broken, so the channel steps make it again. A move of my scan, never an answer: an
    // answer under way on the tombstone ends here (answerEnd), so a failed relink is retried as my own reopen in both worlds.
    await setChan(pk, { ...answerEnd(mem.tombstones[pk] ?? tb), moving: now() })
    if (stopped || s !== session) return
    let groupId: string
    try {
      groupId = await inviteOnce(t, pk, scanInvite(scan))
    } catch (e) {
      dropScan(scan, e)
      void enqueue(pk, () => channelStep(pk))
      return
    }
    if (stopped || s !== session || transport !== t) return
    if (relationOf(pk) === 'none') {
      void t.forgetGroup(groupId).catch(() => debug('forget-failed'))
      return
    }
    await bindRoom(pk, groupId, Math.floor(now() / 1000), true)
    // bindRoom made it the link's room and repeats the hello from 6 s on.
    if (mem.scans[pk] === scan && scan.groupId === groupId) await send(groupId, { t: 'hello', v: 1, code: scan.code }, { peer: pk })
  }

  /**
   * The first hello can be published before the peer has joined. Repeating it is
   * harmless. It stops once the scan is gone or its room changed.
   */
  function resendHello(scan: ScanRec, groupId: string, i: number): void {
    if (i >= HELLO_RESEND_MS.length) return
    later(HELLO_RESEND_MS[i], () => {
      if (mem.scans[scan.pk] !== scan || scan.groupId !== groupId) return
      void send(groupId, { t: 'hello', v: 1, code: scan.code }, { peer: scan.pk })
      resendHello(scan, groupId, i + 1)
    })
  }

  /**
   * A Welcome addressed to me. `from` is the inviter the seal
   * signature proves. Whatever no rule takes is marked read at once; nothing
   * is ever sent back. Contacts and tombstones go through the same rules.
   */
  function onInvite(invite: IncomingInvite): void {
    if (stopped || handledInvites.has(invite.id)) return
    markHandled(invite.id)
    const from = invite.inviterPubkey
    debug('invite', { from: short(from) })
    // My own Welcome, and a repeat of a Welcome I already joined for a move (a reload before it was marked read).
    if (from === me || mem.joinedInvites.includes(invite.id)) {
      ignoreInvite(invite.id)
      return
    }
    const rel = relationOf(from)
    const nowS = Math.floor(now() / 1000)
    if (from > me) {
      // The higher key never makes a room; its Welcome is never joined. From a
      // contact or tombstone it asks me (the lower key) for a fresh room. Never dropped:
      // the gap and the limit only delay it.
      ignoreInvite(invite.id)
      if (rel === 'none' || invite.sentAt > nowS + FUTURE_SENT_S) return
      // The pin first: a pinned channel takes no request, and my screen says nothing of
      // it: the deleting side's re-scan over a
      // tombstone sends exactly such a request while a keeping side's holder scan sends none,
      // so a line made from a request alone would tell the deleted side. Only meeting and
      // scanning each other reconnects before the pin ends.
      const ch = chanOf(from)
      if ((ch?.pinnedUntil ?? 0) > now()) return
      // While my holder scan lives, a request brings the deadline forward once.
      const live = liveHolder(from, evTime(invite.sentAt))
      if (live) {
        if (live.proofSeenAt === undefined && !live.fired) void enqueue(from, () => answerRequest(live))
        return
      }
      // A request sent before the peer had my current room (delivered late) is stale: the peer
      // already has the room, so it neither drives a move nor waits for one
      // (staleRequest judges on the peer's own clock).
      if (ch && staleRequest(ch, invite.sentAt)) return
      requested.add(from)
      // My QR was on screen when the request was made (or lately), so this may be the peer's
      // scan of it: a room made for it is a channel changed by meeting, which gets no
      // "channel reopened" line. Judged on the request's own time too,
      // not only its arrival: a catch-up after my page froze hands it over late.
      if (now() - lastCodeAt <= CODE_RECENT_MS || codeShownNear(invite.sentAt)) requestedMet.add(from)
      void enqueue(from, () => channelStep(from))
      return
    }
    if (rel !== 'none') {
      // The lower key moved our channel to a new room (not from far in the future).
      if (invite.sentAt > nowS + FUTURE_SENT_S) {
        ignoreInvite(invite.id)
        return
      }
      void onMoveWelcome(invite)
      return
    }
    // A first link.
    const scan = mem.scans[from]
    // A replied scan already has its group; a new Welcome belongs to a new
    // attempt, which starts when I scan the peer again (see submitScan).
    if (scan && !holderLike(scan) && !scan.replied && now() - scan.at <= SCAN_TRUST_MS) {
      void enqueue(from, () => acceptFlow(invite))
      return
    }
    // Not scanned (yet). The peer may simply have scanned me first, so keep the Welcome
    // a while without joining anything, but only while I showed a code lately: nobody
    // can scan me otherwise. Lines without values.
    if (now() - lastCodeAt > CODE_RECENT_MS) {
      ignoreInvite(invite.id)
      debug('invite-unbuffered')
      return
    }
    const older = dropBuffered(from)
    if (older) ignoreInvite(older.id)
    if (buffered.size >= INVITE_BUFFER_MAX) {
      const first = buffered.keys().next().value as PubkeyHex
      const dropped = dropBuffered(first)
      if (dropped) ignoreInvite(dropped.id)
      debug('invite-buffer-full')
    }
    const timer = later(INVITE_BUFFER_MS, () => {
      if (buffered.get(from)?.invite.id !== invite.id) return
      buffered.delete(from)
      ignoreInvite(invite.id)
    })
    buffered.set(from, { invite, timer })
  }

  /**
   * A move Welcome: the tag is read before anything is joined (previewInvite,
   * the same one read as the transport's pre-join check). A tag of one of my codes from
   * the last holderCodeMs: a candidate while my holder scan lives (a), else bound at once
   * (b). Anything else: nothing while my holder scan lives (on a channel that has a room)
   * or the channel is pinned, else the ordinary moves (acceptMove), gathered for MOVE_BATCH_MS.
   */
  async function onMoveWelcome(invite: IncomingInvite): Promise<void> {
    const t = transport
    const from = invite.inviterPubkey
    const tag = t ? (await t.previewInvite(invite.id).catch(() => ({ tag: null }))).tag : null
    if (stopped || !t || transport !== t) return
    if (relationOf(from) === 'none') return ignoreInvite(invite.id)
    const at = evTime(invite.sentAt)
    const matched = tagMatches(tag, at)
    // A holder scan guards a room I hold. Without one (a contact restored from the list,
    // groupId null) there is nothing to take over and no room for a proof: the peer's
    // answer to my request is the ordinary way in, as without the scan (otherwise
    // the restored H that scanned its contact would ignore that answer and stay without a room).
    const live = chanOf(from)?.groupId ? liveHolder(from, at) : undefined
    if (live) {
      if (matched) void enqueue(from, () => joinCandidate(live, invite))
      else ignoreInvite(invite.id)
      return
    }
    if (matched) {
      void enqueue(from, () => acceptTagged(invite))
      return
    }
    if ((chanOf(from)?.pinnedUntil ?? 0) > now()) return ignoreInvite(invite.id)
    // Welcomes of one peer are gathered for MOVE_BATCH_MS; only the newest is joined.
    const waiting = pendingMoves.get(from)
    if (waiting) {
      if (invite.sentAt > waiting.invite.sentAt) {
        ignoreInvite(waiting.invite.id)
        waiting.invite = invite
      } else ignoreInvite(invite.id)
      return
    }
    const entry = { invite }
    pendingMoves.set(from, entry)
    later(MOVE_BATCH_MS, () => {
      void enqueue(from, async () => {
        if (pendingMoves.get(from) !== entry) return
        pendingMoves.delete(from)
        await acceptMove(entry.invite)
      })
    })
  }

  async function acceptFlow(invite: IncomingInvite): Promise<void> {
    const t = transport
    const from = invite.inviterPubkey
    const scan = mem.scans[from]
    if (!t || !scan || holderLike(scan) || scan.inviter || scan.replied || relationOf(from) !== 'none' || now() - scan.at > SCAN_TRUST_MS) {
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
      forget(groupId)
      return
    }
    // A second Welcome means the inviter started over; the earlier group is dead.
    const earlier = scan.groupId
    scan.groupId = groupId
    // Never past my clock: this becomes the contact's roomSentAt.
    scan.sentAt = Math.min(invite.sentAt, Math.floor(now() / 1000))
    forget(earlier)
    void save('scans')
    markLinking(from)
  }

  /**
   * A stored proof: the peer's hello with a code of mine that reached `room`
   * before my scan gave it a link room, and so went through B (holderUses). As a proof of
   * a link (A) it counts with the A age of CODE_REDEEM_MS, unused or used by this peer.
   */
  function storedProof(pk: PubkeyHex, room: string): CodeRec | undefined {
    return mem.codes.find(
      (c) => c.holderUses?.[pk]?.in === room && now() - c.createdAt <= CODE_REDEEM_MS && (!c.used || c.usedBy === pk),
    )
  }

  /** Invitee: the inviter proved my code; I reply with its code and wait for the confirmation. */
  async function inviteeReply(scan: ScanRec, groupId: string, rec: CodeRec, from: PubkeyHex): Promise<void> {
    rec.used = true
    rec.usedBy = from
    void save('codes')
    // The link gets a fresh deadline so the confirmation has as long as the inviter had.
    scan.replied = true
    scan.at = now()
    // A new replied link: its own budget of re-sends.
    scan.resends = 0
    void save('scans')
    armLinkTimeout(from, scan.at)
    await send(groupId, { t: 'hello', v: 1, code: scan.code }, { peer: from })
    resendHello(scan, groupId, 0)
  }

  /**
   * Hellos of one link, in order:
   *   inviter -> invitee   { code: invitee's code }   (repeated until answered)
   *   invitee -> inviter   { code: inviter's code }   reply; invitee is not a contact yet
   *   inviter -> invitee   { code: inviter's code }   confirm; the inviter made the contact
   * The invitee also takes any later message from the inviter in that group as
   * the confirmation. So a contact never exists on one side only because the
   * other side rejected or timed out.
   * Between holders: my proof { code: the peer's code } and the peer's echo of it,
   * the peer's proof { code: mine } and my echo of it.
   */
  async function onHello(m: IncomingMessage, msg: Wire<'hello'>): Promise<void> {
    const from = m.senderPubkey
    if (typeof msg.code !== 'string') return
    const rec = mem.codes.find((c) => c.code === msg.code)
    // A proof of my code: young at receipt, and unused or used by this very
    // peer (an earlier attempt of the same link: the peer saw my QR within 2 minutes all the same).
    const fresh = rec !== undefined && (!rec.used || rec.usedBy === from) && now() - rec.createdAt <= CODE_REDEEM_MS

    const scan = mem.scans[from]

    // A: the room of my link in progress with this peer (a lacking scan; a
    // tombstone's link room is also its channel room). Before B. A shaped link that gave
    // up goes on as a holder (B).
    if (scan && !scan.holder && scan.groupId === m.groupId && !scan.lapsed) {
      if (scan.shaped) return shapedHello(m, msg, scan, rec, fresh)
      if (!scan.inviter && scan.replied) {
        // The inviter's confirmation echoes its own code, which I sent it.
        if (msg.code === scan.code) {
          completeLink(from, m.groupId)
          return
        }
        // A repeat of the inviter's first hello: my reply has not reached it yet.
        if (rec?.usedBy === from) await send(m.groupId, { t: 'hello', v: 1, code: scan.code }, { peer: from })
        return
      }

      // A proof of my code, aged at receipt (5.4: unused, or used by this peer in an earlier
      // attempt). Another peer's use of the code is never a proof. Repeats of an exchange I
      // already verified are answered from the stored state (usedBy, confirms, replied).
      if (!rec || !fresh) {
        debug('hello-rejected', { from: short(from) })
        return
      }

      if (scan.inviter) {
        rec.used = true
        rec.usedBy = from
        void save('codes')
        completeLink(from, m.groupId)
        // Kept until the invitee shows it is a contact, so a reload cannot lose it.
        mem.confirms[from] = { groupId: m.groupId, code: msg.code, at: now() }
        await save('confirms')
        echoes.delete(msg.code)
        await send(m.groupId, { t: 'hello', v: 1, code: msg.code }, { peer: from })
        return
      }

      // Invitee: reply, and wait for the inviter's confirmation.
      await inviteeReply(scan, m.groupId, rec, from)
      return
    }
    await holderHello(m, msg, rec)
  }

  /**
   * A hello in the channel room of a contact or of a tombstone, alike,
   * or a candidate room of my holder scan. My own proof echoed back in the
   * room it went to is the ack. A hello with a code of mine up to holderCodeMs old (or
   * the repeat of an exchange I confirmed) is echoed; a code of mine is the peer's proof:
   * kept per sender (holderUses), counted by a living holder scan, and in a candidate room
   * it binds that room. `used` is not looked at here.
   */
  async function holderHello(m: IncomingMessage, msg: Wire<'hello'>, rec: CodeRec | undefined): Promise<void> {
    const from = m.senderPubkey
    const at = evTime(m.at)
    const live = liveHolder(from, at)
    const cand = live ? candidateOf(from, m.groupId) : undefined
    if (chanOf(from)?.groupId !== m.groupId && !cand) return
    if (live && msg.code === live.code && m.groupId === live.provedIn) {
      if (!live.acked) {
        live.acked = true
        void save('scans')
      }
      return
    }
    const pending = mem.confirms[from]
    const mine = rec !== undefined && at - rec.createdAt <= holderCodeMs
    const repeat = rec?.usedBy === from || (pending?.groupId === m.groupId && pending.code === msg.code)
    // A holder proof. The repeat of a link reply with a code this peer redeemed is
    // no proof: it is echoed (an invitee waiting for my confirmation) but not counted, or a
    // rescan right after a link would pair with it while the peer is starting over.
    // A code a shaped link redeemed from this peer's holder proof stays a holder proof.
    const proof = mine && (rec.usedBy !== from || shapedCodes.has(rec.code))
    if (proof) {
      rec.holderUses = { ...rec.holderUses, [from]: { in: m.groupId, at: now() } }
      void save('codes')
    }
    if ((mine || repeat) && mayEcho(msg.code)) await send(m.groupId, { t: 'hello', v: 1, code: msg.code }, { peer: from })
    if (!proof || !live || mem.scans[from] !== live) return
    if (cand) await bindCandidate(live, cand)
    else countProof(live, m.groupId, at)
  }

  /**
   * A hello in the room of a shaped link (ScanRec.shaped). On the wire
   * exactly what a holder sends there: the ack of my proof, and for a hello with a code of
   * mine the holder's echo, with the holder's pairing and pin. The link itself
   * needs two facts: the peer's proof of my code (2 minutes, unused or used by this peer)
   * and my scan; the peer's echo of my proof shows it is in the room
   * and took my proof. With both, completeLink.
   */
  async function shapedHello(m: IncomingMessage, msg: Wire<'hello'>, scan: ScanRec, rec: CodeRec | undefined, fresh: boolean): Promise<void> {
    const from = m.senderPubkey
    if (fresh && rec && !scan.replied && msg.code !== scan.code) {
      rec.used = true
      rec.usedBy = from
      // Still the peer's holder proof: holderHello keeps and counts it, and its repeats, as
      // a holder would, or the holder world pins where this one would not.
      shapedCodes.add(rec.code)
      void save('codes')
      scan.replied = true
      void save('scans')
    }
    // A hello with a code that is not mine leaves no trace here, as at a holder:
    // even a debug event would tell a deleted contact from a living one.
    await holderHello(m, msg, rec)
    if (mem.scans[from] === scan && scan.replied && scan.acked && !scan.lapsed) completeLink(from, m.groupId)
  }

  /** Invitee: any non-hello message from the inviter in our group means it made the contact. */
  function promoteOnTraffic(m: IncomingMessage): void {
    const scan = mem.scans[m.senderPubkey]
    if (!scan || holderLike(scan) || scan.inviter || !scan.replied || scan.groupId !== m.groupId || contactOf(m.senderPubkey)) return
    completeLink(m.senderPubkey, m.groupId)
  }

  /**
   * The only place a contact is made: a link proved by both scans, for a
   * pubkey that is no contact (none, or a tombstone). The contact is stored first, then
   * the tombstone goes; a stop in between leaves both and load() keeps the newer record.
   */
  function completeLink(pk: PubkeyHex, groupId: string): void {
    if (contactOf(pk)) return
    lineSince.delete(pk)
    const scan = mem.scans[pk]
    const tomb = mem.tombstones[pk]
    // The tombstone's pin, how its room was bound and a pending notice stay with that room.
    const same = tomb?.groupId === groupId
    const theirs = earliest(peerSaw.get(groupId), same ? tomb.peerSentAt : undefined)
    const contact: Contact = {
      id: pk,
      pubkey: pk,
      name: '',
      createdAt: now(),
      groupId,
      // Never past my clock, whatever the Welcome said (acceptFlow keeps it raw).
      ...(scan?.groupId === groupId && scan.sentAt !== undefined ? { roomSentAt: Math.min(scan.sentAt, Math.floor(now() / 1000)) } : {}),
      roomAt: tomb?.roomAt ?? now(),
      moves: tomb?.moves ?? [],
      ...(tomb?.answered?.length ? { answered: tomb.answered } : {}),
      // An unfinished move stays until a bind clears it An answer
      // under way does not: the relink ends it with its `moving` (answerEnd), and the new contact starts with no attempts either way.
      ...(tomb?.moving !== undefined && !answerOf(tomb) ? { moving: tomb.moving } : {}),
      ...(tomb?.pinnedUntil !== undefined ? { pinnedUntil: tomb.pinnedUntil } : {}),
      ...(same && tomb.boundBy !== undefined ? { boundBy: tomb.boundBy } : {}),
      ...(same && tomb.noticeAfter !== undefined ? { noticeAfter: tomb.noticeAfter } : {}),
      // The peer's first message in this room on its clock (its link hello): the
      // earlier of this session's and the tombstone's.
      ...(theirs !== undefined ? { peerSentAt: theirs } : {}),
      // How the code came in: kept, never shown, never in the contact list event.
      ...(scan?.via ? { via: scan.via } : {}),
    }
    set({ contacts: [...get().contacts, contact] })
    void save('contacts')
    if (tomb) {
      delete mem.tombstones[pk]
      void save('tombstones')
    }
    if (scan?.shaped) {
      // A shaped link goes on as the holder scan it looked like: the
      // same object, so its proofs, its pairing and its deadline go on, and the holder's
      // life from the scan.
      scan.holder = true
      for (const k of ['shaped', 'replied', 'resends', 'bypassUsed', 'sentAt', 'groupId', 'via', 'lapsed'] as const) delete scan[k]
    } else {
      cancel(linkTimers.get(pk))
      linkTimers.delete(pk)
      delete mem.scans[pk]
    }
    void save('scans')
    // The link completed in one room; the tombstone's and the other attempts' rooms go.
    forget(tomb?.groupId)
    if (!scan?.holder) forget(scan?.groupId)
    const c = get().connect
    if (c.peerPubkey === pk && c.phase !== 'idle') {
      setConnect({ phase: 'done', contactId: pk, errorKey: undefined, waitingPeer: undefined })
    }
    debug('contact', { peer: short(pk) })
    // A new contact (or a deleted one linked again) changes my list.
    listChanged()
    const offer = get().myOffer
    if (offer) startRound(pk, offer.id, false)
  }

  // ---------------------------------------------------------------- 3b. channels
  //
  // Every rule here reads only the channel fields, the pubkey order and the clock, never
  // whether the peer is a contact or a tombstone: a deleted contact's channel is reopened,
  // moved and limited exactly like a living one's, so the peer cannot tell.

  /** L's Welcomes of a peer, gathered for MOVE_BATCH_MS before the newest is looked at. */
  const pendingMoves = new Map<PubkeyHex, { invite: IncomingInvite }>()
  /** I am L; the peer asked for a fresh room that I have not made yet. Memory only: H asks again. */
  const requested = new Set<PubkeyHex>()
  /**
   * L: a room of mine under way in answer to the peer's request (openRoom), until a
   * room is bound: the channel field `answerFrom`, stored with `moving`.
   * The value is my run of attempts (`tries`, `triedAt`) from before the answer: the answer's
   * own attempts are not my facts, so once my room fails while the answer waits, my retries
   * and my status line go on from these as if the peer had never asked.
   * Stored, not memory only: a restart that dropped it made a failed answer my own move
   * (my move limit, `moves`, my run of attempts), which a world without the request never
   * makes. Read with a default: anything but an object is no answer under way.
   */
  function answerOf(ch: ChannelFields | undefined): { tries?: number; triedAt?: number } | undefined {
    const a = ch?.answerFrom
    if (!a || typeof a !== 'object' || ch?.moving === undefined) return undefined
    const num = (x: unknown) => (typeof x === 'number' && Number.isFinite(x) ? x : undefined)
    return { tries: num(a.tries), triedAt: num(a.triedAt) }
  }
  /**
   * The attempts in a row that count as mine (retryAt, the status line's scan hint): while an
   * answer is under way, the run from before it (answerOf).
   */
  function ownTries(ch: ChannelFields): ChannelFields {
    const base = answerOf(ch)
    return base ? { ...ch, tries: base.tries, triedAt: base.triedAt } : ch
  }
  /**
   * The channel patch that ends an answer under way:
   * its `moving` and `answerFrom` go and my run of attempts from before it
   * comes back, so the channel is the one of a world where the peer never asked. For a
   * deletion (removeContact), a relink (relinkFlow) and a room of my scan (openScanRoom):
   * none of these is an answer, and the move that follows is mine. Nothing when no answer
   * is under way (a stray `answerFrom` without `moving` goes too).
   */
  function answerEnd(ch: ChannelFields): Partial<ChannelFields> {
    const base = answerOf(ch)
    if (!base) return ch.answerFrom !== undefined ? { answerFrom: undefined } : {}
    return { moving: undefined, answerFrom: undefined, tries: base.tries, triedAt: base.triedAt }
  }
  /**
   * I am L; a request of `requested` came while my QR was on screen lately (CODE_RECENT_MS):
   * the room made for it gets no "channel reopened" line. Memory only.
   */
  const requestedMet = new Set<PubkeyHex>()
  /**
   * Room id → the earliest rumor time (the sender's clock) of a message another member sent
   * in it this session. Memory only: a room bound or linked later (a candidate, a link
   * room) takes its value as peerSentAt (bindRoom, completeLink).
   */
  const peerSaw = new Map<string, number>()
  /** One timer per peer for its next channel step. */
  const chanTimers = new Map<PubkeyHex, number>()
  /** Rooms I made, still `pending`, in which the peer was heard. */
  const seenIn = new Set<string>()
  /** The ensureChannels gathering groupHealth changes, and the periodic one. */
  let healthTimer: number | undefined

  type ChannelPlan = { kind: 'none' } | { kind: 'confirm' } | { kind: 'open' | 'request'; at: number }

  /** The next channel work for one peer. Pure: reads state, changes nothing. */
  function channelPlan(pk: PubkeyHex, t: number): ChannelPlan {
    const ch = chanOf(pk)
    if (!ch || !transport || get().boot !== 'ready') return { kind: 'none' }
    const roomAt = ch.roomAt ?? t
    const win = windowOpenAt(pk, ch, t)
    if (me > pk) {
      // H: a room only comes from L; ask for one.
      if (channelBroken(ch)) return { kind: 'request', at: Math.max(retryAt(ch, t), win) }
      return { kind: 'none' }
    }
    if (channelBroken(ch)) {
      const gap = ch.roomAt === undefined ? t : roomAt + CHANNEL_MIN_GAP_MS
      // An answer to the peer's request that failed (openRoom left `moving`) is tried again
      // as an answer while my room still works, so its own limit gates it, not my moves:
      // with my two moves used it would else wait up to a day while bindRoom
      // would count it in `answered`. Once my own room cannot carry messages the reopen is
      // mine, gated and counted as in a world where the peer never asked.
      if (answerOf(ch) && !roomUnusable(ch.groupId)) return { kind: 'open', at: Math.max(retryAt(ch, t), gap, answerOpenAt(pk, ch, t)) }
      return { kind: 'open', at: Math.max(retryAt(ownTries(ch), t), gap, win) }
    }
    if (ch.pending && ch.groupId && (transport.peerJoined(ch.groupId) || seenIn.has(ch.groupId))) return { kind: 'confirm' }
    if (ch.pending) {
      const wait = (ch.tries ?? 0) <= 1 ? PENDING_FIRST_MS : PENDING_NEXT_MS
      return { kind: 'open', at: Math.max(roomAt + wait, win) }
    }
    if (requested.has(pk)) return { kind: 'open', at: Math.max(roomAt + CHANNEL_MIN_GAP_MS, answerOpenAt(pk, ch, t)) }
    return { kind: 'none' }
  }

  /**
   * Why a contact's room cannot carry messages now and when that ends, for the room's
   * status. Read-only: no rule of the channel
   * changes. Undefined when the room works or the peer is not a contact (a tombstone has
   * no room on screen). The move limit and the pin stay.
   *
   * Only my own facts decide: my room cannot
   * carry messages, my attempts in a row, my move limit, my newest text that failed. Never
   * a request or a move of the peer alone: the deleting side's re-scan over a tombstone
   * sends a request a keeping side's holder scan does not, so such a line would tell the
   * deleted side it was deleted.
   */
  function reopenOf(pk: PubkeyHex, t: number, cur: ReopenWait | undefined): ReopenWait | undefined {
    const ch = contactOf(pk)
    if (!ch || !transport || get().boot !== 'ready') return undefined
    const since = cur?.since ?? t
    // My room cannot carry messages, or (H) I wait to join the peer's new room. L's own move
    // under way does not count while my room still works: it may be the answer to a request.
    if (roomUnusable(ch.groupId) || (me > pk && ch.moving !== undefined)) {
      const win = windowOpenAt(pk, ch, t)
      return {
        since,
        ...(win > t ? { at: win } : {}),
        ...((ownTries(ch).tries ?? 0) >= REOPEN_SCAN_TRIES ? { scan: true } : {}),
      }
    }
    // The room looks fine to me but my newest text, written in it, failed:
    // say it is reconnecting rather than leave failures with no reason.
    if (lastTextFailed(pk, lineSince.get(pk) ?? ch.roomAt ?? 0, ch.groupId)) return { since }
    return undefined
  }

  /**
   * Message ids of my texts that failed in this session → when (my clock). A text read back
   * as 'failed' by load() (it was 'sending' at the last stop, or failed before it) is not
   * here: a restart alone says nothing of the room now.
   */
  const textFailedAt = new Map<string, number>()
  /** Room → the last time (my clock) it carried a message: the peer's came in, or a relay took one of my records. */
  const roomWorked = new Map<string, number>()
  /**
   * Contact → the `since` of lastTextFailed while its room was bound by an answer (bindRoom
   * `how.answer`: a room made for the peer's request, or joined from its scan of my QR):
   * the bind before it. Such a bind comes from the peer's scan, at once when it deleted me
   * and later or never when it kept me, so it must not end the line.
   * Not kept when I scanned the peer myself (a meeting, my own fact). Memory
   * only, like textFailedAt; any other bind removes it.
   */
  const lineSince = new Map<PubkeyHex, number>()

  /**
   * The peer's message came in through a room: if it is the channel's, the room works. A
   * hello does not count: it is scan traffic, sent into my room by a peer that kept me
   * (its holder proof) where one that deleted me sends none.
   */
  function noteRoomWorked(pk: PubkeyHex, groupId: string, t: WireMessage['t']): void {
    if (t === 'hello' || chanOf(pk)?.groupId !== groupId) return
    roomWorked.set(groupId, now())
    if (get().reopening[pk]) noteReopen(pk)
  }

  /**
   * My newest text to this contact failed in this session (every retry; a resend sets it
   * back to 'sending'), was written at or after `since` (my current room's bind: one that
   * failed while an earlier room was broken says nothing of this one), and nothing came
   * through the room since it failed: neither a message of the peer nor one of mine that a
   * relay took (one relay hiccup while the peer keeps talking is not a broken room).
   */
  function lastTextFailed(pk: PubkeyHex, since: number, groupId: string | null): boolean {
    const list = get().rooms[pk] ?? []
    for (let i = list.length - 1; i >= 0; i--) {
      const m = list[i]
      if (!m.mine || m.kind !== 'text') continue
      if (m.status !== 'failed' || m.at < since) return false
      const failed = textFailedAt.get(m.id)
      if (failed === undefined) return false
      return !groupId || (roomWorked.get(groupId) ?? Number.NEGATIVE_INFINITY) < failed
    }
    return false
  }

  /** The earlier of two optional times (undefined when both are). */
  function earliest(a: number | undefined, b: number | undefined): number | undefined {
    return a === undefined ? b : b === undefined ? a : Math.min(a, b)
  }

  /**
   * A room request of the peer was sent before the peer had my current room
   * (clock skew): a late one, not a sign the peer lost the room. The request's time is on
   * the peer's clock, so it is compared with the peer's FIRST message in this room, on the
   * same clock: the peer sent it only once it had the room, so every stale request is dated
   * before it, and the peer asks again only after losing the room, so every genuine one
   * after it. The first message, not the newest: a request of a peer restored with a clock
   * behind its old device's is still dated after it unless the clocks differ by more than
   * the time since that first message (the gap that remains, 4.9). My room time (roomSentAt,
   * my clock) is used only while the peer has not spoken in the room, and then only a
   * request older than the room by more than two clocks may differ (FUTURE_SENT_S) is
   * stale. Nothing new is sent.
   */
  function staleRequest(ch: ChannelFields, sentAt: number): boolean {
    if (!ch.groupId) return false
    const first = earliest(ch.peerSentAt, peerSaw.get(ch.groupId))
    if (first !== undefined) return sentAt <= first
    return sentAt + FUTURE_SENT_S <= (ch.roomSentAt ?? 0)
  }

  /**
   * The peer spoke in a room (any message, before it is handled): remembered for
   * staleRequest. Stored on the channel when it is the channel's room and nothing earlier
   * is stored: one write per room (a later message never moves it; one delivered out of
   * order with an earlier time does). A time past my clock plus FUTURE_SENT_S is not taken.
   */
  function notePeerSpoke(m: IncomingMessage): void {
    if (m.at > Math.floor(now() / 1000) + FUTURE_SENT_S) return
    if ((peerSaw.get(m.groupId) ?? Infinity) > m.at) peerSaw.set(m.groupId, m.at)
    const ch = chanOf(m.senderPubkey)
    if (stopped || !ch || ch.groupId !== m.groupId) return
    if (ch.peerSentAt === undefined || m.at < ch.peerSentAt) void setChan(m.senderPubkey, { peerSentAt: m.at })
  }

  /** Puts this contact's reconnect status in the state when it changed (reopenOf). */
  function noteReopen(pk: PubkeyHex): void {
    const cur = get().reopening[pk]
    const next = reopenOf(pk, now(), cur)
    if (cur === next || (cur && next && cur.since === next.since && cur.at === next.at && cur.scan === next.scan)) return
    const reopening = { ...get().reopening }
    if (next) reopening[pk] = next
    else delete reopening[pk]
    set({ reopening })
  }

  /** The one timer of this peer's channel, set to `at`. */
  function armChannel(pk: PubkeyHex, at: number): void {
    cancel(chanTimers.get(pk))
    chanTimers.set(
      pk,
      later(Math.max(0, at - now()), () => {
        chanTimers.delete(pk)
        void enqueue(pk, () => channelStep(pk))
      }),
    )
  }

  /** Waits on the engine's timers (virtual time in checks), not later(): the queue must go on after a stop. */
  function pause(ms: number): Promise<void> {
    return new Promise<void>((r) => timerApi.set(r, Math.max(0, ms)))
  }

  /**
   * Runs the plan of one peer. Always inside enqueue(pk), so it never
   * overlaps a link, a join or the boot cleanup of the same peer, and it judges by the
   * state at that moment. At most one open or request per call; then the next timer.
   */
  async function channelStep(pk: PubkeyHex): Promise<void> {
    try {
      await channelStepRun(pk)
    } finally {
      if (!stopped) noteReopen(pk)
    }
  }

  async function channelStepRun(pk: PubkeyHex): Promise<void> {
    const s = session
    let acted = false
    for (let i = 0; i < 4; i++) {
      if (stopped || s !== session) return
      const t = now()
      const plan = channelPlan(pk, t)
      if (plan.kind === 'none') {
        cancel(chanTimers.get(pk))
        chanTimers.delete(pk)
        return
      }
      if (plan.kind === 'confirm') {
        // The peer came into the room I made: the channel works.
        await setChan(pk, { pending: undefined, tries: undefined, triedAt: undefined })
        continue
      }
      if (plan.at > t) return armChannel(pk, plan.at)
      // An attempt always moves its own timer on (tries, roomAt); this only guards a loop.
      if (acted) return armChannel(pk, t + CHANNEL_MIN_GAP_MS)
      acted = true
      if (plan.kind === 'open') await openRoom(pk)
      else await requestRoom(pk)
    }
  }

  /** L makes a new room for the peer. The newest key package of the peer is invited. */
  async function openRoom(pk: PubkeyHex): Promise<void> {
    const t = transport
    const s = session
    const ch = chanOf(pk)
    if (!t || !ch) return
    // The new room's second must be later than the current room's.
    const sec = Math.floor(now() / 1000)
    if (ch.roomSentAt === sec) {
      await pause((sec + 1) * 1000 - now())
      if (stopped || s !== session) return
    }
    const cur = chanOf(pk)
    if (!cur) return
    // In answer to the peer's request while my room works: kept apart from my move
    // limit (`answered`). An answer that failed and is tried again stays one while my room
    // works; once it does not, this is my own reopen: a move, and my run of attempts from
    // before the answer goes on (answerFrom). Stored with `moving` in one write,
    // so a stop or a restart from here on finds the same answer or the same own reopen.
    const base = answerOf(cur)
    const answer = (base !== undefined && !roomUnusable(cur.groupId)) || (requested.has(pk) && !channelBroken(cur) && !cur.pending)
    const prior = base && !answer ? base : cur
    const answerFrom = answer ? (base ?? { tries: cur.tries, triedAt: cur.triedAt }) : undefined
    // `moving` first: a failure or a stop from here on leaves the channel broken, so it is made again.
    await setChan(pk, { moving: now(), tries: (prior.tries ?? 0) + 1, triedAt: now(), answerFrom })
    // A room made because the peer asked for it gets the "channel reopened" line, unless the
    // request came while my QR was on screen (a channel changed by meeting).
    const answering = requested.has(pk) && !requestedMet.has(pk)
    requested.delete(pk)
    requestedMet.delete(pk)
    if (stopped || s !== session) return
    // The relink of a deleter (tomb/L) that a stop cut off before its room was bound: the
    // room is still made from that scan (the QR's key package, the tag), so the
    // holder takes it by its tag as it would have the first one.
    const scan = mem.scans[pk]
    const viaScan =
      scan && !holderLike(scan) && scan.inviter && !scan.groupId && scan.kp && relationOf(pk) === 'tomb' && now() - scan.at <= SCAN_TRUST_MS
        ? scan
        : undefined
    const opts = viaScan ? scanInvite(viaScan) : undefined
    let groupId: string
    try {
      try {
        groupId = (await t.invitePeer(pk, opts)).groupId
      } catch {
        // The peer's key package may not have reached the relays yet: one more try.
        await pause(1500)
        if (stopped || s !== session) return
        groupId = (await t.invitePeer(pk, opts)).groupId
      }
    } catch {
      // No value: an event per peer must not tell the support log who.
      debug('chan-fail')
      return
    }
    // Stopped meanwhile: the room stays unbound and the boot cleanup removes it.
    if (stopped || s !== session || transport !== t) return
    if (relationOf(pk) === 'none') {
      void t.forgetGroup(groupId).catch(() => debug('forget-failed'))
      return
    }
    // Opened without a scan, unless from the deleter's scan above.
    await bindRoom(pk, groupId, Math.floor(now() / 1000), true, viaScan ? {} : { by: 'remote', notice: answering, answer })
  }

  /**
   * H asks L for a fresh room: a Welcome L never joins. The group it makes
   * is bound to nothing and goes at once; one left by a stop goes at the boot cleanup.
   */
  async function requestRoom(pk: PubkeyHex): Promise<void> {
    const t = transport
    const s = session
    const ch = chanOf(pk)
    if (!t || !ch) return
    await setChan(pk, { tries: (ch.tries ?? 0) + 1, triedAt: now() })
    if (stopped || s !== session) return
    try {
      const { groupId } = await t.invitePeer(pk)
      await t.forgetGroup(groupId).catch(() => debug('forget-failed'))
    } catch {
      debug('chan-fail')
    }
  }

  /**
   * The only place the room of an existing contact or tombstone changes.
   * Makes no contact. `mine`: I (L) made the room, so it is pending until the peer is
   * seen in it. The chat and the name stay; matching starts over in the new room.
   * `how.by`: a room bound without a scan, 'remote' (an ordinary move, or a reopen of mine)
   * or 'tag'; none for a room bound from a scan. `how.notice`: the
   * "channel reopened" line is decided holderPairMs later.
   */
  async function bindRoom(
    pk: PubkeyHex,
    groupId: string,
    sentAt: number,
    mine: boolean,
    how: { by?: 'remote' | 'tag'; notice?: boolean; answer?: boolean } = {},
  ): Promise<void> {
    const ch = chanOf(pk)
    if (!ch) {
      void transport?.forgetGroup(groupId).catch(() => debug('forget-failed'))
      return
    }
    if (ch.groupId === groupId) {
      if (ch.moving !== undefined || ch.answerFrom !== undefined) await setChan(pk, { moving: undefined, answerFrom: undefined })
      return
    }
    const t = now()
    const old = ch.groupId
    // The failed-text line keeps its boundary over an answer bind (lineSince), unless I
    // scanned the peer myself: then the new room comes from our meeting, my own fact.
    if (how.answer && !mem.scans[pk]) {
      if (!lineSince.has(pk)) lineSince.set(pk, ch.roomAt ?? 0)
    } else lineSince.delete(pk)
    // A room made in answer to the peer's request, or joined from the peer's scan of my QR
    // (acceptTagged), goes to `answered`, not the move limit.
    const recent = (xs: number[] | undefined) => (xs ?? []).filter((m) => t - m < CHANNEL_WINDOW_MS)
    const moves = how.answer ? recent(ch.moves) : [...recent(ch.moves), t].slice(-CHANNEL_MOVES_MAX)
    const answered = how.answer ? [...recent(ch.answered), t].slice(-CHANNEL_MOVES_MAX) : ch.answered
    // Never past my clock: the channel and the link that follows it
    // keep the same value, so completeLink cannot put a later one back.
    const roomSentAt = Math.min(sentAt, Math.floor(t / 1000))
    // No line when the peer proved itself in my old room shortly before.
    const notice = how.notice === true && !(old && proofIn(pk, old, t - holderPairMs) !== undefined)
    // One write of one key: the room and its metadata never change halfway.
    await setChan(pk, {
      groupId,
      roomSentAt,
      roomAt: t,
      moves,
      answered: answered?.length ? answered : undefined,
      moving: undefined,
      answerFrom: undefined,
      boundBy: how.by,
      noticeAfter: notice ? t + holderPairMs : undefined,
      // The peer's first message in the new room on its clock, when it already spoke there
      // this session (a candidate proved in it); else none until it speaks (notePeerSpoke).
      peerSentAt: peerSaw.get(groupId),
      ...(mine ? { pending: true as const } : { pending: undefined, tries: undefined, triedAt: undefined }),
    })
    if (notice) armNotice(pk)
    // 5. The link follows: a lacking scan over a tombstone takes the new room
    // as its link room. Without this the link hellos of a re-add come in a room the scan
    // does not know, get only echoes and the link times out. A shaped link goes on as a
    // holder below; else a side that already sent its link hello (L always, H once
    // replied) repeats it here, and an H still waiting looks for the peer's proof that came
    // before (a stored proof).
    const scan = mem.scans[pk]
    if (scan && !scan.holder && relationOf(pk) === 'tomb' && scan.groupId !== groupId) {
      scan.groupId = groupId
      scan.sentAt = roomSentAt
      void save('scans')
      markLinking(pk)
      if (!scan.shaped) {
        if (scan.inviter || scan.replied) resendHello(scan, groupId, 0)
        else {
          const stored = storedProof(pk, groupId)
          if (stored) await inviteeReply(scan, groupId, stored, pk)
        }
      }
    }
    // The labels' context is the room id: every round with this peer starts over (matches go here).
    dropRoundState(pk)
    // told stays, but no relay of the new room has taken it: whatever the old
    // room carried, the new one carried nothing. Left 'ok', a withdraw refused here would
    // leave the told of my current offer looking delivered, and once the new round matches
    // again neither side would ever send its offer (scenario S-REOPEN-MATCH).
    const owed = mem.told[pk]
    if (owed?.ok) {
      mem.told[pk] = { ...owed, ok: false }
      void save('told')
    }
    const pc = mem.confirms[pk]
    if (pc && pc.groupId !== groupId) {
      delete mem.confirms[pk]
      void save('confirms')
    }
    if (old) seenIn.delete(old)
    forget(old)
    // State signals owed to this peer go again, now through the new room.
    resendPending()
    const offer = get().myOffer
    if (offer && contactOf(pk)) startRound(pk, offer.id, false)
    // 10. A holder scan of this peer still living (or a shaped link) sends its proof into
    // the new room too, and looks there for the peer's proof again.
    const held = liveHolder(pk)
    if (held) {
      holderLookback(held, groupId)
      holderProof(held, groupId)
    }
    void enqueue(pk, () => channelStep(pk))
  }

  /** Joins for moves run one at a time, whoever they are from (the engine line 'reopen'). */
  let joinTail: Promise<unknown> = Promise.resolve()
  function joinLine<T>(fn: () => Promise<T>): Promise<T> {
    const p = joinTail.then(fn)
    joinTail = p.catch(() => {})
    return p
  }

  /** The newest Welcome of a lower-key contact or tombstone after the gathering. */
  async function acceptMove(invite: IncomingInvite): Promise<void> {
    const t = transport
    const s = session
    const from = invite.inviterPubkey
    const ch = chanOf(from)
    // The relation went meanwhile (a reset).
    if (!t || !ch) return ignoreInvite(invite.id)
    // A pinned channel takes no remote move (a tagged one never comes here).
    if ((ch.pinnedUntil ?? 0) > now()) return ignoreInvite(invite.id)
    const scan = mem.scans[from]
    if (scan && !holderLike(scan) && !scan.replied && !scan.bypassUsed && now() - scan.at <= SCAN_TRUST_MS) {
      // Direct scanning wins: a fresh lacking scan of mine passes the time compare and the limit, once per scan.
      scan.bypassUsed = true
      await save('scans')
    } else {
      // The same room again, or an older one. A room I cannot use makes channelStep ask.
      if (ch.groupId && invite.sentAt <= (ch.roomSentAt ?? 0)) return ignoreInvite(invite.id)
      // Over the move limit. Not held (its key package may be gone by then): I ask
      // for a fresh room once the window opens.
      if (windowOpenAt(from, ch, now()) > now()) {
        ignoreInvite(invite.id)
        if (ch.moving === undefined) await setChan(from, { moving: now() })
        void enqueue(from, () => channelStep(from))
        return
      }
    }
    // Take the move.
    await setChan(from, { moving: now() })
    if (stopped || s !== session) return
    let groupId: string
    try {
      groupId = (await joinLine(() => t.acceptInvite(invite.id))).groupId
    } catch {
      // Not tried again: `moving` stays, so I ask for a fresh room.
      ignoreInvite(invite.id)
      debug('chan-fail')
      void enqueue(from, () => channelStep(from))
      return
    }
    // Stopped meanwhile: the joined room is bound to nothing; the boot cleanup removes it.
    if (stopped || s !== session || transport !== t) return
    noteJoined(invite.id)
    if (relationOf(from) === 'none') {
      void t.forgetGroup(groupId).catch(() => debug('forget-failed'))
      return
    }
    // An ordinary remote move: its "channel reopened" line is decided later.
    await bindRoom(from, groupId, invite.sentAt, false, { by: 'remote', notice: true })
  }

  /** The "channel reopened" line of `pk`'s channel is decided at its noticeAfter. */
  function armNotice(pk: PubkeyHex): void {
    cancel(noticeTimers.get(pk))
    noticeTimers.delete(pk)
    const at = chanOf(pk)?.noticeAfter
    if (at === undefined) return
    noticeTimers.set(
      pk,
      later(Math.max(0, at - now(), resumeUntil - now()), () => {
        noticeTimers.delete(pk)
        void enqueue(pk, () => decideNotice(pk))
      }),
    )
  }

  /**
   * The "channel reopened" line of a remote move is not drawn when the peer's proof came into
   * the new room, I scanned the peer meanwhile (submitScan clears noticeAfter), or
   * the peer proved itself in my old room just before (bindRoom never set it). Else it
   * is due once, for a contact only (a tombstone has no room on screen). Screen only:
   * nothing goes on the wire. The screen draws it.
   */
  async function decideNotice(pk: PubkeyHex): Promise<void> {
    const ch = chanOf(pk)
    if (!ch || ch.noticeAfter === undefined) return
    if (now() < ch.noticeAfter) return armNotice(pk)
    const proved = !!ch.groupId && proofIn(pk, ch.groupId, ch.roomAt ?? 0) !== undefined
    await setChan(pk, { noticeAfter: undefined })
    if (!proved && contactOf(pk)) {
      noticesDue++
      // One "channel reopened" line in my room with them, never sent.
      addRoomMessage({ id: randomId(), contactId: pk, mine: false, kind: 'reopened', at: now() })
    }
  }

  /**
   * Looks at every contact and tombstone in one pubkey-sorted list (never by relation, so
   * the timing is the same whoever is deleted) and starts or schedules its channel work.
   * Not exported: recovery's merge is inside the engine.
   */
  function ensureChannels(): void {
    if (stopped || get().boot !== 'ready' || !transport) return
    const t = now()
    const pks = [...get().contacts.map((c) => c.id), ...Object.keys(mem.tombstones)].sort()
    for (const c of get().contacts) noteReopen(c.id)
    let i = 0
    for (const pk of pks) {
      if (pendingMoves.has(pk)) continue
      const plan = channelPlan(pk, t)
      if (plan.kind === 'none') continue
      if (plan.kind !== 'confirm' && plan.at > t) {
        armChannel(pk, plan.at)
        continue
      }
      later(i++ * CHANNEL_PACE_MS, () => void enqueue(pk, () => channelStep(pk)))
    }
  }

  /** groupHealth changed somewhere: one ensureChannels after HEALTH_BATCH_MS. */
  function healthChanged(): void {
    if (stopped || healthTimer !== undefined) return
    healthTimer = later(HEALTH_BATCH_MS, () => {
      healthTimer = undefined
      ensureChannels()
    })
  }

  /** ensureChannels every CHANNEL_CHECK_MS while the engine runs. */
  function armChannelCheck(): void {
    later(CHANNEL_CHECK_MS, () => {
      ensureChannels()
      armChannelCheck()
    })
  }

  // ============================================================== 4. matching

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
    const previous = progressOf.get(contactId)
    if (previous === 'answered' || (field === 'asked' && previous !== undefined)) return
    const p = get().matchProgress
    // A restored offer can already have finished counts without a memory map.
    if (field === 'answered' && !progressKnown && previous === undefined && p.answered >= p.asked) return
    set({
      matchProgress: {
        ...p,
        [field]: p[field] + 1,
        ...(field === 'answered' && previous === undefined && progressKnown ? { asked: p.asked + 1 } : {}),
      },
    })
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

  /**
   * At most RESP_PER_PEER answer sessions of one sender pubkey and RESP_MAX in all;
   * the oldest go. Counted by pubkey, so the same for a contact and a deleted one.
   */
  function capRespSessions(pk: PubkeyHex): void {
    const byAge = (list: [string, RespSession][]) => list.sort((a, b) => a[1].at - b[1].at)
    const mine = byAge(Object.entries(mem.resp).filter(([, s]) => s.contactId === pk))
    const extra = mine.slice(0, Math.max(0, mine.length - RESP_PER_PEER))
    for (const [key] of extra) delete mem.resp[key]
    const all = byAge(Object.entries(mem.resp))
    const over = all.slice(0, Math.max(0, all.length - RESP_MAX))
    for (const [key] of over) delete mem.resp[key]
    // A line without values: no sender, no count.
    if (extra.length + over.length > 0) debug('resp-capped')
  }

  /** The answer sessions' write, merged over RESP_SAVE_MS: a flood of round 1s writes once a second. */
  let respWrite: Promise<boolean> | null = null
  function saveResp(): Promise<boolean> {
    if (respWrite) return respWrite
    const p = new Promise<boolean>((resolve) => {
      timerApi.set(() => {
        if (respWrite === p) respWrite = null
        void save('resp').then(resolve)
      }, RESP_SAVE_MS)
    })
    respWrite = p
    return p
  }

  /** Forget who matched, and tell everyone who may hold my offer that it is gone (told). */
  function retract(): void {
    mem.verified = {}
    // Queued before any new round: a withdraw still owed goes first.
    for (const pk of Object.keys(mem.told)) syncOffer(pk)
    for (const s of Object.values(mem.init)) releaseInit(s.contactId, s.sid)
    mem.init = {}
    mem.deferred = {}
    for (const id of deferTimers.values()) cancel(id)
    deferTimers.clear()
    silentRounds.clear()
    void save('deferred')
  }

  // ---------------------------------------------------------------- 4b. convergence

  const echoWaitMs = deps.tuning?.echoWaitMs ?? MATCH_ECHO_WAIT_MS
  const reconfirmFloorMs = deps.tuning?.reconfirmFloorMs ?? RECONFIRM_FLOOR_MS
  /** `${offerId}:${pk}` of the echo reconfirm rounds started (one per offer and contact). Memory only. */
  const echoed = new Set<string>()
  /** Contact -> when an app-open reconfirm round last started with it. Memory only: every start runs one. */
  const reconfirmedAt = new Map<PubkeyHex, number>()

  /**
   * A round of my current offer, run to the end, showed no match with `pk`. The match
   * goes and nothing is sent: the contact learnt the same from its side of the round. The
   * shown match reaches storage first, so a stop in between leaves only `verified`, which
   * the next reconfirm settles.
   */
  async function clearMatch(pk: PubkeyHex): Promise<void> {
    const matches = get().matches
    const shown = matches.some((x) => x.contactId === pk)
    if (!shown && mem.verified[pk] === undefined && !mem.told[pk]) return
    if (shown) {
      set({ matches: matches.filter((x) => x.contactId !== pk) })
      await save('matches')
    }
    if (mem.verified[pk] !== undefined) {
      delete mem.verified[pk]
      void save('verified')
    }
    if (mem.told[pk]) {
      delete mem.told[pk]
      void save('told')
    }
  }

  /** A verified match waits for the contact's offer; without it, one reconfirm round. */
  function expectOffer(pk: PubkeyHex): void {
    later(echoWaitMs, () => {
      if (!get().matches.some((x) => x.contactId === pk)) reconfirm(pk, 'echo')
    })
  }

  /**
   * A reconfirm round with a contact whose match with my current offer I verified: only
   * those, so a contact that does not match (or was deleted) gets nothing new at a start
   * or a return. 'echo': once per offer and contact. 'resume':
   * at most once per reconfirmFloorMs, counted here whether or not a round 1 went out.
   */
  function reconfirm(pk: PubkeyHex, why: 'echo' | 'resume'): void {
    const offer = get().myOffer
    if (!contactOf(pk)?.groupId || !offer || mem.verified[pk] !== offer.id) return
    if (why === 'resume') {
      const last = reconfirmedAt.get(pk)
      if (last !== undefined && now() - last < reconfirmFloorMs) return
      reconfirmedAt.set(pk, now())
    } else {
      const key = `${offer.id}:${pk}`
      if (echoed.has(key)) return
      echoed.add(key)
    }
    startRound(pk, offer.id, true, true, true)
  }

  /** When the shared round budget with `pk` frees up; 0 when it is free now. */
  function budgetFreeAt(pk: PubkeyHex): number {
    const last = mem.respondLog[pk]
    if (last === undefined) return 0
    const until = last + MATCH_WINDOW_MS
    return until > now() ? until : 0
  }

  /**
   * Spend the shared round budget with `pk` for the round `owner` ('i:<sid>' or
   * 'r:<sid>'). False when that could not be stored: then do not go on.
   */
  async function spendBudget(pk: PubkeyHex, owner: string): Promise<boolean> {
    mem.respondLog[pk] = now()
    mem.roundOwner[pk] = owner
    const [a, b] = await Promise.all([save('respondLog'), save('roundOwner')])
    return a && b
  }

  /**
   * Give back the budget a round I started holds, when that round ends before I
   * sent m3 (refused, or my offer changed). It revealed nothing: only m2 and m3
   * let the peer learn a result. The budget was free when the round started.
   */
  function releaseInit(pk: PubkeyHex, sid: string): void {
    if (mem.roundOwner[pk] !== `i:${sid}`) return
    delete mem.roundOwner[pk]
    delete mem.respondLog[pk]
    void save('roundOwner')
    void save('respondLog')
  }

  /** Recover an unanswered round; a completed m3 still retains its spent budget. A reconfirm round stays one. */
  function recoverInit(pk: PubkeyHex, sid: string, delayMs = 0): void {
    const pending = mem.init[sid]
    const spent = mem.respondLog[pk]
    delete mem.init[sid]
    releaseInit(pk, sid)
    if (!pending && spent !== undefined) {
      mem.respondLog[pk] = spent
      void save('respondLog')
    }
    void save('init')
    deferCurrent(pk, delayMs, pending?.force === true)
  }

  function deferCurrent(pk: PubkeyHex, delayMs: number, force = false): void {
    const offer = get().myOffer
    if (!offer || !contactOf(pk)) return
    const d: DeferredRound = { offerId: offer.id, retry: true, ...(force ? { force } : {}) }
    mem.deferred[pk] = d
    void save('deferred')
    armDeferred(pk, d, Math.max(budgetFreeAt(pk), now() + delayMs))
  }

  /**
   * Rounds in a row that the contact left unanswered. In memory only: a boot
   * retries at once anyway. The first retry is immediate, since it is usually
   * a lost message; after that the contact's app is probably closed.
   */
  const silentRounds = new Map<PubkeyHex, number>()
  /** Refusals (mx) in a row per contact; any other message from it ends the run. Memory only. */
  const mxStreak = new Map<PubkeyHex, number>()
  function silentRetryDelay(silent: number): number {
    return silent <= 1 ? 0 : Math.min(SILENT_RETRY_BASE_MS * 2 ** (silent - 2), SILENT_RETRY_MAX_MS)
  }

  /** The contact is back: drop the backoff and retry a waiting round now. */
  function heardFrom(pk: PubkeyHex): void {
    if (!silentRounds.delete(pk)) return
    const d = mem.deferred[pk]
    if (d) armDeferred(pk, d, budgetFreeAt(pk) || now())
  }

  const deferTimers = new Map<PubkeyHex, number>()
  /** Start this round once the window passed. Kept across reloads (see armDeferred). */
  function armDeferred(pk: PubkeyHex, d: DeferredRound, at: number): void {
    // Let the peer's window (spent a moment after mine) expire too.
    const DEFER_SLACK_MS = 300
    cancel(deferTimers.get(pk))
    deferTimers.set(
      pk,
      later(Math.max(0, at - now()) + DEFER_SLACK_MS, () => {
        deferTimers.delete(pk)
        if (mem.deferred[pk] !== d) return
        delete mem.deferred[pk]
        void save('deferred')
        startRound(pk, d.offerId, d.retry, true, d.force === true)
      }),
    )
  }

  /**
   * `asked`: matchProgress already counts this contact (a deferred round is
   * counted when it is deferred, so the progress line shows it is waiting).
   * `force`: a reconfirm round. It runs only while the match with this offer
   * stands, also when the contact is shown already; a plain retry stops once it is.
   */
  function startRound(contactId: PubkeyHex, offerId: string, retry: boolean, asked = false, force = false): void {
    void enqueue(contactId, async () => {
      const offer = get().myOffer
      const contact = contactOf(contactId)
      if (!offer || offer.id !== offerId || !contact) return
      // A room that cannot carry messages starts nothing; binding a new room starts it again.
      const room = contact.groupId
      if (!room || roomUnusable(room)) return
      const c = { ...contact, groupId: room }
      if (
        force
          ? mem.verified[contactId] !== offerId
          : retry && mem.verified[contactId] === offerId && get().matches.some((m) => m.contactId === contactId)
      ) {
        return
      }
      // A pending initiator is a reservation even after its cooldown expires.
      // Do not overwrite its owner while a late m2 can still complete it.
      if (Object.values(mem.init).some((s) => s.contactId === contactId)) return
      const freeAt = budgetFreeAt(contactId)
      if (freeAt) {
        // I already used a round with this contact in the window (either role).
        const d: DeferredRound = { offerId, retry, ...(force ? { force } : {}) }
        mem.deferred[contactId] = d
        void save('deferred')
        if (!retry && !asked) bump('asked', contactId)
        armDeferred(contactId, d, freeAt)
        debug('round-deferred', { peer: short(contactId) })
        return
      }
      const sid = randomId()
      const labels = match.labelsFor({ context: c.groupId, myPubkey: me, peerPubkey: c.pubkey, initiator: me, sid, offer })
      const { secret, p } = match.round1(labels)
      const session: InitSession = { sid, contactId, secret, p, offerId, at: now() }
      if (retry) session.retry = true
      if (force) session.force = true
      mem.init[sid] = session
      // The round holds the budget from its start, so no other round with this
      // contact (either role) can run beside it.
      const [, spent] = await Promise.all([save('init'), spendBudget(contactId, `i:${sid}`)])
      if (!spent) {
        delete mem.init[sid]
        releaseInit(contactId, sid)
        void save('init')
        return
      }
      if (get().myOffer?.id !== offerId || mem.init[sid] !== session) return
      if (!retry && !asked) bump('asked', contactId)
      // A relay round trip takes seconds: the 1s window must not expire the round before m2 can arrive.
      const deadline = 15_000
      const expire = (): void => {
        void enqueue(contactId, async () => {
          if (mem.init[sid] !== session) return
          // An explicit send failure already has bounded outbox retries. Do
          // not invalidate them before exhaustion; this deadline recovers
          // silently lost m1/m2, for which there is no outbox retry.
          if (outbox.get(c.groupId)?.items.some((it) => it.msg.t === 'm1' && it.msg.sid === sid)) {
            later(deadline, expire)
            return
          }
          const silent = (silentRounds.get(contactId) ?? 0) + 1
          silentRounds.set(contactId, silent)
          recoverInit(contactId, sid, silentRetryDelay(silent))
        })
      }
      later(deadline, expire)
      await send(c.groupId, { t: 'm1', sid, p }, { peer: contactId })
    })
  }

  async function onM1(m: IncomingMessage, msg: Wire<'m1'>): Promise<void> {
    const from = m.senderPubkey
    // The transport already parsed it; the engine checks the shape again.
    if (!isSid(msg.sid) || !isPair(msg.p)) return
    const active = activeContact(from, m.groupId) !== undefined
    // A deleted contact is still answered, with a random label, so it cannot tell.
    const ghost = !active && relationOf(from) === 'tomb' && chanOf(from)?.groupId === m.groupId
    if (!active && !ghost) return
    // This round 1 was answered already (delivered again, or sent again): the stored
    // answer stands. The same for a contact and a deleted one, whose sessions live on.
    if (mem.resp[`${from}:${msg.sid}`]) return

    const t = now()
    let yielded: InitSession | undefined
    const owner = mem.roundOwner[from]
    const mine = owner?.startsWith('i:') ? mem.init[owner.slice(2)] : undefined
    if (budgetFreeAt(from) || mine) {
      // A round with this contact holds the window. Only one case is not a
      // refusal: we both started a round at once and mine has not been answered.
      if (!mine || mine.contactId !== from) {
        await send(m.groupId, { t: 'mx', sid: msg.sid }, { peer: from })
        return
      }
      // Crossed starts: the round started by the lower pubkey goes on. If that
      // is mine, resend it so a peer that missed m1 can answer and defer its own.
      if (me < from) {
        debug('round-crossed', { peer: short(from), kept: 'mine' })
        if (mine.p) await send(m.groupId, { t: 'm1', sid: mine.sid, p: mine.p }, { peer: from })
        else recoverInit(from, mine.sid)
        return
      }
      // The peer's round goes on: mine ends unanswered (it never sent m3) and waits.
      delete mem.init[mine.sid]
      void save('init')
      yielded = mine
      debug('round-crossed', { peer: short(from), kept: 'theirs' })
    }
    // Answer only once the spent budget is stored, or a reload would let the peer ask again.
    if (!(await spendBudget(from, `r:${msg.sid}`))) return
    if (yielded && get().myOffer?.id === yielded.offerId) {
      // The winning round compares my current offer too. Count it only when
      // m3 completes; keep recovery queued in case that message is lost.
      const d: DeferredRound = { offerId: yielded.offerId, retry: true, ...(yielded.force ? { force: true } : {}) }
      mem.deferred[from] = d
      void save('deferred')
      armDeferred(from, d, budgetFreeAt(from) || now())
    }

    // Both slots random for a deleted contact or without an offer.
    const offer = active ? get().myOffer : null
    let q: MatchPair
    let pq: MatchPair
    try {
      const labels = match.labelsFor({ context: m.groupId, myPubkey: me, peerPubkey: from, initiator: from, sid: msg.sid, offer })
      ;({ q, pq } = match.round2(labels, msg.p))
    } catch {
      return
    }
    pruneRespSessions(t)
    mem.resp[`${from}:${msg.sid}`] = { sid: msg.sid, contactId: from, pq, offerId: offer ? offer.id : null, at: t }
    capRespSessions(from)
    // Stored before the answer goes, so a round 1 delivered again finds it.
    await saveResp()
    await send(m.groupId, { t: 'm2', sid: msg.sid, q, pq }, { peer: from })
  }

  async function onM2(m: IncomingMessage, msg: Wire<'m2'>): Promise<void> {
    const from = m.senderPubkey
    if (!isSid(msg.sid) || !isPair(msg.q) || !isPair(msg.pq)) return
    const s = mem.init[msg.sid]
    if (!s || s.contactId !== from) return
    // The session goes only after the result is stored: a stop before that
    // leaves it, and the m2 delivered again (or recoverInit) finishes the round.
    const endRound = (): void => {
      if (mem.init[msg.sid] !== s) return
      delete mem.init[msg.sid]
      void save('init')
    }

    // Only the round that holds this window's budget may send m3 (which lets the peer learn).
    if (mem.roundOwner[from] !== `i:${msg.sid}`) {
      debug('round-not-owner', { peer: short(from) })
      return endRound()
    }
    const c = activeContact(from, m.groupId)
    const offer = get().myOffer
    // My offer changed since round 1: the answer no longer means anything.
    if (!c || !offer || offer.id !== s.offerId) return endRound()
    bump('answered', from)
    // Completing a round spends the budget with this contact again, from now.
    if (!(await spendBudget(from, `i:${msg.sid}`))) return endRound()

    let matched: boolean
    let qp: MatchPair
    try {
      ;({ matched, qp } = match.round3(s.secret, msg.q, msg.pq))
    } catch {
      return endRound()
    }
    if (matched) {
      mem.verified[from] = offer.id
      await save('verified')
    }
    endRound()
    await send(c.groupId, { t: 'm3', sid: msg.sid, qp }, { peer: from, offerId: s.offerId })
    if (!matched) {
      // A round of my current offer, run to the end, showed no match.
      await clearMatch(from)
      return
    }
    // The starting side: my offer goes first once per offer, through told (so it
    // is re-sent until a relay takes it). A round again with the same offer (a reconfirm)
    // sends nothing more; the contact's own offer is what lets the current one go then.
    const cur = get().myOffer
    if (cur && cur.id === offer.id && mem.verified[from] === offer.id && mem.told[from]?.id !== offer.id) {
      mem.told[from] = { id: offer.id, offer: publicOf(cur), ok: false }
      syncOffer(from, true)
    }
    expectOffer(from)
  }

  async function onM3(m: IncomingMessage, msg: Wire<'m3'>): Promise<void> {
    const from = m.senderPubkey
    if (!isSid(msg.sid) || !isPair(msg.qp)) return
    const key = `${from}:${msg.sid}`
    const s = mem.resp[key]
    if (!s) return
    // The session goes only after the result is stored.
    const endRound = (): void => {
      if (mem.resp[key] !== s) return
      delete mem.resp[key]
      void saveResp()
    }
    // Only the round that holds this window's budget may finish.
    if (mem.roundOwner[from] !== `r:${msg.sid}`) {
      debug('round-not-owner', { peer: short(from) })
      return endRound()
    }

    let matched = false
    try {
      matched = match.finish(s.pq, msg.qp)
    } catch {
      matched = false
    }
    // Keep the cooldown from completion too: a delayed m3 must not allow a
    // second completed probe immediately after this one.
    if (!(await spendBudget(from, `r:${msg.sid}`))) return endRound()
    if (s.offerId !== null && get().myOffer?.id === s.offerId) bump('answered', from)
    const c = activeContact(from, m.groupId)
    const offer = get().myOffer
    const current = !!c && !!offer && s.offerId !== null && offer.id === s.offerId
    if (!matched) {
      // My current offer was in this round and it showed no match. A
      // round I answered with a random label (no offer, a deleted contact) clears nothing.
      if (current) await clearMatch(from)
      return endRound()
    }
    if (!current || !offer) return endRound()
    mem.verified[from] = offer.id
    await save('verified')
    endRound()
    // The answering side: only the match is kept. My offer goes once the
    // contact's valid offer came (onOffer).
    expectOffer(from)
  }

  async function onMx(m: IncomingMessage, msg: Wire<'mx'>): Promise<void> {
    const from = m.senderPubkey
    if (!isSid(msg.sid)) return
    const s = mem.init[msg.sid]
    if (!s || s.contactId !== from) return
    // Refused: this round sent only m1, so its budget goes back.
    const endRound = (): void => {
      if (mem.init[msg.sid] === s) {
        delete mem.init[msg.sid]
        void save('init')
      }
      releaseInit(from, msg.sid)
    }
    const offer = get().myOffer
    if (!offer || offer.id !== s.offerId) return endRound()
    // A refusal is not an answered probe. Keep one persisted retry for this
    // offer until the peer can answer; a fixed retry cap can strand it forever.
    // The retry is stored before the round goes.
    const d: DeferredRound = { offerId: offer.id, retry: true, ...(s.force ? { force: true } : {}) }
    mem.deferred[from] = d
    await save('deferred')
    endRound()
    // Refusal backoff: from the third refusal in a row the
    // next try waits like an unanswered round, 15 s growing to 15 min.
    const streak = (mxStreak.get(from) ?? 0) + 1
    mxStreak.set(from, streak)
    const wait = streak >= 3 ? silentRetryDelay(streak - 1) : MATCH_WINDOW_MS
    if (mem.deferred[from] === d) armDeferred(from, d, now() + wait)
  }

  /**
   * Contact → the claimed time (the contact's unix seconds) of the newest offer or withdraw
   * of it I took this session. The transport hands a long catch-up over in sorted parts,
   * the newest part first (INGEST_HOLD_MAX_MS): an older offer or withdraw of a
   * later part must not undo the newer one. Only the contact's own times are compared; a
   * time far in my future is not kept, so it cannot block what follows. Memory only.
   */
  const offerMsgAt = new Map<PubkeyHex, number>()

  /** This offer or withdraw is older than the one of the contact I took (offerMsgAt); otherwise it is noted. */
  function olderOfferMsg(m: IncomingMessage): boolean {
    const last = offerMsgAt.get(m.senderPubkey)
    if (last !== undefined && m.at < last) return true
    if (m.at <= Math.floor(now() / 1000) + FUTURE_SENT_S) offerMsgAt.set(m.senderPubkey, m.at)
    return false
  }

  function onOffer(m: IncomingMessage, msg: Wire<'offer'>): void {
    const from = m.senderPubkey
    const c = activeContact(from, m.groupId)
    const mine = get().myOffer
    // An offer counts only from someone whose match with my current offer I verified myself.
    if (!c || !mine || mem.verified[from] !== mine.id) return
    const theirs = parsePublicOffer(msg.offer)
    if (!theirs || theirs.currency !== mine.currency || theirs.side === mine.side) return
    // No method in common: not a valid offer for this match. Like an unreadable one, it leaves
    // the Match and verified as they are (an honest app retracts first).
    if (commonMethods(theirs.methods, mine.methods).length === 0) return
    // Older than the offer or withdraw of the contact I took: a later part of a catch-up.
    if (olderOfferMsg(m)) return

    const matches = get().matches
    const prev = matches.find((x) => x.contactId === from)
    const next: Match = { contactId: from, offer: theirs }
    set({ matches: prev ? matches.map((x) => (x === prev ? next : x)) : [...matches, next] })
    void save('matches')
    if (!prev) debug('match', { peer: short(from) })
    // The matched contact changed its amount or premium: one line in my room only, never
    // sent. Only a real change of the numbers I already had.
    if (prev && (prev.offer.amountMinor !== theirs.amountMinor || prev.offer.feePct !== theirs.feePct)) {
      addRoomMessage(peerRecord(m, {
        id: randomId(),
        contactId: from,
        mine: false,
        kind: 'changed',
        currency: theirs.currency,
        before: { amountMinor: prev.offer.amountMinor, feePct: prev.offer.feePct },
        after: { amountMinor: theirs.amountMinor, feePct: theirs.feePct },
        // The contact's claimed time, like its texts, so a catch-up keeps the two in order.
        at: receivedAt(m),
      }))
    }
    // One marker per offer of mine and contact: a match that drops and comes back
    // within the same offer adds none, so a live card is never cut off by it.
    if (!prev && tradeBounds(get().rooms[from] ?? [], mine).matchIdx === -1) {
      addRoomMessage({ id: randomId(), contactId: from, mine: false, kind: 'matched', at: now() })
    }
    // The contact showed its offer, so mine goes now (the answering side's first send,
    // and an edit made meanwhile). The first receipt of each offer of the contact forces it
    // even when told says a relay took it, since the contact may have dropped mine before it
    // verified the match (a lost or late m3), or posted again after a withdraw I never got
    // The wire carries no offer id: a new offer has a new
    // createdAt, an edit keeps it.
    syncOffer(from, !prev || prev.offer.createdAt !== theirs.createdAt)
  }

  function onWithdraw(m: IncomingMessage): void {
    const from = m.senderPubkey
    if (!activeContact(from, m.groupId)) return
    // Older than the offer of the contact I took: a later part of a catch-up (offerMsgAt).
    if (olderOfferMsg(m)) return
    if (mem.verified[from] !== undefined) {
      delete mem.verified[from]
      void save('verified')
    }
    const matches = get().matches
    if (matches.some((x) => x.contactId === from)) {
      set({ matches: matches.filter((x) => x.contactId !== from) })
      void save('matches')
    }
    // Their app cleared its match before it sent this: it shows nothing of mine.
    if (mem.told[from]) {
      delete mem.told[from]
      void save('told')
    }
  }

  async function postOffer(input: OfferInput): Promise<void> {
    if (!me || get().boot !== 'ready') throw new Error('not_ready')
    const { side, currency, amountMinor, feePct } = input
    const sideOk = side === 'buy' || side === 'sell'
    const methods = canonicalMethods(input.methods)
    if (!sideOk || !isCurrency(currency) || !isMinor(amountMinor) || !validFee(feePct) || !methods) {
      throw new Error('invalid_offer')
    }

    const prev = get().myOffer
    if (prev && prev.side === side && prev.currency === currency && prev.methods.join() === methods.join()) {
      // Same direction, currency and methods: an edit. Whoever matched just gets the new numbers.
      // A change of methods is matched again like a change of side: only a round can tell
      // which contacts still share one (one id edits unmatched values only).
      await editOffer({ amountMinor, feePct })
      return
    }

    retract()
    const offer: Offer = { id: randomId(), side, currency, amountMinor, feePct, methods, createdAt: now(), rev: 1 }
    resetProgress()
    set({ myOffer: offer, matches: [], matchProgress: ZERO_PROGRESS })
    await Promise.all([save('offer'), save('matches'), save('progress'), save('verified'), save('init')])
    for (const c of get().contacts) startRound(c.id, offer.id, false)
  }

  /**
   * Changes the numbers of my current offer (same side and currency). `createdAt`
   * stays, `rev` goes up by one, so a completion that names the old rev no longer
   * deducts. Whoever matched just gets the new numbers. The same numbers again do
   * nothing.
   */
  async function editOffer(patch: Partial<Pick<Offer, 'amountMinor' | 'feePct'>>): Promise<void> {
    const prev = get().myOffer
    if (!prev) return
    // The same numbers again change nothing: no new rev reaches the matched contacts,
    // which would only show them when I used the app.
    const keys = Object.keys(patch) as (keyof typeof patch)[]
    if (keys.every((k) => patch[k] === undefined || patch[k] === prev[k])) return
    set({ myOffer: { ...prev, ...patch, rev: prev.rev + 1 } })
    await save('offer')
    // Only the last value goes; one still on its way is followed by it (told).
    for (const pk of Object.keys(mem.verified)) syncOffer(pk)
  }

  async function withdrawOffer(): Promise<void> {
    if (!get().myOffer) return
    retract()
    resetProgress()
    set({ myOffer: null, matches: [], matchProgress: ZERO_PROGRESS })
    await Promise.all([save('offer'), save('matches'), save('progress'), save('verified'), save('init')])
  }

  // ============================================================== 5. rooms, contacts, settings

  /** The contact's claimed time of its records added this session, unclamped (peerRecord, placeOf). */
  const claimedAt = new WeakMap<ChatMessage, number>()
  /**
   * The catch-up batch of the contact's records added this session (peerRecord, placeOf):
   * records of one contact that came in no more than CATCHUP_JOIN_MS after the one
   * before share a batch; a gap starts a new one. "Came in" is when the transport handed the
   * message over (deliveredAt), not when it was handled: the contact's queue can wait on a
   * send of mine (up to the relays' timeout) between two records of one hand-over.
   */
  const batchOf = new WeakMap<ChatMessage, number>()
  const lastBatch = new Map<PubkeyHex, { at: number; id: number }>()
  /** When the transport handed each message over (onMessage); memory only. */
  const deliveredAt = new WeakMap<IncomingMessage, number>()
  let batchSeq = 0

  function addRoomMessage(msg: ChatMessage): void {
    const rooms = get().rooms
    // A record already in the room goes in once: a message handled again (delivered
    // again after a restart) or a re-sent 'done' (it carries the same id).
    if (rooms[msg.contactId]?.some((x) => x.id === msg.id)) return
    const list = [...(rooms[msg.contactId] ?? [])]
    list.splice(placeOf(list, msg), 0, msg)
    set({ rooms: { ...rooms, [msg.contactId]: capRoom(list, get().myOffer) } })
    void saveRoom(msg.contactId)
  }

  /**
   * Where a record goes in its room: the end, except that a contact's text or term change
   * goes before the contact's texts and term changes at the end that it is older than.
   * After the page was frozen, the catch-up can hand a contact's messages over newest first.
   * Only the contact's own claimed times are
   * compared with each other, never with my clock: my lines and every marker stay where
   * they are, so a contact's clock that is off cannot move a text past them. The claimed
   * time before the clamp (claimedAt) where this session has it: `at` is clamped to my
   * clock, so with the contact's clock ahead a whole catch-up would carry my handling
   * times, in handing-over order. A record of an earlier session compares by
   * its `at`.
   */
  function placeOf(list: ChatMessage[], msg: ChatMessage): number {
    let i = list.length
    if (msg.mine || (msg.kind !== 'text' && msg.kind !== 'changed')) return i
    const key = (x: ChatMessage) => claimedAt.get(x) ?? x.at
    const mk = key(msg)
    // Only within the catch-up batch the record came in with: a record that came
    // in after a gap is new to me whatever its time says, so it goes after what I already
    // had. Else a contact's clock set back during the session (a correction) put its new
    // live texts above older ones.
    const batch = batchOf.get(msg)
    if (batch === undefined) return i
    while (i > 0) {
      const prev = list[i - 1]
      if (prev.mine || (prev.kind !== 'text' && prev.kind !== 'changed') || batchOf.get(prev) !== batch || key(prev) <= mk) break
      i--
    }
    return i
  }

  /**
   * The room's limit: the current trade's records (payment
   * cards, completion lines, system lines with the 'matched' marker; from the trade's start
   * in tradeBounds on) keep up to TRADE_KEEP of their own, the newest; everything else
   * shares ROOM_CAP. Over it, the contact's plain texts go first, oldest first, but its
   * newest ROOM_PEER_FLOOR are never dropped; then the oldest of the rest (mine, lines). A long chat in the middle of a
   * trade never pushes out its card, a contact flooding the room never pushes out my lines,
   * and a room full of my own texts never drops the text that just came in (the
   * contact's only text may be the newest).
   */
  function capRoom(list: ChatMessage[], offer: Offer | null): ChatMessage[] {
    if (list.length <= ROOM_CAP) return list
    const isRecord = (m: ChatMessage) => m.kind !== 'text' || hasPayRef(m.text)
    const kept = new Set<number>()
    if (offer) {
      const b = tradeBounds(list, offer)
      const from = Math.max(b.cut, b.matchIdx, 0)
      for (let i = list.length - 1; i >= from && kept.size < TRADE_KEEP; i--) if (isRecord(list[i])) kept.add(i)
    }
    let over = list.length - kept.size - ROOM_CAP
    if (over <= 0) return list
    const drop = new Set<number>()
    const theirs: number[] = []
    list.forEach((m, i) => {
      if (!kept.has(i) && m.kind === 'text' && !m.mine && !hasPayRef(m.text)) theirs.push(i)
    })
    for (const i of theirs.slice(0, Math.max(0, theirs.length - ROOM_PEER_FLOOR))) {
      if (over <= 0) break
      drop.add(i)
      over--
    }
    // The contact's newest ROOM_PEER_FLOOR are never dropped, also when they are older than
    // all of my texts. There is always enough else: the floor is below ROOM_CAP.
    const floor = new Set(theirs.slice(-ROOM_PEER_FLOOR))
    for (let i = 0; i < list.length && over > 0; i++) {
      if (!kept.has(i) && !drop.has(i) && !floor.has(i)) {
        drop.add(i)
        over--
      }
    }
    return list.filter((_, i) => !drop.has(i))
  }

  /**
   * A record of the contact's message keeps the time the message claims, before the clamp
   * of receivedAt, for placeOf: memory only, for the records of this session.
   */
  function peerRecord(m: IncomingMessage, rec: ChatMessage): ChatMessage {
    claimedAt.set(rec, m.at > 0 ? m.at * 1000 : rec.at)
    const t = deliveredAt.get(m) ?? now()
    const last = lastBatch.get(rec.contactId)
    const id = last && t - last.at <= CATCHUP_JOIN_MS ? last.id : ++batchSeq
    lastBatch.set(rec.contactId, { at: t, id })
    batchOf.set(rec, id)
    return rec
  }

  /** Sender-claimed seconds, but never in my future. */
  function receivedAt(m: IncomingMessage): number {
    const t = now()
    return m.at > 0 ? Math.min(m.at * 1000, t) : t
  }

  function onChat(m: IncomingMessage, msg: Wire<'chat'>): void {
    const from = m.senderPubkey
    if (!activeContact(from, m.groupId) || typeof msg.text !== 'string' || msg.text.length === 0) return
    addRoomMessage(peerRecord(m, {
      // The sender's record id, not the rumor's: a text sent again (retryChat) goes in once.
      id: msg.id,
      contactId: from,
      mine: false,
      kind: 'text',
      text: msg.text.slice(0, CHAT_MAX),
      at: receivedAt(m),
    }))
  }

  function onDone(m: IncomingMessage, msg: Wire<'done'>): void {
    const from = m.senderPubkey
    const currency = asCurrency(msg.currency)
    if (!activeContact(from, m.groupId) || !currency || !isMinor(msg.amountMinor)) return
    // The sender's record id, so a resend is the same record; my clock, like every marker.
    addRoomMessage({ id: msg.id, contactId: from, mine: false, kind: 'done', amountMinor: msg.amountMinor, currency, at: now() })
  }

  async function sendChat(contactId: PubkeyHex, text: string): Promise<void> {
    const c = contactOf(contactId)
    const body = text.trim()
    if (!c || body.length === 0) return
    // Never cut: a cut payment request would go out broken.
    if (body.length > CHAT_MAX) throw new Error('too_long')
    const rec: ChatMessage = { id: randomId(), contactId, mine: true, kind: 'text', text: body, at: now(), status: 'sending' }
    addRoomMessage(rec)
    // A room that cannot carry messages fails at once; the user sends it again.
    if (!c.groupId || roomUnusable(c.groupId)) return setChatStatus(contactId, rec.id, false)
    // The record's id travels with it.
    const room = c.groupId
    sendLater(contactId, room, () => wireOf(rec), (ok) => recordSettled(contactId, rec.id, ok, room))
  }

  function setChatStatus(contactId: PubkeyHex, id: string, ok: boolean): void {
    setRecordStatus(contactId, id, ok ? 'sent' : 'failed')
  }

  /** The delivery status of one of my records (a text or a completion), stored with the room. */
  function setRecordStatus(contactId: PubkeyHex, id: string, status: 'sending' | 'sent' | 'failed'): void {
    const rooms = get().rooms
    const list = rooms[contactId]
    const i = list ? list.findIndex((x) => x.id === id) : -1
    if (!list || i < 0) return
    const cur = list[i]
    // Only my records that carry a status: texts and completions. Received ones never do.
    if (!cur.mine || !('status' in cur) || cur.status === status) return
    const next = list.slice()
    next[i] = { ...cur, status } as ChatMessage
    set({ rooms: { ...rooms, [contactId]: next } })
    void saveRoom(contactId)
    // The room's status follows my newest text (reopenOf), failed in this session.
    if (cur.kind === 'text') {
      if (status === 'failed') textFailedAt.set(id, now())
      else textFailedAt.delete(id)
      noteReopen(contactId)
    }
  }

  async function retryChat(contactId: PubkeyHex, messageId: string): Promise<void> {
    const c = contactOf(contactId)
    const list = get().rooms[contactId]
    const i = list ? list.findIndex((x) => x.id === messageId) : -1
    if (!c || !list || i < 0) return
    const msg = list[i]
    if (!msg.mine || msg.kind !== 'text' || msg.status !== 'failed') return
    setRecordStatus(contactId, messageId, 'sending')
    if (!c.groupId || roomUnusable(c.groupId)) return setChatStatus(contactId, messageId, false)
    // The same id as the first try: a text a relay took after all goes in once on the other side.
    const room = c.groupId
    sendLater(contactId, room, () => wireOf(msg), (ok) => recordSettled(contactId, messageId, ok, room))
  }

  /**
   * Completions run one at a time on their own chain, and so does finishing a
   * deduction a crash cut short. Each one sees the offer the one before left.
   */
  let doneChain: Promise<void> = Promise.resolve()

  function markDone(contactId: PubkeyHex, amountMinor: number): Promise<void> {
    const run = doneChain.then(() => runDone(contactId, amountMinor))
    doneChain = run.then(
      () => {},
      () => {},
    )
    return run
  }

  /**
   * Record, then deduct, then tell: the record reaches storage before the offer
   * changes, so a restart finds the record (the card grey) and finishDeducts
   * applies a deduction the crash cut off. The room's state never refuses it:
   * sending alone fails, and the record stays.
   */
  async function runDone(contactId: PubkeyHex, amountMinor: number): Promise<void> {
    if (get().boot !== 'ready') throw new Error('not_ready')
    const c = contactOf(contactId)
    if (!c) throw new Error('no_contact')
    const offer = get().myOffer
    if (!offer) throw new Error('no_offer')
    if (!isMinor(amountMinor)) throw new Error('invalid_amount')
    const left = offer.amountMinor - amountMinor
    if (left < 0) throw new Error('too_much')
    // Nothing changed or sent up to here.
    const rec: ChatMessage = {
      id: randomId(),
      contactId,
      mine: true,
      kind: 'done',
      amountMinor,
      currency: offer.currency,
      at: now(),
      deduct: { offerId: offer.id, rev: offer.rev, leftMinor: left },
      // Stored as 'sending': a stop before a relay took it reads back as 'failed', and
      // resendPending sends it under the same id.
      status: 'sending',
    }
    addRoomMessage(rec)
    if (!(await saveRoom(contactId))) {
      const rooms = get().rooms
      const list = rooms[contactId]
      if (list) set({ rooms: { ...rooms, [contactId]: list.filter((x) => x.id !== rec.id) } })
      // A write that timed out may still land later; this one, queued after it, wins.
      void saveRoom(contactId)
      throw new Error('not_saved')
    }
    // An offer changed or withdrawn while the record was stored wins: no deduction then.
    const cur = get().myOffer
    if (cur && cur.id === offer.id && cur.rev === offer.rev) await applyDeduct(left)
    // Never refused for the room: the record and the deduction stand. While the room
    // cannot carry it the send fails at once, and the resend goes on from there under the
    // same id (resendPending: timer, return to the app, next start).
    const room = contactOf(contactId)?.groupId
    if (!room || roomUnusable(room)) return recordSettled(contactId, rec.id, false)
    const s = session
    sendLater(contactId, room, () => wireOf(rec), (ok) => s === session && recordSettled(contactId, rec.id, ok, room))
  }

  /** The open amount after a completion: withdrawn at zero. */
  async function applyDeduct(leftMinor: number): Promise<void> {
    if (leftMinor === 0) await withdrawOffer()
    else await editOffer({ amountMinor: leftMinor })
  }

  /**
   * At start: a completion record whose deduction never reached storage names my
   * current offer and rev. Apply them in rev order; each one raises rev or
   * removes the offer, so the loop ends.
   */
  async function finishDeducts(): Promise<void> {
    for (;;) {
      const offer = get().myOffer
      if (!offer || stopped) return
      let pending: number | null = null
      for (const list of Object.values(get().rooms)) {
        for (const m of list) {
          if (m.kind === 'done' && m.mine && m.deduct && m.deduct.offerId === offer.id && m.deduct.rev === offer.rev) {
            pending = m.deduct.leftMinor
            break
          }
        }
        if (pending !== null) break
      }
      if (pending === null) return
      await applyDeduct(pending)
    }
  }

  async function renameContact(id: PubkeyHex, name: string): Promise<void> {
    if (!contactOf(id)) return
    const clean = name.trim().slice(0, NAME_MAX)
    set({ contacts: get().contacts.map((c) => (c.id === id ? { ...c, name: clean } : c)) })
    await save('contacts')
    listChanged()
  }

  /**
   * Everything about matching with `pk` goes: progress, the verified match,
   * my open rounds, waiting rounds, the shown match. The answer sessions stay, only no
   * longer tied to an offer: a deleted contact must see the same m2 / m3 behaviour as
   * before (a queued m2, a late m3). `confirms` is not touched. removeContact
   * calls it first.
   */
  function dropRoundState(pk: PubkeyHex): void {
    dropProgress(pk)
    delete mem.verified[pk]
    for (const [sid, s] of Object.entries(mem.init)) {
      if (s.contactId !== pk) continue
      delete mem.init[sid]
      releaseInit(pk, sid)
    }
    // Sessions stay: a deleted contact must see the same m2 / m3 behaviour as before.
    for (const s of Object.values(mem.resp)) if (s.contactId === pk) s.offerId = null
    delete mem.deferred[pk]
    cancel(deferTimers.get(pk))
    deferTimers.delete(pk)
    silentRounds.delete(pk)
    mxStreak.delete(pk)
    // The echo round's once per offer and contact counts within one room: a room move starts matching
    // over, so the new room's match may need its own echo round. reconfirmedAt (the app-open
    // floor) stays: it is a rate, not a round state.
    for (const k of echoed) if (k.endsWith(`:${pk}`)) echoed.delete(k)
    const matches = get().matches
    if (matches.some((x) => x.contactId === pk)) set({ matches: matches.filter((x) => x.contactId !== pk) })
    for (const key of ['verified', 'init', 'resp', 'deferred', 'matches'] as const) void save(key)
  }

  /**
   * The one way a contact is removed (deleteContact, and recovery's merge).
   * In this order: the round state, the tombstone with every channel field of
   * the contact (so the channel behaves exactly as for a contact), the
   * contact, its link scan and timers, its chat item and screen values, then the writes
   * (tombstones before contacts: a stop in between keeps the delete, load() drops the
   * contact), and last the withdraw I owe. `confirms` stay.
   */
  async function removeContact(pk: PubkeyHex, at: number): Promise<void> {
    const c = contactOf(pk)
    if (!c) return
    dropRoundState(pk)
    // Everything but what only a contact has: all channel fields, also those added
    // later. A contact-only field (`via`) is named here.
    const { id: _id, pubkey: _pubkey, name: _name, createdAt: _createdAt, via: _via, ...channel } = c
    // A deletion ends an answer under way (answerEnd):
    // the tombstone starts as in a world where the peer never asked; the peer asks again.
    mem.tombstones[pk] = withChan({ ...channel, at }, answerEnd(channel))
    const reopening = { ...get().reopening }
    delete reopening[pk]
    set({ contacts: get().contacts.filter((x) => x.id !== pk), reopening })
    // A link scan of a contact is left over (load() drops them too); its room goes unless
    // the tombstone keeps it.
    const scan = mem.scans[pk]
    if (scan) {
      delete mem.scans[pk]
      cancel(linkTimers.get(pk))
      linkTimers.delete(pk)
      cancel(deadlineTimers.get(pk))
      deadlineTimers.delete(pk)
      // A holder scan's candidate rooms go too.
      dropCandidates(pk)
      forget(scan.groupId)
    }
    const rooms = { ...get().rooms }
    delete rooms[pk]
    // The trade guide step of this contact goes too.
    const hadSteps = get().tradeSteps[pk] !== undefined
    const tradeSteps = { ...get().tradeSteps }
    delete tradeSteps[pk]
    // Screen values about this contact (draft, linked profile) go with it,
    // and so does the open room it names (memo.place).
    const memoLeft = dropMemoOf(new Set([pk]))
    set({ matches: get().matches.filter((x) => x.contactId !== pk), rooms, tradeSteps })
    // tombstones before contacts: a stop in between never loses the deleted record.
    await save('tombstones')
    await Promise.all([
      save('contacts'),
      save('matches'),
      saveRoom(pk),
      ...(hadSteps ? [save('tradeSteps')] : []),
      ...(memoLeft ? [save('memo')] : []),
      ...(scan ? [save('scans')] : []),
    ])
    // A withdraw still owed goes last, to the deleted contact's room (told stays until a
    // relay took it). It looks to the peer exactly like me taking my offer down.
    syncOffer(pk)
  }

  async function deleteContact(id: PubkeyHex): Promise<void> {
    if (!contactOf(id)) return
    await removeContact(id, now())
    listChanged()
  }

  // ---------------------------------------------------------------- 3c. my contact list
  //
  // The phone is the list's source. An encrypted copy sits on the list relays
  // only; every open and every change compares each relay's copy with the phone and puts
  // the phone's list where it differs. A relay's copy is merged into the phone only once
  // after a restore (or a rebuild of the list): the first time that relay answers.

  /** The list relays; none (scripts without them) means no list sync at all. */
  const listRelays = deps.listRelays ?? []
  let listRun: Promise<void> | null = null
  /** A sync was asked for while one ran: one more run after it. */
  let listAgain = false
  /** The next run is the one the app's open started: only it may write support log lines. */
  let listLogNext = false
  const listRetry: { id: number | undefined; count: number } = { id: undefined, count: 0 }
  let listChangeTimer: number | undefined
  /** The last run did not end in "done" or "too big": a return to the app runs it again. */
  let listPending = false
  /** `relay|digest` this session already put (a relay that says yes and never serves it gets it once per session). */
  const sentThisSession = new Set<string>()
  /**
   * The start-time key-takeover check of this session: true when
   * this device was replaced. A list run may fetch and merge before it answers, but puts
   * nothing on the list relays until it said "not replaced": a phone restored elsewhere
   * must not write its old list over the new phone's.
   */
  let elsewhereGate: Promise<boolean> | null = null

  function listView(): ListView {
    return projection(get().contacts, mem.tombstones)
  }

  /** A contact was added, renamed or deleted: upload once, LIST_CHANGE_MS later. */
  function listChanged(): void {
    if (!listRelays.length || stopped) return
    cancel(listRetry.id)
    listRetry.id = undefined
    listRetry.count = 0
    if (listChangeTimer !== undefined) return
    listChangeTimer = later(LIST_CHANGE_MS, () => {
      listChangeTimer = undefined
      void syncList()
    })
  }

  /** One run at a time; a call during a run makes one more run after it. */
  function syncList(): Promise<void> {
    if (!listRelays.length) return Promise.resolve()
    if (listRun) {
      listAgain = true
      return listRun
    }
    const open = listLogNext
    listLogNext = false
    const s = session
    const run = runListSync(open, s)
      .catch((e: unknown) => debug('task-error', { error: e instanceof Error ? e.message : String(e) }))
      .finally(() => {
        if (listRun === run) listRun = null
        if (listAgain && s === session && !stopped) {
          listAgain = false
          void syncList()
        }
      })
    listRun = run
    return run
  }

  /** The end of a run: the support log event and the next retry. */
  function listEnd(result: 'same' | 'published' | 'unreachable' | 'partial' | 'too-big', open: boolean): void {
    debug('list-sync', { open, result })
    if (result === 'same' || result === 'published' || result === 'too-big') {
      cancel(listRetry.id)
      listRetry.id = undefined
      listRetry.count = 0
      listPending = false
      return
    }
    listPending = true
    if (listRetry.id !== undefined || listRetry.count >= LIST_RETRY_MS.length) return
    listRetry.id = later(LIST_RETRY_MS[listRetry.count++], () => {
      listRetry.id = undefined
      void syncList()
    })
  }

  /**
   * A pubkey that comes into this device by a merge (add, revive) ends a link in
   * progress with it as load() does: its link scan (not a holder's) and timers go, and
   * the scan's room unless something still uses it. ensureChannels opens the channel.
   */
  function dropLinkOf(pk: PubkeyHex): boolean {
    const scan = mem.scans[pk]
    if (!scan || scan.holder) return false
    delete mem.scans[pk]
    cancel(linkTimers.get(pk))
    linkTimers.delete(pk)
    cancel(deadlineTimers.get(pk))
    deadlineTimers.delete(pk)
    dropCandidates(pk)
    forget(scan.groupId)
    return true
  }

  /**
   * A merge plan applied to the phone: `add` makes a contact
   * without a room, `revive` moves the tombstone's channel fields into the contact,
   * `remove` is removeContact, `tombs` makes or ages a tombstone. Stores what changed,
   * then ensureChannels. True when anything changed.
   *
   * `mark` (a relay's first merge): moves that relay from
   * `listSync.pending` to `merged`; its write is queued with the merge's last write, so
   * no stop or lock between them can leave the merge stored and the relay still pending,
   * or the relay merged and the merge lost.
   */
  async function applyMerge(plan: MergePlan, mark?: () => void): Promise<boolean> {
    if (emptyPlan(plan)) {
      if (mark) {
        mark()
        await Promise.all([save('listAt'), save('listSync')])
      }
      return false
    }
    let scansChanged = false
    let contacts = get().contacts
    let tombs = { ...mem.tombstones }
    for (const x of plan.add) {
      if (contacts.some((c) => c.id === x.pk) || tombs[x.pk]) continue
      contacts = [...contacts, { id: x.pk, pubkey: x.pk, groupId: null, name: x.name, createdAt: x.createdAt }]
      scansChanged = dropLinkOf(x.pk) || scansChanged
    }
    for (const x of plan.revive) {
      const tb = tombs[x.pk]
      if (!tb || contacts.some((c) => c.id === x.pk)) continue
      const { at: _at, ...channel } = tb
      contacts = [...contacts, { ...channel, id: x.pk, pubkey: x.pk, name: x.name, createdAt: x.createdAt }]
      delete tombs[x.pk]
      scansChanged = dropLinkOf(x.pk) || scansChanged
    }
    for (const x of plan.tombs) {
      if (contacts.some((c) => c.id === x.pk)) continue
      const tb = tombs[x.pk]
      tombs = { ...tombs, [x.pk]: tb ? { ...tb, at: Math.max(tb.at, x.at) } : { groupId: null, at: x.at } }
    }
    mem.tombstones = tombs
    set({ contacts })
    // tombstones before contacts, as removeContact writes them. All queued at once:
    // the write chain keeps their order and a stop lets queued writes finish.
    const writes = [save('tombstones'), save('contacts'), ...(scansChanged ? [save('scans')] : [])]
    if (mark && !plan.remove.length) {
      mark()
      writes.push(save('listAt'), save('listSync'))
    }
    await Promise.all(writes)
    for (const x of plan.remove) await removeContact(x.pk, x.at)
    if (mark && plan.remove.length) {
      // After the last removal's writes (removeContact queues them before it returns).
      mark()
      await Promise.all([save('listAt'), save('listSync')])
    }
    ensureChannels()
    return true
  }

  /** One sync run. */
  async function runListSync(open: boolean, s: number): Promise<void> {
    const live = () => s === session && !stopped && !frozen && get().boot === 'ready' && transport !== null
    if (!live()) return
    const t = transport as Transport
    let fetch: ListFetch
    try {
      fetch = await t.fetchList()
    } catch {
      if (live()) listEnd('unreachable', open)
      return
    }
    if (!live()) return
    const nowMs = now()
    const nowS = Math.floor(nowMs / 1000)
    // Per relay: the readable copy and its digest. A copy dated past now + 1 day is not taken.
    const copies = new Map<string, ParsedCopy>()
    const per = new Map<string, string>()
    const future = new Set<string>()
    let seenMax = 0
    for (const copy of fetch.copies) {
      seenMax = Math.max(seenMax, copy.createdAt)
      if (copy.createdAt > nowS + LIST_AHEAD_S) {
        future.add(copy.relay)
        continue
      }
      const body = decodeList(copy.payload, me, nowMs)
      if (!body) {
        debug('list-copy-invalid', { open })
        continue
      }
      copies.set(copy.relay, { relay: copy.relay, body, createdAt: copy.createdAt })
      per.set(copy.relay, digest(body.c, body.d))
    }
    // First merge: only relays still pending since the restore, newest copy first.
    const pending = new Set(mem.listSync.pending)
    const firstNow = fetch.answered.filter((r) => pending.has(r))
    if (firstNow.length) {
      const ordered = [...firstNow].sort((a, b) => (copies.get(b)?.createdAt ?? -1) - (copies.get(a)?.createdAt ?? -1))
      for (const relay of ordered) {
        const copy = copies.get(relay)
        // The relay goes from pending to merged in the same write as its merge; a
        // relay that answered without a readable copy is merged with nothing.
        const mark = () => {
          if (copy) mem.listAt = Math.max(mem.listAt, copy.createdAt)
          mem.listSync = {
            merged: { ...mem.listSync.merged, [relay]: true },
            pending: mem.listSync.pending.filter((r) => r !== relay),
          }
        }
        await applyMerge(copy ? mergeInto(listView(), copy.body) : { add: [], revive: [], remove: [], tombs: [] }, mark)
        if (!live()) return
      }
    }
    const view = listView()
    const n = digest(view.c, view.d)
    if (n === EMPTY_DIGEST) {
      // Nothing to upload: a list never had anyone. Pending relays still wait for their merge.
      listEnd(mem.listSync.pending.length || fetch.asked.some((r) => !fetch.answered.includes(r)) ? 'partial' : 'same', open)
      return
    }
    const targets = fetch.answered.filter((r) => per.get(r) !== n && !sentThisSession.has(`${r}|${n}`))
    // A relay merged before this run holds a copy someone else wrote after mine.
    if (targets.some((r) => !firstNow.includes(r) && per.has(r) && (copies.get(r)?.createdAt ?? 0) > mem.listAt)) {
      debug('list-elsewhere')
    }
    let accepted: string[] = []
    if (targets.length && elsewhereGate) {
      // The key-takeover check first: a device another one replaced publishes nothing (its run ends here, and
      // the app stops with 'replaced').
      const replaced = await elsewhereGate
      if (replaced || !live()) return
    }
    if (targets.length) {
      let payload: string
      try {
        payload = encodeList({ v: 1, c: view.c, d: view.d })
      } catch {
        listEnd('too-big', open)
        return
      }
      const createdAt = Math.min(Math.max(nowS, seenMax + 1, mem.listAt + 1), nowS + LIST_AHEAD_S)
      try {
        accepted = await t.publishList(payload, createdAt, targets)
      } catch {
        accepted = []
      }
      if (!live()) return
      for (const r of accepted) sentThisSession.add(`${r}|${n}`)
      if (accepted.length) {
        mem.listAt = Math.max(mem.listAt, createdAt)
        await save('listAt')
      }
      if (targets.some((r) => future.has(r) && !accepted.includes(r))) debug('list-future')
    }
    const holders = new Set([...fetch.answered.filter((r) => per.get(r) === n), ...accepted])
    const allAnswered = fetch.asked.every((r) => fetch.answered.includes(r))
    const allTaken = targets.every((r) => accepted.includes(r))
    let result: 'same' | 'published' | 'unreachable' | 'partial'
    if (targets.length && !accepted.length && holders.size === 0) result = 'unreachable'
    else if (allAnswered && allTaken && holders.size >= LIST_HOLDERS_MIN) result = targets.length ? 'published' : 'same'
    else result = 'partial'
    if (result === 'partial' && holders.size === 1) debug('list-single')
    listEnd(result, open)
    // Changed while this ran: once more.
    const after = listView()
    if (digest(after.c, after.d) !== n) listAgain = true
  }

  /** The guide step I chose in a room; tradeView moves it on by itself only for a new card. */
  async function setTradeStep(contactId: PubkeyHex, step: TradeStep): Promise<void> {
    const offer = get().myOffer
    if (!contactOf(contactId) || !offer || !TRADE_STEPS[offer.side].includes(step)) return
    const view = tradeView(get(), contactId, now())
    set({ tradeSteps: { ...get().tradeSteps, [contactId]: { key: view.stepKey, step, card: view.activeCard } } })
    await save('tradeSteps')
  }

  async function setSettings(patch: Partial<Settings>): Promise<void> {
    const cur = get().settings
    // Throws 'too-few-relays' / 'too-many-relays' before anything changes.
    const relays =
      patch.relays === undefined ? cur.relays : patch.relays === null ? null : cleanRelayList(patch.relays, deps.relays)
    const next: Settings = {
      lang: asLang(patch.lang) ?? cur.lang,
      sort: patch.sort === 'amount' || patch.sort === 'fee' ? patch.sort : cur.sort,
      relockMinutes: asRelockMinutes(patch.relockMinutes) ?? cur.relockMinutes,
      relays,
      relayAuto: typeof patch.relayAuto === 'boolean' ? patch.relayAuto : cur.relayAuto,
      // Never from a patch: only setLightningAddress changes it, after its lookup.
      lnAddress: cur.lnAddress,
    }
    set({ settings: next })
    // Before unlock the change stays in memory (save writes nothing); load() saves it after unlock.
    if (!unlocked) {
      await save('settings')
      return
    }
    if (await save('settings')) return
    // Not stored: memory goes back to what is stored, so a later save of
    // another setting does not store this change after all. Only the fields this call
    // changed, and only where nothing changed them since.
    const now = get().settings
    const back = { ...now }
    for (const key of Object.keys(next) as (keyof Settings)[]) {
      if (next[key] !== cur[key] && now[key] === next[key]) (back as Record<keyof Settings, unknown>)[key] = cur[key]
    }
    set({ settings: back })
    throw new Error('save-failed')
  }

  // ============================================================== 5a. where the buyer receives

  /** Contacts with a sendPaymentRequest in flight (check 3, 'busy'). */
  const requesting = new Set<PubkeyHex>()

  /** An Error whose message is `code`; a 'range' one also says what the wallet takes. */
  function payError(code: string, range?: { minSats?: number; maxSats?: number }): Error {
    const e = new Error(code) as Error & { minSats?: number; maxSats?: number }
    if (range && typeof range.minSats === 'number' && typeof range.maxSats === 'number') {
      e.minSats = range.minSats
      e.maxSats = range.maxSats
    }
    return e
  }

  const LNURL_CODES = new Set<string>(['bad-address', 'unreachable', 'refused', 'range', 'mismatch'])
  /** A failure of the lookup module as one LnurlError code; anything else counts as unreachable. Nothing is logged. */
  function lnurlError(e: unknown): Error {
    const code = e instanceof Error && LNURL_CODES.has(e.message) ? e.message : 'unreachable'
    return payError(code, e as { minSats?: number; maxSats?: number })
  }

  /**
   * The matched seller's terms a request is checked against (checks 5 and 6), or why not.
   * Read again after the wait for an invoice (check 14).
   */
  function requestTerms(contactId: PubkeyHex, method: string): { offer: Offer; match: Match; tradeMinor: number } | string {
    const offer = get().myOffer
    if (offer?.side !== 'buy') return 'not_buyer'
    const match = get().matches.find((m) => m.contactId === contactId)
    if (!match || match.offer.currency !== offer.currency || match.offer.side === offer.side) return 'not_matched'
    const common = commonMethods(offer.methods, match.offer.methods)
    if (common.length === 0) return 'not_matched'
    if (!common.includes(method as PayMethod)) return 'method'
    return { offer, match, tradeMinor: Math.min(offer.amountMinor, match.offer.amountMinor) }
  }

  /** Checks 1 and 2: a ready engine and a contact whose room can carry messages now. */
  function requestRoomError(contactId: PubkeyHex): string | null {
    if (stopped || !writable() || get().boot !== 'ready') return 'not_ready'
    const c = contactOf(contactId)
    if (!c) return 'no_contact'
    if (roomUnusable(c.groupId)) return 'room-unreadable'
    return null
  }

  /**
   * Sending where I receive: checks 1 to 15 in order; a rejection sends
   * and stores nothing. The request goes out as an ordinary chat text (sendChat), so it
   * follows the chat's delivery rules and makes no support log line.
   */
  async function sendPaymentRequest(
    contactId: PubkeyHex,
    req: { method: 'lightning'; amountMinor: number } | { method: 'onchain'; amountMinor: number; address: string },
  ): Promise<void> {
    const roomErr = requestRoomError(contactId)
    if (roomErr) throw payError(roomErr)
    if (requesting.has(contactId)) throw payError('busy')
    requesting.add(contactId)
    try {
      const terms = requestTerms(contactId, req?.method)
      if (typeof terms === 'string') throw payError(terms)
      const { offer, match } = terms
      const amountMinor = req.amountMinor
      if (!isMinor(amountMinor)) throw payError('invalid_amount')
      if (amountMinor > terms.tradeMinor) throw payError('too_much')
      const rate = get().rates[offer.currency]
      if (rate === undefined) throw payError('no_rate')
      // The seller's premium: the seller's own amount
      // warning is computed at the same premium, so an honest request never trips it.
      const feePct = match.offer.feePct
      const sats = requestSats(amountMinor, offer.currency, rate, feePct)
      if (sats === null) throw payError('invalid_amount')

      let text: string
      if (req.method === 'onchain') {
        const parsed = parseAddress(typeof req.address === 'string' ? req.address : '')
        if (!parsed) throw payError('bad-address')
        // Never the same address twice in this room: a card of a finished trade stays grey
        // for good (settledIds), and reuse links trades. A text that failed to send never
        // reached the seller and does not count.
        const sentBefore = (get().rooms[contactId] ?? []).some(
          (m) =>
            m.mine &&
            m.kind === 'text' &&
            m.status !== 'failed' &&
            splitText(m.text).some((p) => p.ref?.kind === 'onchain' && p.ref.id === parsed.address),
        )
        if (sentBefore) throw payError('reused')
        text = bip21(parsed.address, sats)
      } else {
        const address = get().settings.lnAddress
        if (!address) throw payError('no_address')
        let invoice: string
        try {
          invoice = await deps.lnurl.invoice(address, sats)
        } catch (e) {
          throw lnurlError(e)
        }
        // Check 14: the terms may have moved while the wallet service answered.
        if (requestRoomError(contactId)) throw payError('changed')
        const now2 = requestTerms(contactId, req.method)
        if (
          typeof now2 === 'string' ||
          now2.offer.id !== offer.id ||
          amountMinor > now2.tradeMinor ||
          now2.match.offer.feePct !== feePct
        ) {
          throw payError('changed')
        }
        // The lookup module checked the invoice already; the text that goes out must still
        // be one mainnet card for exactly these sats that is not about to expire, or
        // nothing goes (defence in depth).
        const ref = invoice.length <= CHAT_MAX ? payRefOf(invoice) : null
        if (
          !ref ||
          ref.kind !== 'lightning' ||
          !ref.mainnet ||
          ref.amountSats !== sats ||
          ref.id !== invoice ||
          secondsLeft(ref.invoice, now()) <= EXPIRING_SOON_SECONDS
        ) {
          throw payError('mismatch')
        }
        text = invoice
      }
      await sendChat(contactId, text)
    } finally {
      requesting.delete(contactId)
    }
  }

  /** Setting my Lightning address: one successful lookup, then stored. */
  async function setLightningAddress(address: string | null): Promise<void> {
    let next: string | null = null
    if (address !== null) {
      const norm = deps.lnurl.parseAddress(typeof address === 'string' ? address : '')
      if (!norm) throw payError('bad-address')
      try {
        await deps.lnurl.check(norm)
      } catch (e) {
        throw lnurlError(e)
      }
      next = norm
    }
    const cur = get().settings
    if (cur.lnAddress === next) return
    set({ settings: { ...cur, lnAddress: next } })
    // Before unlock the value stays in memory and load() keeps it (as setSettings does).
    if (!unlocked) {
      await save('settings')
      return
    }
    if (await save('settings')) return
    // Not stored: memory goes back unless something changed it since.
    if (get().settings.lnAddress === next) set({ settings: { ...get().settings, lnAddress: cur.lnAddress } })
    throw new Error('save-failed')
  }

  // ============================================================== 5b. identity and lock

  function announce(): void {
    try {
      channel?.postMessage('identity')
    } catch {
      // closed
    }
  }

  function reauthOk(): boolean {
    return get().lock.method === 'none' || now() < reauthUntil
  }

  function setLock(patch: Partial<IlchonState['lock']>): void {
    set({ lock: { ...get().lock, ...patch } })
  }

  /** The lock method is one of three. PIN rules are checked by the store (checkPin), in one place. */
  function checkChoice(choice: LockChoice): void {
    if (!choice || (choice.method !== 'passkey' && choice.method !== 'pin' && choice.method !== 'none')) {
      throw new Error('invalid-choice')
    }
  }

  /** Error codes an unlock-failed line may carry; anything else is 'other'. */
  const UNLOCK_ERRORS = new Set([
    'wrong-pin', 'pin-wait', 'passkey-cancelled', 'passkey-confirm', 'prf-unsupported', 'corrupt', 'storage-unavailable', 'storage-damaged',
  ])

  /** A failed unlock or reauth: the wait may have changed, and the support log gets the code. */
  async function unlockFailed(e: unknown): Promise<void> {
    await refreshLock()
    const code = errCode(e)
    debug('unlock-failed', { errorKey: UNLOCK_ERRORS.has(code) ? code : 'other' })
  }

  /** Reads the lock record again for the PIN wait. Failures are swallowed. */
  async function refreshLock(): Promise<void> {
    try {
      const st = await storage.status()
      setLock({ waitUntil: st?.waitUntil ?? 0 })
    } catch {
      // the screen keeps the last value
    }
  }

  /** The proof the current lock asks for. */
  function proofFor(pin?: string): LockChoice {
    const method = get().lock.method
    if (method === 'passkey') return { method: 'passkey' }
    if (method === 'none') return { method: 'none' }
    return { method: 'pin', pin: typeof pin === 'string' ? pin : '' }
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

  /**
   * The words prepareIdentity showed and the key made from them, kept until
   * createIdentity stores them, so a retried passkey lock keeps the same words. Made
   * before the lock step: the key derivation never runs between the tap and the passkey.
   */
  let pendingNew: { words: string; secret: string } | null = null

  /**
   * Stores a new identity under a new lock. The first await is
   * storage.create, so a passkey ceremony runs straight from the tap. `entries` are
   * written with the identity before the lock record (the records a restore brings
   * back); the profile exists only once create() returns. `words` only for an
   * identity this app made.
   */
  async function establish(id: { sk: string; words?: string }, choice: LockChoice, entries: Record<string, unknown> = {}): Promise<void> {
    // When this device made or restored the key (unix s): the key-takeover check compares other devices' key packages with it.
    const createdAt = Math.floor(now() / 1000)
    const tb = await storage.create(choice, async (t) => {
      await t.kv.set('identity', id.words ? { v: 1, sk: id.sk, words: id.words, createdAt } : { v: 1, sk: id.sk, createdAt })
      for (const [k, v] of Object.entries(entries)) await t.kv.set(k, v)
    })
    reauthUntil = now() + REAUTH_MS
    setLock({ method: choice.method, waitUntil: 0 })
    announce()
    await afterUnlock(tb)
  }

  /**
   * The store is open: read everything, then the identity, then go online. Reading
   * and writing the engine KV happens only from here on.
   */
  async function afterUnlock(tb: Tables): Promise<void> {
    tables = tb
    kv = tb.kv
    unlocked = true
    // A stop() while the store is read ends this start: nothing may open afterwards (a
    // power-off during the boot, found by S-CH-CRASH-MOVE).
    const s = session
    let id: Identity
    let place: 'app' | 'identity' = 'app'
    try {
      await load()
      place = 'identity'
      id = readIdentity(await kv.get('identity'))
    } catch (e) {
      const code = errCode(e)
      if (code === 'storage-damaged') debug('storage-damaged', { errorKey: place })
      else if (code === 'storage-unavailable') debug('storage-unavailable', {})
      return fail(e)
    }
    if (s !== session) return
    // This device saw its key restored on another one and stopped for good.
    // It stays stopped, before going online, until a reset and a restore here.
    let replaced = false
    try {
      replaced = (await kv.get('replaced')) === true
    } catch {
      replaced = false
    }
    if (s !== session) return
    if (replaced) return fail(new Error('replaced'))
    words = id.words ?? ''
    set({ hasWords: words !== '' })
    // An identity stored without a creation time gets its time now.
    if (id.createdAt === undefined) {
      id = { ...id, createdAt: Math.floor(now() / 1000) }
      const stored = id
      void persist('identity', 'identity', () =>
        kv.set('identity', stored.words ? { v: 1, sk: stored.sk, words: stored.words, createdAt: stored.createdAt } : { v: 1, sk: stored.sk, createdAt: stored.createdAt }),
      )
    }
    identityAt = id.createdAt ?? 0
    await openIdentity(id.sk)
  }

  /** The 12 words of a new identity: the same ones until the page reloads or createIdentity succeeds. */
  function prepareIdentity(): string[] {
    if (get().boot !== 'setup') throw new Error('not-allowed')
    pendingNew ??= (() => {
      const w = newMnemonic()
      return { words: w, secret: secretFromMnemonic(w) }
    })()
    return pendingNew.words.split(' ')
  }

  function createIdentity(choice: LockChoice): Promise<void> {
    return exclusive('setup', async () => {
      checkChoice(choice)
      const p = pendingNew
      if (!p) throw new Error('not-prepared')
      // Nothing may await before storage.create: a passkey create() needs the tap's user activation.
      await establish({ sk: p.secret, words: p.words }, choice)
      if (pendingNew === p) pendingNew = null
    })
  }

  /**
   * The words checkMnemonic accepted, the key made from them and the list copies the
   * list relays gave then, kept until restoreIdentity stores them (the words never are).
   */
  let pendingRestore: { words: string; secret: string; copies: ParsedCopy[]; answered: string[] } | null = null

  /**
   * Restore, step 1: the words are checked, the key is made, my list is
   * looked for on the list relays. Nothing is stored. The support log gets only ok,
   * network or invalid, never whether a list was found.
   */
  function checkMnemonic(text: string): Promise<{ found: boolean }> {
    return exclusive('setup', async () => {
      pendingRestore = null
      const w = normalizeWords(typeof text === 'string' ? text : '')
      let secret: string
      try {
        secret = secretFromMnemonic(w)
      } catch {
        debug('restore-check', { result: 'invalid' })
        throw new Error('invalid-mnemonic')
      }
      let fetched: ListFetch
      try {
        if (!listRelays.length) throw new Error('no list relays')
        fetched = await marmot.findList({ secretKeyHex: secret, relays: listRelays })
      } catch {
        debug('restore-check', { result: 'network' })
        throw new Error('network')
      }
      if (get().boot !== 'setup') throw new Error('not-allowed')
      const nowMs = now()
      const mine = marmot.pubkeyOf(secret)
      const copies: ParsedCopy[] = []
      for (const copy of fetched.copies) {
        // A copy dated past now + 1 day is not taken.
        if (copy.createdAt > Math.floor(nowMs / 1000) + LIST_AHEAD_S) continue
        const body = decodeList(copy.payload, mine, nowMs)
        if (body) copies.push({ relay: copy.relay, body, createdAt: copy.createdAt })
      }
      pendingRestore = { words: w, secret, copies, answered: [...fetched.answered] }
      debug('restore-check', { result: 'ok' })
      return { found: copies.length > 0 }
    })
  }

  /**
   * Restore, step 2: the key and the list found by checkMnemonic are stored in one create,
   * so no device has a key without its list. The list is every copy merged into an
   * empty list, newest first; the relays that answered then count as merged, the others
   * stay pending for their first merge. The words are not stored.
   */
  function restoreIdentity(text: string, choice: LockChoice): Promise<void> {
    return exclusive('setup', async () => {
      checkChoice(choice)
      const w = normalizeWords(typeof text === 'string' ? text : '')
      const p = pendingRestore
      if (!p || p.words !== w) throw new Error('not-checked')
      let view: ListView = { c: [], d: [] }
      for (const copy of [...p.copies].sort((a, b) => b.createdAt - a.createdAt)) view = applyPlanTo(view, mergeInto(view, copy.body))
      const contacts: Contact[] = view.c.map(([pk, name, createdAt]) => ({ id: pk, pubkey: pk, groupId: null, name, createdAt }))
      const tombstones: Record<PubkeyHex, Tombstone> = {}
      for (const [pk, at] of view.d) tombstones[pk] = { groupId: null, at }
      const merged: Record<string, true> = {}
      for (const r of listRelays) if (p.answered.includes(r)) merged[r] = true
      const entries: Record<string, unknown> = {
        contacts,
        tombstones,
        listAt: Math.max(0, ...p.copies.map((x) => x.createdAt)),
        listSync: { merged, pending: listRelays.filter((r) => !p.answered.includes(r)) } satisfies ListSync,
      }
      // Nothing may await before storage.create: a passkey create() needs the tap's user activation.
      // The checked words stay until the store succeeds, so a cancelled or failed lock
      // (a passkey ceremony) can be tried again without a new check (as createIdentity).
      await establish({ sk: p.secret }, choice, entries)
      if (pendingRestore === p) pendingRestore = null
    })
  }

  /**
   * Key takeover: my key's packages show another device that
   * took the key after this one did. This device then stops for good, now and at every
   * later open, until it is reset and restored here. The key elsewhere is not told apart
   * from a thief's.
   */
  async function checkElsewhere(ownSlotOnly = false): Promise<boolean> {
    const t = transport
    const s = session
    if (!t || stopped || get().boot !== 'ready' || !identityAt) return false
    let hit = false
    try {
      hit = await t.keyUsedElsewhere(identityAt, { ownSlotOnly })
    } catch {
      hit = false
    }
    if (!hit || s !== session || stopped || transport !== t || get().boot !== 'ready') return false
    debug('key-elsewhere')
    await persist('replaced', 'replaced', () => kv.set('replaced', true))
    await fail(new Error('replaced')).catch(() => {})
    return true
  }

  /** The words again, only on an identity this app made, only right after the lock was proven. */
  function revealMnemonic(): string[] {
    if (get().boot !== 'ready' || !words) throw new Error('not-allowed')
    if (!reauthOk()) throw new Error('reauth-required')
    return words.split(' ')
  }

  function unlock(pin?: string): Promise<void> {
    return exclusive('locked', async () => {
      // The first await reaches the store (a passkey get() needs the tap).
      let tb: Tables
      try {
        tb = await storage.unlock(proofFor(pin))
      } catch (e) {
        await unlockFailed(e)
        throw e
      }
      reauthUntil = now() + REAUTH_MS
      setLock({ waitUntil: 0 })
      await afterUnlock(tb)
    })
  }

  /** Proves the current lock again. The passkey get() runs straight from the tap; a PIN counts like unlock. */
  function reauth(pin?: string): Promise<void> {
    return exclusive('ready', async () => {
      if (!sk) throw new Error('not-allowed')
      if (get().lock.method !== 'none') {
        try {
          await storage.verify(proofFor(pin))
        } catch (e) {
          await unlockFailed(e)
          throw e
        }
        setLock({ waitUntil: 0 })
      }
      reauthUntil = now() + REAUTH_MS
    })
  }

  function reauthed(): boolean {
    return get().boot === 'ready' && !!sk && reauthOk()
  }

  /** Locks the same data key with another lock. Data is not rewritten. */
  function changeLock(choice: LockChoice): Promise<void> {
    return exclusive('ready', async () => {
      checkChoice(choice)
      if (!sk) throw new Error('not-allowed')
      if (!reauthOk()) throw new Error('reauth-required')
      await storage.relock(choice)
      setLock({ method: choice.method, waitUntil: 0 })
      announce()
      reauthUntil = now() + REAUTH_MS
    })
  }

  /**
   * Engine.memo: the screens' small values, encrypted with the rest.
   * A key about a contact (`…:<64 hex>`) is refused once that contact is gone: a screen
   * still open on a removed contact (a draft typed into its room) cannot put back what
   * removeContact took away.
   */
  const memo: Memo = {
    get<T>(key: string): T | undefined {
      return unlocked ? (mem.memo[key] as T | undefined) : undefined
    },
    set(key, value) {
      if (!unlocked || frozen) return false
      const about = /:([0-9a-f]{64})$/.exec(key)?.[1]
      if (about !== undefined && !contactOf(about as PubkeyHex)) return false
      mem.memo = { ...mem.memo, [key]: value }
      void save('memo')
      return true
    },
    del(key) {
      if (!unlocked || frozen) return false
      if (!(key in mem.memo)) return true
      const next = { ...mem.memo }
      delete next[key]
      mem.memo = next
      void save('memo')
      return true
    },
  }

  // ============================================================== 6. incoming, boot, stop, reset

  /**
   * A received message. The promise fulfils once the message is handled
   * and that is stored (`seen` last), and the transport then drops it from its inbox.
   * It rejects, so the message comes again at the next start, when the engine stopped
   * before handling it, when a write failed or ran out of time meanwhile, or when the
   * sender's queue is full. Handling it twice gives the same result (the handler
   * guards).
   */
  function onMessage(m: IncomingMessage): Promise<void> {
    // No room check here: each handler goes by the contact's, the tombstone's or the
    // scan's room, and what they drop is handled (it leaves the inbox).
    if (m.senderPubkey === me || seenSet.has(m.id)) return Promise.resolve()
    // The time of the hand-over, for the catch-up batch (peerRecord): the transport hands a
    // batch over in one go, and its handling may wait behind sends in the contact's queue.
    deliveredAt.set(m, now())
    // The peer spoke in the room I made and it has not joined visibly
    // (its self-update may have failed); that counts as joined.
    const ch = chanOf(m.senderPubkey)
    if (ch?.pending && ch.groupId === m.groupId && !seenIn.has(m.groupId)) {
      seenIn.add(m.groupId)
      const from = m.senderPubkey
      void enqueue(from, () => channelStep(from))
    }
    // The peer's own clock in this room, for stale requests.
    notePeerSpoke(m)
    noteRoomWorked(m.senderPubkey, m.groupId, m.msg.t)
    if (stopped) return Promise.reject(new Error('stopped'))
    // Handled only in the session it came in: after a stop (also a stop and a start of
    // this same engine) it stays in the inbox, and the next session gets it again.
    const s = session
    return new Promise<void>((resolve, reject) => {
      const keep = (why: 'stopped' | 'persist' | 'full'): void => {
        debug('inbox-kept', { why })
        reject(new Error(why))
      }
      if (enqueue.size(m.senderPubkey) >= QUEUE_MAX) return keep('full')
      void enqueue(m.senderPubkey, async () => {
        if (stopped || s !== session) return keep('stopped')
        if (seenSet.has(m.id)) return resolve()
        const fails = persistFails
        try {
          await handle(m)
        } catch (e) {
          debug('task-error', { peer: short(m.senderPubkey), error: e instanceof Error ? e.message : String(e) })
        }
        // Every write the handler queued has ended (each one is bounded).
        await writeChain
        if (s !== session) return keep('stopped')
        if (persistFails !== fails) return keep('persist')
        // Only now: an earlier `seen` write must not carry this id before its results.
        remember(m.id)
        if (!(await save('seen'))) return keep('persist')
        resolve()
      })
    })
  }

  async function handle(m: IncomingMessage): Promise<void> {
    const msg = m.msg
    debug('rx', { t: String(msg.t), from: short(m.senderPubkey) })
    // A refusal is not a sign of life: it neither cuts the backoff short nor ends a run
    // of refusals. Anything else does both.
    if (msg.t !== 'mx') {
      mxStreak.delete(m.senderPubkey)
      heardFrom(m.senderPubkey)
    }
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
    for (const c of CURRENCIES) {
      const v = fresh[c]
      if (typeof v === 'number' && Number.isFinite(v) && v > 0) next[c] = v
    }
    if (CURRENCIES.some((c) => next[c] !== undefined)) {
      next.at = typeof fresh.at === 'number' ? fresh.at : now()
    }
    set({ rates: next })
  }

  const unsubs: Unsub[] = []
  let stopRates: (() => void) | undefined
  let starting: Promise<void> | null = null

  let passkeyChecked = false

  /**
   * Reads only the lock record, then stops in 'setup' (nothing stored) or 'locked'
   * (waiting for unlock), or opens a lock-free profile (development and Node). No
   * engine data is read before the store is unlocked.
   */
  async function boot(): Promise<void> {
    stopped = false
    halted = false
    set({ boot: 'starting', bootError: undefined })
    if (!passkeyChecked) {
      passkeyChecked = true
      void storage
        .passkeySupported()
        .catch(() => false)
        .then((ok) => setLock({ passkeySupported: ok }))
    }
    let st: LockStatus | null
    try {
      st = await storage.status()
    } catch (e) {
      const code = errCode(e)
      // Data of another format is never read: wipe and start over.
      if (code === 'storage-format') return wipe('format')
      if (code === 'storage-damaged') debug('storage-damaged', { errorKey: 'lock' })
      else if (code === 'storage-unavailable') debug('storage-unavailable', {})
      return fail(e)
    }
    if (!st) {
      if (!deps.autoIdentity) {
        setLock({ method: null, waitUntil: 0 })
        set({ boot: 'setup' })
        return
      }
      try {
        const w = newMnemonic()
        await establish({ sk: secretFromMnemonic(w), words: w }, { method: 'none' })
      } catch (e) {
        // A stop() during the wait for relays is not a boot error.
        if (stopped || get().boot === 'error') throw e
        return fail(e)
      }
      return
    }
    setLock({ method: st.method, waitUntil: st.waitUntil })
    if (st.method !== 'none') {
      set({ boot: 'locked' })
      return
    }
    let tb: Tables
    try {
      tb = await storage.unlock({ method: 'none' })
    } catch (e) {
      return fail(e)
    }
    await afterUnlock(tb)
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
    halted = false
    set({ boot: 'starting', bootError: undefined })
    try {
      if (!tables) throw new Error('locked')
      sk = secret
      me = marmot.pubkeyOf(sk)
      set({ me: { pubkey: me, npub: marmot.npubOf(me) } })

      // My chosen relays, or the defaults; with my own relays and automatic switching
      // on, the defaults are the fallback.
      const chosen = get().settings
      const t = marmot.createTransport({
        secretKeyHex: sk,
        relays: chosen.relays ?? deps.relays,
        fallbackRelays: chosen.relays && chosen.relayAuto ? deps.relays : undefined,
        lookupRelays: deps.lookupRelays,
        // My contact list lives on its own relays.
        ...(listRelays.length ? { listRelays } : {}),
        namespace: deps.namespace,
        persistence: deps.persistence,
        tables,
      })
      transport = t
      // The connection screen's "no relay" check needs the list while starting.
      set({ relays: t.relayStatus(), fallingBack: false })
      let relayDown = false
      // Listeners go on before start so relay backfill is not missed.
      unsubs.push(
        t.onRelayStatus((relays) => {
          set({ relays, fallingBack: t.fallingBack() })
          if (!relays.some((r) => r.connected)) relayDown = true
          else if (relayDown) {
            relayDown = false
            if (get().boot === 'ready') later(RECONNECT_SETTLE_MS, onReconnected)
          }
        }),
        t.onInvite(onInvite),
        t.onMessage(onMessage),
        // A room that went missing, unreadable or stranded is reopened.
        t.onGroupHealth(healthChanged),
        // My KeyPackage was replaced (a rotation after a join): the QR names the new one now.
        t.onKeyPackageRef(refreshQrKp),
      )
      // Holder scans are armed once the transport is ready (resumeAfterBoot).
      for (const scan of Object.values(mem.scans)) if (!holderLike(scan)) armLinkTimeout(scan.pk, scan.at)

      void refreshRates()
      const ticker = setInterval(() => void refreshRates(), RATES_EVERY_MS)
      stopRates = () => clearInterval(ticker)

      // Waits as long as there is no connection; rejects only for a local failure
      // or a stop.
      await t.start()
      set({ boot: 'ready', relays: t.relayStatus(), fallingBack: t.fallingBack() })
      debug('ready', { me: short(me) })
      resumeAfterBoot()
      void cleanupRooms(t)
      // Channels: after the waiting Welcomes came in, then every CHANNEL_CHECK_MS.
      later(CHANNEL_BOOT_DELAY_MS, ensureChannels)
      armChannelCheck()
    } catch (e) {
      // A reset or stop() ended the wait: not a boot error, nothing to show.
      if (stopped) throw e
      return fail(e)
    }
  }

  /**
   * Boot cleanup: this device keeps only the rooms of contacts, tombstones
   * and links in progress. A room with a known peer is judged in that peer's queue, so
   * it never races a link or a move of the same peer; a room that could not be loaded
   * goes when nothing uses it (a used one stays until its channel is reopened).
   */
  async function cleanupRooms(t: Transport): Promise<void> {
    let list: { groupId: string; peerPubkey: PubkeyHex | null }[]
    try {
      list = await t.listGroups()
    } catch {
      return
    }
    const drop = (groupId: string) => t.forgetGroup(groupId).catch(() => debug('forget-failed'))
    for (const { groupId, peerPubkey } of list) {
      if (stopped || transport !== t) return
      if (peerPubkey === null) {
        if (!roomReferenced(groupId)) void drop(groupId)
        continue
      }
      void enqueue(peerPubkey, async () => {
        if (stopped || transport !== t || isLiveRoom(peerPubkey, groupId)) return
        await drop(groupId)
      })
    }
  }

  /** My relays came back while the app was open: what waited for them goes again. */
  function onReconnected(): void {
    if (stopped || get().boot !== 'ready') return
    debug('reconnected')
    rearmRounds()
  }

  /** Work that was waiting in memory when the app last stopped. */
  function resumeAfterBoot(): void {
    const t = now()
    // The backlog (Welcomes and hellos that waited) comes in first; until then
    // holder scans and codes stay and their ages go by the messages' own times.
    noteReturn(true)
    for (const scan of Object.values(mem.scans)) {
      if (!holderLike(scan)) continue
      armLinkTimeout(scan.pk, scan.at)
      armDeadline(scan)
    }
    for (const pk of [...get().contacts.map((c) => c.id), ...Object.keys(mem.tombstones)]) {
      if (chanOf(pk)?.noticeAfter !== undefined) armNotice(pk)
    }
    let changed = false
    for (const [pk, c] of Object.entries(mem.confirms)) {
      // Kept for a tombstone too: the peer sees the same repeats as from a contact.
      if (t - c.at > repliedLinkTtlMs || chanOf(pk)?.groupId !== c.groupId) {
        delete mem.confirms[pk]
        changed = true
        continue
      }
      // The invitee may still be waiting for it; a repeat is harmless but shows
      // I am online, so only a limited number of times.
      if ((c.resends ?? 0) >= LINK_RESEND_MAX) continue
      c.resends = (c.resends ?? 0) + 1
      changed = true
      sendLater(pk, c.groupId, () => ({ t: 'hello', v: 1, code: c.code }))
    }
    if (changed) void save('confirms')
    // Invitee: my reply may never have reached the inviter, or its confirmation
    // came while I was away. Repeating the reply makes the inviter confirm again.
    // A shaped link sends what a holder sends, and a holder repeats nothing at a start
    // (a repeated reply here would tell a deleter from a contact).
    for (const scan of Object.values(mem.scans)) {
      // A deleter's relink (tomb/L) whose room was bound but the scan's own write was cut
      // off: the link follows the channel as bindRoom does, and its hello goes again.
      const tb = mem.tombstones[scan.pk]
      if (scan.inviter && !holderLike(scan) && !scan.groupId && tb?.groupId && (tb.roomAt ?? 0) >= scan.at && t - scan.at <= linkTimeoutMs) {
        const room = tb.groupId
        scan.groupId = room
        scan.sentAt = tb.roomSentAt
        void save('scans')
        sendLater(scan.pk, room, () => (mem.scans[scan.pk] === scan ? { t: 'hello', v: 1, code: scan.code } : null))
        resendHello(scan, room, 0)
        continue
      }
      if (holderLike(scan) || scan.inviter || contactOf(scan.pk)) continue
      if (scan.replied && scan.groupId) askAgain(scan, scan.groupId, scan.code)
      // A lacking H still waiting for its room: the request timers lived in memory only.
      else if (now() - scan.at <= linkTimeoutMs) armRequests(scan)
    }
    // A completion whose deduction a crash cut off.
    doneChain = doneChain.then(finishDeducts, finishDeducts)
    // Initiators surviving reload have no persisted outbox to carry m1.
    for (const [sid, s] of Object.entries(mem.init)) {
      if (mem.roundOwner[s.contactId] === `i:${sid}` &&
        ![...outbox.values()].some((box) => box.items.some((it) => it.msg.t === 'm1' && it.msg.sid === sid))) {
        recoverInit(s.contactId, sid)
      }
    }
    const offer = get().myOffer
    for (const [pk, d] of Object.entries(mem.deferred)) {
      if (offer && offer.id === d.offerId && contactOf(pk)) armDeferred(pk, d, budgetFreeAt(pk) || t)
    }
    // State signals the last session could not deliver (after trade's
    // finishDeducts, before recovery's syncList).
    resendDelay = resendBaseMs
    const reconfirming = offer ? Object.keys(mem.verified).filter((pk) => mem.verified[pk] === offer.id) : []
    // A reconfirm round is a repeat: these contacts were counted as answered already.
    for (const pk of reconfirming) progressOf.set(pk, 'answered')
    resendPending()
    // Every stored match is checked again when the app opens.
    for (const pk of reconfirming) reconfirm(pk, 'resume')
    // Last: my contact list against the relays' copies. Only this run may write a
    // support log line.
    // The key-takeover check: in the background, never holding up the
    // start. The list run below may fetch and merge meanwhile; its upload waits for this.
    elsewhereGate = checkElsewhere()
    listLogNext = true
    void syncList()
  }

  /** Contact -> when a return to the app last re-armed its round. In memory only. */
  const returnRearmedAt = new Map<PubkeyHex, number>()

  /**
   * A waiting round may sit behind a long backoff built up while the app was
   * away. Re-arm it as boot does. Only rounds already waiting for the current
   * offer move, and the round budget still applies, so this opens no new
   * comparison and tells a contact nothing a round would not. Pending state
   * signals (told) go first: they go only to contacts that matched or saw my offer.
   * Last, matched contacts get a reconfirm round, at most every 10 minutes each.
   */
  function rearmRounds(): void {
    if (stopped || get().boot !== 'ready') return
    // A list that did not reach two relays goes again whenever the app is seen again.
    if (listPending) void syncList()
    // Back in view or reconnected: the backlog comes first, also for a holder's
    // deadline that comes due meanwhile: it waits for resumeUntil as at a start.
    // One return fires several signals (late timers, the debounced visibility event, the
    // reconnect after it settles); backAt keeps the first, so it moves only when no
    // return window is open. Each signal waits HOLDER_RESUME_GRACE_MS more, but the window
    // closes at most RESUME_WINDOW_MAX_MS after backAt (a flapping relay).
    noteReturn()
    for (const scan of Object.values(mem.scans)) {
      if (holderLike(scan) && deadlineTimers.has(scan.pk)) armDeadline(scan)
    }
    // Pending state signals go again, with or without an offer (a withdraw is owed
    // exactly when there is none).
    resendDelay = resendBaseMs
    resendPending()
    const offer = get().myOffer
    const t = now()
    // Only the waiting rounds need an offer; the channels below never do.
    if (offer) {
      for (const [pk, d] of Object.entries(mem.deferred)) {
        if (offer.id !== d.offerId || !contactOf(pk)) continue
        const last = returnRearmedAt.get(pk)
        if (last !== undefined && t - last < RETURN_REARM_FLOOR_MS) continue
        returnRearmedAt.set(pk, t)
        armDeferred(pk, d, budgetFreeAt(pk) || t)
      }
      // Matched contacts are checked again, at most once per reconfirmFloorMs each.
      for (const [pk, id] of Object.entries(mem.verified)) if (id === offer.id) reconfirm(pk, 'resume')
    }
    // After the waiting rounds and the app-open reconfirm rounds, the channels.
    ensureChannels()
  }

  async function shutdown(): Promise<void> {
    stopped = true
    session++
    for (const stopTimer of timers.values()) stopTimer()
    timers.clear()
    syncing.clear()
    again.clear()
    echoed.clear()
    reconfirmedAt.clear()
    resendTimer = undefined
    linkTimers.clear()
    deadlineTimers.clear()
    noticeTimers.clear()
    candidates.clear()
    deferTimers.clear()
    listChangeTimer = undefined
    listRetry.id = undefined
    listRetry.count = 0
    listAgain = false
    listLogNext = false
    // A run of the old session may still be awaiting: the next session starts its own.
    listRun = null
    listPending = false
    elsewhereGate = null
    sentThisSession.clear()
    // Welcomes not decided yet were never marked read: the next start gets them again, also
    // when this same engine starts again, so they are no longer "handled".
    for (const b of buffered.values()) handledInvites.delete(b.invite.id)
    for (const p of pendingMoves.values()) handledInvites.delete(p.invite.id)
    buffered.clear()
    pendingMoves.clear()
    requested.clear()
    requestedMet.clear()
    // Memory only, like requested: after a stop and a start of this same engine
    // (a lock and unlock, fail() at boot) a text read back as 'failed' raises no line, and no
    // catch-up batch goes on from before. An answer under way is stored (answerFrom):
    // its retry after a start is still an answer while my room works.
    textFailedAt.clear()
    roomWorked.clear()
    lastBatch.clear()
    offerMsgAt.clear()
    set({ reopening: {} })
    chanTimers.clear()
    seenIn.clear()
    healthTimer = undefined
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

  /** A reset began deleting; a retry must finish it. */
  let resetStarted = false
  /**
   * Why the reset that began was started. A retry (actions.resetAll on the
   * 'reset-failed' screen) finishes it for the same reason: a format wipe the user
   * never asked for stays a format wipe (it keeps the support log).
   */
  let resetReason: 'user' | 'format' = 'user'

  /** A reset that could not delete the store: no way back to the normal UI. */
  function resetFailed(): never {
    debug('reset-failed')
    set({ boot: 'error', bootError: 'reset-failed' })
    throw new Error('reset-failed')
  }

  /**
   * Deletes everything: 'user' is the reset the user asked for (actions.resetAll),
   * 'format' the boot-time wipe of data stored in another format. The whole profile
   * store goes at once, so no key is needed and it works while locked.
   */
  async function wipe(reason: 'user' | 'format'): Promise<void> {
    resetStarted = true
    resetReason = reason
    frozen = true
    await shutdown()
    await writeChain.catch(() => {})
    sk = ''
    words = ''
    identityAt = 0
    pendingNew = null
    pendingRestore = null
    set({ hasWords: false })
    me = ''
    reauthUntil = 0
    unlocked = false
    kv = LOCKED_KV
    tables = null
    mem.memo = {}
    let ok = true
    try {
      await storage.wipe()
    } catch {
      ok = false
    }
    announce()
    if (!ok) resetFailed()
    try {
      await hooks.onReset?.({ reason })
    } catch {
      resetFailed()
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
    setTradeStep,
    sendPaymentRequest,
    setLightningAddress,
    setSettings,
    // After a failed reset this retries it for the reason it began with.
    resetAll: () => wipe(resetStarted ? resetReason : 'user'),
    prepareIdentity,
    createIdentity,
    checkMnemonic,
    restoreIdentity,
    revealMnemonic,
    unlock,
    reauth,
    reauthed,
    changeLock,
  }

  return {
    store,
    actions,
    memo,
    start: () => (starting ??= boot()),
    rearmRounds,
    sizes() {
      const per = new Map<string, number>()
      for (const x of Object.values(mem.resp)) per.set(x.contactId, (per.get(x.contactId) ?? 0) + 1)
      const cand = [...candidates.values()].reduce((n, c) => n + c.rooms.length, 0)
      return { resp: Object.keys(mem.resp).length, respPerSender: Math.max(0, ...per.values()), buffered: buffered.size, candidates: cand, notices: noticesDue }
    },
    async stop() {
      channel?.close()
      await shutdown()
      // Writes queued before this point finish; halted is set inside the chain, so a
      // write queued by a handler still running after stop() meets it (no gap of
      // microtasks between the last write and the flag).
      writeChain = writeChain
        .catch(() => {})
        .then(() => {
          halted = true
        })
      await writeChain
      starting = null
    },
  }
}
