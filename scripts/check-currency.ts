/**
 * Checks the currency table (src/lib/money) and everything that reads it:
 * amount text and input per currency, whole-unit rules, the wire accepting
 * only known currencies, the JPY price needing two agreeing sources or a
 * plausible USD/JPY ratio, and every currency having its labels.
 * No network (C5 replaces fetch). Run: pnpm check:currency
 *
 * Numbering: C2 to C7.
 */
import { readFileSync } from 'node:fs'
import { CURRENCIES, type Currency } from '../src/contracts'
import { parseWireMessage } from '../src/lib/marmot/wire'
import { amountInputMode, defaultCurrency, formatMinorNumber, formatMoney, isCurrency, isMinor, minorToInput, sanitizeAmount } from '../src/lib/money'
import { createRatesSource, pickConfirmed } from '../src/lib/rates'

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

// ---------------------------------------------------------------- C2 text and input

eq('formatMoney JPY', formatMoney(1234567, 'JPY'), '¥1,234,567')
eq('formatMoney KRW', formatMoney(1234567, 'KRW'), '₩1,234,567')
eq('formatMoney USD (cents)', formatMoney(1250, 'USD'), '$12.50')
check('JPY symbol is the halfwidth yen sign U+00A5', formatMoney(1, 'JPY').charCodeAt(0) === 0xa5)

