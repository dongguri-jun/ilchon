import { ristretto255, ristretto255_hasher } from '@noble/curves/ed25519.js'
import { mapHashToField } from '@noble/curves/abstract/modular.js'
import { sha256 } from '@noble/hashes/sha2.js'
import { concatBytes, randomBytes, utf8ToBytes } from '@noble/hashes/utils.js'
import { base64urlnopad } from '@scure/base'
import type { MatchCrypto } from '../../contracts'

/**
 * Private equality test over ristretto255 (see MatchCrypto in contracts.ts).
 *
 *   A: p  = H2G(label_A)^a                  -> sends p
 *   B: q  = H2G(label_B)^b, h = C(p^b)      -> sends q, h   (in the `pq` field)
 *   A: qp = q^a, matched = (C(qp) == h)     -> sends qp
 *   B: matched = (C(qp) == h)
 *
 * C is a domain-separated SHA-256 commitment. p^b itself never goes on the
 * wire: if it did, A could echo it back as qp and fake a match on B's side.
 * Without b, A can produce a point whose commitment equals h only when
 * label_A == label_B. Neither side learns anything about the other's label
 * beyond that one bit.
 */

const Point = ristretto255.Point
type RPoint = InstanceType<typeof Point>
const Fn = Point.Fn

const LABEL_TAG = 'ilchon/match/v1'
const CONFIRM_TAG = 'ilchon/match/v1/confirm'
const H2G_DST = 'ilchon/match/v1/h2g/ristretto255_XMD:SHA-512_R255MAP_RO_'
const POINT_BYTES = 32
const LABEL_BYTES = 32

/** 4-byte big-endian length, then the bytes. */
function lp(bytes: Uint8Array): Uint8Array {
  const out = new Uint8Array(4 + bytes.length)
  new DataView(out.buffer).setUint32(0, bytes.length, false)
  out.set(bytes, 4)
  return out
}

function lpText(text: string): Uint8Array {
  return lp(utf8ToBytes(text))
}

function hashToGroup(label: Uint8Array): RPoint {
  if (label.length !== LABEL_BYTES) throw new Error('match: label must be 32 bytes')
  return ristretto255_hasher.hashToCurve(label, { DST: H2G_DST })
}

/** Uniform scalar in 1..n-1. */
function randomScalar(): bigint {
  const s = Fn.fromBytes(mapHashToField(randomBytes(48), Fn.ORDER, true))
  if (!Fn.isValidNot0(s)) throw new Error('match: scalar generation failed')
  return s
}

function encodePoint(pt: RPoint): string {
  return base64urlnopad.encode(pt.toBytes())
}

/** Decodes a canonical, non-identity ristretto255 point. Throws otherwise. */
function decodePoint(text: string): RPoint {
  let bytes: Uint8Array
  try {
    bytes = base64urlnopad.decode(text)
  } catch {
    throw new Error('match: malformed point encoding')
  }
  if (bytes.length !== POINT_BYTES) throw new Error('match: malformed point length')
  let pt: RPoint
  try {
    pt = Point.fromBytes(bytes)
  } catch {
    throw new Error('match: invalid point')
  }
  if (pt.is0()) throw new Error('match: identity point')
  return pt
}

function decodeScalar(text: string): bigint {
  let s: bigint
  try {
    const bytes = base64urlnopad.decode(text)
    if (bytes.length !== Fn.BYTES) throw new Error('length')
    s = Fn.fromBytes(bytes)
  } catch {
    throw new Error('match: malformed secret')
  }
  if (!Fn.isValidNot0(s)) throw new Error('match: malformed secret')
  return s
}

/** Constant-time comparison of two equal-length byte strings. */
function ctEqual(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false
  let diff = 0
  for (let i = 0; i < a.length; i++) diff |= a[i] ^ b[i]
  return diff === 0
}

/** Commitment to a doubly blinded point. Ristretto encodings are canonical. */
function confirmOf(pt: RPoint): Uint8Array {
  return sha256(concatBytes(lpText(CONFIRM_TAG), pt.toBytes()))
}

function decodeConfirm(text: string): Uint8Array {
  let bytes: Uint8Array
  try {
    bytes = base64urlnopad.decode(text)
  } catch {
    throw new Error('match: malformed confirmation')
  }
  if (bytes.length !== 32) throw new Error('match: malformed confirmation')
  return bytes
}

export const matchCrypto: MatchCrypto = {
  labelFor({ context, myPubkey, peerPubkey, offer }) {
    if (offer === null) return randomBytes(LABEL_BYTES)
    const me = myPubkey.toLowerCase()
    const peer = peerPubkey.toLowerCase()
    const seller = offer.side === 'sell' ? me : peer
    const buyer = offer.side === 'sell' ? peer : me
    return sha256(
      concatBytes(
        lpText(LABEL_TAG),
        lpText(context),
        lpText(seller),
        lpText(buyer),
        lpText(offer.currency),
      ),
    )
  },

  round1(label) {
    const a = randomScalar()
    const p = hashToGroup(label).multiply(a)
    return { secret: base64urlnopad.encode(Fn.toBytes(a)), p: encodePoint(p) }
  },

  round2(label, p) {
    const pPoint = decodePoint(p)
    const b = randomScalar()
    const q = hashToGroup(label).multiply(b)
    // Only the commitment leaves this function; it is both sent and kept.
    const h = confirmOf(pPoint.multiply(b))
    return { q: encodePoint(q), pq: base64urlnopad.encode(h) }
  },

  round3(secret, q, pq) {
    const a = decodeScalar(secret)
    const qPoint = decodePoint(q)
    const h = decodeConfirm(pq)
    const qp = qPoint.multiply(a)
    return { matched: ctEqual(confirmOf(qp), h), qp: encodePoint(qp) }
  },

  finish(pq, qp) {
    const h = decodeConfirm(pq)
    return ctEqual(confirmOf(decodePoint(qp)), h)
  },
}
