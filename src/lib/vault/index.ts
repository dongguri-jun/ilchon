/**
 * Vault — protects the 32-byte Nostr secret key at rest.
 *
 * Three lock methods:
 *   passkey   WebAuthn PRF output -> HKDF-SHA256 -> AES-GCM-256 key.
 *   password  NIP-49 ncryptsec (scrypt + XChaCha20-Poly1305), compatible with other Nostr apps.
 *   none      plain hex, for laptop stage demos only.
 *
 * Pure crypto + WebAuthn. No React, no engine imports. Never log secrets,
 * passwords, PRF output or ncryptsec values.
 */
import { xchacha20poly1305 } from '@noble/ciphers/chacha.js'
import { gcm } from '@noble/ciphers/aes.js'
import { scryptAsync } from '@noble/hashes/scrypt.js'
import { hkdf } from '@noble/hashes/hkdf.js'
import { sha256 } from '@noble/hashes/sha2.js'
import { bytesToHex, hexToBytes, randomBytes, utf8ToBytes } from '@noble/hashes/utils.js'
import { base64urlnopad, bech32 } from '@scure/base'

export type LockChoice =
  | { method: 'passkey' }
  | { method: 'password'; password: string }
  | { method: 'none' }

/** All binary fields are base64url (no padding). `sk` is the 64-hex secret key. */
export type LockedVault =
  | { v: 1; method: 'passkey'; credId: string; iv: string; ct: string; salt: string }
  | { v: 1; method: 'password'; ncryptsec: string }
  | { v: 1; method: 'none'; sk: string }

export const MIN_PASSWORD = 8

const HEX64 = /^[0-9a-f]{64}$/

function checkSecret(secretHex: string): Uint8Array {
  const hex = secretHex.toLowerCase()
  if (!HEX64.test(hex)) throw new Error('invalid-key')
  return hexToBytes(hex)
}

// ---------------------------------------------------------------- NIP-49

const NCRYPTSEC = 'ncryptsec'
const NIP49_LEN = 91
/** Largest log_n NIP-49 allows in practice; above this a backup is malformed. */
const MAX_LOG_N = 22

/**
 * Largest log_n this device can run (scrypt needs 2^log_n KiB). Phones get
 * 18 (256 MiB): WebKit kills the tab well before 1 GiB. Desktops get 20.
 */
function maxDecryptLogN(): number {
  try {
    if (typeof navigator === 'undefined') return 20
    const ua = navigator.userAgent || ''
    const touchMac = navigator.platform === 'MacIntel' && (navigator.maxTouchPoints ?? 0) > 1
    return /iPhone|iPad|iPod|Android/i.test(ua) || touchMac ? 18 : 20
  } catch {
    return 18
  }
}

/** NIP-49 key-security byte: 0x00 known insecure, 0x01 not known insecure, 0x02 unknown. */
export type KeySecurity = 0x00 | 0x01 | 0x02

function decodeNcryptsec(ncryptsec: string): Uint8Array {
  let data: Uint8Array
  try {
    const { prefix, words } = bech32.decode(ncryptsec.trim().toLowerCase() as `${string}1${string}`, false)
    if (prefix !== NCRYPTSEC) throw new Error()
    data = bech32.fromWords(words)
  } catch {
    throw new Error('invalid-ncryptsec')
  }
  if (data.length !== NIP49_LEN || data[0] !== 0x02) throw new Error('invalid-ncryptsec')
  const logN = data[1]!
  if (logN < 1 || logN > MAX_LOG_N) throw new Error('invalid-ncryptsec')
  if (data[42]! > 0x02) throw new Error('invalid-ncryptsec')
  return data
}

/** The key-security byte of a backup, or null when it is not a valid ncryptsec. No decryption. */
export function ncryptsecKeySecurity(ncryptsec: string): KeySecurity | null {
  try {
    return decodeNcryptsec(ncryptsec)[42] as KeySecurity
  } catch {
    return null
  }
}

async function nip49Key(password: string, salt: Uint8Array, logN: number): Promise<Uint8Array> {
  const pw = utf8ToBytes(password.normalize('NFKC'))
  return scryptAsync(pw, salt, {
    N: 2 ** logN,
    r: 8,
    p: 1,
    dkLen: 32,
    maxmem: 2 ** 31,
    asyncTick: 20,
  })
}

/**
 * NIP-49 encrypt. `ksb` is the key-security byte; default 0x01 ("not known to
 * have been handled insecurely"). Pass 0x00 when the key ever sat unencrypted.
 */