eq('sanitizeAmount JPY pasted drops decimals', sanitizeAmount('12.75', 'JPY', 'paste'), '12')
eq('sanitizeAmount JPY keeps 12 digits', sanitizeAmount('1234567890123', 'JPY'), '123,456,789,012')
eq('sanitizeAmount KRW keeps 12 digits', sanitizeAmount('1234567890123', 'KRW'), '123,456,789,012')
eq('sanitizeAmount USD keeps 2 decimals', sanitizeAmount('12.756', 'USD'), '12.75')
eq('sanitizeAmount USD groups thousands', sanitizeAmount('1234.5', 'USD'), '1,234.5')
eq('sanitizeAmount USD keeps 9 integer digits', sanitizeAmount('1234567890.5', 'USD'), '123,456,789.5')
eq('sanitizeAmount JPY strips leading zeros and letters', sanitizeAmount('00a5,000', 'JPY'), '5,000')
// Whole units, typed (the default): every non-digit goes, the point too. A '.' typed over a
// selected digit only removes that digit; it is never read as a fraction.
eq('sanitizeAmount JPY typed: 12.7 keeps both digits', sanitizeAmount('12.7', 'JPY'), '127')
eq('sanitizeAmount JPY typed: 12,3.45 → 12,345', sanitizeAmount('12,3.45', 'JPY', 'type'), '12,345')
eq('sanitizeAmount KRW typed: 12,3.45 → 12,345', sanitizeAmount('12,3.45', 'KRW', 'type'), '12,345')
eq('sanitizeAmount JPY typed over a selected digit: 12,3.5 → 1,235', sanitizeAmount('12,3.5', 'JPY', 'type'), '1,235')
eq('sanitizeAmount KRW typed: 1.,234,567 → 1,234,567', sanitizeAmount('1.,234,567', 'KRW', 'type'), '1,234,567')
eq('sanitizeAmount JPY typed: 1,234,56.7 → 1,234,567', sanitizeAmount('1,234,56.7', 'JPY', 'type'), '1,234,567')
eq('sanitizeAmount JPY typed: a trailing point goes', sanitizeAmount('12.', 'JPY', 'type'), '12')
eq('sanitizeAmount JPY typed: 1.000.000', sanitizeAmount('1.000.000', 'JPY', 'type'), '1,000,000')
eq('sanitizeAmount KRW typed: a leading point goes, the digits stay', sanitizeAmount('.75', 'KRW', 'type'), '75')
// Whole units, pasted or dropped: ends are trimmed first (symbol, unit word, space), then
// exactly one point with 1-2 trailing digits is a fraction to drop; any other point goes.
eq('sanitizeAmount JPY pasted: 12.75円 → 12', sanitizeAmount('12.75円', 'JPY', 'paste'), '12')
eq('sanitizeAmount KRW pasted: 1,000.50원 → 1,000', sanitizeAmount('1,000.50원', 'KRW', 'paste'), '1,000')
eq('sanitizeAmount JPY pasted: "12.75 " → 12', sanitizeAmount('12.75 ', 'JPY', 'paste'), '12')
eq('sanitizeAmount KRW pasted: 1.000.000 → 1,000,000', sanitizeAmount('1.000.000', 'KRW', 'paste'), '1,000,000')
eq('sanitizeAmount JPY pasted: .75 → empty', sanitizeAmount('.75', 'JPY', 'paste'), '')
// A pasted value that starts with a point is all fraction, whatever its length.
eq('sanitizeAmount JPY pasted: .5000 → empty', sanitizeAmount('.5000', 'JPY', 'paste'), '')
eq('sanitizeAmount KRW pasted: .123 → empty', sanitizeAmount('.123', 'KRW', 'paste'), '')
eq('sanitizeAmount JPY pasted: .5 → empty', sanitizeAmount('.5', 'JPY', 'paste'), '')
eq('sanitizeAmount JPY pasted: ¥.123 → empty', sanitizeAmount('¥.123', 'JPY', 'paste'), '')
eq('sanitizeAmount USD pasted: .75 keeps its cents', sanitizeAmount('.75', 'USD', 'paste'), '0.75')
eq('sanitizeAmount JPY pasted: 12.7 → 12', sanitizeAmount('12.7', 'JPY', 'paste'), '12')
eq('sanitizeAmount JPY pasted: ¥1,000.5 → 1,000', sanitizeAmount('¥1,000.5', 'JPY', 'paste'), '1,000')
eq('sanitizeAmount KRW pasted: " ₩12,000원 " → 12,000', sanitizeAmount(' ₩12,000원 ', 'KRW', 'paste'), '12,000')
eq('sanitizeAmount JPY pasted: 1.234567 keeps every digit', sanitizeAmount('1.234567', 'JPY', 'paste'), '1,234,567')
eq('sanitizeAmount JPY pasted: 1.000 (three after the point) keeps every digit', sanitizeAmount('1.000', 'JPY', 'paste'), '1,000')
eq('sanitizeAmount JPY pasted: 12.34.5 keeps every digit', sanitizeAmount('12.34.5', 'JPY', 'paste'), '12,345')
eq('sanitizeAmount JPY pasted: 12. → 12', sanitizeAmount('12.', 'JPY', 'paste'), '12')
// Dollars ignore the mode.
eq('sanitizeAmount USD typed: 12.', sanitizeAmount('12.', 'USD', 'type'), '12.')
eq('sanitizeAmount USD pasted: 12.', sanitizeAmount('12.', 'USD', 'paste'), '12.')
eq('sanitizeAmount USD typed: 1,23.4', sanitizeAmount('1,23.4', 'USD', 'type'), '123.4')
eq('sanitizeAmount USD pasted: 1,23.4', sanitizeAmount('1,23.4', 'USD', 'paste'), '123.4')
// Only paste and drop count as pasted.
eq('amountInputMode insertFromPaste', amountInputMode('insertFromPaste'), 'paste')
eq('amountInputMode insertFromDrop', amountInputMode('insertFromDrop'), 'paste')
eq('amountInputMode insertText', amountInputMode('insertText'), 'type')
// A keyboard suggestion or autocorrect puts several characters in at once: read as a paste.
eq('amountInputMode insertReplacementText', amountInputMode('insertReplacementText'), 'paste')
eq('amountInputMode insertReplacementText, one character', amountInputMode('insertReplacementText', '5'), 'paste')
eq('amountInputMode insertText one character', amountInputMode('insertText', '5'), 'type')
eq('amountInputMode insertText two characters', amountInputMode('insertText', '12'), 'paste')
eq('amountInputMode insertText a suggestion', amountInputMode('insertText', '12.75'), 'paste')
eq('amountInputMode insertText one fullwidth digit', amountInputMode('insertText', '５'), 'type')
// IME composition is always typing: data is the whole text composed so far, not one insertion.
eq('amountInputMode insertCompositionText two characters', amountInputMode('insertCompositionText', '１２'), 'type')
eq('amountInputMode insertCompositionText 12.75', amountInputMode('insertCompositionText', '１２．７５'), 'type')
eq('amountInputMode insertCompositionText one character', amountInputMode('insertCompositionText', '１'), 'type')
eq('amountInputMode insertText while composing, two characters', amountInputMode('insertText', '１２', true), 'type')
eq('amountInputMode insertFromPaste while composing', amountInputMode('insertFromPaste', '12.75', true), 'type')
eq('amountInputMode insertText two characters, not composing', amountInputMode('insertText', '12', false), 'paste')
// WebKit (iOS Safari) commits a composition as deleteCompositionText then insertFromComposition,
// possibly with isComposing already false: still typing, not a paste.
eq('amountInputMode insertFromComposition two characters', amountInputMode('insertFromComposition', '１２', false), 'type')
eq('amountInputMode insertFromComposition 12.75', amountInputMode('insertFromComposition', '１２．７５'), 'type')
eq('amountInputMode deleteCompositionText', amountInputMode('deleteCompositionText', null, false), 'type')
eq('JPY committed composition １２．７ via insertFromComposition → 127', sanitizeAmount('１２．７', 'JPY', amountInputMode('insertFromComposition', '１２．７', false)), '127')
eq('JPY composing １２．７ keeps both digits like typing → 127', sanitizeAmount('１２．７', 'JPY', amountInputMode('insertCompositionText', '１２．７')), '127')
eq('amountInputMode insertText null data', amountInputMode('insertText', null), 'type')
eq('amountInputMode deleteContentBackward', amountInputMode('deleteContentBackward', null), 'type')
eq('amountInputMode none', amountInputMode(undefined), 'type')
// A suggestion of 12.75 in a whole-unit field drops the fraction like a paste.
eq('JPY suggestion 12.75 via insertText → 12', sanitizeAmount('12.75', 'JPY', amountInputMode('insertText', '12.75')), '12')

