/**
 * ilchon — shared contracts.
 *
 * This file is the single source of truth for module boundaries. Every module
 * codes against these types. Do not change a signature here without updating
 * every consumer.
 *
 * Module map
 *   src/lib/marmot/   Transport            real Marmot over Nostr relays (marmot-ts)
 *   src/lib/match/    MatchCrypto          private side+currency+method matching, two slots per round
 *   src/lib/connect/  connect payload      one-time QR codes
 *   src/lib/rates/    RatesSource          BTC price in KRW, USD and JPY
 *   src/lib/money/    money helpers        integer minor units: check, format, parse, sats conversion
 *   src/lib/kv/       KV                   memory KV for tests
 *   src/lib/store/    ProfileStorage       encrypted IndexedDB (or memory) for one profile
 *   src/lib/vault/    lock keys            lock keys: passkey PRF, PIN
 *   src/lib/seed/     (functions)          12 words: BIP-39 English, NIP-06 key (account 4242); imported by the engine
 *   src/lib/pwa/      PWA helpers          install hint, standalone, storage persistence
 *   src/lib/bolt11/   invoice reader       BOLT11 amount, expiry, network, description hash; no signature check
 *   src/lib/pay/     payment requests     payment request tokens in chat text (BOLT11 and on-chain)
 *   src/lib/lnurl/    LnurlModule          Lightning address -> validated invoice (LUD-16, LUD-06), no proxy
 *   src/lib/onchain/  on-chain helpers     mainnet address check, bitcoin: links (BIP-21)
 *   src/lib/relays/   relay list rules     normalize and validate a relay list, NIP-11 pre-flight check
 *   src/engine/       Engine               all app logic, no DOM, runs in Node too
 *   src/engine/trade.ts  trade rules      trade bounds and the trade room view, derived from Engine state
 *   src/engine/relock.ts auto-lock         when the app locks again (time out of view, Settings.relockMinutes)
 *   src/i18n/         strings            registerStrings, t(); lang.ts offered languages, detect.ts first language
 *   src/ui/           design kit           Coconut design tokens + components
 *   src/screens/      screens              React, reads Engine state only
 */

// ---------------------------------------------------------------- basics

export type Side = 'buy' | 'sell'
/** Trade currencies, in display order. Adding one breaks every Record<Currency, …> until it is filled. */
export const CURRENCIES = ['KRW', 'USD', 'JPY'] as const
export type Currency = (typeof CURRENCIES)[number]
/** Screen languages. Which ones are offered is src/i18n/lang.ts (offeredLangs, JA_STAGE). */
export const LANGS = ['ko', 'en', 'ja'] as const
export type Lang = (typeof LANGS)[number]
export type SortMode = 'amount' | 'fee'
export type Unsub = () => void

/** Lowercase hex, 64 chars. */
export type PubkeyHex = string

export const APP_NAME = 'ilchon'
/**
 * Public relays from four different operators that passed real Marmot tests
 * on 2026-11-07 (KeyPackage, invite and join, group messages both ways, a
 * 39 KB Welcome, 60 subscriptions).
 * Users may replace them in Settings → Advanced (Settings.relays); they then
 * become the fallback while none of the chosen relays work.
 */
export const DEFAULT_RELAYS = ['wss://relay.coinos.io', 'wss://nostr.mom', 'wss://nostr.21crypto.ch', 'wss://relay.us.whitenoise.chat']

/**
 * Indexer relays: my kind 10002/10050 lists are also published here, and a
 * peer's lists are looked up here too, so two people whose relay lists do not
 * overlap can still find each other (NIP-65 outbox model).
 */
export const LOOKUP_RELAYS = ['wss://purplepag.es']

/**
 * Where my encrypted contact list goes, and only there: public relays
 * from four different operators that took a stranger's 44 KB kind 30078 event without
 * auth, served it back at once and held kind 30078 events older than 7 days
 * (tested 2026-11-14). Separate from DEFAULT_RELAYS,
 * which carry the chats and stay as they are; no setting changes these.
 */
export const LIST_RELAYS = ['wss://relay.coinos.io', 'wss://relay.primal.net', 'wss://purplerelay.com', 'wss://relay.nostr.net']

// ---------------------------------------------------------------- storage

/**
 * Small key-value store. Values: plain objects, arrays, strings, finite
 * numbers, booleans, null, Uint8Array, bigint (src/lib/store/codec.ts).
 */
export interface KV {
  get<T>(key: string): Promise<T | undefined>
  set<T>(key: string, value: T): Promise<void>
  del(key: string): Promise<void>
  keys(prefix?: string): Promise<string[]>
}

/** One table, in the shape marmot-ts calls GenericKeyValueStore. */
export interface Table<T> {
  getItem(key: string): Promise<T | null>
  setItem(key: string, value: T): Promise<T>
  removeItem(key: string): Promise<void>
  clear(): Promise<void>
  keys(): Promise<string[]>
}

/**
 * Everything an unlocked profile stores, encrypted at rest. Requests reach
 * storage in call order: a read sees every write called before it.
 */
export interface Tables {
  /** The engine's own records (table 'app'). */
  kv: KV
  /** Transport tables: groups, keypackages, invites, ingest, rewind, removed, meta, inbox, and any added later. */
  table<T>(name: string): Table<T>
}

export type LockMethod = 'passkey' | 'pin' | 'none'

/**
 * A lock to create, or the proof for unlock/reauth. 'none' exists only in
 * development builds and Node scripts: the shipped storage
 * rejects it with 'not-allowed'. A PIN is exactly 6 ASCII digits.
 */
export type LockChoice = { method: 'passkey' } | { method: 'pin'; pin: string } | { method: 'none' }

export interface LockStatus {
  method: LockMethod
  /** PIN only: unix ms before which the next attempt is refused with 'pin-wait'. 0 = now. */
  waitUntil: number
}

/**
 * At-rest storage of one profile (src/lib/store). Before create() or unlock()
 * only status(), passkeySupported() and wipe() work.
 * Errors are Error(code): 'identity-exists' | 'not-allowed' | 'weak-pin' |
 * 'wrong-pin' | 'pin-wait' | 'passkey-cancelled' | 'passkey-confirm' |
 * 'prf-unsupported' | 'corrupt' | 'storage-damaged' (contents cannot be
 * read: reset and restore) | 'storage-unavailable' (the browser store failed:
 * reopen) | 'storage-format' (stored by another STORE_FORMAT) | 'reset-failed'.
 * create, unlock, verify and relock reach navigator.credentials before their
 * first await, so a passkey ceremony runs straight from the user's tap.
 */
