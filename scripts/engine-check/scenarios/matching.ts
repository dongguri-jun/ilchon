/**
 * Engine check scenarios: matching reflection and round ownership (S-REFLECT, S-M2-OWNER).
 * Run from scripts/check-engine.ts, which lists every scenario in its order.
 */
import type { WireMessage } from '../../../src/contracts'
import { randomHex } from '../../../src/lib/marmot/keys'
import { AMOUNT, FEE } from '../markers'
import { expect } from '../report'
import { BOTH, MIN, adv, finish, link, makePeer, newWorld, orderedKeys, powerOff, sent, settled, until } from '../world'

// ---------------------------------------------------------------- S-REFLECT

export async function sReflect(aLow: boolean): Promise<void> {
  const w = newWorld({ honest: false })
  const [lo, hi] = orderedKeys(2)
  const A = makePeer(w, 'A', { words: aLow ? lo.words : hi.words })
  const B = makePeer(w, 'B', { words: aLow ? hi.words : lo.words })
  await A.engine.start()
  await B.engine.start()
  await link(w, A, B)
  await adv(w, 30_000)

  /** reflected sid -> A's original sid */
  const reflected = new Map<string, string>()
  w.publishHooks.push((e) => {
    if (e.injected || e.from !== A.pk || e.to !== B.pk) return
    const msg = JSON.parse(e.json) as WireMessage
    if (msg.t === 'm1') {
      // A's own round 1 comes back to it under B's name, with a fresh sid.
      const sid = randomHex(16)
      reflected.set(sid, msg.sid)
      w.hub.inject(B.pk, e.groupId, JSON.stringify({ t: 'm1', sid, p: msg.p }))
    } else if (msg.t === 'm2' && reflected.has(msg.sid)) {
      // A answered its own point: hand that answer back as the answer to its round.
      const orig = reflected.get(msg.sid) ?? ''
      w.hub.inject(B.pk, e.groupId, JSON.stringify({ t: 'm2', sid: orig, q: msg.q, pq: msg.pq }))
    }
  })
  // B's honest answers never reach A.
  w.hub.route = (e) => (e.from === B.pk && !e.injected && (e.t === 'm2' || e.t === 'mx') ? 'drop' : 'deliver')

  await A.a.postOffer({ side: 'buy', currency: 'KRW', amountMinor: AMOUNT, feePct: FEE, methods: BOTH })
  await adv(w, 3 * MIN)
  // The leak assertions below (no offer, no verified) pass on
  // the cryptography alone, without the engine's defence: the label binds the initiator,
  // the responder and the sid, so a reflected round never compares equal (check-match M4
  // carries that guarantee). INV-M4 (checked at every upload) keeps watching the engine's
  // progress rule, the crossed-start handling, which stays.
  expect(reflected.size > 0, 'the attack ran (a round 1 of A was reflected)')
  expect(sent(w, A, B, 'offer').length === 0, 'A sends no offer to B')
  expect(!(B.pk in (A.kv.peek<Record<string, string>>('verified') ?? {})), 'A has not verified B')
  expect(A.state().matches.length === 0, 'A has no match')
  // The lower key keeps its own round and sends its round 1 again instead of answering
  // the reflection; INV-M4 (checked at every upload) holds it to that while the round is
  // open. Once that round expires, a late reflection may be answered like any round 1,
  // which is harmless: the round it would complete is gone.
  if (aLow)
    expect(
      A.events.some((e) => e.event === 'round-crossed' && e.info?.kept === 'mine'),
      'the lower key kept its own round',
    )
  else
    expect(
      A.events.some((e) => e.event === 'round-crossed' && e.info?.kept === 'theirs'),
      'the higher key yielded its round',
    )
  await finish(w)
}

// ---------------------------------------------------------------- S-M2-OWNER

/**
 * A stop between a round and its budget, then a reflection. A has answered a round of B, so
 * that answer owns the budget with B. A posts an offer; the power goes off after A stored its
 * new round and before it stored the budget. Once the restarted A kept that round
 * open beside the old owner, and only onM2's owner check kept a reflection
 * harmless. Now load() closes such a round (it never sent its round 1) and runs it again once
 * the budget is free, so INV-M4 is checked here too. The attack still runs: A's own point
 * from the closed round comes back as a round 1 under B's name, and A's answer comes back as
 * the answer to the closed round. Nothing completes: no m3, no offer, no verified, no match.
 */