// Fullwidth digits, comma and point (a Japanese keyboard) become ASCII first, in both modes.
eq('sanitizeAmount JPY typed fullwidth: １２，３４５ → 12,345', sanitizeAmount('１２，３４５', 'JPY', 'type'), '12,345')
eq('sanitizeAmount KRW typed fullwidth: １２，３４５ → 12,345', sanitizeAmount('１２，３４５', 'KRW', 'type'), '12,345')
eq('sanitizeAmount JPY pasted fullwidth: １２，３４５ → 12,345', sanitizeAmount('１２，３４５', 'JPY', 'paste'), '12,345')
eq('sanitizeAmount JPY pasted fullwidth: １２．７５円 → 12', sanitizeAmount('１２．７５円', 'JPY', 'paste'), '12')
eq('sanitizeAmount JPY typed fullwidth: １２．７ → 127', sanitizeAmount('１２．７', 'JPY', 'type'), '127')
eq('sanitizeAmount JPY pasted fullwidth: ．７５ → empty', sanitizeAmount('．７５', 'JPY', 'paste'), '')
eq('sanitizeAmount JPY pasted fullwidth yen: ￥１，０００ → 1,000', sanitizeAmount('￥１，０００', 'JPY', 'paste'), '1,000')
eq('sanitizeAmount USD fullwidth: １２．５ → 12.5', sanitizeAmount('１２．５', 'USD', 'type'), '12.5')
eq('sanitizeAmount USD pasted fullwidth: １２．５ → 12.5', sanitizeAmount('１２．５', 'USD', 'paste'), '12.5')
eq('sanitizeAmount JPY fullwidth 10000', sanitizeAmount('１００００', 'JPY'), '10,000')
// Only those: compatibility characters that NFKC would turn into digits stay non-digits and go.
eq('sanitizeAmount JPY 1½ → 1', sanitizeAmount('1½', 'JPY'), '1')
eq('sanitizeAmount JPY pasted 1½ → 1', sanitizeAmount('1½', 'JPY', 'paste'), '1')
eq('sanitizeAmount KRW ①⓪⓪ → empty', sanitizeAmount('①⓪⓪', 'KRW'), '')
eq('sanitizeAmount JPY pasted ①⓪⓪ → empty', sanitizeAmount('①⓪⓪', 'JPY', 'paste'), '')
eq('sanitizeAmount JPY ² → empty', sanitizeAmount('²', 'JPY'), '')
eq('sanitizeAmount USD 100m² → 100', sanitizeAmount('100m²', 'USD'), '100')
eq('sanitizeAmount KRW pasted 100m² → 100', sanitizeAmount('100m²', 'KRW', 'paste'), '100')

