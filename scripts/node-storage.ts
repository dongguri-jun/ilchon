/**
 * The storage Node scripts give the engine and the transport: the
 * real encrypted store over a memory backend, lock 'none' through the development
 * module. Real encryption and the real codec, with real MLS values from real relays.
 * Not for the engine harness, which uses createPlainStorage (scripts/check-engine.ts).
 */
import type { KV, ProfileStorage, Tables } from '../src/contracts'
import { STORE_FORMAT } from '../src/engine/index'
import { createProfileStorage } from '../src/lib/store'
import { memoryBackend, type MemoryBackend } from '../src/lib/store/backend'

export const noLock = () => import('../src/lib/vault/no-lock.ts')

export interface NodeStorage {
  storage: ProfileStorage
  backend: MemoryBackend
  /** The engine's KV once the store was created or unlocked (for dumps). */
  kv(): KV
  /** The tables once the store was created or unlocked. */
  tables(): Tables
}

/** A new memory-backed store; `backend` reuses one (a reload). */
export function nodeStorage(namespace: string, backend: MemoryBackend = memoryBackend()): NodeStorage {
  const inner = createProfileStorage({ backend, namespace, format: STORE_FORMAT, noLock })
  let open: Tables | null = null
  const keep = (t: Tables) => (open = t)
  const storage: ProfileStorage = {
    status: () => inner.status(),
    create: (choice, init) => inner.create(choice, init).then(keep),
    unlock: (proof) => inner.unlock(proof).then(keep),
    verify: (proof) => inner.verify(proof),
    relock: (choice) => inner.relock(choice),
    passkeySupported: () => inner.passkeySupported(),
    wipe: () => inner.wipe(),
  }
  const tables = () => {
    if (!open) throw new Error('store not open')
    return open
  }
  return { storage, backend, tables, kv: () => tables().kv }
}

/** Every byte the backend holds (keys, values, the sealed lock record), for "no plain text" checks. */
export function rawBytes(backend: MemoryBackend): Uint8Array[] {
  const raw = backend.raw()
  const out: Uint8Array[] = []
  for (const [k, v] of raw.data) out.push(new TextEncoder().encode(k), v)
  if (raw.lock.record) out.push(raw.lock.record.iv, raw.lock.record.ct)
  return out
}

/**
 * The needles found in the backend: each searched as UTF-8 bytes and as base64url
 * text inside the keys (names are base64url). Returns what was found.
 */
export function plainTextIn(backend: MemoryBackend, needles: { what: string; value: string }[]): string[] {
  const hay = rawBytes(backend)
  const found: string[] = []
  for (const n of needles) {
    if (!n.value) continue
    const bytes = new TextEncoder().encode(n.value)
    const b64 = Buffer.from(n.value).toString('base64url')
    const hit = hay.some((h) => indexOf(h, bytes) >= 0 || (b64.length >= 8 && Buffer.from(h).toString('latin1').includes(b64)))
    if (hit) found.push(n.what)
  }
  return found
}

function indexOf(h: Uint8Array, n: Uint8Array): number {
  return Buffer.from(h.buffer, h.byteOffset, h.byteLength).indexOf(Buffer.from(n.buffer, n.byteOffset, n.byteLength))
}
