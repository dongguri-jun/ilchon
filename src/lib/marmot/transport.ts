import type { Rumor } from 'applesauce-common/helpers/gift-wrap'
import { bytesToHex, getEventHash, type NostrEvent } from 'applesauce-core/helpers/event'
import { PrivateKeySigner } from 'applesauce-signers'
import {
  ADDRESSABLE_KEY_PACKAGE_KIND,
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
  type Unsubscribable,
} from '@internet-privacy/marmot-ts'
import {
  APP_NAME,
  ILCHON_KIND,
  type IncomingInvite,
  type IncomingMessage,
  type PubkeyHex,
  type RelayStatus,
  type Transport,
  type TransportOptions,
  type Unsub,
  type WireMessage,
} from '../../contracts'
import { isHex64, pubkeyOf, secretKeyBytes, short } from './keys'
import { debugEnabled, errorText, log, warn } from './log'
import { RelayNetwork, anyAccepted, describePublish, newestBy } from './network'
import { createStores, loadClientId, marmotDatabaseName, type MarmotStores } from './stores'
import { parseWireMessage } from './wire'

type Client = MarmotClient<undefined, undefined>
type Group = MarmotGroup<undefined, undefined>

/** Name of every ilchon group. Lives inside the encrypted group state. */
const GROUP_NAME = APP_NAME

const SEND_TIMEOUT_MS = 30_000
const CATCH_UP_TIMEOUT_MS = 15_000
const SELF_UPDATE_TIMEOUT_MS = 20_000
/** How often and how long to wait for a peer's KeyPackage to show up. */
const KEY_PACKAGE_FETCH_TRIES = 4
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
const STARTUP_CLEANUP_DELAY_MS = 3 * 60 * 1000
const SEEN_RUMOR_CAPACITY = 10_000
/**
 * Incoming messages of a group are collected for a moment and handed over
 * sorted by the sender's sequence tag, because a relay backfill yields them
 * in relay order, not in sending order.
 */
const REORDER_IDLE_MS = 60
const REORDER_MAX_MS = 400
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

interface Inbox {
  queue: { seq: number; message: IncomingMessage }[]
  /** While set, nothing is delivered (invite/accept has not returned yet). */
  held: boolean
  firstAt: number
  cancel: (() => void) | undefined
}

/** How long start() waits for another holder of the profile to let go. */
const PROFILE_LOCK_WAIT_MS = 2_000

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

class MarmotTransport implements Transport {
  readonly pubkey: PubkeyHex

  readonly #relays: string[]
  readonly #signer: PrivateKeySigner
  readonly #network: RelayNetwork
  readonly #stores: MarmotStores
  /** Identifies the stored state: one live transport and one tab at a time. */
  readonly #profile: string
  readonly #durable: boolean
  #releaseProfileLock: (() => void) | undefined

  #client: Client | undefined
  #slot: string | undefined
  #starting: Promise<Client> | undefined
  #stopped = false

  #wired = false
  /** Set once start() reached the point where groups may connect to relays. */
  #connectEnabled = false
  readonly #connections = new Map<string, GroupConnection>()
  #unwatchStatus: (() => void) | undefined
  #inviteSubscription: Unsubscribable | undefined
  /** Cancel functions of pending timers. */
  readonly #timers = new Set<() => void>()

  readonly #inviteCallbacks = new Set<(invite: IncomingInvite) => void>()
  readonly #messageCallbacks = new Set<(message: IncomingMessage) => void>()
  /** Welcomes surfaced but neither accepted nor ignored yet. */
  readonly #invites = new Map<string, { rumor: UnreadInvite; invite: IncomingInvite }>()
  /** Invite ids already surfaced or dropped in this session. */
  readonly #knownInvites = new Set<string>()
  readonly #accepting = new Map<string, Promise<{ groupId: string }>>()
  readonly #inviting = new Map<PubkeyHex, Promise<{ groupId: string }>>()

  /** Detach functions for the message listener of each loaded group. */
  readonly #attached = new Map<string, () => void>()
  readonly #seenRumors = new Set<string>()
  /** Per-group reorder buffer for incoming messages. */
  readonly #inboxes = new Map<string, Inbox>()
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
  /** Per-group send chain so messages leave in call order. */
  readonly #sendTails = new Map<string, Promise<void>>()
  #rotation: Promise<void> = Promise.resolve()

