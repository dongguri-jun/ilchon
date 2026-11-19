/**
 * pnpm check:boot — the start and the relays: the real transport and engine over fake WebSocket relays (scripts/fake-ws.ts), no
 * network. Real time; about two and a half minutes (157 s on 2026-11-18).
 *
 *   B1   no relay answers: start() keeps waiting instead of failing; stop() ends it
 *   B2   a stored room that cannot be read: the start finishes, that room is 'unreadable'
 *   B3   the engine without relays stays 'starting', never 'error'; stop() is clean
 *   B9   a broken store during the online step is still a boot error (not swallowed)
 *   B-STOP-LOCAL  stop() inside the local step (while an unfinished room is removed) and
 *        right after it (before the online loop) ends start() with 'transport is stopped'
 *   B12  Pause
 *   B13  send waits for a socket before encrypting; 'offline' leaves the group untouched
 *   B14  reconnectDelay, onlineRetryWait
 *   B15  strandTick
 *   B-STRAND  a room whose relays are out of reach while mine work: 'stranded' after 90 s
 *        of visible, online time (89 s not yet), hidden / offline / my relays down do not
 *        count but keep the sum, a connection to the room's relays resets it. The health
 *        ticks run on a hand-moved clock (healthClock); the relays are fake-ws.
 *   B-SILENT  one of four relays never answers: start, invite, accept and messages work
 *   B-ALL-SILENT  none of the relays answers: start() waits
 *   B-INBOX  the received-message inbox on the real transport: a message whose callback rejected is
 *        stored encrypted and comes again at the next start (once, before anything new); a
 *        handled one does not; a callback that sends during that start does not block it; a
 *        damaged entry is dropped
 *   B-TURN  a send of a room and the library's ingest of that room take turns (guardIngest,
 *        RoomTurns): marmot-ts 0.9.0 lets a send store the state it started from over a
 *        commit applied meanwhile, which left B-INBOX's inviter an epoch behind (the
 *        joiner's reply 'unreadable')
 *   B-ORDER  a backfill the library ingests slowly (a phone thawed after minutes in the
 *        background; the relays answer newest first) is handed over in sending order: the
 *        transport delivers nothing while an ingest of the room runs
 *   B-FLOOD  signed junk on the room's public h tag every 20 ms (one library ingest each)
 *        does not hold a real message past INGEST_HOLD_MAX_MS (5 s) plus slack.
 *        A smoke check of the wiring over real Marmot only: whether the junk keeps the room
 *        ingesting without a pause depends on the machine, so it cannot prove the bound. The
 *        gate for the bound is check-inbox R-3 (ingests back to back on a fake clock).
 *   B-FORGET  forgetGroup while a send of that room is under way: the send settles, the
 *        room's guard goes, the other room's sends and messages go on
 *   B8   relayListAction, parseRelayListRecord, nextListCreatedAt
 *   B16  my relay lists are signed only when the relays change: a second start
 *        with the same relays signs nothing and puts the stored pair again (relays, then
 *        indexers); changed relays sign once; unreachable relays fail the online step
 *        without signing (record unchanged, the start retries); a 'duplicate:' answer
 *        (OK false) counts as taken; a refused pair is signed again, later dated;
 *        a broken stored record is signed anew; a record that cannot be read is a boot error
 *   B-STRAND also: the first tick after 30 s hidden (a phone's timers slept) adds no
 *        hidden time: the page events settle the time with the state it had
 *
 * Relay settings and the switch to the default relays:
 *   B7   fallbackDue; RelayLiveness constructs and is destroyed
 *   B4   the engine passes relays and fallbackRelays from Settings (none / auto / strict / junk)
 *   B5   setSettings: too few, too many, the defaults as null, repeats and not allowed hosts dropped
 *   B6   none of the fallback relays answers either: no switch; the probes did go out to
 *        them (two in 12 s, waits 5 s then 15 s), so a watch that never runs fails
 *   B10  all chosen relays dead: switch to the fallback within 7 s; inbox, lists and KeyPackage
 *        there; no socket to the dead relays afterwards
 *   B-PARTIAL  only some of the fallback relays live: the switch works on those
 *   B11  my one relay drops after the start: switch; the lists name the new relays
 *   B-RETURN   the next start begins with my relay again (it is back): no switch, lists there
 *   B-AUTO / B-STRICT  the engine with dead relays of my own: automatic switching opens the
 *        app on the defaults (fallingBack); switched off it keeps waiting and sends nothing
 *        to the defaults
 *   B-COVER  strict mode, my relays unreachable: the connection problem, once shown, stays
 *        through retries, a hidden page coming back and an offline blip; only a relay that
 *        actually connects takes it down (UI pass fix A)
 *   B-SILENT-FALLBACK  chosen relays that never answer: no switch before 20 s of visible,
 *        online time (hand-moved health clock), then the switch; 10 minutes hidden with no
 *        tick (a phone asleep) count as nothing
 *   B-FLAP  a chosen relay that connects and drops again and again (it comes back during
 *        every 3 s confirmation): in 60 s of health clock at most 4 probes reach the
 *        fallback relays (waits 5, 15, 30 s), not one every few seconds
 *   B7 also: nextFallbackProbeAt (the waits and the hourly cap), silentTick
 *   B-SWITCH-SIGN  the switch and the relay-list rule (steps 20 and 21): one pair for the
 *        fallback list, dated after the stored one and after a pair this session signed
 *        but never stored; stored only for the list in use; no switch back in the
 *        session; the next start signs once for my relays again, dated later
 *
 * Fake relays: wss://fake-a.test … (wss://, so they pass the host
 * rule), dead ones wss://dead-1.test (refused at once), silent ones wss://silent-1.test
 * (never answer).
 */
import { isDeepStrictEqual } from 'node:util'
import { MarmotClient, MarmotGroup, type GenericKeyValueStore } from '@internet-privacy/marmot-ts'
import { PrivateKeySigner } from 'applesauce-signers'
import { RelayLiveness } from 'applesauce-relay'
import type { IncomingInvite, IncomingMessage, MarmotModule, Tables, Transport, TransportOptions } from '../src/contracts'
import { createEngine } from '../src/engine/index'
import * as connectModule from '../src/lib/connect'
import { createTransport, findList, generateSecretKeyHex, npubOf, pubkeyOf, setLogSink } from '../src/lib/marmot/index'
import { randomHex, secretKeyBytes } from '../src/lib/marmot/keys'
import { RelayNetwork, reconnectDelay } from '../src/lib/marmot/network'
import { loadClientId, storesFrom } from '../src/lib/marmot/stores'
import {
  FALLBACK_PROBES_PER_HOUR,
  FALLBACK_SILENT_MS,
  HEALTH_TICK_MS,
  ONLINE_RETRY_FLOOR_MS,
  Pause,
  RoomTurns,
  STRANDED_MS,
  fallbackDue,
  guardIngest,
  healthClock,
  nextFallbackProbeAt,
  nextListCreatedAt,
  onlineRetryWait,
  parseRelayListRecord,
  relayListAction,
  silentTick,
  strandTick,
} from '../src/lib/marmot/transport'
import { MAX_RELAYS } from '../src/lib/relays'
import { CONNECT_GRACE_MS, ConnectionProblemGate, problemKind, type ProblemKind } from '../src/screens/shell/connection-problem'
import { matchCrypto } from '../src/lib/match'
import { createLnurl } from '../src/lib/lnurl'
import { installFakeWebSocket } from './fake-ws'
import { nodeStorage, plainTextIn } from './node-storage'

const fake = installFakeWebSocket()
;(globalThis as { ILCHON_DEBUG?: boolean }).ILCHON_DEBUG = false

const FAKE_A = 'wss://fake-a.test'
const FAKE_B = 'wss://fake-b.test'
const FAKE_C = 'wss://fake-c.test'
const DEAD_1 = 'wss://dead-1.test'
const DEAD_2 = 'wss://dead-2.test'
const DEAD_3 = 'wss://dead-3.test'
const DEAD_4 = 'wss://dead-4.test'
const SILENT_1 = 'wss://silent-1.test'
const SILENT_2 = 'wss://silent-2.test'

let failures = 0
/** The names of the failed checks, printed again at the end so a rare failure is never lost in the output. */
const failedNames: string[] = []
const unhandled: unknown[] = []
process.on('unhandledRejection', (e) => unhandled.push(e))

function ok(cond: boolean, what: string): void {
  if (cond) console.log(`PASS  ${what}`)
  else {
    failures++
    failedNames.push(what)
    console.log(`FAIL  ${what}`)
  }
}

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms))

/** The outcome of `p` after at most `ms`: its value, its error message, or 'pending'. */
async function within<T>(p: Promise<T>, ms: number): Promise<{ state: 'ok'; value: T } | { state: 'error'; message: string } | { state: 'pending' }> {
  let out: { state: 'ok'; value: T } | { state: 'error'; message: string } | { state: 'pending' } = { state: 'pending' }
  const settled = p.then(
    (value) => (out = { state: 'ok', value }),
    (e: unknown) => (out = { state: 'error', message: e instanceof Error ? e.message : String(e) }),
  )
  await Promise.race([settled, sleep(ms)])
  return out
}

/** Settles `p` silently (its rejection is expected and checked elsewhere). */
function quiet<T>(p: Promise<T>): Promise<T> {
  p.catch(() => {})
  return p
}

let nsCount = 0
async function freshTables(): Promise<Tables> {
  const { storage } = nodeStorage(`check-boot:${++nsCount}`)
  return storage.create({ method: 'none' }, async () => {})
}

/** A table whose getItem throws 'storage-damaged' for `bad` keys (all keys when omitted). */
function damaged(tables: Tables, name: string, bad?: (key: string) => boolean): Tables {
  return {
    ...tables,
    table<T>(n: string): GenericKeyValueStore<T> {
      const inner = tables.table<T>(n)
      if (n !== name) return inner
      return {
        getItem: async (key: string) => {
          if (!bad || bad(key)) throw new Error('storage-damaged')
          return inner.getItem(key)
        },
        setItem: (key: string, value: T) => inner.setItem(key, value),
        removeItem: (key: string) => inner.removeItem(key),
        clear: () => inner.clear(),
        keys: () => inner.keys(),
      }
    },
  }
}

interface Peer {
  t: Transport
  sk: string
  tables: Tables
  invites: IncomingInvite[]
  messages: IncomingMessage[]
}

function transportOn(relays: string[], tables: Tables, sk = generateSecretKeyHex(), fallbackRelays?: string[]): Peer {
  const t = createTransport({
    secretKeyHex: sk,
    relays,
    fallbackRelays,
    lookupRelays: [],
    namespace: `check-boot:t${++nsCount}`,
    persistence: 'memory',
    tables,
  })
  const p: Peer = { t, sk, tables, invites: [], messages: [] }
  t.onInvite((i) => p.invites.push(i))
  t.onMessage((m) => void p.messages.push(m))
  return p
}

async function waitUntil(pred: () => boolean, ms: number): Promise<boolean> {
  const end = Date.now() + ms
  while (Date.now() < end) {
    if (pred()) return true
    await sleep(25)
  }
  return pred()
}

/** A invites B and B accepts; the group id. */
async function linkPair(A: Peer, B: Peer): Promise<string> {
  const invite = A.t.invitePeer(B.t.pubkey)
  const got = await waitUntil(() => B.invites.length > 0, 15_000)
  if (!got) throw new Error('no invite reached B')
  const [{ groupId }] = await Promise.all([invite, B.t.acceptInvite(B.invites[0].id)])
  return groupId
}

// ---------------------------------------------------------------- pure functions

function b14(): void {
  ok(
    reconnectDelay(0) === 1000 && reconnectDelay(1) === 1500 && reconnectDelay(6) === 11390.625 && reconnectDelay(7) === 15000 && reconnectDelay(20) === 15000,
    'B14 reconnectDelay: 1.5^n s, at most 15 s',
  )
  const cases: [Parameters<typeof onlineRetryWait>, number][] = [
    [['unreachable', 1, false], 5000],
    [['unreachable', 2, false], 15000],
    [['unreachable', 4, false], 60000],
    [['unreachable', 9, false], 60000],
    [['unreachable', 3, true], 2000],
    [['refused', 1, false], 60000],
    [['refused', 2, false], 120000],
    [['refused', 3, false], 240000],
    [['refused', 4, false], 300000],
    [['refused', 9, false], 300000],
    [['refused', 1, true], 60000],
  ]
  const wrong = cases.filter(([args, want]) => onlineRetryWait(...args) !== want).map(([a]) => a.join(','))
  ok(wrong.length === 0, `B14 onlineRetryWait${wrong.length ? ` (wrong: ${wrong.join(' / ')})` : ''}`)
}

function b15(): void {
  const up = { visible: true, online: true, mineUp: true, roomUp: false }
  ok(strandTick(50_000, 2_000, { ...up, roomUp: true }) === 0, 'B15 strandTick: a connection to the room relays resets to 0')
  ok(
    strandTick(50_000, 2_000, { ...up, visible: false }) === 50_000 && strandTick(50_000, 2_000, { ...up, online: false }) === 50_000 && strandTick(50_000, 2_000, { ...up, mineUp: false }) === 50_000,
    'B15 strandTick: hidden, offline or my relays down keep the value',
  )
  ok(strandTick(50_000, 2_000, up) === 52_000, 'B15 strandTick: visible, online, mine up, room down adds the elapsed time')
  let ms = 0
  for (let i = 0; i < 30; i++) {
    ms = strandTick(ms, HEALTH_TICK_MS, up)
    if (i % 6 === 0) ms = strandTick(ms, HEALTH_TICK_MS, { ...up, visible: false })
  }
  ok(ms === 60_000, `B15 30 ticks of 2 s with 5 hidden ones in between: 60000 (${ms})`)
  for (let i = 0; i < 15; i++) ms = strandTick(ms, HEALTH_TICK_MS, up)
  ok(ms === 90_000 && ms >= STRANDED_MS, `B15 45 ticks: 90000, stranded (${ms})`)
}