export async function toNcryptsec(
  secretHex: string,
  password: string,
  logN = 16,
  ksb: KeySecurity = 0x01,
): Promise<string> {
  const sk = checkSecret(secretHex)
  if (!Number.isInteger(logN) || logN < 1 || logN > 20) throw new Error('invalid-log-n')
  if (ksb !== 0x00 && ksb !== 0x01 && ksb !== 0x02) throw new Error('invalid-ksb')
  const salt = randomBytes(16)
  const nonce = randomBytes(24)
  const ad = new Uint8Array([ksb])
  const key = await nip49Key(password, salt, logN)
  try {
    const ct = xchacha20poly1305(key, nonce, ad).encrypt(sk)
    const out = new Uint8Array(NIP49_LEN)
    out[0] = 0x02
    out[1] = logN
    out.set(salt, 2)
    out.set(nonce, 18)
    out.set(ad, 42)
    out.set(ct, 43)
    return bech32.encode(NCRYPTSEC, bech32.toWords(out), false)
  } finally {
    key.fill(0)
    sk.fill(0)
  }
}

/**
 * NIP-49 decrypt. Throws Error('invalid-ncryptsec'), Error('wrong-password'),
 * or Error('unsupported-log-n') when the backup needs more scrypt memory than
 * this device can give (it would crash the tab instead).
 */
export async function fromNcryptsec(ncryptsec: string, password: string): Promise<string> {
  const data = decodeNcryptsec(ncryptsec)
  const logN = data[1]!
  if (logN > maxDecryptLogN()) throw new Error('unsupported-log-n')
  const salt = data.subarray(2, 18)
  const nonce = data.subarray(18, 42)
  const ad = data.subarray(42, 43)
  const ct = data.subarray(43)
  const key = await nip49Key(password, salt, logN)
  try {
    const sk = xchacha20poly1305(key, nonce, ad).decrypt(ct)
    const hex = bytesToHex(sk)
    sk.fill(0)
    return hex
  } catch {
    throw new Error('wrong-password')
  } finally {
    key.fill(0)
  }
}

// ---------------------------------------------------------------- passkey (WebAuthn PRF)
//
// Flow (cannot run in Node; browser only):
//   lock:   create() a platform passkey with UV required and the prf extension,
//           then immediately get() it — some providers (e.g. iCloud Keychain)
//           return no PRF output at create(), and Apple returns different PRF
//           values for UV vs non-UV, so we always read it via a UV-required get().
//   key:    HKDF-SHA256(ikm = PRF output, salt = vault salt, info) -> AES-GCM-256.
//   store:  credential id (for allowCredentials), the PRF salt, iv, ciphertext.
//   unlock: get() with allowCredentials + same PRF salt -> same key -> decrypt.
// Losing the passkey loses the key; the UI must offer an ncryptsec backup.

const HKDF_INFO = utf8ToBytes('ilchon-vault-v1 aes-gcm-256')

type PrfResults = { enabled?: boolean; results?: { first?: BufferSource } }

function webauthnError(e: unknown): Error {
  const name = (e as { name?: string } | null)?.name
  if (name === 'NotAllowedError' || name === 'AbortError') return new Error('passkey-cancelled')
  if (e instanceof Error && /^[a-z-]+$/.test(e.message)) return e
  return new Error('passkey-failed')
}

function toBytes(b: BufferSource): Uint8Array {
  return b instanceof ArrayBuffer ? new Uint8Array(b) : new Uint8Array(b.buffer, b.byteOffset, b.byteLength)
}

/** Runs a UV-required assertion with the PRF extension and returns the 32-byte PRF output. */
async function prfGet(credId: Uint8Array, prfSalt: Uint8Array): Promise<Uint8Array> {
  let cred: PublicKeyCredential | null
  try {
    cred = (await navigator.credentials.get({
      publicKey: {
        challenge: randomBytes(32) as BufferSource,
        rpId: location.hostname,
        allowCredentials: [{ type: 'public-key', id: credId as BufferSource }],
        userVerification: 'required',
        timeout: 120_000,
        extensions: { prf: { eval: { first: prfSalt as BufferSource } } } as AuthenticationExtensionsClientInputs,
      },
    })) as PublicKeyCredential | null
  } catch (e) {
    throw webauthnError(e)
  }
  if (!cred) throw new Error('passkey-cancelled')
  const prf = (cred.getClientExtensionResults() as { prf?: PrfResults }).prf
  const first = prf?.results?.first
  if (!first) throw new Error('prf-unsupported')
  return toBytes(first).slice()
}

