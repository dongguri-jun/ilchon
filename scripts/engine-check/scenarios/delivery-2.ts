/**
 * Engine check scenarios: delivery (S-DLV, receiving).
 * Run from scripts/check-engine.ts, which lists every scenario in its order.
 */
import type { ChatMessage, EngineDeps } from '../../../src/contracts'
import { pubkeyOf, randomHex } from '../../../src/lib/marmot/keys'
import { matchCrypto } from '../../../src/lib/match'
import type { Envelope } from '../../fake-transport'
import { countText, pair, roomOf, verifiedOf } from '../helpers/delivery'
import { rejectsWith } from '../helpers/recovery'
import { groupOf, matched } from '../helpers/trade'
import { AMOUNT, CHAT, FEE, dumpOf } from '../markers'
import { Fail, errText, expect } from '../report'
import { BOTH, MIN, type Peer, type World, adv, deleteContact, finish, link, makePeer, newWorld, orderedKeys, peerOf, powerOff, restart, sent, settled, until } from '../world'

// ---------------------------------------------------------------- S-DLV

const SHORT: EngineDeps['tuning'] = { sendRetryMs: [100, 100] }

/** S-DLV-3: B's power goes off while it handles a chat and a done; both come back once, in order. */
export async function sDlv3(): Promise<void> {
  const { w, A, B } = await pair()
  await A.a.postOffer({ side: 'buy', currency: 'KRW', amountMinor: AMOUNT, feePct: FEE, methods: BOTH })
  await adv(w, 30_000)
  void B.kv.crashAfter(0).then(() => powerOff(B))
  await A.a.sendChat(B.pk, 'x')
  await A.a.markDone(B.pk, 10_000)
  await adv(w, 5_000)
  expect(B.dead, 'B went off at its first write for the chat')
  expect(w.hub.inbox(B.pk).length >= 1, 'what B got is in its inbox')
  B.spawn()
  await B.engine.start()
  await adv(w, MIN)
  const check = (when: string) => {
    const room = roomOf(B, A)
    const xs = room.filter((m) => m.kind === 'text' && m.text === 'x')
    const dones = room.filter((m) => m.kind === 'done' && !m.mine)
    expect(xs.length === 1 && dones.length === 1, `${when}: one chat and one done (got ${xs.length}, ${dones.length})`)
    expect(room.indexOf(xs[0]) < room.indexOf(dones[0]), `${when}: in the order they were sent`)
    expect(w.hub.inbox(B.pk).length === 0, `${when}: B's inbox is empty (${w.hub.inbox(B.pk).length})`)
  }
  check('after the crash')
  await restart(B)
  await adv(w, MIN)
  check('after one more restart')
  await finish(w)
}

/**
 * S-RELOCK-INBOX: the auto-lock reload is the power-off
 * path. While locked nothing of A is in memory and nothing is handled; a message that
 * arrives then, and one that was being handled at the reload, are handled once after the
 * unlock. The draft comes back with the unlock.
 */