async function b12(): Promise<void> {
  const ended = (p: Pause) => within(p.done, 0).then((r) => r.state === 'ok')
  const p1 = new Pause(60_000, false)
  p1.wake()
  await sleep(100)
  const notWoken = !(await ended(p1))
  p1.abort()
  await sleep(10)
  ok(notWoken && (await ended(p1)), 'B12 Pause(60 s, not wakeable): wake() does nothing, abort() ends it')

  // The moment `done` settles is recorded, not sampled with a 1.9 s / 2.1 s sleep
  // pair: one event-loop stall of 100 ms near 1.9 s (load, GC) let both timers
  // fire together and the sample saw a correct Pause as "ended early".
  const p2 = new Pause(60_000, true)
  const woke = Date.now()
  let endedAfter = -1
  void p2.done.then(() => (endedAfter = Date.now() - woke))
  p2.wake()
  const r2 = await within(p2.done, 5_000)
  ok(r2.state === 'ok' && endedAfter >= ONLINE_RETRY_FLOOR_MS - 10 && endedAfter < 5_000, `B12 Pause(60 s, wakeable): woken at once still lasts 2 s, then ends (ended ${endedAfter} ms after wake)`)

  const p3 = new Pause(60_000, true)
  await sleep(3_000)
  p3.wake()
  await sleep(10)
  ok(await ended(p3), 'B12 Pause(60 s, wakeable): woken after 3 s ends at once')

  const p4 = new Pause(Infinity, false)
  p4.wake()
  await sleep(50)
  const waiting = !(await ended(p4))
  p4.abort()
  await sleep(10)
  ok(waiting && (await ended(p4)), 'B12 Pause(Infinity): only abort() ends it')
}

// ---------------------------------------------------------------- transport

async function b1(): Promise<void> {
  const p = transportOn([DEAD_1, DEAD_2], await freshTables())
  const start = quiet(p.t.start())
  const r = await within(start, 3_000)
  const status = p.t.relayStatus()
  ok(r.state === 'pending', `B1 no relay answers: start() still waits after 3 s (got ${r.state === 'error' ? r.message : r.state})`)
  ok(status.length === 2 && status.every((s) => !s.connected), 'B1 relayStatus: both relays, neither connected')
  ok(p.t.fallingBack() === false, 'B1 fallingBack() is false')
  await p.t.stop()
  const after = await within(start, 1_000)
  ok(after.state === 'error' && after.message === 'transport is stopped', `B1 stop() rejects the waiting start with 'transport is stopped' (got ${JSON.stringify(after)})`)
}

async function bAllSilent(): Promise<void> {
  const p = transportOn([SILENT_1, SILENT_2], await freshTables())
  const start = quiet(p.t.start())
  const r = await within(start, 3_000)
  ok(r.state === 'pending', `B-ALL-SILENT none of the relays answers: start() waits (got ${r.state === 'error' ? r.message : r.state})`)
  await p.t.stop()
  const after = await within(start, 1_000)
  ok(after.state === 'error' && after.message === 'transport is stopped', 'B-ALL-SILENT stop() ends it')
}

async function b2(): Promise<void> {
  const tables = await freshTables()
  const broken = 'ab'.repeat(32)
  await tables.table<object>('groups').setItem(broken, {})
  const stored = await tables.table<object>('groups').getItem(broken)
  const p = transportOn(
    [FAKE_A, FAKE_B],
    damaged(tables, 'groups', (k) => k === broken),
  )
  let calls = 0
  p.t.onGroupHealth(() => calls++)
  const r = await within(p.t.start(), 10_000)
  ok(r.state === 'ok', `B2 a broken stored room does not stop the start (got ${r.state === 'error' ? r.message : r.state})`)
  ok(p.t.groupHealth(broken) === 'unreadable', `B2 that room is 'unreadable' (got ${p.t.groupHealth(broken)})`)
  ok(p.t.groupHealth('cd'.repeat(32)) === 'missing', "B2 an id with no stored room is 'missing'")
  ok(calls >= 1, `B2 onGroupHealth was called (${calls})`)
  for (const id of [broken, 'cd'.repeat(32)]) {
    const s = await within(p.t.send(id, { t: 'chat', id: randomHex(16), text: 'x' }), 1_000)
    ok(s.state === 'error' && s.message === 'group-unreadable', `B2 send to ${p.t.groupHealth(id)}: 'group-unreadable' within 1 s (got ${JSON.stringify(s)})`)
  }
  ok(isDeepStrictEqual(await tables.table<object>('groups').getItem(broken), stored), 'B2 the broken room is left untouched')

  // stored rooms: listed without its peer; forgetGroup removes it straight from the stores
  // (it cannot be loaded, so destroy() could not), and nothing of another room.
  const other = 'ef'.repeat(32)
  await tables.table<boolean>('removed').setItem(`${broken}/removed`, true)
  await tables.table<Uint8Array>('rewind').setItem(`${broken}/meta`, new Uint8Array([1]))
  await tables.table<Uint8Array>('rewind').setItem(`${other}/meta`, new Uint8Array([2]))
  await tables.table<Uint8Array>('ingest').setItem(`${broken}/x`, new Uint8Array([3]))
  const listed = await p.t.listGroups()
  ok(
    listed.some((g) => g.groupId === broken && g.peerPubkey === null),
    `B2 listGroups lists the unreadable room with peerPubkey null (${JSON.stringify(listed)})`,
  )
  calls = 0
  await p.t.forgetGroup(broken)
  ok(p.t.groupHealth(broken) === 'missing' && calls >= 1, `B2 forgetGroup: the room is 'missing' and onGroupHealth was called (got ${p.t.groupHealth(broken)}, ${calls})`)
  ok(!(await p.t.listGroups()).some((g) => g.groupId === broken), 'B2 forgetGroup: the room is no longer listed')
  const left = (await Promise.all(['groups', 'removed', 'rewind', 'ingest'].map((n) => tables.table<unknown>(n).keys()))).flat()
  ok(!left.some((k) => k === broken || k.startsWith(`${broken}/`)), `B2 forgetGroup leaves no stored item of the room (${left.join(', ')})`)
  ok(left.includes(`${other}/meta`), "B2 forgetGroup leaves another room's items")
  const unknown = await within(p.t.forgetGroup('cd'.repeat(32)), 3_000)
  ok(unknown.state === 'ok', `B2 forgetGroup of an unknown id resolves (got ${JSON.stringify(unknown)})`)
  ok(p.t.peerJoined(broken) === false && p.t.peerJoined('cd'.repeat(32)) === false, 'B2 peerJoined is false for unknown and unloaded rooms')
  await p.t.stop()
}

async function b9(): Promise<void> {
  const tables = damaged(await freshTables(), 'keypackages')
  const p = transportOn([FAKE_A, FAKE_B], tables)
  const r = await within(quiet(p.t.start()), 3_000)
  ok(r.state === 'error' && r.message === 'storage-damaged', `B9 a broken store in the online step rejects start() (got ${JSON.stringify(r)})`)
  await p.t.stop()

  const { storage } = nodeStorage(`check-boot:${++nsCount}`)
  const marmot: MarmotModule = {
    createTransport: (o) => createTransport({ ...o, tables: damaged(o.tables as Tables, 'keypackages') }),
    pubkeyOf,
    npubOf,
    findList,
  }
  const engine = engineOn([FAKE_A, FAKE_B], storage, marmot)
  void engine.start().catch(() => {})
  const ready = await waitUntil(() => engine.store.getState().boot === 'error', 3_000)
  ok(ready, `B9 the engine shows it as a boot error within 3 s (boot ${engine.store.getState().boot})`)
  await engine.stop()
}

/**
 * Stores a room with only me in it, as an invite that never completed leaves behind:
 * the next start's local step removes it (client.groups.destroy).
 */
async function storeUnfinishedRoom(tables: Tables, sk: string): Promise<void> {
  const signer = new PrivateKeySigner(secretKeyBytes(sk))
  const network = new RelayNetwork([FAKE_A], signer, [])
  const stores = storesFrom(tables)
  const client = new MarmotClient<undefined, undefined>({
    signer,
    network,
    clientId: await loadClientId(stores.meta),
    groupStateStore: stores.groups,
    keyPackageStore: stores.keyPackages,
    inviteStore: stores.invites,
    ingestStateStore: stores.ingest,
    rewindStore: stores.rewind,
    removedMarkerStore: stores.removed,
  })
  await client.groups.create('ilchon', { relays: [FAKE_A], adminPubkeys: [] })
  network.close()
}

/**
 * B-STOP-LOCAL. The wait start() ends on
 * must exist from the first moment of the start: a stop() that comes after the local
 * step's last running check, or between the local step and the online loop, has nothing
 * else to end, and start() (and the engine's openIdentity/unlock that wait on it) would
 * hang for good.
 */
async function bStopLocal(): Promise<void> {
  // (가) Inside the local step: stop() while the unfinished room is being removed.
  const tables = await freshTables()
  const sk = generateSecretKeyHex()
  await storeUnfinishedRoom(tables, sk)
  const before = (await tables.table('groups').keys()).length
  let release!: () => void
  const gate = new Promise<void>((r) => (release = r))
  let removing = false
  const held: Tables = {
    ...tables,
    table<T>(n: string): GenericKeyValueStore<T> {
      const inner = tables.table<T>(n)
      if (n !== 'groups') return inner
      return {
        ...inner,
        getItem: (key: string) => inner.getItem(key),
        setItem: (key: string, value: T) => inner.setItem(key, value),
        removeItem: async (key: string) => {
          removing = true
          await gate
          return inner.removeItem(key)
        },
        clear: () => inner.clear(),
        keys: () => inner.keys(),
      }
    },
  }
  const a = transportOn([FAKE_A, FAKE_B], held, sk)
  const startA = quiet(a.t.start())
  const reached = await waitUntil(() => removing, 10_000)
  ok(before === 1 && reached, `B-STOP-LOCAL (가) the local step removes the unfinished room (stored ${before}, reached ${reached})`)
  const stopA = a.t.stop()
  release()
  const ra = await within(startA, 3_000)
  ok(ra.state === 'error' && ra.message === 'transport is stopped', `B-STOP-LOCAL (가) stop() inside the local step ends start() with 'transport is stopped' (got ${JSON.stringify(ra)})`)
  await within(stopA, 3_000)

  // (나) Right after the local step: its last act is the health notice; stop() there.
  const b = transportOn([FAKE_A, FAKE_B], await freshTables())
  let stopB: Promise<void> | undefined
  b.t.onGroupHealth(() => {
    stopB ??= b.t.stop()
  })
  const rb = await within(quiet(b.t.start()), 3_000)
  ok(stopB !== undefined, 'B-STOP-LOCAL (나) the health notice came at the end of the local step')
  ok(rb.state === 'error' && rb.message === 'transport is stopped', `B-STOP-LOCAL (나) stop() right after the local step ends start() with 'transport is stopped' (got ${JSON.stringify(rb)})`)
  if (stopB) await within(stopB, 3_000)
}

function engineOn(relays: string[], storage: ReturnType<typeof nodeStorage>['storage'], marmot: MarmotModule) {
  return createEngine(
    {
      storage,
      marmot,
      match: matchCrypto,
      connect: connectModule,
      rates: { fetch: async () => ({}) },
      lnurl: createLnurl({ fetch: async () => Promise.reject(new TypeError('no network in check-boot')) }),
      relays,
      lookupRelays: [],
      namespace: `check-boot:e${++nsCount}`,
      persistence: 'memory',
      autoIdentity: true,
    },
    { defaultLang: 'en' },
  )
}

async function b3(): Promise<void> {
  const { storage } = nodeStorage(`check-boot:${++nsCount}`)
  const engine = engineOn([DEAD_1, DEAD_2], storage, { createTransport, pubkeyOf, npubOf, findList })
  const boots: string[] = []
  engine.store.subscribe((s) => boots.push(s.boot))
  let caught = false
  void engine.start().catch(() => (caught = true))
  await sleep(3_000)
  const s = engine.store.getState()
  ok(s.boot === 'starting' && !boots.includes('error'), `B3 the engine without relays stays 'starting' (got ${s.boot})`)
  ok(s.relays.length === 2, `B3 its relays are known while starting (${s.relays.length})`)
  await engine.stop()
  await sleep(50)
  ok(engine.store.getState().boot !== 'error' && !boots.includes('error'), `B3 stop() while waiting: no boot error (got ${engine.store.getState().boot})`)
  ok(caught, 'B3 the rejected start() was caught')
}

