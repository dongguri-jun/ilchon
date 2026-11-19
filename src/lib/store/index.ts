/**
 * Encrypted storage of one profile.
 * Everything an unlocked profile keeps sits here as ciphertext under one
 * data key (DEK); only the lock opens the DEK.
 *
 *   passkey PRF --HKDF(prfSalt)--+
 *                                +-- KEK --AES-GCM--> wrapped DEK  (inside the lock record)
 *   6-digit PIN --PBKDF2 600k----+
 *   lock record --AES-GCM(device key: non-extractable, in IndexedDB)--> sealed record
 *   DEK --HKDF--> valueKey (AES-GCM), nameKey (AES-GCM), sivKey (HMAC-SHA256)
 *
 * - Only WebCrypto. Every key is non-extractable. AES-GCM nonces are 12 random bytes,
 *   except entry names, whose nonce is HMAC(sivKey, table ‖ 0 ‖ name): the same name
 *   always seals to the same key (lookups need that) and two different names share a
 *   nonce only on a 96-bit HMAC collision.
 * - A value's AAD is its entry key, so a value moved to another entry fails to open.
 * - Requests of one instance reach the backend in call order (one issue chain): a
 *   read sees every write called before it, and a slow write never lands after a
 *   later one.
 * - Never logs. No PIN, PRF output, key, salt, credential id or entry name leaves
 *   this module except inside a sealed record; errors are bare codes.
 */
import { base64urlnopad } from '@scure/base'
import { checkPin, createPasskeyKek, passkeyKek, passkeySupported, PIN_ITERATIONS, pinKek } from '../vault'
import type { LockEntries, SealedBlob, StoreBackend } from './backend'
import { decode, encode } from './codec'
import type { KV, LockChoice, LockMethod, LockStatus, ProfileStorage, Table, Tables } from './types'

export type { LockChoice, LockMethod, LockStatus, ProfileStorage, Table, Tables } from './types'

/** What the sealed lock record holds (JSON inside the device-key seal). */
export interface LockRecord {
  v: 2
  method: 'passkey' | 'pin' | 'none'
  /** passkey: credential id, PRF salt (base64url) */
  credId?: string
  prfSalt?: string
  /** pin: PBKDF2 salt (base64url) and iterations */
  pinSalt?: string
  iter?: number
  /** passkey, pin: iv and AES-GCM ciphertext of the DEK under the KEK (base64url) */
  dekIv?: string
  dek: string
  /** none (development and Node only): `dek` is the raw DEK; marker from src/lib/vault/no-lock.ts */
  marker?: string
  /** PIN attempts that failed since the last success */
  failures: number
  /** unix ms of the last failed attempt; 0 when failures is 0 */
  lastFailAt: number
}

type NoLock = typeof import('../vault/no-lock')

export interface ProfileStorageOptions {
  backend: StoreBackend
  namespace: string
  /** STORE_FORMAT of the engine. A stored format that differs is 'storage-format'. */
  format: number
  /** Development builds and Node only: the module that handles lock method 'none'. */
  noLock?: () => Promise<NoLock>
  now?: () => number
}

const subtle = globalThis.crypto.subtle
const utf8 = (s: string) => new TextEncoder().encode(s)
const b64 = (b: Uint8Array) => base64urlnopad.encode(b)

const RECORD_AAD = utf8('ilchon/lock/v2')
const dekAad = (method: LockMethod) => utf8(`ilchon/dek/v2/${method}`)
const STORE_SALT = utf8('ilchon/store/v2')
const IV_BYTES = 12
const TAG_BYTES = 9
const GCM_TAG_BYTES = 16
const DEK_BYTES = 32
/** Failed PIN attempts that cost no wait. */
const FREE_FAILURES = 4

const fail = (code: string) => new Error(code)
const damaged = () => fail('storage-damaged')

