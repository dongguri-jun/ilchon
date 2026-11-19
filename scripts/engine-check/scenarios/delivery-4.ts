/**
 * Engine check scenarios: delivery (S-DLV, convergence).
 * Run from scripts/check-engine.ts, which lists every scenario in its order.
 */
import type { Envelope } from '../../fake-transport'
import { CONV, converged, offerViewOf, pair, toldOf, verifiedOf } from '../helpers/delivery'
import { groupOf, markers, matched } from '../helpers/trade'
import { AMOUNT, FEE } from '../markers'
import { expect } from '../report'
import { BOTH, MIN, type Peer, type World, adv, finish, link, makePeer, newWorld, orderedKeys, powerOff, restart, sent, settled, until } from '../world'

/** A (buy) and B (sell) linked, with the convergence timers; B posted, A did not yet. */
async function convLinked(opts: { keys?: { words: string }[] } = {}): Promise<{ w: World; A: Peer; B: Peer }> {
  const { w, A, B } = await pair({ a: { tuning: CONV }, b: { tuning: CONV }, keys: opts.keys })
  await B.a.postOffer({ side: 'sell', currency: 'KRW', amountMinor: 90_000, feePct: 3, methods: BOTH })
  await until(w, () => settled(B), 5 * MIN, "B's rounds")
  await adv(w, 30_000)
  return { w, A, B }
}

/** As convLinked, and A posted: both show each other's offer. */
async function convPair(opts: { keys?: { words: string }[] } = {}): Promise<{ w: World; A: Peer; B: Peer }> {
  const { w, A, B } = await convLinked(opts)
  await A.a.postOffer({ side: 'buy', currency: 'KRW', amountMinor: AMOUNT, feePct: FEE, methods: BOTH })
  await until(w, () => converged(A, B), 5 * MIN, 'A and B match')
  await adv(w, 30_000)
  return { w, A, B }
}

/** Offers and 'matched' markers so far, both ways. */
function exchange(w: World, A: Peer, B: Peer): string {
  return JSON.stringify([sent(w, A, B, 'offer').length, sent(w, B, A, 'offer').length, markers(A, B), markers(B, A)])
}

/** S-DLV-5: A posts again and the m3 of that round is lost. B drops A's offer; the echo reconfirm round brings both to the match. */
export async function sDlv5(): Promise<void> {
  const { w, A, B } = await convPair()
  await A.a.withdrawOffer()
  await until(w, () => !matched(B, A), MIN, 'B loses A')
  await adv(w, 5_000)
  let lost = ''
  w.hub.route = (e) => {
    if (!lost && e.from === A.pk && e.to === B.pk && e.t === 'm3') {
      lost = e.id
      return 'drop'
    }
    return 'deliver'
  }
  const t0 = w.clock.now()
  await A.a.postOffer({ side: 'buy', currency: 'KRW', amountMinor: AMOUNT, feePct: FEE, methods: BOTH })
  await until(w, () => lost !== '' && sent(w, A, B, 'offer').some((e) => e.atMs >= t0), MIN, "A's m3 is lost and A's offer went")
  await adv(w, 200)
  expect(!matched(B, A) && !(A.pk in verifiedOf(B)), 'B dropped the offer of a match it never verified')
  expect(matched(A, B) === false, 'and A has no offer of B yet')
  // The mechanism (the echo reconfirm round): A verified the match when it sent the lost m3 and waits echoWaitMs
  // for B's offer; only then does A start one reconfirm round, which is what converges.
  const m3At = (w.hub.log.find((e) => e.id === lost) as Envelope).atMs
  const echoAt = m3At + (CONV?.echoWaitMs ?? 0)
  const m1After = (from: Peer, to: Peer) => sent(w, from, to, 'm1').filter((e) => e.atMs > m3At)
  expect(w.clock.now() < echoAt - 1, `still before A's echo wait ends (${w.clock.now() - m3At} ms after the m3)`)
  await adv(w, echoAt - 1 - w.clock.now())
  expect(!converged(A, B), "no convergence before A's echo wait ends")
  expect(m1After(A, B).length === 0 && m1After(B, A).length === 0, 'no round started by either side before it')
  await until(w, () => converged(A, B), 2 * MIN, 'the echo reconfirm round brings both to the match')
  const convergedAt = w.clock.now()
  const echo = m1After(A, B)[0]
  expect(!!echo && echo.atMs >= echoAt, `A started a round once its echo wait ended (${echo ? echo.atMs - m3At : 'none'} ms after the m3)`)
  expect(!!echo && echo.atMs <= convergedAt, 'and that round came before the convergence')
  const fromB = m1After(B, A)[0]
  expect(!fromB || (echo !== undefined && fromB.atMs > echo.atMs), "B started no round before A's reconfirm round")
  await adv(w, MIN)
  expect(converged(A, B), 'and it stays')
  await finish(w)
}

