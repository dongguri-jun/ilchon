/**
 * Trade checks without network. Run: pnpm check:trade
 *
 * M: money in integer minor units (src/lib/money): check, parse, format, sats.
 *    The currency table itself is check-currency's.
 * T: trade bounds (src/engine/trade.ts), the pure part.
 * A: tradeView: the one active card, who may pay it, the amount line and
 *    warning, the guide. Called on plain state objects.
 * C: payment cards and board rows: the on-chain branch of
 *    payRefOf, an on-chain card in the trade view, shared methods in the view and on the board.
 *    C-7: the on-chain card's amount, link and copies from one function, and the room's
 *    words for an address (pay-copy.ts) that never speak of an invoice.
 * R: the room draws the active card even when it is older than the first 50 messages
 *    (src/screens/room/window.ts).
 * D: a completion's system line and its "Mark {amount} done too" button say the amount
 *    with one rule (systemMoney), in every language and currency.
 * Engine checks of completions run in check-engine (S-TRD-*): that file runs its
 * scenarios when it is loaded, so nothing can import it.
 */
import { readFileSync } from 'node:fs'
import type { ChatMessage, Currency, IlchonState, Match, Offer, Side, TradeStepRec, TradeView } from '../src/contracts'
import { receivePlaceSent, tradeBounds, tradeView } from '../src/engine/trade'
import { listDictionaries } from '../src/i18n'
import { bip21, btcText, onchainCardValues, parseOnchainRequest } from '../src/lib/onchain'
import { PAY_COPY, askWhereKey, onchainCardNotes, payCopy } from '../src/screens/room/pay-copy'
import '../src/screens/room/strings'
import { isPayCandidate, payRefOf, splitText } from '../src/lib/pay'
import { buildRows, feeToInput, offerFormUnchanged, onlyMethodKey, parseFee } from '../src/screens/board/format'
import { doneApplyLabel, systemMoney } from '../src/screens/room/format'
import { FIRST_SHOWN, cardMessageId, jumpStep, roomWindow, shownToReach, type RoomWindow } from '../src/screens/room/window'
import { ANDROID_KEYBOARD_BAR_ALLOWANCE, SETTLE_EVENTS, SETTLE_FRAMES, composerLift, keyboardGap, movesComposer, settleMeasure, type ComposerSample } from '../src/screens/room/keyboard-gap'
import { buildInvoice } from './invoice-fixture'
import { asksOver, fiatFor, formatFee, formatMoney, isMinor, MAX_MINOR, MINOR_PER_UNIT, minorToInput, parseMinor, sanitizeAmount, requestSats, satsFor } from '../src/lib/money'

let failed = 0
function check(name: string, ok: boolean, detail = ''): void {
  if (ok) console.log(`PASS ${name}`)
  else {
    failed++
    console.log(`FAIL ${name}${detail ? ` — ${detail}` : ''}`)
  }
}
function eq<T>(name: string, got: T, want: T): void {
  check(name, Object.is(got, want), `got ${JSON.stringify(got)}, want ${JSON.stringify(want)}`)
}

// ---------------------------------------------------------------- M isMinor

check('isMinor 1 and MAX_MINOR', isMinor(1) && isMinor(999_999_999_999) && MAX_MINOR === 999_999_999_999)
for (const bad of [0, -1, 1.5, 1e13, NaN, Infinity, '1', null, 0.1 + 0.2, MAX_MINOR + 1]) {
  check(`not isMinor(${String(bad)})`, !isMinor(bad))
}

// ---------------------------------------------------------------- M parseMinor

eq("parseMinor('1,234.50', USD)", parseMinor('1,234.50', 'USD'), 123450)
eq("parseMinor('2.05', USD)", parseMinor('2.05', 'USD'), 205)
eq("parseMinor('.5', USD)", parseMinor('.5', 'USD'), 50)
eq("parseMinor('12.', USD)", parseMinor('12.', 'USD'), 1200)
eq("parseMinor('1,234,567', KRW)", parseMinor('1,234,567', 'KRW'), 1234567)
for (const [text, c] of [
  ['', 'USD'],
  ['.', 'USD'],
  ['0', 'USD'],
  ['0.00', 'USD'],
  ['1.234', 'USD'],
  ['1.5', 'KRW'],
  ['abc', 'KRW'],
  ['-5', 'KRW'],
  ['1e3', 'KRW'],
] as [string, Currency][]) {
  check(`parseMinor(${JSON.stringify(text)}, ${c}) is NaN`, Number.isNaN(parseMinor(text, c)))
}
// Floating point never reaches the amount: 0.1 + 0.2 in cents is exactly 30.
eq('0.10 + 0.20 USD is exactly 0.30 in cents', parseMinor('0.10', 'USD') + parseMinor('0.20', 'USD'), parseMinor('0.30', 'USD'))
check('0.1 + 0.2 as floats is not 0.3 (the case integers avoid)', 0.1 + 0.2 !== 0.3)
eq("parseMinor('2.05') - parseMinor('1') is 105", parseMinor('2.05', 'USD') - parseMinor('1', 'USD'), 105)
// The .005 boundary: three decimals are no amount; the field cuts to two, never rounds up.
check("parseMinor('1.005', USD) is NaN", Number.isNaN(parseMinor('1.005', 'USD')))
eq("sanitizeAmount('1.005', USD) cuts to 1.00", sanitizeAmount('1.005', 'USD'), '1.00')
eq("parseMinor(sanitizeAmount('1.005')) is 100 cents", parseMinor(sanitizeAmount('1.005', 'USD'), 'USD'), 100)
eq("parseMinor(sanitizeAmount('0.995')) is 99 cents", parseMinor(sanitizeAmount('0.995', 'USD'), 'USD'), 99)
// Large amounts: tens of billions of won stay exact integers.
eq("parseMinor('99,999,999,999', KRW)", parseMinor('99,999,999,999', 'KRW'), 99_999_999_999)
eq("parseMinor('999,999,999,999', KRW) is MAX_MINOR", parseMinor('999,999,999,999', 'KRW'), MAX_MINOR)
check("parseMinor('1,000,000,000,000', KRW) is NaN (13 digits)", Number.isNaN(parseMinor('1,000,000,000,000', 'KRW')))
eq("parseMinor('999,999,999.99', USD)", parseMinor('999,999,999.99', 'USD'), 99_999_999_999)

{
  let bad = ''
  for (let n = 1; n <= 1_000_000 && !bad; n++) {
    if (parseMinor(minorToInput(n, 'USD'), 'USD') !== n) bad = `USD ${n} → ${minorToInput(n, 'USD')}`
    else if (parseMinor(minorToInput(n, 'KRW'), 'KRW') !== n) bad = `KRW ${n} → ${minorToInput(n, 'KRW')}`
  }
  check('parseMinor(minorToInput(n)) === n for n = 1..1,000,000 (USD and KRW)', bad === '', bad)
}
for (const n of [MAX_MINOR, 50_000_000_000, 12_345_678_901]) {
  eq(`round trip KRW ${n}`, parseMinor(minorToInput(n, 'KRW'), 'KRW'), n)
  eq(`round trip JPY ${n}`, parseMinor(minorToInput(n, 'JPY'), 'JPY'), n)
}
eq('round trip USD 99,999,999,999 cents', parseMinor(minorToInput(99_999_999_999, 'USD'), 'USD'), 99_999_999_999)

// ---------------------------------------------------------------- M format

eq('formatMoney(105, USD)', formatMoney(105, 'USD'), '$1.05')
eq('formatMoney(123456789, USD)', formatMoney(123456789, 'USD'), '$1,234,567.89')
eq('formatMoney(50000, KRW)', formatMoney(50000, 'KRW'), '₩50,000')
eq('formatMoney(5,000,000,000, KRW)', formatMoney(5_000_000_000, 'KRW'), '₩5,000,000,000')
eq('formatMoney(MAX_MINOR, KRW)', formatMoney(MAX_MINOR, 'KRW'), '₩999,999,999,999')
eq('formatMoney(99,999,999,999, USD)', formatMoney(99_999_999_999, 'USD'), '$999,999,999.99')
eq('formatFee(-0.5)', formatFee(-0.5), '−0.5%')
eq('formatFee(0)', formatFee(0), '0%')
eq('formatFee(1)', formatFee(1), '+1%')

eq('MINOR_PER_UNIT.JPY', MINOR_PER_UNIT.JPY, 1)
eq('MINOR_PER_UNIT.KRW', MINOR_PER_UNIT.KRW, 1)
eq('MINOR_PER_UNIT.USD', MINOR_PER_UNIT.USD, 100)
eq('formatMoney(50000, JPY)', formatMoney(50000, 'JPY'), '¥50,000')
eq("parseMinor('1,000', JPY)", parseMinor('1,000', 'JPY'), 1000)
check("parseMinor('1.5', JPY) is NaN", Number.isNaN(parseMinor('1.5', 'JPY')))
eq('minorToInput(1234567, JPY)', minorToInput(1234567, 'JPY'), '1,234,567')

eq('minorToInput(10000, USD)', minorToInput(10000, 'USD'), '100')
eq('minorToInput(150, USD)', minorToInput(150, 'USD'), '1.50')
eq('minorToInput(5, USD)', minorToInput(5, 'USD'), '0.05')
eq('minorToInput(1234567, KRW)', minorToInput(1234567, 'KRW'), '1,234,567')
eq("sanitizeAmount('12a3.456', USD)", sanitizeAmount('12a3.456', 'USD'), '123.45')

// ---------------------------------------------------------------- M sats

eq('fiatFor(100,000 sats, KRW 150,000,000, 0%)', fiatFor(100_000, 150_000_000, 0, 'KRW'), 150000)
eq('fiatFor with 1%', fiatFor(100_000, 150_000_000, 1, 'KRW'), 151500)
eq('satsFor(150000 KRW) at 150,000,000', Math.round(satsFor(150000, 'KRW', 150_000_000, 0)!), 100000)
eq('satsFor(10000 cents) at USD 100,000', satsFor(10000, 'USD', 100_000, 0), 100_000)
eq('fiatFor(100,000 sats, USD 100,000) is 10000 cents', fiatFor(100_000, 100_000, 0, 'USD'), 10000)
check('no rate: satsFor and fiatFor are null', satsFor(1000, 'KRW', undefined, 0) === null && fiatFor(1000, undefined, 0, 'KRW') === null)
check('a fee of -100% is no price', satsFor(1000, 'KRW', 150_000_000, -100) === null && fiatFor(1000, 150_000_000, -100, 'KRW') === null)