async function b13(): Promise<void> {
  const relays = [FAKE_A, FAKE_B]
  const A = transportOn(relays, await freshTables())
  const B = transportOn(relays, await freshTables())
  await Promise.all([A.t.start(), B.t.start()])
  const g = await linkPair(A, B)
  const chats = () => B.messages.filter((m) => m.msg.t === 'chat').map((m) => (m.msg as { text: string }).text)

  // (가) Down for 3 s: the send waits for the socket and goes.
  fake.relay(FAKE_A).down()
  fake.relay(FAKE_B).down()
  await sleep(100)
  const s1 = A.t.send(g, { t: 'chat', id: randomHex(16), text: 'chat1' })
  await sleep(2_900)
  fake.relay(FAKE_A).up()
  fake.relay(FAKE_B).up()
  const r1 = await within(s1, 12_000)
  ok(r1.state === 'ok', `B13 (가) a send while the relays are down for 3 s goes once they are back (got ${JSON.stringify(r1)})`)
  ok(await waitUntil(() => chats().includes('chat1'), 15_000), 'B13 (가) B gets chat1')

  // (나) Down for 12 s: 'offline' after about 8 s, nothing encrypted.
  await sleep(500)
  fake.relay(FAKE_A).down()
  fake.relay(FAKE_B).down()
  await sleep(50)
  const before = await A.tables.table<unknown>('groups').getItem(g)
  const t0 = Date.now()
  const chat2 = { t: 'chat' as const, id: randomHex(16), text: 'chat2' }
  const s2 = A.t.send(g, chat2)
  const r2 = await within(s2, 11_000)
  const took = Date.now() - t0
  ok(r2.state === 'error' && r2.message === 'offline', `B13 (나) the send is refused with 'offline' (got ${JSON.stringify(r2)})`)
  ok(took >= 7_500 && took <= 9_500, `B13 (나) after 7.5-9.5 s (${took} ms)`)
  const after = await A.tables.table<unknown>('groups').getItem(g)
  ok(isDeepStrictEqual(before, after), 'B13 (나) the group state is the same before and after (nothing was encrypted)')
  await sleep(Math.max(0, 12_000 - (Date.now() - t0)))
  fake.relay(FAKE_A).up()
  fake.relay(FAKE_B).up()
  const r3 = await within(A.t.send(g, chat2), 15_000)
  ok(r3.state === 'ok', `B13 (나) sent again after up (got ${JSON.stringify(r3)})`)
  ok(await waitUntil(() => chats().includes('chat2'), 15_000), 'B13 (나) B gets chat2')
  await Promise.all([A.t.stop(), B.t.stop()])
}

async function bSilent(): Promise<void> {
  const relays = [FAKE_A, FAKE_B, FAKE_C, SILENT_1]
  const A = transportOn(relays, await freshTables())
  const B = transportOn(relays, await freshTables())
  const t0 = Date.now()
  const r = await within(Promise.all([A.t.start(), B.t.start()]), 20_000)
  ok(r.state === 'ok', `B-SILENT one of four relays never answers: both start (${Date.now() - t0} ms; ${r.state === 'error' ? r.message : r.state})`)
  const t1 = Date.now()
  let g = ''
  try {
    g = await linkPair(A, B)
  } catch (e) {
    console.log(`  ${(e as Error).message}`)
  }
  ok(g !== '', `B-SILENT invite and accept work (${Date.now() - t1} ms)`)
  if (g) {
    const t2 = Date.now()
    const s = await within(A.t.send(g, { t: 'chat', id: randomHex(16), text: 'hi' }), 15_000)
    const got = await waitUntil(() => B.messages.some((m) => m.msg.t === 'chat'), 15_000)
    ok(s.state === 'ok' && got, `B-SILENT a message goes through (${Date.now() - t2} ms)`)
  }
  await Promise.all([A.t.stop(), B.t.stop()])
}

// ---------------------------------------------------------------- B-INBOX

async function bInbox(): Promise<void> {
  const relays = [FAKE_A, FAKE_B]
  const A = transportOn(relays, await freshTables())
  const store = nodeStorage(`check-boot:${++nsCount}`)
  const tables = await store.storage.create({ method: 'none' }, async () => {})
  const skB = generateSecretKeyHex()
  const open = (cb: (m: IncomingMessage, t: Transport) => void | Promise<void>): Transport => {
    const t = createTransport({ secretKeyHex: skB, relays, lookupRelays: [], namespace: 'check-boot:inbox-b', persistence: 'memory', tables })
    const invites: IncomingInvite[] = []
    t.onInvite((i) => invites.push(i))
    t.onMessage((m) => cb(m, t))
    ;(t as Transport & { invites?: IncomingInvite[] }).invites = invites
    return t
  }
  const KEPT = 'ZQ-INBOX-kept-대화'
  const got1: string[] = []
  const B1 = open((m) => {
    if (m.msg.t !== 'chat') return
    got1.push(m.msg.text)
    // The engine could not finish it (a failed write, a stop): it stays.
    if (m.msg.text === KEPT) return Promise.reject(new Error('persist'))
  })
  const r = await within(Promise.all([A.t.start(), B1.start()]), 20_000)
  ok(r.state === 'ok', `B-INBOX both start (${r.state === 'error' ? r.message : r.state})`)
  const invite = A.t.invitePeer(B1.pubkey)
  const invitesB = (B1 as Transport & { invites: IncomingInvite[] }).invites
  await waitUntil(() => invitesB.length > 0, 15_000)
  let g = ''
  try {
    ;[{ groupId: g }] = await Promise.all([invite, B1.acceptInvite(invitesB[0].id)])
  } catch (e) {
    console.log(`  ${(e as Error).message}`)
  }
  ok(g !== '', 'B-INBOX A and B share a room')
  if (!g) return
  // A sends right away, racing B's self-update commit after the join. That race used to
  // leave A an epoch behind (marmot-ts 0.9.0 overwrote the commit result when a send was
  // encrypted during the ingest); the per-room turn guard (RoomTurns/guardIngest, B-TURN)
  // removes it, so this case keeps the race on purpose and still expects every step.
  await A.t.send(g, { t: 'chat', id: randomHex(16), text: 'handled-1' })
  await A.t.send(g, { t: 'chat', id: randomHex(16), text: KEPT })
  await A.t.send(g, { t: 'chat', id: randomHex(16), text: 'handled-2' })
  await waitUntil(() => got1.length >= 3, 15_000)
  ok(got1.join('|') === `handled-1|${KEPT}|handled-2`, `B-INBOX the first session gets the three in order (${got1.join('|')})`)
  await sleep(300)
  const keys = await tables.table('inbox').keys()
  ok(keys.length === 1, `B-INBOX only the rejected one stays in the inbox (${keys.length})`)
  const leaks = plainTextIn(store.backend, [
    { what: 'chat text', value: KEPT },
    { what: 'sender pubkey', value: A.t.pubkey },
  ])
  ok(leaks.length === 0, `B-INBOX the stored entry is encrypted: no chat text, no pubkey at rest (${leaks.join(', ') || 'none'})`)
  await B1.stop()
  // A damaged entry (another shape) is dropped at the next start, never delivered.
  await tables.table('inbox').setItem('ab'.repeat(32), { seq: 'x' })

  // The next start: the kept one comes again, first; the callback sends while the start
  // runs (it waits for the local step only), and the start still finishes.
  const got2: string[] = []
  let replySent: string = 'not yet'
  const B2 = open((m, t) => {
    if (m.msg.t !== 'chat') return
    got2.push(m.msg.text)
    if (m.msg.text === KEPT) {
      return t.send(g, { t: 'chat', id: randomHex(16), text: 'reply-from-replay' }).then(
        () => void (replySent = 'ok'),
        (e: Error) => void (replySent = e.message),
      )
    }
  })
  const r2 = await within(B2.start(), 20_000)
  ok(r2.state === 'ok', `B-INBOX the next start finishes while a replayed callback sends (${r2.state === 'error' ? r2.message : r2.state})`)
  await waitUntil(() => replySent !== 'not yet', 15_000)
  await A.t.send(g, { t: 'chat', id: randomHex(16), text: 'after-restart' })
  await waitUntil(() => got2.includes('after-restart'), 15_000)
  await sleep(300)
  ok(got2[0] === KEPT && got2.filter((x) => x === KEPT).length === 1, `B-INBOX the kept message comes again, once and first (${got2.join('|')})`)
  ok(!got2.includes('handled-1') && !got2.includes('handled-2'), 'B-INBOX handled messages do not come again')
  ok(
    replySent === 'ok' && (await waitUntil(() => A.messages.some((m) => m.msg.t === 'chat' && m.msg.text === 'reply-from-replay'), 15_000)),
    `B-INBOX the send from the replayed callback reaches A (${replySent})`,
  )
  const left = await tables.table('inbox').keys()
  ok(left.length === 0, `B-INBOX the inbox is empty again, the damaged entry dropped (${left.length})`)
  await Promise.all([A.t.stop(), B2.stop()])
}

// ---------------------------------------------------------------- B-ORDER

/**
 * B is off while A sends five texts a second apart (the fake relays, like real ones,
 * answer a backfill newest first). B starts again and every ingest result of the library
 * comes 150 ms after the one before, more than REORDER_IDLE_MS, as when a phone decrypts
 * after a thaw. B gets the five in sending order (a phone once showed them newest first).
 */
async function bOrder(): Promise<void> {
  const relays = [FAKE_A, FAKE_B]
  const A = transportOn(relays, await freshTables())
  const tables = await freshTables()
  const skB = generateSecretKeyHex()
  const got: string[] = []
  const open = (): Peer => {
    const t = createTransport({ secretKeyHex: skB, relays, lookupRelays: [], namespace: 'check-boot:order-b', persistence: 'memory', tables })
    const p: Peer = { t, sk: skB, tables, invites: [], messages: [] }
    t.onInvite((i) => p.invites.push(i))
    t.onMessage((m) => {
      if (m.msg.t === 'chat') got.push(m.msg.text)
    })
    return p
  }
  const B1 = open()
  const r = await within(Promise.all([A.t.start(), B1.t.start()]), 20_000)
  ok(r.state === 'ok', `B-ORDER both start (${r.state === 'error' ? r.message : r.state})`)
  const g = await linkPair(A, B1)
  await sleep(1_000)
  await B1.t.stop()
  for (let i = 1; i <= 5; i++) {
    await A.t.send(g, { t: 'chat', id: randomHex(16), text: `order-${i}` })
    await sleep(1_100)
  }
  const proto = MarmotGroup.prototype as unknown as { ingest: (...args: unknown[]) => AsyncGenerator<unknown, unknown, unknown> }
  const original = proto.ingest
  proto.ingest = async function* (this: unknown, ...args: unknown[]) {
    for await (const result of original.apply(this, args)) {
      yield result
      await sleep(150)
    }
  }
  try {
    const B2 = open()
    const r2 = await within(B2.t.start(), 20_000)
    ok(r2.state === 'ok', `B-ORDER B starts again (${r2.state === 'error' ? r2.message : r2.state})`)
    await waitUntil(() => got.length >= 5, 20_000)
    await sleep(500)
    ok(got.join(',') === 'order-1,order-2,order-3,order-4,order-5', `B-ORDER the backfill comes in sending order (${got.join(',')})`)
    await B2.t.stop()
  } finally {
    proto.ingest = original
  }
  await A.t.stop()
}

/**
 * B-FLOOD: while someone publishes signed junk on the room's public h tag every
 * 20 ms (each event its own library ingest), A's real text reaches B within the
 * INGEST_HOLD_MAX_MS bound plus slack, and before the flood stops. A smoke check of the
 * transport's wiring only: on a fast machine the ingests leave pauses and the text comes at
 * once, so this passes without the bound too. check-inbox R-3 is the gate for the bound.
 */
async function bFlood(): Promise<void> {
  const relays = [FAKE_A, FAKE_B]
  const A = transportOn(relays, await freshTables())
  const B = transportOn(relays, await freshTables())
  const r = await within(Promise.all([A.t.start(), B.t.start()]), 20_000)
  ok(r.state === 'ok', `B-FLOOD both start (${r.state === 'error' ? r.message : r.state})`)
  const g = await linkPair(A, B)
  await A.t.send(g, { t: 'chat', id: randomHex(16), text: 'before' })
  const linked = await waitUntil(() => B.messages.some((m) => m.msg.t === 'chat' && m.msg.text === 'before'), 15_000)
  ok(linked, 'B-FLOOD the room carries a text')
  const h = fake
    .relay(FAKE_A)
    .events.filter((e) => e.kind === 445)
    .map((e) => e.tags.find((t) => t[0] === 'h')?.[1])
    .find((x): x is string => typeof x === 'string')
  ok(!!h, "B-FLOOD the room's h tag is on the relay")
  if (!h) return
  const junk = new PrivateKeySigner(secretKeyBytes(generateSecretKeyHex()))
  const sock = new WebSocket(FAKE_A)
  await new Promise<void>((res) => (sock.onopen = () => res()))
  let flooding = true
  let sentJunk = 0
  const flood = (async () => {
    while (flooding) {
      const ev = await junk.signEvent({ kind: 445, created_at: Math.floor(Date.now() / 1000), tags: [['h', h]], content: Buffer.from(randomHex(96), 'hex').toString('base64') })
      sock.send(JSON.stringify(['EVENT', ev]))
      sentJunk++
      await sleep(20)
    }
  })()
  try {
    await sleep(1_500)
    await A.t.send(g, { t: 'chat', id: randomHex(16), text: 'through-flood' })
    const t0 = Date.now()
    const got = await waitUntil(() => B.messages.some((m) => m.msg.t === 'chat' && m.msg.text === 'through-flood'), 12_000)
    const took = Date.now() - t0
    ok(got && flooding && took <= 5_000 + 2_000, `B-FLOOD the text comes within the bound while the junk goes on (${got ? `${took} ms` : 'not at all'}, ${sentJunk} junk events)`)
  } finally {
    flooding = false
    await flood
    sock.close()
  }
  await Promise.all([A.t.stop(), B.t.stop()])
}