export async function sRelockInbox(): Promise<void> {
  const PIN = '135790'
  const w = newWorld()
  const A = makePeer(w, 'A', { pin: PIN })
  const B = makePeer(w, 'B')
  await A.engine.start()
  expect(A.state().boot === 'locked' && A.state().lock.method === 'pin', `A boots locked (${A.state().boot})`)
  await A.a.unlock(PIN)
  await B.engine.start()
  await link(w, A, B)
  await adv(w, 30_000)
  A.engine.memo.set(`draft:${B.pk}`, 'half a line')
  await adv(w, 1_000)

  // A message is being handled when the page reloads (A's first write for it).
  void A.kv.crashAfter(0).then(() => powerOff(A))
  await B.a.sendChat(A.pk, 'in hand at the relock')
  await adv(w, 5_000)
  expect(A.dead, 'A went off while handling the chat')
  A.spawn()
  await A.engine.start()
  const locked = A.state()
  expect(locked.boot === 'locked', `after the reload A is locked (${locked.boot})`)
  expect(locked.contacts.length === 0 && Object.keys(locked.rooms).length === 0 && locked.me === null, 'locked: no contact, chat or key in memory')
  expect(A.engine.memo.get(`draft:${B.pk}`) === undefined, 'locked: the draft is not readable')
  // The chat in hand at the relock is not lost while locked: it waits in A's stored inbox.
  expect(
    w.hub.inboxEntries(A.pk).some((e) => JSON.stringify(e).includes('in hand at the relock')),
    `locked: the chat in hand at the relock waits in A's stored inbox (${w.hub.inbox(A.pk).length} entries)`,
  )

  // More arrives while A is locked; nothing is handled until the unlock.
  await B.a.sendChat(A.pk, 'sent while A was locked')
  await adv(w, 5 * MIN)
  expect(A.state().boot === 'locked' && Object.keys(A.state().rooms).length === 0, 'still locked, nothing handled')
  await rejectsWith(A.a.unlock('000001'), 'wrong-pin', 'a wrong PIN does not open it')

  await A.a.unlock(PIN)
  const texts = () =>
    roomOf(A, B)
      .filter((m) => m.kind === 'text' && !m.mine)
      .map((m) => (m.kind === 'text' ? m.text : ''))
  await until(w, () => texts().includes('sent while A was locked') && texts().includes('in hand at the relock'), 5 * MIN, 'A handles both chats after the unlock')
  await adv(w, MIN)
  const got = texts()
  expect(got.filter((t) => t === 'in hand at the relock').length === 1, `the chat in hand at the relock, once (${got.join(' | ')})`)
  expect(got.filter((t) => t === 'sent while A was locked').length === 1, `the chat sent while locked, once (${got.join(' | ')})`)
  expect(got.indexOf('in hand at the relock') < got.indexOf('sent while A was locked'), 'in the order they were sent')
  expect(w.hub.inbox(A.pk).length === 0, `A's inbox is empty (${w.hub.inbox(A.pk).length})`)
  expect(A.engine.memo.get(`draft:${B.pk}`) === 'half a line', 'the draft is back after the unlock')
  await finish(w)
}

/** S-DLV-4: the same round 1 again after the window: no second answer, no refusal, both match. */
export async function sDlv4(): Promise<void> {
  const { w, A, B } = await pair()
  await B.a.postOffer({ side: 'sell', currency: 'KRW', amountMinor: 90_000, feePct: 3, methods: BOTH })
  await until(w, () => settled(B), 5 * MIN, "B's rounds")
  await adv(w, 30_000)
  let first: Envelope | null = null
  w.publishHooks.push((e) => {
    if (!first && !e.injected && e.from === A.pk && e.t === 'm1') first = e
  })
  let hold = true
  w.hub.route = (e) => (hold && e.from === B.pk && e.t === 'm2' ? 'hold' : 'deliver')
  await A.a.postOffer({ side: 'buy', currency: 'KRW', amountMinor: AMOUNT, feePct: FEE, methods: BOTH })
  await until(w, () => first !== null, MIN, "A's round 1")
  const m1 = first as unknown as Envelope
  const t0 = m1.atMs
  await adv(w, t0 + 20 + 1_200 - w.clock.now())
  w.hub.inject(A.pk, m1.groupId, m1.json)
  await adv(w, t0 + 1_500 - w.clock.now())
  hold = false
  w.hub.release()
  w.hub.route = () => 'deliver'
  await until(w, () => matched(A, B) && matched(B, A), 2 * MIN, 'A and B match')
  const sid = (JSON.parse(m1.json) as { sid: string }).sid
  const of = (t: string) => sent(w, B, A, t).filter((e) => (JSON.parse(e.json) as { sid?: string }).sid === sid).length
  expect(of('m2') === 1 && of('mx') === 0, `B answered that sid once (m2 ${of('m2')}, mx ${of('mx')})`)
  await finish(w)
}

