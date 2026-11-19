/**
 * Engine check scenarios: payment methods and requests (PM-*, S-LEAK-METHOD).
 * Run from scripts/check-engine.ts, which lists every scenario in its order.
 */
import { isDeepStrictEqual } from 'node:util'
import type { IlchonActions, PayMethod } from '../../../src/contracts'
import { HOLDER_SCAN_TTL_MS } from '../../../src/engine/index'
import { tradeView } from '../../../src/engine/trade'
import { LnurlFailure } from '../../../src/lib/lnurl'
import { payRefOf } from '../../../src/lib/pay'
import type { Envelope } from '../../fake-transport'
import { buildInvoice } from '../../invoice-fixture'
import { CHANNEL_CHECK, chanRec, chanRoom, sameNewRoom, scanOnly } from '../helpers/channel'
import { CONV, converged, pair, toldOf, verifiedOf } from '../helpers/delivery'
import { ADDR_TR, ADDR_WPKH, LN_ADDRESS, type PayReq, myTexts, sendsOne } from '../helpers/payment'
import { rejectsWith } from '../helpers/recovery'
import { TRADE_RATES, groupOf, matched, rejectOf, tradePair } from '../helpers/trade'
import { type TwinScript, twin } from '../helpers/twin'
import { AMOUNT, FEE, dumpOf, holdsNumber } from '../markers'
import { expect } from '../report'
import { BOTH, type FakeLnurl, MIN, type Peer, type World, adv, fakeLnurl, finish, invoiceFor, link, makePeer, newWorld, orderedKeys, restart, sent, settled, until } from '../world'

// ---------------------------------------------------------------- PM-1 to PM-6, S-LEAK-METHOD

const LN_ONLY: PayMethod[] = ['lightning']
const OC_ONLY: PayMethod[] = ['onchain']

/** The methods of contact `of` as `p` holds them in its match, or null without a match. */
function methodsSeen(p: Peer, of: Peer): string | null {
  const m = p.state().matches.find((x) => x.contactId === of.pk)
  return m ? m.offer.methods.join() : null
}

/** A, B and C, each linked to the other two. */
async function triangle(): Promise<{ w: World; A: Peer; B: Peer; C: Peer }> {
  const w = newWorld()
  const A = makePeer(w, 'A')
  const B = makePeer(w, 'B')
  const C = makePeer(w, 'C')
  for (const p of [A, B, C]) await p.engine.start()
  await link(w, A, B)
  await link(w, A, C)
  await link(w, B, C)
  await adv(w, 30_000)
  return { w, A, B, C }
}

/**
 * PM-1: A buys KRW {LN}, B sells KRW {LN,OC}, C buys KRW {LN,OC}. A and B match on the
 * one method they share, B and C on both; A and C (same side) never.
 */
async function pm1Setup(): Promise<{ w: World; A: Peer; B: Peer; C: Peer }> {
  const r = await triangle()
  const { w, A, B, C } = r
  await A.a.postOffer({ side: 'buy', currency: 'KRW', amountMinor: 100_000, feePct: 1, methods: LN_ONLY })
  await B.a.postOffer({ side: 'sell', currency: 'KRW', amountMinor: 90_000, feePct: 3, methods: BOTH })
  await C.a.postOffer({ side: 'buy', currency: 'KRW', amountMinor: 50_000, feePct: 1, methods: BOTH })
  await until(w, () => matched(A, B) && matched(B, A) && matched(B, C) && matched(C, B), 10 * MIN, 'A-B and B-C match')
  await until(w, () => [A, B, C].every(settled), 10 * MIN, 'every round answered')
  await adv(w, MIN)
  return r
}

export async function pm1(): Promise<void> {
  const { w, A, B, C } = await pm1Setup()
  expect(methodsSeen(A, B) === 'lightning,onchain', `A sees B's methods as both (${methodsSeen(A, B)})`)
  expect(methodsSeen(B, A) === 'lightning', `B sees A's methods as Lightning only (${methodsSeen(B, A)})`)
  expect(methodsSeen(C, B) === 'lightning,onchain' && methodsSeen(B, C) === 'lightning,onchain', 'B and C see both methods')
  expect(!matched(A, C) && !matched(C, A), 'A and C (both buyers) do not match')
  expect(sent(w, A, C, 'offer').length === 0 && sent(w, C, A, 'offer').length === 0, 'no offer between A and C')
  await finish(w)
}

/** PM-2: A buys KRW {LN}, B sells KRW {OC}: no method in common, nothing of either reaches the other. */
export async function pm2(): Promise<void> {
  const { w, A, B } = await pair()
  await A.a.postOffer({ side: 'buy', currency: 'KRW', amountMinor: AMOUNT, feePct: FEE, methods: LN_ONLY })
  await B.a.postOffer({ side: 'sell', currency: 'KRW', amountMinor: 87_654, feePct: 3.25, methods: OC_ONLY })
  await until(w, () => settled(A) && settled(B), 10 * MIN, 'both rounds answered')
  await adv(w, 2 * MIN)
  expect(A.state().matches.length === 0 && B.state().matches.length === 0, 'no match either way')
  expect(sent(w, A, B, 'offer').length === 0 && sent(w, B, A, 'offer').length === 0, 'no offer either way')
  expect(sent(w, A, B, 'm3').length + sent(w, B, A, 'm3').length > 0, 'rounds did run to the end')
  const aDump = dumpOf(A)
  const bDump = dumpOf(B)
  expect(!holdsNumber(aDump, 87_654) && !holdsNumber(aDump, 3.25), "A holds no trace of B's amount or fee")
  expect(!holdsNumber(bDump, AMOUNT) && !holdsNumber(bDump, FEE), "B holds no trace of A's amount or fee")
  expect(!(B.pk in verifiedOf(A)) && !(A.pk in verifiedOf(B)), 'nobody verified the other')
  await finish(w)
}

/** PM-3: after PM-1, B posts the same side, currency and amount with {OC} only. */
export async function pm3(): Promise<void> {
  const { w, A, B, C } = await pm1Setup()
  const at = w.clock.now()
  await B.a.postOffer({ side: 'sell', currency: 'KRW', amountMinor: 90_000, feePct: 3, methods: OC_ONLY })
  expect(B.state().matches.length === 0, 'a change of methods starts over (a new offer, no match kept)')
  await until(w, () => matched(B, C) && matched(C, B) && settled(B), 10 * MIN, 'B and C match again')
  await adv(w, 2 * MIN)
  expect(
    sent(w, B, A, 'withdraw').some((e) => e.atMs >= at),
    'B told A to take its offer down (withdraw)',
  )
  expect(!matched(A, B) && !matched(B, A), 'A and B no longer match')
  expect(!sent(w, B, A, 'offer').some((e) => e.atMs >= at), "B's new offer never went to A")
  expect(methodsSeen(C, B) === 'onchain', `C sees B's methods as on-chain only (${methodsSeen(C, B)})`)
  expect(!(B.pk in verifiedOf(A)), 'A keeps no verified match of B')
  await finish(w)
}

