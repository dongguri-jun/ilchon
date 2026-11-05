import { bech32 } from '@scure/base'
import type { Contact, Currency, Match, Offer, PubkeyHex, Rates, SortMode } from '../../contracts'

export const FEE_MIN = -50
export const FEE_MAX = 50

export function formatMoney(amount: number, currency: Currency): string {
  if (currency === 'KRW') return `₩${Math.round(amount).toLocaleString('en-US')}`
  return `$${amount.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`
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

/** Sats for `fiat` when 1 BTC costs `rate` plus a premium of `feePct` percent. */
export function satsFor(fiat: number, rate: number | undefined, feePct: number): number | null {
  if (rate === undefined) return null
  const price = rate * (1 + feePct / 100)
  if (!Number.isFinite(price) || price <= 0 || !Number.isFinite(fiat)) return null
  return (fiat / price) * 1e8
}

/** "₩143,250,000 · $98,400" from whatever rates exist, or null when none do. */
export function ratesList(rates: Rates): string | null {
  const parts: string[] = []
  if (rates.KRW !== undefined && rates.KRW > 0) parts.push(`₩${Math.round(rates.KRW).toLocaleString('en-US')}`)
  if (rates.USD !== undefined && rates.USD > 0) parts.push(`$${Math.round(rates.USD).toLocaleString('en-US')}`)
  return parts.length ? parts.join(' · ') : null
}

function hexToBytes(hex: string): Uint8Array {
  const out = new Uint8Array(hex.length >> 1)
  for (let i = 0; i < out.length; i++) out[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16)
  return out
}

/** Short npub-style label for a contact without a local name. */
export function shortNpub(pubkey: PubkeyHex): string {
  try {
    if (!/^[0-9a-f]{64}$/.test(pubkey)) throw new Error('not a pubkey')
    const npub = bech32.encodeFromBytes('npub', hexToBytes(pubkey))
    return `${npub.slice(0, 8)}…${npub.slice(-4)}`
  } catch {
    return `${pubkey.slice(0, 8)}…${pubkey.slice(-4)}`
  }
}

// ------------------------------------------------------------ board rows

export interface BoardRow {
  contactId: PubkeyHex
  /** Local name, or a short npub when the contact has none. */
  label: string
  named: boolean
  amount: number
  feePct: number
  createdAt: number
  /** The smaller of my amount and theirs. */
  tradable: number
  /** Estimate at the current rate and their fee; null without a rate. */
  sats: number | null
}

/**
 * Rows for the column opposite my offer. Only revealed matches that are still
 * opposite to my current offer in the same currency, and only for contacts I
 * still have. Nothing else may ever reach the board.
 */
export function buildRows(
  myOffer: Offer | null,
  matches: Match[],
  contacts: Contact[],
  rates: Rates,
  sort: SortMode,
): BoardRow[] {
  if (!myOffer) return []
  const byId = new Map(contacts.map((c) => [c.id, c]))
  const rate = rates[myOffer.currency]
  const rows: BoardRow[] = []
  const seen = new Set<PubkeyHex>()
  for (const m of matches) {
    const contact = byId.get(m.contactId)
    if (!contact || seen.has(m.contactId)) continue
    if (m.offer.currency !== myOffer.currency || m.offer.side === myOffer.side) continue
    seen.add(m.contactId)
    const name = contact.name.trim()
    const tradable = Math.min(myOffer.amount, m.offer.amount)
    rows.push({
      contactId: m.contactId,
      label: name || shortNpub(contact.pubkey),
      named: name.length > 0,
      amount: m.offer.amount,
      feePct: m.offer.feePct,
      createdAt: m.offer.createdAt,
      tradable,
      sats: satsFor(tradable, rate, m.offer.feePct),
    })
  }

  const diff = (r: BoardRow) => Math.abs(r.amount - myOffer.amount)
  // Lower is better for me: a buyer wants a low fee, a seller a high one.
  const cost = (r: BoardRow) => (myOffer.side === 'buy' ? r.feePct : -r.feePct)
  const byAmount = (a: BoardRow, b: BoardRow) => diff(a) - diff(b)
  const byFee = (a: BoardRow, b: BoardRow) => cost(a) - cost(b)
  const [first, second] = sort === 'fee' ? [byFee, byAmount] : [byAmount, byFee]
  return rows.sort(
    (a, b) =>
      first(a, b) || second(a, b) || a.createdAt - b.createdAt || (a.contactId < b.contactId ? -1 : 1),
  )
}

// ------------------------------------------------------------ form input

/** Keeps only what an amount field may hold and adds thousands separators. */
export function sanitizeAmount(raw: string, currency: Currency): string {
  const group = (digits: string) => (digits ? Number(digits).toLocaleString('en-US') : '')
  if (currency === 'KRW') {
    return group(raw.replace(/\D/g, '').replace(/^0+(?=\d)/, '').slice(0, 12))
  }
  const cleaned = raw.replace(/[^\d.]/g, '')
  const dot = cleaned.indexOf('.')
  const intDigits = (dot < 0 ? cleaned : cleaned.slice(0, dot)).replace(/^0+(?=\d)/, '').slice(0, 9)
  if (dot < 0) return group(intDigits)
  const frac = cleaned
    .slice(dot + 1)
    .replace(/\./g, '')
    .slice(0, 2)
  return `${group(intDigits) || '0'}.${frac}`
}

/** NaN when the text is not a number yet. */
export function parseAmount(text: string): number {
  const t = text.replace(/,/g, '')
  if (!t || t === '.') return NaN
  const n = Number(t)
  return Number.isFinite(n) ? n : NaN
}

export function amountToInput(amount: number, currency: Currency): string {
  if (currency === 'KRW') return sanitizeAmount(String(Math.round(amount)), 'KRW')
  return sanitizeAmount(String(Number(amount.toFixed(2))), 'USD')
}

/** Optional leading minus, up to three integer digits, up to two decimals. */
export function sanitizeFee(raw: string): string {
  const s = raw.replace(/[−–—]/g, '-').replace(/,/g, '.')
  const negative = s.trimStart().startsWith('-')
  const body = s.replace(/[^\d.]/g, '')
  const dot = body.indexOf('.')
  const intDigits = (dot < 0 ? body : body.slice(0, dot)).replace(/^0+(?=\d)/, '').slice(0, 3)
  const frac =
    dot < 0
      ? ''
      : `.${body
          .slice(dot + 1)
          .replace(/\./g, '')
          .slice(0, 2)}`
  return `${negative ? '-' : ''}${intDigits}${frac}`
}

/** Empty and a lone sign count as 0. NaN for anything else that is not a number. */
export function parseFee(text: string): number {
  if (text === '' || text === '-') return 0
  const n = Number(text)
  // `+ 0` turns -0 into 0.
  return Number.isFinite(n) ? n + 0 : NaN
}

export function feeToInput(feePct: number): string {
  return String(Number(feePct.toFixed(2)) + 0)
}
