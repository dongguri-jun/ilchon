/**
 * Engine check scenarios: delivery (S-DLV, record ids, completion status, resend).
 * Run from scripts/check-engine.ts, which lists every scenario in its order.
 */
import type { ChatMessage } from '../../../src/contracts'
import { tradeView } from '../../../src/engine/trade'
import type { SendFailure } from '../../fake-transport'
import { TOLD, countText, matchedPair, offerViewOf, pair, refuseFrom, roomOf, showsCurrent, statusOf, toldOf } from '../helpers/delivery'
import { dones, groupOf, matched, sentMsgs } from '../helpers/trade'
import { AMOUNT, FEE } from '../markers'
import { Fail, errText, expect } from '../report'
import { BOTH, MIN, type Peer, type World, adv, finish, orderedKeys, powerOff, restart, settled, until } from '../world'

/** The statuses one of x's records goes through, as x's store shows them; returns the unsubscribe. */
function trackStatus(x: Peer, y: Peer, pick: (m: ChatMessage) => boolean, trail: string[]): () => void {
  const look = () => {
    const m = (x.state().rooms[y.pk] ?? []).find(pick)
    const s = m ? (statusOf(m) ?? 'none') : 'absent'
    if (trail[trail.length - 1] !== s) trail.push(s)
  }
  look()
  return x.engine.store.subscribe(look)
}

const myDone = (m: ChatMessage) => m.kind === 'done' && m.mine

/** Every done of A in its room with B gets `fate()` from the relay (false: goes through). */
function doneFate(w: World, A: Peer, B: Peer, fate: () => SendFailure, tries?: number[]): void {
  const g = groupOf(A, B)
  w.hub.failSend = (from, groupId, msg) => {
    if (from !== A.pk || groupId !== g || msg.t !== 'done') return false
    tries?.push(w.clock.now())
    return fate()
  }
}

/** B holds exactly A's completions: each of A's records once, under its id and amount, and nothing else. */
function expectDonesAgree(A: Peer, B: Peer, at = ''): void {
  const mine = dones(A, B, true)
  const theirs = dones(B, A, false)
  const ids = theirs.map((m) => m.id)
  expect(new Set(ids).size === ids.length, `${at}B holds each completion of A once (${ids.length} records, ${new Set(ids).size} ids)`)
  expect(
    mine.length === theirs.length && mine.every((m) => theirs.some((x) => x.id === m.id && x.amountMinor === m.amountMinor && x.currency === m.currency)),
    `${at}B's completions of A are exactly A's records (A ${mine.map((m) => m.amountMinor).join(',')}, B ${theirs.map((m) => m.amountMinor).join(',')})`,
  )
}

/** S-DLV-11: A's done is refused, A restarts, the refusal ends: 'sending', 'failed', then 'sent' by itself; B holds it once. */
export async function sDlv11(): Promise<void> {
  const { w, A, B } = await matchedPair()
  let refuse = true
  refuseFrom(w, A, B, () => refuse)
  const trail: string[] = []
  let un = trackStatus(A, B, myDone, trail)
  await A.a.markDone(B.pk, 30_000)
  const rec = dones(A, B, true)[0]
  expect(statusOf(rec) === 'sending', `right after markDone the record is 'sending' (${statusOf(rec)})`)
  await adv(w, 5_000)
  expect(trail.includes('failed'), `the retries ran out: 'failed' (${trail.join(' > ')})`)
  expect(dones(B, A, false).length === 0, 'nothing reached B while refused')
  un()
  await restart(A)
  un = trackStatus(A, B, myDone, trail)
  await adv(w, 5_000)
  expect(statusOf(dones(A, B, true)[0]) !== 'sent', 'after the restart, still refused: not sent')
  refuse = false
  await until(w, () => statusOf(dones(A, B, true)[0]) === 'sent', 15 * MIN, "A's record turns 'sent' by itself")
  un()
  expect(trail[1] === 'sending' && trail.at(-1) === 'sent', `the trail starts 'sending' and ends 'sent' (${trail.join(' > ')})`)
  await adv(w, 5_000)
  expectDonesAgree(A, B)
  expect(dones(B, A, false)[0]?.id === rec.id, 'under the id of the record')
  expect(A.state().myOffer?.amountMinor === AMOUNT - 30_000, `A's open amount was cut once (${A.state().myOffer?.amountMinor})`)
  await until(w, () => showsCurrent(B, A), 5 * MIN, "B sees A's open amount")
  await finish(w)
}