/** PM-4: after PM-1, B changes only its amount: an edit, the match stays. */
export async function pm4(): Promise<void> {
  const { w, A, B } = await pm1Setup()
  const at = w.clock.now()
  const id = B.state().myOffer?.id
  await B.a.postOffer({ side: 'sell', currency: 'KRW', amountMinor: 80_000, feePct: 3, methods: BOTH })
  expect(B.state().myOffer?.id === id, 'the same offer id (an edit)')
  await until(w, () => A.state().matches.find((m) => m.contactId === B.pk)?.offer.amountMinor === 80_000, 2 * MIN, "A sees B's new amount")
  await adv(w, MIN)
  expect(!sent(w, B, A, 'withdraw').some((e) => e.atMs >= at), 'no withdraw')
  expect(methodsSeen(A, B) === 'lightning,onchain', 'the methods stay as they were')
  expect(matched(B, A), 'B still matches A')
  await finish(w)
}

/**
 * PM-4-SAME: after PM-1, B posts its offer again with nothing changed (the sheet's
 * "edit" pressed as it opened). Nothing goes out: no new rev, no offer to A or C, so the
 * matched contacts cannot tell that B used the app. A real change after it still goes out.
 */
export async function pm4Same(): Promise<void> {
  const { w, A, B, C } = await pm1Setup()
  const at = w.clock.now()
  const before = B.state().myOffer
  await B.a.postOffer({ side: 'sell', currency: 'KRW', amountMinor: 90_000, feePct: 3, methods: [...BOTH].reverse() })
  await adv(w, 2 * MIN)
  const after = B.state().myOffer
  expect(after?.id === before?.id && after?.rev === before?.rev, `the same offer and rev (${before?.rev} -> ${after?.rev})`)
  for (const X of [A, C]) {
    expect(!sent(w, B, X, 'offer').some((e) => e.atMs >= at), `no offer from B to ${X.name}`)
    expect(!sent(w, B, X, 'withdraw').some((e) => e.atMs >= at), `no withdraw from B to ${X.name}`)
  }
  expect(matched(B, A) && matched(B, C), 'B still matches A and C')
  await B.a.postOffer({ side: 'sell', currency: 'KRW', amountMinor: 90_000, feePct: 2, methods: BOTH })
  expect(B.state().myOffer?.rev === (before?.rev ?? 0) + 1, 'a real change raises rev once')
  await until(w, () => A.state().matches.find((m) => m.contactId === B.pk)?.offer.feePct === 2, 2 * MIN, "A sees B's new fee")
  await finish(w)
}

/**
 * PM-5 (aLow true and false): the twin check with a setup. A sells KRW {OC} in both
 * worlds before the split; at the split world 2's A deletes B, world 1's does nothing. B
 * then buys KRW {LN}: in world 1 a contact whose offer differs only in its method. A's
 * envelopes to B are the same in both worlds, with the same lengths.
 */
export async function pm5(aLow: boolean): Promise<void> {
  const script: TwinScript = {
    b: [
      { atMs: 0, act: (p) => p.a.postOffer({ side: 'buy', currency: 'KRW', amountMinor: 90_000, feePct: 3, methods: LN_ONLY }) },
      // Past the 15 s round deadline twice, then an hour.
      { atMs: 40_000, act: async () => {} },
      { atMs: 40_000 + 60 * MIN, act: async () => {} },
    ],
    a: [
      { atMs: 10 * MIN, act: async (p) => p.engine.rearmRounds() },
      { atMs: 20 * MIN, act: (p) => restart(p) },
    ],
  }
  const r = await twin(script, {
    aLow,
    // The setup: the same in both worlds, before the delete. Posting an offer
    // is left out of the comparison window this way, the trace allowed for a re-add by scanning.
    beforeSplit: async (w, A) => {
      await A.a.postOffer({ side: 'sell', currency: 'KRW', amountMinor: AMOUNT, feePct: FEE, methods: OC_ONLY })
      await adv(w, 15_000)
    },
  })
  const [s1, s2] = r.seqs
  const firstDiff = s1.findIndex((x, i) => x !== s2[i])
  expect(
    s1.length === s2.length && firstDiff < 0,
    `A→B envelopes differ between the worlds (world 1: ${s1.length}, world 2: ${s2.length}, first difference at ${firstDiff}: ${s1[firstDiff]} / ${s2[firstDiff]})`,
  )
  expect(
    s1.some((x) => x.startsWith('m2@')),
    'A answered B in both worlds (the comparison is not empty)',
  )
  for (let i = 0; i < 2; i++) {
    expect(r.b[i].state().matches.length === 0, `world ${i + 1}: B matches nobody`)
    expect(sent(r.worlds[i], r.a[i], r.b[i], 'offer').length === 0, `world ${i + 1}: no offer from A to B`)
  }
  for (const w of r.worlds) await finish(w)
}

/**
 * PM-WIRE (also across a tagged re-link): "no match because only the method differs" looks on the wire like
 * every other reason for no match. The same two keys in four worlds; A sells KRW {OC}, B
 * then posts (1) buy KRW {LN} (the method differs), (2) buy USD {OC} (the currency), (3)
 * sell KRW {OC} (the side), (4) buy KRW {LN,OC} (a match, the control). In (1) to (3) the
 * envelopes both ways have the same kinds, virtual times and lengths, with one method or two.
 */
