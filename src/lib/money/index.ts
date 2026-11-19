/**
 * The one currency table. Everything that depends on the currency (symbol,
 * decimals, input rules, quick-add chips, first currency) reads it from here,
 * so a new currency in `CURRENCIES` fails to compile until it is filled in.
 *
 * Amounts are minor units everywhere they are stored, sent or subtracted:
 * integers of won, yen or cents (isMinor). Only sats and rates are estimates.
 *
 * No DOM, and no Korean or Japanese text: unit words for system lines and labels
 * live in the string tables (keys cur{C}, opt{C}, add{C}0..3 in board; {C} and
 * sysMoney{C} in room).
 */
import { CURRENCIES, type Currency, type Lang } from '../../contracts'

export interface CurrencyInfo {
  /** Digits after the point. 0 means whole units only (KRW, JPY). */
  decimals: 0 | 2
  /** Shown before the amount in every language: ₩ $ ¥ (U+00A5, not the fullwidth ￥). */
  symbol: string
  /** Integer digits the amount field accepts. */
  maxIntDigits: number
  /** Quick-add chip values, in major units. Labels are board keys add{C}0..3. */
  quickAdd: readonly [number, number, number, number]
  inputMode: 'numeric' | 'decimal'
}

export const CURRENCY: Record<Currency, CurrencyInfo> = {
  KRW: { decimals: 0, symbol: '₩', maxIntDigits: 12, quickAdd: [10_000, 50_000, 100_000, 1_000_000], inputMode: 'numeric' },
  USD: { decimals: 2, symbol: '$', maxIntDigits: 9, quickAdd: [10, 50, 100, 500], inputMode: 'decimal' },
  JPY: { decimals: 0, symbol: '¥', maxIntDigits: 12, quickAdd: [10_000, 50_000, 100_000, 500_000], inputMode: 'numeric' },
}

/** A Japanese screen starts in yen. */
export const DEFAULT_CURRENCY: Record<Lang, Currency> = { ko: 'KRW', en: 'USD', ja: 'JPY' }

/**
 * First currency of the offer sheet. `langs` is navigator.languages, passed in
 * so Node checks need no DOM. An English screen whose browser puts Japanese
 * before Korean and English starts in JPY.
 */
export function defaultCurrency(lang: Lang, langs: readonly string[] = []): Currency {
  if (lang === 'en') {
    for (const raw of langs) {
      const base = String(raw).toLowerCase().split('-')[0]
      if (base === 'ja') return 'JPY'
      if (base === 'ko' || base === 'en') break
    }
  }
  return DEFAULT_CURRENCY[lang]
}

/** Exact, case-sensitive: 'jpy' and 'EUR' are not currencies. */
export function isCurrency(v: unknown): v is Currency {
  return typeof v === 'string' && (CURRENCIES as readonly string[]).includes(v)
}

/** Minor units per major unit: 10 ** CURRENCY[c].decimals, so the two tables never disagree. */
export const MINOR_PER_UNIT: Record<Currency, number> = Object.fromEntries(CURRENCIES.map((c) => [c, 10 ** CURRENCY[c].decimals])) as Record<Currency, number>

/** Twelve digits: the most the KRW and JPY amount fields can hold (USD tops out at 99,999,999,999 cents). */
export const MAX_MINOR = 999_999_999_999

/** How far above the trade amount an invoice may ask before it is flagged: prices move while people talk. */
export const OVER_TOLERANCE = 0.03

/**
 * A safe integer from 1 to MAX_MINOR. Every stored or sent fiat amount passes
 * this: amounts are minor units (KRW won, JPY yen, USD cents), never fractions.
 */
export function isMinor(n: unknown): n is number {
  return typeof n === 'number' && Number.isSafeInteger(n) && n >= 1 && n <= MAX_MINOR
}

const group = (digits: string) => (digits ? Number(digits).toLocaleString('en-US') : '')

/** Whole part of a minor amount (sign dropped) and its two-digit cents, by integer arithmetic only. */
function splitMinor(minor: number): { whole: number; cents: string } {
  const m = Math.abs(Math.trunc(minor))
  return { whole: Math.floor(m / 100), cents: String(m % 100).padStart(2, '0') }
}