/** Seconds to wait after `f` failed PIN attempts, in ms: 30 s, 1 min, 5 min, 15 min, then 60 min. */
export function waitAfter(f: number): number {
  if (f <= FREE_FAILURES) return 0
  if (f === 5) return 30_000
  if (f === 6) return 60_000
  if (f === 7) return 5 * 60_000
  if (f === 8) return 15 * 60_000
  return 60 * 60_000
}

/**
 * The passkey's name in the OS password manager (synced, shown in plain text): never
 * a key. 'ilchon' for the shipped profile, 'ilchon a' for the development profile ?p=a.
 */
export function passkeyName(namespace: string): string {
  return namespace === 'ilchon:default' ? 'ilchon' : `ilchon ${namespace.slice('ilchon:'.length)}`
}

function b64d(s: unknown): Uint8Array {
  if (typeof s !== 'string') throw damaged()
  try {
    return base64urlnopad.decode(s)
  } catch {
    throw damaged()
  }
}

function concat(a: Uint8Array, b: Uint8Array): Uint8Array {
  const out = new Uint8Array(a.length + b.length)
  out.set(a, 0)
  out.set(b, a.length)
  return out
}

/** Backend failures are 'storage-unavailable' unless they carry one of the codes it may give. */
function backendError(e: unknown): Error {
  const m = e instanceof Error ? e.message : ''
  return m === 'storage-unavailable' || m === 'reset-failed' ? (e as Error) : new Error('storage-unavailable', { cause: e })
}

// ---------------------------------------------------------------- cross-tab lock

const localLocks = new Map<string, Promise<void>>()

/** navigator.locks in the browser; in Node, a promise chain per name in this process. */
function withLock<T>(name: string, fn: () => Promise<T>): Promise<T> {
  const locks = typeof navigator !== 'undefined' ? (navigator as { locks?: LockManager }).locks : undefined
  if (locks && typeof locks.request === 'function') return locks.request(name, fn) as Promise<T>
  const prev = localLocks.get(name) ?? Promise.resolve()
  const run = prev.then(fn)
  localLocks.set(
    name,
    run.then(
      () => {},
      () => {},
    ),
  )
  return run
}

// ---------------------------------------------------------------- the lock record

function isRecord(v: unknown): v is LockRecord {
  if (typeof v !== 'object' || v === null) return false
  const r = v as Record<string, unknown>
  const str = (k: string) => typeof r[k] === 'string'
  if (r.v !== 2 || typeof r.dek !== 'string') return false
  if (!Number.isInteger(r.failures) || (r.failures as number) < 0) return false
  if (typeof r.lastFailAt !== 'number' || !Number.isFinite(r.lastFailAt) || r.lastFailAt < 0) return false
  switch (r.method) {
    case 'passkey':
      return str('credId') && str('prfSalt') && str('dekIv')
    case 'pin':
      return str('pinSalt') && str('dekIv') && Number.isInteger(r.iter) && (r.iter as number) > 0
    case 'none':
      return str('marker')
    default:
      return false
  }
}

async function sealRecord(device: CryptoKey, rec: LockRecord): Promise<SealedBlob> {
  const iv = globalThis.crypto.getRandomValues(new Uint8Array(IV_BYTES))
  const ct = new Uint8Array(await subtle.encrypt({ name: 'AES-GCM', iv, additionalData: RECORD_AAD }, device, utf8(JSON.stringify(rec))))
  return { iv, ct }
}

async function openRecord(device: unknown, blob: unknown): Promise<LockRecord> {
  if (typeof device !== 'object' || device === null) throw damaged()
  const b = blob as Partial<SealedBlob> | null
  if (!b || !(b.iv instanceof Uint8Array) || b.iv.length !== IV_BYTES || !(b.ct instanceof Uint8Array)) throw damaged()
  let plain: Uint8Array
  try {
    plain = new Uint8Array(await subtle.decrypt({ name: 'AES-GCM', iv: b.iv as BufferSource, additionalData: RECORD_AAD }, device as CryptoKey, b.ct as BufferSource))
  } catch {
    throw damaged()
  }
  let rec: unknown
  try {
    rec = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(plain))
  } catch {
    throw damaged()
  } finally {
    plain.fill(0)
  }
  if (!isRecord(rec)) throw damaged()
  return rec
}