export interface ProfileStorage {
  /** null: nothing stored yet. Reads only the lock record; call it before unlock(). */
  status(): Promise<LockStatus | null>
  /**
   * Makes the data key and locks it with `choice`. `init` writes the first
   * records before the lock record is stored; until then the profile still
   * counts as empty. The check for an existing profile and the final write
   * hold one cross-tab lock.
   */
  create(choice: LockChoice, init: (tables: Tables) => Promise<void>): Promise<Tables>
  unlock(proof: LockChoice): Promise<Tables>
  /** Unlocked only: proves the lock again. PIN attempts count exactly like unlock. */
  verify(proof: LockChoice): Promise<void>
  /** Unlocked only: locks the same data key with another lock. Data is not rewritten. */
  relock(choice: LockChoice): Promise<void>
  passkeySupported(): Promise<boolean>
  /** Deletes this profile's whole store, lock included. Works while locked. */
  wipe(): Promise<void>
}

// ---------------------------------------------------------------- offers

/** How the bitcoin moves. The order is the slot order of every match message. */
export type PayMethod = 'lightning' | 'onchain'
export const PAY_METHODS: readonly PayMethod[] = ['lightning', 'onchain']

export interface Offer {
  id: string
  side: Side
  currency: Currency
  /** Fiat amount in minor units (KRW won, JPY yen, USD cents). Always passes isMinor (src/lib/money). */
  amountMinor: number
  /** Premium over market price in percent. May be negative. */
  feePct: number
  /** Methods I accept. Non-empty, no duplicates, in PAY_METHODS order. Matching compares them. */
  methods: PayMethod[]
  createdAt: number
  /** Local only, never sent. 1 on creation, +1 on every edit. A 'done' record names the rev it deducted from. */
  rev: number
}

/** What a matched counterparty is allowed to see. */
export type PublicOffer = Pick<Offer, 'side' | 'currency' | 'amountMinor' | 'feePct' | 'methods' | 'createdAt'>

// ---------------------------------------------------------------- wire

/**
 * Every ilchon message travels as one unsigned Nostr rumor of this kind inside
 * a two-member Marmot group. `content` is JSON of a WireMessage.
 */
export const ILCHON_KIND = 4242

/** One value per PAY_METHODS slot. Every match message carries both slots, whatever the offer. */
export type MatchPair = [string, string]

export type WireMessage =
  /** Connect: redeem the one-time code the receiver showed in its QR. */
  | { t: 'hello'; v: 1; code: string }
  /** Match round 1, initiator -> responder. `sid` is 32 lowercase hex. p[i] = H2G(label_i)^a_i */
  | { t: 'm1'; sid: string; p: MatchPair }
  /**
   * Match round 2, responder -> initiator. q[i] = H2G(label_i)^b_i, pq[i] = a
   * slot-tagged SHA-256 commitment to p[i]^b_i (never the point itself, or the
   * initiator could echo it back as qp and fake a match).
   */
  | { t: 'm2'; sid: string; q: MatchPair; pq: MatchPair }
  /** Match round 3, initiator -> responder. qp[i] = q[i]^a_i */
  | { t: 'm3'; sid: string; qp: MatchPair }
  /** Responder refuses a round (quota used). Carries no offer information. */
  | { t: 'mx'; sid: string }
  /** Sent by each side only after it has verified a match. */
  | { t: 'offer'; offer: PublicOffer }
  /** My offer is gone or changed side, currency or methods. Remove me from your board. */
  | { t: 'withdraw' }
  /** `id`: the sender's room-record id (32 lowercase hex). A re-send of the same record keeps it; receivers keep one. Same rule for `done`. */
  | { t: 'chat'; id: string; text: string }
  /**
   * A trade of `amountMinor` (minor units) in `currency` was completed between us.
   * `id` is the sender's room record id (32 lowercase hex); a resend carries the same id.
   */
  | { t: 'done'; id: string; amountMinor: number; currency: Currency }

// ---------------------------------------------------------------- transport (src/lib/marmot)

export interface IncomingInvite {
  /** Opaque id to pass to acceptInvite / ignoreInvite. */
  id: string
  inviterPubkey: PubkeyHex
  receivedAt: number
  /** The Welcome's created_at (unix seconds), on the inviter's clock. Authenticated by the seal signature. */
  sentAt: number
}

/** How a room I make from a scan is made. */
export interface InviteOptions {
  /** Invite only the KeyPackage with this reference: the `kp` of the peer's QR I scanned. */
  keyPackageRef?: string
  /** Put in the room description (encrypted group info): the tag of the peer's code. */
  tag?: string
}

export interface IncomingMessage {
  groupId: string
  senderPubkey: PubkeyHex
  msg: WireMessage
  /** Sender-claimed unix seconds from the rumor. */
  at: number
  /** Rumor id, unique per message. Use for de-duplication. */
  id: string
}

export interface RelayStatus {
  url: string
  connected: boolean
}

/**
 * Whether a room can carry messages:
 * 'ok'         loaded and active
 * 'missing'    no loaded, active group with this id on this device
 * 'unreadable' stored state that could not be loaded at start; left untouched
 * 'stranded'   my relays work but none of the group's relays has connected for a while:
 *              90 s in all of this session, counted only while the page is visible and
 *              online; a connection to one of the group's relays ends it
 */
export type GroupHealth = 'ok' | 'missing' | 'unreadable' | 'stranded'

/**
 * Real Marmot messaging. Implementations must talk to real Nostr relays; the
 * shipped app has no mock or local fallback. The only fake lives in
 * scripts/fake-transport.ts and is used by `pnpm check`.
 *
 * Rules
 * - Groups always have exactly two members: me and one peer.
 * - `onMessage` never delivers my own messages.
 * - Messages for a group arrive in order per sender. Messages published while
 *   I was offline are delivered once a relay of the group is reachable (relay
 *   backfill).
 * - All state lives in `TransportOptions.tables`.
 * - `onMessage` is at-least-once: until its callback finished, a message can
 *   be delivered again (same `id`) after a restart. Callbacks must tolerate repeats.
 */