/** ₩50,000 · ¥50,000 · $1.05 from minor units. Integer arithmetic only; en-US grouping in every language. */
export function formatMoney(minor: number, currency: Currency): string {
  const { decimals, symbol } = CURRENCY[currency]
  const sign = minor < 0 ? '-' : ''
  if (decimals === 0) return `${sign}${symbol}${Math.abs(Math.trunc(minor)).toLocaleString('en-US')}`
  const { whole, cents } = splitMinor(minor)
  return `${sign}${symbol}${whole.toLocaleString('en-US')}.${cents}`
}

/**
 * The number alone, without symbol, for sentences that put a unit word after it
 * (the room's system lines and the completion button): 1,000 · 12.50 · 12.05 · 12. A whole
 * dollar amount has no cents; any other has two digits, never one ($1.50, not $1.5).
 */
export function formatMinorNumber(minor: number, currency: Currency): string {
  if (CURRENCY[currency].decimals === 0) return Math.abs(Math.trunc(minor)).toLocaleString('en-US')
  const { whole, cents } = splitMinor(minor)
  return /^0+$/.test(cents) ? whole.toLocaleString('en-US') : `${whole.toLocaleString('en-US')}.${cents}`
}

/** +1% / −0.5% / 0%. Uses a real minus sign. */
export function formatFee(feePct: number): string {
  const n = Number(feePct.toFixed(2))
  if (n > 0) return `+${n}%`
  if (n < 0) return `−${Math.abs(n)}%`
  return '0%'
}

export function formatSats(sats: number): string {
  return Math.round(sats).toLocaleString('en-US')
}

/** BTC price in major units with the premium, or null when there is no usable price. */
function priceOf(rate: number | undefined, feePct: number): number | null {
  if (rate === undefined) return null
  const price = rate * (1 + feePct / 100)
  return Number.isFinite(price) && price > 0 ? price : null
}

/**
 * Sats for `minor` when 1 BTC costs `rate` (major units) plus `feePct` percent.
 * Null without a usable rate. Display only: sats are an estimate, never stored.
 */
export function satsFor(minor: number, currency: Currency, rate: number | undefined, feePct: number): number | null {
  const price = priceOf(rate, feePct)
  if (price === null || !Number.isFinite(minor)) return null
  return (minor / MINOR_PER_UNIT[currency] / price) * 1e8
}

/**
 * Sats a buyer asks for `minor` at `rate` (major units per BTC) plus `feePct`.
 * Rounded down, so it never asks the seller for more than their own price.
 * Null without a usable rate, below 1 sat or past a safe integer. Multiplying
 * first keeps exact cases exact (KRW 150,000 at 150,000,000 -> 100,000).
 */
export function requestSats(minor: number, currency: Currency, rate: number | undefined, feePct: number): number | null {
  if (priceOf(rate, feePct) === null || !Number.isFinite(minor)) return null
  const sats = Math.floor((minor * 1e8 * 100) / (MINOR_PER_UNIT[currency] * (rate as number) * (100 + feePct)))
  return Number.isSafeInteger(sats) && sats >= 1 ? sats : null
}

/** Fiat value of `sats` in minor units at `rate` plus `feePct`. Null without a usable rate or when it rounds outside isMinor. */
export function fiatFor(sats: number, rate: number | undefined, feePct: number, currency: Currency): number | null {
  const price = priceOf(rate, feePct)
  if (price === null || !Number.isFinite(sats)) return null
  const minor = Math.round((sats / 1e8) * price * MINOR_PER_UNIT[currency])
  return isMinor(minor) ? minor : null
}

/** OVER_TOLERANCE in basis points (300), so the comparison below stays in integers. */
const OVER_BP = BigInt(Math.round(OVER_TOLERANCE * 10_000))
/** The rate in millionths of a major unit and the premium in ten-thousandths of a percent. */
const RATE_SCALE = 1_000_000
const FEE_SCALE = 10_000

