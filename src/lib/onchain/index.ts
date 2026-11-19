/**
 * On-chain receiving: mainnet address check and `bitcoin:` links. No network,
 * no storage; addresses are pasted fresh for every trade.
 *
 * Specs (read 2026-11-13):
 *   BIP-173 https://github.com/bitcoin/bips/blob/master/bip-0173.mediawiki  bech32, segwit v0
 *   BIP-350 https://github.com/bitcoin/bips/blob/master/bip-0350.mediawiki  bech32m, segwit v1+
 *   BIP-21  https://github.com/bitcoin/bips/blob/master/bip-0021.mediawiki  bitcoin: URIs, amount in decimal BTC, req- params
 *
 * Checksums come from @scure/base (bech32, bech32m, base58check); nothing is
 * hand-rolled here except the version and length rules. Only what today's
 * wallets can pay is accepted: p2pkh, p2sh, p2wpkh, p2wsh and p2tr on mainnet.
 * Segwit v2+ and v1 programs other than 32 bytes are valid BIP-350 but refused
 * (some wallets cannot send to them).
 */
import { sha256 } from '@noble/hashes/sha2.js'
import { bech32, bech32m, createBase58check } from '@scure/base'

export type AddressKind = 'p2pkh' | 'p2sh' | 'p2wpkh' | 'p2wsh' | 'p2tr'

export interface ParsedAddress {
  /** bech32 lowercased; base58 as given. */
  address: string
  kind: AddressKind
}

/** A receiving request read from a chat token. `uri` is rebuilt by bip21, never the text as received. */
export interface OnchainRequest {
  address: string
  sats: number | null
  uri: string
}

const MAX_ADDRESS = 90
const SATS_PER_BTC = 100_000_000
const MAX_SATS = 21_000_000 * SATS_PER_BTC
const base58check = createBase58check(sha256)

/** A mainnet address someone can pay today, or null. */
export function parseAddress(text: string): ParsedAddress | null {
  if (typeof text !== 'string') return null
  const s = text.trim()
  if (!s || s.length > MAX_ADDRESS) return null

  if (s.toLowerCase().startsWith('bc1')) {
    // BIP-173: all lower or all upper; a mixed-case string is not an address.
    if (s !== s.toLowerCase() && s !== s.toUpperCase()) return null
    const t = s.toLowerCase() as `${string}1${string}`
    let words: number[]
    let checksum: 'bech32' | 'bech32m'
    let prefix: string
    try {
      ;({ prefix, words } = bech32.decode(t, MAX_ADDRESS))
      checksum = 'bech32'
    } catch {
      try {
        ;({ prefix, words } = bech32m.decode(t, MAX_ADDRESS))
        checksum = 'bech32m'
      } catch {
        return null
      }
    }
    if (prefix !== 'bc' || words.length < 1) return null
    const version = words[0]
    let program: Uint8Array
    try {
      // Strict: non-zero or over-long padding throws (no fromWordsUnsafe).
      program = bech32.fromWords(words.slice(1))
    } catch {
      return null
    }
    if (version === 0 && checksum === 'bech32') {
      if (program.length === 20) return { address: t, kind: 'p2wpkh' }
      if (program.length === 32) return { address: t, kind: 'p2wsh' }
      return null
    }
    if (version === 1 && checksum === 'bech32m' && program.length === 32) return { address: t, kind: 'p2tr' }
    return null
  }

  let bytes: Uint8Array
  try {
    bytes = base58check.decode(s)
  } catch {
    return null
  }
  if (bytes.length !== 21) return null
  if (bytes[0] === 0x00) return { address: s, kind: 'p2pkh' }
  if (bytes[0] === 0x05) return { address: s, kind: 'p2sh' }
  return null
}

/** Why a pasted or typed address was refused (addressProblem). */
export type AddressProblem = 'lightning' | 'testnet' | 'typo' | 'unsupported' | 'invalid'

const BASE58_CHARS = /^[1-9A-HJ-NP-Za-km-z]+$/

/**
 * Why `text` is not an address parseAddress accepts, for the one line the receiving sheet
 * shows; null exactly when parseAddress accepts it. Never echoes the text.
 *
 * The network is judged only after the checksum passes: a string that fails its checksum is
 * a 'typo' whatever it starts with (a testnet prefix cannot be trusted on a damaged string).
 *  - lightning: an invoice, an offer, an LNURL or a lightning: link where an address was asked for.
 *  - testnet: valid checksum, testnet or regtest (tb1, bcrt1, base58 version 0x6f or 0xc4).
 *  - typo: looks like a bitcoin address (bc1/tb1/bcrt1, or base58 starting 1 3 m n 2) but the
 *    checksum or the letter case is wrong.
 *  - unsupported: a valid checksum that today's wallets cannot pay (segwit v2+, a v1 program
 *    that is not 32 bytes, another base58 version in a 21-byte payload), or a bitcoin: link with a
 *    good address but a req- or amount fault.
 *  - invalid: anything else.
 */