export async function pmWire(): Promise<void> {
  const keys = orderedKeys(2)
  const variants: [string, Parameters<IlchonActions['postOffer']>[0]][] = [
    ['method', { side: 'buy', currency: 'KRW', amountMinor: 90_000, feePct: 3, methods: LN_ONLY }],
    ['currency', { side: 'buy', currency: 'USD', amountMinor: 90_000, feePct: 3, methods: OC_ONLY }],
    ['side', { side: 'sell', currency: 'KRW', amountMinor: 90_000, feePct: 3, methods: BOTH }],
    ['match', { side: 'buy', currency: 'KRW', amountMinor: 90_000, feePct: 3, methods: BOTH }],
  ]
  const seqs: { name: string; ab: string[]; ba: string[] }[] = []
  for (const [name, offer] of variants) {
    const { w, A, B } = await pair({ keys })
    await A.a.postOffer({ side: 'sell', currency: 'KRW', amountMinor: AMOUNT, feePct: FEE, methods: OC_ONLY })
    await adv(w, 15_000)
    const t0 = w.clock.now()
    await B.a.postOffer(offer)
    await adv(w, 40_000)
    await A.engine.rearmRounds()
    await adv(w, 10 * MIN)
    await restart(A)
    await adv(w, 30 * MIN)
    // Across a re-link (19b x 27): the lower key scans the other alone, a tagged
    // room follows at its deadline and matching starts over in it (forced rounds, echo).
    const [L, H] = A.pk < B.pk ? [A, B] : [B, A]
    const before = chanRoom(A, B)
    await scanOnly(w, L, H)
    L.a.cancelConnect()
    H.a.cancelConnect()
    await adv(w, HOLDER_SCAN_TTL_MS + 10 * MIN)
    expect(sameNewRoom(A, B, before), `${name}: the channel moved to the tagged room`)
    // And the reconfirm of an app that opens again in the new room.
    await restart(B)
    await adv(w, 10 * MIN)
    const fmt = (e: Envelope) => `${e.t}@${e.atMs - t0}:${e.json.length}`
    seqs.push({
      name,
      ab: sent(w, A, B)
        .filter((e) => e.atMs >= t0)
        .map(fmt),
      ba: sent(w, B, A)
        .filter((e) => e.atMs >= t0)
        .map(fmt),
    })
    const isMatch = name === 'match'
    expect(matched(A, B) === isMatch && matched(B, A) === isMatch, `${name}: ${isMatch ? 'a match' : 'no match'} as expected`)
    if (!isMatch) expect(sent(w, A, B, 'offer').length + sent(w, B, A, 'offer').length === 0, `${name}: no offer either way`)
    await finish(w)
  }
  const [method, ...others] = seqs.filter((x) => x.name !== 'match')
  expect(method.ab.length > 0 && method.ba.length > 0, 'the comparison is not empty')
  for (const o of others) {
    const same = (a: string[], b: string[]) => a.length === b.length && a.every((x, i) => x === b[i])
    expect(same(method.ab, o.ab), `A→B: method-only and ${o.name} differ (${method.ab.join(' ')} / ${o.ab.join(' ')})`)
    expect(same(method.ba, o.ba), `B→A: method-only and ${o.name} differ (${method.ba.join(' ')} / ${o.ba.join(' ')})`)
  }
  // The control: a match sends offers, so its sequence does differ (the check can tell).
  const control = seqs.find((x) => x.name === 'match')
  expect(!!control && control.ab.some((x) => x.startsWith('offer@')), 'the matching control sends an offer')
}

/** PM-6: a verified contact sends an offer with no method in common: it is dropped, the match stays as it was. */
export async function pm6(): Promise<void> {
  const { w, A, B } = await pair()
  await A.a.postOffer({ side: 'buy', currency: 'KRW', amountMinor: AMOUNT, feePct: FEE, methods: LN_ONLY })
  await B.a.postOffer({ side: 'sell', currency: 'KRW', amountMinor: 90_000, feePct: 3, methods: BOTH })
  await until(w, () => matched(A, B) && matched(B, A), 10 * MIN, 'A and B match')
  await adv(w, MIN)
  const before = A.state().matches.find((m) => m.contactId === B.pk)
  w.hub.inject(B.pk, groupOf(A, B), JSON.stringify({ t: 'offer', offer: { side: 'sell', currency: 'KRW', amountMinor: 1_111, feePct: 0, methods: OC_ONLY, createdAt: w.clock.now() } }))
  await adv(w, 10_000)
  const after = A.state().matches.find((m) => m.contactId === B.pk)
  expect(A.state().matches.length === 1 && !!after, "A still holds B's match")
  expect(after?.offer.methods.join() === 'lightning,onchain' && after.offer.amountMinor === 90_000, `A keeps the offer it had (${after?.offer.methods.join()}, ${after?.offer.amountMinor})`)
  expect(isDeepStrictEqual(before, after), 'the match is unchanged')
  expect(verifiedOf(A)[B.pk] === A.state().myOffer?.id, 'A keeps B in verified')
  await finish(w)
}

/**
 * PM-TOLD: B changes only its methods and still shares one
 * with A. The change goes like a change of side: a withdraw, a new round, a new match
 * carrying the new methods. Each side's offer goes once for the new offer (told),
 * and reopening both apps (reconfirm rounds) sends no offer again and keeps the match.
 */
export async function pmTold(): Promise<void> {
  const { w, A, B } = await pair({ a: { tuning: CONV }, b: { tuning: CONV } })
  await A.a.postOffer({ side: 'buy', currency: 'KRW', amountMinor: AMOUNT, feePct: FEE, methods: LN_ONLY })
  await B.a.postOffer({ side: 'sell', currency: 'KRW', amountMinor: 90_000, feePct: 3, methods: BOTH })
  await until(w, () => matched(A, B) && matched(B, A), 10 * MIN, 'A and B match')
  await adv(w, MIN)
  const at = w.clock.now()
  const oldId = B.state().myOffer?.id
  await B.a.postOffer({ side: 'sell', currency: 'KRW', amountMinor: 90_000, feePct: 3, methods: LN_ONLY })
  const newId = B.state().myOffer?.id
  expect(!!newId && newId !== oldId, 'a change of methods is a new offer id')
  await until(w, () => methodsSeen(A, B) === 'lightning' && matched(B, A), 10 * MIN, 'A and B match again on the new offer')
  await adv(w, 2 * MIN)
  expect(
    sent(w, B, A, 'withdraw').some((e) => e.atMs >= at),
    'B sent a withdraw for the old offer',
  )
  const bSent = () => sent(w, B, A, 'offer').filter((e) => e.atMs >= at)
  const bOffers = () => bSent().length
  const aOffers = () => sent(w, A, B, 'offer').filter((e) => e.atMs >= at).length
  // B started the round, so its offer goes first, and once more when A's offer first
  // comes for B's new offer (onOffer's forced send): two at most.
  expect(bOffers() >= 1 && bOffers() <= 2, `B's new offer went to A once or twice (${bOffers()})`)
  expect(
    bSent().every((e) => (JSON.parse(e.json) as { offer: { methods: string[] } }).offer.methods.join() === 'lightning'),
    'every offer B sent after the change carries its new methods',
  )
  expect(aOffers() >= 1, `A's offer went to B again for B's new offer (${aOffers()})`)
  const bBefore = bOffers()
  const aBefore = aOffers()
  await restart(A)
  await restart(B)
  await adv(w, 10 * MIN)
  expect(bOffers() === bBefore && aOffers() === aBefore, `reopening sends no offer again (B ${bOffers()}, A ${aOffers()})`)
  expect(matched(A, B) && matched(B, A) && methodsSeen(A, B) === 'lightning', 'the match stands after the reconfirm rounds')
  expect(verifiedOf(A)[B.pk] === A.state().myOffer?.id && verifiedOf(B)[A.pk] === newId, 'both verified the current offers')
  await finish(w)
}

