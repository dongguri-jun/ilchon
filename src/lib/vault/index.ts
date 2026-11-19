/**
 * Lock keys: a KEK from a passkey's PRF output or a 6-digit PIN. Never log PINs,
 * PRF output or keys.
 *
 * Pure crypto + WebAuthn. No React, no engine imports. Lock method 'none' lives in
 * ./no-lock.ts (development builds and Node only).
 */
import { randomBytes, utf8ToBytes } from '@noble/hashes/utils.js'

// ---------------------------------------------------------------- passkey (WebAuthn PRF)
//
// Browser only. A UV-required get() always produces the PRF output (Apple returns
// different PRF values for UV and non-UV, and some providers give none at create()).

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
  // The caller zeroes the copy once used; the browser's own buffer is zeroed here.
  const view = toBytes(first)
  const out = view.slice()
  view.fill(0)
  return out
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
    const getCaps = (PKC as unknown as { getClientCapabilities?: () => Promise<Record<string, boolean>> }).getClientCapabilities
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

// ---------------------------------------------------------------- lock keys
//
// A KEK (key-encryption key) that wraps the profile's data key in src/lib/store
// Only WebCrypto, never extractable.

/** PBKDF2-HMAC-SHA256 rounds for a 6-digit PIN (OWASP). Stored per lock record as `iter`. */
export const PIN_ITERATIONS = 600_000

/** HKDF info for the passkey KEK. A public constant. */
const PASSKEY_KEK_INFO = utf8ToBytes('ilchon/kek/passkey/v2')

/**
 * Throws Error('weak-pin') unless `pin` is 6 ASCII digits, not all equal and not a
 * ±1 run (012345 … 456789, 987654 … 543210). Full-width digits are not ASCII digits.
 */
export function checkPin(pin: string): void {
  if (typeof pin !== 'string' || !/^[0-9]{6}$/.test(pin)) throw new Error('weak-pin')
  const d = [...pin].map((c) => c.charCodeAt(0) - 48)
  const steps = d.slice(1).map((x, i) => x - d[i]!)
  if (steps.every((s) => s === 0) || steps.every((s) => s === 1) || steps.every((s) => s === -1)) {
    throw new Error('weak-pin')
  }
}

/** PBKDF2-HMAC-SHA256 -> non-extractable AES-GCM-256 key. */
export async function pinKek(pin: string, salt: Uint8Array, iterations: number): Promise<CryptoKey> {
  const pinBytes = utf8ToBytes(pin)
  let base: CryptoKey
  try {
    base = await crypto.subtle.importKey('raw', pinBytes as BufferSource, 'PBKDF2', false, ['deriveKey'])
  } finally {
    pinBytes.fill(0)
  }
  return crypto.subtle.deriveKey({ name: 'PBKDF2', hash: 'SHA-256', salt: salt as BufferSource, iterations }, base, { name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt'])
}

/** HKDF-SHA256(ikm = PRF output, salt = prfSalt, info) -> non-extractable AES-GCM-256. Zeroes `prfOut`. */
async function kekFromPrf(prfOut: Uint8Array, prfSalt: Uint8Array): Promise<CryptoKey> {
  let base: CryptoKey
  try {
    base = await crypto.subtle.importKey('raw', prfOut as BufferSource, 'HKDF', false, ['deriveKey'])
  } finally {
    prfOut.fill(0)
  }
  return crypto.subtle.deriveKey({ name: 'HKDF', hash: 'SHA-256', salt: prfSalt as BufferSource, info: PASSKEY_KEK_INFO as BufferSource }, base, { name: 'AES-GCM', length: 256 }, false, [
    'encrypt',
    'decrypt',
  ])
}

/**
 * A passkey createPasskeyKek made whose UV get() was cancelled (iOS often loses the
 * tap between create() and get()). Calling again with the same name only repeats
 * the get(), so retries never pile up passkeys.
 */
let pendingKek: { credId: Uint8Array; prfSalt: Uint8Array; name: string } | null = null

/**
 * Creates a platform passkey named `name` (UV required, PRF with a fresh 32-byte
 * salt), then derives the KEK from a UV get() of the same credential and salt.
 * create()'s own PRF output is never used.
 * Errors: 'passkey-cancelled', 'passkey-confirm' (the get() was cancelled; calling
 * again with the same name only repeats the get()), 'prf-unsupported'.
 * navigator.credentials is reached before the first await.
 */
export async function createPasskeyKek(name: string): Promise<{ kek: CryptoKey; credId: Uint8Array; prfSalt: Uint8Array }> {
  if (pendingKek && pendingKek.name === name) {
    const p = pendingKek
    let out: Uint8Array
    try {
      out = await prfGet(p.credId, p.prfSalt)
    } catch (e) {
      const code = (e as Error).message
      if (code === 'passkey-cancelled') throw new Error('passkey-confirm')
      pendingKek = null
      throw e
    }
    pendingKek = null
    return { kek: await kekFromPrf(out, p.prfSalt), credId: p.credId.slice(), prfSalt: p.prfSalt.slice() }
  }
  pendingKek = null
  const prfSalt = randomBytes(32)
  let cred: PublicKeyCredential | null
  try {
    cred = (await navigator.credentials.create({
      publicKey: {
        challenge: randomBytes(32) as BufferSource,
        rp: { name: 'ilchon', id: location.hostname },
        user: { id: randomBytes(16) as BufferSource, name, displayName: name },
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
  // create()'s PRF value is only a sign of support; it is wiped, never used.
  const created = prf?.results?.first
  if (created) toBytes(created).fill(0)
  if (prf && prf.enabled === false) throw new Error('prf-unsupported')
  const credId = new Uint8Array(cred.rawId)
  let out: Uint8Array
  try {
    out = await prfGet(credId, prfSalt)
  } catch (e) {
    if ((e as Error).message === 'passkey-cancelled') {
      pendingKek = { credId, prfSalt, name }
      throw new Error('passkey-confirm')
    }
    throw e
  }
  return { kek: await kekFromPrf(out, prfSalt), credId, prfSalt }
}

/** UV get() with the stored credential and salt -> the same KEK. Reaches navigator.credentials before the first await. */
export async function passkeyKek(credId: Uint8Array, prfSalt: Uint8Array): Promise<CryptoKey> {
  return kekFromPrf(await prfGet(credId, prfSalt), prfSalt)
}