// ---------------------------------------------------------------- B-TURN

/**
 * The turn between my sends and the library's ingest of a room, on a stand-in group
 * whose ingest waits for the test: the order is decided by the turns alone, not timing.
 */
async function bTurn(): Promise<void> {
  const turns = new RoomTurns()
  const seen: string[] = []
  let commitApplied!: () => void
  const applying = new Promise<void>((resolve) => (commitApplied = resolve))
  const plainIngest = async function* (events: string[]): AsyncGenerator<number, void, unknown> {
    seen.push(`ingest ${events.join()} start`)
    if (events.includes('commit')) await applying
    yield events.length
    seen.push(`ingest ${events.join()} end`)
  }
  const room = { idStr: 'room-1', ingest: plainIngest }
  const other = { idStr: 'room-2', ingest: plainIngest }
  const undo = guardIngest(room, turns)
  guardIngest(other, turns)
  const drain = async (g: { ingest: (events: string[]) => AsyncGenerator<unknown, unknown, unknown> }, events: string[]) => {
    for await (const r of g.ingest(events)) void r
  }

  // (a) A send asked for while a commit of the room is being ingested waits for its end.
  const ingesting = drain(room, ['commit'])
  await sleep(10)
  const sending = turns.take('room-1').then((leave) => {
    seen.push('send')
    return leave
  })
  await sleep(30)
  ok(seen.join('|') === 'ingest commit start', `B-TURN a send waits while a commit of the room is ingested (${seen.join('|')})`)
  commitApplied()
  await ingesting
  const leave = await sending
  ok(seen.join('|') === 'ingest commit start|ingest commit end|send', `B-TURN the send goes after the commit is applied (${seen.join('|')})`)

  // (b) An ingest that arrives while a send holds the turn waits until it is given back;
  //     another room is not held up.
  const later = drain(room, ['msg'])
  await drain(other, ['other'])
  await sleep(30)
  ok(!seen.includes('ingest msg start') && seen.includes('ingest other end'), `B-TURN an ingest waits for the send of its room only (${seen.join('|')})`)
  leave()
  leave()
  await later
  ok(seen.slice(-2).join('|') === 'ingest msg start|ingest msg end', `B-TURN it runs once the send gives the turn back (given back once) (${seen.join('|')})`)

  // (c) A throwing ingest gives the turn back too; undo puts the library's method back.
  const failing = {
    idStr: 'room-3',
    ingest: async function* (): AsyncGenerator<number, void, unknown> {
      yield 0
      throw new Error('broken event')
    },
  }
  guardIngest(failing, turns)
  const thrown = await drain(failing, []).then(
    () => '',
    (e: Error) => e.message,
  )
  const next = await within(turns.take('room-3'), 1_000)
  ok(thrown === 'broken event' && next.state === 'ok', `B-TURN a failed ingest gives the turn back (${thrown}, ${next.state})`)
  undo()
  ok(room.ingest === plainIngest, 'B-TURN undo restores the original ingest')

  // (d) The span (the transport's hold on delivery) starts once the turn is taken and ends
  //     after it is given back, also when the ingest throws.
  const spans: string[] = []
  const spanTurns = new RoomTurns()
  const spanned = { idStr: 'room-4', ingest: plainIngest }
  guardIngest(spanned, spanTurns, { start: () => spans.push('start'), end: () => spans.push('end') })
  await drain(spanned, ['span'])
  const throwing = {
    idStr: 'room-5',
    ingest: async function* (): AsyncGenerator<number, void, unknown> {
      yield 0
      throw new Error('broken event')
    },
  }
  guardIngest(throwing, spanTurns, { start: () => spans.push('start'), end: () => spans.push('end') })
  await drain(throwing, []).catch(() => {})
  ok(spans.join('|') === 'start|end|start|end', `B-TURN the ingest span starts and ends once per ingest, a failed one too (${spans.join('|')})`)
}

async function bStrand(): Promise<void> {
  // The room is made on [fake-a, fake-b]; then A starts again on [fake-c] only, so
  // its own relays work while the room's can be taken down.
  const A0 = transportOn([FAKE_A, FAKE_B], await freshTables())
  const B = transportOn([FAKE_A, FAKE_B], await freshTables())
  await Promise.all([A0.t.start(), B.t.start()])
  const g = await linkPair(A0, B)
  await Promise.all([A0.t.stop(), B.t.stop()])

  const real = { now: healthClock.now, every: healthClock.every }
  let now = 1_000_000
  const ticks: (() => void)[] = []
  healthClock.now = () => now
  healthClock.every = (_ms, tick) => {
    ticks.push(tick)
    return () => {
      const i = ticks.indexOf(tick)
      if (i >= 0) ticks.splice(i, 1)
    }
  }
  const phrases: string[] = []
  setLogSink((phrase) => phrases.push(phrase))
  const g2 = globalThis as { document?: unknown }
  // A page with visibility events (the transport listens from its start).
  const doc = Object.assign(new EventTarget(), { visibilityState: 'visible' as 'visible' | 'hidden' })
  const show = (state: 'visible' | 'hidden') => {
    doc.visibilityState = state
    doc.dispatchEvent(new Event('visibilitychange'))
  }
  g2.document = doc
  const A = transportOn([FAKE_C], A0.tables, A0.sk)
  try {
    let calls = 0
    A.t.onGroupHealth(() => calls++)
    await A.t.start()
    ok(ticks.length === 1, `B-STRAND one health ticker after start (${ticks.length})`)
    /** Move the clock by `ms` and run the tick. */
    const step = (ms: number, times = 1) => {
      for (let i = 0; i < times; i++) {
        now += ms
        for (const tick of [...ticks]) tick()
      }
    }
    const health = () => A.t.groupHealth(g)
    const strandLines = () => phrases.filter((p) => p === 'room relays unreachable').length
    ok(await waitUntil(() => (step(0), health() === 'ok'), 10_000), `B-STRAND the room is 'ok' after start (${health()})`)

    fake.relay(FAKE_A).down()
    fake.relay(FAKE_B).down()
    await sleep(200)
    calls = 0
    // A phone that slept 10 minutes is charged two ticks (4 s), then 42 ticks of 2 s and 1 s: 89 s.
    step(600_000)
    step(2_000, 42)
    step(1_000)
    ok(health() === 'ok' && calls === 0 && strandLines() === 0, `B-STRAND 89 s: still 'ok', no call, no log line (${health()}, ${calls}, ${strandLines()})`)

    show('hidden')
    step(2_000, 10)
    show('visible')
    ok(health() === 'ok' && calls === 0, `B-STRAND 20 s hidden do not count (${health()})`)

    Object.defineProperty(navigator, 'onLine', { value: false, configurable: true })
    step(2_000, 5)
    delete (navigator as { onLine?: boolean }).onLine
    ok(health() === 'ok' && calls === 0, `B-STRAND 10 s offline do not count (${health()})`)

    fake.relay(FAKE_C).down()
    await sleep(200)
    step(2_000, 5)
    ok(health() === 'ok' && calls === 0, `B-STRAND 10 s with my relays down do not count (${health()})`)
    fake.relay(FAKE_C).up()
    ok(await waitUntil(() => A.t.relayStatus().some((s) => s.connected), 20_000), 'B-STRAND my relay is back')

    step(1_000)
    ok(health() === 'stranded' && calls === 1, `B-STRAND visible again, 1 s more: 90 s, 'stranded', onGroupHealth once (${health()}, ${calls})`)
    ok(strandLines() === 1, `B-STRAND one log line 'room relays unreachable' (${strandLines()})`)
    step(2_000, 3)
    ok(health() === 'stranded' && calls === 1 && strandLines() === 1, `B-STRAND stays 'stranded' without more calls or lines (${calls}, ${strandLines()})`)

    fake.relay(FAKE_A).up()
    ok(await waitUntil(() => (step(0), health() === 'ok'), 20_000), `B-STRAND a room relay connects: 'ok' again (${health()})`)
    ok(calls === 2, `B-STRAND onGroupHealth on leaving 'stranded' (${calls})`)

    // The sum starts again from zero.
    fake.relay(FAKE_A).down()
    await sleep(200)
    step(2_000, 44)
    ok(health() === 'ok', `B-STRAND after the reset 88 s are not enough (${health()})`)
    step(2_000)
    ok(health() === 'stranded', `B-STRAND after the reset 90 s are (${health()})`)

    // A phone hides the page and its timers sleep: no tick for 30 s. Coming back, the first
    // tick must not count the hidden time (up to two ticks, 4 s) as visible time.
    fake.relay(FAKE_A).up()
    ok(await waitUntil(() => (step(0), health() === 'ok'), 20_000), `B-STRAND reset again (${health()})`)
    fake.relay(FAKE_A).down()
    await sleep(200)
    step(2_000, 44)
    ok(health() === 'ok', `B-STRAND 88 s counted (${health()})`)
    show('hidden')
    now += 30_000
    show('visible')
    step(1_000)
    ok(health() === 'ok', `B-STRAND hidden 30 s with no tick, then 1 s visible: 89 s, still 'ok' (the hidden time is not added) (${health()})`)
    step(1_000)
    ok(health() === 'stranded', `B-STRAND 1 s more: 90 s, 'stranded' (${health()})`)
  } finally {
    delete g2.document
    delete (navigator as { onLine?: boolean }).onLine
    fake.relay(FAKE_A).up()
    fake.relay(FAKE_B).up()
    fake.relay(FAKE_C).up()
    await A.t.stop()
    setLogSink(null)
    healthClock.now = real.now
    healthClock.every = real.every
  }
}

// ---------------------------------------------------------------- relay lists

/**
 * The transport's log() lines (debug only) while a case runs: a signature that no relay
 * ever gets shows only here ('relay list signed').
 */
function captureMarmotLog(): { lines: string[]; restore(): void } {
  const g = globalThis as { ILCHON_DEBUG?: boolean }
  const before = { debug: g.ILCHON_DEBUG, log: console.log }
  const lines: string[] = []
  g.ILCHON_DEBUG = true
  console.log = (...args: unknown[]) => {
    if (args[0] === '[marmot]') lines.push(args.slice(1).map(String).join(' '))
    else before.log(...args)
  }
  return {
    lines,
    restore() {
      g.ILCHON_DEBUG = before.debug
      console.log = before.log
    },
  }
}

function b8(): void {
  const pk = 'aa'.repeat(32)
  const ev = (kind: number, created_at: number, pubkey = pk) => ({ id: `id${kind}`, pubkey, kind, created_at, tags: [], content: '', sig: 'sig' })
  const rec = { relays: [FAKE_A, FAKE_B], events: [ev(10002, 200), ev(10050, 150)] }
  const parsed = parseRelayListRecord(JSON.stringify(rec), pk)
  ok(isDeepStrictEqual(parsed, rec), 'B8 parseRelayListRecord reads a good record')
  ok(relayListAction(null, [FAKE_A, FAKE_B]) === 'sign', 'B8 no record: sign')
  ok(relayListAction(parsed, [FAKE_A, FAKE_B]) === 'rebroadcast', 'B8 same relays: rebroadcast')
  ok(relayListAction(parsed, [FAKE_B, FAKE_A]) === 'rebroadcast', 'B8 same relays in another order: rebroadcast')
  ok(relayListAction(parsed, [FAKE_A, FAKE_C]) === 'sign', 'B8 one relay differs: sign')
  ok(relayListAction(parsed, [FAKE_A]) === 'sign', 'B8 one relay fewer: sign')
  const bad: [string, unknown][] = [
    ['broken JSON', '{"relays":['],
    ['one event', JSON.stringify({ ...rec, events: [rec.events[0]] })],
    ["someone else's pubkey", JSON.stringify({ ...rec, events: [ev(10002, 200, 'bb'.repeat(32)), ev(10050, 150, 'bb'.repeat(32))] })],
    ['kinds the other way round', JSON.stringify({ ...rec, events: [rec.events[1], rec.events[0]] })],
    ['relays not strings', JSON.stringify({ ...rec, relays: [1, 2] })],
    ['no created_at', JSON.stringify({ ...rec, events: [{ ...rec.events[0], created_at: 'x' }, rec.events[1]] })],
    ['nothing stored', null],
  ]
  for (const [what, raw] of bad) ok(parseRelayListRecord(raw as string | null, pk) === null, `B8 parseRelayListRecord: ${what} → null`)
  ok(nextListCreatedAt(null, 100) === 100, 'B8 nextListCreatedAt(null, 100) === 100')
  ok(nextListCreatedAt(parsed, 100) === 201, 'B8 nextListCreatedAt: a slow clock still dates after the record (201)')
  ok(nextListCreatedAt(parsed, 300) === 300, 'B8 nextListCreatedAt: now when it is later (300)')
  // A pair signed this session that never reached the record (refused, or the relays
  // switched before it was taken): the next one is dated after it too.
  const signedThisSession = { relays: [FAKE_A, FAKE_C], events: [ev(10002, 201), ev(10050, 201)] }
  ok(nextListCreatedAt(parsed, 100, signedThisSession) === 202, 'B8 nextListCreatedAt: after the session-signed pair too (202, not 201)')
  ok(nextListCreatedAt(parsed, 201, signedThisSession) === 202, 'B8 nextListCreatedAt: same second as the session-signed pair → one later (202)')
  ok(nextListCreatedAt(null, 100, signedThisSession) === 202, 'B8 nextListCreatedAt: no record, session-signed pair at 201 → 202')
  ok(nextListCreatedAt(parsed, 100, null) === 201, 'B8 nextListCreatedAt: no session-signed pair → after the record only (201)')
}

