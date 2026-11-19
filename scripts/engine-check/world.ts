/**
 * The world of a scenario on the fake transport and virtual time (scripts/fake-transport.ts):
 * its clock, hub, KVs and peers, each peer a real engine. Every scenario builds its own.
 *
 * Virtual time moves only through adv() and until(), which check the invariants after
 * every move; finish() checks them once more at the end of a scenario.
 */
import type { Currency, EngineDeps, IlchonActions, IlchonState, LnurlModule, MatchCrypto, PayMethod, ProfileStorage, PubkeyHex, Side } from '../../src/contracts'
import { type IlchonEngine, STORE_FORMAT, createEngine } from '../../src/engine/index'
import { LnurlFailure, parseLnAddress } from '../../src/lib/lnurl'
import { pubkeyOf } from '../../src/lib/marmot/keys'
import { matchCrypto } from '../../src/lib/match'
import { newMnemonic, secretFromMnemonic } from '../../src/lib/seed/index'
import { createPlainStorage } from '../../src/lib/store/plain'
import { type SupportLog, createSupportLog, watchEngine } from '../../src/lib/support-log/index'
import { type Envelope, type FakeClock, type FakeHub, type Fate, type HarnessKV, createFakeClock, createFakeHub, createHarnessKV } from '../fake-transport'
import { buildInvoice } from '../invoice-fixture'
import * as connectModule from '../../src/lib/connect'
import { assertInvariants, checkPublish, expectOnlyChannelRooms } from './invariants'
import { Fail, expect } from './report'

/** Both payment methods: the offer every scenario posts unless it says otherwise. */
export const BOTH: PayMethod[] = ['lightning', 'onchain']

export const START_MS = Date.UTC(2026, 10, 13, 0, 0, 0)
export const MIN = 60_000

// ---------------------------------------------------------------- world and peers

interface LabelEntry {
  me: string
  peer: PubkeyHex
  context: string
  /** Who sent m1 of the round the labels are for. */
  initiator: PubkeyHex
  offer: { side: Side; currency: Currency; methods: PayMethod[] } | null
  atMs: number
}

export interface World {
  /** Reading the clock only. Time moves through adv() and until(), never directly. */
  clock: Pick<FakeClock, 'now' | 'settle'>
  hub: FakeHub
  peers: Peer[]
  kvs: HarnessKV[]
  labelLog: LabelEntry[]
  /** Broken invariants seen inside onPublish; thrown at the next check. */
  violations: string[]
  /** pk -> pubkeys it deleted (set by the harness before deleteContact). INV-W2. */
  deleted: Map<PubkeyHex, Set<PubkeyHex>>
  /** INV-W1 holds only where every engine is honest. */
  honest: boolean
  /** Invariants a scenario turns off because the state it builds breaks them on purpose. */
  skip: Set<string>
  publishHooks: ((e: Envelope) => void)[]
  /** Connection codes shown in this world (S-LOG-REDACT looks for them in the logs). */
  payloads: string[]
  /** Every name a contact was given in this world (renameContact); no support log may hold one (S-REC-LOG). */
  names: Set<string>
}

/** Every world of the run: the last scenario searches all their support logs (S-LOG-SWEEP). */
export const allWorlds: World[] = []

export interface Peer {
  name: string
  /** The options it was made with; spawn() reads them each time (recover() switches `setup` on). */
  opts: PeerOpts
  /** The 12 words this peer's identity was made from (makePeer: an identity made by the app). */
  words: string
  sk: string
  pk: PubkeyHex
  /** Replaced by restore() (a new phone's store). */
  kv: HarnessKV
  /** The hub device of this peer; restore() moves it to a new one. */
  device: string
  /** Its clock is this far off (EngineDeps.now and its Welcome sentAt); see skew(). */
  offset: number
  world: World
  engine: IlchonEngine
  /** Tag of the KV handle the current engine writes through. */
  tag: string
  /** The current engine crashed and was not replaced yet. */
  dead: boolean
  resets: { reason: 'user' | 'format' }[]
  /** Replaces the engine with a new one on a new handle of the same KV (not started). */
  spawn(): void
  /** The peer's support log; it lives on across restarts and crashes, like localStorage. */
  log: SupportLog
  /** The log as "Copy log" would give it, with a header made at this virtual moment. */
  dumpLog(): string
  events: { event: string; info?: Record<string, string | number | boolean>; atMs: number; tag: string }[]
  state(): IlchonState
  readonly a: IlchonActions
  /**
   * The tab goes to the background and is frozen: this peer's timers that come due are held
   * (not run), and the hub holds every envelope to it. Its engine and store stay as they are.
   */
  freeze(): void
  /**
   * Back in view: the held timers run first, late (a frozen tab fires them on resume, maybe
   * before the visibility event), then the held envelopes are delivered.
   */
  thaw(): void
  /**
   * What this peer's screens show of one other peer, as a string (twin(): B's view of A). Read at every change of the store; each change lands in `views` with its
   * virtual moment. Unset: nothing is recorded.
   */
  view?: (st: IlchonState) => string
  views: string[]
}