export interface Transport {
  readonly pubkey: PubkeyHex
  /**
   * Load the stored groups one by one (one that cannot be read is skipped,
   * see groupHealth) and connect them, then become invitable: listen for
   * Welcomes, get my relay lists (kind 10002, 10050) accepted and my
   * KeyPackage (kind 30443) readable on my relays. Resolves once all of that
   * is done. Network trouble never rejects it: it retries, and switches to
   * TransportOptions.fallbackRelays when allowed, until it succeeds or
   * stop(). Rejects for local failures ('profile-locked', unreadable storage, a
   * failed signature), also when they happen while online, and with
   * 'transport is stopped' after stop().
   */
  start(): Promise<void>
  stop(): Promise<void>
  /** My relays in use now: `relays`, or `fallbackRelays` after a switch. */
  relayStatus(): RelayStatus[]
  /** Called when the relays in use change or one of them connects or drops. */
  onRelayStatus(cb: (s: RelayStatus[]) => void): Unsub
  /** True once none of `relays` worked and `fallbackRelays` are used instead. Stays true until stop(). */
  fallingBack(): boolean
  /**
   * Whether a group can carry messages now. Every id is 'missing' until
   * start() has loaded the stored groups. The answer depends on the group's
   * stored state and on relay connections only, never on who the peer is.
   */
  groupHealth(groupId: string): GroupHealth
  /** Called, with no argument, whenever groupHealth may have changed for some group. */
  onGroupHealth(cb: () => void): Unsub

  /**
   * The reference of my KeyPackage on my relays now (the `kp` of my connect QR):
   * the id of its event. null until start() has it on a relay.
   */
  keyPackageRef(): string | null
  /**
   * Called, with no argument, whenever keyPackageRef() may have changed (a rotation after
   * a join replaces my KeyPackage on the relays): a QR still naming the old one could no
   * longer be invited, so the engine puts the new reference into the QR at once.
   */
  onKeyPackageRef(cb: () => void): Unsub
  /**
   * Reads my KeyPackage back from my relays and publishes it again when none
   * serves it (the connect screen). Never rejects.
   */
  checkKeyPackage(): Promise<void>
  /**
   * Key-takeover signal: reads my pubkey's KeyPackages from my
   * relays (limit 20). True when a valid one sits in another device's slot and was made
   * after `sinceSec` (unix seconds: when this device made or restored the key), or when my
   * own slot holds a newer package this device did not make. `ownSlotOnly` (the connect
   * screen's check) looks at my own slot only. Reads at most once per 10
   * minutes per transport (a call within that resolves false). Never rejects: a failed
   * read is false.
   */
  keyUsedElsewhere(sinceSec: number, opts?: { ownSlotOnly?: boolean }): Promise<boolean>
  /**
   * Fetch the peer's KeyPackage, create a two-member group, deliver the
   * Welcome. Must reject if the Welcome was not accepted by any relay.
   * The lower pubkey makes every room. A Welcome from the higher pubkey is
   * never joined: the lower side reads it as a request for a fresh room.
   * Without `opts.keyPackageRef` the peer's newest KeyPackage is invited
   * (a reopen without a scan); with it only that one, and the
   * call rejects when it is not found after KEY_PACKAGE_FETCH_TRIES lookups.
   */
  invitePeer(peerPubkey: PubkeyHex, opts?: InviteOptions): Promise<{ groupId: string }>
  /** Welcomes addressed to me. Nothing is joined until acceptInvite. */
  onInvite(cb: (invite: IncomingInvite) => void): Unsub
  /**
   * Reads a waiting Welcome without joining it (marmot-ts previewWelcome):
   * the tag in its room description, or null when it has none or cannot be read.
   * Writes nothing, publishes nothing, uses no key package.
   */
  previewInvite(inviteId: string): Promise<{ tag: string | null }>
  acceptInvite(inviteId: string): Promise<{ groupId: string }>
  /** Drop a Welcome silently. The inviter learns nothing. */
  ignoreInvite(inviteId: string): Promise<void>

  /**
   * Rejects when no relay took the message. Rejects at once with
   * 'group-unreadable' when groupHealth is 'missing' or 'unreadable'. Waits
   * up to 8 s for a socket to one of the group's relays and rejects with
   * 'offline' if none opens, before anything is encrypted: every encryption
   * uses up a step of the MLS sender ratchet whether or not it is published,
   * so retries must not burn steps while the room's relays are out of reach.
   * Waits for the stored groups to be loaded, not for start() to finish.
   */
  send(groupId: string, msg: WireMessage): Promise<void>
  /**
   * Every incoming message is written to the transport's durable inbox before
   * it is handed over, and removed once `cb` returned or the promise it
   * returned fulfilled. If that promise rejects, or the transport stops first,
   * the message stays and is delivered again at the next `start()`, before
   * anything new. Messages that were in the inbox together keep their order
   * per sender. `stop()` waits for pending inbox writes, at most 10 seconds.
   */
  onMessage(cb: (m: IncomingMessage) => void | Promise<void>): Unsub
  /**
   * Known groups and their single peer. A stored group that could not be
   * loaded is listed with peerPubkey null.
   */
  listGroups(): Promise<{ groupId: string; peerPubkey: PubkeyHex | null }[]>
  /**
   * Remove one group from this device only: stored state (also state that
   * could not be loaded), subscription, pending outgoing messages. Publishes
   * nothing; the peer learns nothing. Resolves also when the id is unknown.
   */
  forgetGroup(groupId: string): Promise<void>
  /**
   * The other member has committed in this loaded group: its epoch is past the
   * one my invite commit made (create = 0, invite = 1). The lower pubkey never
   * commits after inviting and the joiner always self-updates, so for a room I
   * made this means the peer joined. false for unknown or unloaded groups.
   */
  peerJoined(groupId: string): boolean
  /**
   * My contact list on my list relays (TransportOptions.listRelays; without
   * them my relays in use): copies signed by my list key that decrypt. Rejects when none
   * answered. Call only after start() resolved.
   */
  fetchList(): Promise<ListFetch>
  /**
   * Encrypt `payload` to my list key (NIP-44), sign kind 30078 with `createdAt`
   * (unix seconds) and publish to `relays`. Resolves the relays that accepted;
   * rejects 'list-rejected' when none did.
   */
  publishList(payload: string, createdAt: number, relays: string[]): Promise<string[]>
}

/** One readable copy of my contact list, as one relay returned it. */
export interface ListCopy {
  relay: string
  /** Decrypted plaintext; the engine validates it. */
  payload: string
  /** Event created_at, unix seconds. */
  createdAt: number
}

export interface ListFetch {
  copies: ListCopy[]
  /** Relays that answered in time, with or without a copy. Never empty: the call rejects instead. */
  answered: string[]
  /** Relays that were asked. A relay in `asked` but not in `answered` may hold a copy this device has not seen. */
  asked: string[]
}

export interface TransportOptions {
  /** 32-byte secret key, lowercase hex. */
  secretKeyHex: string
  relays: string[]
  /**
   * Used instead of `relays` once none of `relays` can be reached (or they
   * keep refusing) while one of these answers. Omit to keep waiting for
   * `relays`. Never switches back before stop().
   */
  fallbackRelays?: string[]
  /** Extra relays for publishing and looking up kind 10002/10050 only. */
  lookupRelays?: string[]
  /** Where fetchList asks for my contact list (LIST_RELAYS in the app). Absent: `relays`. */
  listRelays?: string[]
  /** Names this profile's cross-tab lock. */
  namespace: string
  /** 'indexeddb': hold the cross-tab profile lock (browser). 'memory': no lock (Node). */
  persistence: 'indexeddb' | 'memory'
  /** Where the Marmot client keeps its state. */
  tables: Pick<Tables, 'table'>
}