/** S-DLV-9b: a contact that never finishes a round sends it again; kept or deleted, A behaves the same. */
export async function sDlv9b(): Promise<void> {
  const keys = orderedKeys(2)
  const seqs: string[][] = []
  for (const del of [false, true]) {
    const { w, A, B: P } = await pair({ keys })
    const g = groupOf(A, P)
    const sid = randomHex(16)
    const { p } = matchCrypto.round1(matchCrypto.labelsFor({ context: g, myPubkey: P.pk, peerPubkey: A.pk, initiator: P.pk, sid, offer: null }))
    // P's own engine never sees an open round of this sid: it drops A's answer, no m3.
    const t0 = w.clock.now()
    w.hub.inject(P.pk, g, JSON.stringify({ t: 'm1', sid, p }))
    await adv(w, 1_100)
    if (del) {
      w.skip.add('INV-W2')
      await deleteContact(w, A, P)
    }
    await adv(w, 100)
    w.hub.inject(P.pk, g, JSON.stringify({ t: 'm1', sid, p }))
    await adv(w, 30_000)
    const out = sent(w, A, P).filter((e) => e.atMs >= t0)
    seqs.push(out.map((e) => `${e.t}@${e.atMs - t0}:${e.json.length}`))
    const answers = out.filter((e) => e.t === 'm2' && (JSON.parse(e.json) as { sid: string }).sid === sid).length
    expect(answers === 1, `${del ? 'deleted' : 'kept'}: A answers that round 1 once, not the repeat (${answers})`)
    await finish(w)
  }
  expect(seqs[0].join() === seqs[1].join(), `P sees the same from A, kept or deleted (${seqs[0].join(' ')} / ${seqs[1].join(' ')})`)
}

/** S-DLV-14: a send refused after a stop does not block the room of the next start. */
export async function sDlv14(): Promise<void> {
  const { w, A, B } = await pair({ a: { tuning: SHORT } })
  let refuse = true
  w.hub.failSend = (from, _g, msg) => (refuse && from === A.pk && msg.t === 'chat' ? { rejectAfterMs: 500 } : false)
  await A.a.sendChat(B.pk, 'before-stop')
  await adv(w, 100)
  await A.engine.stop()
  await adv(w, 1_000)
  await A.engine.start()
  refuse = false
  await A.a.sendChat(B.pk, 'after-start')
  await until(w, () => countText(B, A, 'after-start') === 1, MIN, 'B gets the chat sent after the start')
  await finish(w)
}

/** S-DLV-15: B's power goes off right after its inbox took a round 1; after the start it answers that sid. */
export async function sDlv15(): Promise<void> {
  const { w, A, B } = await pair()
  await B.a.postOffer({ side: 'sell', currency: 'KRW', amountMinor: 90_000, feePct: 3, methods: BOTH })
  await until(w, () => settled(B), 5 * MIN, "B's rounds")
  await adv(w, 30_000)
  let sid = ''
  w.publishHooks.push((e) => {
    if (!sid && e.from === A.pk && e.t === 'm1') sid = (JSON.parse(e.json) as { sid: string }).sid
  })
  void B.kv.crashAfter(0).then(() => powerOff(B))
  await A.a.postOffer({ side: 'buy', currency: 'KRW', amountMinor: AMOUNT, feePct: FEE, methods: BOTH })
  await until(w, () => B.dead, MIN, 'B goes off handling the round 1')
  expect(w.hub.inbox(B.pk).length === 1, `the round 1 waits in B's inbox (${w.hub.inbox(B.pk).length})`)
  B.spawn()
  await B.engine.start()
  expect(B.state().boot === 'ready', 'B starts')
  await until(w, () => matched(A, B) && matched(B, A), 5 * MIN, 'A and B match')
  expect(
    sent(w, B, A, 'm2').some((e) => (JSON.parse(e.json) as { sid: string }).sid === sid),
    'B answered the very round 1 that was delivered again',
  )
  expect(w.hub.inbox(B.pk).length === 0, "B's inbox is empty")
  await finish(w)
}

/** S-DLV-16: A's power goes off right before it stores the verified match of its own round. */
export async function sDlv16(): Promise<void> {
  const { w, A, B } = await pair()
  await B.a.postOffer({ side: 'sell', currency: 'KRW', amountMinor: 90_000, feePct: 3, methods: BOTH })
  await until(w, () => settled(B), 5 * MIN, "B's rounds")
  await adv(w, 30_000)
  void A.kv.crashWhen((x, v) => x.key === 'verified' && typeof v === 'object' && v !== null && B.pk in v).then(() => powerOff(A))
  await A.a.postOffer({ side: 'buy', currency: 'KRW', amountMinor: AMOUNT, feePct: FEE, methods: BOTH })
  await until(w, () => A.dead, MIN, 'A goes off at the verified write')
  A.spawn()
  await A.engine.start()
  await until(w, () => matched(A, B) && matched(B, A), 5 * MIN, 'A and B match after the restart')
  expect(w.hub.inbox(A.pk).length === 0, "A's inbox is empty")
  await finish(w)
}

