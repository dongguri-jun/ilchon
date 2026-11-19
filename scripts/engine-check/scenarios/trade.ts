/**
 * Engine check scenarios: trade (S-DONE-USD, S-TRD-*).
 * Run from scripts/check-engine.ts, which lists every scenario in its order.
 */
import type { Offer } from '../../../src/contracts'
import { tradeView } from '../../../src/engine/trade'
import { randomHex } from '../../../src/lib/marmot/keys'
import type { KvWrite } from '../../fake-transport'
import { buildInvoice } from '../../invoice-fixture'
import { TRADE_RATES, dones, groupOf, markers, matched, rejectOf, sentMsgs, tradePair } from '../helpers/trade'
import { DONE_NUMBERS, holdsNumber } from '../markers'
import { Fail, expect } from '../report'
import { BOTH, MIN, type Peer, type World, adv, deleteContact, finish, link, makePeer, newWorld, powerOff, restart, sent, settled, until } from '../world'

/** B-1 (a USD completion in integer cents): $2.05, then $1 done, then the rest. */
export async function sDoneUsd(): Promise<void> {
  const { w, A, B } = await tradePair({ currency: 'USD', aMinor: 205 })
  await A.a.markDone(B.pk, 100)
  const left = A.state().myOffer
  expect(left?.amountMinor === 105 && left.rev === 2, `after 100 of 205 cents the open amount is 105 at rev 2 (got ${left?.amountMinor} rev ${left?.rev})`)
  await A.a.markDone(B.pk, 105)
  expect(A.state().myOffer === null, 'after the rest the offer is withdrawn')
  await adv(w, 10_000)
  const doneAmounts = sentMsgs(w, A, B, 'done').map((m) => (m.t === 'done' ? m.amountMinor : -1))
  const offers = sentMsgs(w, A, B, 'offer').map((m) => (m.t === 'offer' ? m.offer.amountMinor : -1))
  expect(doneAmounts.includes(100) && doneAmounts.includes(105), `A sent done 100 and done 105 (${doneAmounts.join(',')})`)
  expect(offers.includes(105), `A sent B its offer of 105 (${offers.join(',')})`)
  expect(sent(w, A, B, 'withdraw').length >= 1, 'A sent withdraw at zero')
  expect(
    dones(B, A, false)
      .map((m) => m.amountMinor)
      .sort()
      .join() === '100,105',
    'B holds both completions',
  )
  // The completions leave no amount in either support log: cents and their display form,
  // found by the same hex-bounded search as every other number (the sweep looks again).
  for (const p of [A, B]) {
    const dump = p.dumpLog()
    const found = DONE_NUMBERS.filter((n) => holdsNumber(dump, n))
    expect(found.length === 0, `${p.name}'s support log holds completion amounts ${found.join(', ')}\n${dump}`)
    // Positive control: the same search on the same log with one amount written into it.
    for (const n of DONE_NUMBERS) expect(holdsNumber(`${dump}\nengine  done ${n} sent`, n), `the search finds ${n} when a line holds it`)
  }
  await finish(w)
}

/** B-2: two completions not awaited run one after the other, each on the rev the one before left. */
export async function sTrdChain(): Promise<void> {
  const { w, A, B } = await tradePair({ currency: 'USD', aMinor: 110 })
  const p1 = A.a.markDone(B.pk, 100)
  const p2 = A.a.markDone(B.pk, 10)
  const [r1, r2] = await Promise.allSettled([p1, p2])
  expect(r1.status === 'fulfilled' && r2.status === 'fulfilled', `both completions succeed (${r1.status}, ${r2.status})`)
  expect(A.state().myOffer === null, 'the offer is withdrawn after 100 + 10 of 110')
  const revs = dones(A, B, true).map((m) => m.deduct?.rev)
  expect(revs.join() === '1,2', `the records deducted from rev 1 and rev 2 (${revs.join()})`)
  await adv(w, 10_000)
  await finish(w)
}