/** Exported by src/lib/marmot/index.ts */
export interface MarmotModule {
  createTransport(opts: TransportOptions): Transport
  pubkeyOf(secretKeyHex: string): PubkeyHex
  npubOf(pubkey: PubkeyHex): string
  /**
   * Restore only, before this device has a transport: my contact list on `relays` (the
   * list relays: the list is never anywhere else, so no kind 10002 lookup
   * widens the query). Rejects when no relay answered the list query.
   */
  findList(opts: { secretKeyHex: string; relays: string[] }): Promise<ListFetch>
}

// ---------------------------------------------------------------- matching (src/lib/match)

/**
 * Private equality test on "who sells to whom, in which currency, by which
 * method", run as two independent slots per round (PAY_METHODS order).
 *
 *   label_i = H("ilchon/match/v2/label" | context | seller | buyer | currency
 *               | PAY_METHODS[i] | initiator | responder | sid)
 *
 * A slot whose method my offer does not include, both slots without an offer,
 * and both slots for a deleted contact use a fresh random label, so a
 * non-matching peer cannot tell one method from two, or either from none.
 * Binding initiator, responder and sid stops a peer from reflecting one of my
 * rounds into another. A round matches when any slot matches.
 *
 * All group elements are ristretto255, encoded base64url (43 chars).
 */
export type MatchLabels = [Uint8Array, Uint8Array]

export interface MatchCrypto {
  labelsFor(args: {
    context: string
    myPubkey: PubkeyHex
    peerPubkey: PubkeyHex
    /** Who sent m1 of this round: me or the peer. Anything else throws. */
    initiator: PubkeyHex
    /** The round's sid from m1. */
    sid: string
    offer: Pick<Offer, 'side' | 'currency' | 'methods'> | null
  }): MatchLabels
  /** Initiator. Keep `secret` until round 3. */
  round1(labels: MatchLabels): { secret: string; p: MatchPair }
  /**
   * Responder. `pq` holds one commitment per slot, not points: send it and keep
   * it to verify round 3. Throws when any point is malformed.
   */
  round2(labels: MatchLabels, p: MatchPair): { q: MatchPair; pq: MatchPair }
  /** Initiator. Learns the result here. Throws when any value is malformed. */
  round3(secret: string, q: MatchPair, pq: MatchPair): { matched: boolean; qp: MatchPair }
  /** Responder. `pq` is the kept commitment pair. Throws when any value is malformed. */
  finish(pq: MatchPair, qp: MatchPair): boolean
}

// ---------------------------------------------------------------- connect (src/lib/connect)

/** How long one QR is shown before it rotates. */
export const CODE_DISPLAY_MS = 30_000
/** How long after creation a shown code may still be redeemed (network slack). */
export const CODE_REDEEM_MS = 120_000

export interface ConnectPayload {
  /** 2 since the QR carries `kp`. Version 1 is refused. */
  v: 2
  pk: PubkeyHex
  /** 16 random bytes, hex. One use. */
  code: string
  /** Unix ms after which the QR must not be accepted by a scanner. */
  exp: number
  /**
   * My KeyPackage reference now (Transport.keyPackageRef, 64 hex). A room the scanner
   * makes from this scan invites only that KeyPackage, never a newer one a thief of
   * my key may have published.
   */
  kp: string
}

/** Exported by src/lib/connect/index.ts */
export interface ConnectModule {
  newCode(): string
  /** Text placed in the QR. Starts with "ilchon:". */
  encodePayload(p: ConnectPayload): string
  /** Returns null for anything that is not a well-formed ilchon payload. */
  decodePayload(text: string): ConnectPayload | null
}

/*
 * Connect handshake and channels (implemented in the engine)
 *
 * Rooms. Every two-member group between two people is made by the side with
 * the lexicographically smaller pubkey (L). The other side (H) never makes
 * one: when it needs a room it sends L a Welcome that L never joins. L reads
 * such a Welcome from a contact or tombstone as a request and makes a fresh
 * room. Rooms from the same L compare by the Welcome's created_at (L's clock):
 * the newer wins. A room L made that the peer has not joined after a day is
 * made again.
 *
 * First link (neither side has the other):
 * 1. Each user shows a QR with { pk, code, exp }. A new code every 30 s.
 * 2. Both users must scan each other. A scan stores { peer pk, peer code }.
 * 3. L acts only after it scanned H: invitePeer(H), then hello { code: H's code }.
 * 4. H joins L's Welcome only if it scanned L in the last 5 minutes.
 * 5. Each side proves the scan by sending the peer's fresh code; a code must be
 *    mine and younger than CODE_REDEEM_MS. L makes the contact on H's reply;
 *    H makes it on L's echo of L's code.
 * 6. A link not complete after 2 minutes (7 days once H replied) is dropped.
 *
 * Already linked. Scanning a contact starts no link and the
 * screen says "already added"; my QR stays. Silently, my app sends the proof
 * hello { code: the peer's code } into our room and the peer echoes it. A proof
 * of the peer (a hello with my code) that reaches our room within 5 minutes
 * before or after my scan shows we share the room: nothing changes. When none
 * came by my scan + 5 minutes, L makes a new room for the key package in the
 * peer's QR (kp), tagged with the hash of the peer's code; H does nothing. A
 * tagged room is taken without the move limits (the tag can only come from my
 * QR). A room bound by a move or a tag and then proved by both scans is pinned
 * for 7 days: no remote move or request is taken meanwhile. If the peer
 * no longer has me (it deleted me, lost its list, or gave up a link), the peer
 * links from scratch: as L it makes a tagged room, as H it asks me (L) for one
 * after 10 s, which I make from my scan.
 *
 * Reopening. A contact or tombstone whose room is missing, unreadable, stranded
 * or mid-move gets a new room without meeting: L makes it, H requests it.
 * Moves never create a contact, and treat contacts and tombstones alike.
 *
 * Knowing someone's pubkey is therefore never enough to become their contact.
 */

// ---------------------------------------------------------------- rates (src/lib/rates)

/** Fiat price of 1 BTC per currency; a missing currency has no fresh price. */
export type Rates = Partial<Record<Currency, number>> & { at?: number }

export interface RatesSource {
  /** Never throws. Missing currencies are simply absent. */
  fetch(): Promise<Rates>
}