/** The DEK of a passkey or PIN record. A failed open rejects 'kek-mismatch' (the caller names it). */
async function unwrapDek(kek: CryptoKey, rec: LockRecord): Promise<Uint8Array> {
  const iv = b64d(rec.dekIv)
  const ct = b64d(rec.dek)
  if (iv.length !== IV_BYTES) throw damaged()
  let dek: Uint8Array
  try {
    dek = new Uint8Array(await subtle.decrypt({ name: 'AES-GCM', iv: iv as BufferSource, additionalData: dekAad(rec.method) }, kek, ct as BufferSource))
  } catch {
    throw fail('kek-mismatch')
  }
  if (dek.length !== DEK_BYTES) {
    dek.fill(0)
    throw damaged()
  }
  return dek
}

/** A KEK (or the no-lock module) made from a LockChoice, ready to wrap the DEK. */
type Made = { method: 'passkey'; kek: CryptoKey; credId: Uint8Array; prfSalt: Uint8Array } | { method: 'pin'; kek: CryptoKey; pinSalt: Uint8Array; iter: number } | { method: 'none'; noLock: NoLock }

async function buildRecord(made: Made, dek: Uint8Array): Promise<LockRecord> {
  const base = { v: 2 as const, failures: 0, lastFailAt: 0 }
  if (made.method === 'none') return { ...base, method: 'none', ...made.noLock.sealNone(dek) }
  const iv = globalThis.crypto.getRandomValues(new Uint8Array(IV_BYTES))
  const ct = new Uint8Array(await subtle.encrypt({ name: 'AES-GCM', iv, additionalData: dekAad(made.method) }, made.kek, dek as BufferSource))
  if (made.method === 'passkey') {
    return { ...base, method: 'passkey', credId: b64(made.credId), prfSalt: b64(made.prfSalt), dekIv: b64(iv), dek: b64(ct) }
  }
  return { ...base, method: 'pin', pinSalt: b64(made.pinSalt), iter: made.iter, dekIv: b64(iv), dek: b64(ct) }
}

// ---------------------------------------------------------------- data keys and sealed names

interface DataKeys {
  value: CryptoKey
  name: CryptoKey
  siv: CryptoKey
}

async function dataKeys(dek: Uint8Array): Promise<DataKeys> {
  const base = await subtle.importKey('raw', dek as BufferSource, 'HKDF', false, ['deriveKey', 'deriveBits'])
  const hk = (info: string): HkdfParams => ({ name: 'HKDF', hash: 'SHA-256', salt: STORE_SALT, info: utf8(info) })
  const aes = { name: 'AES-GCM', length: 256 }
  const [value, name, siv] = await Promise.all([
    subtle.deriveKey(hk('value'), base, aes, false, ['encrypt', 'decrypt']),
    subtle.deriveKey(hk('name'), base, aes, false, ['encrypt', 'decrypt']),
    subtle.deriveKey(hk('siv'), base, { name: 'HMAC', hash: 'SHA-256', length: 256 }, false, ['sign']),
  ])
  return { value, name, siv }
}

async function hmac(keys: DataKeys, text: string): Promise<Uint8Array> {
  return new Uint8Array(await subtle.sign('HMAC', keys.siv, utf8(text)))
}

/** 12 base64url characters per table: HMAC(sivKey, "table" ‖ 0 ‖ table)[0..9]. */
async function tableTag(keys: DataKeys, table: string): Promise<string> {
  return b64((await hmac(keys, `table\u0000${table}`)).slice(0, TAG_BYTES))
}

async function sealName(keys: DataKeys, table: string, tag: string, name: string): Promise<string> {
  const iv = (await hmac(keys, `${table}\u0000${name}`)).slice(0, IV_BYTES)
  const ct = new Uint8Array(await subtle.encrypt({ name: 'AES-GCM', iv, additionalData: utf8(table) }, keys.name, utf8(name)))
  return `${tag}.${b64(concat(iv, ct))}`
}