eq('minorToInput JPY', minorToInput(500000, 'JPY'), '500,000')
eq('minorToInput KRW', minorToInput(1000000, 'KRW'), '1,000,000')
eq('minorToInput USD (cents)', minorToInput(123450, 'USD'), '1,234.50')

// System lines put the number into the room's sysMoney{C} keys (unit words live there).
eq('formatMinorNumber JPY', formatMinorNumber(1000, 'JPY'), '1,000')
eq('formatMinorNumber KRW', formatMinorNumber(10000, 'KRW'), '10,000')
eq('formatMinorNumber USD keeps two cent digits', formatMinorNumber(1250, 'USD'), '12.50')
eq('formatMinorNumber USD 150 cents', formatMinorNumber(150, 'USD'), '1.50')
eq('formatMinorNumber USD 100 cents', formatMinorNumber(100, 'USD'), '1')
eq('formatMinorNumber USD 205 cents', formatMinorNumber(205, 'USD'), '2.05')
eq('formatMinorNumber USD 5 cents', formatMinorNumber(5, 'USD'), '0.05')
eq('formatMinorNumber USD keeps cents', formatMinorNumber(1205, 'USD'), '12.05')
eq('formatMinorNumber USD whole', formatMinorNumber(1200, 'USD'), '12')

eq("defaultCurrency('ko', ['ja'])", defaultCurrency('ko', ['ja']), 'KRW')
eq("defaultCurrency('ja', [])", defaultCurrency('ja', []), 'JPY')
eq("defaultCurrency('ja', ['ko'])", defaultCurrency('ja', ['ko']), 'JPY')
eq("defaultCurrency('en', [])", defaultCurrency('en', []), 'USD')
eq("defaultCurrency('en', ['ja-JP', 'en'])", defaultCurrency('en', ['ja-JP', 'en']), 'JPY')
eq("defaultCurrency('en', ['en-US', 'ja'])", defaultCurrency('en', ['en-US', 'ja']), 'USD')
eq("defaultCurrency('en', ['fr', 'JA'])", defaultCurrency('en', ['fr', 'JA']), 'JPY')
eq("defaultCurrency('en', ['ko-KR', 'ja'])", defaultCurrency('en', ['ko-KR', 'ja']), 'USD')

// ---------------------------------------------------------------- C3 amount rules