function deriveAesKey(prfOut: Uint8Array, salt: Uint8Array): Uint8Array {
  const key = hkdf(sha256, prfOut, salt, HKDF_INFO, 32)
  prfOut.fill(0)
  return key
}

/**
 * True only if a user-verifying platform authenticator exists and PRF is
 * plausibly available. Never throws.
 */
export async function passkeySupported(): Promise<boolean> {
  try {
    if (typeof window === 'undefined' || !window.isSecureContext) return false
    const PKC = (window as { PublicKeyCredential?: typeof PublicKeyCredential }).PublicKeyCredential
    if (!PKC) return false
    // PRF on iOS needs iOS 18+; older versions would create a passkey that then fails.
    const ios = /(?:iPhone|iPad|iPod)[^)]*OS (\d+)_/.exec(navigator.userAgent || '')
    if (ios && Number(ios[1]) < 18) return false
    const getCaps = (PKC as unknown as { getClientCapabilities?: () => Promise<Record<string, boolean>> })
      .getClientCapabilities
    if (typeof getCaps === 'function') {
      const caps = await getCaps.call(PKC)
      const prf = caps['extension:prf'] ?? caps['prf']
      if (prf === false) return false
      if (caps['userVerifyingPlatformAuthenticator'] === false) return false
      if (prf === true && caps['userVerifyingPlatformAuthenticator'] === true) return true
    }
    if (typeof PKC.isUserVerifyingPlatformAuthenticatorAvailable !== 'function') return false
    return await PKC.isUserVerifyingPlatformAuthenticatorAvailable()
  } catch {
    return false
  }
}

/**
 * A passkey made by create() whose PRF read failed afterwards (usually the
 * follow-up get() lost the tap on iOS). The next passkey lock with the same
 * label reuses it with only a get(), so retries never pile up passkeys.
 */
let pending: { credId: Uint8Array; prfSalt: Uint8Array; label: string } | null = null

/** True when the attestation's authenticator data has the UV flag (bit 2). */
function attestedUV(cred: PublicKeyCredential): boolean {
  try {
    const resp = cred.response as AuthenticatorAttestationResponse & { getAuthenticatorData?: () => ArrayBuffer }
    const data = resp.getAuthenticatorData?.()
    return !!data && data.byteLength > 32 && (new Uint8Array(data)[32]! & 0x04) !== 0
  } catch {
    return false
  }
}

function sealWithPrf(sk: Uint8Array, prfOut: Uint8Array, credId: Uint8Array, prfSalt: Uint8Array): LockedVault {
  const key = deriveAesKey(prfOut, prfSalt)
  const iv = randomBytes(12)
  try {
    const ct = gcm(key, iv, credId).encrypt(sk)
    return {
      v: 1,
      method: 'passkey',
      credId: base64urlnopad.encode(credId),
      iv: base64urlnopad.encode(iv),
      ct: base64urlnopad.encode(ct),
      salt: base64urlnopad.encode(prfSalt),
    }
  } finally {
    key.fill(0)
  }
}

