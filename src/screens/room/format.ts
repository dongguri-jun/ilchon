import type { Currency } from '../../contracts'

export function formatMoney(amount: number, currency: Currency): string {
  if (currency === 'KRW') return `₩${Math.round(amount).toLocaleString('en-US')}`
  return `$${amount.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`
}

export function formatFee(feePct: number): string {
  const n = Number(feePct.toFixed(2))
  return `${n > 0 ? '+' : ''}${n}%`
}

export function formatSats(sats: number): string {
  return Math.round(sats).toLocaleString('en-US')
}

/** Sats for `fiat` when 1 BTC costs `rate` plus a premium of `feePct` percent. */
export function satsFor(fiat: number, rate: number, feePct: number): number | null {
  const price = rate * (1 + feePct / 100)
  if (!Number.isFinite(price) || price <= 0) return null
  return (fiat / price) * 1e8
}

/** Keeps only what a fiat amount field may hold; KRW gets thousands separators. */
export function sanitizeAmountInput(raw: string, currency: Currency): string {
  if (currency === 'KRW') {
    const digits = raw.replace(/\D/g, '').replace(/^0+(?=\d)/, '')
    return digits ? Number(digits).toLocaleString('en-US') : ''
  }
  const cleaned = raw.replace(/[^\d.]/g, '')
  const dot = cleaned.indexOf('.')
  if (dot < 0) return cleaned
  return `${cleaned.slice(0, dot)}.${cleaned.slice(dot + 1).replace(/\./g, '').slice(0, 2)}`
}

export function parseAmountInput(text: string): number {
  const n = Number(text.replace(/,/g, ''))
  return Number.isFinite(n) ? n : NaN
}

export function amountToInput(amount: number, currency: Currency): string {
  if (currency === 'KRW') return Math.round(amount).toLocaleString('en-US')
  return String(Number(amount.toFixed(2)))
}

const LN_PREFIX = /^(lightning:)?(lnbc|lntb|lnurl)[0-9a-z]+$/i
const LN_ADDRESS = /^[^\s@]+@[^\s@.]+(\.[^\s@.]+)*\.[a-z]{2,}$/i

/** True for one whitespace-free token that looks like an invoice, LNURL or Lightning address. */
export function isLightningToken(token: string): boolean {
  return LN_PREFIX.test(token) || LN_ADDRESS.test(token)
}

export function truncateMiddle(text: string, head = 12, tail = 8): string {
  if (text.length <= head + tail + 1) return text
  return `${text.slice(0, head)}…${text.slice(-tail)}`
}

export function formatClock(at: number): string {
  // Tolerates unix seconds as well as milliseconds.
  const d = new Date(at < 1e12 ? at * 1000 : at)
  const h = String(d.getHours()).padStart(2, '0')
  const m = String(d.getMinutes()).padStart(2, '0')
  return `${h}:${m}`
}