/** B-3: more than the open amount, or not an amount: refused before anything changes. */
export async function sTrdRefuse(): Promise<void> {
  const { w, A, B } = await tradePair({ aMinor: 100 })
  const offer = JSON.stringify(A.state().myOffer)
  const room = JSON.stringify(A.state().rooms[B.pk] ?? [])
  const logLen = w.hub.log.length
  const writes = A.kv.writes.length
  expect((await rejectOf(A.a.markDone(B.pk, 300))) === 'too_much', 'more than the open amount: too_much')
  for (const bad of [0, 1.5, NaN, 1e13, 0.1 + 0.2]) {
    const why = await rejectOf(A.a.markDone(B.pk, bad))
    expect(why === 'invalid_amount', `markDone(${bad}) is invalid_amount (got ${why || 'ok'})`)
  }
  await w.clock.settle()
  expect(JSON.stringify(A.state().myOffer) === offer, 'the offer did not change')
  expect(JSON.stringify(A.state().rooms[B.pk] ?? []) === room, 'the room did not change')
  expect(w.hub.log.length === logLen, 'nothing was sent')
  expect(A.kv.writes.length === writes, 'nothing was written')
  await finish(w)
}

/** Writes of A's offer and of its room with B, in order, from index `from` on. */
function offerAndRoomWrites(A: Peer, B: Peer, from: number): string[] {
  return A.kv.writes
    .slice(from)
    .filter((x) => x.key === 'offer' || x.key === `room:${B.pk}`)
    .map((x) => (x.key === 'offer' ? 'offer' : 'rooms'))
}

/** B-4: an edit queued just before a completion: the record reaches storage before the deducted offer. */
export async function sTrdWriteOrder(): Promise<void> {
  const { w, A, B } = await tradePair({ aMinor: 100_000 })
  const w0 = A.kv.writes.length
  const cur = A.state().myOffer!
  const edit = A.a.postOffer({ side: cur.side, currency: cur.currency, amountMinor: 90_000, feePct: cur.feePct, methods: cur.methods })
  const done = A.a.markDone(B.pk, 30_000)
  await Promise.all([edit, done])
  await w.clock.settle()
  const order = offerAndRoomWrites(A, B, w0).slice(0, 3)
  expect(order.join() === 'offer,rooms,offer', `writes are offer, rooms, offer (${order.join()})`)
  const o = A.state().myOffer
  expect(o?.amountMinor === 60_000 && o.rev === 3, `the offer is 60000 at rev 3 (got ${o?.amountMinor} rev ${o?.rev})`)
  await adv(w, 10_000)
  await finish(w)
}

/** Power off at the first write of A for which `pred` holds, while `act` runs; then A starts again. */
async function crashDuring(w: World, A: Peer, pred: (x: KvWrite, value: unknown) => boolean, act: () => Promise<unknown>): Promise<void> {
  let crashed = false
  const crashP = A.kv.crashWhen(pred).then(() => {
    crashed = true
    powerOff(A)
  })
  const run = act().catch(() => {})
  await Promise.race([run, crashP])
  await w.clock.settle()
  expect(crashed, 'the crash happened at the chosen write')
  A.spawn()
  await A.engine.start()
  await adv(w, 30_000)
}

const isOfferWrite = (test: (o: Offer | null) => boolean) => (x: KvWrite, v: unknown) => x.key === 'offer' && test(v as Offer | null)
const isMyDoneWrite = (B: Peer) => (x: KvWrite, v: unknown) => x.key === `room:${B.pk}` && Array.isArray(v) && v.some((m: { kind?: string; mine?: boolean }) => m.kind === 'done' && m.mine)

/** B-5: B-4 with the power off after the edit and the record, before the deducted offer. */
export async function sTrdCrashEdit(): Promise<void> {
  const { w, A, B } = await tradePair({ aMinor: 100_000 })
  const cur = A.state().myOffer!
  await crashDuring(
    w,
    A,
    isOfferWrite((o) => o?.amountMinor === 60_000),
    async () => {
      const edit = A.a.postOffer({ side: cur.side, currency: cur.currency, amountMinor: 90_000, feePct: cur.feePct, methods: cur.methods })
      const done = A.a.markDone(B.pk, 30_000)
      await Promise.all([edit, done])
    },
  )
  const o = A.state().myOffer
  expect(o?.amountMinor === 60_000 && o.rev === 3, `after the restart the offer is 60000 at rev 3 (got ${o?.amountMinor} rev ${o?.rev})`)
  expect(dones(A, B, true).length === 1, 'one completion record of mine')
  await finish(w)
}

