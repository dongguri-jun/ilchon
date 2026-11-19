/**
 * Raw bytes under the encryption layer of src/lib/store.
 * Two object stores in one database per profile:
 *   lock  'device' (non-extractable CryptoKey), 'record' (sealed lock record), 'format'
 *   data  sealed entry name -> iv ‖ AES-GCM ciphertext
 * Nothing here sees a key, a name or a value in plain text.
 */

export interface SealedBlob {
  iv: Uint8Array
  ct: Uint8Array
}
export interface LockEntries {
  device?: CryptoKey
  record?: SealedBlob
  format?: number
}

/**
 * Raw bytes under the encryption layer. One per profile. Every method creates its
 * IndexedDB transaction synchronously during the call, so transactions follow call
 * order. All failures reject Error('storage-unavailable').
 */
export interface StoreBackend {
  readLock(): Promise<LockEntries>
  /** One transaction, durability 'strict'. Fields left out keep their stored value. */
  writeLock(entries: LockEntries): Promise<void>
  get(key: string): Promise<Uint8Array | undefined>
  put(key: string, value: Uint8Array): Promise<void>
  del(key: string): Promise<void>
  /** Keys k with lo <= k < hi, sorted, without values. */
  keys(lo: string, hi: string): Promise<string[]>
  delRange(lo: string, hi: string): Promise<void>
  clearData(): Promise<void>
  /** Closes and deletes everything. Rejects 'reset-failed' when blocked for 5 s. */
  destroy(): Promise<void>
}

export interface MemoryBackend extends StoreBackend {
  /** Test view of everything stored. */
  raw(): { lock: LockEntries; data: Map<string, Uint8Array> }
  /** Called before each lock or data write; a returned promise holds the write until it settles. */
  onWrite?: (kind: 'lock' | 'data') => void | Promise<void>
  /** The next call of `op` rejects Error('storage-unavailable'). */
  failNext(op: 'readLock' | 'writeLock' | 'get' | 'put'): void
}

const unavailable = (cause?: unknown) => new Error('storage-unavailable', cause === undefined ? undefined : { cause })

// ---------------------------------------------------------------- IndexedDB

/** How long a deletion blocked by another open connection may take before it fails. */
const DELETE_BLOCKED_MS = 5_000
const LOCK = 'lock'
const DATA = 'data'

function request<T>(req: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    req.onsuccess = () => resolve(req.result)
    req.onerror = () => reject(unavailable(req.error))
  })
}

function finished(tx: IDBTransaction): Promise<void> {
  return new Promise((resolve, reject) => {
    tx.oncomplete = () => resolve()
    tx.onerror = () => reject(unavailable(tx.error))
    tx.onabort = () => reject(unavailable(tx.error))
  })
}

/**
 * The browser backend. The database opens on first use. While it is opening, calls
 * wait on the same promise and create their transactions in call order once it is
 * open. Another tab deleting or upgrading it closes this connection and calls
 * `onClosedByOther` (the app reloads).
 */