// requestSats: what a buyer's automatic request asks for, rounded down.
eq('requestSats(150000 KRW, 150,000,000, 0%)', requestSats(150000, 'KRW', 150_000_000, 0), 100000)
eq('requestSats(150000 KRW, 150,000,000, 2%)', requestSats(150000, 'KRW', 150_000_000, 2), 98039)
eq('requestSats(10000 cents, USD 100,000, 0%)', requestSats(10000, 'USD', 100_000, 0), 100000)
eq('requestSats(5025 cents, USD 97,123.45, 1.5%)', requestSats(5025, 'USD', 97_123.45, 1.5), 50973)
eq('requestSats(15000 JPY, 15,000,000, 0%)', requestSats(15000, 'JPY', 15_000_000, 0), 100000)
eq('requestSats with no rate', requestSats(150000, 'KRW', undefined, 0), null)
eq('requestSats(1 KRW) is below 1 sat', requestSats(1, 'KRW', 150_000_000, 0), null)
eq('requestSats with a fee of -100% (no price)', requestSats(1000, 'KRW', 150_000_000, -100), null)
eq('requestSats with rate 0', requestSats(1000, 'KRW', 0, 0), null)
eq('requestSats with NaN amount', requestSats(Number.NaN, 'KRW', 150_000_000, 0), null)
eq('requestSats past a safe integer', requestSats(999_999_999_999, 'KRW', 1e-9, 0), null)
{
  // Never above the exact value, never more than 1 sat below it (amounts where the numerator stays under 2^53).
  let bad = ''
  for (const [c, rate] of [
    ['KRW', 150_123_456],
    ['USD', 97_123.45],
    ['JPY', 15_432_100],
  ] as Array<[Currency, number]>) {
    for (const fee of [0, 1.5, 2, 5]) {
      for (let minor = 1_000; minor <= 5_000_000 && !bad; minor += 9_973) {
        const got = requestSats(minor, c, rate, fee)
        const exact = satsFor(minor, c, rate, fee)!
        if (got === null || got > exact + 1e-6 || got < Math.floor(exact) - 1) bad = `${c} ${minor} ${fee}%: ${got} vs ${exact}`
      }
    }
  }
  check('requestSats is floor of the exact value (within 1 sat, never above)', bad === '', bad)
}

// ---------------------------------------------------------------- M partial completions add up

{
  // Several partial completions: what is left is always the exact integer difference, and the parts sum to the start.
  const cases: [Currency, number, number[]][] = [
    ['KRW', 5_000_000_000, [1_234_567_891, 2_000_000_000, 765_432_109, 999_999_999, 1]],
    ['USD', 205, [100, 105]],
    ['USD', 30, [10, 20]],
    ['USD', 99_999_999_999, [33_333_333_333, 33_333_333_333, 33_333_333_333]],
    ['JPY', 123_457, [70_001, 53_455, 1]],
  ]
  for (const [c, start, parts] of cases) {
    let left = start
    let ok = true
    for (const p of parts) {
      ok &&= isMinor(p) && p <= left
      left -= p
      ok &&= left === 0 || isMinor(left)
    }
    check(`${c} ${formatMoney(start, c)} in ${parts.length} parts leaves exactly 0`, ok && left === 0 && parts.reduce((s, p) => s + p, 0) === start)
  }
}

// ---------------------------------------------------------------- T trade bounds

const OFFER: Offer = { id: 'o1', side: 'sell', currency: 'KRW', amountMinor: 100_000, feePct: 0, methods: ['lightning', 'onchain'], createdAt: 1000, rev: 1 }
let seq = 0
const pk = 'b'.repeat(64)
const matchedAt = (at: number): ChatMessage => ({ id: `m${seq++}`, contactId: pk, mine: false, kind: 'matched', at })
const text = (at: number): ChatMessage => ({ id: `t${seq++}`, contactId: pk, mine: false, kind: 'text', text: 'x', at })
const done = (mine: boolean, amountMinor: number, at: number, currency: Currency = 'KRW'): ChatMessage => ({
  id: `d${seq++}`,
  contactId: pk,
  mine,
  kind: 'done',
  amountMinor,
  currency,
  at,
})

{
  const b = tradeBounds([matchedAt(500), text(600)], OFFER)
  check("T an earlier offer's marker does not count (at < createdAt)", b.matchIdx === -1)
  check('T no offer, no marker index', tradeBounds([matchedAt(1500)], null).matchIdx === -1)
  check('T the marker of this offer counts', tradeBounds([text(1100), matchedAt(1500), text(1600)], OFFER).matchIdx === 1)
}
{
  // [marker, A, their 30k, B, my 30k]: my completion answers theirs; the trade ended at their completion.
  const b = tradeBounds([matchedAt(1500), text(1600), done(false, 30_000, 2000), text(2100), done(true, 30_000, 2200)], OFFER)
  check('T my completion answering theirs cuts at theirs', b.cut === 2 && b.theirsOpen.length === 0 && b.lastDoneAt === 2200, JSON.stringify(b))
}
{
  const b = tradeBounds([matchedAt(1500), text(1600), done(false, 30_000, 2000), text(2100), done(true, 20_000, 2200)], OFFER)
  check('T different amounts do not pair: theirs stays open, mine cuts', b.cut === 4 && b.theirsOpen.join() === '2', JSON.stringify(b))
}
{
  const b = tradeBounds([matchedAt(1500), done(false, 30_000, 2000), text(2100)], OFFER)
  check('T their completion alone does not move the cut', b.cut === -1 && b.theirsOpen.join() === '1')
}
{
  // A late "me too" for my completion of an earlier offer pairs with it, not with the new offer.
  const msgs = [matchedAt(500), done(true, 100_000, 900), done(false, 100_000, 1100)]
  check('T a late mirror of my earlier completion is not open', tradeBounds(msgs, OFFER).theirsOpen.length === 0)
  const msgs2 = [matchedAt(500), done(true, 100_000, 900), done(false, 50_000, 1100)]
  check('T a different amount in the new offer is open', tradeBounds(msgs2, OFFER).theirsOpen.join() === '2')
}
{
  const b = tradeBounds([matchedAt(1500), done(false, 105, 2000, 'USD')], OFFER)
  check('T a completion in another currency is not counted', b.theirsOpen.length === 0)
}

// ---------------------------------------------------------------- M the over-amount limit (integers)

// biome-ignore lint/complexity/noUselessLoneBlockStatements: the block groups one section of checks and keeps its names local
{
  // Trade 100,000 won at 150,000,000 won/BTC, premium 0: 66,666.67 sats, limit × 1.03 = 68,666.67.
  check('over: 68,666 sats is within the limit', !asksOver(68_666, 100_000, 'KRW', 150_000_000, 0))
  check('over: 68,667 sats is over the limit', asksOver(68_667, 100_000, 'KRW', 150_000_000, 0))
  // $100 at $100,000/BTC: exactly 100,000 sats; the limit is exactly 103,000 (floats make it 103,000.00000000001).
  check('over: exactly on the limit (103,000) is not over', !asksOver(103_000, 10_000, 'USD', 100_000, 0))
  check('over: one sat above (103,001) is over', asksOver(103_001, 10_000, 'USD', 100_000, 0))
  // $1.90 at $100,000/BTC: exactly 1,900 sats, the limit exactly 1,957. In floats the limit
  // comes out as 1,956.9999999999998, so a float comparison would flag the honest 1,957.
  check('over: $1.90, exactly on the limit (1,957 sats) is not over', !asksOver(1_957, 190, 'USD', 100_000, 0) && asksOver(1_958, 190, 'USD', 100_000, 0))
  check('over: (the float formula gets 1,957 wrong, the case integers avoid)', 1_957 > satsFor(190, 'USD', 100_000, 0)! * 1.03)
  // JPY, premium +2%: 1,000,000 yen at 15,000,000 yen/BTC → 6,666,666.67 / 1.02 = 6,535,947.7; × 1.03 = 6,732,026.1.
  check('over: JPY +2% just under', !asksOver(6_732_026, 1_000_000, 'JPY', 15_000_000, 2))
  check('over: JPY +2% just over', asksOver(6_732_027, 1_000_000, 'JPY', 15_000_000, 2))
  // A negative premium of the seller raises the sats the seller expects, and the limit with it.
  check('over: seller premium −50% doubles the limit', !asksOver(137_333, 100_000, 'KRW', 150_000_000, -50) && asksOver(137_334, 100_000, 'KRW', 150_000_000, -50))
  check('over: no rate, no warning', !asksOver(10 ** 9, 100_000, 'KRW', undefined, 0))
  // $99,999.50/BTC: $100 is 100,000.5 sats, the limit 103,000.515…
  check('over: a fractional rate counts', !asksOver(103_000, 10_000, 'USD', 99_999.5, 0) && asksOver(103_001, 10_000, 'USD', 99_999.5, 0))
  check('over: a premium of −100% is no price', !asksOver(10 ** 9, 100_000, 'KRW', 150_000_000, -100))
}

// ---------------------------------------------------------------- A tradeView