/** B-6, B-7: the record stored, the deduction (or the withdraw) not: the next start finishes it. */
export async function sTrdCrashDeduct(full: boolean): Promise<void> {
  const { w, A, B } = await tradePair({ aMinor: 100_000 })
  const amount = full ? 100_000 : 30_000
  const atDeduct = full ? isOfferWrite((o) => o === null) : isOfferWrite((o) => o?.amountMinor === 70_000)
  const logAt = w.hub.log.length
  await crashDuring(w, A, atDeduct, () => A.a.markDone(B.pk, amount))
  const mine = dones(A, B, true)
  expect(mine.length === 1 && mine[0].amountMinor === amount, 'one completion record of mine after the restart')
  // The record was stored 'sending', read back 'failed' and re-sent at the start
  // under its id; the crash had cut off the first send (it comes after the deduction).
  expect(mine[0].status === 'sent', `the record is 'sent' after the restart (got ${mine[0].status})`)
  const theirs = dones(B, A, false)
  expect(theirs.length === 1 && theirs[0].id === mine[0].id && theirs[0].amountMinor === amount, `B holds A's completion once, under its id (${theirs.length})`)
  if (full) {
    expect(A.state().myOffer === null, 'the full completion withdrew the offer on the next start')
    expect(
      w.hub.log.slice(logAt).some((e) => e.from === A.pk && e.to === B.pk && e.t === 'withdraw'),
      'A sent B withdraw',
    )
  } else {
    const o = A.state().myOffer
    expect(o?.amountMinor === 70_000 && o.rev === 2, `the open amount is 70000 at rev 2 (got ${o?.amountMinor} rev ${o?.rev})`)
    await until(w, () => B.state().matches.some((m) => m.contactId === A.pk && m.offer.amountMinor === 70_000), MIN, "B sees A's 70000")
    const before = JSON.stringify({ o: A.state().myOffer, r: A.state().rooms[B.pk] })
    await restart(A)
    await adv(w, 30_000)
    expect(JSON.stringify({ o: A.state().myOffer, r: A.state().rooms[B.pk] }) === before, 'another restart changes nothing')
  }
  await finish(w)
}

/** B-8: the power off at the record write itself: nothing happened, nothing was sent. */
export async function sTrdCrashRecord(): Promise<void> {
  const { w, A, B } = await tradePair({ aMinor: 100_000 })
  await crashDuring(w, A, isMyDoneWrite(B), () => A.a.markDone(B.pk, 30_000))
  const o = A.state().myOffer
  expect(o?.amountMinor === 100_000 && o.rev === 1, `the offer is unchanged (got ${o?.amountMinor} rev ${o?.rev})`)
  expect(dones(A, B, true).length === 0, 'no completion record')
  expect(sent(w, A, B, 'done').length === 0, 'no done was sent (sending comes after the record is stored)')
  await finish(w)
}

/** B-9, B-10: a received done keeps the sender's id and my clock; bad ones are dropped; a resend goes in once. */
export async function sTrdReceived(): Promise<void> {
  const { w, A, B } = await tradePair({ aMinor: 100_000 })
  const g = groupOf(B, A)
  const X = 'a'.repeat(32)
  const injectedAt = w.clock.now()
  w.hub.inject(B.pk, g, JSON.stringify({ t: 'done', id: X, amountMinor: 30000, currency: 'KRW', at: 1 }))
  await adv(w, 5_000)
  const got = dones(A, B, false)
  expect(got.length === 1 && got[0].id === X && got[0].amountMinor === 30000 && got[0].currency === 'KRW', 'the done is in the room under the id B sent')
  expect(got[0].at >= injectedAt && got[0].at <= w.clock.now(), 'its time is my clock when it arrived')
  const bad: unknown[] = [{ amountMinor: 1.5 }, { amountMinor: 0 }, { amountMinor: -1 }, { amountMinor: 1e13 }, { amountMinor: '100' }, { currency: 'EUR' }, { id: undefined }, { id: 'abc' }]
  bad.forEach((patch, i) => {
    const id = (i + 1).toString(16).padStart(32, 'b')
    w.hub.inject(B.pk, g, JSON.stringify({ t: 'done', id, amountMinor: 1000 + i, currency: 'KRW', ...(patch as object) }))
  })
  await adv(w, 5_000)
  expect(dones(A, B, false).length === 1, `none of the ${bad.length} malformed dones reached the room`)
  // B-10: the same id again, after my own completion of the same amount.
  await A.a.markDone(B.pk, 30_000)
  w.hub.inject(B.pk, g, JSON.stringify({ t: 'done', id: X, amountMinor: 30000, currency: 'KRW' }))
  await adv(w, 5_000)
  expect(dones(A, B, false).length === 1, 'the resent done (same id) is in the room once')
  expect(tradeView(A.state(), B.pk, w.clock.now()).pendingDone.length === 0, 'and it is answered: nothing pending in the trade view')
  await finish(w)
}

