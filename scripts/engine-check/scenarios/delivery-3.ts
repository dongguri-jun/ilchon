/**
 * Engine check scenarios: delivery (S-DLV, told).
 * Run from scripts/check-engine.ts, which lists every scenario in its order.
 */
import { randomHex } from '../../../src/lib/marmot/keys'
import { matchCrypto } from '../../../src/lib/match'
import { TOLD, matchedPair, offerViewOf, pair, refuseFrom, showsCurrent, toldOf } from '../helpers/delivery'
import { groupOf, matched } from '../helpers/trade'
import { type TwinScript, twin } from '../helpers/twin'
import { AMOUNT, FEE, dumpOf, holdsNumber } from '../markers'
import { Fail, errText, expect } from '../report'
import { BOTH, MIN, type Peer, START_MS, type World, adv, deleteContact, finish, hasContact, link, makePeer, newWorld, orderedKeys, powerOff, restart, sent, settled, until } from '../world'

/** S-DLV-1: A takes its offer down while its sends to B are refused, and restarts; once they go through, B sees it gone. */
export async function sDlv1(): Promise<void> {
  const { w, A, B } = await matchedPair()
  let refuse = true
  refuseFrom(w, A, B, () => refuse)
  await A.a.withdrawOffer()
  await adv(w, 5_000)
  expect(matched(B, A), 'before the restart B still shows A (the withdraw did not go)')
  expect(B.pk in toldOf(A), 'A keeps the withdraw it owes B')
  await restart(A)
  await adv(w, 5_000)
  expect(matched(B, A), 'and after the restart, while it is still refused')
  refuse = false
  await until(w, () => !matched(B, A), 2 * MIN, 'B loses A once the withdraw goes')
  await adv(w, 5_000)
  expect(!(B.pk in toldOf(A)), "A's told no longer holds B")
  expect(sent(w, A, B, 'withdraw').length === 1, `one withdraw went (${sent(w, A, B, 'withdraw').length})`)
  await finish(w)
}

/** S-DLV-2: two edits while refused; only the last one ever reaches B. */
export async function sDlv2(): Promise<void> {
  const { w, A, B } = await matchedPair()
  let refuse = true
  refuseFrom(w, A, B, () => refuse)
  await A.a.postOffer({ side: 'buy', currency: 'KRW', amountMinor: 70_000, feePct: FEE, methods: BOTH })
  await A.a.postOffer({ side: 'buy', currency: 'KRW', amountMinor: 80_000, feePct: FEE, methods: BOTH })
  await adv(w, 10_000)
  expect(offerViewOf(B, A)?.amountMinor === AMOUNT, 'while refused B still shows the first amount')
  refuse = false
  await until(w, () => offerViewOf(B, A)?.amountMinor === 80_000, 2 * MIN, 'B shows the last amount')
  const amounts = sent(w, A, B, 'offer').map((e) => (JSON.parse(e.json) as { offer: { amountMinor: number } }).offer.amountMinor)
  expect(!amounts.includes(70_000), `the middle amount never went to B (${amounts.join(', ')})`)
  expect(showsCurrent(B, A) && toldOf(A)[B.pk]?.ok === true && toldOf(A)[B.pk]?.offer.amountMinor === 80_000, 'B shows A exactly; A knows a relay took it')
  await finish(w)
}

/**
 * S-DLV-POST: A posts, the round matches, but A's offer is refused, and A restarts
 * before it could go. Once sends go through, B shows A's offer (told was written first).
 */
export async function sDlvPost(): Promise<void> {
  const { w, A, B } = await pair({ a: { tuning: TOLD }, b: { tuning: TOLD } })
  await B.a.postOffer({ side: 'sell', currency: 'KRW', amountMinor: 90_000, feePct: 3, methods: BOTH })
  await until(w, () => settled(B), 5 * MIN, "B's rounds")
  let refuse = true
  refuseFrom(w, A, B, () => refuse, ['offer'])
  await A.a.postOffer({ side: 'buy', currency: 'KRW', amountMinor: AMOUNT, feePct: FEE, methods: BOTH })
  await until(w, () => matched(A, B), 5 * MIN, "A gets B's offer")
  await adv(w, 5_000)
  expect(!matched(B, A) && toldOf(A)[B.pk]?.ok === false, "B does not show A yet; A's told says it did not land")
  await restart(A)
  await adv(w, 5_000)
  refuse = false
  await until(w, () => showsCurrent(B, A), 2 * MIN, "B shows A's offer after the restart")
  expect(toldOf(A)[B.pk]?.ok === true, "A's told says a relay took it")
  await finish(w)
}