{
  const T = 1_700_000_000
  const NOW = (T + 100) * 1000
  const PEER = 'c'.repeat(64)
  const inv = (hrp: string, at = T) => buildInvoice(hrp, at)
  const A = inv('lnbc1m') // 100,000 sats
  const B = inv('lnbc1m', T + 1)
  const C = inv('lnbc1m', T + 2)
  const I700 = inv('lnbc700u') // 70,000
  const I680 = inv('lnbc680u') // 68,000
  const I300 = inv('lnbc300u') // 30,000
  const NOAMT = inv('lnbc')
  const TEST = inv('lntb1m')
  let n = 0
  const id = () => `x${(n++).toString().padStart(3, '0')}`
  type Opts = { at?: number; status?: 'sending' | 'sent' | 'failed' }
  const theirs = (body: string, o: Opts = {}): ChatMessage => ({ id: id(), contactId: PEER, mine: false, kind: 'text', text: body, at: o.at ?? 1600 })
  const mineText = (body: string, o: Opts = {}): ChatMessage => ({ id: id(), contactId: PEER, mine: true, kind: 'text', text: body, at: o.at ?? 1600, ...(o.status ? { status: o.status } : {}) })
  const mk = (at = 1500): ChatMessage => ({ id: id(), contactId: PEER, mine: false, kind: 'matched', at })
  let doneAt = 2000
  const dn = (mine: boolean, amountMinor: number, currency: Currency = 'KRW', at?: number): ChatMessage => ({
    id: id(),
    contactId: PEER,
    mine,
    kind: 'done',
    amountMinor,
    currency,
    at: at ?? doneAt++,
  })

  const sellOffer = (o: Partial<Offer> = {}): Offer => ({
    id: 'mine',
    side: 'sell',
    currency: 'KRW',
    amountMinor: 100_000,
    feePct: 0,
    methods: ['lightning', 'onchain'],
    createdAt: 1000,
    rev: 1,
    ...o,
  })
  const theirMatch = (o: { side?: Side; currency?: Currency; amountMinor?: number; feePct?: number } = {}): Match => ({
    contactId: PEER,
    offer: { side: o.side ?? 'buy', currency: o.currency ?? 'KRW', amountMinor: o.amountMinor ?? 100_000, feePct: o.feePct ?? 1, methods: ['lightning', 'onchain'], createdAt: 900 },
  })
  type S = Pick<IlchonState, 'myOffer' | 'matches' | 'rooms' | 'rates' | 'tradeSteps'>
  const state = (messages: ChatMessage[], o: { offer?: Offer | null; matches?: Match[]; rates?: IlchonState['rates']; step?: TradeStepRec } = {}): S => ({
    myOffer: o.offer === undefined ? sellOffer() : o.offer,
    matches: o.matches ?? [theirMatch()],
    rooms: { [PEER]: messages },
    rates: o.rates ?? { KRW: 150_000_000, USD: 100_000 },
    tradeSteps: o.step ? { [PEER]: o.step } : {},
  })
  const view = (s: S, now = NOW): TradeView => tradeView(s, PEER, now)
  /** The key of the first card in message m. */
  const key = (m: ChatMessage, part = 0) => `${m.id}:${part}`
  const stateOf = (v: TradeView, m: ChatMessage, part = 0) => v.cards[key(m, part)]?.state

  // A-1
  const a = theirs(A)
  {
    const v = view(state([mk(), a]))
    check('A-1 [match, their A]: A active, pay', stateOf(v, a) === 'active' && v.cards[key(a)].pay && v.activeCard === key(a))
    check("A-1 receive 'live', step 'account'", v.receive === 'live' && v.step === 'account' && v.receiveExpiresAt === T + 3600, `${v.receive} ${v.step}`)
  }
  // A-2: a new card greys the earlier one automatically.
  const b = theirs(B)
  {
    const v = view(state([mk(), a, b]))
    check('A-2 then B: A inactive, B active, one pay button', stateOf(v, a) === 'inactive' && stateOf(v, b) === 'active' && Object.values(v.cards).filter((c) => c.pay).length === 1)
  }
  // A-3: my completion ends the trade.
  const myDone = dn(true, 30_000)
  {
    const before = view(state([mk(), a, b]))
    const v = view(state([mk(), a, b, myDone]))
    check('A-3 after my completion: A, B inactive, no active card', stateOf(v, a) === 'inactive' && stateOf(v, b) === 'inactive' && v.activeCard === '')
    check("A-3 receive 'none', step 'agree', stepKey changed", v.receive === 'none' && v.step === 'agree' && v.stepKey !== before.stepKey)
    check(
      'A-3 no pay button anywhere after done',
      Object.values(v.cards).every((c) => !c.pay),
    )
  }
  // A-4, A-5: a settled request never comes back; a new one is active.
  {
    const again = theirs(A)
    const v = view(state([mk(), a, b, myDone, again]))
    check('A-4 the same invoice again after done: inactive', stateOf(v, again) === 'inactive' && v.activeCard === '')
    const c = theirs(C)
    const v2 = view(state([mk(), a, b, myDone, c]))
    check('A-5 a new C after done: active', stateOf(v2, c) === 'active')
    const again2 = theirs(A)
    const v3 = view(state([mk(), a, b, myDone, c, again2]))
    check('A-5 [… done, C, A again]: C active, A again inactive', stateOf(v3, c) === 'active' && stateOf(v3, again2) === 'inactive')
  }
  // A-6
  {
    const a1 = theirs(A)
    const b1 = theirs(B)
    const v = view(state([mk(), a1, dn(false, 30_000), b1, dn(true, 30_000)]))
    check(
      "A-6 answering their completion: A inactive, B active, step 'account', nothing pending",
      stateOf(v, a1) === 'inactive' && stateOf(v, b1) === 'active' && v.step === 'account' && v.pendingDone.length === 0,
    )
  }
  // A-7
  {
    const a1 = theirs(A)
    const b1 = theirs(B)
    const c1 = theirs(C)
    const v = view(state([mk(), a1, dn(false, 30_000), b1, dn(false, 30_000), c1, dn(true, 30_000), dn(true, 30_000)]))
    check('A-7 two of theirs answered: A, B inactive, C active', stateOf(v, a1) === 'inactive' && stateOf(v, b1) === 'inactive' && stateOf(v, c1) === 'active')
  }
  // A-8
  {
    const a1 = theirs(A)
    const b1 = theirs(B)
    const theirsDone = dn(false, 30_000)
    const v = view(state([mk(), a1, theirsDone, b1, dn(true, 20_000)]))
    check(
      'A-8 different amounts: A, B inactive, their 30,000 pending',
      stateOf(v, a1) === 'inactive' && stateOf(v, b1) === 'inactive' && v.pendingDone.length === 1 && v.pendingDone[0].messageId === theirsDone.id && v.pendingDone[0].amountMinor === 30_000,
    )
  }
  // A-9: their completion alone never takes my button away.
  {
    const a1 = theirs(A)
    const v = view(state([mk(), dn(false, 30_000), a1, dn(true, 30_000)]))
    check('A-9 their completion before the card, then mine: A still active', stateOf(v, a1) === 'active')
    const b1 = theirs(B)
    const v2 = view(state([mk(), dn(false, 30_000), a1, dn(true, 30_000), b1]))
    check('A-9 then B: B active, A inactive', stateOf(v2, b1) === 'active' && stateOf(v2, a1) === 'inactive')
    const v3 = view(state([mk(), a1, dn(false, 30_000)]))
    check('A-9 their completion after my card does not cut: A active, pay', stateOf(v3, a1) === 'active' && v3.cards[key(a1)].pay)
  }
  // A-10: no marker and no match: no trade.
  {
    const a1 = theirs(A)
    const v = view(state([a1], { matches: [] }))
    check('A-10 no marker, no match: inactive, no active card', stateOf(v, a1) === 'inactive' && v.activeCard === '' && !v.cards[key(a1)].pay)
    const v2 = view(state([a1]))
    check('A-10 matched now, no marker: active', stateOf(v2, a1) === 'active' && v2.cards[key(a1)].pay)
  }
  // A-11: The match goes: the card stays active, the pay button goes; it comes back with the match.
  {
    const a1 = theirs(I700)
    const v = view(state([mk(), a1], { matches: [] }))
    check('A-11 match gone: A active, pay false, tradeMinor null', stateOf(v, a1) === 'active' && !v.cards[key(a1)].pay && v.tradeMinor === null && v.theirOffer === null)
    check("A-11 the warning's limit is my own amount then (70,000 sats over 100,000 won's 68,667)", v.cards[key(a1)].over)
    check("A-11 receive still 'live' (QR and copy stay)", v.receive === 'live')
    const v2 = view(state([mk(), a1]))
    check('A-11 the match back: pay true', v2.cards[key(a1)].pay)
    // A match in another currency or the same side is not this trade's.
    const v3 = view(state([mk(), a1], { matches: [theirMatch({ currency: 'USD' })] }))
    check('A-11 a match entry with another currency: no theirOffer, the button follows the entry', v3.theirOffer === null && v3.cards[key(a1)].pay)
  }
  // A-12: order only; message times and the contact's clock never decide.
  {
    const x = theirs(A)
    const y = theirs(B)
    const v = view(state([x, mk(), y]))
    check('A-12 [X, match, Y]: X inactive, Y active', stateOf(v, x) === 'inactive' && stateOf(v, y) === 'active')
    const x2 = theirs(A, { at: 9_999_999_999_999 })
    const y2 = theirs(B, { at: 0 })
    const v2 = view(state([x2, mk(), y2]))
    check('A-12 with Y at 0 and X in the future: the same', stateOf(v2, x2) === 'inactive' && stateOf(v2, y2) === 'active')
    const v3 = view(state([theirs(A), mk()]))
    check('A-12 [X, match]: a card from before the marker is never active', v3.activeCard === '' && v3.receive === 'none' && Object.values(v3.cards).every((c) => c.state === 'inactive' && !c.pay))
  }
  // A-13: I buy.
  {
    const buy = sellOffer({ side: 'buy' })
    const m = [theirMatch({ side: 'sell' })]
    const t1 = theirs(A)
    const v = view(state([mk(), t1], { offer: buy, matches: m }))
    check("A-13 buyer: the contact's card is notPayer", stateOf(v, t1) === 'notPayer' && !v.cards[key(t1)].pay)
    const own = mineText(A)
    const v2 = view(state([mk(), own], { offer: buy, matches: m }))
    check("A-13 buyer: my card is active, no pay, receive 'live', step 'transfer'", stateOf(v2, own) === 'active' && !v2.cards[key(own)].pay && v2.receive === 'live' && v2.step === 'transfer')
    check('A-13 buyer: my card larger than the trade is not flagged', v2.cards[key(own)].over === false)
    const sending = mineText(B, { status: 'sending' })
    const v3 = view(state([mk(), own, sending], { offer: buy, matches: m }))
    check("A-13 buyer: a card still 'sending' is the active one", stateOf(v3, sending) === 'active' && stateOf(v3, own) === 'inactive')
    const failedCard = mineText(B, { status: 'failed' })
    const v4 = view(state([mk(), own, failedCard], { offer: buy, matches: m }))
    check("A-13 buyer: a 'failed' card is inactive and the one before is active again", stateOf(v4, failedCard) === 'inactive' && stateOf(v4, own) === 'active')
    // As the seller: my own cards are never the buyer's.
    const v5 = view(state([mk(), mineText(A)]))
    check('A-13 seller: a card I sent is inactive', v5.activeCard === '')
  }
  // A-14: no offer.
  {
    const t1 = theirs(A)
    const v = view(state([mk(), t1], { offer: null }))
    check('A-14 no offer: inactive, no steps, step null', stateOf(v, t1) === 'inactive' && v.steps.length === 0 && v.step === null && v.doneSuggestionMinor === null && v.pendingDone.length === 0)
  }
  // A-15: over, the seller's own premium only.
  {
    const c700 = theirs(I700)
    const c680 = theirs(I680)
    const c300 = theirs(I300)
    const over = (c: ChatMessage, matches?: Match[]) => view(state([mk(), c], { matches })).cards[key(c)].over
    check('A-15 70,000 sats over a 100,000-won trade (limit 68,667): flagged', over(c700))
    check('A-15 68,000: not flagged', !over(c680))
    check('A-15 30,000 (a partial trade): not flagged', !over(c300))
    check('A-15 their premium −50% does not widen my limit', over(c700, [theirMatch({ feePct: -50 })]))
    check('A-15 a smaller trade amount lowers the limit (their 50,000 won: 34,333)', over(c680, [theirMatch({ amountMinor: 50_000 })]))
    // The limit right on its integer edge.
    const edge = theirs(inv('lnbc686670n')) // 68,667 sats
    const under = theirs(inv('lnbc686660n')) // 68,666 sats
    check('A-15 68,667 sats is over, 68,666 is not', over(edge) && !over(under))
  }
  // A-16, A-17
  {
    const c = theirs(A)
    const v = view(state([mk(), c]))
    check('A-16 fiatMinor of 100,000 sats at my price (0%): 150,000 won', v.cards[key(c)].fiatMinor === 150_000)
    const v2 = view(state([mk(), c], { rates: {} }))
    check('A-16 no rate: fiatMinor null, over false, sats null', v2.cards[key(c)].fiatMinor === null && !v2.cards[key(c)].over && v2.sats === null)
    check('A-16 no rate: the pay button stays', v2.cards[key(c)].pay)
    const na = theirs(NOAMT)
    const v3 = view(state([mk(), na]))
    check('A-17 no amount: active, fiatMinor null, over false', stateOf(v3, na) === 'active' && v3.cards[key(na)].fiatMinor === null && !v3.cards[key(na)].over)
    const v4 = view(state([mk(), theirs(I300)]))
    check('A-16 only the active card has a fiat value', Object.values(view(state([mk(), theirs(A), theirs(I300)])).cards).filter((x) => x.fiatMinor !== null).length === 1 && v4.sats !== null)
  }
  // A-18: expired.
  {
    const c = theirs(A)
    const v = view(state([mk(), c]), (T + 3600) * 1000)
    check("A-18 expired: receive 'expired', expiresAt 0, still active, step 'account'", v.receive === 'expired' && v.receiveExpiresAt === 0 && stateOf(v, c) === 'active' && v.step === 'account')
  }
  // A-19: testnet last.
  {
    const c = theirs(A)
    const tn = theirs(TEST)
    const v = view(state([mk(), c, tn]))
    check("A-19 a testnet card last: it is active, the mainnet one inactive, receive 'none'", stateOf(v, tn) === 'active' && stateOf(v, c) === 'inactive' && v.receive === 'none')
  }
  // A-20: two cards in one message.
  {
    const two = theirs(`${A} ${B}`)
    const v = view(state([mk(), two]))
    check('A-20 two cards in one message: keys :0 and :2, the later active', v.cards[`${two.id}:0`]?.state === 'inactive' && v.cards[`${two.id}:2`]?.state === 'active')
  }
  // A-21: USD.
  {
    const offer = sellOffer({ currency: 'USD', amountMinor: 205 })
    const m = [theirMatch({ currency: 'USD', amountMinor: 105 })]
    const v = view(state([mk()], { offer, matches: m }))
    check('A-21 USD 205 and 105: tradeMinor 105', v.tradeMinor === 105)
    const v2 = view(state([mk(), dn(false, 105, 'USD'), dn(true, 105, 'USD')], { offer, matches: m }))
    check('A-21 their 105 and my 105: nothing pending', v2.pendingDone.length === 0)
    const t2 = dn(false, 105, 'USD')
    const v3 = view(state([mk(), dn(false, 105, 'USD'), t2, dn(true, 105, 'USD')], { offer, matches: m }))
    check('A-21 two of theirs, one of mine: the later one is pending', v3.pendingDone.length === 1 && v3.pendingDone[0].messageId === t2.id)
    const v4 = view(state([mk(), dn(false, 30_000, 'KRW')], { offer, matches: m }))
    check('A-21 a completion in another currency is not pending', v4.pendingDone.length === 0)
    const v5 = view(state([mk(), dn(false, 500, 'USD')], { offer, matches: m }))
    check('A-21 their completion over my open amount: prefill is my open amount', v5.pendingDone[0]?.prefillMinor === 205 && v5.pendingDone[0]?.amountMinor === 500)
    check('A-21 the done sheet suggests their amount, capped', v5.doneSuggestionMinor === 205 && v.doneSuggestionMinor === 105)
  }
  // A-22: the stored guide step.
  {
    const c = theirs(A)
    const base = view(state([mk(), c]))
    const keep: TradeStepRec = { key: base.stepKey, step: 'agree', card: key(c) }
    const v = view(state([mk(), c], { step: keep }))
    check("A-22 stored 'agree' with A as its card: stays 'agree'", v.step === 'agree')
    const d = theirs(B)
    const v2 = view(state([mk(), c, d], { step: keep }))
    check("A-22 a new card B: 'account'", v2.step === 'account')
    const v3 = view(state([mk(), c], { step: { ...keep, key: 'other' } }))
    check("A-22 another trade's key is ignored: 'account'", v3.step === 'account')
    const v4 = view(state([mk(), c, d], { step: { ...keep, step: 'verify' } }))
    check("A-22 stored 'verify': a new card does not move it", v4.step === 'verify')
    const v5 = view(state([mk(), c], { step: { ...keep, step: 'receive' } }))
    check('A-22 a step my side does not have is ignored', v5.step === 'account')
  }
  // A-23: an earlier offer's marker.
  {
    const c = theirs(A, { at: 600 })
    const v = view(state([mk(500), c], { matches: [] }))
    check('A-23 an earlier offer’s marker, no match: inactive, no pay', stateOf(v, c) === 'inactive' && v.activeCard === '' && !v.cards[key(c)].pay)
    const v2 = view(state([mk(500), c]))
    check('A-23 matched now: active, pay', stateOf(v2, c) === 'active' && v2.cards[key(c)].pay)
  }
  // A-24: a late mirror of my earlier completion.
  {
    const offer = sellOffer({ createdAt: 1000 })
    const v = view(state([mk(500), dn(true, 100_000, 'KRW', 900), dn(false, 100_000, 'KRW', 1100)], { offer }))
    check('A-24 a late mirror of my earlier full completion: nothing pending', v.pendingDone.length === 0)
    const v2 = view(state([mk(500), dn(true, 100_000, 'KRW', 900), dn(false, 50_000, 'KRW', 1100)], { offer }))
    check('A-24 another amount in the new offer: pending', v2.pendingDone.length === 1)
  }
  // Edits of terms keep the trade (createdAt stays): the card stays, the limit follows the new amount.
  {
    const c = theirs(I680)
    const before = view(state([mk(), c]))
    const edited = view(state([mk(), c], { offer: sellOffer({ amountMinor: 50_000, rev: 2 }) }))
    check('A edit: my edited amount keeps the trade and the card', stateOf(edited, c) === 'active' && edited.stepKey === before.stepKey)
    check('A edit: the limit follows the smaller amount (68,000 sats over 50,000 won)', !before.cards[key(c)].over && edited.cards[key(c)].over)
    const newOffer = view(state([mk(), c], { offer: sellOffer({ id: 'new', createdAt: 2000 }), matches: [] }))
    check('A new offer (new createdAt), not matched yet: every card grey', stateOf(newOffer, c) === 'inactive' && newOffer.step === 'agree')
    const sideChanged = view(state([mk(), c], { offer: sellOffer({ id: 'buy', side: 'buy', createdAt: 2000 }), matches: [] }))
    check("A side changed to buy: the contact's card is notPayer", stateOf(sideChanged, c) === 'notPayer')
  }
  // 50 cards from a malicious contact: one active.
  {
    const many = Array.from({ length: 50 }, (_, i) => theirs(inv('lnbc1m', T + 10 + i)))
    const v = view(state([mk(), ...many]))
    const act = Object.values(v.cards).filter((c) => c.state === 'active')
    check('A 50 cards: only the last is active', act.length === 1 && stateOf(v, many[49]) === 'active')
  }
  // Text that is not a request: no card.
  {
    const v = view(state([mk(), theirs('lnbc1 hello'), theirs('x'.repeat(5000))]))
    check('A plain text holds no cards', Object.keys(v.cards).length === 0)
    check("A no card at all: no active card, receive 'none', step 'agree'", v.activeCard === '' && v.receive === 'none' && v.receiveExpiresAt === 0 && v.step === 'agree')
  }

  // R: the room draws the active card even when it is older than the drawn messages
  // (src/screens/room/window.ts). Drawn = the pinned message and the visible ones.
  {
    const drawn = (w: RoomWindow) => [...(w.pinned ? [w.pinned] : []), ...w.visible]
    const chat = (k: number) => Array.from({ length: k }, (_, i) => theirs(`line ${i}`))
    // R-1 the seller: their invoice, then 258 lines of talk, 260 messages in all.
    const card = theirs(inv('lnbc1m', T + 50))
    const room = [mk(), card, ...chat(258)]
    const v = view(state(room))
    check('R-1 setup: the old card is the active one', v.activeCard === key(card) && stateOf(v, card) === 'active', v.activeCard)
    const w = roomWindow(room, FIRST_SHOWN, v.activeCard)
    check('R-1 the first 50 drawn leave the card out', w.hidden === 210 && w.visible.length === 50 && !w.visible.includes(card))
    check('R-1 the active card is drawn anyway, pinned above', w.pinned === card && w.pinnedIndex === 1 && drawn(w).includes(card))
    // R-2 'jump to' opens whole pages down to it; the card is then in place and no longer pinned.
    const reach = shownToReach(room.length, w.pinnedIndex, FIRST_SHOWN)
    const opened = roomWindow(room, reach, v.activeCard)
    check('R-2 jump to: shown grows in pages of 50 until the card is drawn', reach === 300 && opened.visible.includes(card) && opened.pinned === null, String(reach))
    check('R-2 shownToReach never shrinks what is shown', shownToReach(room.length, 250, 100) === 100)
    // R-3 inside the drawn messages: drawn once, at its own place.
    const near = [mk(), ...chat(100), card, ...chat(10)]
    const nv = view(state(near))
    const nw = roomWindow(near, FIRST_SHOWN, nv.activeCard)
    check('R-3 a recent active card is not pinned (drawn once, in place)', nv.activeCard === key(card) && nw.pinned === null && nw.visible.filter((m) => m === card).length === 1)
    // R-4 inactive cards stay where they are: an older card is never pinned, only the active one.
    const old = theirs(inv('lnbc1m', T + 40))
    const later = theirs(inv('lnbc1m', T + 60))
    const two = [mk(), old, ...chat(100), later, ...chat(100)]
    const tv = view(state(two))
    const tw = roomWindow(two, FIRST_SHOWN, tv.activeCard)
    check('R-4 the older inactive card is not pinned; the active one is', stateOf(tv, old) === 'inactive' && tw.pinned === later && !drawn(tw).includes(old))
    // R-5 no active card (finished trade): nothing pinned.
    const fin = [mk(), card, ...chat(100), dn(true, 30_000)]
    const fw = roomWindow(fin, FIRST_SHOWN, view(state(fin)).activeCard)
    check('R-5 after my completion: no active card, nothing pinned', fw.pinned === null && fw.hidden === fin.length - 50)
    // R-6 the buyer: my own on-chain address, older than the window.
    const addr = mineText('bitcoin:bc1qw508d6qejxtdg4y5r3zarvary0c5xw7kv8f3t4?amount=0.001')
    const buyRoom = [mk(), addr, ...chat(120)]
    const bv = view(state(buyRoom, { offer: sellOffer({ side: 'buy' }), matches: [theirMatch({ side: 'sell' })] }))
    const bw = roomWindow(buyRoom, FIRST_SHOWN, bv.activeCard)
    check("R-6 the buyer's own on-chain card outside the window is pinned", bv.activeKind === 'onchain' && bw.pinned === addr && drawn(bw).includes(addr), `${bv.activeKind} ${bv.activeCard}`)
    // R-7 a short room: everything drawn, nothing pinned, no 'show earlier'.
    const short = [mk(), card]
    const sw = roomWindow(short, FIRST_SHOWN, view(state(short)).activeCard)
    check('R-7 a short room: nothing hidden, nothing pinned', sw.hidden === 0 && sw.pinned === null && sw.visible.length === 2)
    eq("R-8 cardMessageId('x001:3')", cardMessageId('x001:3'), 'x001')
    eq("R-8 cardMessageId('a:b:0') keeps the id's own colons", cardMessageId('a:b:0'), 'a:b')
    eq("R-8 cardMessageId('')", cardMessageId(''), '')
    // R-9 a pending 'jump to': scrolls when the expanded history holds the target,
    // is let go when it does not (dropped by the limit meanwhile), and nothing without one.
    eq('R-9 jump to: the card is drawn after the history opened -> scroll', jumpStep(opened, card.id), 'scroll')
    const gone = room.filter((m) => m !== card)
    const goneWin = roomWindow(gone, reach, '')
    eq('R-9 jump to: the card left the room meanwhile -> drop (no jump later)', jumpStep(goneWin, card.id), 'drop')
    eq('R-9 jump to: still outside the drawn ones -> drop', jumpStep(w, card.id), 'drop')
    eq('R-9 no jump pending -> none', jumpStep(w, ''), 'none')
    // R-10 the room's resets on a contact change include the pending 'jump to'.
    const src = readFileSync(new URL('../src/screens/room/RoomScreen.tsx', import.meta.url), 'utf8')
    const reset = /useEffect\(\(\) => \{\n {4}setCompletedAt\(0\)[\s\S]*?\}, \[contactId\]\)/.exec(src)?.[0] ?? ''
    check("R-10 a contact change clears the pending 'jump to' (RoomScreen's contactId reset)", reset.includes("setJumpTo('')"), reset ? 'not in the reset' : 'reset effect not found')
  }
}

