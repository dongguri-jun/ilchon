import type { GenericKeyValueStore, SerializedClientState, StoredInviteEntry, StoredKeyPackage } from '@internet-privacy/marmot-ts'
import type { Tables } from '../../contracts'
import type { InboxEntry } from './durable-inbox'
import { isHex64, randomHex } from './keys'
import { warn } from './log'

/** Every durable table the Marmot client needs, one profile's encrypted tables (src/lib/store). */
export interface MarmotStores {
  groups: GenericKeyValueStore<SerializedClientState>
  keyPackages: GenericKeyValueStore<StoredKeyPackage>
  /** Wrapped by guardInviteStore: flush() before the store goes away. */
  invites: GuardedInviteStore
  ingest: GenericKeyValueStore<Uint8Array>
  rewind: GenericKeyValueStore<Uint8Array>
  removed: GenericKeyValueStore<boolean>
  /** Transport-owned settings (KeyPackage slot id). */
  meta: GenericKeyValueStore<string>
  /** Received messages not handled yet: key the rumor id. */
  inbox: GenericKeyValueStore<InboxEntry>
}

/** The Marmot tables over the profile's storage tables: encrypted with everything else. */
export function storesFrom(tables: Pick<Tables, 'table'>): MarmotStores {
  return {
    groups: tables.table<SerializedClientState>('groups'),
    keyPackages: tables.table<StoredKeyPackage>('keypackages'),
    // The guard is outside the encryption: only its merged writes are encrypted.
    invites: guardInviteStore(tables.table<StoredInviteEntry>('invites')),
    ingest: tables.table<Uint8Array>('ingest'),
    rewind: tables.table<Uint8Array>('rewind'),
    removed: tables.table<boolean>('removed'),
    meta: tables.table<string>('meta'),
    inbox: tables.table<InboxEntry>('inbox'),
  }
}

/** Name of the cross-tab lock one profile and account hold while the transport runs. Never stored. */
export function profileLockName(namespace: string, pubkey: string): string {
  return `${namespace}/marmot/${pubkey}`
}

const SLOT_KEY = 'key-package-slot'

/**
 * KeyPackage publication slot (`d` tag / clientId): 32 random bytes as 64
 * lowercase hex, generated once and kept for this profile.
 */
export async function loadClientId(meta: GenericKeyValueStore<string>): Promise<string> {
  const stored = await meta.getItem(SLOT_KEY)
  if (isHex64(stored)) return stored
  const slot = randomHex(32)
  await meta.setItem(SLOT_KEY, slot)
  return slot
}

// ---------------------------------------------------------------- invite store guard

/** Seen gift wrap ids kept in the stored `__seen` entry (the newest). */
export const SEEN_KEEP = 5_000
/** Decrypted Welcomes waiting to be accepted or ignored. */
export const UNREAD_KEEP = 100
/** Gift wraps waiting to be decrypted (each is removed once tried; a safety cap). */
export const RECEIVED_KEEP = 200
/** The `__seen` entry is written at most once per this many ms. */
export const SEEN_WRITE_MS = 2_000

const SEEN_KEY = '__seen'
const CAPS: readonly [prefix: string, keep: number][] = [
  ['unread:', UNREAD_KEEP],
  ['received:', RECEIVED_KEEP],
]

export interface GuardedInviteStore extends GenericKeyValueStore<StoredInviteEntry> {
  /** Writes a waiting `__seen` now. */
  flush(): Promise<void>
}

export interface InviteGuardOptions {
  /** Called once per trim (the support log's 'invite store trimmed' line). */
  onTrim?: () => void
  timers?: { set(fn: () => void, ms: number): unknown; clear(handle: unknown): void }
}

/**
 * Bounds the invite store against a flood of gift wraps: the
 * library rewrites the whole seen list on every new wrap (n² writes) and keeps
 * every unread Welcome. `__seen` keeps the newest SEEN_KEEP ids and is written at
 * most every SEEN_WRITE_MS (setItem resolves at once); `unread:` and `received:`
 * entries beyond their caps go, oldest written first. Losing a merged write (the
 * app closed within 2 s) is safe: a wrap seen again is decrypted again and the
 * rumor id dedupe (transport #knownInvites, engine handledInvites) drops it.
 */
export function guardInviteStore(inner: GenericKeyValueStore<StoredInviteEntry>, opts: InviteGuardOptions = {}): GuardedInviteStore {
  const timers = opts.timers ?? {
    set: (fn: () => void, ms: number) => setTimeout(fn, ms),
    clear: (h: unknown) => clearTimeout(h as ReturnType<typeof setTimeout>),
  }
  let pendingSeen: StoredInviteEntry | null = null
  let seenTimer: unknown = null
  /** key -> order of its last write, for the capped prefixes. */
  const order = new Map<string, number>()
  let seq = 0
  let ready: Promise<void> | null = null
  const init = (): Promise<void> =>
    (ready ??= inner.keys().then(
      (keys) => {
        for (const k of keys) if (CAPS.some(([p]) => k.startsWith(p))) order.set(k, ++seq)
      },
      () => {
        ready = null
      },
    ))

  async function writeSeen(): Promise<void> {
    if (seenTimer !== null) timers.clear(seenTimer)
    seenTimer = null
    const value = pendingSeen
    pendingSeen = null
    if (!value) return
    try {
      await inner.setItem(SEEN_KEY, value)
    } catch {
      // Safe to lose (see above); the next new wrap writes it again.
    }
  }

  async function trim(prefix: string, keep: number): Promise<void> {
    const keys = [...order.entries()].filter(([k]) => k.startsWith(prefix)).sort((a, b) => a[1] - b[1])
    if (keys.length <= keep) return
    for (const [k] of keys.slice(0, keys.length - keep)) {
      order.delete(k)
      await inner.removeItem(k).catch(() => {})
    }
    warn('invite store trimmed')
    opts.onTrim?.()
  }

  return {
    async getItem(key) {
      if (key === SEEN_KEY && pendingSeen) return pendingSeen
      return inner.getItem(key)
    },
    async setItem(key, value) {
      if (key === SEEN_KEY) {
        const v = value.type === 'seen' ? { type: 'seen' as const, ids: value.ids.slice(-SEEN_KEEP) } : value
        pendingSeen = v
        if (seenTimer === null) seenTimer = timers.set(() => void writeSeen(), SEEN_WRITE_MS)
        return v
      }
      await init()
      const out = await inner.setItem(key, value)
      const cap = CAPS.find(([p]) => key.startsWith(p))
      if (cap) {
        order.set(key, ++seq)
        await trim(cap[0], cap[1])
      }
      return out
    },
    async removeItem(key) {
      if (key === SEEN_KEY) pendingSeen = null
      order.delete(key)
      await inner.removeItem(key)
    },
    async clear() {
      pendingSeen = null
      if (seenTimer !== null) timers.clear(seenTimer)
      seenTimer = null
      order.clear()
      await inner.clear()
    },
    async keys() {
      const keys = await inner.keys()
      return pendingSeen && !keys.includes(SEEN_KEY) ? [...keys, SEEN_KEY] : keys
    },
    flush: writeSeen,
  }
}