/** Puts a signed event on `url` through a socket of its own; resolves with the relay's OK flag. */
function putEvent(url: string, event: unknown): Promise<boolean> {
  return new Promise((resolve) => {
    const ws = new WebSocket(url)
    ws.onopen = () => ws.send(JSON.stringify(['EVENT', event]))
    ws.onmessage = (m: { data: string }) => {
      const msg = JSON.parse(m.data) as unknown[]
      if (msg[0] !== 'OK') return
      ws.close()
      resolve(msg[2] === true)
    }
  })
}

/**
 * B-ELSEWHERE-THROTTLE: keyUsedElsewhere reads my
 * KeyPackages at most once per 10 minutes per mode. The start's full check right before
 * does not make the connect screen's own-slot check skip: a package in my own slot that
 * this device never made is seen at once. A second check of the same mode is skipped.
 */
async function bElsewhereThrottle(): Promise<void> {
  const tables = await freshTables()
  const p = transportOn([FAKE_A, FAKE_B], tables)
  const r = await within(quiet(p.t.start()), 15_000)
  ok(r.state === 'ok', `B-ELSEWHERE start() finishes (${r.state})`)
  const pk = p.t.pubkey
  const kpReqs = () => [FAKE_A, FAKE_B].reduce((n, url) => n + fake.relay(url).reqs.filter((fs) => fs.some((f) => f.kinds?.includes(30443) && f.authors?.includes(pk))).length, 0)
  const since = Math.floor(Date.now() / 1000) - 60
  let before = kpReqs()
  const full = await p.t.keyUsedElsewhere(since)
  ok(!full && kpReqs() > before, `B-ELSEWHERE the full check reads my KeyPackages and finds nothing (${full}, ${kpReqs() - before} reads)`)
  // Another device takes my own slot: a newer package there that this device never made.
  const mine = fake.relay(FAKE_A).stored.find((e) => e.pubkey === pk && e.kind === 30443)
  ok(!!mine, 'B-ELSEWHERE my KeyPackage is on fake-a')
  if (mine) {
    const other = await new PrivateKeySigner(secretKeyBytes(p.sk)).signEvent({
      kind: 30443,
      created_at: mine.created_at + 5,
      tags: mine.tags,
      content: mine.content,
    })
    ok((await putEvent(FAKE_A, other)) && (await putEvent(FAKE_B, other)), "B-ELSEWHERE the other device's package is on both relays")
  }
  before = kpReqs()
  const own = await p.t.keyUsedElsewhere(since, { ownSlotOnly: true })
  ok(own && kpReqs() > before, `B-ELSEWHERE right after the full check the own-slot check still reads and sees it (${own}, ${kpReqs() - before} reads)`)
  before = kpReqs()
  const again = await p.t.keyUsedElsewhere(since, { ownSlotOnly: true })
  const fullAgain = await p.t.keyUsedElsewhere(since)
  ok(!again && !fullAgain && kpReqs() === before, `B-ELSEWHERE a second check of either mode within 10 minutes reads nothing (${again}, ${fullAgain}, ${kpReqs() - before} reads)`)
  await p.t.stop()
}

async function b16(): Promise<void> {
  const sk = generateSecretKeyHex()
  const pk = pubkeyOf(sk)
  const tables = await freshTables()
  const meta = tables.table<string>('meta')
  const mine = (url: string, kind: number) => fake.relay(url).events.filter((e) => e.pubkey === pk && e.kind === kind)
  const ids = (url: string, kind: number) => new Set(mine(url, kind).map((e) => e.id))
  const stored = async () => parseRelayListRecord(await meta.getItem('relay-lists'), pk)
  const open = (relays: string[], lookup: string[] = [], t: Tables = tables) => {
    const transport = createTransport({ secretKeyHex: sk, relays, lookupRelays: lookup, namespace: `check-boot:t${++nsCount}`, persistence: 'memory', tables: t })
    return { transport, start: quiet(transport.start()) }
  }

  // First start: one pair signed, kept, and put on my relays and the indexer.
  let run = open([FAKE_A, FAKE_B], [FAKE_C])
  let r = await within(run.start, 15_000)
  ok(r.state === 'ok', `B16 first start finishes (got ${JSON.stringify(r)})`)
  ok(ids(FAKE_A, 10002).size === 1 && ids(FAKE_A, 10050).size === 1, 'B16 first start: one 10002 and one 10050 signed')
  const first = mine(FAKE_A, 10002)[0]
  ok(await waitUntil(() => ids(FAKE_C, 10002).has(first?.id), 3_000), 'B16 first start: the indexer got the pair after my relays took it')
  const rec1 = await stored()
  ok(rec1?.events[0].id === first?.id && rec1?.events[1].id === mine(FAKE_A, 10050)[0]?.id, 'B16 the pair my relays took is stored')
  await run.transport.stop()

  // Same relays again: nothing signed, the stored pair is put again (my relays, then the indexer).
  const before = { a: mine(FAKE_A, 10002).length, b: mine(FAKE_B, 10050).length, c: mine(FAKE_C, 10002).length }
  run = open([FAKE_A, FAKE_B], [FAKE_C])
  r = await within(run.start, 15_000)
  ok(r.state === 'ok', `B16 second start with the same relays finishes (got ${JSON.stringify(r)})`)
  ok(ids(FAKE_A, 10002).size === 1 && ids(FAKE_A, 10050).size === 1 && ids(FAKE_B, 10002).size === 1, 'B16 second start: no new signature (same ids)')
  ok(mine(FAKE_A, 10002).length > before.a && mine(FAKE_B, 10050).length > before.b, 'B16 second start: the stored pair is put on my relays again')
  ok((await waitUntil(() => mine(FAKE_C, 10002).length > before.c, 3_000)) && ids(FAKE_C, 10002).size === 1, 'B16 second start: the same pair goes to the indexer again')
  await run.transport.stop()

  // Same relays in another order: still nothing signed.
  run = open([FAKE_B, FAKE_A])
  r = await within(run.start, 15_000)
  ok(r.state === 'ok' && ids(FAKE_A, 10002).size === 1 && ids(FAKE_A, 10050).size === 1, 'B16 same relays in another order: no new signature')
  await run.transport.stop()

  // Changed relays: one new pair, dated after the old one, naming the new relays, stored.
  run = open([FAKE_A, FAKE_C])
  r = await within(run.start, 15_000)
  ok(r.state === 'ok', `B16 start with changed relays finishes (got ${JSON.stringify(r)})`)
  ok(ids(FAKE_A, 10002).size === 2 && ids(FAKE_A, 10050).size === 2, 'B16 changed relays: signed once (one new 10002, one new 10050)')
  const second = mine(FAKE_A, 10002).find((e) => e.id !== first?.id)
  ok(!!second && !!first && second.created_at > first.created_at, 'B16 changed relays: the new pair is dated after the old one')
  ok(!!second && second.tags.some((t) => t[1]?.startsWith(FAKE_C)) && !second.tags.some((t) => t[1]?.startsWith(FAKE_B)), 'B16 changed relays: the new 10002 names the new relays')
  const rec2 = await stored()
  ok(rec2?.events[0].id === second?.id && relayListAction(rec2, [FAKE_C, FAKE_A]) === 'rebroadcast', 'B16 changed relays: the new pair is stored')
  await run.transport.stop()

  // My relays cannot be reached while the stored pair is put again: the
  // online step fails WITHOUT signing a new pair, the record stays, the start keeps
  // retrying and finishes once the relays are back. log() lines are the only place a
  // signature that never reaches a relay shows, so they are read here.
  const signedLog = captureMarmotLog()
  fake.relay(FAKE_A).down()
  fake.relay(FAKE_C).down()
  const recBefore = await meta.getItem('relay-lists')
  run = open([FAKE_A, FAKE_C])
  r = await within(run.start, 1_500)
  ok(r.state === 'pending', `B16 unreachable: the start keeps waiting (got ${JSON.stringify(r)})`)
  ok(
    signedLog.lines.some((l) => l.includes('relay list rebroadcast: unreachable')),
    'B16 unreachable: the stored pair was tried first',
  )
  ok(!signedLog.lines.some((l) => l.includes('relay list signed')), 'B16 unreachable: no new pair is signed')
  ok((await meta.getItem('relay-lists')) === recBefore, 'B16 unreachable: the stored record is unchanged')
  fake.relay(FAKE_A).up()
  fake.relay(FAKE_C).up()
  r = await within(run.start, 20_000)
  ok(r.state === 'ok', `B16 unreachable: the start finishes once the relays are back (got ${JSON.stringify(r)})`)
  ok(!signedLog.lines.some((l) => l.includes('relay list signed')) && ids(FAKE_A, 10002).size === 2 && ids(FAKE_A, 10050).size === 2, 'B16 unreachable: still no new signature after the retry')
  ok((await meta.getItem('relay-lists')) === recBefore, 'B16 unreachable: the record is still the stored pair')
  await run.transport.stop()
  signedLog.restore()

  // My relays already hold the stored pair and answer OK false 'duplicate: …': taken, nothing signed.
  const dupLog = captureMarmotLog()
  ok(
    fake.relay(FAKE_A).stored.some((e) => e.id === second?.id),
    'B16 duplicate: the relay already holds the stored pair',
  )
  fake.relay(FAKE_A).duplicateOk(false)
  fake.relay(FAKE_C).duplicateOk(false)
  run = open([FAKE_A, FAKE_C])
  r = await within(run.start, 15_000)
  ok(r.state === 'ok', `B16 duplicate: the start finishes (got ${JSON.stringify(r)})`)
  ok(
    dupLog.lines.some((l) => l.includes('relay list rebroadcast: accepted')),
    "B16 duplicate: 'duplicate:' counts as accepted",
  )
  ok(!dupLog.lines.some((l) => l.includes('relay list signed')) && ids(FAKE_A, 10002).size === 2 && ids(FAKE_A, 10050).size === 2, 'B16 duplicate: no new signature')
  ok((await meta.getItem('relay-lists')) === recBefore, 'B16 duplicate: the record is unchanged')
  await run.transport.stop()
  dupLog.restore()
  fake.relay(FAKE_A).duplicateOk(true)
  fake.relay(FAKE_C).duplicateOk(true)

  // My relays refuse the stored pair (not 'duplicate:'): signed again, later dated; not stored until taken.
  fake.relay(FAKE_A).refuse([10002])
  fake.relay(FAKE_C).refuse([10002])
  run = open([FAKE_A, FAKE_C])
  const resigned = await waitUntil(() => ids(FAKE_A, 10002).size === 3, 8_000)
  const third = mine(FAKE_A, 10002).find((e) => e.id !== first?.id && e.id !== second?.id)
  ok(resigned && !!third && !!second && third.created_at > second.created_at, 'B16 refused: a new pair is signed, dated after the stored one')
  ok(mine(FAKE_A, 10002).filter((e) => e.id === second?.id).length >= 2, 'B16 refused: the stored pair was put first')
  r = await within(run.start, 500)
  ok(r.state === 'pending', `B16 refused: the start keeps waiting (got ${JSON.stringify(r)})`)
  ok((await stored())?.events[0].id === second?.id, 'B16 refused: the refused pair is not stored')
  await run.transport.stop()
  fake.relay(FAKE_A).refuse([])
  fake.relay(FAKE_C).refuse([])

  // A broken stored record: a new pair is signed and stored. It is dated now (no record to
  // date after), so first wait until the clock is past the refused pair's time: each new
  // pair is dated one second after the one before, so after quick starts that time can be
  // a few seconds ahead of the clock, and the same relays and the same time would be the
  // same event id (seen once as "one new pair is signed" failing after a fixed 2.1 s wait).
  while (Math.floor(Date.now() / 1000) <= (third?.created_at ?? 0)) await sleep(100)
  await meta.setItem('relay-lists', '{"relays":[')
  const signedBefore = ids(FAKE_A, 10002).size
  run = open([FAKE_A, FAKE_C])
  r = await within(run.start, 15_000)
  ok(r.state === 'ok', `B16 broken record: the start finishes (got ${JSON.stringify(r)})`)
  ok(ids(FAKE_A, 10002).size === signedBefore + 1, `B16 broken record: one new pair is signed (${signedBefore} → ${ids(FAKE_A, 10002).size})`)
  const rec3 = await stored()
  ok(!!rec3 && rec3.events[0].id !== second?.id && ids(FAKE_A, 10002).has(rec3.events[0].id), 'B16 broken record: replaced by the new pair')
  await run.transport.stop()

  // A record the store cannot read (getItem throws): a local failure, like any stored item (B9).
  run = open(
    [FAKE_A, FAKE_C],
    [],
    damaged(tables, 'meta', (k) => k === 'relay-lists'),
  )
  r = await within(run.start, 5_000)
  ok(r.state === 'error' && r.message === 'storage-damaged', `B16 unreadable record: start() rejects with storage-damaged (got ${JSON.stringify(r)})`)
  await run.transport.stop()
}

// ---------------------------------------------------------------- relay settings and fallback