/**
 * makePeer's options: { kv?, words?, relays?, tuning?, unreadable?,
 * lnurl? }. `lnurl` is the step that adds EngineDeps.lnurl; the rest
 * are here. `bare`, `setup` and `failResets` are this harness's own.
 */
export interface PeerOpts {
  kv?: HarnessKV
  /** The 12 words of the peer's identity; fresh ones when absent. */
  words?: string
  /** deps.relays and so the relays of the peer's fake transport (default ['fake://relay']). */
  relays?: string[]
  /** Shorter engine timers (EngineDeps.tuning, sendRetryMs among them). */
  tuning?: EngineDeps['tuning']
  /** What the peer's rate source (deps.rates) returns; none by default (trade checks pass TRADE_RATES). */
  rates?: Partial<Record<Currency, number>>
  /**
   * Stored rooms of this peer that cannot be read from its next start on (hub.unreadable
   * for each). The ids come from an earlier run on the same KV.
   */
  unreadable?: string[]
  /**
   * Seed nothing: the engine starts on the KV exactly as given (S-FORMAT). With an
   * empty KV it makes its own key (autoIdentity); call adoptKey() after start.
   */
  bare?: boolean
  /** With `bare`: no autoIdentity either, so an empty KV stops in boot 'setup' (S-REC-12). */
  setup?: boolean
  /** onReset throws this many times first (a reset that could not delete everything). */
  failResets?: number
  /**
   * The store says lock 'pin' and opens only with this PIN (pinLocked): the engine boots
   * 'locked' and waits for unlock, as after an auto-lock reload.
   */
  pin?: string
  /** The hub device (default 'main'): a second device of one key. */
  device?: string
  /**
   * EngineDeps.listRelays: the relays of my contact list. None by default,
   * so a peer runs no list sync; the S-REC scenarios pass ['fake://a', 'fake://b'].
   */
  listRelays?: string[]
  /** The peer's clock is this far ahead (negative: behind), engine and Welcome sentAt alike. */
  nowOffsetMs?: number
  /**
   * EngineDeps.lnurl. Without it: the real parseAddress, and a
   * check and invoice that fail as an unreachable wallet service would (no network here).
   * PM-7, PM-8 and the crash sweep pass fakeLnurl().
   */
  lnurl?: LnurlModule
}

/** The default lookup module of a harness peer: nothing is ever fetched. */
const OFFLINE_LNURL: LnurlModule = {
  parseAddress: parseLnAddress,
  check: async () => {
    throw new LnurlFailure('unreachable')
  },
  invoice: async () => {
    throw new LnurlFailure('unreachable')
  },
}

/** A hand-built mainnet invoice for exactly `sats`, made now (scripts/invoice-fixture.ts). */
export function invoiceFor(w: World, sats: number, createdAtSec = Math.floor(w.clock.now() / 1000)): string {
  return buildInvoice(`lnbc${sats * 10}n`, createdAtSec)
}

export interface FakeLnurl {
  module: LnurlModule
  /** Every invoice() call, in order. */
  calls: { address: string; sats: number }[]
  /** Every check() call, in order. */
  checks: string[]
  /** invoice() waits this long on the world's virtual clock first. */
  delayMs: number
  /** invoice() rejects with this instead (after the delay). */
  fail: (() => Error) | null
  /** check() rejects with this. */
  checkFail: (() => Error) | null
  /** invoice() answers this instead of an exact invoice. */
  answer: ((sats: number) => string) | null
}

/** A wallet service for the harness: records calls, answers exactly, can wait or refuse. */
export function fakeLnurl(w: World): FakeLnurl {
  const f: FakeLnurl = {
    calls: [],
    checks: [],
    delayMs: 0,
    fail: null,
    checkFail: null,
    answer: null,
    module: {
      parseAddress: parseLnAddress,
      async check(address) {
        f.checks.push(address)
        if (f.checkFail) throw f.checkFail()
      },
      async invoice(address, sats) {
        f.calls.push({ address, sats })
        const wait = f.delayMs
        if (wait > 0) await new Promise<void>((res) => (timeOf.get(w) as FakeClock).timers.set(res, wait))
        if (f.fail) throw f.fail()
        return f.answer ? f.answer(sats) : invoiceFor(w, sats)
      },
    },
  }
  return f
}