/**
 * S-LEAK-METHOD: A buys KRW {LN}; B sells KRW {LN,OC}, C sells KRW {OC}. A matches B only.
 * A then changes only its amount (the edit path), and A and C re-link into a tagged room:
 * still nothing of A goes to C.
 */
export async function sLeakMethod(): Promise<void> {
  const AMT = 1_234_567
  const w = newWorld()
  const A = makePeer(w, 'A')
  const B = makePeer(w, 'B')
  const C = makePeer(w, 'C')
  for (const p of [A, B, C]) await p.engine.start()
  await link(w, A, B)
  await link(w, A, C)
  await adv(w, 30_000)
  await B.a.postOffer({ side: 'sell', currency: 'KRW', amountMinor: 90_000, feePct: 3, methods: BOTH })
  await C.a.postOffer({ side: 'sell', currency: 'KRW', amountMinor: 80_000, feePct: 3, methods: OC_ONLY })
  await A.a.postOffer({ side: 'buy', currency: 'KRW', amountMinor: AMT, feePct: FEE, methods: LN_ONLY })
  const aOfferId = A.state().myOffer?.id ?? ''
  await until(w, () => matched(A, B) && matched(B, A) && [A, B, C].every(settled), 10 * MIN, 'rounds done')
  await adv(w, MIN)
  // The edit path: same side, currency and methods, another amount.
  await A.a.postOffer({ side: 'buy', currency: 'KRW', amountMinor: 1_200_000, feePct: FEE, methods: LN_ONLY })
  expect(A.state().myOffer?.id === aOfferId, 'an amount change is an edit (same id)')
  await adv(w, 5 * MIN)
  // A re-link of A and C (19b x 27): the lower key scans the other alone, a tagged
  // room follows and every round with C starts over in it. Still nothing of A reaches C.
  const ac = chanRoom(A, C)
  const [L, H] = A.pk < C.pk ? [A, C] : [C, A]
  await scanOnly(w, L, H)
  L.a.cancelConnect()
  H.a.cancelConnect()
  await adv(w, HOLDER_SCAN_TTL_MS + 5 * MIN)
  expect(sameNewRoom(A, C, ac), 'A and C moved to a tagged room')
  expect(
    [...sent(w, A, C, 'm2'), ...sent(w, C, A, 'm2')].some((e) => e.groupId === chanRoom(A, C)),
    'and ran rounds in it',
  )
  expect(A.state().matches.length === 1 && matched(A, B), 'A matches B only')
  expect(B.state().matches.length === 1 && matched(B, A), 'B matches A only')
  expect(C.state().matches.length === 0, 'C matches nobody')
  expect(sent(w, A, C, 'offer').length === 0, 'no offer ever went from A to C (the edit included)')
  expect(sent(w, A, C, 'm2').length + sent(w, C, A, 'm2').length > 0, 'A and C did run rounds')
  const cDump = dumpOf(C)
  expect(!holdsNumber(cDump, AMT) && !holdsNumber(cDump, 1_200_000), "C holds no trace of A's amounts")
  expect(!cDump.includes(aOfferId), "C holds no trace of A's offer id")
  expect(!(A.pk in verifiedOf(C)), 'C keeps no verified match of A')
  await finish(w)
}
const ADDR_WSH = 'bc1qrp33g0q5c5txsp9arysrx4k6zdkfs4nce4xj0gdcccefvpysxf3qccfmv3'

/**
 * A buys KRW 300,000 at +1%, B sells KRW 150,000 at +2% with both methods, C (A's other
 * contact) buys too and never matches A. Price KRW 150,000,000. A has the fake wallet service.
 */
async function payTrio(): Promise<{ w: World; A: Peer; B: Peer; C: Peer; ln: FakeLnurl }> {
  const w = newWorld()
  const ln = fakeLnurl(w)
  const A = makePeer(w, 'A', { rates: { ...TRADE_RATES }, lnurl: ln.module })
  const B = makePeer(w, 'B', { rates: { ...TRADE_RATES } })
  const C = makePeer(w, 'C', { rates: { ...TRADE_RATES } })
  for (const p of [A, B, C]) await p.engine.start()
  await link(w, A, B)
  await link(w, A, C)
  await adv(w, 30_000)
  await B.a.postOffer({ side: 'sell', currency: 'KRW', amountMinor: 150_000, feePct: 2, methods: BOTH })
  await C.a.postOffer({ side: 'buy', currency: 'KRW', amountMinor: 50_000, feePct: 1, methods: BOTH })
  await A.a.postOffer({ side: 'buy', currency: 'KRW', amountMinor: 300_000, feePct: 1, methods: BOTH })
  await until(w, () => matched(A, B) && matched(B, A) && settled(A) && settled(B), 5 * MIN, 'A and B match')
  await adv(w, 30_000)
  expect(!matched(A, C) && !matched(C, A), 'A and C (both buyers) do not match')
  return { w, A, B, C, ln }
}

/**
 * A rejected request leaves no trace: same room, nothing new uploaded from A to anyone,
 * the same support log (no line for receiving requests or their failures).
 */
async function rejectsClean(w: World, A: Peer, B: Peer, run: () => Promise<unknown>, code: string, what: string): Promise<void> {
  const room = JSON.stringify(A.state().rooms[B.pk] ?? [])
  const chats = w.hub.log.filter((e) => e.from === A.pk && e.t === 'chat').length
  const log = A.log.lines().join('\n')
  await rejectsWith(run, code, what)
  await w.clock.settle()
  expect(JSON.stringify(A.state().rooms[B.pk] ?? []) === room, `${what}: A's room is unchanged`)
  expect(w.hub.log.filter((e) => e.from === A.pk && e.t === 'chat').length === chats, `${what}: nothing was uploaded`)
  expect(A.log.lines().join('\n') === log, `${what}: the support log is unchanged`)
}