// ---------------------------------------------------------------- lightning address (src/lib/lnurl)

/** Why a Lightning address could not give an invoice. One line each on screen; never the server's text. */
export type LnurlError = 'bad-address' | 'unreachable' | 'refused' | 'range' | 'mismatch'

/**
 * Lightning address (LUD-16) -> LNURL-pay (LUD-06), fetched straight from the
 * browser to the user's own wallet service. No proxy. Failures reject with an
 * Error whose message is an LnurlError; a 'range' error also has numeric
 * `minSats` and `maxSats`.
 */
export interface LnurlModule {
  /** Normalised `user@domain`, or null when it is not one. */
  parseAddress(text: string): string | null
  /** Fetches the first step only: the address exists, allows web requests and can issue invoices. */
  check(address: string): Promise<void>
  /** A mainnet invoice for exactly `sats`, checked against the request (amount, expiry, description hash). */
  invoice(address: string, sats: number): Promise<string>
}

// ---------------------------------------------------------------- engine (src/engine)

/** The room of the channel to one peer. Engine only: screens never read it, the contact list never syncs it. */
export interface ChannelFields {
  /** The Marmot group of this channel. null: none on this device yet; the app reopens it. */
  groupId: string | null
  /**
   * Unix seconds on the clock of the side that made the room, which is always
   * the lower pubkey: the Welcome's created_at when I joined it, my own time
   * right after inviting when I made it. Two rooms from the same peer compare
   * by this value.
   */
  roomSentAt?: number
  /** Unix ms, my clock: when this room became the channel. */
  roomAt?: number
  /** Unix ms, my clock: recent room changes, newest last, at most CHANNEL_MOVES_MAX. */
  moves?: number[]
  /**
   * Unix ms, my clock: rooms I (L) made in answer to the peer's room request while my room
   * still worked, and rooms I joined from the peer's scan of my QR (a tagged Welcome:
   * a relink over a tombstone of me comes at once, a keeping holder's at its deadline),
   * newest last, at most CHANNEL_MOVES_MAX. Kept apart from
   * `moves`: a deleting side's re-scan over a tombstone sends such a request or room where
   * a keeping side's holder scan sends none or sends it later, so a move limit that
   * counted them would differ between the two worlds. They gate only further answers (with `moves`), never my own
   * reopening or anything on screen.
   */
  answered?: number[]
  /** Unix ms, my clock: a room change started and has not ended in a bound room. Cleared only by a bind. */
  moving?: number
  /**
   * L: the `moving` under way is my answer to the peer's room request, started while my room
   * still worked. The value is my run of attempts (`tries`, `triedAt`)
   * from before the answer: the answer's own attempts are not mine.
   * Stored with `moving` so that a restart keeps a failed answer an answer, the same as in a
   * world where the peer never asked. Cleared by a bind, and when my room
   * cannot carry messages at the next attempt (that one is my own reopen). A deletion, a
   * relink and a room of my scan end it with its `moving` and give back these attempts;
   * a link never copies it to the new contact. Optional: absent
   * reads as no answer under way (no STORE_FORMAT change).
   */
  answerFrom?: { tries?: number; triedAt?: number }
  /** I made this room (lower pubkey) and the peer has not been seen in it yet. */
  pending?: true
  /** My attempts in a row that have not yet given a working channel (requests, rooms not joined, failures). */
  tries?: number
  /** Unix ms, my clock: the last of those attempts. */
  triedAt?: number
  /** Unix ms, my clock: until then remote moves and requests from this peer are ignored. */
  pinnedUntil?: number
  /** Unix ms, my clock: when to decide the "channel reopened" line of a remote move. */
  noticeAfter?: number
  /** How this room was bound without a scan: 'remote' (a move, or a reopen of mine), 'tag' (a tagged move). */
  boundBy?: 'remote' | 'tag'
  /**
   * Unix seconds on the PEER's clock: the rumor time of the peer's first message in this
   * room that I read (written once per room; an earlier one delivered late lowers it). The
   * peer could only send it once it had the room, so a room request of the peer dated at or
   * before it was sent before the peer had this room (stale): one clock on both
   * sides of the comparison, whatever the skew between our two devices.
   */
  peerSentAt?: number
}

export interface Contact extends ChannelFields {
  /** Equals pubkey. */
  id: PubkeyHex
  pubkey: PubkeyHex
  /** Label I chose. Never sent to contacts; kept in my encrypted contact list on my relays. */
  name: string
  createdAt: number
  /**
   * How the link was made: the peer's QR seen by the camera, or its code pasted.
   * Not shown, never sent, not in the contact list event.
   */
  via?: 'camera' | 'paste'
}

/**
 * A contact's room is being reopened: my room
 * with them cannot carry messages, or my newest text in it failed. The screen shows one
 * short status line instead of failures with no reason. Only my own facts make it, never
 * a request or a move of the contact alone (such a line would show on the deleted side only where it was deleted).
 */
export interface ReopenWait {
  /** Unix ms, my clock: when this status began. */
  since: number
  /** Unix ms: when the daily move limit lets the next room change happen. Absent when it is not the limit. */
  at?: number
  /**
   * Waiting longer than usual (several of my attempts in a row): meeting and scanning each
   * other reconnects at once.
   */
  scan?: boolean
}

export interface Match {
  contactId: PubkeyHex
  offer: PublicOffer
}

/** Longest chat text. sendChat rejects longer text; received text is cut to this. */
export const CHAT_MAX = 2000

interface MessageBase {
  /** Unique within the room. A received 'done' or text uses the id the sender put in the message. */
  id: string
  contactId: PubkeyHex
  mine: boolean
  /**
   * Unix ms. A text from the contact, and a 'changed' line: the time the contact's message
   * claims, never in my future. Everything else ('matched', 'done', 'reopened', my own
   * texts): my clock when it was recorded.
   */
  at: number
}