/**
 * The plain store behind a PIN, for the harness only: status() says 'pin', unlock and
 * verify want the PIN. No KDF and no count (check-storage covers those); what matters
 * here is that the engine reads nothing and runs no transport until unlock.
 */
function pinLocked(inner: ProfileStorage, pin: string): ProfileStorage {
  const proven = (proof: { method: string; pin?: string }) => {
    if (proof?.method !== 'pin') throw new Error('not-allowed')
    if (proof.pin !== pin) throw new Error('wrong-pin')
  }
  return {
    ...inner,
    async status() {
      const st = await inner.status()
      return st && { method: 'pin', waitUntil: 0 }
    },
    async unlock(proof) {
      proven(proof)
      return inner.unlock({ method: 'none' })
    },
    async verify(proof) {
      proven(proof)
    },
  }
}

/** The one clock of each world that moves time. Only adv() and until() reach it. */
const timeOf = new WeakMap<World, FakeClock>()

export function newWorld(opts: { honest?: boolean; skip?: string[]; inboxMax?: number; acceptDelayMs?: number } = {}): World {
  const clock = createFakeClock(START_MS)
  const hub = createFakeHub(clock, { inboxMax: opts.inboxMax, acceptDelayMs: opts.acceptDelayMs })
  const w: World = {
    clock: { now: clock.now, settle: clock.settle },
    hub,
    peers: [],
    kvs: [],
    labelLog: [],
    violations: [],
    deleted: new Map(),
    honest: opts.honest ?? true,
    skip: new Set(opts.skip ?? []),
    publishHooks: [],
    payloads: [],
    names: new Set(),
  }
  allWorlds.push(w)
  timeOf.set(w, clock)
  hub.onPublish = (e) => {
    checkPublish(w, e)
    for (const h of w.publishHooks) h(e)
  }
  // The transport's warnings reach the peer's support log, as src/engine/browser.ts wires them.
  hub.onWarn = (pk, phrase, values) => peerOf(w, pk)?.log.marmot(phrase, values)
  return w
}

/** Wraps MatchCrypto: every labelsFor is written to the label log (INV-W1, INV-M3). */
function recordLabels(match: MatchCrypto, labelLog: LabelEntry[], name: string, clock: World['clock']): MatchCrypto {
  return {
    labelsFor(args) {
      labelLog.push({
        me: name,
        peer: args.peerPubkey,
        context: args.context,
        initiator: args.initiator,
        offer: args.offer ? { side: args.offer.side, currency: args.offer.currency, methods: [...args.offer.methods] } : null,
        atMs: clock.now(),
      })
      return match.labelsFor(args)
    },
    round1: (labels) => match.round1(labels),
    round2: (labels, p) => match.round2(labels, p),
    round3: (secret, q, pq) => match.round3(secret, q, pq),
    finish: (pq, qp) => match.finish(pq, qp),
  }
}

/** n fresh sets of 12 words whose derived pubkeys sort ascending. */
export function orderedKeys(n: number): { words: string; sk: string }[] {
  const keys = Array.from({ length: n }, () => {
    const words = newMnemonic()
    return { words, sk: secretFromMnemonic(words) }
  })
  return keys.sort((x, y) => (pubkeyOf(x.sk) < pubkeyOf(y.sk) ? -1 : 1))
}

