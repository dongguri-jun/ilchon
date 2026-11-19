import { ristretto255, ristretto255_hasher } from '@noble/curves/ed25519.js'
import { mapHashToField } from '@noble/curves/abstract/modular.js'
import { sha256 } from '@noble/hashes/sha2.js'
import { concatBytes, randomBytes, utf8ToBytes } from '@noble/hashes/utils.js'
import { base64urlnopad } from '@scure/base'
import { PAY_METHODS, type MatchCrypto, type MatchLabels, type PayMethod } from '../../contracts'

/**
 * Private equality test over ristretto255, two slots per round (see MatchCrypto
 * in contracts.ts). Slot i is PAY_METHODS[i]; every value below is per slot,
 * with its own fresh scalar:
 *
 *   A: p_i  = H2G(label_i)^a_i                       -> sends p  = [p_0, p_1]
 *   B: q_i  = H2G(label_i)^b_i, h_i = C_i(p_i^b_i)   -> sends q, h (h in the `pq` field)
 *   A: qp_i = q_i^a_i, ok_i = (C_i(qp_i) == h_i)     -> sends qp = [qp_0, qp_1]
 *   B: ok_i = (C_i(qp_i) == h_i)
 *   matched = ok_0 | ok_1 on both sides
 *
 * C_i is a SHA-256 commitment tagged with the slot's method. p_i^b_i itself
 * never goes on the wire: if it did, A could echo it back as qp and fake a
 * match on B's side. The label binds the round (initiator, responder, sid), so
 * a peer cannot feed one of my rounds into another of mine (reflection), and
 * the slot's method, so values moved between slots never compare equal. A slot
 * my offer does not cover gets a fresh random label: every message has the same
 * shape and length whatever the offer, or none.
 */

const Point = ristretto255.Point
type RPoint = InstanceType<typeof Point>
const Fn = Point.Fn

const LABEL_TAG = 'ilchon/match/v2/label'
const CONFIRM_TAG = 'ilchon/match/v2/confirm'
const H2G_DST = 'ilchon/match/v2/h2g/ristretto255_XMD:SHA-512_R255MAP_RO_'
const POINT_BYTES = 32
const LABEL_BYTES = 32
const SLOTS = PAY_METHODS.length

/**
 * The methods in canonical form: duplicates dropped, PAY_METHODS order. Null when
 * the value is not an array, is empty, or holds anything that is not a known method.
 */
export function canonicalMethods(v: unknown): PayMethod[] | null {
  if (!Array.isArray(v) || v.length === 0) return null
  if (!v.every((m) => (PAY_METHODS as readonly unknown[]).includes(m))) return null
  return PAY_METHODS.filter((m) => v.includes(m))
}