// ---------------------------------------------------------------- C payment cards and board rows

{
  const ADDR = 'bc1qw508d6qejxtdg4y5r3zarvary0c5xw7kv8f3t4'
  const T = 1_700_000_000
  const LNINV = buildInvoice('lnbc1m', T)
  // C-1
  {
    const ref = payRefOf(`bitcoin:${ADDR}?amount=0.001`)
    check(
      'C-1 bitcoin: link with amount: an on-chain card of 100,000 sats that never expires',
      ref?.kind === 'onchain' && ref.id === ADDR && ref.amountSats === 100_000 && ref.expiresAt === null && ref.mainnet === true && ref.req.uri === bip21(ADDR, 100_000),
    )
    const upper = payRefOf(`BITCOIN:${ADDR.toUpperCase()}?amount=0.001&label=x`)
    check('C-1 upper case link and address: the same card (lower-case id)', upper?.kind === 'onchain' && upper.id === ADDR && upper.amountSats === 100_000)
    const bare = payRefOf(ADDR)
    check('C-1 a bare address: a card without an amount', bare?.kind === 'onchain' && bare.amountSats === null && bare.req.uri === `bitcoin:${ADDR}`)
    check('C-1 base58 mainnet addresses are cards', payRefOf('1BvBMSEYstWetqTFn5Au4m4GFg7xJaNVN2')?.kind === 'onchain' && payRefOf('3J98t1WpEZ73CNmQviecrnyiWrnqRhWNLy')?.kind === 'onchain')
  }
  // C-2
  {
    const unified = payRefOf(`bitcoin:${ADDR}?amount=0.001&lightning=${LNINV}`)
    check('C-2 bitcoin: with lightning=: a Lightning card', unified?.kind === 'lightning' && unified.id === LNINV)
    check('C-2 a bare invoice: Lightning', payRefOf(LNINV)?.kind === 'lightning')
    const notCards: [string, string][] = [
      ['bitcoin:tb1qw508d6qejxtdg4y5r3zarvary0c5xw7kxpjzsx', 'testnet link'],
      ['tb1qw508d6qejxtdg4y5r3zarvary0c5xw7kxpjzsx', 'testnet address'],
      ['bcrt1qw508d6qejxtdg4y5r3zarvary0c5xw7kygt080', 'regtest address'],
      ['mipcBbFg9gMiCh81Kj8tqqdgoZub1ZJRfn', 'base58 testnet'],
      [`bitcoin:${ADDR}?req-foo=1`, 'req- parameter'],
      [`bitcoin:${ADDR}?amount=0.000000001`, 'nine decimals'],
      [`bitcoin:${ADDR}?amount=-1`, 'negative amount'],
      [`bitcoin:${ADDR}?amount=1e-3`, 'exponent amount'],
      [`bitcoin:${ADDR}?amount=0.001&amount=0.002`, 'amount twice'],
      ['bc1qw508d6qejxtdg4y5r3zarvary0c5xw7KV8F3T4', 'mixed case'],
      [`bc1qw508d6qejxtdg4y5r3zarvary0c5xw7kv8f3\u200bt4`, 'zero-width space'],
      ['bc1qw508d6qejxtdg4y5r3zarvary0c5xw7kv8f3tа', 'Cyrillic a'],
      [`bitcoin:${ADDR}?amount=0.001&x=${'q'.repeat(4100)}`, 'over 4,096 characters'],
      ['1234567890123456789012345678', 'digits that look like base58'],
    ]
    for (const [token, what] of notCards) check(`C-2 not a card: ${what}`, payRefOf(token) === null)
    check(
      'C-2 candidates: plain words and short tokens are never parsed',
      !isPayCandidate('hello') && !isPayCandidate('bc1') && !isPayCandidate('3') && isPayCandidate(`bitcoin:${ADDR}`) && isPayCandidate(ADDR),
    )
    const parts = splitText(`send to ${ADDR}\nthanks`)
    check('C-2 splitText finds the address between words and line breaks', parts.filter((p) => p.ref?.kind === 'onchain').length === 1)
  }

  const PEER = 'd'.repeat(64)
  let n = 0
  const theirs = (body: string): ChatMessage => ({ id: `c${n++}`, contactId: PEER, mine: false, kind: 'text', text: body, at: 1600 })
  const mk = (): ChatMessage => ({ id: `c${n++}`, contactId: PEER, mine: false, kind: 'matched', at: 1500 })
  const dn = (amountMinor: number, at: number): ChatMessage => ({ id: `c${n++}`, contactId: PEER, mine: true, kind: 'done', amountMinor, currency: 'KRW', at })
  const offer = (side: Side, methods: Offer['methods']): Offer => ({ id: 'o', side, currency: 'KRW', amountMinor: 100_000, feePct: 0, methods, createdAt: 1000, rev: 1 })
  const match = (side: Side, methods: Offer['methods']): Match => ({ contactId: PEER, offer: { side, currency: 'KRW', amountMinor: 100_000, feePct: 1, methods, createdAt: 900 } })
  type S = Pick<IlchonState, 'myOffer' | 'matches' | 'rooms' | 'rates' | 'tradeSteps'>
  const st = (messages: ChatMessage[], my: Offer, matches: Match[]): S => ({ myOffer: my, matches, rooms: { [PEER]: messages }, rates: { KRW: 150_000_000 }, tradeSteps: {} })
  const NOW = (T + 100) * 1000
  const BOTH: Offer['methods'] = ['lightning', 'onchain']

  // C-3: the seller's room [match, their invoice A, their on-chain B].
  {
    const a = theirs(LNINV)
    const b = theirs(`bitcoin:${ADDR}?amount=0.00066`)
    const v = tradeView(st([mk(), a, b], offer('sell', BOTH), [match('buy', BOTH)]), PEER, NOW)
    const ca = v.cards[`${a.id}:0`]
    const cb = v.cards[`${b.id}:0`]
    check('C-3 [match, invoice, on-chain]: the invoice inactive, the on-chain card active and payable', ca?.state === 'inactive' && cb?.state === 'active' && cb.pay === true)
    check("C-3 activeKind 'onchain', receive 'live', no expiry", v.activeKind === 'onchain' && v.receive === 'live' && v.receiveExpiresAt === 0)
    check('C-3 the on-chain card has its fiat value and no warning (66,000 sats under 100,000 won)', cb?.fiatMinor === 99_000 && cb.over === false, JSON.stringify(cb))
    const big = theirs(`bitcoin:${ADDR}?amount=0.0007`)
    const v2 = tradeView(st([mk(), big], offer('sell', BOTH), [match('buy', BOTH)]), PEER, NOW)
    check('C-3 an on-chain card asking more than 3% over the trade amount warns the seller', v2.cards[`${big.id}:0`]?.over === true)
    const noAmt = theirs(ADDR)
    const v3 = tradeView(st([mk(), noAmt], offer('sell', BOTH), [match('buy', BOTH)]), PEER, NOW)
    check('C-3 a bare address: active, no fiat value, no warning', v3.cards[`${noAmt.id}:0`]?.state === 'active' && v3.cards[`${noAmt.id}:0`]?.fiatMinor === null && !v3.cards[`${noAmt.id}:0`]?.over)
    const vBuy = tradeView(st([mk(), b], offer('buy', BOTH), [match('sell', BOTH)]), PEER, NOW)
    check("C-3 the buyer sees the seller's on-chain card as notPayer", vBuy.cards[`${b.id}:0`]?.state === 'notPayer' && !vBuy.cards[`${b.id}:0`]?.pay)
    const vGone = tradeView(st([mk(), b], offer('sell', BOTH), []), PEER, NOW)
    check('C-3 no match now: the card stays active, no pay button', vGone.cards[`${b.id}:0`]?.state === 'active' && !vGone.cards[`${b.id}:0`]?.pay)
  }
  // C-4: the address of a finished trade never comes back.
  {
    const x1 = theirs(`bitcoin:${ADDR}?amount=0.0002`)
    const x2 = theirs(`bitcoin:${ADDR}?amount=0.0003`)
    const v = tradeView(st([mk(), x1, dn(30_000, 2000), { ...mk(), at: 2100 }, x2], offer('sell', BOTH), [match('buy', BOTH)]), PEER, NOW)
    check('C-4 [match, X, my done, match, X again]: X again is inactive (settled by address)', v.cards[`${x2.id}:0`]?.state === 'inactive' && v.activeCard === '' && v.activeKind === null)
  }
  // C-5: shared methods in the view.
  {
    const v = tradeView(st([mk()], offer('buy', BOTH), [match('sell', ['onchain'])]), PEER, NOW)
    check("C-5 mine {LN,OC}, theirs {OC}: methods ['onchain']", v.methods.join() === 'onchain' && v.theirOffer !== null)
    const v2 = tradeView(st([mk()], offer('buy', ['lightning']), [match('sell', ['onchain'])]), PEER, NOW)
    check('C-5 a match without a shared method (put in by hand): no theirOffer, no methods', v2.theirOffer === null && v2.methods.length === 0 && v2.tradeMinor === null)
    const v3 = tradeView(st([mk()], offer('buy', BOTH), []), PEER, NOW)
    check('C-5 not matched: no methods', v3.methods.length === 0)
  }
  // C-7: what the on-chain card shows, copies and encodes, and the words around it.
  {
    for (const sats of [98039, 100_000, 1, 66_000, 123_456_789, 100_000_000]) {
      const req = parseOnchainRequest(bip21(ADDR, sats))
      const v = req ? onchainCardValues(req) : null
      check(
        `C-7 ${sats} sats: the BTC line, the copied link and the QR carry one amount (btcText)`,
        !!req && !!v && v.btc === btcText(sats) && v.link === `bitcoin:${ADDR}?amount=${v.btc}` && v.link === req.uri && parseOnchainRequest(v.link)?.sats === sats && v.address === ADDR,
        JSON.stringify(v),
      )
    }
    const fromChat = parseOnchainRequest(`BITCOIN:${ADDR.toUpperCase()}?amount=0.00066&label=x`)
    const vc = fromChat ? onchainCardValues(fromChat) : null
    check(
      'C-7 a link pasted with other keys: the copied link is rebuilt, its amount the shown one',
      vc?.link === `bitcoin:${ADDR}?amount=0.00066` && vc.btc === '0.00066' && vc.address === ADDR,
      JSON.stringify(vc),
    )
    const bareReq = parseOnchainRequest(ADDR)
    const vb = bareReq ? onchainCardValues(bareReq) : null
    check('C-7 a bare address: no BTC line, the link and the copy have no amount', vb?.btc === null && vb.link === `bitcoin:${ADDR}` && vb.address === ADDR)

    const room = listDictionaries().get('room')
    const invoiceWords = { ko: /청구서|인보이스|라이트닝|결제/, en: /invoice|lightning|\bpay\b|\bpaid\b/i }
    for (const lang of ['ko', 'en'] as const) {
      for (const [role, key] of Object.entries(PAY_COPY.onchain)) {
        const text = room?.[lang][key]
        check(
          `C-7 ${lang} on-chain ${role} (${key}): its own key, no invoice words`,
          typeof text === 'string' && text !== '' && (key as string) !== PAY_COPY.lightning[role as keyof typeof PAY_COPY.lightning] && !invoiceWords[lang].test(text),
          text,
        )
      }
      for (const key of ['copyLink', 'copyAddressOnly', 'copyAddress', 'invOpenHintOnchain', 'invOpenHintOnchainNoAmount']) check(`C-7 ${lang} ${key} exists`, !!room?.[lang][key])
    }
    // Every note and warning row the on-chain card can show (the 'over'
    // warning had kept the invoice's words): each state x amount x over x whose card.
    const lightningOnly = new Set<string>(Object.values(PAY_COPY.lightning).filter((k) => !(Object.values(PAY_COPY.onchain) as string[]).includes(k)))
    const rows = new Set<string>()
    for (const state of ['active', 'inactive', 'notPayer'] as const) {
      for (const over of [false, true]) {
        for (const hasAmount of [false, true]) {
          for (const mine of [false, true]) {
            const card = { state, pay: state === 'active', fiatMinor: null, over }
            for (const key of onchainCardNotes(card, hasAmount, mine)) rows.add(key)
          }
        }
      }
    }
    check(
      'C-7 the on-chain card has its warning rows (no amount, over, not the payer, inactive)',
      ['invIssueNoAmountOnchain', 'invIssueOverOnchain', 'invNotPayerOnchain', 'invInactive'].every((k) => rows.has(k)),
      [...rows].join(','),
    )
    for (const lang of ['ko', 'en'] as const) {
      for (const key of rows) {
        const text = room?.[lang][key]
        check(
          `C-7 ${lang} on-chain card row ${key}: an address's words, not an invoice key`,
          typeof text === 'string' && text !== '' && !lightningOnly.has(key) && !invoiceWords[lang].test(text),
          text,
        )
      }
    }
    // The hints name the buttons by their labels.
    for (const lang of ['ko', 'en'] as const) {
      const d = room?.[lang] ?? {}
      check(
        `C-7 ${lang} the on-chain hint names both copy buttons`,
        (d.invOpenHintOnchain ?? '').includes(d.copyLink ?? '\u0000') && (d.invOpenHintOnchain ?? '').includes(d.copyAddressOnly ?? '\u0000'),
      )
      check(`C-7 ${lang} the hint without an amount names the address copy`, (d.invOpenHintOnchainNoAmount ?? '').includes(d.copyAddress ?? '\u0000'))
    }
    // Which words the room uses: the active card's kind, else an on-chain-only trade, else an invoice.
    check('C-7 payCopy: an active on-chain card speaks of an address', payCopy('onchain', ['lightning', 'onchain']) === PAY_COPY.onchain)
    check('C-7 payCopy: an active invoice speaks of an invoice even when on-chain is shared', payCopy('lightning', ['onchain', 'lightning']) === PAY_COPY.lightning)
    check('C-7 payCopy: no card yet, on-chain the only shared method: an address', payCopy(null, ['onchain']) === PAY_COPY.onchain)
    check('C-7 payCopy: no card yet, Lightning shared or no match: an invoice', payCopy(null, ['lightning', 'onchain']) === PAY_COPY.lightning && payCopy(null, []) === PAY_COPY.lightning)
    const st2 = tradeView(st([mk(), theirs(`bitcoin:${ADDR}?amount=0.00066`)], offer('sell', BOTH), [match('buy', BOTH)]), PEER, NOW)
    check("C-7 the seller's view of an on-chain card picks the address words", payCopy(st2.activeKind, st2.methods) === PAY_COPY.onchain)
    // The seller's "ask where to send" chip follows the trade's method:
    // the view's methods from real offers, each case its own whole sentence.
    const sellerMethods = (mine: Offer['methods'], theirs: Offer['methods']) => tradeView(st([mk()], offer('sell', mine), [match('buy', theirs)]), PEER, NOW).methods
    const askCases = [
      ['on-chain only', sellerMethods(BOTH, ['onchain']), 'msgAskInvoiceOnchain'],
      ['Lightning only', sellerMethods(['lightning'], BOTH), 'msgAskInvoiceLightning'],
      ['both', sellerMethods(BOTH, BOTH), 'msgAskInvoice'],
      ['no match yet', tradeView(st([mk()], offer('sell', BOTH), []), PEER, NOW).methods, 'msgAskInvoice'],
    ] as const
    for (const [name, methods, key] of askCases) {
      check(`C-7 ask-where chip, ${name} (${methods.join('+')}): ${key}`, askWhereKey(methods) === key, askWhereKey(methods))
    }
    // The same match, the seller's offer changed afterwards: the sentence follows the current offers.
    const beforeDrop = askWhereKey(sellerMethods(BOTH, BOTH))
    const afterDrop = askWhereKey(sellerMethods(['onchain'], BOTH))
    check(
      'C-7 ask-where chip, seller drops Lightning after the match: msgAskInvoice then msgAskInvoiceOnchain',
      beforeDrop === 'msgAskInvoice' && afterDrop === 'msgAskInvoiceOnchain',
      `${beforeDrop} -> ${afterDrop}`,
    )
    const roomSrc = readFileSync(new URL('../src/screens/room/RoomScreen.tsx', import.meta.url), 'utf8')
    const askChip = /<Chip[^\n]*\{t\('chipAskInvoice'\)\}<\/Chip>/.exec(roomSrc)?.[0] ?? ''
    check("C-7 the seller's ask-where chip inserts askWhereKey(view.methods)", askChip.includes('insert(t(askWhereKey(view.methods)))'), askChip || 'chip not found')
    const addressWords = { ko: /주소/, en: /address/i }
    for (const lang of ['ko', 'en'] as const) {
      const d = room?.[lang] ?? {}
      check(
        `C-7 ${lang} ask-where on-chain sentence names an address, no invoice words`,
        addressWords[lang].test(d.msgAskInvoiceOnchain ?? '') && !invoiceWords[lang].test(d.msgAskInvoiceOnchain ?? ''),
        d.msgAskInvoiceOnchain,
      )
      check(
        `C-7 ${lang} ask-where Lightning sentence names an invoice, no address`,
        invoiceWords[lang].test(d.msgAskInvoiceLightning ?? '') && !addressWords[lang].test(d.msgAskInvoiceLightning ?? ''),
        d.msgAskInvoiceLightning,
      )
      check(`C-7 ${lang} ask-where sentence for both names both`, invoiceWords[lang].test(d.msgAskInvoice ?? '') && addressWords[lang].test(d.msgAskInvoice ?? ''), d.msgAskInvoice)
    }
  }
  // C-8: the buyer's step 2 counts only a live receiving place of a method the
  // trade still shares. The seller changing its methods keeps the match with no new marker in
  // the buyer's room, so the invoice sent before stays the active card.
  {
    const mineT = (body: string): ChatMessage => ({ id: `c${n++}`, contactId: PEER, mine: true, kind: 'text', text: body, at: 1600, status: 'sent' })
    const inv = mineT(LNINV)
    const before = tradeView(st([mk(), inv], offer('buy', BOTH), [match('sell', BOTH)]), PEER, NOW)
    check('C-8 buyer sent an invoice, Lightning shared: step 2 done', before.receive === 'live' && receivePlaceSent(before))
    const changed = tradeView(st([mk(), inv], offer('buy', BOTH), [match('sell', ['onchain'])]), PEER, NOW)
    check(
      'C-8 the seller changed to on-chain only after the invoice: step 2 open',
      changed.receive === 'live' && changed.methods.join() === 'onchain' && changed.activeKind === 'lightning' && !receivePlaceSent(changed),
      JSON.stringify({ r: changed.receive, k: changed.activeKind, m: changed.methods }),
    )
    const addr = mineT(`bitcoin:${ADDR}?amount=0.00066`)
    const after = tradeView(st([mk(), inv, addr], offer('buy', BOTH), [match('sell', ['onchain'])]), PEER, NOW)
    check('C-8 then an on-chain address sent: step 2 done', after.activeKind === 'onchain' && receivePlaceSent(after))
    const gone = tradeView(st([mk(), inv], offer('buy', BOTH), []), PEER, NOW)
    check('C-8 no match now (no shared methods to compare): the live invoice still counts', gone.receive === 'live' && receivePlaceSent(gone))
    const none = tradeView(st([mk()], offer('buy', BOTH), [match('sell', ['onchain'])]), PEER, NOW)
    check('C-8 nothing sent: step 2 open', !receivePlaceSent(none))
    // The guide's current step follows: the invoice moved it to
    // step 3 by itself; once step 2 opens again that automatic step 3 goes back to step 2. A
    // step I stored by hand wins, 'done' is never pulled back, and Next/Prev always work. A
    // place of a shared method moves it on again.
    check('C-8 guide: the invoice moved the buyer to step 3', before.step === 'transfer', String(before.step))
    check('C-8 guide: step 2 open again -> the automatic step 3 goes back to step 2', changed.step === 'receive', String(changed.step))
    const chosen = (step: TradeStepRec['step'], card = changed.activeCard): S => ({
      ...st([mk(), inv], offer('buy', BOTH), [match('sell', ['onchain'])]),
      tradeSteps: { [PEER]: { key: changed.stepKey, step, card } },
    })
    check('C-8 guide: a step 3 I chose by hand with that invoice stays', tradeView(chosen('transfer'), PEER, NOW).step === 'transfer', String(tradeView(chosen('transfer'), PEER, NOW).step))
    check('C-8 guide: a stored done stays done (a buyer who paid is not pulled back)', tradeView(chosen('done'), PEER, NOW).step === 'done', String(tradeView(chosen('done'), PEER, NOW).step))
    check('C-8 guide: a done stored before that invoice also stays', tradeView(chosen('done', ''), PEER, NOW).step === 'done', String(tradeView(chosen('done', ''), PEER, NOW).step))
    check('C-8 guide: step 1 I chose stays', tradeView(chosen('agree'), PEER, NOW).step === 'agree')
    check(
      'C-8 guide: step 1 stored before that invoice -> the card moves it, and it lands on step 2',
      tradeView(chosen('agree', ''), PEER, NOW).step === 'receive',
      String(tradeView(chosen('agree', ''), PEER, NOW).step),
    )
    // Next from step 2: what goToStep -> setTradeStep stores ({ key: stepKey, step, card: activeCard }).
    const nextIdx = changed.steps.indexOf(changed.step!) + 1
    const afterNext = tradeView(chosen(changed.steps[nextIdx]!), PEER, NOW)
    check('C-8 guide: Next from step 2 moves to step 3 and stays', changed.steps[nextIdx] === 'transfer' && afterNext.step === 'transfer', String(afterNext.step))
    const backPrev = tradeView(chosen(afterNext.steps[afterNext.steps.indexOf(afterNext.step!) - 1]!), PEER, NOW)
    check('C-8 guide: Prev from that step 3 goes to step 2', backPrev.step === 'receive', String(backPrev.step))
    check('C-8 guide: the on-chain address sent -> step 3 again', after.step === 'transfer', String(after.step))
    check('C-8 guide: no match now -> the invoice keeps step 3', gone.step === 'transfer', String(gone.step))
    const sellerChanged = tradeView(st([mk(), theirs(LNINV)], offer('sell', BOTH), [match('buy', ['onchain'])]), PEER, NOW)
    check("C-8 guide: the seller's guide is not moved by this rule", sellerChanged.step === 'account', String(sellerChanged.step))
  }
  // C-6: board rows.
  {
    const contact = { id: PEER, pubkey: PEER, name: 'x', addedAt: 1 } as unknown as Parameters<typeof buildRows>[2][number]
    const rows = (mine: Offer['methods'], their: Offer['methods']) => buildRows(offer('buy', mine), [match('sell', their)], [contact], { KRW: 150_000_000 }, 'amount')
    const r1 = rows(BOTH, ['onchain'])
    check("C-6 mine {LN,OC}, theirs {OC}: methods ['onchain'], the 'On-chain only' mark", r1.length === 1 && r1[0].methods.join() === 'onchain' && onlyMethodKey(r1[0].methods) === 'onlyOnchain')
    const r2 = rows(BOTH, BOTH)
    check('C-6 both share both: no mark', r2.length === 1 && onlyMethodKey(r2[0].methods) === null)
    const r3 = rows(['lightning'], BOTH)
    check("C-6 mine {LN}, theirs {LN,OC}: 'Lightning only'", r3.length === 1 && onlyMethodKey(r3[0].methods) === 'onlyLightning')
    check('C-6 no shared method: no row', rows(['lightning'], ['onchain']).length === 0)
  }
}

