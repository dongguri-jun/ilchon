/**
 * Value codec of the encrypted store. What goes in comes
 * back with the same shape, or the write fails: nothing is changed quietly.
 *
 * - A Uint8Array (a Node Buffer too): 0x01 ‖ the bytes. Most transport records are this.
 * - Anything else: 0x02 ‖ UTF-8 JSON, where a Uint8Array inside becomes
 *   { "$t": "b", "v": base64url } and a bigint { "$t": "n", "v": decimal }.
 *   A property that is undefined is left out and undefined in an array becomes null,
 *   as in JSON. Numbers must be finite. Only plain objects (Object.prototype or a null
 *   prototype) and arrays pass; a Map, Set, Date, another typed array, a class
 *   instance, a function or a symbol, and an object with an own "$t" property throw
 *   Error('unserializable').
 * - Reading anything else (another tag, broken UTF-8 or JSON, a bad "$t" record)
 *   throws Error('storage-damaged').
 */
import { base64urlnopad } from '@scure/base'

const TAG_BYTES = 0x01
const TAG_JSON = 0x02

const unserializable = () => new Error('unserializable')
const damaged = () => new Error('storage-damaged')

function isPlainObject(v: object): boolean {
  const proto = Object.getPrototypeOf(v)
  return proto === Object.prototype || proto === null
}

/**
 * JSON.stringify calls toJSON before the replacer, so `this[key]` (the holder's own
 * value) is what we judge: a Buffer's toJSON would hide that it is bytes, and a Date's
 * would turn it into a string.
 */
function replacer(this: Record<string, unknown>, key: string, _converted: unknown): unknown {
  const v = this[key]
  if (v instanceof Uint8Array) return { $t: 'b', v: base64urlnopad.encode(v) }
  switch (typeof v) {
    case 'bigint':
      return { $t: 'n', v: v.toString(10) }
    case 'number':
      if (!Number.isFinite(v)) throw unserializable()
      return v
    case 'string':
    case 'boolean':
    case 'undefined':
      return v
    case 'function':
    case 'symbol':
      throw unserializable()
    case 'object':
      if (v === null) return v
      if (Array.isArray(v)) return v
      if (!isPlainObject(v)) throw unserializable()
      if (Object.prototype.hasOwnProperty.call(v, '$t')) throw unserializable()
      // The original object, not a toJSON result: its own properties go through here too.
      return v
  }
  throw unserializable()
}

export function encode(value: unknown): Uint8Array {
  if (value instanceof Uint8Array) {
    const out = new Uint8Array(value.length + 1)
    out[0] = TAG_BYTES
    out.set(value, 1)
    return out
  }
  if (value === undefined) throw unserializable()
  const json = JSON.stringify(value, replacer)
  if (typeof json !== 'string') throw unserializable()
  const body = new TextEncoder().encode(json)
  const out = new Uint8Array(body.length + 1)
  out[0] = TAG_JSON
  out.set(body, 1)
  return out
}

const DECIMAL = /^-?(0|[1-9][0-9]*)$/

function reviver(_key: string, v: unknown): unknown {
  if (typeof v !== 'object' || v === null || Array.isArray(v)) return v
  if (!Object.prototype.hasOwnProperty.call(v, '$t')) return v
  const rec = v as Record<string, unknown>
  const keys = Object.keys(rec)
  if (keys.length !== 2 || typeof rec.v !== 'string') throw damaged()
  if (rec.$t === 'b') {
    try {
      return base64urlnopad.decode(rec.v)
    } catch {
      throw damaged()
    }
  }
  if (rec.$t === 'n') {
    if (!DECIMAL.test(rec.v)) throw damaged()
    return BigInt(rec.v)
  }
  throw damaged()
}

export function decode(bytes: Uint8Array): unknown {
  if (!(bytes instanceof Uint8Array) || bytes.length === 0) throw damaged()
  // A copy, and a plain Uint8Array even when `bytes` is a Node Buffer (whose slice shares memory).
  if (bytes[0] === TAG_BYTES) return new Uint8Array(bytes.subarray(1))
  if (bytes[0] !== TAG_JSON) throw damaged()
  let text: string
  try {
    text = new TextDecoder('utf-8', { fatal: true }).decode(bytes.subarray(1))
  } catch {
    throw damaged()
  }
  try {
    return JSON.parse(text, reviver)
  } catch {
    throw damaged()
  }
}