/** PM-7: sendPaymentRequest, every check in the order it makes them. */
export async function pm7(): Promise<void> {
  const { w, A, B, C, ln } = await payTrio()
  const room = groupOf(A, B)
  expect((await rejectOf(A.a.setLightningAddress(LN_ADDRESS))) === '', 'A saves its Lightning address')

  // (1) Lightning, the agreed amount: requestSats at the seller's +2%: 98,039 sats.
  const inv = await sendsOne(w, A, B, { method: 'lightning', amountMinor: 150_000 }, '(1) Lightning 150,000 won')
  const call = ln.calls[ln.calls.length - 1]
  expect(call?.address === LN_ADDRESS && call.sats === 98_039, `(1) the wallet service was asked for 98,039 sats at the seller's premium (${JSON.stringify(call)})`)
  const ref1 = payRefOf(inv)
  expect(ref1?.kind === 'lightning' && ref1.mainnet && ref1.amountSats === 98_039, '(1) the text is one mainnet invoice for 98,039 sats')
  const bView = tradeView(B.state(), A.pk, w.clock.now())
  expect(
    bView.activeKind === 'lightning' && Object.values(bView.cards).some((c) => c.state === 'active' && c.pay && !c.over),
    "(1) B: the invoice is B's active card, payable, no amount warning (same premium as the limit)",
  )

  // (2) On-chain: the bitcoin: link carries the same sats, from the same calculation.
  const link1 = await sendsOne(w, A, B, { method: 'onchain', amountMinor: 150_000, address: ADDR_WPKH }, '(2) on-chain')
  expect(link1 === `bitcoin:${ADDR_WPKH}?amount=0.00098039`, `(2) the text is the BIP-21 link (${link1})`)
  const v2 = tradeView(B.state(), A.pk, w.clock.now())
  expect(v2.activeKind === 'onchain' && v2.receive === 'live' && v2.receiveExpiresAt === 0, '(2) B: the on-chain card is active, live, never expires')
  expect(Object.values(v2.cards).filter((c) => c.state === 'active').length === 1, '(2) one active card: the invoice went grey')

  // (3) The same address again, in capitals and with a line break after it.
  await rejectsClean(w, A, B, () => A.a.sendPaymentRequest(B.pk, { method: 'onchain', amountMinor: 150_000, address: `${ADDR_WPKH.toUpperCase()}\n` }), 'reused', '(3) the same address in capitals')
  // (4), (5)
  await rejectsWith(() => B.a.sendPaymentRequest(A.pk, { method: 'onchain', amountMinor: 150_000, address: ADDR_TR }), 'not_buyer', '(4) the seller asks')
  await rejectsClean(w, A, B, () => A.a.sendPaymentRequest(C.pk, { method: 'onchain', amountMinor: 50_000, address: ADDR_TR }), 'not_matched', '(5) a contact that does not match')
  expect((C.state().rooms[A.pk] ?? []).length === 0, '(5) C got nothing')
  // (7) More than the trade amount (the smaller offer, 150,000).
  await rejectsClean(w, A, B, () => A.a.sendPaymentRequest(B.pk, { method: 'lightning', amountMinor: 150_001 }), 'too_much', '(7) 150,001 won')
  for (const bad of [0, -1, 1.5, Number.NaN]) {
    await rejectsClean(w, A, B, () => A.a.sendPaymentRequest(B.pk, { method: 'lightning', amountMinor: bad }), 'invalid_amount', `(7) amount ${bad}`)
  }
  // (9) No Lightning address.
  await A.a.setLightningAddress(null)
  await rejectsClean(w, A, B, () => A.a.sendPaymentRequest(B.pk, { method: 'lightning', amountMinor: 1000 }), 'no_address', '(9) no Lightning address')
  await A.a.setLightningAddress(LN_ADDRESS)
  // (10) Not a mainnet address: every shape the address check refuses, and what a paste can carry.
  const notAddresses: [string, string][] = [
    ['tb1qw508d6qejxtdg4y5r3zarvary0c5xw7kxpjzsx', 'testnet'],
    ['bcrt1qw508d6qejxtdg4y5r3zarvary0c5xw7kygt080', 'regtest'],
    ['mipcBbFg9gMiCh81Kj8tqqdgoZub1ZJRfn', 'base58 testnet'],
    ['bc1qw508d6qejxtdg4y5r3zarvary0c5xw7KV8F3T4', 'mixed case'],
    [`bitcoin:${ADDR_TR}`, 'a bitcoin: link instead of an address'],
    [`lightning:${inv}`, 'an invoice'],
    [`bc1p0xlxvlhemja6c4dqv22uapctqupfhlxm9h8z3k2e72q4k9hcz7vqzk5j​j0`, 'a zero-width space inside'],
    [`bc1p0xlxvlhemja6c4dqv22uapctqupfhlxm9h8z3k2e72q4k9hcz7vqzk5jjо`, 'a Cyrillic o at the end'],
    ['ｂｃ1p0xlxvlhemja6c4dqv22uapctqupfhlxm9h8z3k2e72q4k9hcz7vqzk5jj0', 'full-width letters'],
    ['bc1p0xlxvlhemja6c4dqv22uapctqupfhlxm9h8z3k2e72q4k9hcz7vqzk5jj1', 'one checksum character changed'],
    ['', 'empty'],
  ]
  for (const [address, what] of notAddresses) {
    await rejectsClean(w, A, B, () => A.a.sendPaymentRequest(B.pk, { method: 'onchain', amountMinor: 1000, address }), 'bad-address', `(10) ${what}`)
  }
  // White space and a line break around a fresh address are a paste, not a different address.
  const link2 = await sendsOne(w, A, B, { method: 'onchain', amountMinor: 1000, address: `  ${ADDR_TR}\r\n` }, '(10) a fresh address with spaces and a line break')
  expect(link2.startsWith(`bitcoin:${ADDR_TR}?amount=`) && !/\s/.test(link2), `(10) sent trimmed (${link2})`)

  // (13) A second request while one waits for the wallet service.
  ln.delayMs = 5000
  const first = A.a.sendPaymentRequest(B.pk, { method: 'lightning', amountMinor: 10_000 })
  await w.clock.settle()
  await rejectsWith(() => A.a.sendPaymentRequest(B.pk, { method: 'onchain', amountMinor: 10_000, address: ADDR_WSH }), 'busy', '(13) a second request while the first waits')
  await adv(w, 6000)
  expect((await rejectOf(first)) === '', '(13) the first one goes')
  // (11) B takes its offer down during the wait.
  {
    const chats = w.hub.log.filter((e) => e.from === A.pk && e.t === 'chat').length
    const p = rejectOf(A.a.sendPaymentRequest(B.pk, { method: 'lightning', amountMinor: 10_000 }))
    await adv(w, 500)
    await B.a.withdrawOffer()
    await adv(w, 6000)
    expect((await p) === 'changed', '(11) the seller took the offer down meanwhile: changed')
    expect(w.hub.log.filter((e) => e.from === A.pk && e.t === 'chat').length === chats, '(11) the invoice fetched meanwhile was not sent')
    await B.a.postOffer({ side: 'sell', currency: 'KRW', amountMinor: 150_000, feePct: 2, methods: BOTH })
    await until(w, () => matched(A, B) && matched(B, A) && settled(B), 5 * MIN, 'A and B match again')
  }
  // (12) B changes only its premium during the wait (an edit: the match stays, the sats would change).
  {
    const p = rejectOf(A.a.sendPaymentRequest(B.pk, { method: 'lightning', amountMinor: 10_000 }))
    await adv(w, 500)
    await B.a.postOffer({ side: 'sell', currency: 'KRW', amountMinor: 150_000, feePct: 3, methods: BOTH })
    await adv(w, 6000)
    expect(A.state().matches.find((m) => m.contactId === B.pk)?.offer.feePct === 3, "(12) A sees B's new premium")
    expect((await p) === 'changed', '(12) the premium changed meanwhile: changed')
  }
  ln.delayMs = 0
  // (14) The wallet service refuses the amount; the reason and the limits come through, nothing else.
  ln.fail = () => new LnurlFailure('range', 1000, 50_000)
  {
    let range: { minSats?: number; maxSats?: number } = {}
    const err = await A.a.sendPaymentRequest(B.pk, { method: 'lightning', amountMinor: 10_000 }).then(
      () => '',
      (e: Error & { minSats?: number; maxSats?: number }) => ((range = e), e.message),
    )
    expect(err === 'range' && range.minSats === 1000 && range.maxSats === 50_000, `(14) range with the wallet's limits (${err} ${range.minSats}-${range.maxSats})`)
  }
  for (const code of ['unreachable', 'refused', 'mismatch'] as const) {
    ln.fail = () => new LnurlFailure(code)
    await rejectsClean(w, A, B, () => A.a.sendPaymentRequest(B.pk, { method: 'lightning', amountMinor: 10_000 }), code, `(14) the lookup fails: ${code}`)
  }
  // A failure that is not one of the codes, with server text in it, comes out as a code only.
  ln.fail = () => new Error(`server says ${LN_ADDRESS} ${ADDR_WSH}`)
  await rejectsClean(w, A, B, () => A.a.sendPaymentRequest(B.pk, { method: 'lightning', amountMinor: 10_000 }), 'unreachable', '(14) a foreign error becomes unreachable')
  ln.fail = null
  // The engine checks what the lookup gave back once more: never a card for other sats.
  const wrong: [string, (sats: number) => string][] = [
    ['one sat more', (sats) => invoiceFor(w, sats + 1)],
    ['a testnet invoice', (sats) => buildInvoice(`lntb${sats * 10}n`, Math.floor(w.clock.now() / 1000))],
    ['an invoice without an amount', () => buildInvoice('lnbc', Math.floor(w.clock.now() / 1000))],
    ['an expired invoice', (sats) => invoiceFor(w, sats, Math.floor(w.clock.now() / 1000) - 7200)],
    ['an invoice with 100 s left', (sats) => invoiceFor(w, sats, Math.floor(w.clock.now() / 1000) - 3500)],
    ['a signet invoice', (sats) => buildInvoice(`lntbs${sats * 10}n`, Math.floor(w.clock.now() / 1000))],
    ['a regtest invoice', (sats) => buildInvoice(`lnbcrt${sats * 10}n`, Math.floor(w.clock.now() / 1000))],
    ['not an invoice', () => ADDR_WSH],
    ['longer than a chat', (sats) => `${invoiceFor(w, sats)}${'q'.repeat(2100)}`],
  ]
  for (const [what, answer] of wrong) {
    ln.answer = answer
    await rejectsClean(w, A, B, () => A.a.sendPaymentRequest(B.pk, { method: 'lightning', amountMinor: 10_000 }), 'mismatch', `(14) the service answers ${what}`)
  }
  ln.answer = null

  // (15) A text that failed to send never reached the seller: the same address may go again.
  {
    w.hub.failSend = (from, _g, msg) => (from === A.pk && msg.t === 'chat' ? 'reject' : false)
    expect((await rejectOf(A.a.sendPaymentRequest(B.pk, { method: 'onchain', amountMinor: 10_000, address: ADDR_WSH }))) === '', '(15) the request is recorded')
    await until(w, () => myTexts(A, B).some((m) => m.text.includes(ADDR_WSH) && m.status === 'failed'), 30 * MIN, '(15) its send fails')
    w.hub.failSend = () => false
    const again = await sendsOne(w, A, B, { method: 'onchain', amountMinor: 10_000, address: ADDR_WSH }, '(15) the same address after a failed send')
    expect(again.startsWith(`bitcoin:${ADDR_WSH}`), '(15) it is the same address')
  }
  // (16) A room that cannot carry messages now ('stranded' included).
  w.hub.strand(room, true)
  await adv(w, 1000)
  await rejectsClean(w, A, B, () => A.a.sendPaymentRequest(B.pk, { method: 'onchain', amountMinor: 10_000, address: ADDR_TR }), 'room-unreadable', '(16) a stranded room')
  w.hub.strand(room, false)
  await adv(w, 1000)
  // A malformed request from a screen bug.
  await rejectsClean(w, A, B, () => A.a.sendPaymentRequest(B.pk, { method: 'carrier-pigeon' } as unknown as PayReq), 'method', 'an unknown method')
  // (6) B accepts Lightning only now: on-chain is not a shared method.
  await B.a.postOffer({ side: 'sell', currency: 'KRW', amountMinor: 150_000, feePct: 2, methods: LN_ONLY })
  await until(w, () => methodsSeen(A, B) === 'lightning' && settled(B), 5 * MIN, 'A and B match on Lightning only')
  await rejectsClean(w, A, B, () => A.a.sendPaymentRequest(B.pk, { method: 'onchain', amountMinor: 10_000, address: ADDR_TR }), 'method', '(6) on-chain with a Lightning-only seller')
  expect(tradeView(A.state(), B.pk, w.clock.now()).methods.join() === 'lightning', "(6) A's trade view offers Lightning only")

  // Nothing of it reached C, and C holds no address, invoice or Lightning address.
  const cDump = dumpOf(C)
  expect(!cDump.includes(ADDR_WPKH) && !cDump.includes(ADDR_TR) && !cDump.includes(LN_ADDRESS) && !cDump.includes(inv), 'C holds no address, invoice or Lightning address')
  expect(w.hub.log.filter((e) => e.from === A.pk && e.to === C.pk && e.t === 'chat').length === 0, 'no chat from A to C')
  // The Lightning address itself never leaves A (only invoices do).
  expect(
    w.hub.log.every((e) => !e.json.toLowerCase().includes(LN_ADDRESS)),
    'the Lightning address is in no uploaded message',
  )
  expect(!dumpOf(B).includes(LN_ADDRESS), 'B holds no trace of the Lightning address')
  await finish(w)

  // (8) No price for the currency: nothing to compute the sats from.
  const t = await tradePair({ aMinor: 100_000 })
  await rejectsClean(t.w, t.A, t.B, () => t.A.a.sendPaymentRequest(t.B.pk, { method: 'onchain', amountMinor: 100_000, address: ADDR_WPKH }), 'no_rate', '(8) no price')
  await finish(t.w)
}

