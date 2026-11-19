/**
 * Engine check scenarios: the fake hub itself (S-HUB, S-HUB-*).
 * Run from scripts/check-engine.ts, which lists every scenario in its order.
 */
import type { ChatMessage } from '../../../src/contracts'
import { pubkeyOf, randomHex } from '../../../src/lib/marmot/keys'
import { type Envelope, type FakeClock, type FakeHub, createFakeClock, createFakeHub, createHarnessKV } from '../../fake-transport'
import { expect } from '../report'
import { MIN, type Peer, START_MS, adv, finish, hasContact, link, makePeer, newWorld, orderedKeys, until } from '../world'

// ---------------------------------------------------------------- S-HUB

export async function sHub(): Promise<void> {
  const clock = createFakeClock(START_MS)
  const hub = createFakeHub(clock)
  const m = hub.marmot()
  const [ka, kb] = orderedKeys(2)
  const opts = (sk: string, name: string) => ({
    secretKeyHex: sk,
    relays: ['fake://relay'],
    namespace: name,
    persistence: 'memory' as const,
    tables: {
      table: () => {
        throw new Error('the fake transport keeps no tables')
      },
    },
  })
  const A = m.createTransport(opts(ka.sk, 'a'))
  let B = m.createTransport(opts(kb.sk, 'b'))
  const gotB: { id: string; t: string }[] = []
  const invitesB: string[] = []
  const wire = (t: typeof B) => {
    t.onMessage((x) => void gotB.push({ id: x.id, t: x.msg.t }))
    t.onInvite((i) => invitesB.push(i.id))
  }
  wire(B)
  await A.start()
  await B.start()
  await B.stop()

  // An invite sent while the peer is off arrives at its next start().
  const inv = A.invitePeer(B.pubkey)
  await clock.advance(100)
  const { groupId } = await inv
  expect(invitesB.length === 0, 'no invite while the peer is stopped')
  B = m.createTransport(opts(kb.sk, 'b'))
  wire(B)
  await B.start()
  await clock.advance(10)
  expect(invitesB.length === 1, `the invite arrives at the next start() (got ${invitesB.length})`)

  // A message uploaded before the accept is delivered after it.
  await A.send(groupId, { t: 'chat', id: randomHex(16), text: 'early' })
  await clock.advance(100)
  expect(gotB.length === 0, 'nothing before the accept')
  const acc = B.acceptInvite(invitesB[0])
  await clock.advance(100)
  expect((await acc).groupId === groupId, 'accept returns the group')
  await clock.advance(100)
  expect(gotB.length === 1 && gotB[0].t === 'chat', `the early message follows the accept (got ${gotB.length})`)

  // 'duplicate': the same id twice.
  hub.route = () => 'duplicate'
  await A.send(groupId, { t: 'chat', id: randomHex(16), text: 'twice' })
  await clock.advance(100)
  hub.route = () => 'deliver'
  expect(gotB.length === 3 && gotB[1].id === gotB[2].id, 'a duplicated message arrives twice with one id')

  // Same key again: attaches to the same hub state, nothing delivered again.
  await B.stop()
  B = m.createTransport(opts(kb.sk, 'b'))
  wire(B)
  await B.start()
  await clock.advance(1000)
  expect(gotB.length === 3, `no redelivery after reattaching (got ${gotB.length})`)

  // A stopped transport refuses to send.
  await A.stop()
  let err = ''
  await A.send(groupId, { t: 'chat', id: randomHex(16), text: 'x' }).catch((e: Error) => (err = e.message))
  expect(err === 'transport is stopped', `send on a stopped transport: Error('transport is stopped') (got '${err}')`)

  // groupHealth: the key's group 'ok', any other id 'missing', strand 'stranded'.
  let healthCalls = 0
  const offHealth = B.onGroupHealth(() => healthCalls++)
  expect(B.groupHealth(groupId) === 'ok', `groupHealth of a joined group (got ${B.groupHealth(groupId)})`)
  expect(B.groupHealth('cd'.repeat(32)) === 'missing', 'groupHealth of an unknown id is missing')
  expect(B.fallingBack() === false, 'fallingBack is false (no fallback yet)')
  err = ''
  await B.send('cd'.repeat(32), { t: 'chat', id: randomHex(16), text: 'x' }).catch((e: Error) => (err = e.message))
  expect(err === 'group-unreadable', `send to an unknown group: Error('group-unreadable') (got '${err}')`)
  hub.strand(groupId)
  expect(B.groupHealth(groupId) === 'stranded' && healthCalls >= 1, 'strand: stranded, and onGroupHealth is called')
  hub.strand(groupId, false)
  expect(B.groupHealth(groupId) === 'ok', 'strand off: ok again')
  offHealth()

  // 'down': send is refused with 'offline'; start() waits, and
  // stop() ends the wait with 'transport is stopped'.
  hub.setNetwork(B.pubkey, 'down')
  err = ''
  await B.send(groupId, { t: 'chat', id: randomHex(16), text: 'x' }).catch((e: Error) => (err = e.message))
  expect(err === 'offline', `send while down: Error('offline') (got '${err}')`)
  expect(
    B.relayStatus().every((r) => !r.connected),
    'relays reported disconnected while down',
  )
  const B2 = m.createTransport(opts(kb.sk, 'b'))
  let started2: string | null = null
  void B2.start().then(
    () => (started2 = 'ok'),
    (e: Error) => (started2 = e.message),
  )
  await clock.advance(10 * 60_000)
  expect(started2 === null, `start while down waits, also after 10 minutes (got '${started2}')`)
  expect(B2.groupHealth(groupId) === 'ok', 'while waiting the stored groups are loaded (local step)')
  await B2.stop()
  await clock.settle()
  expect(started2 === 'transport is stopped', `stop() ends a waiting start with 'transport is stopped' (got '${started2}')`)
  B = m.createTransport(opts(kb.sk, 'b'))
  wire(B)
  let started3 = false
  const p3 = B.start().then(() => (started3 = true))
  await clock.advance(60_000)
  expect(!started3, 'still waiting while down')
  hub.setNetwork(B.pubkey, 'up')
  await p3
  expect(started3 && B.relayStatus().every((r) => r.connected), "start resolves once 'up' comes")

  // A room whose stored state cannot be read: skipped from the next start on.
  hub.unreadable(B.pubkey, groupId)
  await B.stop()
  B = m.createTransport(opts(kb.sk, 'b'))
  wire(B)
  await B.start()
  expect(B.groupHealth(groupId) === 'unreadable', `unreadable from the next start (got ${B.groupHealth(groupId)})`)
  err = ''
  await B.send(groupId, { t: 'chat', id: randomHex(16), text: 'x' }).catch((e: Error) => (err = e.message))
  expect(err === 'group-unreadable', `send in an unreadable room: Error('group-unreadable') (got '${err}')`)
  const listedUnreadable = await B.listGroups()
  expect(
    listedUnreadable.length === 1 && listedUnreadable[0].groupId === groupId && listedUnreadable[0].peerPubkey === null,
    `an unreadable room is listed without its peer (stored rooms; got ${JSON.stringify(listedUnreadable)})`,
  )
  const beforeUnreadable = gotB.length
  const A3 = m.createTransport(opts(ka.sk, 'a'))
  await A3.start()
  await A3.send(groupId, { t: 'chat', id: randomHex(16), text: 'while unreadable' })
  await clock.advance(1000)
  expect(gotB.length === beforeUnreadable, 'nothing is delivered from an unreadable room')
  hub.unreadable(B.pubkey, groupId, false)
  await B.stop()
  B = m.createTransport(opts(kb.sk, 'b'))
  wire(B)
  await B.start()
  await clock.advance(1000)
  expect(B.groupHealth(groupId) === 'ok' && gotB.length === beforeUnreadable + 1, 'readable again: ok, and what waited arrives')
  await A3.stop()

  // Second device of B's key: a Welcome goes only to the device with the
  // newest key package; a wipe forgets one device and leaves the other.
  const Bsecond = hub.marmot('second', { nowOffsetMs: 5 * MIN }).createTransport(opts(kb.sk, 'b2'))
  const invitesB2: { id: string; sentAt: number }[] = []
  Bsecond.onInvite((i) => invitesB2.push({ id: i.id, sentAt: i.sentAt }))
  await Bsecond.start()
  const A4 = m.createTransport(opts(ka.sk, 'a'))
  await A4.start()
  const before2 = invitesB.length
  const g2 = A4.invitePeer(B.pubkey)
  await clock.advance(100)
  const g2id = (await g2).groupId
  await clock.advance(10)
  expect(invitesB2.length === 1 && invitesB.length === before2, `the Welcome reaches only the newest device (second ${invitesB2.length}, main ${invitesB.length - before2})`)
  const rec2 = hub.invites.find((r) => r.groupId === g2id)
  expect(rec2?.toDevice === 'second' && rec2.fromDevice === 'main', 'the invite record names both devices')
  // B2's own Welcome carries its clock offset.
  const g3 = Bsecond.invitePeer(A4.pubkey)
  await clock.advance(100)
  const g3id = (await g3).groupId
  const rec3 = hub.invites.find((r) => r.groupId === g3id)
  // The group is made after the 30 ms invite delay, 70 ms before now.
  expect(rec3?.sentAt === Math.floor((clock.now() - 70 + 5 * MIN) / 1000), `the second device's sentAt is off by its offset (${rec3?.sentAt})`)
  await Bsecond.forgetGroup(g3id)
  hub.wipe(B.pubkey, 'second')
  expect(hub.groupsOf(B.pubkey, 'second').length === 0 && hub.groupsOf(B.pubkey, 'main').includes(groupId), 'wipe forgets that device only')
  await A4.forgetGroup(g2id)
  await A4.stop()

  // crashAfter(2): the third write resolves the promise and is not applied.
  const kv = createHarnessKV()
  const h = kv.handle('x#1')
  let crashed = false
  const c = kv.crashAfter(2).then(() => (crashed = true))
  await h.set('k1', 1)
  await h.set('k2', 2)
  void h.set('k3', 3)
  await c
  expect(crashed && kv.peek('k1') === 1 && kv.peek('k2') === 2 && kv.peek('k3') === undefined, 'crashAfter(2): third write not applied')
  kv.close('x#1', 'crash')
  void h.set('k4', 4)
  await clock.settle()
  expect(kv.lateWrites.length === 0 && kv.peek('k4') === undefined, 'a crashed handle writes nothing and counts no late write')
  const h2 = kv.handle('x#2')
  await h2.set('k3', 3)
  expect(kv.peek('k3') === 3, 'a new handle after close writes')
  kv.close('x#2')
  await h2.set('k5', 5)
  expect(kv.lateWrites.length === 1 && kv.peek('k5') === undefined, 'a write through a stopped handle is a late write')

  // crashWhen: the power goes off at the first matching write; nothing lands after it.
  const h3 = kv.handle('x#3')
  const c2 = kv.crashWhen((x) => x.key === 'k7')
  await h3.set('k6', 6)
  void h3.set('k7', 7)
  await c2
  void h3.set('k8', 8)
  await Promise.resolve()
  expect(kv.peek('k6') === 6 && kv.peek('k7') === undefined && kv.peek('k8') === undefined, 'crashWhen: the matching write and later ones do not land')
  expect(kv.keys().includes('k6') && !kv.keys().includes('k7'), 'keys() lists what is stored')
  kv.close('x#3', 'crash')

  // Unreadable content goes to unparsed, not to the receiver.
  const before = gotB.length
  const A2 = m.createTransport(opts(ka.sk, 'a'))
  await A2.start()
  hub.inject(A.pubkey, groupId, '{"t":"nope"}')
  await clock.advance(100)
  expect(gotB.length === before && hub.unparsed.length === 1, 'an unknown message type is dropped by the parser')
  await B.stop()
  await A2.stop()
}