/**
 * True when `amountSats` asks for more than `boundMinor` is worth at `rate` plus
 * `feePct`, by more than OVER_TOLERANCE (CardView.over):
 * amountSats > satsFor(boundMinor) × (1 + OVER_TOLERANCE). Decided in integers
 * (BigInt): the rate is taken to a millionth of a major unit and the premium to a
 * ten-thousandth of a percent, then both sides are multiplied out, so an amount right on
 * the limit is never flagged by a rounding error. False without a usable rate or amount.
 */
export function asksOver(amountSats: number, boundMinor: number, currency: Currency, rate: number | undefined, feePct: number): boolean {
  if (priceOf(rate, feePct) === null || !Number.isSafeInteger(amountSats) || amountSats < 0 || !isMinor(boundMinor)) return false
  const r = BigInt(Math.round(rate! * RATE_SCALE))
  const f = BigInt(Math.round((100 + feePct) * FEE_SCALE))
  if (r <= 0n || f <= 0n) return false
  // sats × price × MINOR_PER_UNIT > bound × 1e8 × (1 + tolerance), with
  // price = (r / RATE_SCALE) × (f / (100 × FEE_SCALE)) and (1 + tolerance) = (10,000 + OVER_BP) / 10,000.
  const left = BigInt(amountSats) * r * f * BigInt(MINOR_PER_UNIT[currency]) * 10_000n
  const right = BigInt(boundMinor) * 100_000_000n * (10_000n + OVER_BP) * BigInt(RATE_SCALE) * 100n * BigInt(FEE_SCALE)
  return left > right
}

/**
 * Exact parse of the amount field text into minor units, without floating point:
 * the digit strings are read as integers and the cents added. Commas are ignored.
 * NaN unless the result passes isMinor ('', '.', '0', '1.234' in USD, '1.5' in KRW).
 */
export function parseMinor(text: string, currency: Currency): number {
  const t = text.replace(/,/g, '')
  let minor: number
  if (CURRENCY[currency].decimals === 0) {
    if (!/^\d+$/.test(t)) return NaN
    minor = Number(t)
  } else {
    const m = /^(\d*)(?:\.(\d{0,2}))?$/.exec(t)
    if (!m || (m[1] === '' && (m[2] ?? '') === '')) return NaN
    minor = Number(m[1] || '0') * 100 + Number((m[2] ?? '').padEnd(2, '0'))
  }
  return isMinor(minor) ? minor : NaN
}

/**
 * Fullwidth digits ０-９ (U+FF10-FF19), the fullwidth point ． (U+FF0E) and comma ，
 * (U+FF0C) become their ASCII forms; every other character is left as it is. This is
 * deliberately narrower than NFKC, which would also turn ½, ①, ² and the like into
 * digits ('100m²' would become 1002).
 */
export function toAsciiDigits(raw: string): string {
  return raw.replace(/[\uFF0C\uFF0E\uFF10-\uFF19]/g, (ch) => String.fromCharCode(ch.charCodeAt(0) - 0xfee0))
}

/**
 * How a change reached an amount field. 'paste' is anything that put more than
 * one character in at once: a paste or drop, a keyboard suggestion or autocorrect
 * (insertReplacementText), or any input event whose data is two or more
 * characters (some phone keyboards insert a suggestion as insertText). Single
 * keystrokes, deletions and changes with no event data are 'type'.
 *
 * IME composition (a Japanese or Korean keyboard) is always 'type': while composing,
 * `data` is the whole text composed so far, not one insertion, so its length says
 * nothing about a paste. That covers inputType 'insertCompositionText' and any event
 * the browser marks with isComposing, and also WebKit's (iOS Safari) commit of a
 * composition: 'deleteCompositionText' followed by 'insertFromComposition', which
 * may arrive with isComposing already false.
 */
export type AmountInputMode = 'type' | 'paste'

/** The mode for an input event's inputType and data (TextField passes both to onChange). */
export function amountInputMode(inputType: string | undefined, data?: string | null, composing?: boolean): AmountInputMode {
  if (composing || inputType === 'insertCompositionText' || inputType === 'insertFromComposition' || inputType === 'deleteCompositionText') {
    return 'type'
  }
  if (inputType === 'insertFromPaste' || inputType === 'insertFromDrop' || inputType === 'insertReplacementText') {
    return 'paste'
  }
  return typeof data === 'string' && [...data].length >= 2 ? 'paste' : 'type'
}

