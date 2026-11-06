/**
 * ilchon — shared contracts.
 *
 * This file is the single source of truth for module boundaries. Every module
 * codes against these types. Do not change a signature here without updating
 * every consumer. Product intent lives in `p2p-거래-기획.md`.
 *
 * Module map
 *   src/lib/marmot/   Transport            real Marmot over Nostr relays (marmot-ts)
 *   src/lib/match/    MatchCrypto          private direction+currency matching
 *   src/lib/connect/  connect payload      one-time QR codes
 *   src/lib/rates/    RatesSource          BTC price in KRW and USD
 *   src/lib/kv/       KV implementations   browser (IndexedDB) and memory
 *   src/lib/vault/    VaultModule          secret key lock: passkey PRF, NIP-49 password, none
 *   src/lib/pwa/      PWA helpers          install hint, standalone, storage persistence
 *   src/engine/       Engine               all app logic, no DOM, runs in Node too
 *   src/ui/           design kit           Coconut design tokens + components
 *   src/screens/      screens              React, reads Engine state only
 */

// ---------------------------------------------------------------- basics

export type Side = 'buy' | 'sell'
export type Currency = 'KRW' | 'USD'
export type Lang = 'ko' | 'en'
export type SortMode = 'amount' | 'fee'
export type Unsub = () => void

/** Lowercase hex, 64 chars. */
export type PubkeyHex = string

export const APP_NAME = 'ilchon'
export const DEFAULT_RELAYS = ['wss://relay.us.whitenoise.chat', 'wss://relay.eu.whitenoise.chat']

// ---------------------------------------------------------------- storage

/** Small JSON key-value store. Values must be structured-clone safe. */
export interface KV {
  get<T>(key: string): Promise<T | undefined>
  set<T>(key: string, value: T): Promise<void>
  del(key: string): Promise<void>
  keys(prefix?: string): Promise<string[]>
}

// ---------------------------------------------------------------- offers

export interface Offer {
  id: string
  side: Side
  currency: Currency
  /** Fiat amount in the offer currency. KRW in won, USD in dollars. */
  amount: number
  /** Premium over market price in percent. May be negative. */
  feePct: number
  createdAt: number
}

/** What a matched counterparty is allowed to see. */
export type PublicOffer = Pick<Offer, 'side' | 'currency' | 'amount' | 'feePct' | 'createdAt'>

// ---------------------------------------------------------------- wire

/**
 * Every ilchon message travels as one unsigned Nostr rumor of this kind inside
 * a two-member Marmot group. `content` is JSON of a WireMessage.
 */
export const ILCHON_KIND = 4242

export type WireMessage =
  /**
   * Connect: redeem the one-time code the receiver showed in its QR.
   * `r` marks a restore of a deleted contact: a fresh random nonce per restore
   * attempt. The receiver echoes a hello with `r` only after it consumed a fresh
   * code for that same nonce, so a plain (confirmation) echo never proves a restore.
   */
  | { t: 'hello'; v: 1; code: string; r?: string }
  /** Match round 1, initiator -> responder. `p` = H(label_i)^a */
  | { t: 'm1'; sid: string; p: string }
  /**
   * Match round 2, responder -> initiator. `q` = H(label_r)^b, `pq` = a
   * SHA-256 commitment to p^b (never the point itself, or the initiator could
   * echo it back as `qp` and fake a match).
   */
  | { t: 'm2'; sid: string; q: string; pq: string }
  /** Match round 3, initiator -> responder. `qp` = q^a */
  | { t: 'm3'; sid: string; qp: string }
  /** Responder refuses a round (quota used). Carries no offer information. */
  | { t: 'mx'; sid: string }
  /** Sent by each side only after it has verified a match. */
  | { t: 'offer'; offer: PublicOffer }
  /** My offer is gone or changed side/currency. Remove me from your board. */
  | { t: 'withdraw' }
  | { t: 'chat'; text: string }
  /** A trade of `amount` in `currency` was completed between us. */
  | { t: 'done'; amount: number; currency: Currency }

// ---------------------------------------------------------------- transport (src/lib/marmot)