/** B-11: an offer with a fractional amount changes nothing. */
export async function sTrdBadOffer(): Promise<void> {
  const { w, A, B } = await tradePair({ aMinor: 100_000, bMinor: 90_000 })
  const before = JSON.stringify(A.state().matches)
  w.hub.inject(B.pk, groupOf(B, A), JSON.stringify({ t: 'offer', offer: { side: 'sell', currency: 'KRW', amountMinor: 1.5, feePct: 1, methods: BOTH, createdAt: 1 } }))
  await adv(w, 5_000)
  expect(JSON.stringify(A.state().matches) === before, 'the matches did not change')
  await finish(w)
}

/** B-12: one 'matched' marker per offer of mine and contact. */
export async function sTrdMarkers(): Promise<void> {
  // (a) and (b): a room whose last line is text gets the marker; a drop and a re-match of the same offer adds none.
  {
    const w = newWorld()
    const A = makePeer(w, 'A')
    const B = makePeer(w, 'B')
    await A.engine.start()
    await B.engine.start()
    await link(w, A, B)
    await A.a.sendChat(B.pk, 'hello')
    await adv(w, 5_000)
    await B.a.postOffer({ side: 'sell', currency: 'KRW', amountMinor: 50_000, feePct: 1, methods: BOTH })
    await A.a.postOffer({ side: 'buy', currency: 'KRW', amountMinor: 50_000, feePct: 0, methods: BOTH })
    await until(w, () => matched(A, B) && settled(A), 5 * MIN, 'first match')
    await adv(w, 10_000)
    expect(markers(A, B) === 1, `(a) one marker after the first match (${markers(A, B)})`)
    await B.a.withdrawOffer()
    await until(w, () => !matched(A, B), MIN, 'A loses B')
    await A.a.sendChat(B.pk, 'still there?')
    await adv(w, 5_000)
    await B.a.postOffer({ side: 'sell', currency: 'KRW', amountMinor: 50_000, feePct: 1, methods: BOTH })
    await until(w, () => matched(A, B), 5 * MIN, 'the same offer of A matches again')
    await adv(w, 10_000)
    expect(markers(A, B) === 1, `(b) still one marker for the same offer (${markers(A, B)})`)
    await finish(w)
  }
  // (c): the room ends with the last offer's marker; a new offer (other side) matches again: a second marker.
  {
    const { w, A, B } = await tradePair({ aSide: 'buy', aMinor: 50_000 })
    expect(markers(A, B) === 1 && (A.state().rooms[B.pk] ?? []).at(-1)?.kind === 'matched', '(c) the room ends with the marker')
    await B.a.postOffer({ side: 'buy', currency: 'KRW', amountMinor: 50_000, feePct: 1, methods: BOTH })
    await A.a.postOffer({ side: 'sell', currency: 'KRW', amountMinor: 50_000, feePct: 0, methods: BOTH })
    await until(w, () => matched(A, B) && settled(A), 5 * MIN, 'the new offers match')
    await adv(w, 10_000)
    expect(markers(A, B) === 2, `(c) a new offer gets its own marker (${markers(A, B)})`)
    await finish(w)
  }
}

/** B-13: CHAT_MAX. Longer text of mine is refused, not cut; received text is cut. */
export async function sTrdChatMax(): Promise<void> {
  const { w, A, B } = await tradePair({ aMinor: 100_000 })
  const room = JSON.stringify(A.state().rooms[B.pk] ?? [])
  const logLen = w.hub.log.length
  const why = await rejectOf(A.a.sendChat(B.pk, 'x'.repeat(2001)))
  await w.clock.settle()
  expect(why === 'too_long', `2001 characters: too_long (got ${why || 'ok'})`)
  expect(JSON.stringify(A.state().rooms[B.pk] ?? []) === room && w.hub.log.length === logLen, 'nothing appended or sent')
  await A.a.sendChat(B.pk, 'y'.repeat(2000))
  await adv(w, 5_000)
  expect(
    (B.state().rooms[A.pk] ?? []).some((m) => m.kind === 'text' && m.text === 'y'.repeat(2000)),
    '2000 characters go through whole',
  )
  w.hub.inject(B.pk, groupOf(B, A), JSON.stringify({ t: 'chat', id: randomHex(16), text: 'z'.repeat(3000) }))
  await adv(w, 5_000)
  const z = (A.state().rooms[B.pk] ?? []).find((m) => m.kind === 'text' && m.text.startsWith('zzz'))
  expect(z?.kind === 'text' && z.text.length === 2000, `a received 3000-character chat is kept as 2000 (${z?.kind === 'text' ? z.text.length : 'none'})`)
  await finish(w)
}