// E: the offer sheet's edit button is off only when the form equals the live offer.
{
  const live: Offer = { id: 'o1', side: 'sell', currency: 'KRW', amountMinor: 90_000, feePct: 1.5, methods: ['lightning', 'onchain'], createdAt: 1, rev: 3 }
  // The sheet fills its text fields from the offer and parses them back; nothing may drift.
  const form = (o: Offer = live) => ({
    side: o.side,
    currency: o.currency,
    amountMinor: parseMinor(minorToInput(o.amountMinor, o.currency), o.currency),
    feePct: parseFee(feeToInput(o.feePct)),
    methods: [...o.methods],
  })
  check('E-1 the form as opened (text round trip, 90,000 and 1.5): unchanged', offerFormUnchanged(live, form()))
  check("E-1 amount typed as '90,000': unchanged", offerFormUnchanged(live, { ...form(), amountMinor: parseMinor('90,000', 'KRW') }))
  check('E-2 fee changed: not unchanged', !offerFormUnchanged(live, { ...form(), feePct: 2 }))
  check('E-2 amount changed: not unchanged', !offerFormUnchanged(live, { ...form(), amountMinor: 80_000 }))
  check('E-2 side changed: not unchanged', !offerFormUnchanged(live, { ...form(), side: 'buy' }))
  check('E-2 currency changed: not unchanged', !offerFormUnchanged(live, { ...form(), currency: 'USD' }))
  check('E-2 a method off: not unchanged', !offerFormUnchanged(live, { ...form(), methods: ['lightning'] }))
  check('E-3 a method off and on again (any order): unchanged', offerFormUnchanged(live, { ...form(), methods: ['onchain', 'lightning'] }))
  // A completion while the sheet is open: the live offer moved, the form did not.
  check('E-4 live offer withdrawn (filled): the button turns on', !offerFormUnchanged(null, form()))
  check('E-4 live amount lowered 90,000 -> 80,000, form still 90,000: the button turns on', !offerFormUnchanged({ ...live, amountMinor: 80_000, rev: 4 }, form()))
}

