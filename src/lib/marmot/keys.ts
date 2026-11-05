import { bytesToHex, hexToBytes } from 'applesauce-core/helpers/event'
import { generateSecretKey, getPublicKey } from 'applesauce-core/helpers/keys'
import { npubEncode, nsecEncode } from 'applesauce-core/helpers/pointers'
import type { PubkeyHex } from '../../contracts'

const HEX64 = /^[0-9a-f]{64}$/

export function isHex64(value: unknown): value is string {
  return typeof value === 'string' && HEX64.test(value)
}

/** Parse a 32-byte secret key given as lowercase hex. Never echoes the input. */
export function secretKeyBytes(secretKeyHex: string): Uint8Array {
  if (!isHex64(secretKeyHex)) throw new Error('secret key must be 64 lowercase hex characters')
  return hexToBytes(secretKeyHex)
}

export function generateSecretKeyHex(): string {
  return bytesToHex(generateSecretKey())
}

export function pubkeyOf(secretKeyHex: string): PubkeyHex {
  return getPublicKey(secretKeyBytes(secretKeyHex))
}

export function npubOf(pubkey: PubkeyHex): string {
  return npubEncode(pubkey)
}

export function nsecOf(secretKeyHex: string): string {
  return nsecEncode(secretKeyBytes(secretKeyHex))
}

/** Random bytes as lowercase hex (Web Crypto, works in browsers and Node). */
export function randomHex(bytes: number): string {
  return bytesToHex(crypto.getRandomValues(new Uint8Array(bytes)))
}

/** Shortened pubkey for log lines. */
export function short(pubkey: string): string {
  return pubkey.slice(0, 8)
}