/**
 * Exact sums: partial completions of a large KRW
 * amount (5,000,000,000 won) and of 30 cents in 10 + 20 (the 0.1 + 0.2 case) leave
 * exactly zero, and every open amount on the way is the integer difference.
 */
export async function sTrdSums(): Promise<void> {
  {
    const { w, A, B } = await tradePair({ aMinor: 5_000_000_000 })
    const parts = [1_234_567_891, 2_000_000_000, 765_432_109, 999_999_999, 1]
    let left = 5_000_000_000
    for (const part of parts) {
      await A.a.markDone(B.pk, part)
      left -= part
      const got = A.state().myOffer?.amountMinor ?? 0
      expect(got === left, `KRW: after ${part} the open amount is ${left} (got ${got})`)
    }
    expect(A.state().myOffer === null && left === 0, 'KRW: five parts of 5,000,000,000 leave nothing')
    expect(dones(A, B, true).reduce((s, m) => s + m.amountMinor, 0) === 5_000_000_000, 'KRW: the records add up exactly')
    await adv(w, 10_000)
    await finish(w)
  }
  {
    const { w, A, B } = await tradePair({ currency: 'USD', aMinor: 30 })
    await A.a.markDone(B.pk, 10)
    expect(A.state().myOffer?.amountMinor === 20, 'USD: 30 - 10 cents is exactly 20')
    await A.a.markDone(B.pk, 20)
    expect(A.state().myOffer === null, 'USD: 10 + 20 cents is exactly the 30 offered (no 0.1 + 0.2 rest)')
    await adv(w, 10_000)
    await finish(w)
  }
}

/** B-15 (part): a deleted contact gets nothing from markDone. S-TWIN and S-LEAK cover the rest with the new names. */
export async function sTrdDeleted(): Promise<void> {
  const { w, A, B } = await tradePair({ aMinor: 100_000 })
  await deleteContact(w, A, B)
  await adv(w, 5_000)
  const logLen = w.hub.log.length
  const why = await rejectOf(A.a.markDone(B.pk, 30_000))
  await adv(w, 5_000)
  expect(why === 'no_contact', `markDone for a deleted contact: no_contact (got ${why || 'ok'})`)
  expect(w.hub.log.length === logLen, 'nothing was sent')
  await finish(w)
}

/** The trade view of x's room with y, from x's engine state as it is (rates included). */
function viewOf(w: World, x: Peer, y: Peer) {
  const s = x.state()
  if (s.rates.KRW !== TRADE_RATES.KRW || s.rates.USD !== TRADE_RATES.USD) throw new Fail(`${x.name}'s engine state has no stand-in rates (${JSON.stringify(s.rates)})`)
  return tradeView(s, y.pk, w.clock.now())
}

/** A mainnet invoice made now (expires in an hour), e.g. 'lnbc1m' for 100,000 sats. */
function invoiceNow(w: World, hrp: string): string {
  return buildInvoice(hrp, Math.floor(w.clock.now() / 1000))
}

/** The key of the card in the room message whose text is exactly `text`. */
function cardKey(x: Peer, y: Peer, text: string): string {
  const m = (x.state().rooms[y.pk] ?? []).find((k) => k.kind === 'text' && k.text === text)
  return m ? `${m.id}:0` : ''
}

