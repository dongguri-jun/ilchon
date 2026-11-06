import type { Currency, PublicOffer, Side, WireMessage } from '../../contracts'

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function isString(value: unknown): value is string {
  return typeof value === 'string'
}

function isNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value)
}

function isSide(value: unknown): value is Side {
  return value === 'buy' || value === 'sell'
}

function isCurrency(value: unknown): value is Currency {
  return value === 'KRW' || value === 'USD'
}

function parseOffer(value: unknown): PublicOffer | null {
  if (!isRecord(value)) return null
  const { side, currency, amount, feePct, createdAt } = value
  if (!isSide(side) || !isCurrency(currency)) return null
  if (!isNumber(amount) || !isNumber(feePct) || !isNumber(createdAt)) return null
  return { side, currency, amount, feePct, createdAt }
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
      if (value.r !== undefined && (!isString(value.r) || !/^[A-Za-z0-9_-]{16,64}$/.test(value.r))) return null
      return { t: 'hello', v: 1, code: value.code, ...(value.r === undefined ? {} : { r: value.r }) }
    }
    case 'm1':
      return isString(value.sid) && isString(value.p)
        ? { t: 'm1', sid: value.sid, p: value.p }
        : null
    case 'm2':
      return isString(value.sid) && isString(value.q) && isString(value.pq)
        ? { t: 'm2', sid: value.sid, q: value.q, pq: value.pq }
        : null
    case 'm3':
      return isString(value.sid) && isString(value.qp)
        ? { t: 'm3', sid: value.sid, qp: value.qp }
        : null
    case 'mx':
      return isString(value.sid) ? { t: 'mx', sid: value.sid } : null
    case 'offer': {
      const offer = parseOffer(value.offer)
      return offer ? { t: 'offer', offer } : null
    }
    case 'withdraw':
      return { t: 'withdraw' }
    case 'chat':
      return isString(value.text) ? { t: 'chat', text: value.text } : null
    case 'done':
      return isNumber(value.amount) && isCurrency(value.currency)
        ? { t: 'done', amount: value.amount, currency: value.currency }
        : null
    default:
      return null
  }
}