export function makePeer(w: World, name: string, opts: PeerOpts = {}): Peer {
  const words = opts.words ?? newMnemonic()
  const sk = secretFromMnemonic(words)
  const kv = opts.kv ?? createHarnessKV()
  if (!w.kvs.includes(kv)) w.kvs.push(kv)
  // The lock-free plain store: my identity, made by the app from
  // 12 words (so it keeps them), and the store format that goes with it (an identity
  // without the format would be wiped as data of another format). Engine keys
  // stay readable in the harness KV.
  if (!opts.bare && kv.peek('identity') === undefined) {
    kv.seed('identity', { v: 1, sk, words })
    kv.seed('format', STORE_FORMAT)
  }
  for (const groupId of opts.unreadable ?? []) w.hub.unreadable(pubkeyOf(sk), groupId)
  let gen = 0
  let failResets = opts.failResets ?? 0
  let unwatch: (() => void) | undefined
  // A per-peer gate over the world's virtual timers (freeze/thaw: a frozen background tab).
  const base = (timeOf.get(w) as FakeClock).timers
  type Gated = { inner: unknown; cancelled: boolean; fn: () => void }
  const gate = { frozen: false, held: [] as Gated[] }
  const timers = {
    set(fn: () => void, ms: number): unknown {
      const h: Gated = { inner: undefined, cancelled: false, fn }
      h.inner = base.set(() => {
        if (h.cancelled) return
        if (gate.frozen) gate.held.push(h)
        else fn()
      }, ms)
      return h
    },
    clear(handle: unknown): void {
      const h = handle as Gated | undefined
      if (!h) return
      h.cancelled = true
      base.clear(h.inner)
    },
  }
  let prevRoute: ((e: Envelope) => Fate) | undefined
  const p = {
    name,
    opts,
    log: createSupportLog({ now: w.clock.now }),
    words,
    sk,
    pk: pubkeyOf(sk),
    kv,
    device: opts.device ?? 'main',
    offset: opts.nowOffsetMs ?? 0,
    world: w,
    dead: false,
    resets: [] as Peer['resets'],
    events: [] as Peer['events'],
    views: [] as string[],
    state: () => p.engine.store.getState(),
    get a() {
      // Names given to contacts are recorded for the support log searches (S-REC-LOG).
      const actions = p.engine.actions
      return new Proxy(actions, {
        get(target, key, receiver) {
          if (key !== 'renameContact') return Reflect.get(target, key, receiver)
          return (pk: PubkeyHex, name: string) => {
            w.names.add(name)
            return target.renameContact(pk, name)
          }
        },
      })
    },
    dumpLog() {
      const s = p.engine.store.getState()
      return p.log.dump({
        app: 'check (development)',
        time: new Date(w.clock.now()).toISOString().replace(/\.\d{3}Z$/, 'Z'),
        browser: 'check-engine',
        installed: 'no',
        lang: 'en',
        online: 'yes',
        'storage persisted': 'no',
        lock: s.lock.method ?? 'none-yet',
        boot: s.boot,
        relays: s.relays.map((r) => `${r.url} ${r.connected ? 'connected' : 'not connected'}`).join(', ') || 'none',
      })
    },
  } as Peer
  p.spawn = () => {
    gen++
    const tag = `${name}#${gen}`
    p.tag = tag
    p.dead = false
    w.hub.setOffset(p.pk, p.device, p.offset)
    p.engine = createEngine(
      {
        storage: opts.pin ? pinLocked(createPlainStorage(p.kv.handle(tag), { format: STORE_FORMAT }), opts.pin) : createPlainStorage(p.kv.handle(tag), { format: STORE_FORMAT }),
        marmot: w.hub.marmot(p.device),
        match: recordLabels(matchCrypto, w.labelLog, name, w.clock),
        connect: connectModule,
        rates: { fetch: async () => ({ ...opts.rates }) },
        lnurl: opts.lnurl ?? OFFLINE_LNURL,
        relays: opts.relays ?? ['fake://relay'],
        ...(opts.listRelays ? { listRelays: opts.listRelays } : {}),
        namespace: `check:${name}`,
        persistence: 'memory',
        now: () => w.clock.now() + p.offset,
        timers,
        autoIdentity: !opts.setup,
        tuning: opts.tuning,
      },
      {
        defaultLang: 'en',
        debug: (event, info) => {
          p.events.push({ event, info, atMs: w.clock.now(), tag })
          // As src/engine/browser.ts does: the allow list decides what makes a line.
          p.log.engine(event, info)
        },
        onReset: (info) => {
          p.resets.push({ ...info })
          if (failResets > 0) {
            failResets--
            throw new Error('reset-failed')
          }
        },
      },
    )
    unwatch?.()
    const unlog = watchEngine(p.log, p.engine.store, () => w.clock.now() - START_MS)
    const look = (st: IlchonState): void => {
      if (!p.view) return
      const v = p.view(st)
      const last = p.views[p.views.length - 1]
      if (last === undefined || last.slice(last.indexOf(' ') + 1) !== v) p.views.push(`${w.clock.now() - START_MS} ${v}`)
    }
    const unview = p.engine.store.subscribe(look)
    look(p.engine.store.getState())
    unwatch = () => {
      unlog()
      unview()
    }
  }
  p.freeze = () => {
    gate.frozen = true
    const route = w.hub.route
    prevRoute = route
    w.hub.route = (e) => (e.to === p.pk ? 'hold' : route(e))
  }
  p.thaw = () => {
    gate.frozen = false
    const held = gate.held.splice(0)
    for (const h of held) if (!h.cancelled) h.fn()
    if (prevRoute) w.hub.route = prevRoute
    prevRoute = undefined
    for (const id of w.hub.held()) {
      const e = w.hub.log.find((x) => x.id === id)
      if (e?.to === p.pk) w.hub.release(id)
    }
  }
  p.spawn()
  w.peers.push(p)
  return p
}

