import { bech32 } from '@scure/base'
import { CURRENCIES, PAY_METHODS, type Contact, type Match, type Offer, type PayMethod, type PubkeyHex, type Rates, type SortMode } from '../../contracts'
import { commonMethods } from '../../lib/match'
import { CURRENCY, satsFor, toAsciiDigits } from '../../lib/money'

/** Money text and sats estimates come from the one money module (integer minor units). */
export { formatFee, formatMoney, formatSats, minorToInput, sanitizeAmount, satsFor } from '../../lib/money'

export const FEE_MIN = -50
export const FEE_MAX = 50

/** The methods a new offer starts with: both, narrowed only by those who need to. */
export function newOfferMethods(): PayMethod[] {
  return [...PAY_METHODS]
}

/** The offer form's values, in the units the engine stores (minor units, fee percent). */
export interface OfferForm {
  side: Offer['side']
  currency: Offer['currency']
  amountMinor: number
  feePct: number
  methods: readonly PayMethod[]
}

/**
 * The form equals the live offer: posting it would change nothing, so the edit button stays
 * off. Compared with the live offer, not the one the sheet opened with, so a completion
 * that lowers or removes the offer meanwhile turns the button back on. Methods compare as a set.
 */
export function offerFormUnchanged(live: Offer | null, form: OfferForm): boolean {
  return (
    live !== null &&
    form.side === live.side &&
    form.currency === live.currency &&
    form.amountMinor === live.amountMinor &&
    form.feePct === live.feePct &&
    form.methods.length === live.methods.length &&
    form.methods.every((m) => live.methods.includes(m))
  )
}

/** The string key of a single shared method ("Lightning only"), or null when both are shared. */
export function onlyMethodKey(methods: readonly PayMethod[]): 'onlyLightning' | 'onlyOnchain' | null {
  if (methods.length !== 1) return null
  return methods[0] === 'lightning' ? 'onlyLightning' : 'onlyOnchain'
}

/** "₩143,250,000 · $98,400 · ¥15,600,000" from whatever rates exist, or null when none do. */
export function ratesList(rates: Rates): string | null {
  const parts: string[] = []
  for (const c of CURRENCIES) {
    const rate = rates[c]
    if (rate !== undefined && rate > 0) parts.push(`${CURRENCY[c].symbol}${Math.round(rate).toLocaleString('en-US')}`)
  }
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
  /** Their amount, minor units. */
  amountMinor: number
  feePct: number
  createdAt: number
  /** The smaller of my amount and theirs, minor units. */
  tradeMinor: number
  /** Estimate at the current rate and their fee; null without a rate. */
  sats: number | null
  /** The methods we both accept (commonMethods), never empty. */
  methods: PayMethod[]
}

/**
 * Rows for the column opposite my offer. Only revealed matches that are still
 * opposite to my current offer in the same currency, and only for contacts I
 * still have. Nothing else may ever reach the board.
 */
export function buildRows(myOffer: Offer | null, matches: Match[], contacts: Contact[], rates: Rates, sort: SortMode): BoardRow[] {
  if (!myOffer) return []
  const byId = new Map(contacts.map((c) => [c.id, c]))
  const rate = rates[myOffer.currency]
  const rows: BoardRow[] = []
  const seen = new Set<PubkeyHex>()
  for (const m of matches) {
    const contact = byId.get(m.contactId)
    if (!contact || seen.has(m.contactId)) continue
    if (m.offer.currency !== myOffer.currency || m.offer.side === myOffer.side) continue
    // The engine never keeps a match without a shared method; a defence all the same.
    const methods = commonMethods(myOffer.methods, m.offer.methods)
    if (methods.length === 0) continue
    seen.add(m.contactId)
    const name = contact.name.trim()
    const tradeMinor = Math.min(myOffer.amountMinor, m.offer.amountMinor)
    rows.push({
      contactId: m.contactId,
      label: name || shortNpub(contact.pubkey),
      named: name.length > 0,
      amountMinor: m.offer.amountMinor,
      feePct: m.offer.feePct,
      createdAt: m.offer.createdAt,
      tradeMinor,
      sats: satsFor(tradeMinor, myOffer.currency, rate, m.offer.feePct),
      methods,
    })
  }

  // Integer difference of minor units.
  const diff = (r: BoardRow) => Math.abs(r.amountMinor - myOffer.amountMinor)
  // Lower is better for me: a buyer wants a low fee, a seller a high one.
  const cost = (r: BoardRow) => (myOffer.side === 'buy' ? r.feePct : -r.feePct)
  const byAmount = (a: BoardRow, b: BoardRow) => diff(a) - diff(b)
  const byFee = (a: BoardRow, b: BoardRow) => cost(a) - cost(b)
  const [first, second] = sort === 'fee' ? [byFee, byAmount] : [byAmount, byFee]
  return rows.sort((a, b) => first(a, b) || second(a, b) || a.createdAt - b.createdAt || (a.contactId < b.contactId ? -1 : 1))
}

// ------------------------------------------------------------ form input

/** Optional leading minus, up to three integer digits, up to two decimals. */
export function sanitizeFee(raw: string): string {
  // Fullwidth digits, ． and ， become ASCII first (toAsciiDigits, not NFKC: ½ or ²
  // must not turn into digits). The fullwidth hyphen－, and the long-vowel marks ー and
  // halfwidth ｰ that a Japanese keyboard can give for a minus, are a sign only at the
  // front, like the other dashes.
  const s = toAsciiDigits(raw)
    .replace(/[−–—－ーｰ]/g, '-')
    .replace(/,/g, '.')
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