// ---------------------------------------------------------------- S-HUB-*

/** Two started fake transports A and B of one hub, in one group; B's chats in arrival order. */
async function hubPair(): Promise<{
  clock: FakeClock
  hub: FakeHub
  A: ReturnType<MarmotModuleOf['createTransport']>
  B: ReturnType<MarmotModuleOf['createTransport']>
  groupId: string
  texts: () => string[]
}> {
  const clock = createFakeClock(START_MS)
  const hub = createFakeHub(clock)
  const m = hub.marmot()
  const [ka, kb] = orderedKeys(2)
  let n = 0
  const make = (sk: string, name: string) =>
    m.createTransport({
      secretKeyHex: sk,
      relays: ['fake://relay'],
      namespace: `${name}${++n}`,
      persistence: 'memory',
      tables: {
        table: () => {
          throw new Error('the fake transport keeps no tables')
        },
      },
    })
  const A = make(ka.sk, 'a')
  const B = make(kb.sk, 'b')
  const got: string[] = []
  B.onMessage((x) => {
    if (x.msg.t === 'chat') got.push(x.msg.text)
  })
  const invites: string[] = []
  B.onInvite((i) => invites.push(i.id))
  await A.start()
  await B.start()
  const inv = A.invitePeer(B.pubkey)
  await clock.advance(100)
  const { groupId } = await inv
  await clock.advance(10)
  const acc = B.acceptInvite(invites[0])
  await clock.advance(100)
  await acc
  return { clock, hub, A, B, groupId, texts: () => [...got] }
}