/** B-14: setTradeStep is kept encrypted with the engine state and goes with the contact. */
export async function sTrdSteps(): Promise<void> {
  const { w, A, B } = await tradePair({ aSide: 'sell', aMinor: 100_000, rates: true })
  // A live card first, so the stored record names a real card (not '').
  const inv = invoiceNow(w, 'lnbc500u')
  await B.a.sendChat(A.pk, inv)
  await adv(w, 5_000)
  const key = cardKey(A, B, inv)
  expect(key !== '' && viewOf(w, A, B).activeCard === key, "B's invoice is A's active card")
  await A.a.setTradeStep(B.pk, 'verify')
  await w.clock.settle()
  const rec = A.state().tradeSteps[B.pk]
  const view = viewOf(w, A, B)
  expect(view.stepKey !== '' && rec?.step === 'verify' && rec.key === view.stepKey && rec.card === key, `the step is in the state (${JSON.stringify(rec)})`)
  expect(view.step === 'verify', 'and the view shows it')
  const stored = A.kv.peek<Record<string, { key?: string; step?: string; card?: string }>>('tradeSteps')?.[B.pk]
  expect(
    stored?.key === view.stepKey && stored.step === 'verify' && stored.card === key && Object.keys(stored).sort().join() === 'card,key,step',
    `and in the KV under tradeSteps as { key, step: 'verify', card } (${JSON.stringify(stored)})`,
  )
  await A.a.setTradeStep(B.pk, 'receive')
  await w.clock.settle()
  expect(A.state().tradeSteps[B.pk]?.step === 'verify', "'receive' (a buyer's step) is ignored for a seller")
  await restart(A)
  await until(w, () => A.state().boot === 'ready', MIN, 'A back')
  expect(A.state().tradeSteps[B.pk]?.step === 'verify' && viewOf(w, A, B).step === 'verify', 'the step survives a restart')
  await A.a.withdrawOffer()
  await A.a.setTradeStep(B.pk, 'pay')
  await w.clock.settle()
  expect(A.state().tradeSteps[B.pk]?.step === 'verify', 'without an offer nothing is stored')
  await deleteContact(w, A, B)
  await adv(w, 5_000)
  expect(A.state().tradeSteps[B.pk] === undefined, 'deleting the contact drops its step from the state')
  expect(A.kv.peek<Record<string, unknown>>('tradeSteps')?.[B.pk] === undefined, 'and from the KV')
  await finish(w)
}

/**
 * S-BOT-OFFER-SWAP: after the match B moves its premium from +1% to
 * −50% and asks for twice the sats. A's warning limit stays at A's own premium. A also
 * gets one local line about the change, which never goes on the wire.
 */
export async function sBotOfferSwap(): Promise<void> {
  const { w, A, B } = await tradePair({ aSide: 'sell', aMinor: 100_000, rates: true })
  const before = sent(w, A, B).length
  await B.a.postOffer({ side: 'buy', currency: 'KRW', amountMinor: 100_000, feePct: -50, methods: BOTH })
  await until(w, () => A.state().matches.some((m) => m.contactId === B.pk && m.offer.feePct === -50), MIN, "A sees B's new premium")
  // 100,000 won at −50% is 133,333 sats: honest at B's price, twice A's 66,667.
  const inv = invoiceNow(w, 'lnbc1340u')
  await B.a.sendChat(A.pk, inv)
  await adv(w, 5_000)
  const key = cardKey(A, B, inv)
  const v = viewOf(w, A, B)
  expect(key !== '' && v.activeCard === key, 'the invoice is the active card')
  expect(v.cards[key]?.over === true, "A's warning is on: the limit is A's own premium (68,667 sats)")
  // From A's own engine state (rate 150,000,000 won per BTC, A's premium 0%): 134,000 sats are 201,000 won.
  expect(v.cards[key]?.fiatMinor === 201_000, `the card is worth 201,000 won at A's price (${v.cards[key]?.fiatMinor})`)
  expect(v.cards[key]?.pay === true, 'B matches now, so the pay button is there')
  const changed = (A.state().rooms[B.pk] ?? []).filter((m) => m.kind === 'changed')
  expect(
    changed.length === 1 && changed[0].kind === 'changed' && changed[0].before.feePct === 1 && changed[0].after.feePct === -50 && changed[0].before.amountMinor === 100_000,
    `A's room has one line about the change (${JSON.stringify(changed)})`,
  )
  expect(!(B.state().rooms[A.pk] ?? []).some((m) => m.kind === 'changed'), "B's room has none: A changed nothing")
  expect(
    sent(w, A, B)
      .slice(before)
      .every((e) => e.t !== 'changed'),
    'the line is never sent',
  )
  // The same numbers again change nothing.
  await B.a.postOffer({ side: 'buy', currency: 'KRW', amountMinor: 100_000, feePct: -50, methods: BOTH })
  await adv(w, 10_000)
  expect((A.state().rooms[B.pk] ?? []).filter((m) => m.kind === 'changed').length === 1, 'an offer with the same numbers adds no line')
  await finish(w)
}

