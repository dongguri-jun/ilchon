/**
 * A ProfileStorage without encryption, over a plain KV. For the
 * engine harness only (scripts/check-engine.ts): the engine's logical keys stay
 * readable in the harness KV, and no crypto.subtle call runs on Node's thread pool,
 * which the virtual clock's settle() cannot wait for. Never part of the app:
 * `pnpm build` looks for PLAIN_MARKER in dist/ (scripts/check-dist.ts).
 *
 * - status(): an empty KV is null; a KV with keys but another or no `format` is
 *   'storage-format'; no `identity` is null; otherwise lock 'none'.
 * - create(): lock 'none' only. Writes `format` and `plain` (PLAIN_MARKER), hands the tables to init.
 *   Writing the marker at run time keeps it in any bundle that holds this code, so
 *   check-dist finds it (an unused constant would be dropped by the bundler).
 * - tables.kv is the KV itself; table(name) is a `mls/<name>/` prefix view of it.
 */
import type { KV, LockChoice, ProfileStorage, Table, Tables } from './types'

export const PLAIN_MARKER = 'ilchon-plain-storage-test-only'

const notAllowed = () => new Error('not-allowed')

function prefixTable<T>(kv: KV, name: string): Table<T> {
  const prefix = `mls/${name}/`
  return {
    async getItem(key) {
      const v = await kv.get<T>(prefix + key)
      return v === undefined ? null : v
    },
    async setItem(key, value) {
      await kv.set(prefix + key, value)
      return value
    },
    removeItem: (key) => kv.del(prefix + key),
    async clear() {
      for (const k of await kv.keys(prefix)) await kv.del(k)
    },
    async keys() {
      return (await kv.keys(prefix)).map((k) => k.slice(prefix.length))
    },
  }
}

export function createPlainStorage(kv: KV, opts: { format: number }): ProfileStorage {
  const tables: Tables = { kv, table: <T>(name: string) => prefixTable<T>(kv, name) }
  const isNone = (c: LockChoice) => c?.method === 'none'
  return {
    async status() {
      if ((await kv.keys()).length === 0) return null
      if ((await kv.get<number>('format')) !== opts.format) throw new Error('storage-format')
      if ((await kv.get('identity')) === undefined) return null
      return { method: 'none', waitUntil: 0 }
    },
    async create(choice, init) {
      if (!isNone(choice)) throw notAllowed()
      if ((await kv.get('identity')) !== undefined) throw new Error('identity-exists')
      await kv.set('format', opts.format)
      await kv.set('plain', PLAIN_MARKER)
      await init(tables)
      return tables
    },
    async unlock(proof) {
      if (!isNone(proof)) throw notAllowed()
      return tables
    },
    async verify(proof) {
      if (!isNone(proof)) throw notAllowed()
    },
    async relock() {
      throw notAllowed()
    },
    async passkeySupported() {
      return false
    },
    async wipe() {
      for (const k of await kv.keys()) await kv.del(k)
    },
  }
}