/** A bare peer started on an empty KV made its own key: take it as the peer's. */
export function adoptKey(p: Peer): void {
  const id = p.kv.peek<{ sk?: string; words?: string }>('identity')
  if (typeof id?.sk !== 'string' || typeof id.words !== 'string') throw new Fail(`${p.name} stored no key or no words`)
  p.words = id.words
  p.sk = id.sk
  p.pk = pubkeyOf(id.sk)
}

/** await engine.stop(), close the old handle, start a new engine on a new handle of the same KV. */
export async function restart(p: Peer): Promise<void> {
  await p.engine.stop()
  p.kv.close(p.tag, 'stop')
  p.spawn()
  await p.engine.start()
}

/** The power went off: the engine stops without waiting for its writes, its handle closes, a new engine starts. */
export function powerOff(p: Peer): void {
  if (p.dead) return
  p.dead = true
  void p.engine.stop()
  p.kv.close(p.tag, 'crash')
}

/**
 * The end of a scenario: the invariants once more, no late writes, then every engine
 * stops (clears the real rates interval). Crashed engines are left alone.
 */
export async function finish(w: World): Promise<void> {
  assertInvariants(w, true)
  // INV-CH3 at the end of every scenario, not only in S-CH-SWEEP.
  expectOnlyChannelRooms(w)
  for (const kv of w.kvs) {
    expect(kv.lateWrites.length === 0, `no writes after stop (${kv.lateWrites.map((x) => `${x.tag}:${x.op}:${x.key}`).join(', ')})`)
  }
  for (const p of w.peers) if (!p.dead) await p.engine.stop()
}

/** The peer of a key; a running one first (a restored or second device shares the key). */
export function peerOf(w: World, pk: PubkeyHex): Peer | undefined {
  return w.peers.find((p) => p.pk === pk && !p.dead) ?? w.peers.find((p) => p.pk === pk)
}

export function hasContact(x: Peer, y: Peer): boolean {
  return x.state().contacts.some((c) => c.pubkey === y.pk)
}

/** Moves virtual time (timers fire in order) and checks the invariants. */
export async function adv(w: World, ms: number): Promise<void> {
  await (timeOf.get(w) as FakeClock).advance(ms)
  assertInvariants(w)
}

/** Moves virtual time until pred holds (at most maxMs) and checks the invariants. */
export async function until(w: World, pred: () => boolean, maxMs: number, what: string): Promise<void> {
  try {
    await (timeOf.get(w) as FakeClock).until(pred, maxMs)
  } catch {
    throw new Fail(`timed out: ${what}`)
  }
  assertInvariants(w)
}

export function settled(p: Peer): boolean {
  const { asked, answered } = p.state().matchProgress
  return asked > 0 && answered >= asked
}

/** Both scan each other's QR (the inviter first) until both list the other. */
export async function link(w: World, x: Peer, y: Peer): Promise<void> {
  x.a.startConnect()
  y.a.startConnect()
  const px = x.state().connect.myPayload ?? ''
  const py = y.state().connect.myPayload ?? ''
  w.payloads.push(px, py)
  const [first, firstScans, second, secondScans] = x.pk < y.pk ? [x, py, y, px] : [y, px, x, py]
  const s1 = first.a.submitScan(firstScans)
  await adv(w, 200)
  const s2 = second.a.submitScan(secondScans)
  await until(w, () => hasContact(x, y) && hasContact(y, x), 120_000, `${x.name} and ${y.name} link`)
  await Promise.all([s1, s2])
  x.a.cancelConnect()
  y.a.cancelConnect()
}

export function sent(w: World, from: Peer, to: Peer, t?: string): Envelope[] {
  return w.hub.log.filter((e) => e.from === from.pk && e.to === to.pk && !e.injected && (t === undefined || e.t === t))
}

export async function deleteContact(w: World, x: Peer, y: Peer): Promise<void> {
  const set = w.deleted.get(x.pk) ?? new Set<PubkeyHex>()
  set.add(y.pk)
  w.deleted.set(x.pk, set)
  await x.a.deleteContact(y.pk)
}