/**
 * Keeps only what an amount field may hold and adds thousands separators.
 *
 * First the fullwidth digits, comma and point from a Japanese keyboard become ASCII
 * (１２，３４５ gives 12,345), in every mode and currency (`toAsciiDigits`). Nothing
 * else is converted: compatibility characters such as ½, ①, ² stay non-digits and go
 * like any other letter (no NFKC on the whole text, so '1½' is 1, not 112).
 *
 * Whole units (KRW, JPY) have no point, so what a point means depends on how it came in:
 * - 'type': every non-digit goes, the point included. A '.' typed over a selected
 *   digit only removes that digit; it is never read as a fraction that drops what
 *   follows (12,345 → 12,3.45 gives 12,345; 12,3.5 gives 1,235).
 * - 'paste': non-digits at both ends go first (a symbol, unit word or space), keeping
 *   a leading point. A value that then starts with a point is all fraction and gives
 *   empty, whatever its length (.75, .5000 and ¥.123 all give ''). Exactly one point
 *   followed by 1-2 trailing digits is a fraction and is dropped (12.75 plus a unit
 *   word → 12, 1,000.50 → 1,000). Otherwise every non-digit goes (1.000.000 → 1,000,000).
 * USD ignores the mode.
 */
export function sanitizeAmount(raw: string, currency: Currency, mode: AmountInputMode = 'type'): string {
  const { decimals, maxIntDigits } = CURRENCY[currency]
  const text = toAsciiDigits(raw)
  if (decimals === 0) {
    let digits = text
    if (mode === 'paste') {
      const trimmed = text.replace(/^[^\d.]+|\D+$/g, '')
      if (trimmed.startsWith('.')) return ''
      const looksDecimal = trimmed.split('.').length === 2 && /\.\d{1,2}$/.test(trimmed)
      digits = looksDecimal ? trimmed.slice(0, trimmed.lastIndexOf('.')) : trimmed
    }
    return group(
      digits
        .replace(/\D/g, '')
        .replace(/^0+(?=\d)/, '')
        .slice(0, maxIntDigits),
    )
  }
  const cleaned = text.replace(/[^\d.]/g, '')
  const dot = cleaned.indexOf('.')
  const intDigits = (dot < 0 ? cleaned : cleaned.slice(0, dot)).replace(/^0+(?=\d)/, '').slice(0, maxIntDigits)
  if (dot < 0) return group(intDigits)
  const frac = cleaned
    .slice(dot + 1)
    .replace(/\./g, '')
    .slice(0, decimals)
  return `${group(intDigits) || '0'}.${frac}`
}

/**
 * How many characters before `pos` in the raw field text survive `sanitizeAmount`:
 * digits, plus the point when the currency has decimals (no currency: digits only).
 * Counted after `toAsciiDigits` like sanitizeAmount, so a fullwidth digit counts as one
 * and a fullwidth comma not at all. The caret goes back after that many characters of the
 * formatted text (src/ui/caret.ts). significantBefore('１２，３', 4) is 3.
 */
export function significantBefore(raw: string, pos: number, currency?: Currency): number {
  const test = currency && CURRENCY[currency].decimals > 0 ? /[\d.]/ : /\d/
  let n = 0
  for (const ch of toAsciiDigits(raw.slice(0, pos))) if (test.test(ch)) n++
  return n
}

/**
 * Field text for `minor`, in the shape `sanitizeAmount` produces: decimals 0
 * "1,234,567"; decimals 2 "1,234" when whole, else "1,234.05".
 */
export function minorToInput(minor: number, currency: Currency): string {
  if (CURRENCY[currency].decimals === 0) return group(String(Math.abs(Math.trunc(minor))))
  const { whole, cents } = splitMinor(minor)
  return cents === '00' ? group(String(whole)) : `${group(String(whole)) || '0'}.${cents}`
}