check('isMinor(1000)', isMinor(1000))
check('not isMinor(1000.5): JPY and KRW have no fractions, USD is cents', !isMinor(1000.5))
check('not isMinor(0)', !isMinor(0))
check('not isMinor(-5)', !isMinor(-5))
check('not isMinor(NaN or Infinity or text)', ![NaN, Infinity, '1000', null].some((v) => isMinor(v)))
check('isMinor(99999999999) (USD 999,999,999.99 in cents)', isMinor(99_999_999_999))
check('partial done: 100000 - 30000 stays a valid amount', isMinor(100000 - 30000) && 100000 - 30000 === 70000)

// ---------------------------------------------------------------- C4 wire

const offerMsg = (currency: unknown) => JSON.stringify({ t: 'offer', offer: { side: 'sell', currency, amountMinor: 70001, feePct: 2, methods: ['lightning', 'onchain'], createdAt: 1 } })
const DONE_ID = '0123456789abcdef0123456789abcdef'
const doneMsg = (currency: unknown) => JSON.stringify({ t: 'done', id: DONE_ID, amountMinor: 5000, currency })
{
  const o = parseWireMessage(offerMsg('JPY'))
  check('wire accepts a JPY offer', o?.t === 'offer' && o.offer.currency === 'JPY' && o.offer.amountMinor === 70001)
  const d = parseWireMessage(doneMsg('JPY'))
  check('wire accepts a JPY done', d?.t === 'done' && d.currency === 'JPY' && d.amountMinor === 5000 && d.id === DONE_ID)
  for (const bad of ['EUR', 'jpy', '', 1]) {
    check(`wire drops an offer in ${JSON.stringify(bad)}`, parseWireMessage(offerMsg(bad)) === null)
    check(`wire drops a done in ${JSON.stringify(bad)}`, parseWireMessage(doneMsg(bad)) === null)
  }
  check('isCurrency is exact', isCurrency('JPY') && !isCurrency('jpy') && !isCurrency('EUR') && !isCurrency(undefined))
}

// ---------------------------------------------------------------- C5 JPY price
// Prices measured on 2026-11-13.
const BITBANK = 11_511_750
const CB_RATES = 11_488_449
const KRAKEN_JPY = 11_333_333
const BTC_USD = 71_926
const CB_JPY_SPOT_WRONG = 35_600_000

eq('pickConfirmed: two agreeing sources give bitbank', pickConfirmed([BITBANK, CB_RATES], BTC_USD), BITBANK)
eq('pickConfirmed: the 3.1x value is refused', pickConfirmed([CB_JPY_SPOT_WRONG, CB_RATES], BTC_USD), CB_RATES)
eq('pickConfirmed: one source and no USD price gives nothing', pickConfirmed([BITBANK], undefined), undefined)
eq('pickConfirmed: one source within the USD/JPY band', pickConfirmed([BITBANK], BTC_USD), BITBANK)
eq('pickConfirmed: one source outside the band gives nothing', pickConfirmed([CB_JPY_SPOT_WRONG], BTC_USD), undefined)
eq('pickConfirmed: disagreeing and no USD gives nothing', pickConfirmed([CB_JPY_SPOT_WRONG, CB_RATES], undefined), undefined)
eq('pickConfirmed: Kraken settles a disagreement', pickConfirmed([CB_JPY_SPOT_WRONG, CB_RATES, KRAKEN_JPY], undefined), CB_RATES)
eq('pickConfirmed: nothing gives nothing', pickConfirmed([], BTC_USD), undefined)

type Reply = number | 'fail'
interface Market {
  upbit: Reply
  bithumb: Reply
  cbUsd: Reply
  krakenUsd: Reply
  bitbank: Reply
  cbRates: Reply
  krakenJpy: Reply
}
const ok: Market = {
  upbit: 150_000_000,
  bithumb: 150_000_000,
  cbUsd: BTC_USD,
  krakenUsd: BTC_USD,
  bitbank: BITBANK,
  cbRates: CB_RATES,
  krakenJpy: KRAKEN_JPY,
}