type MarmotModuleOf = ReturnType<FakeHub['marmot']>

const textOf = (e: Envelope): string => {
  try {
    const v = JSON.parse(e.json) as { text?: unknown }
    return typeof v.text === 'string' ? v.text : ''
  } catch {
    return ''
  }
}

/** 'hold' keeps an envelope back until release; release(id) lets that one go, release() the rest in order. */
export async function sHubHold(): Promise<void> {
  const { clock, hub, A, groupId, texts } = await hubPair()
  hub.route = (e) => (textOf(e).startsWith('h') ? 'hold' : 'deliver')
  for (const text of ['h1', 'n1', 'h2', 'h3']) await A.send(groupId, { t: 'chat', id: randomHex(16), text })
  await clock.advance(10 * MIN)
  expect(texts().join() === 'n1', `before release only the free one arrives (got ${texts().join()})`)
  const held = hub.held()
  expect(held.length === 3, `three envelopes are held (got ${held.length})`)
  const h2 = hub.log.find((e) => textOf(e) === 'h2') as Envelope
  expect(hub.release(h2.id) === 1, 'release(id) lets exactly one go')
  await clock.advance(19)
  expect(texts().join() === 'n1', 'a released envelope still takes the latency (not before 20 ms)')
  await clock.advance(1)
  expect(texts().join() === 'n1,h2', `release(id): that one arrives, the others stay held (got ${texts().join()})`)
  expect(hub.held().length === 2, 'two are still held')
  hub.route = () => 'deliver'
  await A.send(groupId, { t: 'chat', id: randomHex(16), text: 'n2' })
  await clock.advance(MIN)
  expect(texts().join() === 'n1,h2,n2', `a later free message is not blocked by held ones (got ${texts().join()})`)
  expect(hub.release() === 2, 'release() lets every held one go')
  await clock.advance(100)
  expect(texts().join() === 'n1,h2,n2,h1,h3', `release(): the rest arrive in the order they were held (got ${texts().join()})`)
  expect(hub.held().length === 0 && hub.release() === 0, 'nothing is held any more')
  await clock.advance(10 * MIN)
  expect(texts().length === 5, 'each released envelope arrives once')
}