/** PM-8: setLightningAddress. One lookup before it is kept; setSettings never changes it. */
export async function pm8(): Promise<void> {
  const w = newWorld()
  const ln = fakeLnurl(w)
  const A = makePeer(w, 'A', { lnurl: ln.module })
  await A.engine.start()
  await adv(w, 1000)
  const stored = () => A.kv.peek<{ lnAddress?: unknown }>('settings')?.lnAddress ?? null
  const log = A.log.lines().join('\n')
  for (const bad of ['Not An Address', 'alice@localhost', 'alice@1.2.3.44', 'alice@printer.local', 'alice@example.onion', 'alice@127.0.0.0x1', 'al ice@example.com', 'alice@exa​mple.com']) {
    await rejectsWith(() => A.a.setLightningAddress(bad), 'bad-address', `'${bad}'`)
  }
  expect(ln.checks.length === 0, 'a malformed address asks nobody')
  ln.checkFail = () => new LnurlFailure('unreachable')
  await rejectsWith(() => A.a.setLightningAddress(LN_ADDRESS), 'unreachable', 'the wallet service cannot be reached')
  ln.checkFail = () => new Error('server text')
  await rejectsWith(() => A.a.setLightningAddress(LN_ADDRESS), 'unreachable', 'a foreign error')
  expect(A.state().settings.lnAddress === null && stored() === null, 'nothing kept after a failed lookup')
  ln.checkFail = null
  expect((await rejectOf(A.a.setLightningAddress(' Alice@Example.COM '))) === '', 'a real address is kept')
  expect(ln.checks[ln.checks.length - 1] === LN_ADDRESS, 'the lookup asked for the normalised address')
  expect(A.state().settings.lnAddress === LN_ADDRESS && stored() === LN_ADDRESS, `normalised in memory and in the store (${String(stored())})`)
  expect((await rejectOf(A.a.setLightningAddress('ａｌｉｃｅ＠ｅｘａｍｐｌｅ．ｃｏｍ'))) === '' && A.state().settings.lnAddress === LN_ADDRESS, 'full-width letters become the same address (NFKC)')
  await A.a.setSettings({ lnAddress: 'x@y.example' } as never)
  await A.a.setSettings({ sort: 'fee' })
  expect(A.state().settings.lnAddress === LN_ADDRESS && stored() === LN_ADDRESS, 'setSettings never changes the Lightning address')
  expect((await rejectOf(A.a.setLightningAddress(null))) === '' && A.state().settings.lnAddress === null && stored() === null, 'null clears it')
  await A.a.setLightningAddress(LN_ADDRESS)
  expect(A.log.lines().join('\n') === log, 'no support log line for any of it')
  await restart(A)
  expect(A.state().settings.lnAddress === LN_ADDRESS, 'kept after a restart')
  // A stored value the lookup module does not read as an address is none.
  await A.engine.stop()
  A.kv.close(A.tag, 'stop')
  A.kv.seed('settings', { ...(A.kv.peek<Record<string, unknown>>('settings') ?? {}), lnAddress: 'alice@localhost' })
  A.spawn()
  await A.engine.start()
  expect(A.state().settings.lnAddress === null, 'a stored value that is not an address reads as none')
  expect(
    A.log.lines().every((l) => !l.includes('alice') && !l.includes('example.com')),
    'the support log names no address',
  )
  await finish(w)
}

