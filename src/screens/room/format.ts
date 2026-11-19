import type { Currency } from '../../contracts'
import type { TFn } from '../../i18n'
import { formatMinorNumber } from '../../lib/money'

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

/** A payment invoice, excluding LNURL and address-like tokens. */
export function isInvoiceToken(token: string): boolean {
  return /^(lightning:)?(lnbc|lntb)[0-9a-z]+$/i.test(token)
}

/**
 * An amount inside a system line: Korean and Japanese put the unit word after the
 * number (1,000원, 1,000円), English the symbol before it (₩1,000).
 * The button under a completion line ("Mark {amount} done too") says its amount the same
 * way, so the line and its button never differ (not $1 and $1.00). `t` is the room's.
 */
export function systemMoney(t: TFn, minor: number, currency: Currency): string {
  return t(`sysMoney${currency}`, { amount: formatMinorNumber(minor, currency) })
}

/** The label of the button that applies a peer's completion to my offer too. */
export function doneApplyLabel(t: TFn, minor: number, currency: Currency): string {
  return t('doneApply', { amount: systemMoney(t, minor, currency) })
}
