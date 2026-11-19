/**
 * Payment requests inside chat text. A
 * payment card is a request token in a chat message: pasting it and the trade screen's
 * "send" button both send it as plain chat text, so there is no wire message of its
 * own. The engine (tradeView) and the room screen split text with the same function,
 * so a card's key is the same on both sides. No DOM; nothing is cached or stored.
 *
 * Two kinds: a BOLT11 invoice (trade) and an on-chain address or bitcoin:
 * link. Both carry the same common fields (`id`,
 * `amountSats`, `expiresAt`, `mainnet`), which are all the trade rules read.
 */
import { decodeInvoice, invoiceCandidates, type Invoice } from '../bolt11'
import { parseOnchainRequest, type OnchainRequest } from '../onchain'

/** A longer token is never read as a payment request. */
export const PAY_TOKEN_MAX = 4096
/** A BOLT11 invoice is never shorter: the signature alone is 104 characters. */
const PAY_TOKEN_MIN = 100
/** Shortest and longest bare mainnet address parseAddress accepts (base58 26, bech32 90). */
const ADDRESS_MIN = 26
const ADDRESS_MAX = 90

/** One payment request found in a chat text. */
export type PayRef =
  | {
      kind: 'lightning'
      /** Identity of the request: the same id is the same payment. Lightning: the lowercased invoice. */
      id: string
      /** Null for an "any amount" request. */
      amountSats: number | null
      /** Unix seconds; null when it never expires. */
      expiresAt: number | null
      /** False for testnet, signet, regtest. */
      mainnet: boolean
      invoice: Invoice
    }
  | {
      kind: 'onchain'
      /** The address as parseAddress returns it: bech32 lowercased, base58 as given. */
      id: string
      amountSats: number | null
      expiresAt: null
      /** parseAddress accepts mainnet addresses only. */
      mainnet: true
      req: OnchainRequest
    }

/**
 * Whether a token is worth parsing at all: at most 4,096
 * characters and either an invoice candidate (100 or more characters starting with `ln`
 * or `lightning:`, any case) or an on-chain one (a `bitcoin:` link, or
 * 26 to 90 characters starting with `bc1`, `1` or `3`). Plain words never reach a decoder.
 */
export function isPayCandidate(token: string): boolean {
  if (token.length > PAY_TOKEN_MAX) return false
  if (token.length >= PAY_TOKEN_MIN && /^(ln|lightning:)/i.test(token)) return true
  if (/^bitcoin:/i.test(token)) return true
  return token.length >= ADDRESS_MIN && token.length <= ADDRESS_MAX && /^(bc1|[13])/i.test(token)
}

/**
 * The token as a payment request, or null (in this order):
 * 1. a BOLT11 invoice (bare or `lightning:`);
 * 2. a `bitcoin:` link whose first `lightning=` value is an invoice: the unified link a
 *    wallet gives is a Lightning card;
 * 3. a mainnet address or a `bitcoin:` link to one (parseOnchainRequest; a `req-`
 *    parameter makes it plain text).
 */
export function payRefOf(token: string): PayRef | null {
  if (!isPayCandidate(token)) return null
  const lightning = (inv: Invoice | null): PayRef | null =>
    inv && {
      kind: 'lightning',
      id: inv.invoice,
      amountSats: inv.amountSats,
      expiresAt: inv.expiresAt,
      mainnet: inv.network === 'mainnet',
      invoice: inv,
    }
  if (/^(ln|lightning:)/i.test(token)) return lightning(decodeInvoice(token))
  if (/^bitcoin:/i.test(token)) {
    const first = invoiceCandidates(token)[0]
    const inv = first !== undefined && first.length <= PAY_TOKEN_MAX ? decodeInvoice(first) : null
    if (inv) return lightning(inv)
  }
  const req = parseOnchainRequest(token)
  if (!req) return null
  return { kind: 'onchain', id: req.address, amountSats: req.sats, expiresAt: null, mainnet: true, req }
}

/**
 * `text.split(/(\s+)/)` with each part read by payRefOf. The room renders these
 * parts in order, and a card's key is `${messageId}:${partIndex}`.
 */
export function splitText(text: string): { text: string; ref: PayRef | null }[] {
  return text.split(/(\s+)/).map((part) => ({ text: part, ref: payRefOf(part) }))
}

/** True when the text holds at least one payment request. */
export function hasPayRef(text: string): boolean {
  return text.split(/\s+/).some((part) => payRefOf(part) !== null)
}