/**
 * S-DLV-18 / 18b: B stops while a handler is really running: its answer to A's round 1
 * waits on B's own send (the relays' refusal comes 5 s later). A chat of A waits behind
 * it in the same queue. 18: B stops, the handler ends after the stop, writes nothing, and
 * both messages stay in the inbox; a new engine handles the chat once. 18b: the same engine
 * starts again at once; the handler of the old session neither sends nor finishes in the
 * new one (no answer of it is uploaded, and its `seen`
 * does not land: the new session handles the replayed round 1 itself).
 */
export async function sDlv18(sameEngine: boolean): Promise<void> {
  const { w, A, B } = await pair({ b: { tuning: SHORT } })
  let refuse = true
  let reached = 0
  w.hub.failSend = (from, _g, msg) => {
    if (!refuse || from !== B.pk || msg.t !== 'm2') return false
    reached++
    return { rejectAfterMs: 5_000 }
  }
  let m1: Envelope | null = null
  w.publishHooks.push((e) => {
    if (!m1 && !e.injected && e.from === A.pk && e.t === 'm1') m1 = e
  })
  await A.a.postOffer({ side: 'buy', currency: 'KRW', amountMinor: AMOUNT, feePct: FEE, methods: BOTH })
  await until(w, () => reached > 0, MIN, "B's handler of the round 1 waits on its send")
  const round1 = m1 as unknown as Envelope
  const sid = (JSON.parse(round1.json) as { sid: string }).sid
  await A.a.sendChat(B.pk, 'a-x')
  await adv(w, 200)
  expect(countText(B, A, 'a-x') === 0, "the chat waits behind B's running handler")
  const inbox = w.hub.inbox(B.pk)
  expect(inbox.includes(round1.id) && inbox.length === 2, `both are in B's inbox (${inbox.length})`)
  const oldTag = B.tag
  const writesAt = B.kv.writes.length
  const eventsAt = B.events.length
  const stopAt = w.clock.now()
  if (sameEngine) {
    await B.engine.stop()
    await B.engine.start()
  } else {
    await B.engine.stop()
  }
  // The refusal comes and the old handler runs to its end.
  await adv(w, 6_000)
  if (sameEngine) {
    // The old handler has ended without marking the round 1 seen: the new session got the
    // replayed copy and handled it itself (its own 'rx'), instead of finding it in `seen`.
    // A later round 1 of A (another sid) would be its own 'rx', so those are counted out.
    const rx = B.events.slice(eventsAt).filter((e) => e.event === 'rx' && e.info?.t === 'm1').length
    const newRounds = sent(w, A, B, 'm1').filter((e) => e.atMs >= stopAt).length
    expect(rx === newRounds + 1, `the new session handled the replayed round 1 itself (rx ${rx}, new rounds ${newRounds})`)
  }
  if (!sameEngine) {
    const after = B.kv.writes.slice(writesAt).filter((x) => x.tag === oldTag)
    expect(after.length === 0, `no write after the stop (${after.map((x) => x.key).join(', ')})`)
    expect(w.hub.inbox(B.pk).includes(round1.id), 'the round 1 whose handler ran at the stop stays in the inbox')
    B.kv.close(B.tag, 'stop')
    B.spawn()
    await B.engine.start()
  }
  refuse = false
  await adv(w, 30_000)
  const answers = sent(w, B, A, 'm2').filter((e) => (JSON.parse(e.json) as { sid: string }).sid === sid).length
  expect(answers === 0, `the old session's answer was not sent in the next one (${answers})`)
  expect(countText(B, A, 'a-x') === 1, `B has the chat once (${countText(B, A, 'a-x')})`)
  expect(w.hub.inbox(B.pk).length === 0, "B's inbox is empty")
  await finish(w)
}