/** { rejectAfterMs }: nothing goes up, and the refusal comes exactly that much later, also across stop(). */
export async function sHubRejectAfter(): Promise<void> {
  const { clock, hub, A, groupId, texts } = await hubPair()
  hub.failSend = () => ({ rejectAfterMs: 500 })
  const logBefore = hub.log.length
  const t0 = clock.now()
  let at = -1
  let err = ''
  void A.send(groupId, { t: 'chat', id: randomHex(16), text: 'late-no' }).then(
    () => (at = -2),
    (e: Error) => {
      at = clock.now() - t0
      err = e.message
    },
  )
  await clock.advance(499)
  expect(at === -1, `not refused before 500 ms (got ${at})`)
  await clock.advance(1)
  expect(at === 500 && err === 'no relay accepted the message', `refused at 500 ms (got ${at}, '${err}')`)
  expect(hub.log.length === logBefore, 'nothing was uploaded')
  // A stop() in between does not cut the wait short; the refusal still comes at 500 ms.
  const t1 = clock.now()
  at = -1
  void A.send(groupId, { t: 'chat', id: randomHex(16), text: 'late-no-2' }).then(
    () => (at = -2),
    (e: Error) => {
      at = clock.now() - t1
      err = e.message
    },
  )
  await clock.advance(200)
  await A.stop()
  await clock.advance(299)
  expect(at === -1, `stop() in between: still not refused at 499 ms (got ${at})`)
  await clock.advance(1)
  expect(at === 500 && err === 'no relay accepted the message', `stop() in between: refused at 500 ms (got ${at}, '${err}')`)
  await clock.advance(MIN)
  expect(hub.log.length === logBefore && texts().length === 0, 'nothing was uploaded or delivered')
}