export interface IncomingInvite {
  /** Opaque id to pass to acceptInvite / ignoreInvite. */
  id: string
  inviterPubkey: PubkeyHex
  receivedAt: number
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
 * Real Marmot messaging. Implementations must talk to real Nostr relays; there
 * is no mock or local fallback in the shipped app.
 *
 * Rules
 * - Groups always have exactly two members: me and one peer.
 * - `onMessage` never delivers my own messages.
 * - Messages for a group arrive in order per sender. Messages published while
 *   I was offline are delivered after `start()` (relay backfill).
 * - All state survives a page reload when persistence is 'indexeddb'.
 */
export interface Transport {
  readonly pubkey: PubkeyHex
  /**
   * Connect to relays, publish relay lists (kind 10002, 10050) and a reusable
   * KeyPackage (kind 30443) if missing, start listening for invites and group
   * messages. Resolves once I am invitable.
   */
  start(): Promise<void>
  stop(): Promise<void>
  relayStatus(): RelayStatus[]
  onRelayStatus(cb: (s: RelayStatus[]) => void): Unsub

  /**
   * Fetch the peer's KeyPackage, create a two-member group, deliver the
   * Welcome. Must reject if the Welcome was not accepted by any relay.
   */
  invitePeer(peerPubkey: PubkeyHex): Promise<{ groupId: string }>
  /** Welcomes addressed to me. Nothing is joined until acceptInvite. */
  onInvite(cb: (invite: IncomingInvite) => void): Unsub
  acceptInvite(inviteId: string): Promise<{ groupId: string }>
  /** Drop a Welcome silently. The inviter learns nothing. */
  ignoreInvite(inviteId: string): Promise<void>