async function openName(keys: DataKeys, table: string, tag: string, key: string): Promise<string> {
  if (!key.startsWith(`${tag}.`)) throw damaged()
  const raw = b64d(key.slice(tag.length + 1))
  if (raw.length < IV_BYTES + GCM_TAG_BYTES) throw damaged()
  try {
    const plain = await subtle.decrypt({ name: 'AES-GCM', iv: raw.subarray(0, IV_BYTES) as BufferSource, additionalData: utf8(table) }, keys.name, raw.subarray(IV_BYTES) as BufferSource)
    return new TextDecoder('utf-8', { fatal: true }).decode(plain)
  } catch {
    throw damaged()
  }
}

async function sealValue(keys: DataKeys, entryKey: string, plain: Uint8Array): Promise<Uint8Array> {
  const iv = globalThis.crypto.getRandomValues(new Uint8Array(IV_BYTES))
  try {
    const ct = await subtle.encrypt({ name: 'AES-GCM', iv, additionalData: utf8(entryKey) }, keys.value, plain as BufferSource)
    return concat(iv, new Uint8Array(ct))
  } finally {
    plain.fill(0)
  }
}

async function openValue(keys: DataKeys, entryKey: string, sealed: unknown): Promise<unknown> {
  if (!(sealed instanceof Uint8Array) || sealed.length < IV_BYTES + GCM_TAG_BYTES) throw damaged()
  let plain: Uint8Array
  try {
    plain = new Uint8Array(
      await subtle.decrypt({ name: 'AES-GCM', iv: sealed.subarray(0, IV_BYTES) as BufferSource, additionalData: utf8(entryKey) }, keys.value, sealed.subarray(IV_BYTES) as BufferSource),
    )
  } catch {
    throw damaged()
  }
  try {
    return decode(plain)
  } finally {
    plain.fill(0)
  }
}

// ---------------------------------------------------------------- the storage

interface TableState {
  tag: Promise<string>
  /** name -> sealed entry key */
  keys: Map<string, Promise<string>>
  /** The table's names, once read; changed when a request is issued. */
  list: Set<string> | null
  loading: Promise<Set<string>> | null
}

interface Open {
  keys: DataKeys
  dek: Uint8Array
  tables: Tables
}

