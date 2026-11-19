/**
 * Minimal BOLT11 reader: enough to show a Lightning invoice's amount, expiry
 * and network before someone pays it. It does not verify the signature or
 * the payee; the payer's wallet does that.
 *
 * Spec: https://github.com/lightning/bolts/blob/master/11-payment-encoding.md
 */
import { bech32 } from '@scure/base'

export type LnNetwork = 'mainnet' | 'testnet' | 'signet' | 'regtest'

export interface Invoice {
  /** Lowercased invoice without any `lightning:` prefix. */
  invoice: string
  network: LnNetwork
  /** Millisatoshis requested, or null for an "any amount" invoice. */
  amountMsat: bigint | null
  /** Whole sats (floor), or null for an "any amount" invoice. */
  amountSats: number | null
  /** Unix seconds. */
  createdAt: number
  /** Unix seconds. */
  expiresAt: number
  /** The `d` field, if present and valid UTF-8. */
  description: string | null
  /** The `h` field (description hash), lowercase hex, if present. */
  descriptionHash: string | null
}

const PREFIXES: Array<[string, LnNetwork]> = [
  // Longest first: `lnbcrt` and `lntbs` start with `lnbc` and `lntb`.
  ['lnbcrt', 'regtest'],
  ['lntbs', 'signet'],
  ['lnbc', 'mainnet'],
  ['lntb', 'testnet'],
]

/** msat per unit of the amount digits, by multiplier. 1 BTC = 1e11 msat. */
const MSAT_PER_UNIT: Record<string, bigint> = {
  '': 100_000_000_000n,
  m: 100_000_000n,
  u: 100_000n,
  n: 100n,
}

const SIGNATURE_WORDS = 104 // 65 bytes, 520 bits
const TIMESTAMP_WORDS = 7 // 35 bits
const DEFAULT_EXPIRY = 3600

const TAG_PAYMENT_HASH = 1 // 'p'
const TAG_DESCRIPTION = 13 // 'd'
const TAG_EXPIRY = 6 // 'x'
const TAG_DESCRIPTION_HASH = 23 // 'h'

/** Strips a `lightning:` URI scheme and surrounding space. */
export function stripLightningScheme(text: string): string {
  return text.trim().replace(/^lightning:/i, '')
}

/** Decodes a BOLT11 invoice, or returns null if it is not a well-formed one. */
export function decodeInvoice(text: string): Invoice | null {
  const raw = stripLightningScheme(text)
  // bech32 forbids mixed case; the decoder below enforces it.
  let decoded: { prefix: string; words: number[] }
  try {
    decoded = bech32.decode(raw as `${string}1${string}`, false)
  } catch {
    return null
  }
  const { prefix, words } = decoded

  const match = PREFIXES.find(([p]) => prefix.startsWith(p))
  if (!match) return null
  const [base, network] = match
  const amountMsat = parseAmount(prefix.slice(base.length))
  if (amountMsat === undefined) return null

  if (words.length < TIMESTAMP_WORDS + SIGNATURE_WORDS) return null
  const data = words.slice(0, words.length - SIGNATURE_WORDS)
  const createdAt = wordsToInt(data.slice(0, TIMESTAMP_WORDS))

  let expiry: number | null = null
  let description: string | null = null
  let descriptionHash: string | null = null
  let hasPaymentHash = false
  let i = TIMESTAMP_WORDS
  while (i < data.length) {
    if (i + 3 > data.length) return null
    const tag = data[i]
    const len = data[i + 1] * 32 + data[i + 2]
    const field = data.slice(i + 3, i + 3 + len)
    if (field.length !== len) return null
    i += 3 + len
    if (tag === TAG_PAYMENT_HASH && len === 52) hasPaymentHash = true
    else if (tag === TAG_EXPIRY && expiry === null) {
      // Like wallets, keep the first `x`. Over 10 words (50 bits) is not a real expiry.
      if (len > 10) return null
      expiry = wordsToInt(field)
    } else if (tag === TAG_DESCRIPTION && description === null) description = wordsToUtf8(field)
    else if (tag === TAG_DESCRIPTION_HASH && len === 52 && descriptionHash === null) {
      // Like `p`: a field of another length is skipped, not an error.
      const bytes = bech32.fromWordsUnsafe(field)
      if (bytes && bytes.length === 32) descriptionHash = toHex(bytes)
    }
  }
  if (!hasPaymentHash) return null

  return {
    invoice: raw.toLowerCase(),
    network,
    amountMsat,
    amountSats: amountMsat === null ? null : Number(amountMsat / 1000n),
    createdAt,
    expiresAt: createdAt + (expiry ?? DEFAULT_EXPIRY),
    description,
    descriptionHash,
  }
}