  send(groupId: string, msg: WireMessage): Promise<void>
  onMessage(cb: (m: IncomingMessage) => void): Unsub
  /** Known groups and their single peer. */
  listGroups(): Promise<{ groupId: string; peerPubkey: PubkeyHex }[]>
}

export interface TransportOptions {
  /** 32-byte secret key, lowercase hex. */
  secretKeyHex: string
  relays: string[]
  /** Storage namespace so several profiles can share one origin. */
  namespace: string
  persistence: 'indexeddb' | 'memory'
}

/** Exported by src/lib/marmot/index.ts */
export interface MarmotModule {
  createTransport(opts: TransportOptions): Transport
  generateSecretKeyHex(): string
  pubkeyOf(secretKeyHex: string): PubkeyHex
  npubOf(pubkey: PubkeyHex): string
  nsecOf(secretKeyHex: string): string
}

// ---------------------------------------------------------------- matching (src/lib/match)

/**
 * Private equality test on "who sells to whom, in which currency".
 *
 * Both sides derive a label. The labels are equal exactly when one side sells
 * and the other buys in the same currency. Each side blinds its label with a
 * fresh secret scalar; blinding commutes, so both can compare the doubly
 * blinded values without either learning the other's label.
 *
 *   label = H("ilchon/match/v1" | context | seller pubkey | buyer pubkey | currency)
 *
 * A side with no offer (or a deleted contact) uses a fresh random label, so
 * "no offer" and "same side" look identical to the peer.
 *
 * All group elements are ristretto255, encoded base64url on the wire.
 */
export interface MatchCrypto {
  labelFor(args: {
    context: string
    myPubkey: PubkeyHex
    peerPubkey: PubkeyHex
    offer: Pick<Offer, 'side' | 'currency'> | null
  }): Uint8Array
  /** Initiator. Keep `secret` until round 3. */
  round1(label: Uint8Array): { secret: string; p: string }
  /**
   * Responder. `pq` is a commitment to p^b, not the point: send it and keep it
   * to verify round 3. Throws on a malformed point.
   */
  round2(label: Uint8Array, p: string): { q: string; pq: string }
  /** Initiator. `pq` is the commitment from round 2. Learns the result here. */
  round3(secret: string, q: string, pq: string): { matched: boolean; qp: string }
  /** Responder. `pq` is the kept commitment. Learns the result here. */
  finish(pq: string, qp: string): boolean
}

// ---------------------------------------------------------------- connect (src/lib/connect)

/** How long one QR is shown before it rotates. */
export const CODE_DISPLAY_MS = 30_000
/** How long after creation a shown code may still be redeemed (network slack). */
export const CODE_REDEEM_MS = 120_000

export interface ConnectPayload {
  v: 1
  pk: PubkeyHex
  /** 16 random bytes, hex. One use. */
  code: string
  /** Unix ms after which the QR must not be accepted by a scanner. */
  exp: number
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
 * Connect handshake (implemented in the engine)
 *
 * 1. Each user shows a QR with { pk, code, exp }. A new code every 30 s.
 * 2. Both users must scan each other. A scan stores { peer pk, peer code }.
 * 3. The side with the lexicographically smaller pubkey is the inviter. It
 *    acts only after it has scanned the peer: invitePeer(peer), then
 *    send hello { code: peer's code }.
 * 4. The other side accepts a Welcome only if the inviter's pubkey is one it
 *    scanned in the last 5 minutes. Any other Welcome is ignored silently.
 * 5. After joining it waits for hello. The code must be one it issued, unused
 *    and younger than CODE_REDEEM_MS. Then it replies hello { code: inviter's
 *    code }, which the inviter checks the same way.
 * 6. A contact exists only after both hellos verified. A group whose hello is
 *    missing or wrong after 2 minutes is abandoned and never used.
 *
 * Knowing someone's pubkey is therefore never enough to become their contact.
 */

// ---------------------------------------------------------------- rates (src/lib/rates)

export interface Rates {
  /** Fiat price of 1 BTC. */
  KRW?: number
  USD?: number
  at?: number
}

export interface RatesSource {
  /** Never throws. Missing currencies are simply absent. */
  fetch(): Promise<Rates>
}

// ---------------------------------------------------------------- engine (src/engine)

export interface Contact {
  /** Equals pubkey. */
  id: PubkeyHex
  pubkey: PubkeyHex
  groupId: string
  /** Label I chose. Stored on my device only, never sent. */
  name: string
  createdAt: number
}

export interface Match {
  contactId: PubkeyHex
  offer: PublicOffer
  matchedAt: number
}

export interface ChatMessage {
  id: string
  contactId: PubkeyHex
  mine: boolean
  kind: 'text' | 'system'
  text: string
  at: number
  /**
   * Delivery of my own text messages only. 'sending' until a relay took it,
   * 'failed' once every retry failed (retryChat sends it again). Undefined
   * means sent (older stored messages, and everything that is not mine).
   */
  status?: 'sending' | 'sent' | 'failed'
}

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
  errorKey?: 'expired' | 'invalid' | 'self' | 'already' | 'timeout' | 'network'
}

export interface Settings {
  lang: Lang
  sort: SortMode
  /**
   * Hackathon demo mode. Shortens the "answer one match round per contact"
   * window from 24 h to 20 s so a live demo can re-post offers.
   */
  demoMode: boolean
}

export const RESPOND_WINDOW_MS = 24 * 60 * 60 * 1000
export const RESPOND_WINDOW_DEMO_MS = 20 * 1000

// ---------------------------------------------------------------- key vault (src/lib/vault)

/** How the user wants the secret key locked on this device. */
export type LockChoice = { method: 'passkey' } | { method: 'password'; password: string } | { method: 'none' }
export type LockMethod = LockChoice['method']

/** What is stored in KV under "vault". Strings are base64url; `sk` is 64-hex. */
export type LockedVault =
  | { v: 1; method: 'passkey'; credId: string; iv: string; ct: string; salt: string }
  | { v: 1; method: 'password'; ncryptsec: string }
  | { v: 1; method: 'none'; sk: string }

/** Exported by src/lib/vault/index.ts */
export interface VaultModule {
  passkeySupported(): Promise<boolean>
  lockSecret(secretHex: string, choice: LockChoice, label: string): Promise<LockedVault>
  unlockSecret(v: LockedVault, password?: string): Promise<string>
  /** `ksb` = NIP-49 key-security byte (0x00 known insecure, 0x01 default, 0x02 unknown). */
  toNcryptsec(secretHex: string, password: string, logN?: number, ksb?: 0 | 1 | 2): Promise<string>
  fromNcryptsec(ncryptsec: string, password: string): Promise<string>
  /** Key-security byte of a backup without decrypting it; null if not a valid ncryptsec. */
  ncryptsecKeySecurity?(ncryptsec: string): 0 | 1 | 2 | null
}

/** Minimum password length for a password lock or a backup. */
export const MIN_PASSWORD = 8

export interface IlchonState {
  /**
   * 'setup'  = no identity on this profile yet; call createIdentity or restoreIdentity.
   * 'locked' = identity exists but is locked; call unlock.
   */
  boot: 'starting' | 'setup' | 'locked' | 'ready' | 'error'
  bootError?: string
  lock: {
    method: LockMethod | null
    /** Null until checked. */
    passkeySupported: boolean | null
    /** The user saved an ncryptsec backup (copied it or confirmed it) at least once. */
    backedUp: boolean
    /** The key was moved from the old plaintext storage; ask the user to pick a lock once. */
    migrated: boolean
  }
  me: { pubkey: PubkeyHex; npub: string } | null
  relays: RelayStatus[]
  contacts: Contact[]
  myOffer: Offer | null
  /** Contacts whose opposite, same-currency offer has been revealed to me. */
  matches: Match[]
  /** For the current offer: how many contacts were asked and how many answered. */
  matchProgress: { asked: number; answered: number }
  rooms: Record<PubkeyHex, ChatMessage[]>
  connect: ConnectState
  rates: Rates
  settings: Settings
}

export interface OfferInput {
  side: Side
  currency: Currency
  amount: number
  feePct: number
}

export interface IlchonActions {
  /** Replaces any existing offer and starts matching with every contact. */
  postOffer(input: OfferInput): Promise<void>
  withdrawOffer(): Promise<void>