/** S-DLV-DEL: A deletes B while its sends are refused and restarts; the withdraw it owes still goes, to the deleted contact's room. */
export async function sDlvDel(): Promise<void> {
  const { w, A, B } = await matchedPair()
  const g = groupOf(A, B)
  let refuse = true
  refuseFrom(w, A, B, () => refuse)
  await deleteContact(w, A, B)
  await adv(w, 5_000)
  expect(matched(B, A) && B.pk in toldOf(A), 'B still shows A; A owes it a withdraw')
  await restart(A)
  refuse = false
  await until(w, () => !matched(B, A), 2 * MIN, 'B loses A')
  await adv(w, 5_000)
  const w2 = sent(w, A, B, 'withdraw')
  expect(w2.length === 1 && w2[0].groupId === g, `one withdraw, in the room of the deleted contact (${w2.length})`)
  expect(!(B.pk in toldOf(A)), "A's told is empty")
  expect(hasContact(B, A), 'B still lists A')
  await finish(w)
}

/**
 * S-DLV-9: twin with A as the deleting side. A and B match; while A's sends to B
 * are refused, world 1 takes A's offer down (split1) and world 2 deletes B. B restarts and
 * reconfirms; both restart A and let the sends go; B posts twice; A re-arms and
 * restarts. B gets the same from A in both worlds, one withdraw each.
 */
export async function sDlv9(aLow: boolean): Promise<void> {
  const reopened = new Map<World, number>()
  const script: TwinScript = {
    a: [
      { atMs: 2 * MIN, act: (p) => restart(p) },
      {
        atMs: 3 * MIN,
        act: async (p) => {
          p.world.hub.failSend = () => false
        },
      },
      { atMs: 20 * MIN, act: async (p) => p.engine.rearmRounds() },
      { atMs: 25 * MIN, act: (p) => restart(p) },
    ],
    b: [
      // B reopens while A's withdraw is still refused: B's reconfirm round
      // reaches A, which answers it the same whether it took its offer down or deleted B.
      {
        atMs: MIN,
        act: (p) => {
          reopened.set(p.world, p.world.clock.now())
          return restart(p)
        },
      },
      { atMs: 5 * MIN, act: (p) => p.a.postOffer({ side: 'buy', currency: 'KRW', amountMinor: 80_000, feePct: 2, methods: BOTH }) },
      { atMs: 10 * MIN, act: (p) => p.a.postOffer({ side: 'sell', currency: 'USD', amountMinor: 10_000, feePct: 2, methods: BOTH }) },
      { atMs: 40 * MIN, act: async () => {} },
    ],
  }
  const r = await twin(script, {
    aLow,
    tuning: TOLD,
    beforeSplit: async (w, A, B) => {
      await B.a.postOffer({ side: 'sell', currency: 'KRW', amountMinor: 90_000, feePct: 3, methods: BOTH })
      await until(w, () => settled(B), 5 * MIN, "B's rounds")
      await A.a.postOffer({ side: 'buy', currency: 'KRW', amountMinor: AMOUNT, feePct: FEE, methods: BOTH })
      await until(w, () => matched(A, B) && matched(B, A), 5 * MIN, 'A and B match')
      await adv(w, 30_000)
      refuseFrom(w, A, B, () => true)
    },
    split1: (_w, A) => A.a.withdrawOffer(),
  })
  const [s1, s2] = r.seqs
  const firstDiff = s1.findIndex((x, i) => x !== s2[i])
  expect(
    s1.length === s2.length && firstDiff < 0,
    `A→B envelopes differ between the worlds (world 1: ${s1.length}, world 2: ${s2.length}, first difference at ${firstDiff}: ${s1[firstDiff]} / ${s2[firstDiff]})`,
  )
  for (let i = 0; i < 2; i++) {
    const [w, A, B] = [r.worlds[i], r.a[i], r.b[i]]
    const n = sent(w, A, B, 'withdraw').length
    expect(n === 1, `world ${i + 1}: one withdraw went to B (${n})`)
    const t = reopened.get(w) ?? Infinity
    expect(sent(w, B, A, 'm1').some((e) => e.atMs >= t) && sent(w, A, B, 'm2').some((e) => e.atMs >= t), `world ${i + 1}: B reconfirmed after it reopened and A answered`)
    expect(hasContact(B, A) && !matched(B, A), `world ${i + 1}: B lists A and shows no offer of A`)
    expect(Object.keys(toldOf(A)).length === 0, `world ${i + 1}: A's told is empty`)
  }
  for (const w of r.worlds) await finish(w)
}