/**
 * S-DLV-12: the relay takes every done of A but A hears a refusal ('timeout'): the record
 * goes 'failed', the resends go up again and again (also after a restart), and once the
 * relay answers, 'sent'. B holds it once, its trade view has it pending once, A's amount
 * was cut once.
 */
export async function sDlv12(): Promise<void> {
  const { w, A, B } = await matchedPair()
  let timeout = true
  doneFate(w, A, B, () => (timeout ? 'timeout' : false))
  await A.a.markDone(B.pk, 30_000)
  await until(w, () => statusOf(dones(A, B, true)[0]) === 'failed', MIN, "A's record turns 'failed'")
  const id = dones(A, B, true)[0].id
  await adv(w, 10_000)
  await restart(A)
  await adv(w, 3_000)
  timeout = false
  await until(w, () => statusOf(dones(A, B, true)[0]) === 'sent', 15 * MIN, "A's record turns 'sent'")
  await adv(w, 5_000)
  const ups = sentMsgs(w, A, B, 'done').filter((m) => m.t === 'done' && m.id === id).length
  expect(ups >= 4, `the same completion went up again and again, also after the restart (${ups})`)
  expect(
    sentMsgs(w, A, B, 'done').every((m) => m.t === 'done' && m.id === id),
    'every upload carries the one record id',
  )
  expectDonesAgree(A, B)
  expect(dones(A, B, true).length === 1, 'A has one record')
  const pending = tradeView(B.state(), A.pk, w.clock.now()).pendingDone
  expect(pending.length === 1 && pending[0].amountMinor === 30_000, `B's trade view has it pending once (${pending.length})`)
  expect(A.state().myOffer?.amountMinor === AMOUNT - 30_000, `A's open amount was cut once (${A.state().myOffer?.amountMinor})`)
  await finish(w)
}

/** S-DLV-13: both mark their whole amount done at once: no match, no told, each room one done of each side. */
export async function sDlv13(): Promise<void> {
  const { w, A, B } = await matchedPair()
  await Promise.all([A.a.markDone(B.pk, AMOUNT), B.a.markDone(A.pk, 90_000)])
  await adv(w, MIN)
  for (const [x, y] of [
    [A, B],
    [B, A],
  ] as const) {
    expect(x.state().myOffer === null, `${x.name}'s offer is withdrawn`)
    expect(!matched(x, y), `${x.name} no longer shows ${y.name}`)
    expect(Object.keys(toldOf(x)).length === 0, `${x.name}'s stored told is empty (${Object.keys(toldOf(x)).length})`)
    const mine = dones(x, y, true)
    expect(mine.length === 1 && dones(x, y, false).length === 1, `${x.name}'s room has one done of each side (${mine.length}, ${dones(x, y, false).length})`)
    expect(statusOf(mine[0]) === 'sent', `${x.name}'s record is 'sent' (${statusOf(mine[0])})`)
    expectDonesAgree(x, y, `${x.name}: `)
  }
  await finish(w)
}

/**
 * S-DLV-17: a chat the relay took but A heard refused ('timeout') is 'failed' and stays so:
 * no timer, return to the app or restart sends it (texts are re-sent by the user only).
 * retryChat sends it under the same id: B shows it once.
 */