  /** Opens the connect flow and shows my first QR. */
  startConnect(): void
  /** Called by the UI when the 30 s timer runs out. */
  rotateConnectCode(): void
  /** Text scanned from the peer's QR, or pasted. */
  submitScan(text: string): Promise<void>
  cancelConnect(): void

  renameContact(id: PubkeyHex, name: string): Promise<void>
  /**
   * Stop matching with this contact for real. The Marmot group is kept and I
   * keep answering with random labels, so the peer cannot tell.
   */
  deleteContact(id: PubkeyHex): Promise<void>

  /** Appends my message with status 'sending' and returns; the status follows delivery. */
  sendChat(contactId: PubkeyHex, text: string): Promise<void>
  /** Sends a 'failed' message of mine again and sets it back to 'sending'. */
  retryChat(contactId: PubkeyHex, messageId: string): Promise<void>
  /** Record a completed trade; reduces my open amount, withdraws at zero. */
  markDone(contactId: PubkeyHex, amount: number): Promise<void>

  setSettings(patch: Partial<Settings>): Promise<void>
  /** My secret key as nsec, for backup. Needs a recent reauth (throws 'reauth-required'). */
  exportKey(): string

  /*
   * Identity and lock. Failures reject with Error whose message is one of
   * 'wrong-password' | 'passkey-cancelled' | 'prf-unsupported' |
   * 'invalid-ncryptsec' | 'weak-password' | 'not-allowed' | 'corrupt' | 'no-vault' |
   * 'busy' | 'passkey-confirm' (passkey made, tap again to read it) |
   * 'reauth-required' | 'identity-exists' (another tab made one) | 'unsupported-log-n' |
   * 'cleanup-failed' (the new lock is stored, but the old plaintext key could
   * not be deleted; boot retries the deletion and stops in 'error' until it works).
   */
  /** Only in boot 'setup': new key, lock it, then finish boot. */
  createIdentity(choice: LockChoice): Promise<void>
  /**
   * Only in boot 'setup': decrypt the backup now and keep the key in engine
   * memory, so restoreIdentity can start a passkey ceremony straight from the tap.
   */
  checkBackup(ncryptsec: string, password: string): Promise<void>
  /** Only in boot 'setup': decrypt an ncryptsec backup (reuses checkBackup's result), lock it with `choice`, then finish boot. */
  restoreIdentity(ncryptsec: string, password: string, choice: LockChoice): Promise<void>
  /** Only in boot 'locked'. Password is needed for a password lock. */
  unlock(password?: string): Promise<void>
  /**
   * Only in boot 'ready': prove the current lock again (passkey or password).
   * Opens a short window for changeLock, exportBackup and exportKey.
   * Method 'none' needs no proof.
   */
  reauth(password?: string): Promise<void>
  /** True while that window is open (always true for method 'none'). */
  reauthed(): boolean
  /** Only in boot 'ready': re-lock the key with another method. Needs reauth. */
  changeLock(choice: LockChoice): Promise<void>
  /** Only in boot 'ready': ncryptsec of my key. Needs reauth. Does not mark backedUp. */
  exportBackup(password: string): Promise<string>
  /** The user copied or confirmed saving the backup: sets lock.backedUp (persisted). */
  markBackedUp(): Promise<void>
  /**
   * Wipes this profile's local data and reloads. Rejects with 'reset-failed'
   * (and does not reload) when something could not be deleted; boot is then
   * 'error' with bootError 'reset-failed', and calling it again retries.
   * Rejects with 'reset-needs-unlock' (nothing deleted, state unchanged) when
   * the locked identity's message store cannot be found on this device.
   */
  resetAll(): Promise<void>
}

export interface EngineDeps {
  kv: KV
  marmot: MarmotModule
  match: MatchCrypto
  connect: ConnectModule
  rates: RatesSource
  relays: string[]
  namespace: string
  persistence: 'indexeddb' | 'memory'
  now?: () => number
  /** Key locking. Without it only method 'none' works (Node scripts). */
  vault?: VaultModule
  /** Node scripts: a missing identity is created with method 'none' instead of stopping in 'setup'. */
  autoIdentity?: boolean
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
  start(): Promise<void>
  stop(): Promise<void>
}