/**
 * S-DLV-10: the told flow with C beside it (C buys like A, so it never matches A). A
 * matches B, edits while refused, takes the offer down, restarts, re-arms, posts again,
 * marks a trade done and edits. Nothing of A's offer goes to C or is told about C.
 */
export async function sDlv10(): Promise<void> {
  const { w, A, B } = await matchedPair()
  const C = makePeer(w, 'C', { tuning: TOLD })
  await C.engine.start()
  // A new contact gets a round of my current offer, like a new offer does.
  const posts: number[] = [w.clock.now()]
  await link(w, A, C)
  await C.a.postOffer({ side: 'buy', currency: 'KRW', amountMinor: 50_000, feePct: 1, methods: BOTH })
  await adv(w, MIN)
  const offerIds = [A.state().myOffer?.id ?? '']
  let refuse = true
  refuseFrom(w, A, B, () => refuse)
  await A.a.postOffer({ side: 'buy', currency: 'KRW', amountMinor: 54_321, feePct: FEE, methods: BOTH })
  await adv(w, 5_000)
  await A.a.withdrawOffer()
  await adv(w, 5_000)
  await restart(A)
  refuse = false
  await adv(w, 2 * MIN)
  A.engine.rearmRounds()
  await adv(w, MIN)
  posts.push(w.clock.now())
  await A.a.postOffer({ side: 'buy', currency: 'KRW', amountMinor: AMOUNT, feePct: FEE, methods: BOTH })
  offerIds.push(A.state().myOffer?.id ?? '')
  await until(w, () => matched(A, B) && matched(B, A), 5 * MIN, 'A and B match again')
  await A.a.markDone(B.pk, 10_000)
  await adv(w, 10_000)
  await restart(A)
  A.engine.rearmRounds()
  await adv(w, 5 * MIN)
  expect(showsCurrent(B, A), "B shows A's current offer")
  for (const t of ['offer', 'withdraw', 'done']) expect(sent(w, A, C, t).length === 0, `nothing of type ${t} went from A to C`)
  expect(!(C.pk in toldOf(A)), "A's told holds nothing about C")
  // C's round 1s came only when C was linked or A posted a new offer.
  const m1s = sent(w, A, C, 'm1')
  expect(
    m1s.every((e) => posts.some((t) => e.atMs >= t && e.atMs - t < 2 * MIN)),
    `A's round 1s to C follow its new offers only (${m1s.map((e) => e.atMs - START_MS).join(', ')})`,
  )
  // The control: A's restarts and returns did reconfirm B; C got none of it.
  expect(
    sent(w, A, B, 'm1').some((e) => !posts.some((t) => e.atMs >= t && e.atMs - t < 2 * MIN)),
    'A reconfirmed B at a restart or a return',
  )
  const cDump = dumpOf(C)
  for (const n of [AMOUNT, 54_321, AMOUNT - 10_000, FEE]) expect(!holdsNumber(cDump, n), `C holds no trace of A's number ${n}`)
  for (const id of offerIds) expect(id !== '' && !cDump.includes(id), "C holds no trace of A's offer ids")
  await finish(w)
}