function b7(): void {
  const off = { connected: false, failures: 0 }
  const failed = { connected: false, failures: 1 }
  const on = { connected: true, failures: 0 }
  ok(!fallbackDue([], 60_000, 0), 'B7 fallbackDue: no chosen relays -> no')
  ok(!fallbackDue([on, failed], 60_000, 0), 'B7 fallbackDue: one connected -> no')
  ok(!fallbackDue([off, off], 19_000, 0), 'B7 fallbackDue: all down, no failure, 19 s silent -> no')
  ok(fallbackDue([off, off], FALLBACK_SILENT_MS, 0), 'B7 fallbackDue: all down, no failure, 20 s silent -> yes')
  ok(!fallbackDue([failed, off], 0, 0), 'B7 fallbackDue: all down, one failed -> no')
  ok(fallbackDue([failed, failed], 0, 0), 'B7 fallbackDue: all down, all failed once -> yes')
  ok(fallbackDue([on, on], 0, 2), 'B7 fallbackDue: connected but refused twice in a row -> yes')
  // The next probe, answered or not.
  const waits = [1, 2, 3, 4, 5, 9].map((n) => nextFallbackProbeAt(1_000, n, [1_000]) - 1_000)
  ok(JSON.stringify(waits) === JSON.stringify([5_000, 15_000, 30_000, 60_000, 60_000, 60_000]), `B7 nextFallbackProbeAt: waits 5, 15, 30, 60 s, then 60 s (${waits.join(', ')})`)
  const hour = Array.from({ length: FALLBACK_PROBES_PER_HOUR }, (_, i) => 10_000 + i * 60_000)
  const last = hour[hour.length - 1]
  ok(nextFallbackProbeAt(last, 30, hour) === 10_000 + 3_600_000, `B7 nextFallbackProbeAt: the ${FALLBACK_PROBES_PER_HOUR}th probe in an hour waits until the first is an hour old`)
  ok(nextFallbackProbeAt(last, 30, hour.slice(1)) === last + 60_000, 'B7 nextFallbackProbeAt: below the cap, the 60 s wait')
  ok(FALLBACK_PROBES_PER_HOUR <= 20, `B7 at most 20 probes an hour (${FALLBACK_PROBES_PER_HOUR})`)
  const up = { visible: true, online: true, chosenUp: false }
  ok(silentTick(10_000, 2_000, up) === 12_000, 'B7 silentTick: visible, online, chosen down -> adds')
  ok(silentTick(10_000, 2_000, { ...up, visible: false }) === 0 && silentTick(10_000, 2_000, { ...up, online: false }) === 0, 'B7 silentTick: hidden or offline -> 0')
  ok(silentTick(10_000, 2_000, { ...up, chosenUp: true }) === 0, 'B7 silentTick: a chosen relay connected -> 0')
  let made = false
  try {
    new RelayLiveness().destroy()
    made = true
  } catch {
    made = false
  }
  ok(made, 'B7 new RelayLiveness() does not throw and is destroyed')
}

/** A stored profile with lock 'none', an identity and these settings, then reopened (a reload). */
async function preparedStorage(settings?: unknown): Promise<{ storage: ReturnType<typeof nodeStorage>; sk: string }> {
  const name = `check-boot:${++nsCount}`
  const first = nodeStorage(name)
  const sk = generateSecretKeyHex()
  await first.storage.create({ method: 'none' }, async (t) => {
    await t.kv.set('identity', { v: 1, sk })
    if (settings !== undefined) await t.kv.set('settings', settings)
  })
  return { storage: nodeStorage(name, first.backend), sk }
}

/** A marmot module that records the transport options the engine passes. */
function recording(seen: TransportOptions[]): MarmotModule {
  return {
    createTransport: (o) => {
      seen.push(o)
      return createTransport(o)
    },
    pubkeyOf,
    npubOf,
    findList,
  }
}

async function b4b5(): Promise<void> {
  const deps = [DEAD_3, DEAD_4]
  const mine = [DEAD_1, DEAD_2]
  const cases: { what: string; settings?: unknown; relays: string[]; fallback: string[] | undefined; state?: [string[] | null, boolean] }[] = [
    { what: 'no settings', relays: deps, fallback: undefined },
    { what: 'my relays, automatic', settings: { lang: 'en', sort: 'amount', relays: mine, relayAuto: true }, relays: mine, fallback: deps },
    { what: "my relays, don't switch", settings: { lang: 'en', sort: 'amount', relays: mine, relayAuto: false }, relays: mine, fallback: undefined },
    { what: 'junk values', settings: { lang: 'en', sort: 'amount', relays: 'x', relayAuto: 'y' }, relays: deps, fallback: undefined, state: [null, true] },
    {
      what: 'a stored list that no longer passes the host rule',
      settings: { lang: 'en', sort: 'amount', relays: ['ws://dead-1.test', DEAD_2], relayAuto: true },
      relays: deps,
      fallback: undefined,
      state: [null, true],
    },
  ]
  let last: ReturnType<typeof engineOn> | undefined
  let lastStorage: ReturnType<typeof nodeStorage> | undefined
  for (const c of cases) {
    const { storage } = await preparedStorage(c.settings)
    const seen: TransportOptions[] = []
    const engine = engineOn(deps, storage.storage, recording(seen))
    void engine.start().catch(() => {})
    await waitUntil(() => seen.length > 0, 5_000)
    const o = seen[0]
    ok(
      !!o && JSON.stringify(o.relays) === JSON.stringify(c.relays) && JSON.stringify(o.fallbackRelays) === JSON.stringify(c.fallback),
      `B4 ${c.what}: relays ${o ? o.relays.join(',') : '-'}, fallbackRelays ${o?.fallbackRelays?.join(',') ?? 'none'}`,
    )
    if (c.state) {
      const st = engine.store.getState().settings
      ok(st.relays === c.state[0] && st.relayAuto === c.state[1], `B4 ${c.what}: settings.relays null, relayAuto true (${JSON.stringify([st.relays, st.relayAuto])})`)
    }
    if (last) await last.stop()
    last = engine
    lastStorage = storage
  }
  // B5 on the last engine (deps [dead-3, dead-4]), started and unlocked, waiting for relays.
  const engine = last as ReturnType<typeof engineOn>
  const settings = () => engine.store.getState().settings
  const reason = async (relays: unknown) => {
    try {
      await engine.actions.setSettings({ relays: relays as string[] })
      return 'ok'
    } catch (e) {
      return e instanceof Error ? e.message : String(e)
    }
  }
  const before = JSON.stringify(settings())
  ok((await reason([DEAD_1])) === 'too-few-relays' && JSON.stringify(settings()) === before, 'B5 one relay: too-few-relays, settings unchanged')
  const nine = Array.from({ length: MAX_RELAYS + 1 }, (_, i) => `wss://r${i}.test`)
  ok((await reason(nine)) === 'too-many-relays' && JSON.stringify(settings()) === before, 'B5 nine relays: too-many-relays, settings unchanged')
  ok((await reason([DEAD_1, 'ws://localhost:7777', 'wss://127.0.0.1', 'wss://u:p@x.test'])) === 'too-few-relays', 'B5 only one allowed host left: too-few-relays')
  ok((await reason([DEAD_4, DEAD_3])) === 'ok' && settings().relays === null, `B5 the defaults in another order are stored as null (${JSON.stringify(settings().relays)})`)
  ok(
    (await reason([DEAD_1, DEAD_1, 'not a url', 'ws://dead-9.test', DEAD_2])) === 'ok' && JSON.stringify(settings().relays) === JSON.stringify([DEAD_1, DEAD_2]),
    `B5 repeats, junk and ws:// dropped: [dead-1, dead-2] (${JSON.stringify(settings().relays)})`,
  )
  await engine.actions.setSettings({ relayAuto: false })
  const stored = await lastStorage!.kv().get<{ relays?: unknown; relayAuto?: unknown }>('settings')
  ok(
    settings().relayAuto === false && JSON.stringify(stored?.relays) === JSON.stringify([DEAD_1, DEAD_2]) && stored?.relayAuto === false,
    'B5 the choice is in the encrypted store (engine KV settings), relayAuto false',
  )
  await engine.stop()
}

async function b6(): Promise<void> {
  // Runs alone: the log sink is global and other scenarios probe too.
  const lines: { at: number; ms: unknown }[] = []
  setLogSink((phrase, values) => {
    if (phrase === 'relay fallback probe unanswered, retrying in') lines.push({ at: Date.now(), ms: values[0] })
  })
  const socketsBefore = fake.relay(DEAD_3).sockets + fake.relay(DEAD_4).sockets
  const p = transportOn([DEAD_1, DEAD_2], await freshTables(), undefined, [DEAD_3, DEAD_4])
  try {
    const start = quiet(p.t.start())
    await sleep(6_000)
    const urls = p.t.relayStatus().map((s) => s.url)
    ok(!p.t.fallingBack(), 'B6 the fallback relays do not answer either: no switch after 6 s')
    ok(JSON.stringify(urls) === JSON.stringify([DEAD_1, DEAD_2]), `B6 the relays in use are still mine (${urls.join(', ')})`)
    ok((await within(start, 0)).state === 'pending', 'B6 start() still waits')
    await sleep(6_000)
    const probeSockets = fake.relay(DEAD_3).sockets + fake.relay(DEAD_4).sockets - socketsBefore
    ok(probeSockets > 0, `B6 the probe went out to the fallback relays (${probeSockets} sockets)`)
    const ms = lines.map((l) => l.ms)
    ok(lines.length === 2 && ms[0] === 5_000 && ms[1] === 15_000, `B6 in 12 s two probes, unanswered, the next after 5 s then 15 s (${lines.length}: ${ms.join(', ')})`)
    const gap = lines.length >= 2 ? lines[1].at - lines[0].at : 0
    ok(gap >= 4_000, `B6 the second probe waited for its time (${gap} ms after the first)`)
    ok(!p.t.fallingBack(), 'B6 still no switch after 12 s')
  } finally {
    setLogSink(null)
    await p.t.stop()
  }
}

/** Kinds `pubkey` published to `url`'s fake relay. */
function kindsOn(url: string, pubkey: string): number[] {
  return fake
    .relay(url)
    .events.filter((e) => e.pubkey === pubkey)
    .map((e) => e.kind)
}

async function b10(): Promise<void> {
  // Dead hosts of its own: the scenarios running beside it use dead-1 and dead-2.
  const deadA = 'wss://dead-10.test'
  const deadB = 'wss://dead-11.test'
  const p = transportOn([deadA, deadB], await freshTables(), undefined, [FAKE_A, FAKE_B])
  const statuses: string[][] = []
  p.t.onRelayStatus((s) => statuses.push(s.map((r) => r.url)))
  const t0 = Date.now()
  const start = quiet(p.t.start())
  const switched = await waitUntil(() => p.t.fallingBack(), 7_000)
  const tookMs = Date.now() - t0
  ok(switched, `B10 all chosen relays dead: switched within 7 s (${tookMs} ms)`)
  const urls = p.t.relayStatus().map((s) => s.url)
  ok(JSON.stringify(urls) === JSON.stringify([FAKE_A, FAKE_B]), `B10 relayStatus is the fallback relays (${urls.join(', ')})`)
  ok(
    statuses.some((s) => JSON.stringify(s) === JSON.stringify([FAKE_A, FAKE_B])),
    'B10 onRelayStatus told the new list',
  )
  const r = await within(start, 10_000)
  ok(r.state === 'ok', `B10 start() finishes on the fallback relays (${r.state === 'error' ? r.message : r.state})`)
  const inbox = fake.relay(FAKE_A).reqs.some((filters) => filters.some((f) => f.kinds?.includes(1059) && (f['#p'] as string[] | undefined)?.includes(p.t.pubkey)))
  const kinds = kindsOn(FAKE_A, p.t.pubkey)
  ok(inbox, 'B10 my inbox (kind 1059) is read on the fallback relay')
  ok(
    [10002, 10050, 30443].every((k) => kinds.includes(k)),
    `B10 my lists and KeyPackage are on the fallback relay (${[...new Set(kinds)].join(',')})`,
  )
  await sleep(2_000)
  const dead = () => fake.relay(deadA).sockets + fake.relay(deadB).sockets
  const before = dead()
  await sleep(6_000)
  ok(dead() === before, `B10 no new socket to the dead relays 2-8 s after the switch (${dead() - before})`)
  await p.t.stop()
}

async function bPartial(): Promise<void> {
  const p = transportOn([DEAD_1, DEAD_2], await freshTables(), undefined, [DEAD_3, FAKE_A])
  const start = quiet(p.t.start())
  ok(await waitUntil(() => p.t.fallingBack(), 7_000), 'B-PARTIAL one of two fallback relays lives: switched within 7 s')
  const urls = p.t.relayStatus().map((s) => s.url)
  ok(JSON.stringify(urls) === JSON.stringify([DEAD_3, FAKE_A]), `B-PARTIAL both fallback relays are in use (${urls.join(', ')})`)
  const r = await within(start, 10_000)
  const kinds = kindsOn(FAKE_A, p.t.pubkey)
  ok(r.state === 'ok' && [10002, 10050, 30443].every((k) => kinds.includes(k)), `B-PARTIAL start() finishes on the live one (${r.state === 'error' ? r.message : r.state})`)
  await p.t.stop()
}

/** The relays each kind 10002 event of `pubkey` that `url` got names (without a trailing slash). */
function listRelays(url: string, pubkey: string): string[][] {
  return fake
    .relay(url)
    .events.filter((e) => e.pubkey === pubkey && e.kind === 10002)
    .map((e) => e.tags.filter((t) => t[0] === 'r').map((t) => t[1].replace(/\/+$/, '')))
}

