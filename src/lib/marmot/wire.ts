import type { MatchPair, PublicOffer, Side, WireMessage } from '../../contracts'
import { canonicalMethods } from '../match'
import { isCurrency } from '../money'

/** A room-record id carried by 'chat' and 'done': 32 lowercase hex, the same on a resend. */
const RECORD_ID = /^[0-9a-f]{32}$/

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function isString(value: unknown): value is string {
  return typeof value === 'string'
}

function isNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value)
}

/** A match round id: exactly 32 lowercase hex, the shape every honest app makes (randomId). */
export const isSid = (v: unknown): v is string => typeof v === 'string' && /^[0-9a-f]{32}$/.test(v)

/** One string per PAY_METHODS slot, exactly two. */
export const isPair = (v: unknown): v is MatchPair => Array.isArray(v) && v.length === 2 && v.every(isString)

function isSide(value: unknown): value is Side {
  return value === 'buy' || value === 'sell'
}

function parseOffer(value: unknown): PublicOffer | null {
  if (!isRecord(value)) return null
  const { side, currency, amountMinor, feePct, createdAt } = value
  if (!isSide(side) || !isCurrency(currency)) return null
  // Only "is a number" here; the engine checks the range (isMinor).
  if (!isNumber(amountMinor) || !isNumber(feePct) || !isNumber(createdAt)) return null
  // Empty, unknown or missing methods drop the message; duplicates collapse.
  const methods = canonicalMethods(value.methods)
  if (!methods) return null
  return { side, currency, amountMinor, feePct, methods, createdAt }
}

/**
 * Parse rumor content into a WireMessage. Returns null for malformed JSON or
 * an unknown shape. Unknown fields are dropped.
 */
export function parseWireMessage(content: string): WireMessage | null {
  let value: unknown
  try {
    value = JSON.parse(content)
  } catch {
    return null
  }
  if (!isRecord(value)) return null
  switch (value.t) {
    case 'hello': {
      if (value.v !== 1 || !isString(value.code)) return null
      return { t: 'hello', v: 1, code: value.code }
    }
    // Every match message carries both slots: a pair is rebuilt so no extra field rides along.
    case 'm1':
      return isSid(value.sid) && isPair(value.p) ? { t: 'm1', sid: value.sid, p: [value.p[0], value.p[1]] } : null
    case 'm2':
      return isSid(value.sid) && isPair(value.q) && isPair(value.pq) ? { t: 'm2', sid: value.sid, q: [value.q[0], value.q[1]], pq: [value.pq[0], value.pq[1]] } : null
    case 'm3':
      return isSid(value.sid) && isPair(value.qp) ? { t: 'm3', sid: value.sid, qp: [value.qp[0], value.qp[1]] } : null
    case 'mx':
      return isSid(value.sid) ? { t: 'mx', sid: value.sid } : null
    case 'offer': {
      const offer = parseOffer(value.offer)
      return offer ? { t: 'offer', offer } : null
    }
    case 'withdraw':
      return { t: 'withdraw' }
    case 'chat':
      return isString(value.text) && isString(value.id) && RECORD_ID.test(value.id) ? { t: 'chat', id: value.id, text: value.text } : null
    case 'done':
      // `id` names the sender's room record: 32 lowercase hex, the same on a resend.
      return isString(value.id) && RECORD_ID.test(value.id) && isNumber(value.amountMinor) && isCurrency(value.currency)
        ? { t: 'done', id: value.id, amountMinor: value.amountMinor, currency: value.currency }
        : null
    default:
      return null
  }
}
