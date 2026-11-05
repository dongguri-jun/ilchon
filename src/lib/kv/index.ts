import localforage from 'localforage'
import type { KV } from '../../contracts'

/**
 * IndexedDB-backed KV. Every key is stored as `${namespace}/${key}`. The
 * separator cannot occur in a profile name, so profile `a` never lists or
 * deletes the keys of profile `ab`.
 */
export function createBrowserKV(namespace: string): KV {
  const store = localforage.createInstance({ name: 'ilchon', storeName: 'kv' })
  const base = namespace + '/'
  const full = (key: string) => base + key
  return {
    async get<T>(key: string) {
      const v = await store.getItem<T>(full(key))
      return v === null ? undefined : v
    },
    async set<T>(key: string, value: T) {
      await store.setItem(full(key), value)
    },
    async del(key: string) {
      await store.removeItem(full(key))
    },
    async keys(prefix = '') {
      const all = await store.keys()
      const start = base + prefix
      return all.filter((k) => k.startsWith(start)).map((k) => k.slice(base.length))
    },
  }
}

/** In-memory KV for Node and tests. Values are structured-cloned like IndexedDB. */
export function createMemoryKV(): KV {
  const m = new Map<string, unknown>()
  return {
    async get<T>(key: string) {
      return m.has(key) ? (structuredClone(m.get(key)) as T) : undefined
    },
    async set<T>(key: string, value: T) {
      m.set(key, structuredClone(value))
    },
    async del(key: string) {
      m.delete(key)
    },
    async keys(prefix = '') {
      return [...m.keys()].filter((k) => k.startsWith(prefix))
    },
  }
}