/** A send before start() waits for the start's local step; stop() before it ends the wait. */
export async function sHubSendWait(): Promise<void> {
  const clock = createFakeClock(START_MS)
  const hub = createFakeHub(clock)
  const m = hub.marmot()
  const [ka, kb] = orderedKeys(2)
  const make = (sk: string, name: string) =>
    m.createTransport({
      secretKeyHex: sk,
      relays: ['fake://relay'],
      namespace: name,
      persistence: 'memory',
      tables: {
        table: () => {
          throw new Error('the fake transport keeps no tables')
        },
      },
    })
  const A = make(ka.sk, 'a1')
  const B = make(kb.sk, 'b1')
  const got: string[] = []
  B.onMessage((x) => void (x.msg.t === 'chat' && got.push(x.msg.text)))
  const invites: string[] = []
  B.onInvite((i) => invites.push(i.id))
  await A.start()
  await B.start()
  const inv = A.invitePeer(B.pubkey)
  await clock.advance(100)
  const { groupId } = await inv
  await clock.advance(10)
  const acc = B.acceptInvite(invites[0])
  await clock.advance(100)
  await acc
  await A.stop()

  // A new transport of A, not started: the send waits, also for minutes.
  const A2 = make(ka.sk, 'a2')
  let r: string | null = null
  void A2.send(groupId, { t: 'chat', id: randomHex(16), text: 'after-start' }).then(
    () => (r = 'ok'),
    (e: Error) => (r = e.message),
  )
  await clock.advance(5 * MIN)
  expect(r === null, `a send before start() waits (got '${r}')`)
  expect(!hub.log.some((e) => textOf(e) === 'after-start'), 'nothing goes up before the start')
  await A2.start()
  await clock.advance(100)
  expect(r === 'ok', `the send goes once start() ran (got '${r}')`)
  expect(got.includes('after-start'), 'and arrives')

  // While the network is down the start's online step waits, but the send only waits for
  // the local step: it is refused with 'offline' at once, not held until 'up'.
  hub.setNetwork(pubkeyOf(ka.sk), 'down')
  await A2.stop()
  const A3 = make(ka.sk, 'a3')
  void A3.start().catch(() => {})
  let r3: string | null = null
  void A3.send(groupId, { t: 'chat', id: randomHex(16), text: 'while-down' }).then(
    () => (r3 = 'ok'),
    (e: Error) => (r3 = e.message),
  )
  await clock.settle()
  expect(r3 === 'offline', `a send after the local step while down is refused with 'offline' (got '${r3}')`)
  await A3.stop()
  hub.setNetwork(pubkeyOf(ka.sk), 'up')

  // stop() before any start: the waiting send ends with 'transport is stopped'.
  const A4 = make(ka.sk, 'a4')
  let r4: string | null = null
  void A4.send(groupId, { t: 'chat', id: randomHex(16), text: 'never' }).then(
    () => (r4 = 'ok'),
    (e: Error) => (r4 = e.message),
  )
  await clock.advance(1000)
  expect(r4 === null, 'still waiting before stop()')
  await A4.stop()
  await clock.settle()
  expect(r4 === 'transport is stopped', `stop() ends a send that waited for the start (got '${r4}')`)
  expect(!hub.log.some((e) => textOf(e) === 'never'), 'it never went up')
  await B.stop()
}