// D: the completion line and its button, one amount text (the line
// once said "$1" and the button "$1.00").
{
  const room = listDictionaries().get('room')
  for (const lang of ['ko', 'en', 'ja'] as const) {
    const t = (key: string, vars?: Record<string, string | number>) => {
      const raw = room?.[lang]?.[key] ?? room?.en[key] ?? key
      return vars ? raw.replace(/\{(\w+)\}/g, (m, n: string) => (n in vars ? String(vars[n]) : m)) : raw
    }
    const cases: [number, Currency][] = [
      [100, 'USD'],
      [150, 'USD'],
      [1205, 'USD'],
      [123_456, 'USD'],
      [1_000, 'KRW'],
      [50_000, 'JPY'],
    ]
    for (const [minor, currency] of cases) {
      const amount = systemMoney(t, minor, currency)
      const line = t('sysDoneTheirs', { amount })
      const button = doneApplyLabel(t, minor, currency)
      check(
        `D-1 ${lang} ${currency} ${minor}: the line and the button both say ${amount}`,
        line.includes(amount) && button.includes(amount) && button === t('doneApply', { amount }),
        `${line} / ${button}`,
      )
    }
  }
  const en = room?.en
  const enT = (key: string, vars?: Record<string, string | number>) => (en?.[key] ?? key).replace(/\{(\w+)\}/g, (m, n: string) => (vars && n in vars ? String(vars[n]) : m))
  check('D-1 en USD 100: "Mark $1 done too", not $1.00', doneApplyLabel(enT, 100, 'USD') === 'Mark $1 done too', doneApplyLabel(enT, 100, 'USD'))
  // Cents in two digits on the line and the button alike: $1.50, never $1.5.
  for (const [minor, want] of [
    [150, '$1.50'],
    [100, '$1'],
    [205, '$2.05'],
  ] as const) {
    const line = enT('sysDoneTheirs', { amount: systemMoney(enT, minor, 'USD') })
    const button = doneApplyLabel(enT, minor, 'USD')
    check(`D-2 en USD ${minor}: the line and the button say ${want}`, line.includes(want) && !line.includes(`${want}0`) && button === `Mark ${want} done too`, `${line} / ${button}`)
  }
  check(
    'D-2 en KRW 1000 and JPY 50000 unchanged',
    systemMoney(enT, 1_000, 'KRW') === '₩1,000' && systemMoney(enT, 50_000, 'JPY') === '¥50,000',
    `${systemMoney(enT, 1_000, 'KRW')} / ${systemMoney(enT, 50_000, 'JPY')}`,
  )
}