async function b11Return(): Promise<void> {
  const tables = await freshTables()
  const sk = generateSecretKeyHex()
  const A = transportOn([FAKE_C], tables, sk, [FAKE_A, FAKE_B])
  const r = await within(A.t.start(), 10_000)
  ok(r.state === 'ok' && !A.t.fallingBack(), `B11 starts on my relay, no switch (${r.state === 'error' ? r.message : r.state})`)
  const onC = listRelays(FAKE_C, A.t.pubkey)
  fake.relay(FAKE_C).down()
  const t0 = Date.now()
  const switched = await waitUntil(() => A.t.fallingBack(), 10_000)
  ok(switched, `B11 my relay drops: switched within 10 s (${Date.now() - t0} ms)`)
  const urls = A.t.relayStatus().map((s) => s.url)
  ok(JSON.stringify(urls) === JSON.stringify([FAKE_A, FAKE_B]), `B11 relayStatus is the fallback relays (${urls.join(', ')})`)
  const listed = await waitUntil(() => listRelays(FAKE_A, A.t.pubkey).length > 0, 10_000)
  const onA = listRelays(FAKE_A, A.t.pubkey)
  ok(
    listed && onC.length > 0 && JSON.stringify(onC[0]) !== JSON.stringify(onA[onA.length - 1]) && onA[onA.length - 1].includes(FAKE_A),
    `B11 the list on the fallback relay names the new relays (${JSON.stringify(onC[0])} -> ${JSON.stringify(onA[onA.length - 1])})`,
  )
  const inbox = await waitUntil(() => fake.relay(FAKE_A).reqs.some((filters) => filters.some((f) => f.kinds?.includes(1059) && (f['#p'] as string[] | undefined)?.includes(A.t.pubkey))), 10_000)
  ok(inbox, 'B11 my inbox is read on the fallback relay')
  await A.t.stop()

  // B-RETURN: my relay is back; the next start begins with it and does not switch.
  fake.relay(FAKE_C).up()
  const before = listRelays(FAKE_C, A.t.pubkey).length
  const A2 = transportOn([FAKE_C], tables, sk, [FAKE_A, FAKE_B])
  const r2 = await within(A2.t.start(), 10_000)
  const urls2 = A2.t.relayStatus().map((s) => s.url)
  ok(r2.state === 'ok', `B-RETURN the next start finishes on my relay (${r2.state === 'error' ? r2.message : r2.state})`)
  ok(!A2.t.fallingBack() && JSON.stringify(urls2) === JSON.stringify([FAKE_C]), `B-RETURN no switch, my relay in use (${urls2.join(', ')})`)
  // A generous wait, not a timing check: poll until the list has gone out (at most the old 3 s).
  await waitUntil(() => {
    const l = listRelays(FAKE_C, A2.t.pubkey)
    return l.length > before && l[l.length - 1].includes(FAKE_C)
  }, 3_000)
  const after = listRelays(FAKE_C, A2.t.pubkey)
  ok(!A2.t.fallingBack() && after.length > before && after[after.length - 1].includes(FAKE_C), 'B-RETURN my lists go to my relay again, naming it')
  await A2.t.stop()
}

async function bEngineModes(): Promise<void> {
  const deps = [FAKE_A, FAKE_B]
  const mine = [DEAD_1, DEAD_2]
  // Automatic (the default once relays of my own are set): the app opens on the defaults.
  const auto = await preparedStorage({ lang: 'en', sort: 'amount', relays: mine, relayAuto: true })
  const eAuto = engineOn(deps, auto.storage.storage, { createTransport, pubkeyOf, npubOf, findList })
  void eAuto.start().catch(() => {})
  const ready = await waitUntil(() => eAuto.store.getState().boot === 'ready', 15_000)
  const sa = eAuto.store.getState()
  ok(ready && sa.fallingBack, `B-AUTO dead relays of my own: the app opens on the defaults (boot ${sa.boot}, fallingBack ${sa.fallingBack})`)
  ok(JSON.stringify(sa.relays.map((r) => r.url)) === JSON.stringify(deps), `B-AUTO state.relays are the defaults (${sa.relays.map((r) => r.url).join(', ')})`)
  ok(JSON.stringify(sa.settings.relays) === JSON.stringify(mine) && sa.settings.relayAuto, 'B-AUTO the choice itself is kept (settings.relays unchanged)')
  await eAuto.stop()

  // "Don't switch automatically": waits for my relays, sends nothing to the defaults.
  const strict = await preparedStorage({ lang: 'en', sort: 'amount', relays: mine, relayAuto: false })
  const eStrict = engineOn(deps, strict.storage.storage, { createTransport, pubkeyOf, npubOf, findList })
  const boots: string[] = []
  eStrict.store.subscribe((s) => boots.push(s.boot))
  void eStrict.start().catch(() => {})
  await sleep(8_000)
  const ss = eStrict.store.getState()
  const pk = ss.me?.pubkey ?? ''
  ok(ss.boot === 'starting' && !boots.includes('error') && !ss.fallingBack, `B-STRICT after 8 s still 'starting', no switch (boot ${ss.boot})`)
  ok(JSON.stringify(ss.relays.map((r) => r.url)) === JSON.stringify(mine), `B-STRICT state.relays are my relays (${ss.relays.map((r) => r.url).join(', ')})`)
  ok(pk !== '' && kindsOn(FAKE_A, pk).length === 0 && kindsOn(FAKE_B, pk).length === 0, 'B-STRICT nothing of mine reached the default relays')
  await eStrict.stop()
}

/** A hand-moved clock for ConnectionProblemGate: timers fire only in advance(). */
function handGateClock() {
  let now = 1_000_000
  let seq = 0
  const timers = new Map<number, { at: number; fn: () => void }>()
  return {
    now: () => now,
    setTimer: (fn: () => void, ms: number) => {
      timers.set(++seq, { at: now + ms, fn })
      return seq
    },
    clearTimer: (h: unknown) => void timers.delete(h as number),
    advance(ms: number) {
      const end = now + ms
      for (;;) {
        const due = [...timers.entries()].filter(([, t]) => t.at <= end).sort((a, b) => a[1].at - b[1].at)[0]
        if (!due) break
        timers.delete(due[0])
        now = Math.max(now, due[1].at)
        due[1].fn()
      }
      now = end
    },
  }
}

/**
 * B-COVER (UI pass fix A): strict mode, my relays unreachable. The connection problem
 * (ConnectionProblemGate, behind useConnectionProblem) is fed from the real engine's
 * state over fake relays, timers on a hand clock. Once shown it stays through the
 * engine's online retries (state.relays never empty, the kind never null), a hidden page
 * coming back, and an offline blip; the grace is not started again. It goes only when a
 * relay of mine actually connects. Before this fix the page coming back took the problem
 * down for 10 s (the boot screen in place of the cover, the relay sheet closed).
 */
async function bCover(): Promise<void> {
  const COVER = 'wss://cover-1.test'
  const mine = [COVER, DEAD_1]
  fake.relay(COVER).down()
  const st = await preparedStorage({ lang: 'en', sort: 'amount', relays: mine, relayAuto: false })
  const engine = engineOn([FAKE_A, FAKE_B], st.storage.storage, { createTransport, pubkeyOf, npubOf, findList })
  const clock = handGateClock()
  const changes: boolean[] = []
  const gate = new ConnectionProblemGate((v) => changes.push(v), true, clock)
  let online = true
  const kinds: ProblemKind[] = []
  let emptyAfterKnown = false
  let known = false
  const feed = () => {
    const s = engine.store.getState()
    if (s.relays.length) known = true
    else if (known) emptyAfterKnown = true
    const k = problemKind(online, s.relays)
    if (kinds[kinds.length - 1] !== k) kinds.push(k)
    gate.setKind(k)
  }
  const unsub = engine.store.subscribe(feed)
  void engine.start().catch(() => {})
  await waitUntil(() => kinds.includes('relay'), 5_000)
  clock.advance(CONNECT_GRACE_MS - 1)
  ok(!gate.shown, 'B-COVER not shown before the 10 s grace')
  clock.advance(1)
  ok(gate.shown, 'B-COVER shown after the 10 s grace (strict, my relays unreachable)')
  // The browser is online and only my relays fail: the kind is 'relay' (its 10 s grace),
  // not 'offline'. Both kinds show the same headline by design ("인터넷 연결을
  // 확인해 주세요" for no internet and for relays out of reach, so the screen never names
  // relays); strict mode adds its own line under it.
  ok(problemKind(online, engine.store.getState().relays) === 'relay', `B-COVER online with my relays all failing: kind 'relay' (${problemKind(online, engine.store.getState().relays)})`)
  const shownAt = changes.length
  // The page goes to the background and comes back: the problem is still there.
  gate.setVisible(false)
  clock.advance(60_000)
  gate.setVisible(true)
  ok(gate.shown, 'B-COVER a hidden page coming back keeps it shown (no boot screen for another 10 s)')
  // The browser says offline for a moment, then online again: still the same problem.
  online = false
  feed()
  ok(kinds[kinds.length - 1] === 'offline', `B-COVER the browser offline: kind 'offline' (${kinds[kinds.length - 1]})`)
  online = true
  feed()
  ok(kinds[kinds.length - 1] === 'relay', `B-COVER online again with my relays still failing: kind 'relay' (${kinds[kinds.length - 1]})`)
  ok(gate.shown, 'B-COVER an offline blip keeps it shown (the grace does not start again)')
  // The engine retries the online step meanwhile (real time, sockets to my relays again).
  const socketsBefore = fake.relay(COVER).sockets
  await sleep(7_000)
  clock.advance(1)
  ok(fake.relay(COVER).sockets > socketsBefore, `B-COVER the engine retried my relays (${socketsBefore} -> ${fake.relay(COVER).sockets} sockets)`)
  ok(!emptyAfterKnown && !kinds.slice(kinds.indexOf('relay')).includes(null), `B-COVER during retries state.relays never empty and the kind never null (${kinds.join(' > ')})`)
  ok(gate.shown && changes.length === shownAt, `B-COVER shown throughout, taken down never (${changes.join(',')})`)
  // A relay of mine comes back: the problem goes at once.
  fake.relay(COVER).up()
  const connected = await waitUntil(() => engine.store.getState().relays.some((r) => r.connected), 20_000)
  ok(connected && !gate.shown, `B-COVER a relay actually connected takes it down (connected ${connected}, shown ${gate.shown})`)
  // Before it is shown, coming back to the page starts the grace again.
  fake.relay(COVER).down()
  await waitUntil(() => kinds[kinds.length - 1] === 'relay', 20_000)
  clock.advance(5_000)
  gate.setVisible(false)
  gate.setVisible(true)
  clock.advance(CONNECT_GRACE_MS - 1)
  ok(!gate.shown, 'B-COVER not yet shown: a page coming back starts the grace again')
  clock.advance(1)
  ok(gate.shown, 'B-COVER then shown 10 s after coming back')
  unsub()
  gate.dispose()
  await engine.stop()
}

async function bSilentFallback(): Promise<void> {
  const real = { now: healthClock.now, every: healthClock.every }
  let now = 5_000_000
  const ticks: (() => void)[] = []
  healthClock.now = () => now
  healthClock.every = (_ms, tick) => {
    ticks.push(tick)
    return () => {
      const i = ticks.indexOf(tick)
      if (i >= 0) ticks.splice(i, 1)
    }
  }
  const phrases: string[] = []
  setLogSink((phrase) => phrases.push(phrase))
  const g2 = globalThis as { document?: unknown }
  // A page with visibility events (the transport listens from its start).
  const doc = Object.assign(new EventTarget(), { visibilityState: 'visible' as 'visible' | 'hidden' })
  const show = (state: 'visible' | 'hidden') => {
    doc.visibilityState = state
    doc.dispatchEvent(new Event('visibilitychange'))
  }
  g2.document = doc
  const p = transportOn([SILENT_1, SILENT_2], await freshTables(), undefined, [FAKE_A, FAKE_B])
  try {
    const start = quiet(p.t.start())
    await waitUntil(() => ticks.length > 0, 5_000)
    const step = (ms: number, times = 1) => {
      for (let i = 0; i < times; i++) {
        now += ms
        for (const tick of [...ticks]) tick()
      }
    }
    const noProbe = () => !p.t.fallingBack() && !phrases.some((x) => x.startsWith('relay fallback'))
    step(0)
    step(HEALTH_TICK_MS, 5)
    // A phone hides the page at 10 s silent and its timers sleep 10 minutes.
    // Back, the first tick must not count the hidden time as silent time.
    show('hidden')
    now += 600_000
    show('visible')
    step(HEALTH_TICK_MS)
    await sleep(4_000)
    ok(noProbe(), 'B-SILENT-FALLBACK 10 min hidden without a tick, then 2 s visible: no probe (the hidden time is not silent time)')
    step(HEALTH_TICK_MS, 8)
    await sleep(4_000)
    ok(noProbe(), 'B-SILENT-FALLBACK chosen relays that never answer: no probe, no switch at 18 s visible')
    step(HEALTH_TICK_MS)
    const switched = await waitUntil(() => p.t.fallingBack(), 8_000)
    const line = phrases.find((x) => x.startsWith('relay fallback (')) ?? '-'
    ok(switched, `B-SILENT-FALLBACK at 20 s silent: probe, 3 s confirm, switch (${line})`)
    const r = await within(start, 10_000)
    ok(r.state === 'ok', `B-SILENT-FALLBACK start() finishes on the fallback relays (${r.state === 'error' ? r.message : r.state})`)
  } finally {
    delete g2.document
    await p.t.stop()
    setLogSink(null)
    healthClock.now = real.now
    healthClock.every = real.every
  }
}

/** REQs to `url` of the fallback probe of `pubkey`: my relay list, one event. */
function probesOn(url: string, pubkey: string): number {
  return fake.relay(url).reqs.filter((filters) => filters.some((f) => f.kinds?.includes(10002) && f.authors?.includes(pubkey) && f.limit === 1)).length
}