/** S-DLV-22: a full sender queue leaves the message in the inbox; the next start handles it. */
export async function sDlv22(): Promise<void> {
  const { w, A, B } = await pair()
  const g = groupOf(A, B)
  const sizeBefore = JSON.stringify(Object.fromEntries(B.kv.keys().map((k) => [k, B.kv.peek(k)]))).length
  // B's next `seen` write hangs: the first message holds the queue for 10 s while 1,000 more come.
  B.kv.hangNext('seen')
  for (let i = 0; i < 1_000; i++) w.hub.inject(A.pk, g, JSON.stringify({ t: 'withdraw' }))
  const last = w.hub.inject(A.pk, g, JSON.stringify({ t: 'chat', id: randomHex(16), text: 'overflow-chat' }))
  await adv(w, 5_000)
  expect(
    B.events.some((e) => e.event === 'inbox-kept' && e.info?.why === 'full'),
    'the 1,001st found the queue full',
  )
  await adv(w, 60_000)
  expect(w.hub.inbox(B.pk).includes(last.id), 'it stays in the inbox')
  expect(countText(B, A, 'overflow-chat') === 0, 'and is not handled yet')
  const seen = B.kv.peek<string[]>('seen') ?? []
  const sizeAfter = JSON.stringify(Object.fromEntries(B.kv.keys().map((k) => [k, B.kv.peek(k)]))).length
  expect(seen.length <= 500 && sizeAfter - sizeBefore < 64_000, `the flood leaves B's store bounded (seen ${seen.length}, +${sizeAfter - sizeBefore} bytes)`)
  expect(B.dumpLog().includes('engine  inbox kept'), 'the support log has the kept line')
  await restart(B)
  await adv(w, MIN)
  expect(countText(B, A, 'overflow-chat') === 1, 'the next start handles it, once')
  expect(w.hub.inbox(B.pk).length === 0, "B's inbox is empty")
  await finish(w)
}

/** S-DLV-HANG: one write that never ends holds up neither the other contact's message nor stop(). */
export async function sDlvHang(): Promise<void> {
  const w = newWorld()
  const A = makePeer(w, 'A')
  const B = makePeer(w, 'B')
  const C = makePeer(w, 'C')
  for (const p of [A, B, C]) await p.engine.start()
  await link(w, A, B)
  await link(w, C, B)
  await adv(w, 30_000)
  B.kv.hangNext(`room:${A.pk}`)
  await A.a.sendChat(B.pk, 'a')
  await adv(w, 100)
  await C.a.sendChat(B.pk, 'c')
  await adv(w, 30_000)
  expect(
    (B.kv.peek<ChatMessage[]>(`room:${C.pk}`) ?? []).some((m) => m.kind === 'text' && m.text === 'c'),
    "C's chat is stored though A's write hangs",
  )
  let stopped = false
  void B.engine.stop().then(() => (stopped = true))
  await until(w, () => stopped, 20_000, 'B.stop() ends within 20 s')
  B.kv.close(B.tag, 'stop')
  B.spawn()
  await B.engine.start()
  await adv(w, MIN)
  expect(countText(B, A, 'a') === 1 && countText(B, C, 'c') === 1, `after the restart one 'a' and one 'c' (${countText(B, A, 'a')}, ${countText(B, C, 'c')})`)
  expect(w.hub.inbox(B.pk).length === 0, "B's inbox is empty")
  await finish(w)
}

/**
 * S-DLV-FLOOD: floods keep the phone's storage bounded. (1) A sender who is not a contact
 * floods a room: everything is dropped and leaves the inbox. (2) A contact sends round 1
 * after round 1: answer sessions stay at 3 per sender. (3) With the inbox full a message is
 * still handled, only not stored, and the support log says so once.
 */