/**
 * S-DLV-21: a relay refuses every send of A to C during their first round. The round
 * comes again with the gaps of an unanswered one, not every 77 s: attempts at the relay
 * (each try of each round 1) at most 80 in the first hour and 30 in the second.
 */
export async function sDlv21(): Promise<void> {
  const w = newWorld()
  const A = makePeer(w, 'A')
  const C = makePeer(w, 'C')
  await A.engine.start()
  await C.engine.start()
  await link(w, A, C)
  await adv(w, 30_000)
  const g = groupOf(A, C)
  const tries: number[] = []
  w.hub.failSend = (from, groupId, msg) => {
    if (from !== A.pk || groupId !== g) return false
    if (msg.t === 'm1') tries.push(w.clock.now())
    return 'reject'
  }
  const t0 = w.clock.now()
  await A.a.postOffer({ side: 'buy', currency: 'KRW', amountMinor: AMOUNT, feePct: FEE, methods: BOTH })
  await adv(w, 120 * MIN)
  const first = tries.filter((t) => t - t0 < 60 * MIN).length
  const second = tries.length - first
  expect(first > 6, `the round was tried at all (${first})`)
  expect(first <= 80 && second <= 30, `tries of round 1: ${first} in the first hour, ${second} in the second`)
  await finish(w)
}

/**
 * S-BOT-MX-LOOP: B refuses every round 1 of A with mx. In an hour
 * A tries B at most 12 times (refusal backoff); A and an honest C match as usual.
 */
export async function sBotMxLoop(): Promise<void> {
  const w = newWorld({ honest: false })
  const A = makePeer(w, 'A')
  const B = makePeer(w, 'B')
  const C = makePeer(w, 'C')
  for (const p of [A, B, C]) await p.engine.start()
  await link(w, A, B)
  await link(w, A, C)
  await adv(w, 30_000)
  await C.a.postOffer({ side: 'sell', currency: 'KRW', amountMinor: 90_000, feePct: 3, methods: BOTH })
  await until(w, () => settled(C), 5 * MIN, "C's rounds")
  await adv(w, 30_000)
  // B's own answers never reach A; every round 1 of A is answered with a refusal.
  w.hub.route = (e) => (e.from === B.pk && e.to === A.pk && !e.injected ? 'drop' : 'deliver')
  w.publishHooks.push((e) => {
    if (e.injected || e.from !== A.pk || e.to !== B.pk || e.t !== 'm1') return
    w.hub.inject(B.pk, e.groupId, JSON.stringify({ t: 'mx', sid: (JSON.parse(e.json) as { sid: string }).sid }))
  })
  const t0 = w.clock.now()
  await A.a.postOffer({ side: 'buy', currency: 'KRW', amountMinor: AMOUNT, feePct: FEE, methods: BOTH })
  await until(w, () => matched(A, C) && matched(C, A), 2 * MIN, 'A and the honest C match in the usual time')
  await adv(w, t0 + 60 * MIN - w.clock.now())
  const tries = sent(w, A, B, 'm1').filter((e) => e.atMs >= t0).length
  expect(tries >= 3 && tries <= 12, `A tried B ${tries} times in an hour (at most 12)`)
  await finish(w)
}

/**
 * S-DLV-TX-SWEEP: the sending side. A posts, matches B, reconfirms, loses B's match to a
 * round of B's non-matching offer while B's withdraw is lost and matches again (those
 * three), edits twice, takes the offer down, posts again, edits and deletes B, while A's power goes off before each of its
 * writes in turn (n = 0..N-1; at n = N the power stays on and the flow writes exactly N
 * times, as in the base run); the flow ends there and A starts again. 10 minutes later B
 * shows either nothing of A or exactly A's current offer: never an old one; it shows that
 * offer whenever A holds a verified match of it; nothing once A has no offer or deleted
 * B. Inboxes empty, no late writes, no task error.
 */