export type ChatMessage =
  | (MessageBase & {
      kind: 'text'
      text: string
      /**
       * Delivery of my own texts only. 'sending' until a relay took it, 'failed'
       * once every retry failed (retryChat sends it again, with the same id; never
       * automatically). Undefined = sent.
       */
      status?: 'sending' | 'sent' | 'failed'
    })
  /** My offer and theirs first matched here. Once per offer of mine. `mine` is false. */
  | (MessageBase & { kind: 'matched' })
  /** A trade marked done, by me (`mine`) or by the contact. The screen writes the sentence. */
  | (MessageBase & {
      kind: 'done'
      amountMinor: number
      currency: Currency
      /** Mine only: what this completion does to my offer, so a crash before the deduction can be finished on the next start. */
      deduct?: { offerId: string; rev: number; leftMinor: number }
      /** Mine only: 'sending' until a relay took it, 'failed' after the engine's retries; a failed one is re-sent automatically. Not shown. */
      status?: 'sending' | 'sent' | 'failed'
    })
  /**
   * The matched contact changed the amount or premium of their offer.
   * Kept in my room only, never sent. `mine` is false. The screen writes the sentence.
   */
  | (MessageBase & {
      kind: 'changed'
      currency: Currency
      before: { amountMinor: number; feePct: number }
      after: { amountMinor: number; feePct: number }
    })
  /**
   * The contact's side moved our channel to a new room without a scan of mine:
   * drawn once, in my room only, never sent. `mine` is false. The
   * screen writes the sentence.
   */
  | (MessageBase & { kind: 'reopened' })

export type ConnectPhase =
  /** Not connecting. */
  | 'idle'
  /** My QR is visible. I have not scanned the peer yet. */
  | 'showing'
  /** I scanned the peer. Waiting for the peer to scan me and for the link. */
  | 'scanned'
  /** The Marmot group exists, hellos in flight. */
  | 'linking'
  | 'done'
  | 'failed'
  /**
   * I scanned someone who already is my contact. The screen does not change and
   * no link starts; my QR stays visible because the peer may still need to scan
   * it. The app silently checks that our room is the same and opens a new one only
   * when it is not (proof pairing and deadline).
   */
  | 'already'

export interface ConnectState {
  phase: ConnectPhase
  /** Text for my QR. Present from 'showing' on. */
  myPayload?: string
  /** Unix ms when my current QR rotates. */
  myCodeExpiresAt?: number
  peerPubkey?: PubkeyHex
  /** Set when phase is 'done'. */
  contactId?: PubkeyHex
  /** i18n key, set when phase is 'failed'. */
  errorKey?: 'expired' | 'invalid' | 'self' | 'timeout' | 'network'
  /**
   * Phase 'linking', invitee only: my reply went out long ago and only the
   * peer's confirmation is missing. Closing the screen is safe; the link
   * completes in the background when the peer's app is online.
   */
  waitingPeer?: boolean
}

/** Minutes out of view after which the app locks again. */
export type RelockMinutes = 1 | 5 | 15 | 30
export const RELOCK_MINUTES: readonly RelockMinutes[] = [1, 5, 15, 30]
/** The auto-lock time until the user picks another. */
export const DEFAULT_RELOCK_MINUTES: RelockMinutes = 5

export interface Settings {
  lang: Lang
  sort: SortMode
  /** 1 | 5 | 15 | 30, default 5. */
  relockMinutes: RelockMinutes
  /** Relays I chose in Settings → Advanced. null = the default relays (EngineDeps.relays). */
  relays: string[] | null
  /** With relays of my own: use the default relays while none of mine work. Default true. */
  relayAuto: boolean
  /**
   * My Lightning address for automatic invoices; checked once when saved (setLightningAddress
   * only, setSettings ignores it). Never sent to contacts or relays.
   */
  lnAddress: string | null
}

/** The rolling window for one completed probe per contact. */
export const MATCH_WINDOW_MS = 1_000

// ---------------------------------------------------------------- trade room (src/engine/trade.ts)

export type TradeStep = 'agree' | 'receive' | 'transfer' | 'account' | 'verify' | 'pay' | 'done'

/** Guide steps in order, by my side. Fiat first, then the seller checks the depositor and sends bitcoin. */
export const TRADE_STEPS: Record<Side, readonly TradeStep[]> = {
  buy: ['agree', 'receive', 'transfer', 'done'],
  sell: ['agree', 'account', 'verify', 'pay', 'done'],
}

/** Where I left the guide of one room. Written only when I move the guide myself. */
export interface TradeStepRec {
  /** TradeView.stepKey when stored. Another key means another trade: start over. */
  key: string
  step: TradeStep
  /** TradeView.activeCard when stored, so that card does not move the guide again. */
  card: string
}

/**
 * What one payment request card is to me.
 *   active    the one request of the current trade: the latest the buyer sent since it began
 *   inactive  anything else: earlier in this trade, a finished trade, an earlier offer, no offer, sent by the seller
 *   notPayer  I buy and the contact sent it; buyers never pay
 */
export type CardState = 'active' | 'inactive' | 'notPayer'

export interface CardView {
  state: CardState
  /** Active, I sell, and the contact matches my offer now. The card still hides the button while expired or not mainnet. */
  pay: boolean
  /** Active only: fiat value in minor units at the current price and my premium. Null without amount or rate. */
  fiatMinor: number | null
  /** Active and I sell only: asks for clearly more than the trade amount is worth. */
  over: boolean
}

/** Everything a trade room shows that is not plain chat. Derived, never stored. */
export interface TradeView {
  offer: Offer | null
  /** The contact's offer while it is opposite to mine in the same currency. */
  theirOffer: PublicOffer | null
  /** Trade amount: the smaller of both offers, minor units. Null unless matched. */
  tradeMinor: number | null
  /** Sats for tradeMinor at my premium and at theirs. Null unless matched and a rate exists. */
  sats: { mine: number; theirs: number } | null
  /** By `${messageId}:${partIndex}` (src/lib/pay splitText). */
  cards: Record<string, CardView>
  /** Key of the active card, or ''. */
  activeCard: string
  /** The active card for the guide. 'none' also when it is not mainnet. */
  receive: 'none' | 'live' | 'expired'
  /** Unix seconds when a live active card expires; 0 when none or it never expires. Recompute then. */
  receiveExpiresAt: number
  /** Methods both offers accept while matched (commonMethods); [] otherwise. */
  methods: PayMethod[]
  /** Kind of the active card (src/lib/pay PayRef['kind']), or null without one. */
  activeKind: PayMethod | null
  /** Empty without an offer. */
  steps: readonly TradeStep[]
  step: TradeStep | null
  /** Offer creation time and my last completion: identifies the current trade for the guide. */
  stepKey: string
  /** Their completions within my offer that I have not mirrored, oldest first. `prefillMinor` is capped at my open amount. */
  pendingDone: { messageId: string; amountMinor: number; prefillMinor: number }[]
  /** Amount to prefill when I mark a trade done. Null without an offer. */
  doneSuggestionMinor: number | null
}

/** Exported by src/engine/trade.ts as `tradeView`. Pure. */
export type TradeViewFn = (state: Pick<IlchonState, 'myOffer' | 'matches' | 'rooms' | 'rates' | 'tradeSteps'>, contactId: PubkeyHex, nowMs: number) => TradeView

