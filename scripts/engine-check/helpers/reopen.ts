/**
 * Shared engine check helpers of the reopen scenarios.
 */
import { AMOUNT, FEE, dumpOf, holdsNumber } from '../markers'
import { expect } from '../report'
import { BOTH, MIN, type Peer, type World, adv, link, makePeer, newWorld, orderedKeys, sent, settled, until } from '../world'
import { CONV, converged, verifiedOf } from './delivery'
import { LIST_AB } from './recovery'
import { TRADE_RATES, matched } from './trade'

// ---------------------------------------------------------------- reopen x matching x done

/**
 * A (buy, the lower key; `aHigh`: the higher) and B (sell) matched with the convergence
 * timers; C (sell USD) linked to both and matching nobody. `pinB`: B's store is behind a PIN
 * (the auto-lock path).
 */
export async function reopenTrio(opts: { pinB?: string; aHigh?: boolean; listA?: boolean; rates?: boolean } = {}): Promise<{ w: World; A: Peer; B: Peer; C: Peer; firstAB: number; firstBA: number }> {
  const [k0, k1, kc] = orderedKeys(3)
  // A the lower key of A and B, or (aHigh) the higher.
  const [ka, kb] = opts.aHigh ? [k1, k0] : [k0, k1]
  const w = newWorld()
  // listA: A keeps its contact list on the list relays, so a restore brings B and C back.
  // rates: a price source on every side, for a payment request.
  const rates = opts.rates ? { rates: { ...TRADE_RATES } } : {}
  const A = makePeer(w, 'A', { words: ka.words, tuning: CONV, ...rates, ...(opts.listA ? { listRelays: LIST_AB } : {}) })
  const B = makePeer(w, 'B', { words: kb.words, tuning: CONV, pin: opts.pinB, ...rates })
  const C = makePeer(w, 'C', { words: kc.words, tuning: CONV, ...rates })
  for (const p of [A, B, C]) await p.engine.start()
  if (opts.pinB) await B.a.unlock(opts.pinB)
  await link(w, A, B)
  await link(w, A, C)
  await link(w, B, C)
  await adv(w, 30_000)
  await B.a.postOffer({ side: 'sell', currency: 'KRW', amountMinor: 90_000, feePct: 3, methods: BOTH })
  await C.a.postOffer({ side: 'sell', currency: 'USD', amountMinor: 50_000, feePct: 1, methods: BOTH })
  await until(w, () => settled(B) && settled(C), 5 * MIN, 'rounds of B and C')
  await A.a.postOffer({ side: 'buy', currency: 'KRW', amountMinor: AMOUNT, feePct: FEE, methods: BOTH })
  await until(w, () => converged(A, B), 5 * MIN, 'A and B match')
  await adv(w, 30_000)
  expect(C.state().matches.length === 0 && !matched(A, C) && !matched(B, C), 'C matches nobody')
  // What the first match cost (the starting side's first send and onOffer's forced first receipt): a reopen costs the same.
  return { w, A, B, C, firstAB: sent(w, A, B, 'offer').length, firstBA: sent(w, B, A, 'offer').length }
}

/** Nothing of A's or B's offer ever went to C, and C holds no trace of either. */
export function expectNoLeakToC(w: World, A: Peer, B: Peer, C: Peer): void {
  expect(sent(w, A, C, 'offer').length === 0 && sent(w, B, C, 'offer').length === 0, 'no offer ever went to C')
  const cDump = dumpOf(C)
  expect(!holdsNumber(cDump, AMOUNT) && !holdsNumber(cDump, FEE), "C holds no trace of A's amount or fee")
  expect(!(A.pk in verifiedOf(C)) && !(B.pk in verifiedOf(C)), 'C verified nobody')
  expect(!(C.pk in verifiedOf(A)) && !(C.pk in verifiedOf(B)), 'nobody verified C')
}