export async function sM2Owner(): Promise<void> {
  const w = newWorld({ honest: false })
  const [lo, hi] = orderedKeys(2)
  const A = makePeer(w, 'A', { words: hi.words })
  const B = makePeer(w, 'B', { words: lo.words })
  await A.engine.start()
  await B.engine.start()
  await link(w, A, B)
  await adv(w, 30_000)

  // A answers a round of B: that round owns the budget with B on A's side.
  await B.a.postOffer({ side: 'sell', currency: 'KRW', amountMinor: 90000, feePct: 3, methods: BOTH })
  await until(w, () => settled(B), 5 * MIN, 'round of B')
  await adv(w, 30_000)
  const before = A.kv.peek<Record<string, string>>('roundOwner')?.[B.pk] ?? ''
  expect(before.startsWith('r:'), `A's budget with B is held by its answer to B (${before})`)

  // From here B's own messages do not reach A; only injected ones do.
  w.hub.route = (e) => (e.from === B.pk && !e.injected ? 'drop' : 'deliver')
  const openRound = () => Object.entries(A.kv.peek<Record<string, { contactId: string; p?: [string, string] }>>('init') ?? {}).find(([, x]) => x.contactId === B.pk)
  let crashed = false
  const off = A.kv
    .crashWhen((x) => x.key === 'respondLog' && openRound() !== undefined)
    .then(() => {
      crashed = true
      powerOff(A)
    })
  void A.a.postOffer({ side: 'buy', currency: 'KRW', amountMinor: AMOUNT, feePct: FEE, methods: BOTH }).catch(() => {})
  await until(w, () => crashed, MIN, 'the power goes off between the round and its budget')
  await off
  const orphan = openRound()
  expect(orphan !== undefined && Array.isArray(orphan[1].p) && orphan[1].p.length === 2, 'on disk: the new round (both slots of its point), its budget still on the old answer')
  const [sid, session] = orphan as [string, { p: [string, string] }]
  expect((A.kv.peek<Record<string, string>>('roundOwner')?.[B.pk] ?? '') === before, 'on disk: the owner is still the old answer')
  const m1Before = sent(w, A, B, 'm1').length
  A.spawn()
  await A.engine.start()
  await adv(w, 5_000)
  expect(A.state().boot === 'ready' && A.state().myOffer?.amountMinor === AMOUNT, 'A is ready again with its offer')
  expect(!(sid in (A.kv.peek<Record<string, unknown>>('init') ?? {})), 'the round that never got its budget is closed at load')
  const owner = A.kv.peek<Record<string, string>>('roundOwner')?.[B.pk] ?? ''
  const reopened = openRound()
  expect(reopened === undefined || owner === `i:${reopened[0]}`, `an open round of A with B owns the budget (${owner})`)
  expect(
    sent(w, A, B, 'm1')
      .slice(m1Before)
      .every((e) => !e.json.includes(sid)),
    'the closed round never sent its round 1',
  )

  // The attacker sends A's own point (of the closed round) as a round 1 under B's name and
  // hands A's answer back as the answer to that round.
  const contact = A.state().contacts.find((c) => c.pubkey === B.pk)
  expect(!!contact, 'A lists B')
  const reflectedSid = randomHex(16)
  w.publishHooks.push((e) => {
    if (e.injected || e.from !== A.pk || e.to !== B.pk) return
    const msg = JSON.parse(e.json) as WireMessage
    if (msg.t !== 'm2' || msg.sid !== reflectedSid) return
    w.hub.inject(B.pk, e.groupId, JSON.stringify({ t: 'm2', sid, q: msg.q, pq: msg.pq }))
  })
  const mark = w.clock.now()
  w.hub.inject(B.pk, contact?.groupId ?? '', JSON.stringify({ t: 'm1', sid: reflectedSid, p: session.p }))
  await adv(w, MIN)
  expect(sent(w, A, B, 'offer').length === 0, 'A sends no offer to B')
  expect(!sent(w, A, B, 'm3').some((e) => e.atMs >= mark), 'A sends no m3 to B')
  expect(!(B.pk in (A.kv.peek<Record<string, string>>('verified') ?? {})), 'A has not verified B')
  expect(A.state().matches.length === 0, 'A has no match')
  await finish(w)
}