export interface IlchonState {
  /**
   * 'setup'  = no identity on this profile yet; call prepareIdentity then createIdentity,
   *            or checkMnemonic then restoreIdentity.
   * 'locked' = identity exists but is locked; call unlock.
   * 'starting' = opening stored data, then waiting until my relays take me
   *            (Transport.start). Lasts as long as there is no connection;
   *            never turns into 'error' for network reasons.
   * 'ready'  = connected and invitable once. A later disconnect stays 'ready';
   *            see `relays`.
   * 'error'  = a local failure (bootError): 'storage-damaged': stored data cannot be read; the way on is
   *            resetAll and recovery. 'storage-unavailable': the browser store failed;
   *            reopen the app. 'replaced': the same 12 words were restored on another
   *            device, so this one stopped for good; the way on is resetAll
   *            and a restore with the 12 words here.
   */
  boot: 'starting' | 'setup' | 'locked' | 'ready' | 'error'
  bootError?: string
  lock: {
    method: LockMethod | null
    /** Null until checked. */
    passkeySupported: boolean | null
    /** PIN only: unix ms before which unlock and reauth are refused. 0 = now. */
    waitUntil: number
  }
  me: { pubkey: PubkeyHex; npub: string } | null
  /**
   * The identity keeps the 12 words it was made from (made by this app). A restored
   * identity keeps none, so there is nothing to show again: settings shows
   * "Show 12 words" only when this is true. False until unlocked.
   */
  hasWords: boolean
  /** My relays in use now (Transport.relayStatus). Empty until the transport exists. */
  relays: RelayStatus[]
  /** The default relays are in use because none of settings.relays worked (Transport.fallingBack). */
  fallingBack: boolean
  contacts: Contact[]
  myOffer: Offer | null
  /** Contacts whose opposite, same-currency offer with a shared method has been revealed to me. */
  matches: Match[]
  /** For the current offer: how many contacts were asked and how many answered. */
  matchProgress: { asked: number; answered: number }
  rooms: Record<PubkeyHex, ChatMessage[]>
  /** The trade guide step I chose per room (setTradeStep). Encrypted like the rest of the engine KV. */
  tradeSteps: Record<PubkeyHex, TradeStepRec>
  /** Contacts whose room cannot carry messages right now while the app reopens it. Memory only. */
  reopening: Record<PubkeyHex, ReopenWait>
  connect: ConnectState
  rates: Rates
  settings: Settings
}

export interface OfferInput {
  side: Side
  currency: Currency
  /** Minor units (KRW won, JPY yen, USD cents). Must pass isMinor. */
  amountMinor: number
  feePct: number
  /** At least one; duplicates are dropped. */
  methods: PayMethod[]
}

export interface IlchonActions {
  /**
   * Replaces any existing offer and starts matching with every contact.
   * Rejects with 'invalid_offer' when methods is empty or holds an unknown value.
   * Changing side, currency or methods starts matching over; changing only amount or fee keeps matches.
   */
  postOffer(input: OfferInput): Promise<void>
  withdrawOffer(): Promise<void>

  /** Opens the connect flow and shows my first QR. */
  startConnect(): void
  /** Called by the UI when the 30 s timer runs out. */
  rotateConnectCode(): void
  /**
   * Text scanned from the peer's QR, or pasted. `via` says which (kept on the contact a
   * link makes, never shown or sent).
   */
  submitScan(text: string, via?: 'camera' | 'paste'): Promise<void>
  cancelConnect(): void

  renameContact(id: PubkeyHex, name: string): Promise<void>
  /**
   * Stop matching with this contact for real. The Marmot group is kept and I
   * keep answering with random labels, so the peer cannot tell.
   */
  deleteContact(id: PubkeyHex): Promise<void>

  /**
   * Appends my message with status 'sending' and returns; the status follows delivery.
   * Rejects with 'too_long' when the trimmed text is longer than CHAT_MAX; nothing is appended.
   */
  sendChat(contactId: PubkeyHex, text: string): Promise<void>
  /** Sends a 'failed' message of mine again and sets it back to 'sending'. */
  retryChat(contactId: PubkeyHex, messageId: string): Promise<void>
  /**
   * Record a completed trade of `amountMinor` (minor units, in my offer's currency).
   * Completions run one at a time. The record is stored first, then my open amount
   * is reduced (withdrawn at zero) unless I changed the offer meanwhile, then the
   * contact is told. The room's state never rejects it. Rejects with 'not_ready' |
   * 'no_contact' | 'no_offer' | 'invalid_amount' | 'too_much' (more than my open
   * amount) | 'not_saved' (the record could not be stored); nothing is kept or sent then.
   * The record is stored with status 'sending' first and re-sent automatically until a relay took it.
   */
  markDone(contactId: PubkeyHex, amountMinor: number): Promise<void>
  /**
   * Buyer only: send where I receive the bitcoin for `amountMinor` (minor units of my
   * offer currency), as an ordinary chat message. 'lightning' fetches an invoice from
   * settings.lnAddress; 'onchain' sends a bitcoin: link for `address`, which is not
   * stored and must not have been sent in this room before. Sats use the current rate
   * and the seller's premium, rounded down. Rejects with
   * 'not_ready' | 'no_contact' | 'room-unreadable' | 'busy' | 'not_buyer' |
   * 'not_matched' | 'method' | 'invalid_amount' | 'too_much' | 'no_rate' |
   * 'bad-address' | 'reused' | 'no_address' | 'changed' | an LnurlError (a 'range'
   * error also has numeric `minSats` and `maxSats`); nothing is sent then.
   */
  sendPaymentRequest(contactId: PubkeyHex, req: { method: 'lightning'; amountMinor: number } | { method: 'onchain'; amountMinor: number; address: string }): Promise<void>
  /**
   * Save (after one successful lookup) or clear my Lightning address. Rejects with an
   * LnurlError, or 'save-failed' when the store did not take it; nothing is saved then.
   */
  setLightningAddress(address: string | null): Promise<void>
  /** Remember the guide step I am looking at in this room. Ignored without the contact, without an offer, or for a step my side does not have. */
  setTradeStep(contactId: PubkeyHex, step: TradeStep): Promise<void>

  /**
   * Rejects with 'too-few-relays' or 'too-many-relays' when `relays`, after
   * normalizing and dropping invalid, repeated or not allowed addresses (the
   * host rule of cleanRelayList), has fewer than MIN_RELAYS or more than
   * MAX_RELAYS entries. A list equal to the defaults is stored as null. Relay
   * settings take effect at the next start. A relockMinutes that is not one of
   * RELOCK_MINUTES is ignored (the rest of the patch applies). Once unlocked, resolves only after the
   * settings are stored; when the write fails it rejects with 'save-failed' and the
   * state keeps the stored settings (the patch is undone), so a caller that reloads
   * on success never loses a change silently. Before unlock the change stays in
   * memory and is stored after unlock. `lnAddress` is ignored: only
   * setLightningAddress changes it, after its lookup.
   */
  setSettings(patch: Partial<Settings>): Promise<void>

