import type { ConnectPayload } from '../../contracts'

const PREFIX = 'ilchon:'
const HEX64 = /^[0-9a-f]{64}$/
const HEX32 = /^[0-9a-f]{32}$/
const B64URL = /^[A-Za-z0-9_-]+$/

/** 16 random bytes as lowercase hex. */
export function newCode(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(16))
  let out = ''
  for (const b of bytes) out += b.toString(16).padStart(2, '0')
  return out
}

/** "ilchon:" + base64url(JSON). The JSON is ASCII only, so btoa is safe. */
export function encodePayload(p: ConnectPayload): string {
  const json = JSON.stringify({ v: p.v, pk: p.pk, code: p.code, exp: p.exp })
  return PREFIX + btoa(json).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
}

export function decodePayload(text: string): ConnectPayload | null {
  if (typeof text !== 'string') return null
  const trimmed = text.trim()
  if (!trimmed.startsWith(PREFIX)) return null
  const body = trimmed.slice(PREFIX.length)
  if (body.length === 0 || body.length > 1024 || !B64URL.test(body)) return null

  let parsed: unknown
  try {
    const b64 = body.replace(/-/g, '+').replace(/_/g, '/')
    parsed = JSON.parse(atob(b64 + '='.repeat((4 - (b64.length % 4)) % 4)))
  } catch {
    return null
  }
  if (typeof parsed !== 'object' || parsed === null) return null

  const { v, pk, code, exp } = parsed as Record<string, unknown>
  if (v !== 1) return null
  if (typeof pk !== 'string' || !HEX64.test(pk)) return null
  if (typeof code !== 'string' || !HEX32.test(code)) return null
  if (typeof exp !== 'number' || !Number.isFinite(exp)) return null
  return { v: 1, pk, code, exp }
}