async function txRun(keys: { words: string }[], crashAt: number | null): Promise<{ w: World; A: Peer; B: Peer; writes: number; crashed: boolean }> {
  const { w, A, B } = await pair({ keys, a: { tuning: TOLD }, b: { tuning: TOLD } })
  await B.a.postOffer({ side: 'sell', currency: 'KRW', amountMinor: 90_000, feePct: 3, methods: BOTH })
  await until(w, () => settled(B), 5 * MIN, "B's rounds")
  await adv(w, 30_000)
  const armed = A.kv.writes.length
  let crashed = false
  const crashP =
    crashAt === null
      ? new Promise<void>(() => {})
      : A.kv.crashAfter(crashAt).then(() => {
          crashed = true
          powerOff(A)
        })
  const act = (run: () => Promise<void>) => async () => {
    await Promise.race([run(), crashP])
  }
  const wait = (pred: () => boolean, what: string) => () => until(w, () => crashed || pred(), 5 * MIN, what)
  let loseB = false
  w.hub.route = (e) => (loseB && e.from === B.pk && e.to === A.pk && e.t === 'withdraw' ? 'drop' : 'deliver')
  const pause = (ms: number) => () => adv(w, ms)
  const steps: (() => Promise<void>)[] = [
    act(() => A.a.postOffer({ side: 'buy', currency: 'KRW', amountMinor: AMOUNT, feePct: FEE, methods: BOTH })),
    wait(() => matched(A, B) && matched(B, A), 'match'),
    // The writes on A: its reconfirm round; then B's withdraw is lost while B
    // posts an offer that does not match, whose round clears B on A; B posts again.
    act(async () => A.engine.rearmRounds()),
    pause(30_000),
    act(async () => {
      loseB = true
      await B.a.postOffer({ side: 'sell', currency: 'USD', amountMinor: 10_000, feePct: 3, methods: BOTH })
    }),
    wait(() => !matched(A, B), 'the no-match round clears B on A'),
    pause(5_000),
    act(async () => {
      loseB = false
      await B.a.postOffer({ side: 'sell', currency: 'KRW', amountMinor: 90_000, feePct: 3, methods: BOTH })
    }),
    wait(() => matched(A, B) && matched(B, A), 'match after the no-match round'),
    act(() => A.a.postOffer({ side: 'buy', currency: 'KRW', amountMinor: 54_321, feePct: FEE, methods: BOTH })),
    pause(5_000),
    act(() => A.a.postOffer({ side: 'buy', currency: 'KRW', amountMinor: 54_321, feePct: 1.5, methods: BOTH })),
    pause(5_000),
    act(() => A.a.withdrawOffer()),
    pause(5_000),
    act(() => A.a.postOffer({ side: 'buy', currency: 'KRW', amountMinor: AMOUNT, feePct: FEE, methods: BOTH })),
    wait(() => matched(A, B) && matched(B, A), 'match again'),
    act(() => A.a.postOffer({ side: 'buy', currency: 'KRW', amountMinor: 60_000, feePct: FEE, methods: BOTH })),
    pause(5_000),
    act(() => deleteContact(w, A, B)),
    pause(5_000),
  ]
  for (const step of steps) {
    await step()
    await w.clock.settle()
    if (crashed) break
  }
  return { w, A, B, writes: A.kv.writes.length - armed, crashed }
}

