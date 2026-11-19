/**
 * Engine check scenarios: stop, settings and boot (S-STOP-*, S-SETTINGS-SAVE-FAIL, S-BOOT-*).
 * Run from scripts/check-engine.ts, which lists every scenario in its order.
 */
import type { Offer } from '../../../src/contracts'
import { AMOUNT, FEE } from '../markers'
import { Fail, expect } from '../report'
import { BOTH, MIN, type Peer, START_MS, adv, finish, hasContact, link, makePeer, newWorld, orderedKeys, restart, until } from '../world'

// ---------------------------------------------------------------- S-STOP-WRITE, S-STOP-START

export async function sStopWrite(): Promise<void> {
  const w = newWorld()
  const [lo, hi] = orderedKeys(2)
  const A = makePeer(w, 'A', { words: lo.words })
  const B = makePeer(w, 'B', { words: hi.words })
  await A.engine.start()
  await B.engine.start()
  let first = true
  w.hub.failInvite = () => {
    const f = first
    first = false
    return f
  }
  B.a.startConnect()
  A.a.startConnect()
  const scan = A.a.submitScan(B.state().connect.myPayload ?? '')
  // The first invite fails after 30 ms; A now waits 1.5 s before the retry.
  await adv(w, 500)
  expect(
    A.events.some((e) => e.event === 'invite-retry'),
    'A is waiting to retry the invite',
  )
  const before = JSON.stringify(A.kv.peek('scans'))
  expect(before.includes(B.pk), 'the scan of B is stored')
  await restart(A)
  await adv(w, 2_000)
  await scan
  expect(A.kv.lateWrites.length === 0, `the stopped engine wrote nothing (${A.kv.lateWrites.map((x) => x.key).join(', ')})`)
  expect(JSON.stringify(A.kv.peek('scans')) === before, 'the new engine still has the scan from before the restart')
  await finish(w)
}

/**
 * S-SETTINGS-SAVE-FAIL: the settings write fails. setSettings rejects with
 * 'save-failed' (the relay screen then shows relayErrSave and does not reload), the
 * state keeps the stored relays, and a later save of another setting (the language)
 * does not store the relays that never were.
 */
export async function sSettingsSaveFail(): Promise<void> {
  const w = newWorld()
  const A = makePeer(w, 'A')
  await A.engine.start()
  expect(A.state().boot === 'ready', 'A is ready')
  const mine = ['wss://relay-one.example.com', 'wss://relay-two.example.com']
  const storedBefore = JSON.stringify(A.kv.peek<{ relays?: unknown }>('settings')?.relays ?? null)
  A.kv.failNext('settings')
  let code = ''
  try {
    await A.a.setSettings({ relays: mine, relayAuto: false })
  } catch (e) {
    code = e instanceof Error ? e.message : String(e)
  }
  expect(code === 'save-failed', `setSettings rejects when the write fails (${code || 'resolved'})`)
  expect(A.state().settings.relays === null && A.state().settings.relayAuto === true, `the state keeps the stored relays (${JSON.stringify(A.state().settings)})`)
  await A.a.setSettings({ lang: 'ko' })
  const stored = A.kv.peek<{ relays?: unknown; relayAuto?: unknown; lang?: unknown }>('settings')
  expect(stored?.lang === 'ko', `the next setting is stored (${JSON.stringify(stored)})`)
  expect(JSON.stringify(stored?.relays ?? null) === storedBefore && stored?.relayAuto !== false, `the failed relay list was not stored with it (${JSON.stringify(stored)})`)
  // A write that works: stored, and the state shows it.
  await A.a.setSettings({ relays: mine })
  expect(JSON.stringify(A.kv.peek<{ relays?: unknown }>('settings')?.relays) === JSON.stringify(mine), 'a write that works stores the relays')
  await finish(w)
}