export async function sDlvFlood(): Promise<void> {
  {
    const { w, A, B } = await pair()
    const g = groupOf(A, B)
    const stranger = pubkeyOf(randomHex(32))
    let target: Peer | undefined
    for (let i = 0; i < 1_500; i++) {
      const e = w.hub.inject(stranger, g, JSON.stringify({ t: 'chat', id: randomHex(16), text: `ZQ-LEAK-flood-${i}` }))
      target ??= peerOf(w, e.to)
    }
    await adv(w, 2 * MIN)
    if (!target) throw new Fail('the flood reached nobody')
    expect(w.hub.inbox(target.pk).length === 0, `(1) the stranger's flood leaves the inbox (${w.hub.inbox(target.pk).length})`)
    expect(!dumpOf(target).includes('ZQ-LEAK-flood'), '(1) nothing of it is kept')
    await finish(w)
  }
  {
    const { w, A, B } = await pair()
    const g = groupOf(A, B)
    for (let i = 0; i < 20; i++) {
      const sid = randomHex(16)
      const { p } = matchCrypto.round1(matchCrypto.labelsFor({ context: g, myPubkey: A.pk, peerPubkey: B.pk, initiator: A.pk, sid, offer: null }))
      w.hub.inject(A.pk, g, JSON.stringify({ t: 'm1', sid, p }))
      await adv(w, 1_500)
    }
    await adv(w, 5_000)
    const resp = Object.values(B.kv.peek<Record<string, { contactId: string }>>('resp') ?? {})
    expect(resp.filter((s) => s.contactId === A.pk).length <= 3 && resp.length <= 60, `(2) answer sessions stay bounded (${resp.length})`)
    expect(sent(w, B, A, 'm2').length >= 10, '(2) B did answer them')
    await finish(w)
  }
  {
    const { w, A, B } = await pair({ inboxMax: 20 })
    const g = groupOf(A, B)
    B.kv.hangNext('seen')
    let most = 0
    w.publishHooks.push(() => (most = Math.max(most, w.hub.inbox(B.pk).length)))
    for (let i = 0; i < 30; i++) {
      w.hub.inject(A.pk, g, JSON.stringify({ t: 'chat', id: randomHex(16), text: `f${i}` }))
      most = Math.max(most, w.hub.inbox(B.pk).length)
    }
    await adv(w, 50)
    most = Math.max(most, w.hub.inbox(B.pk).length)
    expect(most <= 20, `(3) the stored inbox never holds more than its bound (${most})`)
    await adv(w, MIN)
    await restart(B)
    await adv(w, MIN)
    const all = Array.from({ length: 30 }, (_, i) => countText(B, A, `f${i}`))
    expect(
      all.every((n) => n === 1),
      `(3) every message was handled once, stored or not (${all.join('')})`,
    )
    expect(B.dumpLog().includes('marmot  inbox full'), '(3) the support log has the full line')
    expect(w.hub.inbox(B.pk).length === 0, "(3) B's inbox is empty")
    await finish(w)
  }
}

/** The inbox is part of the leak search: a waiting chat is found there (the control for S-LEAK). */
export async function sDlvInboxDump(): Promise<void> {
  const { w, A, B } = await pair()
  const C = makePeer(w, 'C')
  await C.engine.start()
  await link(w, A, C)
  await adv(w, 30_000)
  B.kv.hangNext(`room:${A.pk}`)
  await A.a.sendChat(B.pk, CHAT)
  await adv(w, 5_000)
  expect(
    w.hub.inboxEntries(B.pk).some((e) => JSON.stringify(e).includes(CHAT)),
    "the chat waits in B's stored inbox",
  )
  expect(dumpOf(B).includes('"inbox":[{'), 'dumpOf holds the inbox')
  expect(!dumpOf(C).includes('ZQ-LEAK'), "C's dump, inbox included, holds none of it")
  await adv(w, MIN)
  await finish(w)
}

/**
 * S-DLV-RX-SWEEP: the receiving side. A chats, matches, marks done, edits, chats, withdraws
 * and posts again, reconfirms, posts a non-matching offer whose withdraw is lost (B's no-match round clears it)
 * and posts again while B's power goes off before each of its writes in turn (n = 0..N),
 * and B starts again at once. Every time, 10 minutes later: each chat and the done once in
 * B's room, A and B agree on the match and see each other's current offer, B's inbox empty,
 * no late writes, no task error.
 */