/**
 * S-DLV-6: A's m3 is held. The echo reconfirm round brings both to the match meanwhile; 11 minutes later B
 * restarts and the held m3 comes. It changes nothing on B.
 */
export async function sDlv6(): Promise<void> {
  const { w, A, B } = await convLinked()
  let held = ''
  w.hub.route = (e) => {
    if (e.from === A.pk && e.to === B.pk && e.t === 'm3' && (held === '' || held === e.id)) {
      held = e.id
      return 'hold'
    }
    return 'deliver'
  }
  await A.a.postOffer({ side: 'buy', currency: 'KRW', amountMinor: AMOUNT, feePct: FEE, methods: BOTH })
  await until(w, () => held !== '', MIN, "A's m3 is held")
  await adv(w, 50)
  const atHold = JSON.stringify([verifiedOf(B), B.state().matches])
  expect(!(A.pk in verifiedOf(B)) && !matched(B, A), `with the m3 held B has not verified A (${atHold})`)
  await until(w, () => converged(A, B), 2 * MIN, 'the echo reconfirm round brings both to the match')
  await adv(w, 11 * MIN)
  await restart(B)
  await adv(w, 30_000)
  expect(converged(A, B), 'after the restart both still match')
  const before = JSON.stringify([verifiedOf(B), B.state().matches])
  expect(w.hub.release(held) === 1, 'the late m3 goes now')
  w.hub.route = () => 'deliver'
  await adv(w, 30_000)
  const after = JSON.stringify([verifiedOf(B), B.state().matches])
  expect(before === after, `the late m3 changed nothing on B (${before} / ${after})`)
  expect(converged(A, B), 'both still match')
  await finish(w)
}

/** S-DLV-7: A's withdraw is lost (a relay took it). B's reconfirm round on its return clears A. */
export async function sDlv7(): Promise<void> {
  const { w, A, B } = await convPair()
  w.hub.route = (e) => (e.from === A.pk && e.to === B.pk && e.t === 'withdraw' ? 'drop' : 'deliver')
  await A.a.withdrawOffer()
  await adv(w, 30_000)
  expect(matched(B, A), 'the withdraw was lost: B still shows A')
  expect(!(B.pk in toldOf(A)), 'a relay took it, so A owes nothing')
  const t0 = w.clock.now()
  B.engine.rearmRounds()
  await until(w, () => !matched(B, A), MIN, "B's reconfirm round clears A")
  await adv(w, 5_000)
  expect(!(A.pk in verifiedOf(B)) && !(A.pk in toldOf(B)), 'B keeps neither a match of A nor a told for A')
  expect(sent(w, B, A, 'withdraw').filter((e) => e.atMs >= t0).length === 0, 'the no-match round sends nothing')
  expect(!matched(A, B), 'A shows nothing of B')
  await finish(w)
}

