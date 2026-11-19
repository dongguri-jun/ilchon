/**
 * Hand-built BOLT11 invoices for checks. The signature is zeros: src/lib/bolt11 does not check signatures.
 * No network.
 */
import { bech32 } from '@scure/base'

/** `n` as `len` big-endian 5-bit words. */
export function intWords(n: number, len: number): number[] {
  const w: number[] = []
  for (let i = 0; i < len; i++) {
    w.unshift(n % 32)
    n = Math.floor(n / 32)
  }
  return w
}

/** One tagged field: tag, 10-bit length, data words. */
export const tagged = (tag: number, words: number[]): number[] => [tag, Math.floor(words.length / 32), words.length % 32, ...words]

/** A fixed payment hash (tag p). */
const HASH = tagged(1, bech32.toWords(new Uint8Array(32).fill(7)))

/**
 * An invoice with human-readable part `hrp` (network and amount, e.g. 'lnbc1m' for
 * 100,000 sats on mainnet), created at `createdAtSec`, with the payment hash and
 * `fields` (more tagged fields, e.g. tagged(6, intWords(3600, 2)) for the expiry).
 */
export function buildInvoice(hrp: string, createdAtSec: number, fields: number[][] = []): string {
  return bech32.encode(hrp, [...intWords(createdAtSec, 7), ...HASH, ...fields.flat(), ...new Array(104).fill(0)], false)
}