/** The methods both lists hold, in PAY_METHODS order. What the screens show. */
export function commonMethods(a: readonly PayMethod[], b: readonly PayMethod[]): PayMethod[] {
  return PAY_METHODS.filter((m) => a.includes(m) && b.includes(m))
}

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
function decodePoint(text: unknown): RPoint {
  if (typeof text !== 'string') throw new Error('match: malformed point encoding')
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

/** The secret is a_0 ‖ a_1, each Fn.BYTES little-endian, base64url. */
function decodeSecret(text: unknown): bigint[] {
  let bytes: Uint8Array
  try {
    if (typeof text !== 'string') throw new Error('type')
    bytes = base64urlnopad.decode(text)
  } catch {
    throw new Error('match: malformed secret')
  }
  if (bytes.length !== Fn.BYTES * SLOTS) throw new Error('match: malformed secret')
  const out: bigint[] = []
  for (let i = 0; i < SLOTS; i++) {
    let s: bigint
    try {
      s = Fn.fromBytes(bytes.slice(i * Fn.BYTES, (i + 1) * Fn.BYTES))
    } catch {
      throw new Error('match: malformed secret')
    }
    if (!Fn.isValidNot0(s)) throw new Error('match: malformed secret')
    out.push(s)
  }
  return out
}

/** Constant-time comparison of two equal-length byte strings. */
function ctEqual(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false
  let diff = 0
  for (let i = 0; i < a.length; i++) diff |= a[i] ^ b[i]
  return diff === 0
}

/** Slot i's commitment to a doubly blinded point. Ristretto encodings are canonical. */
function confirmOf(slot: number, pt: RPoint): Uint8Array {
  return sha256(concatBytes(lpText(CONFIRM_TAG), lpText(PAY_METHODS[slot]), pt.toBytes()))
}

function decodeConfirm(text: unknown): Uint8Array {
  let bytes: Uint8Array
  try {
    if (typeof text !== 'string') throw new Error('type')
    bytes = base64urlnopad.decode(text)
  } catch {
    throw new Error('match: malformed confirmation')
  }
  if (bytes.length !== 32) throw new Error('match: malformed confirmation')
  return bytes
}

/** Both slots of a pair; throws unless it is exactly two values. */
function slotsOf(pair: unknown): [unknown, unknown] {
  if (!Array.isArray(pair) || pair.length !== SLOTS) throw new Error('match: malformed pair')
  return [pair[0], pair[1]]
}

function labelsOk(labels: unknown): labels is MatchLabels {
  return Array.isArray(labels) && labels.length === SLOTS && labels.every((l) => l instanceof Uint8Array && l.length === LABEL_BYTES)
}

export const matchCrypto: MatchCrypto = {
  labelsFor({ context, myPubkey, peerPubkey, initiator, sid, offer }) {
    const me = myPubkey.toLowerCase()
    const peer = peerPubkey.toLowerCase()
    const init = initiator.toLowerCase()
    if (init !== me && init !== peer) throw new Error('match: initiator must be me or the peer')
    const responder = init === me ? peer : me
    const out: Uint8Array[] = []
    for (let i = 0; i < SLOTS; i++) {
      const method = PAY_METHODS[i]
      if (offer === null || !offer.methods.includes(method)) {
        out.push(randomBytes(LABEL_BYTES))
        continue
      }
      const seller = offer.side === 'sell' ? me : peer
      const buyer = offer.side === 'sell' ? peer : me
      out.push(sha256(concatBytes(lpText(LABEL_TAG), lpText(context), lpText(seller), lpText(buyer), lpText(offer.currency), lpText(method), lpText(init), lpText(responder), lpText(sid))))
    }
    return [out[0], out[1]]
  },

  round1(labels) {
    if (!labelsOk(labels)) throw new Error('match: malformed labels')
    const a = [randomScalar(), randomScalar()]
    const p = labels.map((l, i) => encodePoint(hashToGroup(l).multiply(a[i])))
    const secret = base64urlnopad.encode(concatBytes(...a.map((s) => Fn.toBytes(s))))
    return { secret, p: [p[0], p[1]] }
  },

  round2(labels, p) {
    if (!labelsOk(labels)) throw new Error('match: malformed labels')
    // Every input is read before anything is computed.
    const pPoints = slotsOf(p).map(decodePoint)
    const q: string[] = []
    const pq: string[] = []
    for (let i = 0; i < SLOTS; i++) {
      const b = randomScalar()
      q.push(encodePoint(hashToGroup(labels[i]).multiply(b)))
      // Only the commitment leaves this function; it is both sent and kept.
      pq.push(base64urlnopad.encode(confirmOf(i, pPoints[i].multiply(b))))
    }
    return { q: [q[0], q[1]], pq: [pq[0], pq[1]] }
  },

  round3(secret, q, pq) {
    const a = decodeSecret(secret)
    const qPoints = slotsOf(q).map(decodePoint)
    const h = slotsOf(pq).map(decodeConfirm)
    const qp: string[] = []
    let matched = false
    for (let i = 0; i < SLOTS; i++) {
      const pt = qPoints[i].multiply(a[i])
      // Both slots are computed: no short-circuit on the first match.
      const ok = ctEqual(confirmOf(i, pt), h[i])
      matched = matched || ok
      qp.push(encodePoint(pt))
    }
    return { matched, qp: [qp[0], qp[1]] }
  },

  finish(pq, qp) {
    const h = slotsOf(pq).map(decodeConfirm)
    const pts = slotsOf(qp).map(decodePoint)
    let matched = false
    for (let i = 0; i < SLOTS; i++) {
      const ok = ctEqual(confirmOf(i, pts[i]), h[i])
      matched = matched || ok
    }
    return matched
  },
}