/** hangNext(key): only the next write of that key hangs (not applied, never done); the rest go on. */
export async function sHubHang(): Promise<void> {
  const clock = createFakeClock(START_MS)
  const kv = createHarnessKV()
  const h1 = kv.handle('x#1')
  await h1.set('rooms', 'r0')
  kv.hangNext('rooms')
  let done1 = false
  void h1.set('rooms', 'r1').then(() => (done1 = true))
  await h1.set('other', 'o1')
  await clock.settle()
  expect(!done1 && kv.peek('rooms') === 'r0', `the next write of the key hangs and is not applied (done ${done1}, value ${kv.peek('rooms')})`)
  expect(kv.peek('other') === 'o1', 'a write of another key goes on')
  await h1.set('rooms', 'r2')
  expect(kv.peek('rooms') === 'r2', 'the write after it is applied as usual')
  await clock.settle()
  expect(!done1, 'the hung write never finishes')
  expect(kv.writes.filter((x) => x.key === 'rooms').length === 2, `the log holds r0 and r2 only (got ${kv.writes.filter((x) => x.key === 'rooms').length})`)
  // One call hangs one write, through whatever handle comes next; a del counts too.
  kv.hangNext('rooms')
  kv.close('x#1')
  const h2 = kv.handle('x#2')
  let done2 = false
  void h2.del('rooms').then(() => (done2 = true))
  await clock.settle()
  expect(!done2 && kv.peek('rooms') === 'r2', 'a del of the key through a new handle hangs too')
  await h2.del('rooms')
  expect(kv.peek('rooms') === undefined, 'the next del goes through')
  expect(kv.lateWrites.length === 0, 'no late writes')
  kv.close('x#2')
}

/** A crashed generation: its late writes never land and never finish, also after a newer generation wrote. */
export async function sHubCrashGen(): Promise<void> {
  const clock = createFakeClock(START_MS)
  const kv = createHarnessKV()
  const old = kv.handle('x#1')
  await old.set('k', 'old-1')
  kv.close('x#1', 'crash')
  const now = kv.handle('x#2')
  await now.set('k', 'new-1')
  let finished = false
  void old.set('k', 'old-late').then(() => (finished = true))
  void old.del('k').then(() => (finished = true))
  await clock.settle()
  expect(kv.peek('k') === 'new-1', `a late write of the crashed generation does not reach the store (got ${kv.peek('k')})`)
  expect(!finished, 'it never finishes (the power is off)')
  expect(kv.lateWrites.length === 0, 'and it is not a late write')
  // Only a stopped generation's writes are late writes: they finish at once and are counted.
  kv.close('x#2', 'stop')
  let stopped = false
  await now.set('k', 'stop-late').then(() => (stopped = true))
  expect(stopped && kv.peek('k') === 'new-1' && kv.lateWrites.length === 1, 'a stopped generation: finished, not applied, one late write')
}

/**
 * makePeer's options: tuning.sendRetryMs drives the engine's backoff of a refused
 * send (an empty list: no retry), relays reach the transport, unreadable makes a stored
 * room unreadable from the next start. Each with its control: the same restart without
 * `unreadable` sends through that room and reports it 'ok'.
 */