export async function sDlv17(): Promise<void> {
  const { w, A, B } = await pair({ a: { tuning: TOLD } })
  const g = groupOf(A, B)
  let timeout = true
  w.hub.failSend = (from, groupId, msg) => (timeout && from === A.pk && groupId === g && msg.t === 'chat' ? 'timeout' : false)
  const TEXT = 'dlv-17'
  const mine = () => roomOf(A, B).find((m) => m.kind === 'text' && m.mine && m.text === TEXT)
  const ups = () => sentMsgs(w, A, B, 'chat').filter((m) => m.t === 'chat' && m.text === TEXT)
  await A.a.sendChat(B.pk, TEXT)
  await until(w, () => statusOf(mine()) === 'failed', MIN, "A's chat turns 'failed'")
  expect(countText(B, A, TEXT) === 1, 'the relay took it: B shows it once')
  const before = ups().length
  A.engine.rearmRounds()
  await adv(w, 10 * MIN)
  await restart(A)
  await adv(w, 2 * MIN)
  expect(statusOf(mine()) === 'failed', `still 'failed': never re-sent by itself (${statusOf(mine())})`)
  expect(ups().length === before, `no upload of it without the user (${before} -> ${ups().length})`)
  timeout = false
  await A.a.retryChat(B.pk, mine()!.id)
  await until(w, () => statusOf(mine()) === 'sent', MIN, "A's chat turns 'sent'")
  await adv(w, 5_000)
  expect(ups().length > before, 'the retry went up')
  expect(
    ups().every((m) => m.t === 'chat' && m.id === mine()!.id),
    'every upload carries the record id',
  )
  expect(countText(B, A, TEXT) === 1, `B shows it once after the retry (${countText(B, A, TEXT)})`)
  const theirs = roomOf(B, A).find((m) => m.kind === 'text' && m.text === TEXT)
  expect(theirs?.id === mine()!.id, "B keeps it under A's record id")
  await finish(w)
}

/** S-DLV-20: a chat or done without a well-formed record id is thrown away by the parser; a good one goes in under its id. */
export async function sDlv20(): Promise<void> {
  const { w, A, B } = await pair()
  const g = groupOf(A, B)
  const before = w.hub.unparsed.length
  const bad: Record<string, unknown>[] = [
    { t: 'chat', text: 'dlv20-none' },
    { t: 'chat', id: 'abc', text: 'dlv20-short' },
    { t: 'chat', id: 'A'.repeat(32), text: 'dlv20-upper' },
    { t: 'chat', id: 'g'.repeat(32), text: 'dlv20-nonhex' },
    { t: 'chat', id: 'a'.repeat(33), text: 'dlv20-long' },
    { t: 'chat', id: 7, text: 'dlv20-number' },
    { t: 'done', amountMinor: 1000, currency: 'KRW' },
    { t: 'done', id: 'B'.repeat(32), amountMinor: 1001, currency: 'KRW' },
    { t: 'done', id: 'a'.repeat(31), amountMinor: 1002, currency: 'KRW' },
  ]
  for (const b of bad) w.hub.inject(A.pk, g, JSON.stringify(b))
  await adv(w, 5_000)
  expect(w.hub.unparsed.length - before === bad.length, `the parser threw all ${bad.length} away (${w.hub.unparsed.length - before})`)
  expect(!roomOf(B, A).some((m) => m.kind === 'text' && m.text.startsWith('dlv20')), "no such chat in B's room")
  expect(dones(B, A, false).length === 0, "no such done in B's room")
  // Positive control: the same shape with a good id goes in, under that id.
  const ID = 'c'.repeat(32)
  w.hub.inject(A.pk, g, JSON.stringify({ t: 'chat', id: ID, text: 'dlv20-ok' }))
  await adv(w, 5_000)
  expect(countText(B, A, 'dlv20-ok') === 1 && roomOf(B, A).some((m) => m.kind === 'text' && m.text === 'dlv20-ok' && m.id === ID), 'a well-formed one goes in under its id')
  await finish(w)
}

/**
 * S-DLV-DONE-DUP: resends that overlap. While A's completion keeps failing (taken by the
 * relay, heard refused), three resend triggers at the same instant send it once; a restart
 * and a trigger right after it too. B holds it once and its amount once; A cut its amount once.
 */