// Composer above Android Chrome's keyboard bar.
check('keyboard gap: the view ends 11.4 px above the composer -> lift 12 px', keyboardGap(740, 0, 728.6) === 12)
check('keyboard gap: the browser panned the view (offsetTop) -> counted', keyboardGap(740, 20, 700) === 20)
check('keyboard gap: the composer is inside the view -> 0', keyboardGap(700, 0, 739) === 0)
check('keyboard gap: keyboard closed, view equals the page -> 0', keyboardGap(739, 0, 739) === 0)
// Pinch-zoom shrinks and pans the visual viewport: no lift then.
check('keyboard gap: pinch-zoomed in (scale 2) -> 0, not the zoomed view', keyboardGap(740, 300, 370, 2) === 0)
check('keyboard gap: zoomed out a little (scale 0.9) -> 0', keyboardGap(740, 0, 700, 0.9) === 0)
check('keyboard gap: scale 1 still lifts', keyboardGap(740, 0, 728.6, 1) === 12)
// On a phone, the room still sliding in (translateY(12px)) with no keyboard left a
// 12 px lift: bottom 751.2 against a view of 739.2 that equals the layout viewport.
check('keyboard gap: opening animation, keyboard closed (layout = view) -> 0, not 12', keyboardGap(751.2, 0, 739.2, 1, { layoutHeight: 739.2 }) === 0)
check('keyboard gap: the same box without the layout height still reads 12 (what a phone showed)', keyboardGap(751.2, 0, 739.2) === 12)
check('keyboard gap: view 100 px shorter than the layout (URL bar, not a keyboard) -> 0', keyboardGap(739, 0, 639, 1, { layoutHeight: 739 }) === 0)
check('keyboard gap: keyboard open (view 331.7 of 739.2, panned 179.6) -> the measured lift 228', keyboardGap(739.2, 179.6, 331.7, 1, { layoutHeight: 739.2 }) === 228)
// The layout height is the initial containing block (documentElement.clientHeight), which
// the keyboard leaves alone. window.innerHeight would follow the visual viewport in Chrome
// (about 331 here) and read the keyboard as closed: the lift would be lost.
check('keyboard gap: a layout height that followed the view (innerHeight-like, 331) -> 0, which is why it is not used', keyboardGap(739.2, 179.6, 331.7, 1, { layoutHeight: 331 }) === 0)
// Chrome's autofill bar lies partly over the visual viewport.
check(
  `keyboard gap: keyboard open + bar allowance ${ANDROID_KEYBOARD_BAR_ALLOWANCE} -> ${228 + ANDROID_KEYBOARD_BAR_ALLOWANCE}`,
  keyboardGap(739.2, 179.6, 331.7, 1, { layoutHeight: 739.2, bar: ANDROID_KEYBOARD_BAR_ALLOWANCE }) === 228 + ANDROID_KEYBOARD_BAR_ALLOWANCE,
)
check('keyboard gap: bar allowance covers the 15.3 px measured on an Android phone', ANDROID_KEYBOARD_BAR_ALLOWANCE >= 16)
check('keyboard gap: bar allowance with the keyboard closed -> 0', keyboardGap(739.2, 0, 739.2, 1, { layoutHeight: 739.2, bar: ANDROID_KEYBOARD_BAR_ALLOWANCE }) === 0)
// The end of the room's opening animation (or any transition around the composer)
// measures again, so a lift measured during the slide-in cannot outlive it.
check(
  `keyboard gap: measures again on animationend, animationcancel and transitionend (${SETTLE_EVENTS.join(', ')})`,
  ['animationend', 'animationcancel', 'transitionend'].every((e) => (SETTLE_EVENTS as readonly string[]).includes(e)),
)
{
  const composer = { contains: (o: unknown) => o === composer }
  const room = { contains: (o: unknown) => o === room || o === composer }
  const sibling = { contains: (o: unknown) => o === sibling }
  check('keyboard gap: an animation on the room around the composer re-measures', movesComposer(room, composer) && movesComposer(composer, composer))
  check('keyboard gap: an animation elsewhere (a sibling, no target, text node) does not', !movesComposer(sibling, composer) && !movesComposer(null, composer) && !movesComposer({}, composer))
}
check('keyboard gap: bar allowance while pinch-zoomed -> 0', keyboardGap(739.2, 300, 200, 2, { layoutHeight: 739.2, bar: ANDROID_KEYBOARD_BAR_ALLOWANCE }) === 0)