export function indexedDbBackend(dbName: string, onClosedByOther: () => void): StoreBackend {
  let opening: Promise<IDBDatabase> | null = null
  let closed = false

  function open(): Promise<IDBDatabase> {
    if (closed) return Promise.reject(unavailable())
    opening ??= new Promise<IDBDatabase>((resolve, reject) => {
      let req: IDBOpenDBRequest
      try {
        req = indexedDB.open(dbName, 1)
      } catch (e) {
        reject(unavailable(e))
        return
      }
      req.onupgradeneeded = () => {
        const db = req.result
        if (!db.objectStoreNames.contains(LOCK)) db.createObjectStore(LOCK)
        if (!db.objectStoreNames.contains(DATA)) db.createObjectStore(DATA)
      }
      req.onsuccess = () => {
        const db = req.result
        db.onversionchange = () => {
          db.close()
          closed = true
          onClosedByOther()
        }
        // The browser closed it (storage cleared, connection lost): open again next time.
        db.onclose = () => {
          opening = null
        }
        resolve(db)
      }
      req.onerror = () => reject(unavailable(req.error))
      req.onblocked = () => reject(unavailable())
    })
    // A failed open is not kept: the next call tries again.
    opening.catch(() => {
      opening = null
    })
    return opening
  }

  /** Runs `fn` with a fresh transaction, created in call order; any throw is storage-unavailable. */
  function withTx<T>(store: string, mode: IDBTransactionMode, fn: (s: IDBObjectStore, tx: IDBTransaction) => Promise<T>, strict = false): Promise<T> {
    return open().then((db) => {
      let tx: IDBTransaction
      try {
        tx = strict ? db.transaction(store, mode, { durability: 'strict' }) : db.transaction(store, mode)
        return fn(tx.objectStore(store), tx).catch((e: unknown) => {
          throw e instanceof Error && e.message === 'storage-unavailable' ? e : unavailable(e)
        })
      } catch (e) {
        return Promise.reject(unavailable(e))
      }
    })
  }

  return {
    readLock() {
      return withTx(LOCK, 'readonly', async (s) => {
        const [device, record, format] = await Promise.all([request(s.get('device')), request(s.get('record')), request(s.get('format'))])
        return { device, record, format } as LockEntries
      })
    },
    writeLock(entries) {
      return withTx(
        LOCK,
        'readwrite',
        (s, tx) => {
          const done = finished(tx)
          if (entries.device !== undefined) s.put(entries.device, 'device')
          if (entries.record !== undefined) s.put(entries.record, 'record')
          if (entries.format !== undefined) s.put(entries.format, 'format')
          return done
        },
        true,
      )
    },
    get(key) {
      return withTx(DATA, 'readonly', (s) => request(s.get(key)) as Promise<Uint8Array | undefined>)
    },
    put(key, value) {
      return withTx(DATA, 'readwrite', (s, tx) => {
        const done = finished(tx)
        s.put(value, key)
        return done
      })
    },
    del(key) {
      return withTx(DATA, 'readwrite', (s, tx) => {
        const done = finished(tx)
        s.delete(key)
        return done
      })
    },
    keys(lo, hi) {
      return withTx(DATA, 'readonly', (s) => request(s.getAllKeys(IDBKeyRange.bound(lo, hi, false, true))).then((ks) => ks.map(String)))
    },
    delRange(lo, hi) {
      return withTx(DATA, 'readwrite', (s, tx) => {
        const done = finished(tx)
        s.delete(IDBKeyRange.bound(lo, hi, false, true))
        return done
      })
    },
    clearData() {
      return withTx(DATA, 'readwrite', (s, tx) => {
        const done = finished(tx)
        s.clear()
        return done
      })
    },
    async destroy() {
      const was = opening
      opening = null
      if (was) {
        try {
          ;(await was).close()
        } catch {
          // It never opened: nothing to close.
        }
      }
      await new Promise<void>((resolve, reject) => {
        let timer: ReturnType<typeof setTimeout> | undefined
        let req: IDBOpenDBRequest
        try {
          req = indexedDB.deleteDatabase(dbName)
        } catch {
          reject(new Error('reset-failed'))
          return
        }
        req.onsuccess = () => {
          if (timer !== undefined) clearTimeout(timer)
          resolve()
        }
        req.onerror = () => {
          if (timer !== undefined) clearTimeout(timer)
          reject(new Error('reset-failed'))
        }
        // Blocked may still turn into success when the other connection closes.
        req.onblocked = () => {
          timer ??= setTimeout(() => reject(new Error('reset-failed')), DELETE_BLOCKED_MS)
        }
      })
    },
  }
}

// ---------------------------------------------------------------- memory

/**
 * Node and tests. Requests run one after another in call order, like IndexedDB
 * transactions on one store; `onWrite` can hold a write (and everything after it).
 * Values are copied in and out.
 */
export function memoryBackend(): MemoryBackend {
  let lock: LockEntries = {}
  const data = new Map<string, Uint8Array>()
  const fail = new Set<string>()
  let tail: Promise<unknown> = Promise.resolve()

  const sorted = (lo: string, hi: string) => [...data.keys()].filter((k) => k >= lo && k < hi).sort()

  function run<T>(op: string, write: 'lock' | 'data' | null, fn: () => T): Promise<T> {
    const result = tail.then(async () => {
      if (fail.delete(op)) throw unavailable()
      if (write && backend.onWrite) await backend.onWrite(write)
      return fn()
    })
    tail = result.catch(() => {})
    return result
  }

  const copyLock = (e: LockEntries): LockEntries => ({
    ...(e.device !== undefined ? { device: e.device } : {}),
    ...(e.record !== undefined ? { record: { iv: e.record.iv.slice(), ct: e.record.ct.slice() } } : {}),
    ...(e.format !== undefined ? { format: e.format } : {}),
  })

  const backend: MemoryBackend = {
    readLock: () => run('readLock', null, () => copyLock(lock)),
    writeLock: (entries) => {
      const copy = copyLock(entries)
      return run('writeLock', 'lock', () => {
        lock = { ...lock, ...copy }
      })
    },
    get: (key) =>
      run('get', null, () => {
        const v = data.get(key)
        return v === undefined ? undefined : v.slice()
      }),
    put: (key, value) => {
      const copy = value.slice()
      return run('put', 'data', () => {
        data.set(key, copy)
      })
    },
    del: (key) =>
      run('del', 'data', () => {
        data.delete(key)
      }),
    keys: (lo, hi) => run('keys', null, () => sorted(lo, hi)),
    delRange: (lo, hi) =>
      run('delRange', 'data', () => {
        for (const k of sorted(lo, hi)) data.delete(k)
      }),
    clearData: () =>
      run('clearData', 'data', () => {
        data.clear()
      }),
    destroy: () =>
      run('destroy', null, () => {
        lock = {}
        data.clear()
      }),
    raw: () => ({ lock: copyLock(lock), data: new Map([...data].map(([k, v]) => [k, v.slice()])) }),
    failNext(op) {
      fail.add(op)
    },
  }
  return backend
}