/** S-DLV-8: A's withdraw is lost and A posts the other side. A's new round alone clears A on B; B sends nothing. */
export async function sDlv8(): Promise<void> {
  const { w, A, B } = await convPair()
  w.hub.route = (e) => (e.from === A.pk && e.to === B.pk && e.t === 'withdraw' ? 'drop' : 'deliver')
  const t0 = w.clock.now()
  await A.a.postOffer({ side: 'sell', currency: 'KRW', amountMinor: AMOUNT, feePct: FEE, methods: BOTH })
  await until(w, () => !matched(B, A), 2 * MIN, 'B loses A without doing anything')
  await adv(w, 30_000)
  expect(!matched(A, B), 'A does not see B')
  expect(sent(w, B, A, 'withdraw').filter((e) => e.atMs >= t0).length === 0, 'B sends A no withdraw')
  expect(!(A.pk in verifiedOf(B)) && !(A.pk in toldOf(B)), 'B keeps neither a match of A nor a told for A')
  await finish(w)
}

/**
 * S-DLV-8b: A's withdraw is lost (a relay took it) and A posts matching terms again (a new
 * offer). B still holds A's old offer, but the new one is a first receipt, so B sends its
 * own once more: both converge within minutes.
 */
export async function sDlv8b(): Promise<void> {
  const { w, A, B } = await convPair()
  w.hub.route = (e) => (e.from === A.pk && e.to === B.pk && e.t === 'withdraw' ? 'drop' : 'deliver')
  await A.a.withdrawOffer()
  await adv(w, 30_000)
  expect(matched(B, A), 'the withdraw was lost: B still shows A')
  expect(!matched(A, B), 'A shows nothing of B')
  w.hub.route = () => 'deliver'
  const t0 = w.clock.now()
  await A.a.postOffer({ side: 'buy', currency: 'KRW', amountMinor: AMOUNT, feePct: FEE, methods: BOTH })
  await until(w, () => converged(A, B), 3 * MIN, "A's new offer brings both to the match")
  expect(sent(w, B, A, 'offer').filter((e) => e.atMs >= t0).length >= 1, 'B sent its offer again')
  const offers = () => [sent(w, A, B, 'offer').length, sent(w, B, A, 'offer').length].join('/')
  const settledOffers = offers()
  await adv(w, 5 * MIN)
  expect(converged(A, B), 'and it stays')
  expect(offers() === settledOffers, `no offer ping-pong afterwards (${settledOffers} / ${offers()})`)
  await finish(w)
}

/**
 * S-DLV-RESTART-ONE: matched, A restarts. One reconfirm round at the start, none
 * more on a return within the floor, one more after it. Both still show each other's
 * current offer; no offer, no 'matched' marker, no count in the progress line is added.
 */
export async function sDlvRestartOne(): Promise<void> {
  const { w, A, B } = await convPair()
  const before = exchange(w, A, B)
  const progress = JSON.stringify([A.state().matchProgress, B.state().matchProgress])
  const t0 = w.clock.now()
  const m1s = () => sent(w, A, B, 'm1').filter((e) => e.atMs >= t0).length
  await restart(A)
  await adv(w, 2_000)
  expect(m1s() === 1, `one reconfirm round 1 at the start (${m1s()})`)
  // The floor is 5 s here (10 min in the app).
  A.engine.rearmRounds()
  await adv(w, 2_000)
  expect(m1s() === 1, `none for a return within the floor (${m1s()})`)
  await adv(w, 2_000)
  A.engine.rearmRounds()
  await adv(w, 2_000)
  expect(m1s() === 2, `a return after the floor reconfirms once more (${m1s()})`)
  await adv(w, MIN)
  expect(converged(A, B), 'both show each other')
  expect(exchange(w, A, B) === before, `no offer and no marker added (${before} / ${exchange(w, A, B)})`)
  expect(JSON.stringify([A.state().matchProgress, B.state().matchProgress]) === progress, `the progress lines count nothing twice (${progress})`)
  await finish(w)
}