/**
 * PM-RESEND: a request is a chat text under its record id: a relay
 * that delivers it twice, and a retry after a failed send, both leave it once in B's room,
 * so B has one card, not two.
 */
export async function pmResend(): Promise<void> {
  const { w, A, B } = await payTrio()
  w.hub.route = (e) => (e.from === A.pk && e.t === 'chat' ? 'duplicate' : 'deliver')
  const text = await sendsOne(w, A, B, { method: 'onchain', amountMinor: 10_000, address: ADDR_WPKH }, 'a request delivered twice')
  await adv(w, 10_000)
  const inB = (t: string) => (B.state().rooms[A.pk] ?? []).filter((m) => m.kind === 'text' && m.text === t).length
  expect(inB(text) === 1, `delivered twice, kept once (${inB(text)})`)
  w.hub.route = () => 'deliver'
  w.hub.failSend = (from, _g, msg) => (from === A.pk && msg.t === 'chat' ? 'timeout' : false)
  expect((await rejectOf(A.a.sendPaymentRequest(B.pk, { method: 'onchain', amountMinor: 10_000, address: ADDR_TR }))) === '', 'a request whose send times out')
  const rec = myTexts(A, B).find((m) => m.text.includes(ADDR_TR))
  await until(w, () => myTexts(A, B).find((m) => m.id === rec?.id)?.status === 'failed', 30 * MIN, 'it ends failed')
  w.hub.failSend = () => false
  await A.a.retryChat(B.pk, rec?.id ?? '')
  await until(w, () => myTexts(A, B).find((m) => m.id === rec?.id)?.status === 'sent', 5 * MIN, 'the retry is taken')
  await adv(w, 10_000)
  const copies = (B.state().rooms[A.pk] ?? []).filter((m) => m.kind === 'text' && m.id === rec?.id).length
  expect(copies === 1, `uploaded by the first try and the retry, kept once under one id (${copies})`)
  const view = tradeView(B.state(), A.pk, w.clock.now())
  expect(Object.values(view.cards).filter((c) => c.state === 'active').length === 1 && view.activeKind === 'onchain', 'B has one active card')
  await finish(w)
}

/**
 * PM-REOPEN: A's room with B is lost and the channel reopens (the told
 * rule). While the room is gone a request is refused ('room-unreadable') and nothing goes
 * into the old room; once both match again in the new room it goes there, and B's pay
 * button follows the match.
 */
export async function pmReopen(): Promise<void> {
  const { w, A, B, C } = await payTrio()
  const old = chanRoom(A, B)
  const t0 = w.clock.now()
  w.hub.loseGroup(A.pk, old)
  await w.clock.settle()
  await rejectsWith(() => A.a.sendPaymentRequest(B.pk, { method: 'onchain', amountMinor: 10_000, address: ADDR_WPKH }), 'room-unreadable', 'a request while the room is lost')
  await until(w, () => sameNewRoom(A, B, old), CHANNEL_CHECK, 'a new room')
  await until(w, () => converged(A, B), 5 * MIN, 'both match again in the new room')
  expect(toldOf(A)[B.pk]?.ok === true && toldOf(B)[A.pk]?.ok === true, "both sides' offers were taken in the new room")
  const room = chanRoom(A, B)
  await sendsOne(w, A, B, { method: 'onchain', amountMinor: 10_000, address: ADDR_WPKH }, 'a request after the reopen')
  const chats = sent(w, A, B, 'chat').filter((e) => e.atMs >= t0)
  expect(chats.length > 0 && chats.every((e) => e.groupId === room), 'every chat after the break went into the new room')
  const view = tradeView(B.state(), A.pk, w.clock.now())
  expect(view.activeKind === 'onchain' && Object.values(view.cards).some((c) => c.state === 'active' && c.pay), "B's card is active with the pay button")
  expect((C.state().rooms[A.pk] ?? []).length === 0, 'C got nothing')
  await finish(w)
}