export async function sDlvDoneDup(): Promise<void> {
  const { w, A, B } = await matchedPair()
  let fate: SendFailure = 'reject'
  const tries: number[] = []
  doneFate(w, A, B, () => fate, tries)
  await A.a.markDone(B.pk, 30_000)
  const failed = () => statusOf(dones(A, B, true)[0]) === 'failed'
  await until(w, failed, MIN, "A's record turns 'failed'")
  fate = 'timeout'
  const burst = async (what: string, before?: () => Promise<void>) => {
    await until(w, failed, 5 * MIN, `${what}: 'failed' again`)
    await before?.()
    const t0 = w.clock.now()
    const n0 = tries.length
    for (let i = 0; i < 3; i++) A.engine.rearmRounds()
    await adv(w, 50)
    const first = tries.slice(n0).filter((t) => t < t0 + 50).length
    expect(first === 1, `${what}: three resend triggers at once sent the record once (${first})`)
  }
  for (let round = 1; round <= 3; round++) await burst(`burst ${round}`)
  await burst('after a restart', () => restart(A))
  fate = false
  await until(w, () => statusOf(dones(A, B, true)[0]) === 'sent', 15 * MIN, "A's record turns 'sent'")
  await adv(w, 5_000)
  const id = dones(A, B, true)[0].id
  const ups = sentMsgs(w, A, B, 'done').filter((m) => m.t === 'done' && m.id === id).length
  expect(ups >= 4, `the relay got it several times (${ups})`)
  expectDonesAgree(A, B)
  expect(tradeView(B.state(), A.pk, w.clock.now()).pendingDone.length === 1, "B's trade view has it pending once")
  expect(A.state().myOffer?.amountMinor === AMOUNT - 30_000, `A's open amount was cut once (${A.state().myOffer?.amountMinor})`)
  await finish(w)
}

/**
 * S-DLV-DONE-SWEEP: the sending side's power goes off before each of A's writes in turn
 * (n = 0..N-1; at n = N the power stays on and the flow writes exactly N times, as the
 * base run). The flow: a completion refused by the relay ('failed', resent by the timer),
 * then taken but heard refused ('timeout', resends overlap at B), then let through; a chat;
 * the rest of the amount done. At the crash the flow ends and A starts again with the relay
 * letting everything through. 10 minutes later: every completion record of A is 'sent' and
 * B holds exactly those, once each; A's open amount is the offer less its records, once;
 * B shows nothing of A or A's current offer; a chat A's record still shows 'failed' was not
 * re-sent by itself; inboxes empty, no late writes, no task error.
 */
const SWEEP_OFFER = 100_000
const SWEEP_CHAT = 'done-sweep'

async function doneRun(keys: { words: string }[], crashAt: number | null): Promise<{ w: World; A: Peer; B: Peer; writes: number; crashed: boolean }> {
  const { w, A, B } = await pair({ keys, a: { tuning: TOLD }, b: { tuning: TOLD } })
  await B.a.postOffer({ side: 'sell', currency: 'KRW', amountMinor: 90_000, feePct: 3, methods: BOTH })
  await until(w, () => settled(B), 5 * MIN, "B's rounds")
  await A.a.postOffer({ side: 'buy', currency: 'KRW', amountMinor: SWEEP_OFFER, feePct: FEE, methods: BOTH })
  await until(w, () => matched(A, B) && matched(B, A), 5 * MIN, 'A and B match')
  await adv(w, 30_000)
  let fate: SendFailure = false
  doneFate(w, A, B, () => fate)
  const armed = A.kv.writes.length
  let crashed = false
  const crashP =
    crashAt === null
      ? new Promise<void>(() => {})
      : A.kv.crashAfter(crashAt).then(() => {
          crashed = true
          powerOff(A)
        })
  const act = (run: () => Promise<unknown>) => async () => {
    await Promise.race([run().catch(() => {}), crashP])
  }
  const pause = (ms: number) => () => adv(w, ms)
  const steps: (() => Promise<void> | void)[] = [
    () => void (fate = 'reject'),
    act(() => A.a.markDone(B.pk, 30_000)),
    pause(3_000),
    () => void (fate = 'timeout'),
    pause(4_000),
    () => void (fate = false),
    pause(10_000),
    act(() => A.a.sendChat(B.pk, SWEEP_CHAT)),
    pause(5_000),
    act(() => A.a.markDone(B.pk, 70_000)),
    pause(10_000),
  ]
  for (const step of steps) {
    await step()
    await w.clock.settle()
    if (crashed) break
  }
  fate = false
  return { w, A, B, writes: A.kv.writes.length - armed, crashed }
}