export async function sStopStart(): Promise<void> {
  const w = newWorld()
  const A = makePeer(w, 'A')
  const B = makePeer(w, 'B')
  await A.engine.start()
  await B.engine.start()
  await link(w, A, B)
  await A.engine.stop()
  await A.engine.start()
  expect(A.state().boot === 'ready', 'A is ready again')
  await A.a.postOffer({ side: 'buy', currency: 'KRW', amountMinor: AMOUNT, feePct: FEE, methods: BOTH })
  await adv(w, 10_000)
  const stored = A.kv.peek<Offer>('offer')
  expect(!!stored && stored.amountMinor === AMOUNT && stored.id === A.state().myOffer?.id, 'the offer posted after stop() and start() is stored')
  await finish(w)
}

// ---------------------------------------------------------------- S-BOOT

type Confirms = Record<string, { resends?: number }>

/** The peer of a linked pair that keeps a pending confirmation (the inviter), and the other. */
function confirmHolder(A: Peer, B: Peer): [Peer, Peer] {
  const has = (p: Peer) => Object.keys(p.kv.peek<Confirms>('confirms') ?? {}).length > 0
  if (has(A)) return [A, B]
  if (has(B)) return [B, A]
  throw new Fail('neither peer keeps a pending confirmation after the link')
}

/**
 * S-BOOT-WAIT: a peer that starts while its network is down stays in boot 'starting'
 * (never 'error') for as long as it lasts, resends nothing meanwhile, and becomes ready
 * once the network is back, running resumeAfterBoot exactly once.
 */
export async function sBootWait(): Promise<void> {
  const w = newWorld()
  const A0 = makePeer(w, 'A')
  const B0 = makePeer(w, 'B')
  await A0.engine.start()
  await B0.engine.start()
  await link(w, A0, B0)
  const [X] = confirmHolder(A0, B0)
  await X.engine.stop()
  X.kv.close(X.tag, 'stop')
  X.spawn()
  w.hub.setNetwork(X.pk, 'down')
  const before = JSON.stringify(X.kv.peek<Confirms>('confirms'))
  let boots: string[] = []
  const un = X.engine.store.subscribe((st) => boots.push(st.boot))
  let result: string | null = null
  void X.engine.start().then(
    () => (result = 'ok'),
    (e: Error) => (result = e.message),
  )
  await adv(w, 10 * MIN)
  expect(X.state().boot === 'starting', `boot stays 'starting' while down (got ${X.state().boot})`)
  expect(!boots.includes('error') && result === null, 'no boot error and start() still waiting after 10 minutes')
  expect(X.state().relays.length > 0 && X.state().relays.every((r) => !r.connected), 'the relays are known and none is connected')
  expect(JSON.stringify(X.kv.peek<Confirms>('confirms')) === before, 'no confirmation resend while down')
  const resendsBefore = Object.values(X.kv.peek<Confirms>('confirms') ?? {}).map((c) => c.resends ?? 0)
  w.hub.setNetwork(X.pk, 'up')
  await until(w, () => X.state().boot === 'ready', MIN, 'ready once up')
  await adv(w, 30_000)
  const resendsAfter = Object.values(X.kv.peek<Confirms>('confirms') ?? {}).map((c) => c.resends ?? 0)
  expect(
    resendsAfter.length === resendsBefore.length && resendsAfter.every((n, i) => n === resendsBefore[i] + 1),
    `resumeAfterBoot ran once after 'up' (resends ${resendsBefore.join(',')} -> ${resendsAfter.join(',')})`,
  )
  expect(result === 'ok' && !boots.includes('error'), 'start() resolved, never an error')
  un()
  boots = []
  await finish(w)
}

/** S-BOOT-STOP: stop() while waiting for the network does not turn boot into 'error'. */
export async function sBootStop(): Promise<void> {
  const w = newWorld()
  const A = makePeer(w, 'A')
  w.hub.setNetwork(A.pk, 'down')
  const boots: string[] = []
  const un = A.engine.store.subscribe((st) => boots.push(st.boot))
  let result: string | null = null
  void A.engine.start().then(
    () => (result = 'ok'),
    (e: Error) => (result = e.message),
  )
  await adv(w, MIN)
  expect(A.state().boot === 'starting', `starting while down (got ${A.state().boot})`)
  await A.engine.stop()
  await adv(w, 1000)
  expect(!boots.includes('error') && A.state().boot !== 'error', `stop() while waiting: no boot error (boots: ${[...new Set(boots)].join(',')})`)
  expect(result !== null && result !== 'ok', `start() was rejected and the rejection was caught (got '${result}')`)
  un()
  await finish(w)
}