async function rxRun(keys: { words: string }[], crashAt: number | null): Promise<{ w: World; A: Peer; B: Peer; armed: number; crashed: () => boolean; inFlow: boolean }> {
  const { w, A, B } = await pair({ keys })
  await B.a.postOffer({ side: 'sell', currency: 'KRW', amountMinor: 90_000, feePct: 3, methods: BOTH })
  await until(w, () => settled(B), 5 * MIN, "B's rounds")
  await adv(w, 30_000)
  const armed = B.kv.writes.length
  let crashed = false
  if (crashAt !== null) {
    void B.kv.crashAfter(crashAt).then(() => {
      crashed = true
      powerOff(B)
      B.spawn()
      void B.engine.start()
    })
  }
  await A.a.sendChat(B.pk, 'rx-1')
  await adv(w, 5_000)
  await A.a.postOffer({ side: 'buy', currency: 'KRW', amountMinor: AMOUNT, feePct: FEE, methods: BOTH })
  await adv(w, 60_000)
  await A.a.markDone(B.pk, 10_000)
  await adv(w, 5_000)
  await A.a.sendChat(B.pk, 'rx-2')
  await adv(w, 5_000)
  await A.a.withdrawOffer()
  await adv(w, 5_000)
  await A.a.postOffer({ side: 'buy', currency: 'KRW', amountMinor: AMOUNT, feePct: FEE, methods: BOTH })
  await adv(w, 60_000)
  // The writes on B: A's reconfirm round, which B answers, then a round of an
  // offer of A that no longer matches while A's withdraw is lost, which clears A on B
  //, and the match again.
  const tR = w.clock.now()
  A.engine.rearmRounds()
  await adv(w, 30_000)
  // The base run shows the step does what it is for (a run with a crash may cut it short).
  if (crashAt === null)
    expect(
      sent(w, A, B, 'm1').some((e) => e.atMs >= tR),
      'base run: A reconfirmed B',
    )
  let lose = true
  w.hub.route = (e) => (lose && e.from === A.pk && e.to === B.pk && e.t === 'withdraw' ? 'drop' : 'deliver')
  await A.a.postOffer({ side: 'buy', currency: 'USD', amountMinor: 10_000, feePct: FEE, methods: BOTH })
  await adv(w, 60_000)
  if (crashAt === null) expect(!matched(B, A) && !(A.pk in verifiedOf(B)), 'base run: the lost withdraw was made up by the no-match round on B')
  lose = false
  await A.a.postOffer({ side: 'buy', currency: 'KRW', amountMinor: AMOUNT, feePct: FEE, methods: BOTH })
  await adv(w, 60_000)
  return { w, A, B, armed, crashed: () => crashed, inFlow: crashed }
}

export async function sDlvRxSweep(): Promise<void> {
  const keys = orderedKeys(2)
  const base = await rxRun(keys, null)
  const total = base.B.kv.writes.length - base.armed
  await finish(base.w)
  expect(total > 10, `the flow writes on B (${total})`)
  for (let n = 0; n <= total; n++) {
    const r = await rxRun(keys, n)
    const at = `crash before B's write ${n + 1}/${total}`
    try {
      await adv(r.w, 10 * MIN)
    } catch (e) {
      throw new Fail(`${at}: ${errText(e)}`)
    }
    // A sweep step whose power never went off would test nothing; a flow that writes more
    // or less than the base run means the steps do not line up with the base's writes.
    if (n < total) expect(r.crashed() && r.inFlow, `${at}: the power went off during the flow (crashed ${r.crashed()}, in the flow ${r.inFlow})`)
    else expect(!r.inFlow, `${at}: the flow wrote as often as the base run (${total})`)
    const { A, B } = r
    expect(B.state().boot === 'ready', `${at}: B is ready`)
    const errors = B.events.filter((e) => e.tag === B.tag && e.event === 'task-error')
    expect(errors.length === 0, `${at}: no task error (${JSON.stringify(errors[0]?.info)})`)
    const dones = roomOf(B, A).filter((m) => m.kind === 'done' && !m.mine).length
    expect(countText(B, A, 'rx-1') === 1 && countText(B, A, 'rx-2') === 1 && dones === 1, `${at}: each chat and the done once (${countText(B, A, 'rx-1')}, ${countText(B, A, 'rx-2')}, ${dones})`)
    const ab = A.state().matches.find((m) => m.contactId === B.pk)
    const ba = B.state().matches.find((m) => m.contactId === A.pk)
    expect(!!ab && !!ba, `${at}: A and B match each other (A has B ${!!ab}, B has A ${!!ba})`)
    expect(ab?.offer.amountMinor === 90_000 && ba?.offer.amountMinor === AMOUNT, `${at}: each sees the other's current offer (${ab?.offer.amountMinor}, ${ba?.offer.amountMinor})`)
    expect(r.w.hub.inbox(B.pk).length === 0, `${at}: B's inbox is empty (${r.w.hub.inbox(B.pk).length})`)
    try {
      await finish(r.w)
    } catch (e) {
      throw new Fail(`${at}: ${errText(e)}`)
    }
  }
}