/** Replaces fetch and Date.now; every requested URL is recorded. */
const realFetch = globalThis.fetch
const realNow = Date.now
let market: Market = ok
let clock = 1_800_000_000_000
const asked: string[] = []
const everAsked: string[] = []
function body(url: string): unknown {
  const v = (r: Reply) => (r === 'fail' ? undefined : r)
  if (url.startsWith('https://api.upbit.com/')) return v(market.upbit) && [{ trade_price: v(market.upbit) }]
  if (url.startsWith('https://api.bithumb.com/')) return v(market.bithumb) && { data: { closing_price: String(v(market.bithumb)) } }
  if (url === 'https://api.coinbase.com/v2/prices/BTC-USD/spot') return v(market.cbUsd) && { data: { amount: String(v(market.cbUsd)) } }
  if (url.includes('api.kraken.com') && url.endsWith('XBTUSD')) return v(market.krakenUsd) && { result: { XXBTZUSD: { c: [String(v(market.krakenUsd)), '1'] } } }
  if (url.includes('api.kraken.com') && url.endsWith('XBTJPY')) return v(market.krakenJpy) && { result: { XXBTZJPY: { c: [String(v(market.krakenJpy)), '1'] } } }
  if (url === 'https://public.bitbank.cc/btc_jpy/ticker') return v(market.bitbank) && { success: 1, data: { last: String(v(market.bitbank)) } }
  if (url === 'https://api.coinbase.com/v2/exchange-rates?currency=BTC') return v(market.cbRates) && { data: { currency: 'BTC', rates: { USD: String(BTC_USD), JPY: String(v(market.cbRates)) } } }
  return undefined
}
globalThis.fetch = (async (input: string | URL | Request) => {
  const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url
  asked.push(url)
  everAsked.push(url)
  const b = body(url)
  if (b === undefined) return new Response('unavailable', { status: 503 })
  return new Response(JSON.stringify(b), { status: 200, headers: { 'content-type': 'application/json' } })
}) as typeof fetch
Date.now = () => clock
const askedKrakenJpy = () => asked.some((u) => u.includes('api.kraken.com') && u.endsWith('XBTJPY'))

try {
  {
    market = ok
    asked.length = 0
    const r = await createRatesSource().fetch()
    eq('rates: JPY from two agreeing sources', r.JPY, BITBANK)
    check('rates: KRW and USD still come', r.KRW === 150_000_000 && r.USD === BTC_USD)
    check(
      'rates: bitbank and Coinbase exchange-rates are both asked',
      asked.includes('https://public.bitbank.cc/btc_jpy/ticker') && asked.includes('https://api.coinbase.com/v2/exchange-rates?currency=BTC'),
    )
    check('rates: Kraken XBTJPY not asked when the two agree', !askedKrakenJpy())
  }
  {
    market = { ...ok, cbRates: CB_JPY_SPOT_WRONG, cbUsd: 'fail', krakenUsd: 'fail' }
    asked.length = 0
    const r = await createRatesSource().fetch()
    check('rates: Kraken XBTJPY asked when the two disagree and no USD', askedKrakenJpy())
    eq('rates: Kraken picks the agreeing source', r.JPY, BITBANK)
  }
  {
    market = { ...ok, cbRates: CB_JPY_SPOT_WRONG }
    asked.length = 0
    const r = await createRatesSource().fetch()
    eq('rates: disagreement settled by the USD band', r.JPY, BITBANK)
    check('rates: Kraken XBTJPY not asked when the USD band settles it', !askedKrakenJpy())
  }
  {
    market = { ...ok, bitbank: CB_JPY_SPOT_WRONG, cbRates: 'fail', cbUsd: 'fail', krakenUsd: 'fail', krakenJpy: 'fail' }
    asked.length = 0
    const r = await createRatesSource().fetch()
    eq('rates: an unconfirmed single JPY price is not used', r.JPY, undefined)
  }
  {
    // Cached USD: first round all good; 31 s later (past the 30 s cache) only bitbank answers.
    market = ok
    const src = createRatesSource()
    const first = await src.fetch()
    const t0 = clock
    clock = t0 + 31_000
    market = { ...ok, upbit: 'fail', bithumb: 'fail', cbUsd: 'fail', krakenUsd: 'fail', cbRates: 'fail', krakenJpy: 'fail', bitbank: 11_600_000 }
    const second = await src.fetch()
    check('rates: first round has JPY', first.JPY === BITBANK)
    eq('rates: fresh cached USD confirms a lone bitbank price', second.JPY, 11_600_000)

    // Same, but the cached USD is older than 10 minutes: no update, and the old JPY is stale too.
    const src2 = createRatesSource()
    market = ok
    clock = t0 + 100_000
    await src2.fetch()
    clock += 11 * 60_000
    market = { ...ok, upbit: 'fail', bithumb: 'fail', cbUsd: 'fail', krakenUsd: 'fail', cbRates: 'fail', krakenJpy: 'fail', bitbank: 11_600_000 }
    const late = await src2.fetch()
    eq('rates: stale cached USD does not confirm a lone bitbank price', late.JPY, undefined)
  }
  check('rates: Coinbase /prices/BTC-JPY is never asked', everAsked.length > 0 && !everAsked.some((u) => u.includes('/prices/BTC-JPY')))
} finally {
  globalThis.fetch = realFetch
  Date.now = realNow
}