/**
 * PM-MOVE-TAG: A buys, B sells, matched on both methods. A sends an
 * on-chain address (B's one active card, payable). A second address fails to send (the
 * relays refuse it: 'failed', never reaches B). Then the lower key of the two scans the
 * other alone: at its deadline it opens a tagged room and the other binds it by the tag
 *. In the new room: the failed text is not sent again by itself (chats
 * never are); B's view holds at most one active card at every moment, and it is the
 * address that reached B, payable only while B matches A again (never a card from before
 * the move marked payable without the match); the 'reused' check still sees the room's
 * history (the address sent before the move is refused, the failed one may go and becomes
 * the one active card); a tag move draws no reopened notice. Then the room is lost on L's
 * device and L reopens it: H binds that remote move and counts one due notice
 * HOLDER_PAIR_MS later; the active card stays the same one.
 */
export async function pmMoveTag(): Promise<void> {
  const { w, A, B, C } = await payTrio()
  const room0 = chanRoom(A, B)
  const sent1 = await sendsOne(w, A, B, { method: 'onchain', amountMinor: 10_000, address: ADDR_WPKH }, 'the first address')
  const activeOf = () => {
    const v = tradeView(B.state(), A.pk, w.clock.now())
    const act = Object.entries(v.cards).filter(([, c]) => c.state === 'active')
    return { v, act }
  }
  const textOfKey = (key: string) => {
    const id = key.slice(0, key.lastIndexOf(':'))
    const m = (B.state().rooms[A.pk] ?? []).find((x) => x.id === id)
    return m?.kind === 'text' ? m.text : ''
  }
  {
    const { act } = activeOf()
    expect(act.length === 1 && act[0][1].pay && textOfKey(act[0][0]) === sent1, 'before the move: one active card, payable')
  }
  // A second address the relays refuse.
  w.hub.failSend = (from, _g, msg) => (from === A.pk && msg.t === 'chat' ? 'reject' : false)
  void A.a.sendPaymentRequest(B.pk, { method: 'onchain', amountMinor: 10_000, address: ADDR_TR }).catch(() => {})
  await until(w, () => myTexts(A, B).some((m) => m.text.toLowerCase().includes(ADDR_TR) && m.status === 'failed'), 5 * MIN, 'the second address fails to send')
  w.hub.failSend = () => false
  const failed = myTexts(A, B).find((m) => m.text.toLowerCase().includes(ADDR_TR))
  expect(failed?.status === 'failed', `the second address failed to send (${failed?.status})`)
  const tMove = w.clock.now()
  // The lower key scans alone: a tagged room at its deadline.
  const [L, H] = A.pk < B.pk ? [A, B] : [B, A]
  await scanOnly(w, L, H)
  let most = 0
  let payableUnmatched = false
  let wrongCard = false
  await until(
    w,
    () => {
      const { act } = activeOf()
      most = Math.max(most, act.length)
      if (act.some(([, c]) => c.pay) && !matched(B, A)) payableUnmatched = true
      if (act.some(([k]) => textOfKey(k) !== sent1)) wrongCard = true
      return sameNewRoom(A, B, room0) && converged(A, B)
    },
    HOLDER_SCAN_TTL_MS,
    'the tagged room, and A and B match again in it',
  )
  expect((chanRec(H, L) as { boundBy?: string } | undefined)?.boundBy === 'tag', 'H bound the new room by its tag')
  expect(most <= 1, `never more than one active card on B (${most})`)
  expect(!payableUnmatched, "B's card was never payable while B did not match A")
  expect(!wrongCard, 'the active card is the address that reached B')
  {
    const { act } = activeOf()
    expect(act.length === 1 && act[0][1].pay && textOfKey(act[0][0]) === sent1, 'matched again: the same card, payable again')
  }
  const failedText = failed?.text ?? '\u0000'
  expect(!w.hub.log.some((e) => e.from === A.pk && e.t === 'chat' && e.json.includes(ADDR_TR)), 'the failed text was not sent again by itself')
  expect(myTexts(A, B).find((m) => m.id === failed?.id)?.status === 'failed', 'it is still marked failed')
  expect(!(B.state().rooms[A.pk] ?? []).some((m) => m.kind === 'text' && m.text === failedText), 'B never got it')
  // The room's history counts across the move ('reused').
  await rejectsWith(() => A.a.sendPaymentRequest(B.pk, { method: 'onchain', amountMinor: 10_000, address: ADDR_WPKH }), 'reused', 'the address sent before the move')
  const sent2 = await sendsOne(w, A, B, { method: 'onchain', amountMinor: 10_000, address: ADDR_TR }, 'the address that failed before')
  expect(
    sent(w, A, B, 'chat')
      .filter((e) => e.atMs >= tMove)
      .every((e) => e.groupId === chanRoom(A, B)),
    'into the new room only',
  )
  {
    const { act } = activeOf()
    expect(act.length === 1 && act[0][1].pay && textOfKey(act[0][0]) === sent2, 'the newest address is the one active card')
  }
  expect(A.engine.sizes().notices === 0 && B.engine.sizes().notices === 0, 'a tag move draws no reopened notice')
  // A remote reopen: L loses the room and opens a new one; H counts a due notice.
  await adv(w, HOLDER_SCAN_TTL_MS)
  const room1 = chanRoom(A, B)
  w.hub.loseGroup(L.pk, room1)
  await until(w, () => sameNewRoom(A, B, room1), CHANNEL_CHECK + 5 * MIN, 'L reopens the lost room')
  expect((chanRec(H, L) as { noticeAfter?: number } | undefined)?.noticeAfter !== undefined, 'H bound a remote move: its notice waits')
  await adv(w, 5 * MIN + 10_000)
  expect(H.engine.sizes().notices === 1, `H counts one due reopened notice (${H.engine.sizes().notices})`)
  await until(w, () => converged(A, B), 5 * MIN, 'A and B match again after the reopen')
  {
    const { act } = activeOf()
    expect(act.length === 1 && act[0][1].pay && textOfKey(act[0][0]) === sent2, 'after the reopen: still the one active card')
  }
  expect((C.state().rooms[A.pk] ?? []).length === 0, 'C got nothing')
  await finish(w)
}