  /*
   * Identity and lock. Failures reject with Error whose message is one of
   * 'wrong-pin' | 'pin-wait' | 'weak-pin' | 'passkey-cancelled' |
   * 'passkey-confirm' (passkey made, tap again to read it) | 'prf-unsupported' |
   * 'corrupt' | 'not-allowed' | 'busy' | 'reauth-required' |
   * 'identity-exists' (another tab made one) | 'storage-damaged' |
   * 'storage-unavailable' | 'invalid-mnemonic' | 'not-prepared' |
   * 'network' (no relay answered) | 'not-checked' |
   * 'invalid-choice' (a LockChoice the app never builds) | 'reset-failed'
   * (resetAll). The same list as errorKey in src/screens/lock/util.ts.
   */
  /** Only in boot 'setup': the 12 words of a new identity. The same words until the page reloads or createIdentity succeeds. */
  prepareIdentity(): string[]
  /** Only in boot 'setup': lock the identity from prepareIdentity with `choice`, then finish boot. Rejects 'not-prepared' before prepareIdentity. */
  createIdentity(choice: LockChoice): Promise<void>
  /**
   * Only in boot 'setup': check 12 words and look for my contact list on the list relays.
   * Keeps the words and the list in engine memory so restoreIdentity can start a
   * passkey ceremony straight from the tap. Changes nothing in storage.
   * Rejects 'invalid-mnemonic', or 'network' when no relay answered.
   * `found` is false when relays answered but none held a readable list.
   */
  checkMnemonic(words: string): Promise<{ found: boolean }>
  /**
   * Only in boot 'setup', after checkMnemonic with the same words (else 'not-checked'):
   * lock the identity with `choice` and store the contact list found then, in one step,
   * then finish boot. The words themselves are not stored. Channels to the contacts are
   * reopened afterwards, without meeting again.
   */
  restoreIdentity(words: string, choice: LockChoice): Promise<void>
  /** Only in boot 'locked'. `pin` for a PIN lock; a passkey lock needs none. */
  unlock(pin?: string): Promise<void>
  /**
   * Only in boot 'ready': prove the current lock again (passkey or PIN; a PIN
   * attempt counts like one at unlock). Opens a short window for changeLock
   * and revealMnemonic. Method 'none' needs no proof.
   */
  reauth(pin?: string): Promise<void>
  /** True while that window is open (always true for method 'none'). */
  reauthed(): boolean
  /** Only in boot 'ready': re-lock the key with another method. Needs reauth. */
  changeLock(choice: LockChoice): Promise<void>
  /** Only in boot 'ready' on an identity made by this app (restored ones keep no words: 'not-allowed'). Needs a recent reauth (throws 'reauth-required'). */
  revealMnemonic(): string[]
  /**
   * Wipes this profile's local data and reloads. Rejects with 'reset-failed'
   * (and does not reload) when something could not be deleted; boot is then
   * 'error' with bootError 'reset-failed', and calling it again retries
   * (for the reason that reset began with: a failed format wipe at boot is
   * retried as a format wipe, not as a reset the user asked for). Works while
   * locked: the whole profile store is deleted without its key.
   */
  resetAll(): Promise<void>
}

export interface EngineDeps {
  /** Everything this profile keeps, encrypted at rest (src/lib/store). */
  storage: ProfileStorage
  marmot: MarmotModule
  match: MatchCrypto
  connect: ConnectModule
  rates: RatesSource
  /** Lightning address lookups (src/lib/lnurl createLnurl()). */
  lnurl: LnurlModule
  /** The default relays (DEFAULT_RELAYS in the app). settings.relays replaces them, and they become the fallback. */
  relays: string[]
  /** Indexer relays for kind 10002/10050 (see LOOKUP_RELAYS). */
  lookupRelays?: string[]
  /**
   * Where my contact list goes and is looked for (LIST_RELAYS in the app).
   * Absent or empty: no contact list sync, and checkMnemonic rejects 'network'.
   */
  listRelays?: string[]
  namespace: string
  /** Passed to the transport. */
  persistence: 'indexeddb' | 'memory'
  now?: () => number
  /** Node scripts: an empty profile is created from fresh words with lock 'none' instead of stopping in 'setup'. */
  autoIdentity?: boolean
  /** Tests only: shorter timers. */
  tuning?: {
    linkTimeoutMs?: number
    repliedLinkTtlMs?: number
    /** Backoff of a refused send (default SEND_RETRY_MS). An empty list: no retry, the first refusal drops it. */
    sendRetryMs?: number[]
    /** First delay of the pending-signal resend timer (default 60 s). */
    resendBaseMs?: number
    /** How long a verified match waits for the peer's offer before one reconfirm round (default 30 s). */
    echoWaitMs?: number
    /** Minimum gap between reconfirm rounds with one contact at boot or return (default 10 min). */
    reconfirmFloorMs?: number
    /**
     * The holder's pairing window and deadline (default 5 min). The scan's life
     * (2x + 1 min) and the age of a code a holder proof may carry follow it. e2e only.
     */
    holderPairMs?: number
  }
  /** Tests only: replaces setTimeout/clearTimeout so a check can run on virtual time (scripts/fake-transport.ts). */
  timers?: { set(fn: () => void, ms: number): unknown; clear(handle: unknown): void }
}

/**
 * Small values the screens keep between launches: open place, the chat
 * draft, dismissed cards, linked profiles. Stored encrypted with everything
 * else. Before unlock, get returns undefined and set/del do nothing. Keys
 * about one contact end with `:<contactId>`; removing the contact removes them,
 * and set refuses them once the contact is gone.
 */
export interface Memo {
  get<T>(key: string): T | undefined
  /** False when nothing was kept: locked, stopped, or a key of a contact that is gone. */
  set(key: string, value: unknown): boolean
  /** False when nothing was removed because the memo is locked or stopped; true also when the key was not there. */
  del(key: string): boolean
}

/**
 * Engine store is a zustand vanilla store so it runs without React:
 *   const engine = createEngine(deps); await engine.start()
 *   engine.store.getState(); engine.store.subscribe(fn); engine.actions.postOffer(...)
 */
export interface Engine {
  store: {
    getState(): IlchonState
    subscribe(listener: (s: IlchonState, prev: IlchonState) => void): Unsub
  }
  actions: IlchonActions
  memo: Memo
  start(): Promise<void>
  stop(): Promise<void>
}