async function lockWithPasskey(sk: Uint8Array, label: string): Promise<LockedVault> {
  // Retry after a failed PRF read: only a get(), no new passkey.
  if (pending && pending.label === label) {
    const p = pending
    let out: Uint8Array
    try {
      out = await prfGet(p.credId, p.prfSalt)
    } catch (e) {
      if ((e as Error).message === 'prf-unsupported') pending = null
      throw e
    }
    pending = null
    return sealWithPrf(sk, out, p.credId, p.prfSalt)
  }
  pending = null
  const prfSalt = randomBytes(32)
  let cred: PublicKeyCredential | null
  try {
    cred = (await navigator.credentials.create({
      publicKey: {
        challenge: randomBytes(32) as BufferSource,
        rp: { name: 'ilchon', id: location.hostname },
        user: { id: randomBytes(16) as BufferSource, name: label, displayName: label },
        pubKeyCredParams: [
          { type: 'public-key', alg: -7 }, // ES256
          { type: 'public-key', alg: -257 }, // RS256
        ],
        authenticatorSelection: {
          authenticatorAttachment: 'platform',
          residentKey: 'preferred',
          userVerification: 'required',
        },
        timeout: 120_000,
        extensions: { prf: { eval: { first: prfSalt as BufferSource } } } as AuthenticationExtensionsClientInputs,
      },
    })) as PublicKeyCredential | null
  } catch (e) {
    throw webauthnError(e)
  }
  if (!cred) throw new Error('passkey-cancelled')
  const prf = (cred.getClientExtensionResults() as { prf?: PrfResults }).prf
  // Explicit "enabled: false" means the authenticator has no PRF. Missing => try get() anyway.
  if (prf && prf.enabled === false) throw new Error('prf-unsupported')
  const credId = new Uint8Array(cred.rawId)
  const created = prf?.results?.first

  if (created && attestedUV(cred)) {
    // UV was performed at create, so this is the same UV-seeded value a later get() returns.
    // A follow-up get() is only a cross-check; losing the tap there is not fatal.
    let out: Uint8Array = toBytes(created).slice()
    try {
      const again = await prfGet(credId, prfSalt)
      out.fill(0)
      out = again
    } catch {
      // keep the create() output
    }
    return sealWithPrf(sk, out, credId, prfSalt)
  }

  // No usable PRF from create(): read it with a UV-required get().
  try {
    return sealWithPrf(sk, await prfGet(credId, prfSalt), credId, prfSalt)
  } catch (e) {
    const code = (e as Error).message
    if (code === 'passkey-cancelled') {
      pending = { credId, prfSalt, label }
      throw new Error('passkey-confirm')
    }
    throw e
  }
}

async function unlockWithPasskey(v: Extract<LockedVault, { method: 'passkey' }>): Promise<string> {
  let credId: Uint8Array, iv: Uint8Array, ct: Uint8Array, salt: Uint8Array
  try {
    credId = base64urlnopad.decode(v.credId)
    iv = base64urlnopad.decode(v.iv)
    ct = base64urlnopad.decode(v.ct)
    salt = base64urlnopad.decode(v.salt)
  } catch {
    throw new Error('corrupt')
  }
  const key = deriveAesKey(await prfGet(credId, salt), salt)
  try {
    const sk = gcm(key, iv, credId).decrypt(ct)
    const hex = bytesToHex(sk)
    sk.fill(0)
    return hex
  } catch {
    throw new Error('corrupt')
  } finally {
    key.fill(0)
  }
}

// ---------------------------------------------------------------- public API

/**
 * Locks a 64-hex secret key with the chosen method.
 * Errors: 'weak-password', 'prf-unsupported', 'passkey-cancelled', 'invalid-key',
 * 'passkey-confirm' (passkey made but its PRF read failed; call again from a new tap,
 * which only runs a get() on that passkey).
 */
export async function lockSecret(secretHex: string, choice: LockChoice, label: string): Promise<LockedVault> {
  const sk = checkSecret(secretHex)
  switch (choice.method) {
    case 'none':
      return { v: 1, method: 'none', sk: bytesToHex(sk) }
    case 'password':
      if (choice.password.length < MIN_PASSWORD) throw new Error('weak-password')
      return { v: 1, method: 'password', ncryptsec: await toNcryptsec(bytesToHex(sk), choice.password) }
    case 'passkey':
      try {
        return await lockWithPasskey(sk, label || 'ilchon')
      } finally {
        sk.fill(0)
      }
  }
}

/**
 * Returns the 64-hex secret key.
 * Errors: 'wrong-password', 'passkey-cancelled', 'prf-unsupported', 'corrupt'.
 */
export async function unlockSecret(v: LockedVault, password?: string): Promise<string> {
  if (!v || v.v !== 1) throw new Error('corrupt')
  switch (v.method) {
    case 'none': {
      const hex = typeof v.sk === 'string' ? v.sk.toLowerCase() : ''
      if (!HEX64.test(hex)) throw new Error('corrupt')
      return hex
    }
    case 'password':
      if (!password) throw new Error('wrong-password')
      try {
        return await fromNcryptsec(v.ncryptsec, password)
      } catch (e) {
        if ((e as Error).message === 'invalid-ncryptsec') throw new Error('corrupt')
        throw e
      }
    case 'passkey':
      return unlockWithPasskey(v)
    default:
      throw new Error('corrupt')
  }
}

/** Convenience bundle matching EngineDeps.vault. */
export const vault = { passkeySupported, lockSecret, unlockSecret, toNcryptsec, fromNcryptsec, ncryptsecKeySecurity }
export type VaultModule = typeof vault