/** S-DLV-RESTART-BOTH: matched, both restart at once. Their reconfirm rounds cross; both still match, nothing is added. */
export async function sDlvRestartBoth(): Promise<void> {
  const { w, A, B } = await convPair({ keys: orderedKeys(2) })
  const before = exchange(w, A, B)
  const t0 = w.clock.now()
  await Promise.all([restart(A), restart(B)])
  await adv(w, 2 * MIN)
  expect(sent(w, A, B, 'm1').some((e) => e.atMs >= t0) && sent(w, B, A, 'm1').some((e) => e.atMs >= t0), 'both reconfirmed')
  expect(converged(A, B), 'both show each other')
  expect(exchange(w, A, B) === before, `no offer and no marker added (${before} / ${exchange(w, A, B)})`)
  expect(w.hub.inbox(A.pk).length === 0 && w.hub.inbox(B.pk).length === 0, 'the inboxes are empty')
  await finish(w)
}

/**
 * S-DLV-REORDER: messages come out of order. (1) A's m3 comes 3 s late, after A's offer:
 * B drops the offer, and the rounds that follow bring both to the match. (2) A's edit
 * comes after A's withdraw: B shows nothing of A.
 */
export async function sDlvReorder(): Promise<void> {
  const { w, A, B } = await convLinked()
  let late = ''
  w.hub.route = (e) => {
    if (e.from === A.pk && e.to === B.pk && e.t === 'm3' && (late === '' || late === e.id)) {
      late = e.id
      return { delayMs: 3_000 }
    }
    return 'deliver'
  }
  await A.a.postOffer({ side: 'buy', currency: 'KRW', amountMinor: AMOUNT, feePct: FEE, methods: BOTH })
  await until(w, () => late !== '' && converged(A, B), 2 * MIN, 'both match although the m3 came after the offer')
  await adv(w, MIN)
  expect(converged(A, B), 'and stay matched')
  w.hub.route = (e) => (e.from === A.pk && e.to === B.pk && e.t === 'offer' ? { delayMs: 3_000 } : 'deliver')
  await A.a.postOffer({ side: 'buy', currency: 'KRW', amountMinor: 54_321, feePct: FEE, methods: BOTH })
  await adv(w, 100)
  await A.a.withdrawOffer()
  await adv(w, 30_000)
  expect(
    sent(w, A, B, 'offer').some((e) => e.json.includes('54321')),
    'the edit went before the withdraw',
  )
  expect(!matched(B, A) && !(A.pk in verifiedOf(B)), 'the edit that came after the withdraw shows nothing')
  expect(!(B.pk in toldOf(A)), 'A owes B nothing')
  await finish(w)
}

/** S-DLV-EDIT: B's app is closed while A edits twice; B opens and shows A's last offer, both still match. */
export async function sDlvEdit(): Promise<void> {
  const { w, A, B } = await convPair()
  const marks = [markers(A, B), markers(B, A)]
  powerOff(B)
  await A.a.postOffer({ side: 'buy', currency: 'KRW', amountMinor: 70_000, feePct: FEE, methods: BOTH })
  await adv(w, 5_000)
  await A.a.postOffer({ side: 'buy', currency: 'KRW', amountMinor: 80_000, feePct: 1.5, methods: BOTH })
  await adv(w, 5 * MIN)
  B.spawn()
  await B.engine.start()
  await until(w, () => converged(A, B), 2 * MIN, "B shows A's last offer")
  await adv(w, MIN)
  expect(offerViewOf(B, A)?.amountMinor === 80_000 && converged(A, B), 'both match, B with the last edit')
  expect(markers(A, B) === marks[0] && markers(B, A) === marks[1], 'no marker added')
  expect(w.hub.inbox(B.pk).length === 0, "B's inbox is empty")
  await finish(w)
}

/**
 * S-BOT-PROBE-SCRAPE: B starts a round with the opposite label, matches,
 * and never lets A see an offer. (가) A edits; (나) A reopens the app three times and its
 * reconfirm rounds go unanswered: no offer and no withdraw reach B, the match stays. (다) A's
 * round reaches B and matches: A's offer goes once for this offer, also after one more
 * reopen. B shows an offer (a fake one): A sends its current one and shows B.
 */