/** S-BOT-UNMATCHED-INVOICE: a contact that never matched sends the seller an invoice: no pay button. */
export async function sBotUnmatchedInvoice(): Promise<void> {
  const w = newWorld()
  const A = makePeer(w, 'A', { rates: TRADE_RATES })
  const C = makePeer(w, 'C', { rates: TRADE_RATES })
  await A.engine.start()
  await C.engine.start()
  await link(w, A, C)
  await A.a.postOffer({ side: 'sell', currency: 'KRW', amountMinor: 100_000, feePct: 0, methods: BOTH })
  await adv(w, 30_000)
  const inv = invoiceNow(w, 'lnbc1m')
  await C.a.sendChat(A.pk, inv)
  await adv(w, 5_000)
  const key = cardKey(A, C, inv)
  const v = viewOf(w, A, C)
  expect(key !== '' && !matched(A, C), 'the invoice arrived from a contact A never matched')
  expect(v.cards[key]?.pay === false && v.cards[key]?.state === 'inactive' && v.activeCard === '', `no pay button (${JSON.stringify(v.cards[key])})`)
  await finish(w)
}

/**
 * S-TRD-KEEP: a trade with a finished part and a live card, then 250 chat lines.
 * The card, the completion line and the marker stay; the contact's plain texts go first.
 * The invoices never reach a support log.
 */
export async function sTrdKeep(): Promise<void> {
  const { w, A, B } = await tradePair({ aSide: 'sell', aMinor: 100_000, rates: true })
  const first = invoiceNow(w, 'lnbc300u')
  await B.a.sendChat(A.pk, first)
  await adv(w, 5_000)
  await A.a.markDone(B.pk, 30_000)
  await adv(w, 5_000)
  const live = invoiceNow(w, 'lnbc400u')
  await B.a.sendChat(A.pk, live)
  await adv(w, 5_000)
  const key = cardKey(A, B, live)
  const v0 = viewOf(w, A, B)
  expect(key !== '' && v0.activeCard === key, 'the second invoice is active before the long chat')
  // A's engine state: 70,000 won left at 0%, B still offers 100,000, so the trade is 70,000
  // won (46,667 sats, limit 48,067). 40,000 sats are 60,000 won and within it.
  expect(
    v0.tradeMinor === 70_000 && v0.cards[key]?.fiatMinor === 60_000 && v0.cards[key]?.over === false,
    `the live card is 60,000 won and not over the limit (trade ${v0.tradeMinor}, ${JSON.stringify(v0.cards[key])})`,
  )
  for (let i = 0; i < 250; i++) {
    const [from, to] = i % 2 === 0 ? [B, A] : [A, B]
    await from.a.sendChat(to.pk, `line ${i}`)
    if (i % 25 === 24) await adv(w, 5_000)
  }
  await adv(w, 10_000)
  const room = A.state().rooms[B.pk] ?? []
  const v = viewOf(w, A, B)
  expect(cardKey(A, B, live) === key && v.activeCard === key && v.cards[key]?.pay === true, 'the live card is still there and active')
  expect(
    room.some((m) => m.kind === 'done' && m.mine && m.amountMinor === 30_000),
    'the completion line is still there',
  )
  expect(
    room.some((m) => m.kind === 'matched'),
    'the marker is still there',
  )
  expect(cardKey(A, B, first) !== '' && v.cards[cardKey(A, B, first)]?.state === 'inactive', 'the first (settled) card is kept too, grey')
  const texts = room.filter((m) => m.kind === 'text' && !m.text.startsWith('ln'))
  expect(texts.length <= 200 && room.length <= 250, `the room keeps its limit (${room.length}, plain ${texts.length})`)
  const mineLeft = texts.filter((m) => m.mine).length
  const theirsLeft = texts.length - mineLeft
  expect(mineLeft === 125 && theirsLeft < 125, `the contact's plain texts went first (mine ${mineLeft}, theirs ${theirsLeft})`)
  const bv = viewOf(w, B, A)
  expect(bv.activeCard === cardKey(B, A, live) && bv.cards[bv.activeCard]?.state === 'active', "B's own card is still active on B's side")
  for (const p of [A, B]) {
    const dump = p.dumpLog()
    for (const s of [first, live]) {
      expect(!dump.includes(s) && !dump.includes(s.slice(10, 40)) && !dump.toLowerCase().includes(s.slice(-30)), `${p.name}'s support log holds no invoice text`)
    }
  }
  await finish(w)
}