export async function sDlvDoneSweep(): Promise<void> {
  const keys = orderedKeys(2)
  const base = await doneRun(keys, null)
  const total = base.writes
  expect(total > 10, `the flow writes on A (${total})`)
  expect(base.A.state().myOffer === null && dones(base.A, base.B, true).length === 2, 'base run: two completions, the offer gone')
  expect(
    dones(base.A, base.B, true).every((m) => statusOf(m) === 'sent'),
    "base run: both records 'sent'",
  )
  expectDonesAgree(base.A, base.B, 'base run: ')
  await finish(base.w)
  for (let n = 0; n <= total; n++) {
    const r = await doneRun(keys, n)
    const at = `crash before A's write ${n + 1}/${total}`
    if (n === total) {
      expect(!r.crashed && r.writes === total, `${at}: the flow wrote as often as the base run (${r.writes} of ${total}, crashed ${r.crashed})`)
      await finish(r.w)
      break
    }
    // A sweep step whose power never went off would test nothing.
    expect(r.crashed, `${at}: the power went off during the flow`)
    const { w, A, B } = r
    // Every chat upload of A from here on would be an automatic re-send: the flow sends its
    // one chat before the crash and the user sends nothing after the start. Counted by the
    // hub's log position, not its time: the flow's own upload can carry the crash's instant.
    const logAtRestart = w.hub.log.length
    A.spawn()
    try {
      await A.engine.start()
      await adv(w, 10 * MIN)
    } catch (e) {
      throw new Fail(`${at}: ${errText(e)}`)
    }
    expect(A.state().boot === 'ready', `${at}: A is ready`)
    const errors = A.events.filter((e) => e.tag === A.tag && e.event === 'task-error')
    expect(errors.length === 0, `${at}: no task error (${JSON.stringify(errors[0]?.info)})`)
    const mine = dones(A, B, true)
    expect(
      mine.every((m) => statusOf(m) === 'sent'),
      `${at}: every completion record of A is 'sent' (${mine.map((m) => statusOf(m)).join(',')})`,
    )
    expectDonesAgree(A, B, `${at}: `)
    const used = mine.reduce((s, m) => s + m.amountMinor, 0)
    const cur = A.state().myOffer
    expect(
      used === SWEEP_OFFER ? cur === null : cur?.amountMinor === SWEEP_OFFER - used,
      `${at}: A's open amount is the offer less its records, once (records ${used}, open ${cur?.amountMinor ?? 'none'})`,
    )
    const view = offerViewOf(B, A)
    expect(!view || showsCurrent(B, A), `${at}: B shows nothing of A or A's current offer (B ${view?.amountMinor}, A ${cur?.amountMinor})`)
    if (!cur) expect(!view, `${at}: B shows nothing once A has no offer`)
    const chat = roomOf(A, B).find((m) => m.kind === 'text' && m.mine && m.text === SWEEP_CHAT)
    const onB = countText(B, A, SWEEP_CHAT)
    expect(onB <= 1, `${at}: B shows the chat at most once (${onB})`)
    if (statusOf(chat) === 'sent') expect(onB === 1, `${at}: a chat A shows 'sent' is on B`)
    expect(statusOf(chat) !== 'sending', `${at}: no chat is left 'sending' (a failed one waits for the user)`)
    const chatsAfter = w.hub.log.slice(logAtRestart).filter((e) => e.from === A.pk && e.t === 'chat').length
    expect(chatsAfter === 0, `${at}: A re-sent no chat by itself after the start (${chatsAfter} uploads; A's record ${statusOf(chat) ?? 'none'})`)
    const uploads = chat ? w.hub.log.filter((e) => e.from === A.pk && e.t === 'chat' && e.json.includes(chat.id)).length : 0
    expect(uploads <= 1, `${at}: A's chat record went up at most once, by the flow's own send (${uploads})`)
    expect(w.hub.inbox(A.pk).length === 0 && w.hub.inbox(B.pk).length === 0, `${at}: the inboxes are empty`)
    try {
      await finish(w)
    } catch (e) {
      throw new Fail(`${at}: ${errText(e)}`)
    }
  }
}