export async function sHubPeerOpts(): Promise<void> {
  const w = newWorld()
  const relays = ['fake://relay-x', 'fake://relay-y']
  const A = makePeer(w, 'A', { tuning: { sendRetryMs: [100, 100] }, relays })
  const B = makePeer(w, 'B')
  await A.engine.start()
  await B.engine.start()
  expect(
    A.state()
      .relays.map((r) => r.url)
      .join() === relays.join(),
    `relays reach deps and the transport (got ${A.state()
      .relays.map((r) => r.url)
      .join()})`,
  )
  await link(w, A, B)
  await adv(w, 30_000)
  const tries: number[] = []
  w.hub.failSend = (from, _g, msg) => {
    if (from !== A.pk || msg.t !== 'chat') return false
    tries.push(w.clock.now())
    return 'reject'
  }
  await A.a.sendChat(B.pk, 'tuned')
  await adv(w, 10_000)
  const gaps = tries.slice(1).map((x, i) => x - tries[i])
  expect(tries.length === 3 && gaps.every((g) => g === 100), `a refused send is tried 1 + 2 times, 100 ms apart (tries ${tries.length}, gaps ${gaps.join(',')})`)
  w.hub.failSend = () => false

  // sendRetryMs: [] means no retry: the first refusal drops the message.
  const C = makePeer(w, 'C', { tuning: { sendRetryMs: [] } })
  await C.engine.start()
  await link(w, C, B)
  await adv(w, 30_000)
  const triesC: number[] = []
  w.hub.failSend = (from, _g, msg) => {
    if (from !== C.pk || msg.t !== 'chat') return false
    triesC.push(w.clock.now())
    return 'reject'
  }
  await C.a.sendChat(B.pk, 'no-retry')
  await adv(w, 10 * MIN)
  const noRetry = (C.state().rooms[B.pk] ?? []).find((x): x is Extract<ChatMessage, { kind: 'text' }> => x.kind === 'text' && x.text === 'no-retry')
  expect(triesC.length === 1 && noRetry?.status === 'failed', `sendRetryMs []: tried once, then 'failed' (tries ${triesC.length}, status ${noRetry?.status})`)
  w.hub.failSend = () => false

  const roomAB = A.state().contacts.find((c) => c.pubkey === B.pk)?.groupId ?? ''
  const replace = async (old: Peer, name: string, unreadable?: string[]): Promise<Peer> => {
    await old.engine.stop()
    old.kv.close(old.tag, 'stop')
    w.peers.splice(w.peers.indexOf(old), 1)
    old.dead = true
    const next = makePeer(w, name, { kv: old.kv, words: old.words, unreadable })
    await next.engine.start()
    return next
  }
  // The control: the same restart without `unreadable` sends through that room.
  const A1 = await replace(A, 'A1')
  expect(w.hub.health(A1.pk, roomAB) === 'ok', `without unreadable the room is 'ok' (got ${w.hub.health(A1.pk, roomAB)})`)
  await A1.a.sendChat(B.pk, 'into-readable')
  await until(w, () => w.hub.log.some((e) => e.from === A1.pk && textOf(e) === 'into-readable'), MIN, 'the control send goes up')
  const A2 = await replace(A1, 'A2', [roomAB])
  expect(A2.state().boot === 'ready' && hasContact(A2, B), 'with the room unreadable the peer still opens with its contact')
  expect(w.hub.health(A2.pk, roomAB) === 'unreadable', `opts.unreadable: groupHealth reports the room 'unreadable' (got ${w.hub.health(A2.pk, roomAB)})`)
  await A2.a.sendChat(B.pk, 'into-unreadable')
  await adv(w, 3 * MIN)
  expect(!w.hub.log.some((e) => e.from === A2.pk && textOf(e) === 'into-unreadable'), 'opts.unreadable: nothing goes up through that room')
  await finish(w)
}