export async function sDlvTxSweep(): Promise<void> {
  const keys = orderedKeys(2)
  const base = await txRun(keys, null)
  const total = base.writes
  expect(total > 10, `the flow writes on A (${total})`)
  expect(!matched(base.B, base.A) && !(base.B.pk in toldOf(base.A)), 'base run: after the delete B shows nothing of A and A owes nothing')
  await finish(base.w)
  for (let n = 0; n <= total; n++) {
    const r = await txRun(keys, n)
    const at = `crash before A's write ${n + 1}/${total}`
    // A flow that writes more or less than the base run means the steps do not line up
    // with the base's writes: armed one past the last write, the power must stay on and
    // the flow write exactly as often as the base run.
    if (n === total) {
      expect(!r.crashed && r.writes === total, `${at}: the flow wrote as often as the base run (${r.writes} of ${total}, crashed ${r.crashed})`)
      await finish(r.w)
      break
    }
    // A sweep step whose power never went off would test nothing.
    expect(r.crashed, `${at}: the power went off during the flow`)
    const { w, A, B } = r
    // A delete that never reached storage did not happen: A may still talk to B.
    const tombs = A.kv.peek<Record<string, unknown>>('tombstones') ?? {}
    if (!(B.pk in tombs)) w.deleted.delete(A.pk)
    // Off between the delete's two writes (tombstones first): the pubkey is in both
    // lists on disk; load() settles it for the later record, the tombstone,
    // so INV-L1 holds again from the restart on and the delete stands.
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
    const cur = A.state().myOffer
    const view = offerViewOf(B, A)
    const deleted = !hasContact(A, B)
    expect(!view || showsCurrent(B, A), `${at}: B shows nothing of A or exactly A's current offer (B: ${view?.amountMinor}/${view?.feePct}, A: ${cur?.amountMinor}/${cur?.feePct})`)
    if (!cur || deleted) expect(!view, `${at}: B shows nothing once A has no offer or deleted B`)
    else if ((A.kv.peek<Record<string, string>>('verified') ?? {})[B.pk] === cur.id) {
      expect(
        showsCurrent(B, A),
        `${at}: A holds a verified match, so B shows A's current offer (told ${JSON.stringify(toldOf(A)[B.pk])}, B verified A ${(B.kv.peek<Record<string, string>>('verified') ?? {})[A.pk] !== undefined}, B shows ${view?.amountMinor}, A shows B ${matched(A, B)}, A ${cur.amountMinor})`,
      )
    }
    if (!view) expect(!(B.pk in toldOf(A)) || toldOf(A)[B.pk].ok === false || !deleted, `${at}: A owes B nothing it thinks has landed`)
    expect(w.hub.inbox(A.pk).length === 0 && w.hub.inbox(B.pk).length === 0, `${at}: the inboxes are empty`)
    try {
      await finish(w)
    } catch (e) {
      throw new Fail(`${at}: ${errText(e)}`)
    }
  }
}

/**
 * S-DLV-RESP-CAP: answer sessions are bounded per sender (3) and in all (60).
 * 22 contacts send round 1 after round 1 and never finish: the engine's test hook reads
 * the sizes, the stored copy agrees, and the support log has one bare line.
 */
export async function sDlvRespCap(): Promise<void> {
  const w = newWorld()
  const B = makePeer(w, 'B')
  await B.engine.start()
  const senders: Peer[] = []
  for (let i = 0; i < 22; i++) {
    const P = makePeer(w, `P${i}`)
    await P.engine.start()
    await link(w, P, B)
    senders.push(P)
  }
  await adv(w, 30_000)
  let most = 0
  for (let round = 0; round < 4; round++) {
    for (const P of senders) {
      const g = groupOf(P, B)
      const sid = randomHex(16)
      const { p } = matchCrypto.round1(matchCrypto.labelsFor({ context: g, myPubkey: P.pk, peerPubkey: B.pk, initiator: P.pk, sid, offer: null }))
      w.hub.inject(P.pk, g, JSON.stringify({ t: 'm1', sid, p }))
    }
    await adv(w, 1_500)
    most = Math.max(most, B.engine.sizes().resp)
  }
  await adv(w, 5_000)
  const sz = B.engine.sizes()
  const answered = sent(w, B, senders[0], 'm2').length
  expect(answered >= 3, `B answered the round 1s (${answered} to one sender)`)
  expect(sz.respPerSender <= 3, `at most 3 sessions per sender (${sz.respPerSender})`)
  expect(most <= 60 && sz.resp <= 60, `at most 60 sessions in all (${sz.resp}, most ${most})`)
  expect(sz.resp === 60, `the bound in all was reached: 22 senders, 3 each (${sz.resp})`)
  const stored = Object.keys(B.kv.peek<Record<string, unknown>>('resp') ?? {}).length
  expect(stored <= 60, `the stored sessions are bounded too (${stored})`)
  expect(B.dumpLog().includes('engine  answer sessions capped'), 'the support log has the bare capped line')
  await finish(w)
}