/**
 * S-BOOT-RECONNECT: A's relays drop for 30 s and come back. A's engine runs
 * onReconnected exactly once (2.5 s after), a chat sent while down is refused by the
 * transport and still reaches B after 'up'.
 */
export async function sBootReconnect(): Promise<void> {
  const w = newWorld()
  const A = makePeer(w, 'A')
  const B = makePeer(w, 'B')
  await A.engine.start()
  await B.engine.start()
  await link(w, A, B)
  await adv(w, 30_000)
  const reconnects = () => A.events.filter((e) => e.event === 'reconnected').length
  const r0 = reconnects()
  const failedBefore = A.events.filter((e) => e.event === 'tx-failed').length
  w.hub.setNetwork(A.pk, 'down')
  await adv(w, 1000)
  await A.a.sendChat(B.pk, 'while-down-1')
  await adv(w, 29_000)
  expect(A.events.filter((e) => e.event === 'tx-failed').length > failedBefore, 'a send while down was refused by the transport')
  expect(!(B.state().rooms[A.pk] ?? []).some((x) => x.kind === 'text' && x.text === 'while-down-1'), 'nothing reached B while A was down')
  w.hub.setNetwork(A.pk, 'up')
  await adv(w, 3_000)
  expect(reconnects() - r0 === 1, `onReconnected ran once (got ${reconnects() - r0})`)
  await until(w, () => (B.state().rooms[A.pk] ?? []).some((x) => x.kind === 'text' && x.text === 'while-down-1'), 2 * MIN, 'the chat sent while down reaches B')
  await adv(w, 30_000)
  expect(reconnects() - r0 === 1, 'and only once')
  expect(A.dumpLog().includes('relay  reconnected'), 'the support log has the reconnect line')
  await finish(w)
}

/**
 * S-BOOT-ROOM: one room's stored state cannot be read. A still opens,
 * keeps both contacts, and the other room works as before; the broken room carries
 * nothing (the transport refuses with 'group-unreadable' before anything is sent).
 */
export async function sBootRoom(): Promise<void> {
  const w = newWorld()
  const A = makePeer(w, 'A')
  const B = makePeer(w, 'B')
  const C = makePeer(w, 'C')
  for (const p of [A, B, C]) await p.engine.start()
  await link(w, A, B)
  await link(w, A, C)
  const roomAB = A.state().contacts.find((c) => c.pubkey === B.pk)?.groupId ?? ''
  expect(roomAB !== '', 'A has a room with B')
  w.hub.unreadable(A.pk, roomAB)
  await restart(A)
  expect(A.state().boot === 'ready', `A opens with one unreadable room (got ${A.state().boot})`)
  expect(hasContact(A, B) && hasContact(A, C), 'A keeps both contacts')
  await A.a.sendChat(C.pk, 'to-c-after-restart')
  await A.a.sendChat(B.pk, 'to-b-unreadable')
  await until(w, () => (C.state().rooms[A.pk] ?? []).some((x) => x.kind === 'text' && x.text === 'to-c-after-restart'), MIN, 'the readable room works')
  await adv(w, 3 * MIN)
  expect(!(B.state().rooms[A.pk] ?? []).some((x) => x.kind === 'text' && x.text === 'to-b-unreadable'), 'nothing goes through the unreadable room')
  expect(!w.hub.log.some((e) => e.from === A.pk && e.groupId === roomAB && e.atMs > START_MS && e.t === 'chat'), 'no chat was uploaded to the unreadable room')
  await finish(w)
}