  constructor(opts: TransportOptions) {
    if (!opts.relays.length) throw new Error('at least one relay is required')
    this.pubkey = pubkeyOf(opts.secretKeyHex)
    this.#relays = [...new Set(opts.relays)]
    this.#signer = new PrivateKeySigner(secretKeyBytes(opts.secretKeyHex))
    this.#network = new RelayNetwork(this.#relays, this.#signer)
    this.#stores = createStores(opts.namespace, this.pubkey, opts.persistence)
    this.#profile = marmotDatabaseName(opts.namespace, this.pubkey)
    this.#durable = opts.persistence === 'indexeddb'
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

  async #start(): Promise<Client> {
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
    // traffic is ingested, so backfilled messages are not missed.
    const groups = await client.groups.loadAll()
    this.#assertRunning()
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
    // Each group is connected by the transport itself and retried until it is
    // live: one failed backfill must not leave a contact deaf for the session.
    this.#connectEnabled = true
    for (const group of client.groups.loaded) this.#connectGroup(group)
    this.#unwatchStatus ??= this.#network.watchStatus((status) => {
      if (status.some((relay) => relay.connected)) this.#retryConnections()
    })

    await Promise.all([this.#publishRelayLists(), this.#ensureKeyPackage(client, slot, false)])
    this.#assertRunning()

    this.#inviteSubscription ??= await client.invites.listen(this.#relays)
    this.#assertRunning()
    for (const rumor of await client.invites.getUnread()) void this.#onWelcome(rumor)

    this.#scheduleStartupCleanup(client, slot)
    log('started', short(this.pubkey), 'groups:', client.groups.loaded.length)
    return client
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
    client.groups.on('unreadable', (groupId) => log('unreadable group event in', short(bytesToHex(groupId))))
    client.groups.on('rejected', (groupId, _event, reason) =>
      log('rejected group event in', short(bytesToHex(groupId)), reason),
    )
    client.groups.on('ingestResult', (groupId, result) => {
      if (!debugEnabled()) return
      const detail =
        result.kind === 'processed' ? result.result.kind : 'reason' in result ? String(result.reason) : ''
      log('ingest', short(this.pubkey), short(bytesToHex(groupId)), result.kind, detail)
    })
    client.invites.on('decrypted', (rumor) => void this.#onWelcome(rumor))
    client.invites.on('error', (error) => log('invite could not be read:', error.message))
  }

  async stop(): Promise<void> {
    if (this.#stopped) return
    this.#stopped = true
    for (const cancel of this.#timers) cancel()
    this.#timers.clear()
    this.#inviteSubscription?.unsubscribe()
    this.#unwatchStatus?.()
    this.#unwatchStatus = undefined
    for (const conn of this.#connections.values()) this.#closeConnection(conn)
    this.#connections.clear()
    for (const detach of this.#attached.values()) detach()
    this.#attached.clear()
    for (const inbox of this.#inboxes.values()) inbox.cancel?.()
    this.#inboxes.clear()
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
  }

  relayStatus(): RelayStatus[] {
    return this.#network.status()
  }

  onRelayStatus(cb: (s: RelayStatus[]) => void): Unsub {
    return this.#network.watchStatus(cb)
  }

  // ------------------------------------------------------------ identity on relays

  /** Kind 10002 (where my KeyPackage lives) and 10050 (where Welcomes go). */
  async #publishRelayLists(): Promise<void> {
    const drafts = [
      createNip65RelayListEvent({ pubkey: this.pubkey, relays: this.#relays }),
      createInboxRelayListEvent({ pubkey: this.pubkey, relays: this.#relays }),
    ]
    await Promise.all(
      drafts.map(async (draft) => {
        const event = await this.#signer.signEvent(draft)
        const results = await this.#network.publish(this.#relays, event)
        if (!anyAccepted(results)) {
          throw new Error(`relay list (kind ${event.kind}) was not accepted: ${describePublish(results)}`)
        }
        log('relay list', event.kind, describePublish(results))
      }),
    )
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
      const created = await client.keyPackages.create({ relays: this.#relays, identifier: slot })
      const ref = bytesToHex(created.keyPackageRef)
      pkg = (await client.keyPackages.list()).find((p) => bytesToHex(p.keyPackageRef) === ref)
    }
    const event = pkg ? newestPublished(pkg) : undefined
    if (!event) throw new Error('KeyPackage could not be created')
    await this.#confirmKeyPackage(event, slot)
  }

  /**
   * marmot-ts records a KeyPackage as published even if every relay refused
   * it (issue #126), so read it back and republish until a relay serves it.
   */
  async #confirmKeyPackage(event: NostrEvent, slot: string): Promise<void> {
    let problem = 'not found on any relay'
    for (let attempt = 0; attempt < KEY_PACKAGE_CONFIRM_TRIES; attempt++) {
      this.#assertRunning()
      try {
        const { events } = await this.#network.requestAny(this.#relays, {
          kinds: [ADDRESSABLE_KEY_PACKAGE_KIND],
          authors: [this.pubkey],
          '#d': [slot],
        })
        if (events.some((found) => found.id === event.id)) {
          log('key package confirmed on relay', short(event.id))
          return
        }
      } catch (error) {
        problem = errorText(error)
      }
      try {
        const results = await this.#network.publishAll(this.#relays, event)
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
      const { events } = await this.#network.requestAny(this.#relays, {
        kinds: [ADDRESSABLE_KEY_PACKAGE_KIND],
        authors: [this.pubkey],
        '#d': [slot],
      })
      if (events.some((found) => found.id === event.id)) {
        log('key package confirmed on relay', short(event.id))
        return
      }
    } catch (error) {
      problem = errorText(error)
    }
    throw new Error(`KeyPackage is not available on any relay: ${problem}`)
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

  invitePeer(peerPubkey: PubkeyHex): Promise<{ groupId: string }> {
    if (!isHex64(peerPubkey)) return Promise.reject(new Error('peer pubkey must be 64 lowercase hex'))
    if (peerPubkey === this.pubkey) return Promise.reject(new Error('cannot invite myself'))
    const running = this.#inviting.get(peerPubkey)
    if (running) return running
    const invite = this.#invitePeer(peerPubkey).finally(() => {
      if (this.#inviting.get(peerPubkey) === invite) this.#inviting.delete(peerPubkey)
    })
    this.#inviting.set(peerPubkey, invite)
    return invite
  }

  async #invitePeer(peer: PubkeyHex): Promise<{ groupId: string }> {
    const client = await this.#ready()
    const candidates = await this.#fetchKeyPackages(peer)

    const group = await client.groups.create(GROUP_NAME, {
      relays: this.#relays,
      adminPubkeys: [this.pubkey],
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
      const results = await client.groups.send(
        group.id,
        createInviteIntent({ keyPackageEvent: chosen, actorPubkey: this.pubkey }),
      )
      if (!results.some((result) => anyAccepted(result.response))) {
        throw new Error('no relay accepted the group commit')
      }
      const outcomes = results.flatMap((result) =>
        result.welcomeDelivery.kind === 'attempted' ? result.welcomeDelivery.outcomes : [],
      )
      const failures = outcomes.flatMap((outcome) => (outcome.kind === 'failed' ? [outcome.error] : []))
      const delivered = outcomes.some(
        (outcome) => outcome.kind === 'succeeded' && anyAccepted(outcome.response),
      )
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
      const { events } = await this.#network.requestAny(this.#relays, {
        kinds: [NIP65_RELAY_LIST_KIND],
        authors: [peer],
      })
      const newest = newestBy(events.filter((event) => event.pubkey === peer))
      const write = newest ? getNip65Relays(newest, 'write') : []
      if (write.length) return write
    } catch (error) {
      log('relay list lookup failed for', short(peer), errorText(error))
    }
    return this.#relays
  }

  /** Always fetched from the relays at invite time. Newest first. */
  async #fetchKeyPackages(peer: PubkeyHex): Promise<NostrEvent[]> {
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
          .sort((a, b) => b.created_at - a.created_at)
        if (own.length) return own
        problem = 'none published'
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
    this.#knownInvites.add(rumor.id)
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
    }
    this.#invites.set(rumor.id, { rumor, invite })
    log('invite from', short(rumor.pubkey))
    for (const cb of this.#inviteCallbacks) this.#call(cb, invite)
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
    const rumor =
      this.#invites.get(inviteId)?.rumor ??
      (await client.invites.getUnread()).find((entry) => entry.id === inviteId)
    if (!rumor) throw new Error('invite not found')

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
      await withTimeout(group.selfUpdate(), SELF_UPDATE_TIMEOUT_MS, 'self-update').catch(
        (error: unknown) => warn('self-update after join failed', errorText(error)),
      )
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
    await withTimeout(connecting, CATCH_UP_TIMEOUT_MS, 'group backfill').catch((error: unknown) =>
      warn('group backfill after join failed', errorText(error)),
    )
  }

  async ignoreInvite(inviteId: string): Promise<void> {
    const client = await this.#ready()
    this.#invites.delete(inviteId)
    this.#knownInvites.add(inviteId)
    // Local only: nothing is published, the inviter learns nothing.
    await client.invites.markAsRead(inviteId)
  }

  // ------------------------------------------------------------ messages

  async send(groupId: string, msg: WireMessage): Promise<void> {
    const client = await this.#ready()
    const group =
      client.groups.loaded.find((candidate) => candidate.idStr === groupId) ??
      (await client.groups.get(groupId))
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
    // when no group relay acknowledged it.
    const results = await withTimeout(
      client.groups.send(group.id, createApplicationMessageIntent(rumor)),
      SEND_TIMEOUT_MS,
      'send',
    )
    if (!results.some((result) => anyAccepted(result.response))) {
      throw new Error('no relay accepted the message')
    }
  }

  onMessage(cb: (m: IncomingMessage) => void): Unsub {
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

  async listGroups(): Promise<{ groupId: string; peerPubkey: PubkeyHex }[]> {
    const client = await this.#ready()
    const groups: { groupId: string; peerPubkey: PubkeyHex }[] = []
    for (const group of client.groups.loaded) {
      if (group.status !== 'active') continue
      const others = getGroupMemberPubkeys(group.state).filter((member) => member !== this.pubkey)
      if (others.length === 1) groups.push({ groupId: group.idStr, peerPubkey: others[0] })
    }
    return groups
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
    this.#attached.set(groupId, () => group.off('ingestResult', onIngestResult))
    this.#connectGroup(group)
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
    if (!msg) return
    const message: IncomingMessage = {
      groupId,
      senderPubkey: rumor.pubkey,
      msg,
      at: rumor.created_at,
      id: rumor.id,
    }
    const tagged = Number(rumor.tags.find((tag) => tag[0] === SEQ_TAG)?.[1])
    const seq = Number.isFinite(tagged) ? tagged : rumor.created_at * 1000
    const inbox = this.#inbox(groupId)
    if (!inbox.queue.length) inbox.firstAt = Date.now()
    inbox.queue.push({ seq, message })
    if (!inbox.held) this.#armFlush(groupId, inbox)
  }

  #inbox(groupId: string): Inbox {
    let inbox = this.#inboxes.get(groupId)
    if (!inbox) {
      inbox = { queue: [], held: false, firstAt: 0, cancel: undefined }
      this.#inboxes.set(groupId, inbox)
    }
    return inbox
  }

  /** Flush once the burst went quiet, at the latest REORDER_MAX_MS after its start. */
  #armFlush(groupId: string, inbox: Inbox): void {
    inbox.cancel?.()
    const wait = Math.max(0, Math.min(REORDER_IDLE_MS, inbox.firstAt + REORDER_MAX_MS - Date.now()))
    const timer = setTimeout(() => this.#flush(groupId), wait)
    inbox.cancel = () => clearTimeout(timer)
  }

  #flush(groupId: string): void {
    const inbox = this.#inboxes.get(groupId)
    if (!inbox || inbox.held) return
    inbox.cancel?.()
    inbox.cancel = undefined
    const batch = inbox.queue.splice(0).sort((a, b) => a.seq - b.seq)
    for (const { message } of batch) this.#deliver(message)
  }

  #deliver(message: IncomingMessage): void {
    if (this.#stopped) return
    if (!this.#messageCallbacks.size) {
      this.#undelivered.push(message)
      return
    }
    for (const cb of this.#messageCallbacks) this.#call(cb, message)
  }

  /** Keep a group's messages back until {@link #release}. */
  #hold(groupId: string): void {
    const inbox = this.#inbox(groupId)
    inbox.held = true
    inbox.cancel?.()
    inbox.cancel = undefined
  }

  /**
   * Deliver held messages on the next task, i.e. after the promise that hands
   * the group id to the caller has resolved.
   */
  #release(groupId: string): void {
    setTimeout(() => {
      const inbox = this.#inboxes.get(groupId)
      if (!inbox) return
      inbox.held = false
      this.#flush(groupId)
    }, 0)
  }

  #discard(groupId: string): void {
    this.#inboxes.get(groupId)?.cancel?.()
    this.#inboxes.delete(groupId)
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
