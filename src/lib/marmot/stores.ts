import localforage from 'localforage'
import type {
  GenericKeyValueStore,
  SerializedClientState,
  StoredInviteEntry,
  StoredKeyPackage,
} from '@internet-privacy/marmot-ts'
import { InMemoryKeyValueStore } from '@internet-privacy/marmot-ts/extra'
import { isHex64, randomHex } from './keys'

/**
 * IndexedDB store via localforage. Structured clone keeps `Uint8Array` and
 * `bigint` intact, so MLS state needs no JSON tagging.
 */
class LocalForageStore<T> implements GenericKeyValueStore<T> {
  readonly #store: LocalForage

  constructor(name: string, storeName: string) {
    this.#store = localforage.createInstance({ name, storeName, driver: localforage.INDEXEDDB })
  }

  async getItem(key: string): Promise<T | null> {
    return (await this.#store.getItem<T>(key)) ?? null
  }

  setItem(key: string, value: T): Promise<T> {
    return this.#store.setItem<T>(key, value)
  }

  removeItem(key: string): Promise<void> {
    return this.#store.removeItem(key)
  }

  clear(): Promise<void> {
    return this.#store.clear()
  }

  keys(): Promise<string[]> {
    return this.#store.keys()
  }
}

/** Every durable table the Marmot client needs, isolated per namespace and account. */
export interface MarmotStores {
  groups: GenericKeyValueStore<SerializedClientState>
  keyPackages: GenericKeyValueStore<StoredKeyPackage>
  invites: GenericKeyValueStore<StoredInviteEntry>
  ingest: GenericKeyValueStore<Uint8Array>
  rewind: GenericKeyValueStore<Uint8Array>
  removed: GenericKeyValueStore<boolean>
  /** Transport-owned settings (KeyPackage slot id). */
  meta: GenericKeyValueStore<string>
}

const TABLES = ['groups', 'keypackages', 'invites', 'ingest', 'rewind', 'removed', 'meta'] as const

/** IndexedDB database name for one profile and account. */
export function marmotDatabaseName(namespace: string, pubkey: string): string {
  return `${namespace}/marmot/${pubkey}`
}

/**
 * Memory stores live as long as the process, keyed like the IndexedDB
 * database. A transport created again with the same namespace and key picks
 * its state back up, which is what a page reload does with IndexedDB.
 */
const memoryStores = new Map<string, MarmotStores>()

export function createStores(
  namespace: string,
  pubkey: string,
  persistence: 'indexeddb' | 'memory',
): MarmotStores {
  const name = marmotDatabaseName(namespace, pubkey)
  if (persistence === 'memory') {
    let stores = memoryStores.get(name)
    if (!stores) {
      stores = {
        groups: new InMemoryKeyValueStore<SerializedClientState>(),
        keyPackages: new InMemoryKeyValueStore<StoredKeyPackage>(),
        invites: new InMemoryKeyValueStore<StoredInviteEntry>(),
        ingest: new InMemoryKeyValueStore<Uint8Array>(),
        rewind: new InMemoryKeyValueStore<Uint8Array>(),
        removed: new InMemoryKeyValueStore<boolean>(),
        meta: new InMemoryKeyValueStore<string>(),
      }
      memoryStores.set(name, stores)
    }
    return stores
  }
  return {
    groups: new LocalForageStore<SerializedClientState>(name, 'groups'),
    keyPackages: new LocalForageStore<StoredKeyPackage>(name, 'keypackages'),
    invites: new LocalForageStore<StoredInviteEntry>(name, 'invites'),
    ingest: new LocalForageStore<Uint8Array>(name, 'ingest'),
    rewind: new LocalForageStore<Uint8Array>(name, 'rewind'),
    removed: new LocalForageStore<boolean>(name, 'removed'),
    meta: new LocalForageStore<string>(name, 'meta'),
  }
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

/**
 * Delete every Marmot table of one profile and account. Stop the transport
 * first.
 */
export async function purgeMarmotStorage(namespace: string, pubkey: string): Promise<void> {
  const name = marmotDatabaseName(namespace, pubkey)
  if (memoryStores.delete(name)) return
  for (const table of TABLES) await new LocalForageStore<unknown>(name, table).clear()
}