// ---------------------------------------------------------------- C6 labels per currency

/** The ko and en blocks of one registerStrings file, as raw text. */
function blocks(path: string): { ko: string; en: string } {
  const src = readFileSync(new URL(`../${path}`, import.meta.url), 'utf8')
  const ko = src.indexOf('\n  ko: {')
  const en = src.indexOf('\n  en: {')
  if (ko < 0 || en < 0 || en < ko) throw new Error(`${path}: ko and en blocks not found`)
  return { ko: src.slice(ko, en), en: src.slice(en) }
}
const hasKey = (block: string, key: string) => new RegExp(`\\n\\s+${key}:\\s`).test(block)
{
  const board = blocks('src/screens/board/strings.ts')
  const room = blocks('src/screens/room/strings.ts')
  for (const c of CURRENCIES) {
    const boardKeys = [`cur${c}`, `opt${c}`, `add${c}0`, `add${c}1`, `add${c}2`, `add${c}3`]
    // Only that the keys exist: check-i18n T1 fails when English differs from Korean,
    // so the English block is not counted again here.
    const missing = boardKeys.filter((k) => !hasKey(board.ko, k))
    check(`board has the labels of ${c}`, missing.length === 0, `missing ${missing.join(', ')}`)
    check(`room has the name of ${c}`, hasKey(room.ko, c))
    check(`room has the system-line amount of ${c} in Korean and English`, hasKey(room.ko, `sysMoney${c}`) && hasKey(room.en, `sysMoney${c}`))
  }
}

// ---------------------------------------------------------------- C7 no Korean or Japanese in the money module

{
  const src = readFileSync(new URL('../src/lib/money/index.ts', import.meta.url), 'utf8')
  // Hangul, kana, CJK ideographs, halfwidth kana. Unit words belong in the room table (sysMoney{C}).
  const found = src.match(/[ᄀ-ᇿ㄰-㆏가-힯぀-ヿㇰ-ㇿ㐀-䶿一-鿿ｦ-ﾟ]/g)
  check('src/lib/money has no Korean or Japanese text', found === null, `found ${found?.join('')}`)
}

// Every currency is wired through the table (a missing row is a type error; this guards the order).
check('CURRENCIES are KRW, USD, JPY in display order', CURRENCIES.join() === (['KRW', 'USD', 'JPY'] satisfies Currency[]).join())

console.log(failed === 0 ? '\nALL PASS' : `\n${failed} FAILED`)
if (failed > 0) process.exitCode = 1