function toHex(bytes: Uint8Array): string {
  let out = ''
  for (const b of bytes) out += b.toString(16).padStart(2, '0')
  return out
}

/** undefined: malformed. null: no amount. */
function parseAmount(s: string): bigint | null | undefined {
  if (s === '') return null
  const m = /^([1-9][0-9]*)([munp]?)$/.exec(s)
  if (!m) return undefined
  const digits = BigInt(m[1])
  if (m[2] === 'p') {
    // 1 pico-BTC = 0.1 msat; sub-msat amounts are invalid.
    if (digits % 10n !== 0n) return undefined
    return digits / 10n
  }
  return digits * MSAT_PER_UNIT[m[2]]
}

function wordsToInt(words: number[]): number {
  let n = 0
  for (const w of words) n = n * 32 + w
  return n
}

function wordsToUtf8(words: number[]): string | null {
  const bytes = bech32.fromWordsUnsafe(words)
  if (!bytes) return null
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(bytes)
  } catch {
    return null
  }
}

/**
 * Invoice-looking strings in pasted text: bare invoices, `lightning:` URIs and
 * the `lightning=` parameter of BIP21 `bitcoin:` URIs, in order of appearance.
 */
export function invoiceCandidates(text: string): string[] {
  const out: string[] = []
  for (const token of text.split(/\s+/)) {
    if (!token) continue
    if (/^bitcoin:/i.test(token)) {
      const q = token.indexOf('?')
      if (q < 0) continue
      for (const pair of token.slice(q + 1).split('&')) {
        const [k, v] = pair.split('=')
        if (k?.toLowerCase() === 'lightning' && v) {
          try {
            out.push(decodeURIComponent(v))
          } catch {
            /* malformed escape */
          }
        }
      }
    } else out.push(token)
  }
  return out
}

/** Seconds left before expiry; negative once expired. */
export function secondsLeft(inv: Invoice, nowMs: number): number {
  return inv.expiresAt - Math.floor(nowMs / 1000)
}

/**
 * A screen that shows an invoice's expiry counts again this long after the expiry second,
 * so a timer that fires a hair early still sees the invoice as expired. The trade room's
 * guide (src/engine/browser.ts useTradeView) and the invoice card (src/screens/room/InvoiceCard.tsx
 * useNow) both use it, so they turn to "expired" at the same moment.
 */
export const EXPIRY_RECOUNT_SLACK_MS = 500

/**
 * How long until a countdown should be recounted: every `intervalMs`, but sooner when the
 * expiry comes first. null once the expiry has passed (nothing more to count down).
 */
export function msUntilRecount(expiresAt: number, nowMs: number, intervalMs: number): number | null {
  const recountAt = expiresAt * 1000 + EXPIRY_RECOUNT_SLACK_MS
  if (nowMs >= recountAt) return null
  return Math.min(intervalMs, recountAt - nowMs)
}

export type InvoiceIssue = 'expired' | 'expiringSoon' | 'notMainnet' | 'noAmount'

export const EXPIRING_SOON_SECONDS = 120

/**
 * What a payer should know before paying, most serious first. An empty list
 * means nothing stood out; it does not mean the invoice is safe to pay. Whether the
 * amount fits the trade is the trade room's (src/engine/trade.ts, CardView.over).
 */
export function invoiceIssues(inv: Invoice, nowMs: number): InvoiceIssue[] {
  const issues: InvoiceIssue[] = []
  const left = secondsLeft(inv, nowMs)
  if (left <= 0) issues.push('expired')
  if (inv.network !== 'mainnet') issues.push('notMainnet')
  if (inv.amountSats === null) issues.push('noAmount')
  if (left > 0 && left <= EXPIRING_SOON_SECONDS) issues.push('expiringSoon')
  return issues
}