export function addressProblem(text: string): AddressProblem | null {
  if (typeof text !== 'string') return 'invalid'
  const s = text.trim()
  if (!s) return 'invalid'
  if (parseAddress(s) !== null) return null
  if (/^(lightning:|ln(bc|tb|bcrt)|lnurl1|lno1)/i.test(s)) return 'lightning'
  if (/^bitcoin:/i.test(s)) {
    const rest = s.slice('bitcoin:'.length)
    const q = rest.indexOf('?')
    const inner = q < 0 ? rest : rest.slice(0, q)
    if (!inner || /^bitcoin:/i.test(inner)) return 'invalid'
    return addressProblem(inner) ?? 'unsupported'
  }
  if (s.length > MAX_ADDRESS) return 'invalid'

  if (/^(bc|tb|bcrt)1/i.test(s)) {
    if (s !== s.toLowerCase() && s !== s.toUpperCase()) return 'typo'
    const t = s.toLowerCase() as `${string}1${string}`
    let prefix: string | null = null
    try {
      prefix = bech32.decode(t, MAX_ADDRESS).prefix
    } catch {
      try {
        prefix = bech32m.decode(t, MAX_ADDRESS).prefix
      } catch {
        /* the checksum fails under both */
      }
    }
    if (prefix === null) return s.length >= 14 ? 'typo' : 'invalid'
    if (prefix === 'tb' || prefix === 'bcrt') return 'testnet'
    return prefix === 'bc' ? 'unsupported' : 'invalid'
  }

  const looksBase58 = /^[13mn2]/.test(s) && s.length >= 26 && s.length <= 35 && /^[A-Za-z0-9]+$/.test(s)
  if (!BASE58_CHARS.test(s)) return looksBase58 ? 'typo' : 'invalid'
  let bytes: Uint8Array
  try {
    bytes = base58check.decode(s)
  } catch {
    return looksBase58 ? 'typo' : 'invalid'
  }
  // Not a 21-byte address payload (a private key, an extended key): not an address of any kind.
  if (bytes.length !== 21) return 'invalid'
  if (bytes[0] === 0x6f || bytes[0] === 0xc4) return 'testnet'
  return 'unsupported'
}

/**
 * `bitcoin:{address}`, with `?amount=` in decimal BTC when `sats` is given. The
 * amount is built from integers only: 98039 -> 0.00098039, 100000000 -> 1.
 * Throws RangeError for sats that are not a whole number from 1 to 21M BTC.
 */
export function bip21(address: string, sats: number | null): string {
  if (sats === null) return `bitcoin:${address}`
  return `bitcoin:${address}?amount=${btcText(sats)}`
}

/**
 * Decimal BTC for `sats`, from integers only (98039 -> "0.00098039", 100000000 -> "1"):
 * the amount of a bitcoin: link and the BTC line of the on-chain card, from one function.
 * Throws RangeError for sats that are not a whole number from 1 to 21M BTC.
 */
export function btcText(sats: number): string {
  if (!Number.isSafeInteger(sats) || sats < 1 || sats > MAX_SATS) throw new RangeError('sats')
  const whole = Math.floor(sats / SATS_PER_BTC)
  const frac = sats % SATS_PER_BTC
  return frac === 0 ? String(whole) : `${whole}.${String(frac).padStart(8, '0').replace(/0+$/, '')}`
}

/** What the on-chain card shows, copies and puts in its QR (onchainCardValues). */
export interface OnchainCardValues {
  /** The address alone: the "copy address" button. */
  address: string
  /** The BTC line under the sats, or null for a card without an amount. */
  btc: string | null
  /** The bitcoin: link with the same amount as `btc` (bip21): the QR, "Open in wallet" and "copy link". */
  link: string
}

/**
 * The on-chain card's values from one place: the BTC it shows and the amount of
 * the link it copies and encodes are both btcText of the same sats, so what the seller
 * reads and what the wallet receives cannot differ.
 */
export function onchainCardValues(req: OnchainRequest): OnchainCardValues {
  return {
    address: req.address,
    btc: req.sats === null ? null : btcText(req.sats),
    link: bip21(req.address, req.sats),
  }
}

/** Decimal BTC (at most 8 places) to sats by string arithmetic; null when malformed, 0 or over 21M BTC. */
function btcToSats(value: string): number | null {
  const m = /^(\d{1,8})(?:\.(\d{1,8}))?$/.exec(value)
  if (!m) return null
  const sats = Number(m[1]) * SATS_PER_BTC + Number((m[2] ?? '').padEnd(8, '0'))
  if (!Number.isSafeInteger(sats) || sats < 1 || sats > MAX_SATS) return null
  return sats
}

/**
 * A bare mainnet address or a `bitcoin:` link to one. In a link, `amount`
 * becomes sats; a `req-` parameter makes the whole link unusable (BIP-21);
 * `label`, `message`, `lightning` and other keys are ignored. Null when the
 * address fails parseAddress, the amount is malformed, 0, over 21M BTC or
 * given twice.
 */
export function parseOnchainRequest(token: string): OnchainRequest | null {
  if (typeof token !== 'string') return null
  const s = token.trim()
  if (!/^bitcoin:/i.test(s)) {
    const parsed = parseAddress(s)
    return parsed ? { address: parsed.address, sats: null, uri: bip21(parsed.address, null) } : null
  }
  const rest = s.slice('bitcoin:'.length)
  const q = rest.indexOf('?')
  const parsed = parseAddress(q < 0 ? rest : rest.slice(0, q))
  if (!parsed) return null
  let sats: number | null = null
  let seenAmount = false
  if (q >= 0) {
    for (const pair of rest.slice(q + 1).split('&')) {
      if (!pair) continue
      const eq = pair.indexOf('=')
      const key = (eq < 0 ? pair : pair.slice(0, eq)).toLowerCase()
      const value = eq < 0 ? '' : pair.slice(eq + 1)
      if (key.startsWith('req-')) return null
      if (key !== 'amount') continue
      if (seenAmount) return null
      seenAmount = true
      sats = btcToSats(value)
      if (sats === null) return null
    }
  }
  return { address: parsed.address, sats, uri: bip21(parsed.address, sats) }
}
