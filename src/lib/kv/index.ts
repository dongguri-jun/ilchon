import type { KV } from '../../contracts'

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