// The lift fed back into its own measure (composer bottom + applied lift).
// On an Android phone: layout 739.2, the room ends at 739.2; while the keyboard opens the view is
// 331.7 tall at offsetTop 0, and the message list stops shrinking with the composer at 392.7;
// Chrome then pans the view to offsetTop 190.9 and the lift should settle at 241.
{
  const bar = ANDROID_KEYBOARD_BAR_ALLOWANCE
  const base = { containerBottom: 739.2, layoutHeight: 739.2, viewHeight: 331.7, scale: 1, bar }
  // What the hook could also read but must not use: the composer's box now and the lift now
  // applied. The samples carry them so a lift that read them would show it.
  type Probe = ComposerSample & { composerBottom: number; applied: number }
  const probe = (s: Probe): Probe => s
  // The composer follows the lift until the list cannot shrink any further.
  const composerAt = (applied: number) => Math.max(392.7, 739.2 - applied)
  const run = (lift: (s: Probe) => number, viewTop: number, start: number, n: number) => {
    const seen: number[] = []
    let applied = start
    for (let i = 0; i < n; i++) {
      applied = lift(probe({ ...base, viewTop, composerBottom: composerAt(applied), applied }))
      seen.push(applied)
    }
    return seen
  }
  const opening = run(composerLift, 0, 0, 6)
  check(`keyboard gap: measures with the growing applied lift do not grow it (${opening.join(', ')})`, opening.every((v) => v === opening[0]) && opening[0] === 432)
  // The old estimate on the same sequence ran away: the scenario is the one the device saw.
  const old = run((s) => keyboardGap(s.composerBottom + s.applied, s.viewTop, s.viewHeight, s.scale, { layoutHeight: s.layoutHeight, bar: s.bar }), 0, 0, 6)
  check(`keyboard gap: the old composerBottom + applied estimate grows on that sequence (${old.join(', ')})`, old[old.length - 1] > old[0])
  // After the pan, from the 345 px stale lift (or the 492 px overshoot), one measure gives 241.
  check('keyboard gap: after the pan to 190.9, a stale 345 px lift measures 241', run(composerLift, 190.9, 345, 1)[0] === 241)
  check(
    'keyboard gap: after the pan, from the 492 px overshoot -> 241, and stays',
    run(composerLift, 190.9, 492, 4).every((v) => v === 241),
  )
  check(
    'keyboard gap: composer box and applied lift do not change the result',
    composerLift(probe({ ...base, viewTop: 190.9, composerBottom: 100, applied: 999 })) === composerLift(probe({ ...base, viewTop: 190.9, composerBottom: 739.2, applied: 0 })),
  )
  check('keyboard gap: keyboard closed (view = layout) -> 0 whatever lift is applied', composerLift(probe({ ...base, viewTop: 0, viewHeight: 739.2, composerBottom: 498.2, applied: 241 })) === 0)
}
// A measure in the next frame alone missed Chrome's last pan once (it landed after the
// event's frame); every trigger measures again SETTLE_FRAMES frames later.
{
  const fakeClock = () => {
    let next = 1
    const queue = new Map<number, () => void>()
    return {
      clock: { request: (cb: () => void) => (queue.set(next, cb), next++), cancel: (id: number) => void queue.delete(id) },
      step: () => {
        const due = [...queue.entries()]
        queue.clear()
        for (const [, cb] of due) cb()
      },
      pending: () => queue.size,
    }
  }
  check('keyboard gap: settle frames is 1 or 2', SETTLE_FRAMES >= 1 && SETTLE_FRAMES <= 2)
  {
    const f = fakeClock()
    let n = 0
    const m = settleMeasure(f.clock, () => n++)
    m.kick()
    m.kick()
    m.kick()
    f.step()
    const afterFirst = n
    for (let i = 0; i < SETTLE_FRAMES; i++) f.step()
    check(`keyboard gap: kicks in one frame measure once, then once more ${SETTLE_FRAMES} frames later, then stop`, afterFirst === 1 && n === 2 && f.pending() === 0)
  }
  {
    // The device sequence: the scroll event comes while the view is still at about 87 (lift 345),
    // the final pan to 190.9 lands one frame later with no event of its own.
    const f = fakeClock()
    let viewTop = 87
    let lift = 0
    const m = settleMeasure(f.clock, () => {
      lift = composerLift({ containerBottom: 739.2, layoutHeight: 739.2, viewTop, viewHeight: 331.7, scale: 1, bar: ANDROID_KEYBOARD_BAR_ALLOWANCE })
    })
    m.kick()
    f.step()
    const first = lift
    viewTop = 190.9
    for (let i = 0; i < SETTLE_FRAMES; i++) f.step()
    check(`keyboard gap: the pan after the event's frame is seen by the settle measure (${first} -> ${lift})`, first === 345 && lift === 241)
  }
  {
    // A new event during the settle frames measures in its next frame and pushes the settle measure back.
    const f = fakeClock()
    let n = 0
    const m = settleMeasure(f.clock, () => n++)
    m.kick()
    f.step()
    m.kick()
    f.step()
    const second = n
    for (let i = 0; i < SETTLE_FRAMES; i++) f.step()
    check('keyboard gap: a new trigger during the settle measures next frame and settles again after it', second === 2 && n === 3 && f.pending() === 0)
  }
  {
    const f = fakeClock()
    let n = 0
    const m = settleMeasure(f.clock, () => n++)
    m.kick()
    m.stop()
    f.step()
    f.step()
    f.step()
    check('keyboard gap: stop cancels the pending measure', n === 0 && f.pending() === 0)
  }
}

console.log(failed === 0 ? '\nALL PASS' : `\n${failed} FAILED`)
if (failed > 0) process.exitCode = 1