export function createProfileStorage(opts: ProfileStorageOptions): ProfileStorage {
  const { backend, namespace } = opts
  const now = opts.now ?? (() => Date.now())
  const lockName = `ilchon-lock:${namespace}`

  /** Decrypted copy of the lock record: read for method, credId and prfSalt only, never written back. */
  let rec: LockRecord | null = null
  let open: Open | null = null
  /** The issue chain: each data request creates its backend transaction after the one called before it. */
  let issue: Promise<void> = Promise.resolve()
  /** Requests not yet settled, for create() to wait on what init wrote. */
  const pending = new Set<Promise<unknown>>()

  /**
   * Queues a data request: `prep` (sealing) starts at once; `send` runs in call order
   * and must create its backend transaction synchronously. Resolves with send's result.
   */
  function enqueue<P, T>(prep: Promise<P>, send: (p: P) => Promise<T>): Promise<T> {
    let sent!: Promise<T>
    const step = issue
      .then(() => prep)
      .then((p) => {
        sent = send(p)
      })
    issue = step.then(
      () => {},
      () => {},
    )
    const out = step.then(() => sent)
    pending.add(out)
    const forget = () => void pending.delete(out)
    out.then(forget, forget)
    return out
  }

  function backendCall<T>(p: Promise<T>): Promise<T> {
    return p.catch((e: unknown) => {
      throw backendError(e)
    })
  }

  function makeTables(keys: DataKeys): Tables {
    const states = new Map<string, TableState>()
    const live = () => {
      if (!open || open.keys !== keys) throw fail('not-allowed')
    }

    function state(table: string): TableState {
      if (typeof table !== 'string' || table === '' || table.includes('\u0000')) throw fail('not-allowed')
      let st = states.get(table)
      if (!st) {
        st = { tag: tableTag(keys, table), keys: new Map(), list: null, loading: null }
        states.set(table, st)
      }
      return st
    }

    function entryKey(table: string, st: TableState, name: string): Promise<string> {
      if (typeof name !== 'string') return Promise.reject(fail('not-allowed'))
      let k = st.keys.get(name)
      if (!k) {
        k = st.tag.then((tag) => sealName(keys, table, tag, name))
        st.keys.set(name, k)
        // A failed seal is not kept.
        k.catch(() => st.keys.delete(name))
      }
      return k
    }

    /** Applies a change to the name list now, or once the list being read is there. */
    function onList(st: TableState, fn: (list: Set<string>) => void): void {
      if (st.list) fn(st.list)
      else if (st.loading) st.loading.then(fn, () => {})
    }

    function table<T>(name: string): Table<T> {
      const st = state(name)
      return {
        getItem(key) {
          try {
            live()
          } catch (e) {
            return Promise.reject(e)
          }
          const k = entryKey(name, st, key)
          return enqueue(k, (ek) => backendCall(backend.get(ek)).then((v) => ({ ek, v }))).then(({ ek, v }) => (v === undefined ? null : (openValue(keys, ek, v) as Promise<T>)))
        },
        setItem(key, value) {
          let plain: Uint8Array
          try {
            live()
            // Encoded now: the value as it is at the call is what gets stored.
            plain = encode(value)
          } catch (e) {
            return Promise.reject(e)
          }
          const k = entryKey(name, st, key)
          const sealed = k.then((ek) => sealValue(keys, ek, plain).then((bytes) => ({ ek, bytes })))
          sealed.catch(() => plain.fill(0))
          return enqueue(sealed, ({ ek, bytes }) => {
            const done = backendCall(backend.put(ek, bytes))
            onList(st, (list) => list.add(key))
            return done
          }).then(() => value)
        },
        removeItem(key) {
          try {
            live()
          } catch (e) {
            return Promise.reject(e)
          }
          return enqueue(entryKey(name, st, key), (ek) => {
            const done = backendCall(backend.del(ek))
            onList(st, (list) => list.delete(key))
            return done
          })
        },
        clear() {
          try {
            live()
          } catch (e) {
            return Promise.reject(e)
          }
          return enqueue(st.tag, (tag) => {
            const done = backendCall(backend.delRange(`${tag}.`, `${tag}/`))
            st.list = new Set()
            st.loading = null
            return done
          })
        },
        keys() {
          try {
            live()
          } catch (e) {
            return Promise.reject(e)
          }
          return enqueue(st.tag, (tag) => {
            if (st.list) return Promise.resolve([...st.list].sort())
            if (!st.loading) {
              // '.' (46) is followed by '/' (47): exactly this table's keys.
              const loading: Promise<Set<string>> = backendCall(backend.keys(`${tag}.`, `${tag}/`))
                .then((ks) => Promise.all(ks.map(async (ek) => [await openName(keys, name, tag, ek), ek] as const)))
                .then((pairs) => {
                  const list = new Set<string>()
                  for (const [n, ek] of pairs) {
                    list.add(n)
                    if (!st.keys.has(n)) st.keys.set(n, Promise.resolve(ek))
                  }
                  if (st.loading === loading) {
                    st.list = list
                    st.loading = null
                  }
                  return list
                })
              loading.catch(() => {
                if (st.loading === loading) st.loading = null
              })
              st.loading = loading
            }
            return st.loading.then((list) => [...list].sort())
          })
        },
      }
    }

    const app = table<unknown>('app')
    const kv: KV = {
      async get<T>(key: string) {
        const v = await app.getItem(key)
        return v === null ? undefined : (v as T)
      },
      async set<T>(key: string, value: T) {
        await app.setItem(key, value)
      },
      del: (key) => app.removeItem(key),
      async keys(prefix = '') {
        return (await app.keys()).filter((k) => k.startsWith(prefix))
      },
    }
    return { kv, table }
  }

  async function openWith(dek: Uint8Array): Promise<Tables> {
    const keys = await dataKeys(dek)
    close()
    const tables = makeTables(keys)
    open = { keys, dek, tables }
    return tables
  }

  function close(): void {
    if (open) open.dek.fill(0)
    open = null
  }

  /** Waits until every request issued so far has settled; rejects with the first failure. */
  async function drain(): Promise<void> {
    await issue
    await Promise.all([...pending])
  }

  /** The lock record on disk, opened. Read failures are storage-unavailable, everything else storage-damaged. */
  async function readDisk(): Promise<{ device: CryptoKey; record: LockRecord }> {
    const e: LockEntries = await backendCall(backend.readLock())
    if (!e.record) throw fail('not-allowed')
    const record = await openRecord(e.device, e.record)
    return { device: e.device as CryptoKey, record }
  }

  async function writeRecord(device: CryptoKey, record: LockRecord): Promise<void> {
    const sealed = await sealRecord(device, record)
    await backendCall(backend.writeLock({ record: sealed }))
  }

  /**
   * Starts making a KEK for `choice`. Called before any await of create and relock,
   * so a passkey ceremony starts inside the user's tap. Throws 'weak-pin' and
   * 'not-allowed' at once.
   */
  function startKek(choice: LockChoice): Promise<Made> {
    switch (choice?.method) {
      case 'passkey':
        return createPasskeyKek(passkeyName(namespace)).then((r) => ({ method: 'passkey' as const, ...r }))
      case 'pin': {
        checkPin(choice.pin)
        const pinSalt = globalThis.crypto.getRandomValues(new Uint8Array(16))
        return pinKek(choice.pin, pinSalt, PIN_ITERATIONS).then((kek) => ({ method: 'pin' as const, kek, pinSalt, iter: PIN_ITERATIONS }))
      }
      case 'none':
        if (!opts.noLock) throw fail('not-allowed')
        return opts.noLock().then((noLock) => ({ method: 'none' as const, noLock }))
      default:
        throw fail('not-allowed')
    }
  }

  /** 7: count first, then try. The attempt counts even when the page dies during the KDF. */
  async function pinAttempt(pin: string): Promise<Uint8Array> {
    const counted = await withLock(lockName, async () => {
      const { device, record } = await readDisk()
      if (record.method !== 'pin') throw fail('not-allowed')
      // A clock before 1970 would make a record that no longer reads as one.
      const t = Math.max(0, now())
      // The clock went back: the wait starts again from now.
      if (record.lastFailAt > t) {
        record.lastFailAt = t
        await writeRecord(device, record)
      }
      rec = record
      if (record.failures >= FREE_FAILURES + 1 && t < record.lastFailAt + waitAfter(record.failures)) throw fail('pin-wait')
      record.failures += 1
      record.lastFailAt = t
      // A try that cannot be counted is not made.
      await writeRecord(device, record)
      rec = record
      return record
    })
    const kek = await pinKek(typeof pin === 'string' ? pin : '', b64d(counted.pinSalt), counted.iter ?? PIN_ITERATIONS)
    let dek: Uint8Array
    try {
      dek = await unwrapDek(kek, counted)
    } catch (e) {
      throw (e as Error).message === 'kek-mismatch' ? fail('wrong-pin') : e
    }
    try {
      await withLock(lockName, async () => {
        const { device, record } = await readDisk()
        record.failures = 0
        record.lastFailAt = 0
        await writeRecord(device, record)
        rec = record
      })
    } catch {
      // Unlocked anyway; the count stays until the next success.
    }
    return dek
  }

  /** passkey: the KEK comes first (the ceremony), then the record on disk opens the DEK. */
  async function passkeyDek(kekPromise: Promise<CryptoKey>): Promise<Uint8Array> {
    const kek = await kekPromise
    return withLock(lockName, async () => {
      const { record } = await readDisk()
      if (record.method !== 'passkey') throw fail('not-allowed')
      try {
        return await unwrapDek(kek, record)
      } catch (e) {
        throw (e as Error).message === 'kek-mismatch' ? fail('corrupt') : e
      }
    })
  }

  async function noneDek(): Promise<Uint8Array> {
    if (!opts.noLock) throw damaged()
    const m = await opts.noLock()
    return withLock(lockName, async () => {
      const { record } = await readDisk()
      return m.openNone(record)
    })
  }

  /** Before the first await: the passkey get() for this record. */
  function startPasskeyGet(r: LockRecord): Promise<CryptoKey> {
    let credId: Uint8Array
    let prfSalt: Uint8Array
    try {
      credId = b64d(r.credId)
      prfSalt = b64d(r.prfSalt)
    } catch (e) {
      return Promise.reject(e)
    }
    return passkeyKek(credId, prfSalt)
  }

  const storage: ProfileStorage = {
    async status() {
      const e: LockEntries = await backendCall(backend.readLock())
      if (!e.record) {
        rec = null
        return null
      }
      // Before opening the record: another format may mean another record shape.
      if (e.format === undefined || e.format !== opts.format) throw fail('storage-format')
      if (!e.device) throw damaged()
      const record = await openRecord(e.device, e.record)
      if (record.method === 'none' && !opts.noLock) throw damaged()
      rec = record
      return { method: record.method, waitUntil: record.failures > FREE_FAILURES ? record.lastFailAt + waitAfter(record.failures) : 0 }
    },

    async create(choice, init) {
      const making = startKek(choice)
      const made = await making
      return withLock(lockName, async () => {
        const e: LockEntries = await backendCall(backend.readLock())
        if (e.record) throw fail('identity-exists')
        // What an earlier create left before it could write its lock record.
        await backendCall(backend.clearData())
        const dek = globalThis.crypto.getRandomValues(new Uint8Array(DEK_BYTES))
        try {
          const tables = await openWith(dek)
          await init(tables)
          await drain()
          const record = await buildRecord(made, dek)
          const device = await subtle.generateKey({ name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt'])
          const sealed = await sealRecord(device, record)
          // The moment the identity exists: device key, record and format in one transaction.
          await backendCall(backend.writeLock({ device, record: sealed, format: opts.format }))
          rec = record
          return tables
        } catch (err) {
          close()
          dek.fill(0)
          throw err
        }
      })
    },

    async unlock(proof) {
      const r = rec
      if (!r || !proof || proof.method !== r.method) throw fail('not-allowed')
      let dek: Uint8Array
      if (proof.method === 'passkey') dek = await passkeyDek(startPasskeyGet(r))
      else if (proof.method === 'pin') dek = await pinAttempt(proof.pin)
      else dek = await noneDek()
      try {
        return await openWith(dek)
      } catch (e) {
        dek.fill(0)
        throw e
      }
    },

    async verify(proof) {
      const r = rec
      if (!open || !r || !proof || proof.method !== r.method) throw fail('not-allowed')
      let dek: Uint8Array
      if (proof.method === 'passkey') dek = await passkeyDek(startPasskeyGet(r))
      else if (proof.method === 'pin') dek = await pinAttempt(proof.pin)
      else dek = await noneDek()
      // Opening the inner wrap is the proof; the DEK is not compared.
      dek.fill(0)
    },

    async relock(choice) {
      if (!open) throw fail('not-allowed')
      const making = startKek(choice)
      const made = await making
      await withLock(lockName, async () => {
        if (!open) throw fail('not-allowed')
        const { device } = await readDisk()
        const record = await buildRecord(made, open.dek)
        // Same device key, same data, same format: only the record changes.
        await writeRecord(device, record)
        rec = record
      })
    },

    passkeySupported() {
      return passkeySupported()
    },

    async wipe() {
      close()
      rec = null
      try {
        await backend.destroy()
      } catch (e) {
        throw e instanceof Error && e.message === 'reset-failed' ? e : fail('reset-failed')
      }
    },
  }
  return storage
}