async function bFlap(): Promise<void> {
  const FLAP = 'wss://flap-1.test'
  const real = { now: healthClock.now, every: healthClock.every }
  let now = 9_000_000
  const ticks: (() => void)[] = []
  healthClock.now = () => now
  healthClock.every = (_ms, tick) => {
    ticks.push(tick)
    return () => {
      const i = ticks.indexOf(tick)
      if (i >= 0) ticks.splice(i, 1)
    }
  }
  const flap = fake.relay(FLAP)
  const p = transportOn([FLAP], await freshTables(), undefined, [FAKE_A, FAKE_B])
  // The relay comes back the moment a probe reaches the fallback relay, before the
  // transport wakes the chosen relays for the 3 s confirmation.
  const reqs = fake.relay(FAKE_A).reqs
  const push = reqs.push
  reqs.push = (...items: typeof reqs) => {
    const n = push.apply(reqs, items)
    if (items.some((filters) => filters.some((f) => f.kinds?.includes(10002) && f.authors?.includes(p.t.pubkey) && f.limit === 1))) flap.up()
    return n
  }
  try {
    const r = await within(p.t.start(), 10_000)
    ok(r.state === 'ok', `B-FLAP starts on the chosen relay (${r.state === 'error' ? r.message : r.state})`)
    const connected = () => p.t.relayStatus().some((s) => s.connected)
    const probes = () => probesOn(FAKE_A, p.t.pubkey)
    flap.down()
    await waitUntil(() => !connected(), 5_000)
    // Its reconnects fail: counted failures, so the watch wants a probe.
    await sleep(1_500)
    const start = now
    let seen = 0
    // 60 s of health clock in ticks of 2 s. Whenever a probe goes out, the relay comes
    // back during the 3 s confirmation (so no switch), then drops again.
    while (now - start < 60_000 && seen <= 8) {
      now += HEALTH_TICK_MS
      for (const tick of [...ticks]) tick()
      await sleep(50)
      if (probes() > seen) {
        seen = probes()
        await sleep(3_300)
        flap.down()
        await waitUntil(() => !connected(), 5_000)
        await sleep(1_500)
      }
    }
    ok(!p.t.fallingBack(), 'B-FLAP the relay always came back in time: no switch')
    ok(seen >= 2, `B-FLAP the watch runs: probes went out (${seen})`)
    ok(seen <= 4, `B-FLAP in 60 s at most 4 probes reach the fallback relays (waits 5, 15, 30 s) (${seen})`)
  } finally {
    reqs.push = push
    flap.up()
    await p.t.stop()
    healthClock.now = real.now
    healthClock.every = real.every
  }
}

/**
 * B-SWITCH-SIGN (the switch to the fallback relays meets the rule that relay lists are signed only when they change).
 * The switch reassigns #relays and #resyncAfterSwitch() reruns the online attempt, so
 * #ensureRelayLists signs one pair for the fallback list, dated after the stored record
 * and after any pair this session already signed, and stores only the list in use.
 */
async function bSwitchSign(): Promise<void> {
  const tables = await freshTables()
  const meta = tables.table<string>('meta')
  const sk = generateSecretKeyHex()
  const pk = pubkeyOf(sk)
  const stored = async () => parseRelayListRecord(await meta.getItem('relay-lists'), pk)
  const pairs = (url: string) => {
    const e = fake.relay(url).events.filter((x) => x.pubkey === pk)
    return { n10002: new Set(e.filter((x) => x.kind === 10002).map((x) => x.id)), n10050: new Set(e.filter((x) => x.kind === 10050).map((x) => x.id)) }
  }
  const signedLines = (lines: string[]) => lines.filter((l) => l.includes('relay list signed')).length

  // A first session on my relay: the record is a pair naming it.
  let A = transportOn([FAKE_C], tables, sk, [FAKE_A, FAKE_B])
  let r = await within(A.t.start(), 10_000)
  const recC = await stored()
  ok(r.state === 'ok' && !A.t.fallingBack() && !!recC && relayListAction(recC, [FAKE_C]) === 'rebroadcast', `B-SWITCH-SIGN first start on my relay stores its pair (${r.state})`)
  await A.t.stop()
  const c0 = recC?.events[0].created_at ?? Infinity

  // My relay is dead at the next start: the stored pair fails (no signature for it), the
  // switch follows, and exactly one pair is signed for the fallback list, dated later.
  fake.relay(FAKE_C).down()
  let log = captureMarmotLog()
  const beforeA = pairs(FAKE_A)
  A = transportOn([FAKE_C], tables, sk, [FAKE_A, FAKE_B])
  const start2 = quiet(A.t.start())
  const switched = await waitUntil(() => A.t.fallingBack(), 10_000)
  r = await within(start2, 10_000)
  await sleep(1_500)
  const afterA = pairs(FAKE_A)
  const recF = await stored()
  ok(switched && r.state === 'ok', `B-SWITCH-SIGN chosen relay dead: switched and the start finished (${r.state})`)
  ok(signedLines(log.lines) === 1, `B-SWITCH-SIGN exactly one pair signed in the switching session (${signedLines(log.lines)})`)
  ok(afterA.n10002.size === beforeA.n10002.size + 1 && afterA.n10050.size === beforeA.n10050.size + 1, 'B-SWITCH-SIGN the fallback relay got one new 10002 and one new 10050')
  ok(
    !!recF && relayListAction(recF, [FAKE_A, FAKE_B]) === 'rebroadcast' && recF.events[0].created_at > c0 && recF.events[1].created_at > c0,
    `B-SWITCH-SIGN the stored record is the fallback pair, dated after the old one (${recF?.events[0].created_at} > ${c0})`,
  )

  // My relay returns in the same session: no switch back, nothing signed.
  fake.relay(FAKE_C).up()
  await sleep(3_000)
  ok(A.t.fallingBack() && signedLines(log.lines) === 1, 'B-SWITCH-SIGN my relay back in the same session: still on the fallback, no new signature')
  ok((await stored())?.events[0].id === recF?.events[0].id, 'B-SWITCH-SIGN the record stays the fallback pair')
  await A.t.stop()
  log.restore()

  // The next start begins with my relay again (it is back): one pair for it, dated after
  // the fallback pair even within the same second, and stored; no switch.
  log = captureMarmotLog()
  A = transportOn([FAKE_C], tables, sk, [FAKE_A, FAKE_B])
  r = await within(A.t.start(), 10_000)
  const recC2 = await stored()
  const f0 = recF?.events[0].created_at ?? Infinity
  ok(r.state === 'ok' && !A.t.fallingBack(), `B-SWITCH-SIGN the next start stays on my relay (${r.state})`)
  ok(
    signedLines(log.lines) === 1 && !!recC2 && relayListAction(recC2, [FAKE_C]) === 'rebroadcast' && recC2.events[0].created_at > f0,
    `B-SWITCH-SIGN back on my relay: one pair, stored, dated after the fallback pair (${recC2?.events[0].created_at} > ${f0})`,
  )
  await A.t.stop()
  log.restore()

  // A session that signs a pair its relays never take (a changed list of dead relays),
  // then switches: the fallback pair is dated after that unstored pair too (the
  // three-argument nextListCreatedAt), so two signatures in one second never share a time.
  log = captureMarmotLog()
  const c2 = recC2?.events[0].created_at ?? Infinity
  A = transportOn([DEAD_1], tables, sk, [FAKE_A, FAKE_B])
  const start4 = quiet(A.t.start())
  const switched4 = await waitUntil(() => A.t.fallingBack(), 10_000)
  r = await within(start4, 10_000)
  await sleep(500)
  const recF2 = await stored()
  ok(switched4 && r.state === 'ok', `B-SWITCH-SIGN dead changed list: switched (${r.state})`)
  ok(signedLines(log.lines) === 2, `B-SWITCH-SIGN dead changed list: two pairs signed, the dead one and the fallback one (${signedLines(log.lines)})`)
  ok(
    !!recF2 && relayListAction(recF2, [FAKE_A, FAKE_B]) === 'rebroadcast' && recF2.events[0].created_at >= c2 + 2,
    `B-SWITCH-SIGN the fallback pair is dated after the unstored pair as well (${recF2?.events[0].created_at} >= ${c2} + 2)`,
  )
  await A.t.stop()
  log.restore()
}

/**
 * B-FORGET (forgetGroup meets the room turns and guardIngest). A room
 * forgotten while a send of it is under way: the send settles (it does not hang on the
 * room's turn), the room's ingest guard goes with it (#detach), and sends and messages of
 * another room go on; the forgotten room is no longer listed or stored.
 */
async function bForget(): Promise<void> {
  const relays = [FAKE_A, FAKE_B]
  const A = transportOn(relays, await freshTables())
  const B = transportOn(relays, await freshTables())
  const C = transportOn(relays, await freshTables())
  await Promise.all([A.t.start(), B.t.start(), C.t.start()])
  const gAB = await linkPair(A, B)
  const gAC = await linkPair(A, C)
  const texts = (p: Peer, g: string) => p.messages.filter((m) => m.groupId === g && m.msg.t === 'chat').map((m) => (m.msg as { text: string }).text)

  // Both rooms carry messages before.
  ok((await within(A.t.send(gAB, { t: 'chat', id: randomHex(16), text: 'ab-1' }), 15_000)).state === 'ok', 'B-FORGET a send in the room to forget works before')
  ok((await within(A.t.send(gAC, { t: 'chat', id: randomHex(16), text: 'ac-1' }), 15_000)).state === 'ok', 'B-FORGET a send in the other room works before')

  // Forget A-B while a send of it is under way and B is sending into it.
  // quiet: it may reject (the room is destroyed under it) before within() below listens.
  const inFlight = quiet(A.t.send(gAB, { t: 'chat', id: randomHex(16), text: 'ab-2' }))
  void B.t.send(gAB, { t: 'chat', id: randomHex(16), text: 'ba-after' }).catch(() => {})
  const forgot = await within(A.t.forgetGroup(gAB), 15_000)
  ok(forgot.state === 'ok', `B-FORGET forgetGroup resolves (${forgot.state === 'error' ? forgot.message : forgot.state})`)
  const settled = await within(inFlight, 35_000)
  ok(settled.state !== 'pending', `B-FORGET the send under way settles instead of holding the room's turn (${settled.state === 'error' ? settled.message : settled.state})`)
  const listed = await A.t.listGroups()
  ok(!listed.some((g) => g.groupId === gAB) && listed.some((g) => g.groupId === gAC), 'B-FORGET the forgotten room is no longer listed; the other one is')
  ok(A.t.groupHealth(gAB) === 'missing', `B-FORGET the forgotten room is 'missing' (${A.t.groupHealth(gAB)})`)
  ok((await A.tables.table<unknown>('groups').getItem(gAB)) == null, 'B-FORGET its stored state is gone')

  // The other room: sends in both directions go on at once (no turn left behind).
  const r2 = await within(A.t.send(gAC, { t: 'chat', id: randomHex(16), text: 'ac-2' }), 15_000)
  ok(r2.state === 'ok', `B-FORGET a send in the other room right after works (${r2.state === 'error' ? r2.message : r2.state})`)
  ok(await waitUntil(() => texts(C, gAC).includes('ac-2'), 15_000), 'B-FORGET C gets it')
  const r3 = await within(C.t.send(gAC, { t: 'chat', id: randomHex(16), text: 'ca-2' }), 15_000)
  ok(r3.state === 'ok' && (await waitUntil(() => texts(A, gAC).includes('ca-2'), 15_000)), "B-FORGET and A gets the other room's messages")
  // A send to the forgotten room fails instead of waiting.
  const r4 = await within(A.t.send(gAB, { t: 'chat', id: randomHex(16), text: 'ab-3' }), 15_000)
  ok(r4.state === 'error', `B-FORGET a send to the forgotten room is refused (${r4.state === 'error' ? r4.message : r4.state})`)
  await sleep(1_000)
  ok(!texts(A, gAB).includes('ba-after'), 'B-FORGET nothing of the forgotten room is delivered to A afterwards')
  // Unknown or already forgotten: resolves.
  ok((await within(A.t.forgetGroup(gAB), 5_000)).state === 'ok', 'B-FORGET forgetting it again resolves')
  await Promise.all([A.t.stop(), B.t.stop(), C.t.stop()])
}

// ---------------------------------------------------------------- run

const t0 = Date.now()
b14()
b15()
await b12()
await b1()
await bAllSilent()
await b2()
await b9()
await bStopLocal()
await b3()
await b13()
await bSilent()
await bInbox()
await bTurn()
await bOrder()
await bFlood()
await bForget()
await bStrand()
b8()
await b16()
await bElsewhereThrottle()
b7()
// These use only dead and silent hosts and fake-a/b, which none of them takes down.
// B6 runs alone after them: it reads the global log sink.
await Promise.all([b4b5(), b10(), bPartial(), bEngineModes(), bCover()])
await b6()
await b11Return()
await bSilentFallback()
await bFlap()
await bSwitchSign()
await sleep(200)
ok(unhandled.length === 0, `no unhandled rejections${unhandled.length ? `: ${unhandled.map((e) => (e instanceof Error ? e.message : String(e))).join('; ')}` : ''}`)
fake.restore()
console.log(failures ? `\n${failures} FAILED  (${Date.now() - t0} ms)` : `\nALL PASS  (${Date.now() - t0} ms)`)
for (const n of failedNames) console.log(`  FAILED: ${n}`)
process.exit(failures ? 1 : 0)