export async function sBotProbeScrape(): Promise<void> {
  const w = newWorld()
  const A = makePeer(w, 'A', { tuning: CONV })
  const B = makePeer(w, 'B', { tuning: CONV })
  await A.engine.start()
  await B.engine.start()
  await link(w, A, B)
  await adv(w, 30_000)
  let silent = false
  w.hub.route = (e) => {
    if (e.injected) return 'deliver'
    if (e.from === B.pk && e.to === A.pk && e.t === 'offer') return 'drop'
    if (silent && e.from === A.pk && e.to === B.pk && e.t === 'm1') return 'drop'
    return 'deliver'
  }
  // A's own round with B (no offer yet) ends first, so B's round is the one that matches.
  await A.a.postOffer({ side: 'buy', currency: 'KRW', amountMinor: AMOUNT, feePct: FEE, methods: BOTH })
  await until(w, () => settled(A), 5 * MIN, "A's rounds")
  await adv(w, 30_000)
  silent = true
  await B.a.postOffer({ side: 'sell', currency: 'KRW', amountMinor: 90_000, feePct: 3, methods: BOTH })
  const offerId = A.state().myOffer?.id ?? ''
  await until(w, () => verifiedOf(A)[B.pk] === offerId, 10 * MIN, 'A verified the match B started')
  await adv(w, MIN)
  const offers = () => sent(w, A, B, 'offer')
  const withdraws = () => sent(w, A, B, 'withdraw').length
  expect(offers().length === 0 && !matched(A, B), 'the answering side A sent no offer and shows none')
  // (가)
  await A.a.postOffer({ side: 'buy', currency: 'KRW', amountMinor: 54_321, feePct: 1.5, methods: BOTH })
  await adv(w, 2 * MIN)
  expect(offers().length === 0 && withdraws() === 0, `(가) the edit sends B nothing (offers ${offers().length}, withdraws ${withdraws()})`)
  // (나)
  for (let i = 1; i <= 3; i++) {
    await restart(A)
    await adv(w, 500)
    const init = Object.values(A.kv.peek<Record<string, { contactId: string; force?: boolean }>>('init') ?? {})
    const deferred = A.kv.peek<Record<string, { force?: boolean }>>('deferred') ?? {}
    expect(init.some((s) => s.contactId === B.pk && s.force) || deferred[B.pk]?.force === true, `(나) reopen ${i}: a reconfirm round with B is on`)
    await adv(w, 2 * MIN)
  }
  expect(offers().length === 0 && withdraws() === 0, `(나) reconfirm rounds send B nothing (offers ${offers().length}, withdraws ${withdraws()})`)
  expect(verifiedOf(A)[B.pk] === offerId, '(나) unanswered rounds clear no match')
  // (다)
  silent = false
  await until(w, () => offers().length > 0, 20 * MIN, "(다) A's round reaches B and matches")
  await adv(w, 2 * MIN)
  await restart(A)
  await adv(w, 2 * MIN)
  expect(offers().length === 1, `(다) A's offer went to B once for this offer (${offers().length})`)
  expect(!matched(A, B), '(다) A still shows nothing of B')
  w.hub.inject(B.pk, groupOf(A, B), JSON.stringify({ t: 'offer', offer: { side: 'sell', currency: 'KRW', amountMinor: 1, feePct: 0, methods: BOTH, createdAt: w.clock.now() } }))
  await until(w, () => matched(A, B), MIN, "A shows B once B's offer came")
  await adv(w, 5_000)
  const last = JSON.parse(offers()[offers().length - 1].json) as { offer: { amountMinor: number; feePct: number } }
  expect(offers().length === 2 && last.offer.amountMinor === 54_321 && last.offer.feePct === 1.5, `then A sends its current offer (${offers().length})`)
  expect(withdraws() === 0, 'no withdraw at any point')
  await finish(w)
}
