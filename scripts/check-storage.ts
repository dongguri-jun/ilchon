/**
 * Encrypted storage (checks 1~27 on their own; 29, 31, 33~39 with the engine and the
 * source; 28, 30, 32, the relockMinutes of 31 and the auto-lock clock). Codec, hidden names, request order, tampering, error classes, PIN attempts
 * and waits, no plain text at rest. No network, no DOM. Run: pnpm check:storage
 *
 * Prints pass/fail and timings only: never a PIN, a key or a stored value.
 * PBKDF2 runs for real (600,000 rounds, a few hundred ms each), so one PIN profile is
 * made once and copied for each case.
 */
import { createCredential, createSimpleGroup, deserializeClientState, generateKeyPackage, serializeClientState, calculateKeyPackageRef } from '@internet-privacy/marmot-ts/core'
import { defaultCryptoProvider, getCiphersuiteImpl } from '@internet-privacy/marmot-ts/mls'
import { base64urlnopad } from '@scure/base'
import { PrivateKeySigner } from 'applesauce-signers'
import { memoryBackend, type MemoryBackend, type LockEntries } from '../src/lib/store/backend.ts'
import { decode, encode } from '../src/lib/store/codec.ts'
import { createProfileStorage, passkeyName, waitAfter, type LockRecord } from '../src/lib/store/index.ts'
import type { ProfileStorage, Tables } from '../src/lib/store/types.ts'
import { checkPin, PIN_ITERATIONS, pinKek } from '../src/lib/vault/index.ts'
import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join, relative } from 'node:path'
import type { ChatMessage, Contact, PayMethod } from '../src/contracts.ts'
import { createEngine, REAUTH_MS, STORE_FORMAT, type IlchonEngine } from '../src/engine/index.ts'
import { createRelockWatch, FOCUS_WAIT_MS, handsOffHref, TAP_GRACE_MS } from '../src/engine/relock.ts'
import { afterPaint, PAINT_WAIT_MS } from '../src/engine/privacy-cover.ts'
import { createOverlayNav, createSetupHistory, isSetupMark, isSheetMark, markOf, type HistoryPort } from '../src/screens/shell/overlay-history.ts'
import { clearRestoreMark, setRestoreMark, takeRestoreMark, type MarkLocation } from '../src/screens/lock/after-reset.ts'
import { initialSetup, lockSubmitKind, nextSetup, setupPop, type SetupEvent, type SetupFlow } from '../src/screens/lock/setup-flow.ts'
import * as connectModule from '../src/lib/connect/index.ts'
import { matchCrypto } from '../src/lib/match/index.ts'
import { createLnurl } from '../src/lib/lnurl/index.ts'

const BOTH: PayMethod[] = ['lightning', 'onchain']
import { generateSecretKeyHex, pubkeyOf } from '../src/lib/marmot/keys.ts'
import { newMnemonic, secretFromMnemonic } from '../src/lib/seed/index.ts'
import { getProfileNamespace } from '../src/lib/profile.ts'
import { createFakeClock, createFakeHub } from './fake-transport.ts'
import { plainTextIn } from './node-storage.ts'

let failed = 0
/** The names of the failed checks, printed again at the end so a rare failure is never lost in the output. */
const failedNames: string[] = []
function check(name: string, ok: boolean, detail = ''): void {
  if (!ok) {
    failed++
    failedNames.push(name)
  }
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${!ok && detail ? `\n  ${detail}` : ''}`)
}
/** Runs one group of cases; an uncaught throw counts as a failure and the next group still runs. */
async function section(n: number | string, fn: () => Promise<void>): Promise<void> {
  try {
    await fn()
  } catch (e) {
    failed++
    failedNames.push(`group ${n} threw`)
    console.log(`FAIL  group ${n} threw ${e instanceof Error ? e.message : String(e)}`)
  }
}
/** The error code a promise rejects with, or 'resolved'. */
async function codeOf(p: Promise<unknown> | (() => unknown)): Promise<string> {
  try {
    await (typeof p === 'function' ? p() : p)
    return 'resolved'
  } catch (e) {
    return e instanceof Error ? e.message : String(e)
  }
}
async function rejects(name: string, p: Promise<unknown> | (() => unknown), code: string): Promise<void> {
  const got = await codeOf(p)
  check(name, got === code, `expected ${code}, got ${got}`)
}
const elapsed = async <T>(fn: () => Promise<T>): Promise<[number, T | Error]> => {
  const t = performance.now()
  try {
    const v = await fn()
    return [performance.now() - t, v]
  } catch (e) {
    return [performance.now() - t, e as Error]
  }
}

/** Deep equality where an undefined property equals a missing one (the codec drops them). */
function same(a: unknown, b: unknown): boolean {
  if (a instanceof Uint8Array || b instanceof Uint8Array) {
    if (!(a instanceof Uint8Array) || !(b instanceof Uint8Array) || a.length !== b.length) return false
    return a.every((x, i) => x === b[i])
  }
  if (typeof a !== typeof b) return false
  if (typeof a !== 'object' || a === null || b === null) return a === b
  if (Array.isArray(a) !== Array.isArray(b)) return false
  if (Array.isArray(a)) return a.length === (b as unknown[]).length && a.every((x, i) => same(x, (b as unknown[])[i]))
  const ka = Object.keys(a)
    .filter((k) => (a as Record<string, unknown>)[k] !== undefined)
    .sort()
  const kb = Object.keys(b as object)
    .filter((k) => (b as Record<string, unknown>)[k] !== undefined)
    .sort()
  return same(ka, kb) && ka.every((k) => same((a as Record<string, unknown>)[k], (b as Record<string, unknown>)[k]))
}

const clock = { t: Date.UTC(2026, 10, 13, 12), now: () => clock.t }
const NS = 'ilchon:test'
const noLock = () => import('../src/lib/vault/no-lock.ts')
function storage(backend: MemoryBackend, o: { format?: number; noLock?: boolean; namespace?: string } = {}): ProfileStorage {
  return createProfileStorage({
    backend,
    namespace: o.namespace ?? NS,
    format: o.format ?? 1,
    noLock: o.noLock === false ? undefined : noLock,
    now: clock.now,
  })
}
const none = { method: 'none' } as const
/** A new instance (a reload): status() first, as the engine does, then unlock. */
async function openNone(b: MemoryBackend): Promise<Tables> {
  const s = storage(b)
  await s.status()
  return s.unlock(none)
}
const nothing = async () => {}

/** A new memory backend holding a copy of `src` (optionally changed). */
async function copyOf(src: MemoryBackend, change: { lock?: (l: LockEntries) => LockEntries; data?: (d: Map<string, Uint8Array>) => void } = {}): Promise<MemoryBackend> {
  const raw = src.raw()
  const lock = change.lock ? change.lock(raw.lock) : raw.lock
  change.data?.(raw.data)
  const out = memoryBackend()
  if (lock.device !== undefined || lock.record !== undefined || lock.format !== undefined) await out.writeLock(lock)
  for (const [k, v] of raw.data) await out.put(k, v)
  return out
}

/** Test view: the lock record as stored, opened with the device key. */
async function storedRecord(b: MemoryBackend): Promise<LockRecord> {
  const { lock } = b.raw()
  const plain = await crypto.subtle.decrypt(
    { name: 'AES-GCM', iv: lock.record!.iv as BufferSource, additionalData: new TextEncoder().encode('ilchon/lock/v2') },
    lock.device!,
    lock.record!.ct as BufferSource,
  )
  return JSON.parse(new TextDecoder().decode(plain)) as LockRecord
}

const flip = (b: Uint8Array, i = b.length >> 1) => {
  const c = b.slice()
  c[i] = c[i]! ^ 0x01
  return c
}

// ---------------------------------------------------------------- 1~3 codec

await section(1, async () => {
  const big = 2n ** 64n + 123n
  const buf = Buffer.from([1, 2, 3, 250])
  const value = {
    bytes: new Uint8Array([0, 255, 7]),
    nested: { deeper: [new Uint8Array([9, 9]), { b: new Uint8Array(0) }] },
    buf,
    neg: -42n,
    big,
    nil: null,
    empty: [],
    text: '일촌 ¥ 🎉 \u0000 "quoted"',
    num: -1.5,
    yes: true,
    gone: undefined,
    holes: [1, undefined, 3],
  }
  const back = decode(encode(value)) as Record<string, unknown>
  const want = { ...value, gone: undefined, holes: [1, null, 3] }
  check('1 codec: round trip of nested bytes, Buffer, bigint, null, [], unicode', same(back, want))
  check('1 codec: a property that is undefined is left out', !('gone' in back))
  check('1 codec: undefined in an array becomes null', same(back.holes, [1, null, 3]))
  check('1 codec: a Buffer reads back as a plain Uint8Array', back.buf instanceof Uint8Array && (back.buf as object).constructor === Uint8Array)
  check('1 codec: bigint above 2^64 and negative', back.big === big && back.neg === -42n)
  const raw = new Uint8Array([5, 6, 7])
  const enc = encode(raw)
  check('1 codec: a Uint8Array alone is tag 0x01 and its bytes', enc[0] === 0x01 && enc.length === 4 && same(decode(enc), raw))
  check('1 codec: a Buffer alone is tag 0x01', encode(Buffer.from([1]))[0] === 0x01)
  check('1 codec: JSON values are tag 0x02', encode({ a: 1 })[0] === 0x02 && encode('x')[0] === 0x02)
  const out = decode(enc) as Uint8Array
  out[0] = 99
  check('1 codec: decoded bytes are a copy', enc[1] === 5)
})
await section(2, async () => {
  const cases: [string, unknown][] = [
    ['Map', new Map([[1, 2]])],
    ['Set', new Set([1])],
    ['Date', new Date(0)],
    ['NaN', Number.NaN],
    ['Infinity', { x: Number.POSITIVE_INFINITY }],
    ['own $t', { $t: 'b', v: 'AQ' }],
    ['nested own $t', { ok: [{ $t: 'n', v: '1' }] }],
    ['nested Map', { a: { b: new Map() } }],
    ['Uint16Array', new Uint16Array([1])],
    [
      'class instance',
      new (class Foo {
        x = 1
      })(),
    ],
    ['function', { f: () => 1 }],
    ['toJSON trick', { toJSON: () => 'x' }],
    ['undefined', undefined],
  ]
  for (const [name, v] of cases) await rejects(`2 codec: ${name} is unserializable`, () => encode(v), 'unserializable')
})
await section(3, async () => {
  const json = (s: string) => new Uint8Array([0x02, ...new TextEncoder().encode(s)])
  const cases: [string, Uint8Array][] = [
    ['tag 0x03', new Uint8Array([0x03, 1, 2])],
    ['empty', new Uint8Array(0)],
    ['broken JSON', json('{"a":')],
    ['broken UTF-8', new Uint8Array([0x02, 0xff, 0xfe])],
    ['bad base64url in $t b', json('{"$t":"b","v":"!!"}')],
    ['bad decimal in $t n', json('{"$t":"n","v":"1e3"}')],
    ['unknown $t', json('{"$t":"x","v":"1"}')],
    ['$t with an extra field', json('{"$t":"b","v":"AQ","w":1}')],
  ]
  for (const [name, b] of cases) await rejects(`3 codec: ${name} is storage-damaged`, () => decode(b), 'storage-damaged')
})

// ---------------------------------------------------------------- 4~15 storage (memory backend + noLock)

const hexG = '7c1f5b9e04a3d2c88e6b1a0f3d4c5b6a7e8f90123456789abcdef0123456789a'
const hexE = 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855'
const ingestName = `${hexG}/ingest/wrapper/v1/${hexE}`

let base: MemoryBackend
await section(4, async () => {
  base = memoryBackend()
  const s = storage(base)
  check('4 storage: an empty backend has no status', (await s.status()) === null)
  let initTables: Tables | null = null
  const t = await s.create(none, async (tables) => {
    initTables = tables
    await tables.kv.set('identity', { v: 1, sk: 'not a real key' })
  })
  check('4 storage: create hands init the tables it returns', initTables === t)
  await t.kv.set('x', 'app-x')
  await t.table('groups').setItem('x', 'groups-x')
  await t.kv.set('obj', { a: [1, 2], b: new Uint8Array([1, 2, 3]) })
  await t.kv.set('gone', 1)
  await t.kv.del('gone')
  const g = t.table<string>('groups')
  await g.setItem('y', 'groups-y')
  check('4 storage: same name in two tables, two values', (await t.kv.get('x')) === 'app-x' && (await g.getItem('x')) === 'groups-x')
  check('4 storage: kv.get of a missing key is undefined', (await t.kv.get('gone')) === undefined && (await t.kv.get('never')) === undefined)
  check('4 storage: getItem of a missing key is null', (await g.getItem('never')) === null)
  check('4 storage: values come back', same(await t.kv.get('obj'), { a: [1, 2], b: new Uint8Array([1, 2, 3]) }))
  check('4 storage: kv.keys lists app only', same(await t.kv.keys(), ['identity', 'obj', 'x']), JSON.stringify(await t.kv.keys()))
  check('4 storage: kv.keys(prefix)', same(await t.kv.keys('o'), ['obj']))
  check('4 storage: table keys', same(await g.keys(), ['x', 'y']))
  await g.removeItem('y')
  check('4 storage: removeItem', (await g.getItem('y')) === null && same(await g.keys(), ['x']))
  const tmp = t.table<number>('tmp')
  await tmp.setItem('a', 1)
  await tmp.setItem('b', 2)
  await tmp.clear()
  check('4 storage: clear empties that table only', same(await tmp.keys(), []) && (await tmp.getItem('a')) === null && same(await g.keys(), ['x']))
  check('4 storage: setItem resolves with the value', (await g.setItem('z', 'zz')) === 'zz')
  await g.removeItem('z')
})
await section(5, async () => {
  const s = storage(base)
  const st = await s.status()
  check('5 storage: a new instance sees lock none', st?.method === 'none' && st.waitUntil === 0)
  await rejects('5 storage: unlock with another method is not-allowed', s.unlock({ method: 'pin', pin: '135790' }), 'not-allowed')
  const t = await s.unlock(none)
  check('5 storage: values survive a new instance', (await t.kv.get('x')) === 'app-x' && (await t.table('groups').getItem('x')) === 'groups-x')
  check('5 storage: keys() comes back from the sealed names', same(await t.kv.keys(), ['identity', 'obj', 'x']) && same(await t.table('groups').keys(), ['x']))
  check('5 storage: a table name never written has no keys', same(await t.table('nothing').keys(), []))
})

// 6: nothing readable at rest.
await section(6, async () => {
  const b = memoryBackend()
  const t = await storage(b).create(none, nothing)
  await t.kv.set('contacts', [{ name: 'MARKER-NAME-7781' }])
  await t.kv.set('rooms', { x: 'MARKER-CHAT 계좌 110-123-456789' })
  await t.table('ingest').setItem(ingestName, new TextEncoder().encode('MARKER-BYTES'))
  check('6 storage: the values are there', (await t.kv.get<{ name: string }[]>('contacts'))?.[0]?.name === 'MARKER-NAME-7781')
  const needles = ['MARKER-', '110-123', hexG, hexE, 'contacts', 'ingest', 'wrapper', 'rooms']
  const raw = b.raw()
  const latin1 = (u: Uint8Array) => Array.from(u, (x) => String.fromCharCode(x)).join('')
  const hay: string[] = [...raw.data.keys()]
  for (const v of raw.data.values()) hay.push(latin1(v), base64urlnopad.encode(v))
  if (raw.lock.record) hay.push(latin1(raw.lock.record.iv), latin1(raw.lock.record.ct), base64urlnopad.encode(raw.lock.record.ct))
  const forms = (n: string): string[] => {
    const bytes = new TextEncoder().encode(n)
    const out = [latin1(bytes)]
    // base64url at the three byte alignments, without the edge characters the neighbours change.
    for (let k = 0; k < 3; k++) {
      const enc = base64urlnopad.encode(new Uint8Array([...new Array<number>(k).fill(0), ...bytes]))
      out.push(enc.slice(k === 0 ? 0 : 2, -2))
    }
    return out
  }
  const found = needles.filter((n) => forms(n).some((f) => hay.some((h) => h.includes(f))))
  check('6 storage: no marker, account, hex id, or table name in any key or byte (UTF-8 and base64url)', found.length === 0, `found: ${found.join(', ')}`)
  const keys = [...raw.data.keys()]
  check('6 storage: entry keys are <12-char tag>.<base64url>', keys.length === 3 && keys.every((k) => /^[A-Za-z0-9_-]{12}\.[A-Za-z0-9_-]+$/.test(k)), keys.join(' '))
  check('6 storage: two tables, two tags', new Set(keys.map((k) => k.slice(0, 12))).size === 2)
})

// 7: real MLS values through the codec and the seal.
await section(7, async () => {
  const signer = new PrivateKeySigner(crypto.getRandomValues(new Uint8Array(32)))
  const pubkey = await signer.getPublicKey()
  const impl = await getCiphersuiteImpl('MLS_128_DHKEMX25519_AES128GCM_SHA256_Ed25519', defaultCryptoProvider)
  const kp = await generateKeyPackage({ credential: createCredential(pubkey), signer, ciphersuiteImpl: impl })
  const keyPackageRef = await calculateKeyPackageRef(kp.publicPackage, defaultCryptoProvider)
  const { clientState } = await createSimpleGroup(kp, impl, 'g', { relays: ['wss://a.example'] })
  const groupId = clientState.groupContext.groupId
  const groupState = serializeClientState(clientState)
  const published = await signer.signEvent({ kind: 443, created_at: 1_763_000_000, tags: [['encoding', 'base64']], content: 'kp' })
  const giftwrap = await signer.signEvent({ kind: 1059, created_at: 1_763_000_001, tags: [['p', pubkey]], content: 'sealed' })
  const local = {
    keyPackageRef,
    publicPackage: kp.publicPackage,
    privatePackage: kp.privatePackage,
    identifier: 'x',
    published: [published],
    publicationRelays: ['wss://a.example'],
    used: false,
    consumptionReceipts: [{ groupId, keyPackageRef }],
  }
  const invite = { type: 'received', giftwrap }
  const refKey = base64urlnopad.encode(keyPackageRef)
  const groupKey = Buffer.from(groupId).toString('hex')
  const b = memoryBackend()
  const t = await storage(b).create(none, nothing)
  let wrote = 'resolved'
  try {
    await t.table('keypackages').setItem(refKey, local)
    await t.table('groups').setItem(groupKey, groupState)
    await t.table('invites').setItem(giftwrap.id, invite)
  } catch (e) {
    wrote = (e as Error).message
  }
  check('7 MLS: key package, group state and invite entry can be stored', wrote === 'resolved', wrote)
  const t2 = await openNone(b)
  const kpBack = await t2.table('keypackages').getItem(refKey)
  const gBack = await t2.table<Uint8Array>('groups').getItem(groupKey)
  const iBack = await t2.table('invites').getItem(giftwrap.id)
  const hasBigint = (v: unknown): boolean => typeof v === 'bigint' || (typeof v === 'object' && v !== null && !(v instanceof Uint8Array) && Object.values(v).some(hasBigint))
  check('7 MLS: the key package has a bigint lifetime (the codec path is exercised)', hasBigint(local.publicPackage))
  check('7 MLS: key package deep-equal after a new instance (bigint, bytes, order)', same(kpBack, local))
  check('7 MLS: group state bytes equal', same(gBack, groupState))
  check('7 MLS: invite entry deep-equal', same(iBack, invite))
  let des = 'resolved'
  try {
    deserializeClientState(gBack!)
  } catch (e) {
    des = (e as Error).message
  }
  check('7 MLS: deserializeClientState takes the stored state', des === 'resolved', des)
})

// 8: requests reach the backend in call order.
await section(8, async () => {
  const b = memoryBackend()
  const s = storage(b)
  const t = await s.create(none, nothing)
  const big = crypto.getRandomValues(new Uint8Array(65_536))
  const huge = new Uint8Array(4 * 1024 * 1024)
  for (let i = 0; i < huge.length; i += 65_536) huge.set(big, i)
  const first = t.kv.set('k', huge)
  const second = t.kv.set('k', 'small')
  await Promise.all([first, second])
  check('8 order: a slow first write never lands after a later one', (await t.kv.get('k')) === 'small')
  const w = t.kv.set('j', 'v')
  const r = t.kv.get('j')
  await w
  check('8 order: a read right after a write (not awaited) sees it', (await r) === 'v')
  // A new instance whose name list is not loaded yet: keys() goes to the backend.
  const t2 = await openNone(b)
  const put = t2.table('t').setItem('a', huge)
  const listed = t2.table('t').keys()
  await put
  check('8 order: keys() right after setItem (not awaited) lists it', (await listed).includes('a'))
  const t3 = await openNone(b)
  const k1 = t3.table('t').keys()
  const put2 = t3.table('t').setItem('b', 1)
  const del = t3.table('t').removeItem('a')
  await Promise.all([k1, put2, del])
  check('8 order: changes called while the list loads end up in it', same(await t3.table('t').keys(), ['b']), JSON.stringify(await t3.table('t').keys()))
})

// 9: tampering.
await section(9, async () => {
  const b = memoryBackend()
  const t = await storage(b).create(none, nothing)
  await t.kv.set('a', 'value-a')
  await t.kv.set('b', 'value-b')
  await t.kv.set('c', { long: 'x'.repeat(200) })
  const raw = b.raw()
  const keyOf = async (name: string) => {
    // Find the stored key of `name` by changing one value and looking at what moved.
    const before = new Map(b.raw().data)
    await t.kv.set(name, `marker-${name}`)
    const after = b.raw().data
    return [...after.keys()].find((k) => !same(after.get(k), before.get(k)))!
  }
  const ka = await keyOf('a')
  const kb = await keyOf('b')
  const kc = await keyOf('c')
  await t.kv.set('a', 'value-a')
  await t.kv.set('b', 'value-b')
  await t.kv.set('c', { long: 'x'.repeat(200) })
  void raw
  const swapped = await copyOf(b, {
    data: (d) => {
      const va = d.get(ka)!
      d.set(ka, d.get(kb)!)
      d.set(kb, va)
    },
  })
  const ts = await openNone(swapped)
  await rejects('9 tamper: a value moved to another entry (a)', ts.kv.get('a'), 'storage-damaged')
  await rejects('9 tamper: a value moved to another entry (b)', ts.kv.get('b'), 'storage-damaged')
  const flipped = await copyOf(b, { data: (d) => d.set(kc, flip(d.get(kc)!)) })
  await rejects('9 tamper: one value byte flipped', (await openNone(flipped)).kv.get('c'), 'storage-damaged')
  const flippedIv = await copyOf(b, { data: (d) => d.set(kc, flip(d.get(kc)!, 0)) })
  await rejects('9 tamper: one nonce byte flipped', (await openNone(flippedIv)).kv.get('c'), 'storage-damaged')
  const cut = await copyOf(b, { data: (d) => d.set(kc, d.get(kc)!.slice(0, -1)) })
  await rejects('9 tamper: a value cut by one byte', (await openNone(cut)).kv.get('c'), 'storage-damaged')
  const short = await copyOf(b, { data: (d) => d.set(kc, d.get(kc)!.slice(0, 20)) })
  await rejects('9 tamper: a value cut shorter than nonce and tag', (await openNone(short)).kv.get('c'), 'storage-damaged')
  // The same name in another profile seals to another key: put that profile's value here.
  const other = memoryBackend()
  const to = await storage(other).create(none, nothing)
  await to.kv.set('c', { long: 'x'.repeat(200) })
  const otherValue = [...other.raw().data.values()][0]!
  const foreign = await copyOf(b, { data: (d) => d.set(kc, otherValue) })
  await rejects('9 tamper: a value sealed under another data key', (await openNone(foreign)).kv.get('c'), 'storage-damaged')
  const badName = await copyOf(b, {
    data: (d) => {
      const v = d.get(ka)!
      d.delete(ka)
      const tail = ka.slice(13)
      const c = tail[5] === 'A' ? 'B' : 'A'
      d.set(`${ka.slice(0, 13)}${tail.slice(0, 5)}${c}${tail.slice(6)}`, v)
    },
  })
  await rejects('9 tamper: a sealed entry name changed (keys)', (await openNone(badName)).kv.keys(), 'storage-damaged')

  const recFlip = await copyOf(b, { lock: (l) => ({ ...l, record: { iv: l.record!.iv, ct: flip(l.record!.ct) } }) })
  await rejects('9 tamper: one lock record byte flipped', storage(recFlip).status(), 'storage-damaged')
  const recIv = await copyOf(b, { lock: (l) => ({ ...l, record: { iv: flip(l.record!.iv, 0), ct: l.record!.ct } }) })
  await rejects('9 tamper: lock record nonce flipped', storage(recIv).status(), 'storage-damaged')
  const recCut = await copyOf(b, { lock: (l) => ({ ...l, record: { iv: l.record!.iv, ct: l.record!.ct.slice(0, -1) } }) })
  await rejects('9 tamper: lock record cut by one byte', storage(recCut).status(), 'storage-damaged')
  const recShortIv = await copyOf(b, { lock: (l) => ({ ...l, record: { iv: l.record!.iv.slice(0, 8), ct: l.record!.ct } }) })
  await rejects('9 tamper: lock record with a short nonce', storage(recShortIv).status(), 'storage-damaged')
  const noDevice = await copyOf(b, { lock: (l) => ({ record: l.record, format: l.format }) })
  await rejects('9 tamper: device key removed', storage(noDevice).status(), 'storage-damaged')
  const otherDevice = await copyOf(b, { lock: (l) => ({ ...l, device: other.raw().lock.device }) })
  await rejects('9 tamper: lock record under another device key', storage(otherDevice).status(), 'storage-damaged')
  const otherRecord = await copyOf(b, { lock: (l) => ({ ...l, record: other.raw().lock.record }) })
  await rejects('9 tamper: another profile record with this device key', storage(otherRecord).status(), 'storage-damaged')
  // A record sealed with this device key but not a lock record.
  const device = b.raw().lock.device!
  const sealJson = async (s: string) => {
    const iv = crypto.getRandomValues(new Uint8Array(12))
    const ct = new Uint8Array(await crypto.subtle.encrypt({ name: 'AES-GCM', iv, additionalData: new TextEncoder().encode('ilchon/lock/v2') }, device, new TextEncoder().encode(s)))
    return { iv, ct }
  }
  const good = await storedRecord(b)
  for (const [name, json] of [
    ['v 3', JSON.stringify({ ...good, v: 3 })],
    ['unknown method', JSON.stringify({ ...good, method: 'password' })],
    ['negative failures', JSON.stringify({ ...good, failures: -1 })],
    ['not JSON', '{"v":2,'],
  ] as const) {
    const bad = await copyOf(b, { lock: (l) => l })
    await bad.writeLock({ record: await sealJson(json) })
    await rejects(`9 tamper: a sealed record that does not fit (${name})`, storage(bad).status(), 'storage-damaged')
  }
  // Another profile's lock (its own device key and DEK) opens, but finds nothing of this data:
  // its table tags differ, and sealed names or values do not open under its keys.
  const swappedLock = await copyOf(b, { lock: () => other.raw().lock })
  const tsw = await openNone(swappedLock)
  const readA = await tsw.kv.get('a')
  const listed = await tsw.kv.keys()
  check('9 tamper: another profile lock (other DEK) reads none of this data', readA === undefined && same(listed, []), `${String(readA)} ${JSON.stringify(listed)}`)
})

// 10: error classes.
await section(10, async () => {
  const b = memoryBackend()
  const s = storage(b)
  const t = await s.create(none, nothing)
  await t.kv.set('k', 'v')
  b.failNext('readLock')
  await rejects('10 errors: readLock fails -> status storage-unavailable', s.status(), 'storage-unavailable')
  b.failNext('get')
  await rejects('10 errors: get fails -> storage-unavailable, not damaged', t.kv.get('k'), 'storage-unavailable')
  b.failNext('put')
  await rejects('10 errors: put fails -> storage-unavailable', t.kv.set('k', 'w'), 'storage-unavailable')
  check('10 errors: after the failures the store still works', (await t.kv.get('k')) === 'v')
})

// 11: format.
await section(11, async () => {
  const b = memoryBackend()
  await storage(b, { format: 1 }).create(none, nothing)
  await rejects('11 format: another STORE_FORMAT -> storage-format', storage(b, { format: 2 }).status(), 'storage-format')
  const broken = await copyOf(b, { lock: (l) => ({ ...l, record: { iv: l.record!.iv, ct: flip(l.record!.ct) } }) })
  await rejects('11 format: storage-format comes before a broken record', storage(broken, { format: 2 }).status(), 'storage-format')
  const noFormat = await copyOf(b, { lock: (l) => ({ device: l.device, record: l.record }) })
  await rejects('11 format: no stored format -> storage-format', storage(noFormat, { format: 1 }).status(), 'storage-format')
})

// 12: no noLock (the shipped build).
await section(12, async () => {
  await rejects('12 shipped: create none without noLock -> not-allowed', storage(memoryBackend(), { noLock: false }).create(none, nothing), 'not-allowed')
  await rejects('12 shipped: a none record without noLock -> storage-damaged', storage(base, { noLock: false }).status(), 'storage-damaged')
  const s = storage(base, { noLock: false })
  await rejects('12 shipped: unlock none without noLock (no status read) -> not-allowed', s.unlock(none), 'not-allowed')
})

// 13: create on an existing profile, and leftovers of a broken create.
await section(13, async () => {
  await rejects('13 create: an existing profile -> identity-exists', storage(base).create(none, nothing), 'identity-exists')
  const leftover = await copyOf(base, { lock: () => ({}) })
  const oldKeys = [...leftover.raw().data.keys()]
  check('13 create: the copy holds data without a lock record', oldKeys.length > 0 && leftover.raw().lock.record === undefined)
  const s = storage(leftover)
  check('13 create: data without a record counts as empty', (await s.status()) === null)
  const t = await s.create(none, async (tables) => tables.kv.set('fresh', 1))
  const now = [...leftover.raw().data.keys()]
  check('13 create: the old entries are gone', oldKeys.every((k) => !now.includes(k)) && same(await t.kv.keys(), ['fresh']))
})

// 14: two creates at once. `how` names the cross-tab lock in use (also run without navigator.locks below).
async function concurrentCreate(how = ''): Promise<void> {
  const b = memoryBackend()
  const s1 = storage(b)
  const s2 = storage(b)
  const ran: string[] = []
  const init = (who: string) => async (t: Tables) => {
    ran.push(who)
    await t.kv.set('who', who)
    await t.kv.set(`only-${who}`, who)
  }
  const [r1, r2] = await Promise.allSettled([s1.create(none, init('one')), s2.create(none, init('two'))])
  const won = r1.status === 'fulfilled' ? 'one' : r2.status === 'fulfilled' ? 'two' : ''
  const lost = r1.status === 'rejected' ? r1 : r2.status === 'rejected' ? r2 : null
  check(`14 concurrent create${how}: one wins, one gets identity-exists`, won !== '' && (lost?.reason as Error)?.message === 'identity-exists')
  check(`14 concurrent create${how}: the loser never ran its init`, ran.length === 1 && ran[0] === won, ran.join(','))
  const t = await openNone(b)
  check(`14 concurrent create${how}: only the winner is stored`, (await t.kv.get('who')) === won && same(await t.kv.keys(), ['only-' + won, 'who']))
}
await section(14, () => concurrentCreate())

// 15: wipe.
await section(15, async () => {
  const b = await copyOf(base)
  const s = storage(b)
  await s.status()
  await s.wipe()
  const raw = b.raw()
  check('15 wipe: the backend is empty', raw.data.size === 0 && raw.lock.record === undefined && raw.lock.device === undefined && raw.lock.format === undefined)
  check('15 wipe: status is null', (await s.status()) === null)
  await rejects('15 wipe: unlock after wipe -> not-allowed', s.unlock(none), 'not-allowed')
})

// ---------------------------------------------------------------- 16~27 PIN

await section(16, async () => {
  for (const pin of ['111111', '000000', '123456', '987654', '012345', '543210', '12345', '1234567', '12a456', '１２３４５６', ' 13579', '']) {
    await rejects(`16 checkPin: ${JSON.stringify(pin)} is weak-pin`, () => checkPin(pin), 'weak-pin')
  }
  let weak = 0
  for (let i = 0; i < 1_000_000; i++) {
    try {
      checkPin(String(i).padStart(6, '0'))
    } catch {
      weak++
    }
  }
  check('16 checkPin: 135790 and 000123 pass', (await codeOf(() => checkPin('135790'))) === 'resolved' && (await codeOf(() => checkPin('000123'))) === 'resolved')
  check('16 checkPin: 20 weak PINs in all (10 same digit, 5 up, 5 down)', weak === 20, String(weak))
  check('16 PBKDF2 rounds are 600,000', PIN_ITERATIONS === 600_000)
  check('16 waits: 0 to 4 free, then 30 s, 1, 5, 15, 60 min', [4, 5, 6, 7, 8, 9, 20].map(waitAfter).join() === [0, 30_000, 60_000, 300_000, 900_000, 3_600_000, 3_600_000].join())
  check('16 passkey names hold no key', passkeyName('ilchon:default') === 'ilchon' && passkeyName('ilchon:a') === 'ilchon a')
})

/**
 * "No KDF ran": the bound is 50 ms (PBKDF2 600,000 rounds takes hundreds of ms
 * on a phone). Node's native PBKDF2 can be close to 50 ms on a fast machine, so the
 * bound is also at most half of one KDF measured here.
 */
const kdfMs = await (async () => {
  const t = performance.now()
  await pinKek('135790', new Uint8Array(16), PIN_ITERATIONS)
  return performance.now() - t
})()
const NO_KDF_MS = Math.min(50, kdfMs / 2)
console.log(`      one PBKDF2 (600,000 rounds): ${Math.round(kdfMs)} ms; "no KDF" bound ${Math.round(NO_KDF_MS)} ms`)

const PIN = '135790'
const WRONG = '000001'
const pin = (p: string) => ({ method: 'pin', pin: p }) as const
const failures = async (b: MemoryBackend) => (await storedRecord(b)).failures

let pinBase: MemoryBackend
await section(17, async () => {
  pinBase = memoryBackend()
  const t0 = performance.now()
  const s = storage(pinBase)
  await rejects('17 PIN: a weak PIN is refused at create', s.create(pin('123456'), nothing), 'weak-pin')
  const t = await s.create(pin(PIN), async (tables) => tables.kv.set('identity', { v: 1, sk: 'pin profile' }))
  console.log(`      create with a PIN: ${Math.round(performance.now() - t0)} ms`)
  await t.kv.set('secret', 'MARKER-PIN')
  const rec = await storedRecord(pinBase)
  check('17 PIN: the record keeps salt and rounds, failures 0', rec.method === 'pin' && rec.iter === 600_000 && base64urlnopad.decode(rec.pinSalt!).length === 16 && rec.failures === 0)
  check('17 PIN: the stored DEK is wrapped (48 bytes ciphertext)', base64urlnopad.decode(rec.dek).length === 48 && base64urlnopad.decode(rec.dekIv!).length === 12)
  check('17 PIN: create keeps the store unlocked', (await t.kv.get('secret')) === 'MARKER-PIN')
})

await section('17, 18, 22', async () => {
  const b = await copyOf(pinBase)
  const s = storage(b)
  const st = await s.status()
  check('17 PIN: status of a PIN profile', st?.method === 'pin' && st.waitUntil === 0)
  await rejects('17 PIN: a wrong PIN -> wrong-pin', s.unlock(pin(WRONG)), 'wrong-pin')
  check('17 PIN: one miss, no wait', (await s.status())?.waitUntil === 0 && (await failures(b)) === 1)
  for (let i = 0; i < 4; i++) await s.unlock(pin(WRONG)).catch(() => {})
  const after5 = await s.status()
  check('17 PIN: five misses -> wait 30 s', after5?.waitUntil === clock.t + 30_000 && (await failures(b)) === 5, JSON.stringify(after5))
  const [ms, res] = await elapsed(() => s.unlock(pin(PIN)))
  check('17 PIN: right PIN during the wait -> pin-wait', res instanceof Error && res.message === 'pin-wait', String(res))
  check('17 PIN: pin-wait runs no KDF (< bound) and counts nothing', ms < NO_KDF_MS && (await failures(b)) === 5, `${Math.round(ms)} ms`)
  const s5 = await copyOf(b)

  clock.t += 30_000
  await rejects('18 PIN: after 30 s a wrong PIN -> wrong-pin', s.unlock(pin(WRONG)), 'wrong-pin')
  const after6 = await s.status()
  check('18 PIN: six misses -> wait 60 s', (await failures(b)) === 6 && after6?.waitUntil === clock.t + 60_000, JSON.stringify(after6))
  await rejects(
    '18 PIN: 59 s later still pin-wait',
    (async () => {
      clock.t += 59_000
      return s.unlock(pin(PIN))
    })(),
    'pin-wait',
  )
  clock.t += 1_000
  const t = await s.unlock(pin(PIN))
  check('18 PIN: the right PIN after the wait opens, failures 0', (await t.kv.get('secret')) === 'MARKER-PIN' && (await failures(b)) === 0)
  check('18 PIN: status after success has no wait', (await s.status())?.waitUntil === 0)

  // 22: the clock moved back past the last miss.
  const back = storage(s5)
  const lastFail = (await storedRecord(s5)).lastFailAt
  clock.t = lastFail - 10 * 60_000
  await back.status()
  await rejects('22 PIN: clock behind the last miss -> pin-wait', back.unlock(pin(PIN)), 'pin-wait')
  const pulled = await storedRecord(s5)
  check('22 PIN: lastFailAt pulled to now, failures unchanged', pulled.lastFailAt === clock.t && pulled.failures === 5)
  check('22 PIN: the wait starts again from now', (await back.status())?.waitUntil === clock.t + 30_000)
  clock.t += 30_000
  const t22 = await back.unlock(pin(PIN))
  check('22 PIN: 30 s after the pulled time the right PIN opens', (await t22.kv.get('secret')) === 'MARKER-PIN')
})

// 19: misses survive a reload.
await section(19, async () => {
  const b = await copyOf(pinBase)
  const s = storage(b)
  await s.status()
  for (let i = 0; i < 3; i++) await s.unlock(pin(WRONG)).catch(() => {})
  const fresh = storage(b)
  await fresh.status()
  check('19 PIN: three misses are there for a new instance', (await failures(b)) === 3)
  await rejects('19 PIN: the new instance counts on from 3', fresh.unlock(pin(WRONG)), 'wrong-pin')
  check('19 PIN: four after one more', (await failures(b)) === 4)
})

// 20: the count is written before the try.
await section(20, async () => {
  const b = await copyOf(pinBase)
  // Which failure count each lock write carries, in order (opened with the device key).
  const written: number[] = []
  const device = b.raw().lock.device!
  const writeLock = b.writeLock
  b.writeLock = async (e) => {
    if (e.record) {
      const plain = await crypto.subtle.decrypt({ name: 'AES-GCM', iv: e.record.iv as BufferSource, additionalData: new TextEncoder().encode('ilchon/lock/v2') }, device, e.record.ct as BufferSource)
      written.push((JSON.parse(new TextDecoder().decode(plain)) as LockRecord).failures)
    }
    return writeLock(e)
  }
  const s = storage(b)
  await s.status()
  let release!: () => void
  let held = 0
  b.onWrite = (kind) => {
    if (kind !== 'lock' || held++ > 0) return
    return new Promise<void>((r) => (release = r))
  }
  let settled = false
  const p = s.unlock(pin(PIN)).then(
    (t) => {
      settled = true
      return t
    },
    (e: Error) => {
      settled = true
      throw e
    },
  )
  await new Promise((r) => setTimeout(r, 2_000))
  check('20 PIN: with the count write held, the right PIN does not open (2 s)', !settled && held === 1)
  check('20 PIN: the held write is the count (failures 1), before any other', same(written, [1]), JSON.stringify(written))
  release()
  const t = await p
  b.onWrite = undefined
  check('20 PIN: once the count is written it opens, failures 0', (await t.kv.get('secret')) === 'MARKER-PIN' && (await failures(b)) === 0)
  check('20 PIN: writes were count then reset', same(written, [1, 0]), JSON.stringify(written))
})

// 21: an old copy in memory is never written back.
await section(21, async () => {
  const b = await copyOf(pinBase)
  const x = storage(b)
  await x.status()
  await x.unlock(pin(PIN))
  const y = storage(b)
  await y.status()
  for (let i = 0; i < 3; i++) await y.unlock(pin(WRONG)).catch(() => {})
  await rejects('21 PIN: verify on the unlocked instance with a wrong PIN', x.verify(pin(WRONG)), 'wrong-pin')
  check('21 PIN: four misses (not 1 from the old copy)', (await failures(b)) === 4, String(await failures(b)))
})

// 23: two instances miss at once (also run without navigator.locks below).
async function concurrentMiss(how = ''): Promise<void> {
  const b = await copyOf(pinBase)
  const s1 = storage(b)
  const s2 = storage(b)
  await s1.status()
  await s2.status()
  const r = await Promise.allSettled([s1.unlock(pin(WRONG)), s2.unlock(pin('000002'))])
  check(
    `23 PIN${how}: both wrong-pin`,
    r.every((x) => x.status === 'rejected' && (x.reason as Error).message === 'wrong-pin'),
  )
  check(`23 PIN${how}: both counted`, (await failures(b)) === 2)
}
await section(23, () => concurrentMiss())

// 24: verify counts.
await section(24, async () => {
  const b = await copyOf(pinBase)
  const s = storage(b)
  await s.status()
  await rejects('24 PIN: verify while locked -> not-allowed', s.verify(pin(PIN)), 'not-allowed')
  await s.unlock(pin(PIN))
  await rejects('24 PIN: verify with a wrong PIN -> wrong-pin', s.verify(pin(WRONG)), 'wrong-pin')
  check('24 PIN: that verify counted', (await failures(b)) === 1)
  const ok = await codeOf(s.verify(pin(PIN)))
  check('24 PIN: the right verify passes and sets 0', ok === 'resolved' && (await failures(b)) === 0, ok)
  await rejects('24 PIN: verify with another method -> not-allowed', s.verify(none), 'not-allowed')
})

// 25: a count that cannot be written is no try.
await section(25, async () => {
  const b = await copyOf(pinBase)
  const s = storage(b)
  await s.status()
  b.failNext('writeLock')
  const [ms, res] = await elapsed(() => s.unlock(pin(PIN)))
  check('25 PIN: the count write fails -> storage-unavailable', res instanceof Error && res.message === 'storage-unavailable', String(res))
  check('25 PIN: no KDF ran (< bound), nothing counted', ms < NO_KDF_MS && (await failures(b)) === 0, `${Math.round(ms)} ms`)
})

// 26: relock keeps the data as it is.
await section(26, async () => {
  const b = await copyOf(pinBase)
  const s = storage(b)
  await s.status()
  await rejects('26 relock: while locked -> not-allowed', s.relock(pin('246813')), 'not-allowed')
  await s.unlock(pin(PIN))
  const before = b.raw()
  await rejects('26 relock: to a weak PIN -> weak-pin', s.relock(pin('222222')), 'weak-pin')
  await s.relock(pin('246813'))
  const after = b.raw()
  const sameData = before.data.size === after.data.size && [...before.data].every(([k, v]) => same(after.data.get(k), v))
  check('26 relock: every data key and byte unchanged, same format and device key', sameData && after.lock.format === before.lock.format && after.lock.device === before.lock.device)
  check('26 relock: the record changed, failures 0', !same(after.lock.record!.ct, before.lock.record!.ct) && (await failures(b)) === 0)
  const fresh = storage(b)
  await fresh.status()
  await rejects('26 relock: the old PIN -> wrong-pin', fresh.unlock(pin(PIN)), 'wrong-pin')
  const t = await fresh.unlock(pin('246813'))
  check('26 relock: the new PIN opens the same data', (await t.kv.get('secret')) === 'MARKER-PIN')
})

// 27: timings (printed, not asserted).
await section(27, async () => {
  const b = await copyOf(pinBase)
  const s = storage(b)
  await s.status()
  const t0 = performance.now()
  const t = await s.unlock(pin(PIN))
  const unlockMs = performance.now() - t0
  const v64 = crypto.getRandomValues(new Uint8Array(65_536))
  const t1 = performance.now()
  await t.kv.set('big', v64)
  const setMs = performance.now() - t1
  const tbl = t.table<number>('ingest')
  await Promise.all(Array.from({ length: 5_000 }, (_, i) => tbl.setItem(`${hexG}/ingest/wrapper/v1/${i}`, i)))
  const s2 = storage(b)
  await s2.status()
  const t2 = await s2.unlock(pin(PIN))
  const t3 = performance.now()
  const ks = await t2.table('ingest').keys()
  const keysMs = performance.now() - t3
  check('27 timings: 5,000 names listed back', ks.length === 5_000)
  console.log(`      PIN unlock ${Math.round(unlockMs)} ms, kv.set 64 KB ${setMs.toFixed(1)} ms, keys() of 5,000 ${Math.round(keysMs)} ms`)
})

// ---------------------------------------------------------------- fresh nonces and salts
//
// AES-GCM with a repeated nonce under one key gives away the XOR of the plain texts and
// the authentication key. Every random nonce and salt must be new on each use; only the
// entry-name nonce is derived (HMAC), and it must differ between tables.

const hex = (b: Uint8Array) => Buffer.from(b).toString('hex')
/** The value nonce of a stored data entry: its first 12 bytes. */
const valueIv = (b: MemoryBackend, key: string) => hex(b.raw().data.get(key)!.subarray(0, 12))
/** The name nonce inside an entry key `<tag>.<base64url(iv ‖ ct)>`. */
const nameIv = (key: string) => hex(base64urlnopad.decode(key.slice(13)).subarray(0, 12))
/** The entry key a write added or changed: run `fn`, return the keys whose bytes changed. */
async function written(b: MemoryBackend, fn: () => Promise<unknown>): Promise<string[]> {
  const before = new Map([...b.raw().data].map(([k, v]) => [k, hex(v)]))
  await fn()
  return [...b.raw().data].filter(([k, v]) => before.get(k) !== hex(v)).map(([k]) => k)
}

await section('nonce', async () => {
  const b = memoryBackend()
  const t = await storage(b).create(none, nothing)
  const [k1] = await written(b, () => t.kv.set('same', 'value'))
  const iv1 = valueIv(b, k1!)
  // Read by the entry key of the first write: a repeated nonce would leave the bytes unchanged.
  await t.kv.set('same', 'value')
  check('nonce: the same value written twice to the same entry has two value nonces', iv1 !== valueIv(b, k1!), `${iv1} ${valueIv(b, k1!)}`)
  const [kOther] = await written(b, () => t.kv.set('other', 'value'))
  check('nonce: two entries have different value nonces', valueIv(b, kOther!) !== valueIv(b, k1!))
  const [kMany] = await written(b, () => t.kv.set('many', -1))
  const ivs = new Set<string>([valueIv(b, kMany!)])
  for (let i = 0; i < 99; i++) {
    await t.kv.set('many', i)
    ivs.add(valueIv(b, kMany!))
  }
  check('nonce: 100 writes, 100 different value nonces', ivs.size === 100, String(ivs.size))
  // Name nonces are HMAC-derived: the same name in another table seals with another nonce.
  const [inApp] = await written(b, () => t.kv.set('shared-name', 1))
  const [inGroups] = await written(b, () => t.table('groups').setItem('shared-name', 1))
  check('nonce: the same name in two tables has two name nonces', nameIv(inApp!) !== nameIv(inGroups!))
  const [again] = await written(b, () => t.kv.set('shared-name', 2))
  check('nonce: the same name in one table keeps its entry key (lookups need that)', again === inApp)

  // Two locks made the same way: new PIN salt, new DEK wrap nonce, new record nonce.
  const b1 = memoryBackend()
  const b2 = memoryBackend()
  await storage(b1).create(pin(PIN), nothing)
  await storage(b2).create(pin(PIN), nothing)
  const r1 = await storedRecord(b1)
  const r2 = await storedRecord(b2)
  check('nonce: two PIN locks have two PIN salts', r1.pinSalt !== r2.pinSalt)
  check('nonce: two PIN locks have two DEK wrap nonces', r1.dekIv !== r2.dekIv)
  check('nonce: two sealed lock records have two nonces', hex(b1.raw().lock.record!.iv) !== hex(b2.raw().lock.record!.iv))
  // One lock record written again (a miss) is sealed with a new nonce.
  const s = storage(b1)
  await s.status()
  const before = hex(b1.raw().lock.record!.iv)
  await s.unlock(pin(WRONG)).catch(() => {})
  check('nonce: a lock record written again has a new nonce', hex(b1.raw().lock.record!.iv) !== before)
  // relock wraps the same DEK again: a new wrap nonce under the new KEK.
  const s1 = storage(b1)
  await s1.status()
  await s1.unlock(pin(PIN))
  await s1.relock(pin('246813'))
  const r1b = await storedRecord(b1)
  check('nonce: relock makes a new PIN salt and DEK wrap nonce', r1b.pinSalt !== r1.pinSalt && r1b.dekIv !== r1.dekIv)
})

// ---------------------------------------------------------------- 14 and 23 without navigator.locks
//
// Node 24 has navigator.locks, so the fallback chain in withLock (a promise chain per
// name) never ran. Hide navigator.locks for these two and run them again.
await section('14, 23 without navigator.locks', async () => {
  Object.defineProperty(navigator, 'locks', { value: undefined, configurable: true })
  try {
    check('fallback: navigator.locks is hidden', (navigator as { locks?: unknown }).locks === undefined)
    await concurrentCreate(' (no navigator.locks)')
    await concurrentMiss(' (no navigator.locks)')
  } finally {
    delete (navigator as { locks?: unknown }).locks
  }
  check('fallback: navigator.locks is back', typeof (navigator as { locks?: { request?: unknown } }).locks?.request === 'function')
})

// ---------------------------------------------------------------- 29 source: one way to the lock-free module

const ROOT = join(import.meta.dirname, '..')
function walk(dir: string): string[] {
  return readdirSync(dir).flatMap((n) => {
    const p = join(dir, n)
    return statSync(p).isDirectory() ? walk(p) : /\.(ts|tsx)$/.test(n) ? [p] : []
  })
}
await section(29, async () => {
  const uses: string[] = []
  for (const f of walk(join(ROOT, 'src'))) {
    const lines = readFileSync(f, 'utf8').split('\n')
    lines.forEach((line, i) => {
      if (!line.includes('no-lock')) return
      const code = line.trim()
      // Comments and type positions (erased by the build) do not load the module.
      if (code.startsWith('*') || code.startsWith('//') || code.startsWith('/*')) return
      if (/typeof import\(['"][./a-z-]*no-lock['"]\)/.test(code) || code.startsWith('import type')) return
      // Only a static or dynamic import loads it.
      if (!/import\(['"][^'"]*no-lock['"]\)|from\s+['"][^'"]*no-lock['"]/.test(code)) return
      uses.push(`${relative(ROOT, f)}:${i + 1}: ${code}`)
    })
  }
  const ok = uses.length === 1 && uses[0]!.startsWith('src/engine/browser.ts:') && /noLock: import\.meta\.env\.DEV \? \(\) => import\('\.\.\/lib\/vault\/no-lock'\) : undefined/.test(uses[0]!)
  check('29 source: only src/engine/browser.ts loads no-lock, under import.meta.env.DEV', ok, uses.join('\n  '))
})

/** Code lines (not comments) of src/ and public/ that match `re`, as file:line: text. */
function codeLines(re: RegExp, dirs: string[], ext = /\.(ts|tsx|js)$/): string[] {
  const out: string[] = []
  const all = (dir: string): string[] =>
    readdirSync(dir).flatMap((n) => {
      const p = join(dir, n)
      return statSync(p).isDirectory() ? all(p) : ext.test(n) ? [p] : []
    })
  for (const d of dirs) {
    for (const f of all(join(ROOT, d))) {
      readFileSync(f, 'utf8')
        .split('\n')
        .forEach((line, i) => {
          const code = line.trim()
          if (code.startsWith('*') || code.startsWith('//') || code.startsWith('/*')) return
          if (re.test(code.replace(/\/\/.*$/, ''))) out.push(`${relative(ROOT, f)}:${i + 1}: ${code}`)
        })
    }
  }
  return out
}

// 28: nothing but the support log module and the legacy sweep touches
// localStorage, sessionStorage or localforage. Drafts, the open room, the intro card and
// linked profiles live in the encrypted memo.
await section(28, async () => {
  const allowed = new Set(['src/lib/support-log/browser.ts', 'src/engine/browser.ts'])
  const uses = codeLines(/\b(localStorage|sessionStorage|localforage)\b/, ['src', 'public']).filter((l) => !allowed.has(l.slice(0, l.indexOf(':'))))
  check('28 source: localStorage, sessionStorage and localforage only in the support log module and the legacy sweep', uses.length === 0, uses.join('\n  '))
})

// 30: pushState and replaceState are called only in the history
// helper file, and only with null or its mark(kind). history.state never holds a contact,
// a room, a text or an amount: it is { ilchonOverlay: 'room' | 'connect' | 'setup' |
// 'sheet' } (the type is kept by tsc; the states written are checked below by driving the
// helper). 'sheet': the bottom sheets' one entry.
await section(30, async () => {
  const HELPER = 'src/screens/shell/overlay-history.ts'
  // App code only: the helper's own test (*.test.ts, a fake history) is not shipped.
  const uses = codeLines(/\b(pushState|replaceState)\b/, ['src']).filter((l) => !/^[^:]+\.test\.ts:/.test(l))
  const outside = uses.filter((l) => l.slice(0, l.indexOf(':')) !== HELPER)
  check('30 source: pushState and replaceState only in the history helper', outside.length === 0, outside.join('\n  '))
  const calls = uses.filter((l) => /\.(pushState|replaceState)\(/.test(l))
  check('30 source: the helper calls them (push and replace)', calls.some((l) => l.includes('.pushState(')) && calls.some((l) => l.includes('.replaceState(')), calls.join('\n  '))
  // mark('setup'): the first run's words entry.
  // mark('sheet'): the open bottom sheets' entry.
  const odd = calls.filter((l) => !/\.(pushState|replaceState)\((null|mark\((next|shown)\.kind\)|mark\('(setup|sheet)'\)), ''\)/.test(l))
  check("30 source: every call passes null, mark(kind), mark('setup') or mark('sheet'), and no URL", odd.length === 0, odd.join('\n  '))
  // The sheets reach history only through the helper: BottomSheet takes the nav App hands it.
  const sheetSrc = readFileSync(join(ROOT, 'src/ui/BottomSheet.tsx'), 'utf8')
  check('30 source: BottomSheet asks the helper for its back entry (useSheetBack)', /useSheetBack\(open, onClose, dismissible, !!aboveCover\)/.test(sheetSrc))
  // A sheet whose onClose can refuse (a busy guard) must say so through dismissible, so Back keeps its entry
  // at once instead of after the restore timer.
  const refusing: string[] = []
  for (const f of walk(join(ROOT, 'src'))) {
    const src = readFileSync(f, 'utf8')
    if (!src.includes('<BottomSheet')) continue
    for (const m of src.matchAll(/onClose=\{\(\) => !(\w+) &&/g)) {
      if (!src.includes(`dismissible={!${m[1]}}`)) refusing.push(`${relative(ROOT, f)}: onClose refuses while ${m[1]}, no dismissible={!${m[1]}}`)
    }
  }
  check('30 source: a sheet that refuses to close also says so through dismissible', refusing.length === 0, refusing.join('\n  '))
  // The receive sheet fetches an invoice for up to ~12 s: while busy, backdrop, Escape, Back and the
  // close button must not close it, or the failure line is lost.
  const recvSrc = readFileSync(join(ROOT, 'src/screens/room/ReceiveSheet.tsx'), 'utf8')
  check('30 source: the receive form sheet cannot be dismissed while busy (dismissible and hideClose)', recvSrc.includes('dismissible={!busy}') && recvSrc.includes('hideClose={busy}'))
  check('30 source: App hands the nav to the sheets (setSheetBack)', /setSheetBack\(nav\)/.test(readFileSync(join(ROOT, 'src/App.tsx'), 'utf8')))

  // Drive the helper through opens, closes, back, forward, reloads and a removal with a
  // fake history; every state it ever writes is recorded.
  const PK_A = 'a'.repeat(64) as never
  const PK_B = 'b'.repeat(64) as never
  const written: unknown[] = []
  const entries: unknown[] = [null]
  let at = 0
  const h: HistoryPort = {
    get state() {
      return entries[at]
    },
    pushState(d) {
      written.push(d)
      entries.splice(at + 1)
      entries.push(structuredClone(d))
      at++
    },
    replaceState(d) {
      written.push(d)
      entries[at] = structuredClone(d)
    },
    back() {
      if (at > 0) at--
    },
  }
  const contacts = new Set<string>([PK_A, PK_B])
  const nav = () => createOverlayNav(h, { hasContact: (id) => contacts.has(id), show: () => undefined })
  let n = nav()
  n.start({ tab: 'board', room: PK_A, at: 1 })
  n.close()
  n.popState(h.state)
  n.open({ kind: 'room', contactId: PK_B })
  n = nav()
  n.start({ tab: 'contacts', room: PK_B, at: 2 })
  n.open({ kind: 'connect' })
  h.back()
  n.popState(h.state)
  n.open({ kind: 'room', contactId: PK_A })
  contacts.delete(PK_A)
  n.contactsChanged({ kind: 'room', contactId: PK_A })
  n.popState(h.state)
  at++
  n.popState(h.state)
  n = nav()
  n.start({ tab: 'board', room: PK_A, at: 3 })
  // Bottom sheets: over the tab, closed by back and by its button; a reload
  // with one on top replaces its entry in place.
  const slot = { onBack: () => undefined, dismissible: () => true, aboveCover: () => false }
  const s1 = n.openSheet(slot)
  h.back()
  n.popState(h.state)
  s1.close()
  n.openSheet(slot).close()
  n.popState(h.state)
  n.open({ kind: 'room', contactId: PK_B })
  n.openSheet(slot)
  const atReload = at
  n = nav()
  n.start({ tab: 'board', room: PK_B, at: 4 })
  // Replaced in place: no sheet mark on top, and no entry pushed over the old one.
  const sheetOnTopAfterReload = isSheetMark(entries[at]) || entries.slice(0, at + 1).some(isSheetMark) || at !== atReload
  // The first run's words entry, on the same tab: in, out with the app bar, in again, done.
  const sh = createSetupHistory(h)
  sh.enter()
  sh.enter()
  sh.leave()
  sh.enter()
  sh.done()
  const shapes = written.filter((d) => d !== null)
  // A room whose contact is gone leaves its entry with back(), never by writing null over
  // it: the helper writes marks only.
  check('30 history: the helper wrote states (push and replace), marks only', shapes.length >= 3 && !written.includes(null), JSON.stringify(written))
  const bad = written.filter((d) => d !== null && !((markOf(d) !== null || isSetupMark(d) || isSheetMark(d)) && JSON.stringify(Object.keys(d as object)) === '["ilchonOverlay"]'))
  check("30 history: every state is null or exactly { ilchonOverlay: 'room' | 'connect' | 'setup' | 'sheet' }", bad.length === 0, JSON.stringify(bad))
  check('30 history: the sheets wrote their entry, and a reload left no sheet entry on top', written.some(isSheetMark) && !sheetOnTopAfterReload, JSON.stringify([written, entries]))
  check('30 history: the setup entry was written once per entering (no second push on the entry)', written.filter(isSetupMark).length === 2, JSON.stringify(written))
  const all = JSON.stringify([written, entries])
  check('30 history: no contact key in any state written', !all.includes('a'.repeat(16)) && !all.includes('b'.repeat(16)), all)
})

// PIN fields: no PIN field is a password field to the
// browser's password manager, and no field of the app carries a credential autocomplete
// token. Every PIN field goes through src/screens/lock/PinField.tsx: a text field with the
// number pad and the dots drawn by CSS; type="password" only as its fallback where the
// browser cannot draw them.
await section('pin fields', async () => {
  const PIN_FIELD = 'src/screens/lock/PinField.tsx'
  const pw = codeLines(/type\s*=\s*\{?\s*["']password["']|type:\s*["']password["']|['"]password['"]/, ['src'], /\.(ts|tsx)$/).filter((l) => !/^[^:]+\.test\.ts:/.test(l))
  const pwOutside = pw.filter((l) => !l.startsWith(`${PIN_FIELD}:`))
  check('pin fields: no type="password" anywhere in src/ but the PinField fallback', pwOutside.length === 0, pwOutside.join('\n  '))
  const pf = readFileSync(join(ROOT, PIN_FIELD), 'utf8')
  check("pin fields: PinField uses password only as the fallback (MASKED ? 'text' : 'password')", pw.length === 1 && /type=\{MASKED \? 'text' : 'password'\}/.test(pf), pw.join('\n  '))
  check('pin fields: PinField decides the mask with CSS.supports(-webkit-text-security)', /CSS\.supports\('-webkit-text-security', 'disc'\)/.test(pf))
  check(
    'pin fields: PinField has the number pad, 6 digits, autocomplete off, no autocorrect',
    /inputMode="numeric"/.test(pf) && /maxLength=\{6\}/.test(pf) && /autoComplete="off"/.test(pf) && /autoCorrect="off"/.test(pf) && /spellCheck=\{false\}/.test(pf),
  )
  const name = /PIN_FIELD_NAME = '([^']+)'/.exec(pf)?.[1] ?? ''
  check('pin fields: the field name is not a login name (no pass, pin, user, login, otp, code, email)', name !== '' && !/pass|pin|user|login|otp|code|mail|auth|secret/i.test(name), name)
  const css = readFileSync(join(ROOT, 'src/screens/lock/lock.css'), 'utf8')
  check('pin fields: lock.css draws the dots on .lock-pin', /\.lock-pin \.ui-field__input \{\s*-webkit-text-security: disc;/.test(css))
  const forms = codeLines(/<form\b/, ['src/screens/lock', 'src/ui'], /\.tsx$/)
  check('pin fields: no <form> in the lock screens or the ui kit (no submit that offers to save)', forms.length === 0, forms.join('\n  '))

  // Every TextField block of src/: none is a PIN field in disguise (a PIN label or 6 digits).
  const disguised: string[] = []
  for (const f of walk(join(ROOT, 'src'))) {
    if (!f.endsWith('.tsx') || relative(ROOT, f) === PIN_FIELD) continue
    const src = readFileSync(f, 'utf8')
    for (const m of src.matchAll(/<TextField\b[\s\S]*?\/>/g)) {
      if (/t\('(pin|pinConfirm|currentPin)'\)|maxLength=\{6\}/.test(m[0])) disguised.push(`${relative(ROOT, f)}: ${m[0].slice(0, 80).replace(/\s+/g, ' ')}`)
    }
  }
  check('pin fields: no TextField with a PIN label or 6 digits outside PinField', disguised.length === 0, disguised.join('\n  '))
  const users: string[] = []
  for (const f of walk(join(ROOT, 'src/screens/lock'))) {
    const src = readFileSync(f, 'utf8')
    for (const m of src.matchAll(/<PinField\b/g)) users.push(`${relative(ROOT, f)}:${m.index}`)
  }
  const usersOf = (file: string) => users.filter((u) => u.startsWith(`src/screens/lock/${file}:`)).length
  check(
    'pin fields: the lock chooser (2), unlock (1) and re-check (1) use PinField',
    usersOf('LockChooser.tsx') === 2 && usersOf('UnlockScreen.tsx') === 1 && usersOf('ReauthGate.tsx') === 1,
    users.join(', '),
  )

  // No credential autocomplete token on any field of the app.
  const CRED = /autoComplete\s*=\s*\{?\s*["'][^"']*\b(username|current-password|new-password|one-time-code|webauthn)\b/
  const cred = codeLines(CRED, ['src'], /\.(ts|tsx)$/)
  check('pin fields: no credential autocomplete token (username, current-password, new-password, one-time-code, webauthn) in src/', cred.length === 0, cred.join('\n  '))
  const room = readFileSync(join(ROOT, 'src/screens/room/RoomScreen.tsx'), 'utf8')
  const composer = /<TextField\s+inputRef=\{composerRef\}[\s\S]*?\/>/.exec(room)?.[0] ?? ''
  check('pin fields: the chat composer has autocomplete off and a plain name', /autoComplete="off"/.test(composer) && /name="ilchon-chat"/.test(composer), composer.slice(0, 120))
})

// The #restore mark: the stop screen's reset sets it for its own
// reload only. A fake address with its history entries: the page that loads with the mark
// reads it once and removes it at once, never by adding an entry, so a later unrelated
// reset (Settings, the unlock screen, other boot screens) opens on the start step. A reset
// that throws on the stop screen removes it too.
await section('restore mark', async () => {
  const entries = ['https://ilchon.example/?p=a']
  let at = 0
  let pushes = 0
  const loc: MarkLocation & { href: string; assignHash(h: string): void } = {
    get href() {
      return entries[at]
    },
    get hash() {
      const i = entries[at].indexOf('#')
      return i < 0 || i === entries[at].length - 1 ? '' : entries[at].slice(i)
    },
    replace(url: string) {
      if (!url.startsWith('#')) throw new Error('only a fragment is expected')
      const base = entries[at].split('#')[0]
      entries[at] = base + url
    },
    assignHash(h: string) {
      pushes++
      entries.splice(at + 1)
      entries.push(entries[at].split('#')[0] + h)
      at++
    },
  }
  setRestoreMark(loc)
  check('restore mark: set on the current entry, no new history entry', loc.hash === '#restore' && entries.length === 1 && pushes === 0, JSON.stringify(entries))
  // The reset's reload keeps the address; the new page reads the mark.
  check("restore mark: the reload after the stop screen's reset sees it", takeRestoreMark(loc))
  check('restore mark: removed at once, without a new history entry', loc.hash === '' && entries.length === 1 && pushes === 0, JSON.stringify(entries))
  // A later reset from Settings or the unlock screen reloads the same address.
  check('restore mark: a later unrelated reset does not see it', !takeRestoreMark(loc))
  setRestoreMark(loc)
  clearRestoreMark(loc)
  check('restore mark: a reset that threw removes it', loc.hash === '' && !takeRestoreMark(loc))
  loc.assignHash('#other')
  clearRestoreMark(loc)
  check('restore mark: another fragment is left alone', loc.hash === '#other')
  check('restore mark: no location (Node) reads as no mark', !takeRestoreMark(undefined))
  // Wiring: the module itself takes the mark once, when it loads with the page,
  // and restoreAfterReset() returns that answer. A fresh copy of the module is loaded with
  // a fake address that carries the mark.
  {
    const marked = ['https://ilchon.example/?p=a#restore']
    let replaced = 0
    const fakeLoc: MarkLocation = {
      get hash() {
        const i = marked[0].indexOf('#')
        return i < 0 || i === marked[0].length - 1 ? '' : marked[0].slice(i)
      },
      replace(url: string) {
        replaced++
        marked[0] = marked[0].split('#')[0] + url
      },
    }
    const g = globalThis as { location?: unknown }
    const had = Object.hasOwn(g, 'location')
    const prev = g.location
    g.location = fakeLoc
    try {
      const mod = (await import(`../src/screens/lock/after-reset.ts?load=${Date.now()}`)) as typeof import('../src/screens/lock/after-reset.ts')
      check('restore mark wiring: the page loaded with the mark opens on the restore step', mod.restoreAfterReset() === true)
      check('restore mark wiring: the module removed the mark when it loaded', fakeLoc.hash === '' && replaced === 1, marked[0])
      check('restore mark wiring: every later read agrees (one answer per page)', mod.restoreAfterReset() === true)
      const again = (await import(`../src/screens/lock/after-reset.ts?load=${Date.now()}-2`)) as typeof import('../src/screens/lock/after-reset.ts')
      check('restore mark wiring: the next page load (a later reset) reads no mark', again.restoreAfterReset() === false)
    } finally {
      if (had) g.location = prev
      else delete g.location
    }
    const setup = readFileSync(join(ROOT, 'src/screens/lock/SetupScreen.tsx'), 'utf8')
    check('restore mark wiring: the first-run screen starts from restoreAfterReset() through initialSetup', /initialSetup\(restoreAfterReset\(\)\)/.test(setup) && !/location\.hash/.test(setup))
  }
  const src = readFileSync(join(ROOT, 'src/screens/lock/after-reset.ts'), 'utf8')
  check('restore mark source: the hash is never assigned (that would add a history entry)', !/location\.hash\s*=[^=]/.test(src) && !/\.hash\s*=[^=]/.test(src))
  const boot = readFileSync(join(ROOT, 'src/screens/shell/BootScreens.tsx'), 'utf8')
  check('restore mark source: the stop screen clears it when its reset throws', /catch \{[^}]*clearRestoreMark\(\)/.test(boot))
})

// ---------------------------------------------------------------- 31, 33~39 with the engine
//
// The hub's fake transport, real encryption: crypto.subtle runs on Node's thread
// pool, so these wait on real time, not the virtual clock.

const hub = createFakeHub(createFakeClock(Date.now()))
interface Run {
  engine: IlchonEngine
  events: string[]
  resets: { reason: string }[]
}
/** The engine's clock in these sections: real time plus `skew.ms` (S-REC-11 moves it past REAUTH_MS). */
const skew = { ms: 0 }
function engineOn(st: ProfileStorage, o: { autoIdentity?: boolean } = {}): Run {
  const run: Run = { engine: undefined as unknown as IlchonEngine, events: [], resets: [] }
  run.engine = createEngine(
    {
      storage: st,
      marmot: hub.marmot(),
      match: matchCrypto,
      connect: connectModule,
      rates: { fetch: async () => ({}) },
      lnurl: createLnurl({ fetch: async () => Promise.reject(new TypeError('no network in check-storage')) }),
      relays: ['fake://relay'],
      namespace: NS,
      persistence: 'memory',
      now: () => Date.now() + skew.ms,
      autoIdentity: o.autoIdentity,
    },
    {
      defaultLang: 'ko',
      debug: (event, info) => run.events.push(info?.errorKey ? `${event}:${String(info.errorKey)}` : event),
      onReset: (info) => void run.resets.push({ ...info }),
    },
  )
  return run
}
const started = async (r: Run) => {
  await r.engine.start().catch(() => {})
  return r.engine.store.getState()
}

/** A profile made the way the engine reads it: identity (with its 12 words), two contacts, their chats, an offer. */
const fx = (() => {
  const words = newMnemonic()
  const sk = secretFromMnemonic(words)
  const pkX = pubkeyOf(generateSecretKeyHex())
  const pkY = pubkeyOf(generateSecretKeyHex())
  const contact = (pk: string, name: string): Contact => ({ id: pk, pubkey: pk, groupId: 'ab'.repeat(32), name, createdAt: 1 })
  const chat = (pk: string, text: string): ChatMessage[] => [{ id: randomId(), contactId: pk, mine: false, kind: 'text', text, at: 1 }]
  return { words, sk, pkX, pkY, contacts: [contact(pkX, 'MARKER-NAME-X'), contact(pkY, 'MARKER-NAME-Y')], chat }
})()
function randomId(): string {
  return Buffer.from(crypto.getRandomValues(new Uint8Array(8))).toString('hex')
}
/** Backend with the fixture under lock 'none'; `roomKeyOf` names the entry of X's chat. */
async function fixture(): Promise<{ b: MemoryBackend; roomX: string; contactsKey: string; tombstonesKey: string }> {
  const b = memoryBackend()
  let roomX = ''
  let contactsKey = ''
  let tombstonesKey = ''
  await storage(b).create(none, async (t) => {
    await t.kv.set('identity', { v: 1, sk: fx.sk, words: fx.words })
    contactsKey = (await written(b, () => t.kv.set('contacts', fx.contacts)))[0]!
    // An empty tombstones item, as the engine reads by default: written only so the damaged-tombstones check can damage it.
    tombstonesKey = (await written(b, () => t.kv.set('tombstones', {})))[0]!
    await t.kv.set(`room:${fx.pkY}`, fx.chat(fx.pkY, 'MARKER-CHAT-Y'))
    roomX = (await written(b, () => t.kv.set(`room:${fx.pkX}`, fx.chat(fx.pkX, 'MARKER-CHAT-X 계좌 110-123-456789'))))[0]!
    await t.kv.set('offer', { id: 'offer-id-1', side: 'sell', currency: 'KRW', amountMinor: 43219, feePct: 2.75, methods: BOTH, createdAt: 1, rev: 1 })
  })
  return { b, roomX, contactsKey, tombstonesKey }
}

await section(31, async () => {
  const b = memoryBackend()
  const r1 = engineOn(storage(b))
  check('31 engine: an empty store boots to setup', (await started(r1)).boot === 'setup')
  r1.engine.actions.prepareIdentity()
  await r1.engine.actions.createIdentity(pin(PIN))
  check('31 engine: createIdentity with a PIN -> ready', r1.engine.store.getState().boot === 'ready' && r1.engine.store.getState().lock.method === 'pin')
  r1.engine.memo.set('draft:x', 'MARKER-DRAFT')
  await r1.engine.stop()
  // A reload: a new store instance on the same backend, a new engine.
  const r2 = engineOn(storage(b))
  const s2 = await started(r2)
  check('31 engine: after a reload it is locked', s2.boot === 'locked' && s2.lock.method === 'pin')
  check('31 engine: locked, no contact, chat or me in memory', s2.contacts.length === 0 && Object.keys(s2.rooms).length === 0 && s2.me === null)
  check('31 engine: locked, memo reads nothing', r2.engine.memo.get('draft:x') === undefined)
  check('31 engine: locked, memo writes report that nothing was kept', r2.engine.memo.set('draft:y', 'L') === false && r2.engine.memo.del('draft:x') === false)
  await rejects('31 engine: a wrong PIN -> wrong-pin', r2.engine.actions.unlock(WRONG), 'wrong-pin')
  check('31 engine: the failed unlock made a support line event', r2.events.includes('unlock-failed:wrong-pin'))
  await r2.engine.actions.unlock(PIN)
  check('31 engine: the right PIN -> ready', r2.engine.store.getState().boot === 'ready')
  check('31 engine: the memo written before the reload is back', r2.engine.memo.get('draft:x') === 'MARKER-DRAFT' && r2.engine.memo.get('draft:y') === undefined)
  check('31 engine: no MARKER-DRAFT in the stored bytes', plainTextIn(b, [{ what: 'draft', value: 'MARKER-DRAFT' }]).length === 0)
  r2.engine.memo.set('draft:x', 'AFTER')
  check('31 engine: the auto-lock time starts at 5 minutes', r2.engine.store.getState().settings.relockMinutes === 5)
  await r2.engine.actions.setSettings({ relockMinutes: 15 })
  await r2.engine.stop()
  const r3 = engineOn(storage(b))
  await started(r3)
  check('31 engine: locked, the auto-lock time is not known yet', r3.engine.store.getState().settings.relockMinutes === 5)
  await r3.engine.actions.unlock(PIN)
  check('31 engine: a write after unlock reaches the store', r3.engine.memo.get('draft:x') === 'AFTER')
  check('31 engine: the auto-lock time comes back after unlock', r3.engine.store.getState().settings.relockMinutes === 15)
  // 32: only one of the choices.
  await r3.engine.actions.setSettings({ relockMinutes: 7 as never })
  check('32 engine: setSettings({ relockMinutes: 7 }) is ignored, 15 stays', r3.engine.store.getState().settings.relockMinutes === 15)
  await r3.engine.actions.setSettings({ relockMinutes: '30' as never, sort: 'fee' })
  check("32 engine: '30' (a string) is ignored too, the rest of the patch applies", r3.engine.store.getState().settings.relockMinutes === 15 && r3.engine.store.getState().settings.sort === 'fee')
  // A write that fails: rejected, memory goes back to the stored time.
  b.failNext('put')
  await rejects('32 engine: a failed write -> save-failed', r3.engine.actions.setSettings({ relockMinutes: 1 }), 'save-failed')
  check('32 engine: and the auto-lock time stays the stored 15', r3.engine.store.getState().settings.relockMinutes === 15)
  await r3.engine.stop()
  const r4 = engineOn(storage(b))
  await started(r4)
  await r4.engine.actions.unlock(PIN)
  check('32 engine: after a reload the stored time is 15, not the failed 1', r4.engine.store.getState().settings.relockMinutes === 15)
  await r4.engine.stop()
})

// 32: a stored value that is missing or not one of the choices is the default.
await section(32, async () => {
  for (const [what, stored] of [
    ['no relockMinutes', { lang: 'en', sort: 'amount' }],
    ['relockMinutes 7', { lang: 'en', sort: 'amount', relockMinutes: 7 }],
    ["relockMinutes '15'", { lang: 'en', sort: 'amount', relockMinutes: '15' }],
    ['relockMinutes null', { lang: 'en', sort: 'amount', relockMinutes: null }],
  ] as const) {
    const b = memoryBackend()
    await storage(b).create(none, async (t) => {
      await t.kv.set('identity', { v: 1, sk: fx.sk, words: fx.words })
      await t.kv.set('settings', stored)
    })
    const r = engineOn(storage(b))
    const st = await started(r)
    check(`32 engine: stored settings with ${what} -> 5`, st.boot === 'ready' && st.settings.relockMinutes === 5 && st.settings.lang === 'en', `${st.boot} ${st.settings.relockMinutes}`)
    await r.engine.stop()
  }
  const b = memoryBackend()
  await storage(b).create(none, async (t) => {
    await t.kv.set('identity', { v: 1, sk: fx.sk, words: fx.words })
    await t.kv.set('settings', { lang: 'en', sort: 'amount', relockMinutes: 30 })
  })
  const r = engineOn(storage(b))
  check('32 engine: a stored 30 is read as 30', (await started(r)).settings.relockMinutes === 30)
  await r.engine.stop()
})

await section(33, async () => {
  const b = memoryBackend()
  const r1 = engineOn(storage(b))
  await started(r1)
  await r1.engine.actions.setSettings({ lang: 'en' })
  check('33 language: picked in setup, nothing stored yet', b.raw().data.size === 0 && b.raw().lock.record === undefined)
  r1.engine.actions.prepareIdentity()
  await r1.engine.actions.createIdentity(none)
  check('33 language: the first screen choice is kept after create', r1.engine.store.getState().settings.lang === 'en')
  await r1.engine.stop()
  const r2 = engineOn(storage(b))
  await started(r2)
  check('33 language: and after a reload', r2.engine.store.getState().boot === 'ready' && r2.engine.store.getState().settings.lang === 'en')
  await r2.engine.stop()
})

await section(34, async () => {
  const { b } = await fixture()
  const r1 = engineOn(storage(b))
  const st = await started(r1)
  check('34 delete: the fixture opens with two contacts and their chats', st.boot === 'ready' && st.contacts.length === 2 && (st.rooms[fx.pkX]?.length ?? 0) === 1)
  const m = r1.engine.memo
  m.set(`draft:${fx.pkX}`, 'MARKER-DRAFT-X')
  m.set(`nostr:${fx.pkX}`, { npub: 'x' })
  m.set(`draft:${fx.pkY}`, 'keep')
  m.set('intro', true)
  m.set('place', { tab: 'contacts', room: fx.pkX, at: 1 })
  await r1.engine.actions.deleteContact(fx.pkX)
  check('34 delete: the memo keys of that contact are gone', m.get(`draft:${fx.pkX}`) === undefined && m.get(`nostr:${fx.pkX}`) === undefined)
  check('34 delete: other memo keys stay', m.get(`draft:${fx.pkY}`) === 'keep' && m.get('intro') === true)
  const place = m.get<{ tab: string; room: string | null }>('place')
  check('34 delete: the open room of that contact goes, the tab stays', place?.room === null && place.tab === 'contacts', JSON.stringify(place))
  // A room still on screen after the removal cannot write its draft back.
  const again = m.set(`draft:${fx.pkX}`, 'TYPED-AFTER') || m.set(`nostr:${fx.pkX}`, { npub: 'x' })
  check('34 delete: a draft or profile of the removed contact is refused afterwards', !again && m.get(`draft:${fx.pkX}`) === undefined && m.get(`nostr:${fx.pkX}`) === undefined)
  check('34 delete: keys of a contact still here are kept', m.set(`draft:${fx.pkY}`, 'keep') && m.get(`draft:${fx.pkY}`) === 'keep')
  m.set('place', { tab: 'board', room: fx.pkY, at: 2 })
  await r1.engine.stop()
  const r2 = engineOn(storage(b))
  const s2 = await started(r2)
  check('34 delete: after a reload too', r2.engine.memo.get(`draft:${fx.pkX}`) === undefined && r2.engine.memo.get(`draft:${fx.pkY}`) === 'keep')
  check("34 delete: another contact's open room stays", r2.engine.memo.get<{ room: string }>('place')?.room === fx.pkY)
  check("34 delete: the contact's chat item is gone", s2.rooms[fx.pkX] === undefined && (s2.rooms[fx.pkY]?.length ?? 0) === 1)
  await r2.engine.stop()
})

// One contact's chat item that cannot be read loses that chat only.
await section('room', async () => {
  const { b, roomX, contactsKey } = await fixture()
  const bad = await copyOf(b, { data: (d) => d.set(roomX, flip(d.get(roomX)!)) })
  const r = engineOn(storage(bad))
  const st = await started(r)
  check('room: a damaged chat item opens the app', st.boot === 'ready', `${st.boot} ${st.bootError}`)
  check('room: that chat is empty, the other one is there', st.rooms[fx.pkX] === undefined && (st.rooms[fx.pkY]?.length ?? 0) === 1)
  check('room: both contacts stay', st.contacts.length === 2)
  check('room: one room-damaged event (a line without values)', r.events.filter((e) => e === 'room-damaged').length === 1, r.events.join(','))
  await r.engine.stop()
  // contacts stays one item; from recovery 25 on its damage opens the app with an empty
  // list and every list relay pending, so the relays' copies bring it back.
  const badContacts = await copyOf(b, { data: (d) => d.set(contactsKey, flip(d.get(contactsKey)!)) })
  const r2 = engineOn(storage(badContacts))
  const s2 = await started(r2)
  check('room: a damaged contacts item opens the app with no contacts', s2.boot === 'ready' && s2.contacts.length === 0, `${s2.boot} ${s2.bootError}`)
  check('room: its event names the place, not the item', r2.events.includes('storage-damaged:contact-list'), r2.events.join(','))
  await r2.engine.stop()
  // A damaged tombstones item takes the same path; the contacts item is read as it is.
  const { b: b3, tombstonesKey } = await fixture()
  const badTombs = await copyOf(b3, { data: (d) => d.set(tombstonesKey, flip(d.get(tombstonesKey)!)) })
  const r3 = engineOn(storage(badTombs))
  const s3 = await started(r3)
  check('room: a damaged tombstones item opens the app, both contacts stay', s3.boot === 'ready' && s3.contacts.length === 2, `${s3.boot} ${s3.bootError} ${s3.contacts.length}`)
  check('room: one storage-damaged:contact-list event for it', r3.events.filter((e) => e === 'storage-damaged:contact-list').length === 1, r3.events.join(','))
  await r3.engine.stop()
})

// Everything the engine stores, after it ran: no plain amount, name, chat, key or id.
await section('at rest', async () => {
  const { b } = await fixture()
  const r = engineOn(storage(b))
  await started(r)
  const a = r.engine.actions
  await a.renameContact(fx.pkY, 'MARKER-RENAME')
  await a.postOffer({ side: 'buy', currency: 'USD', amountMinor: 432150, feePct: 2.75, methods: BOTH })
  await a.sendChat(fx.pkY, 'MARKER-CHAT-SENT')
  r.engine.memo.set(`draft:${fx.pkY}`, 'MARKER-DRAFT 110-123-456789')
  // The open room names a contact: its pubkey is in the search below.
  r.engine.memo.set('place', { tab: 'contacts', room: fx.pkY, at: 1 })
  await a.setSettings({ lang: 'en', sort: 'fee' })
  await r.engine.stop()
  // The store really holds them: a reload reads them back.
  const r2 = engineOn(storage(b))
  const s2 = await started(r2)
  const back =
    s2.contacts.some((c) => c.name === 'MARKER-RENAME') &&
    s2.myOffer?.amountMinor === 432150 &&
    (s2.rooms[fx.pkY] ?? []).some((m) => m.kind === 'text' && m.text === 'MARKER-CHAT-SENT') &&
    r2.engine.memo.get(`draft:${fx.pkY}`) === 'MARKER-DRAFT 110-123-456789' &&
    r2.engine.memo.get<{ room: string }>('place')?.room === fx.pkY &&
    s2.settings.sort === 'fee'
  check('at rest: a reload reads everything back', back)
  await r2.engine.stop()
  const found = plainTextIn(b, [
    { what: 'MARKER (names, chats, draft)', value: 'MARKER-' },
    { what: 'account number', value: '110-123' },
    { what: 'amount 43219', value: '43219' },
    { what: 'amount 432150 (USD 4,321.50 in cents)', value: '432150' },
    { what: 'fee 2.75', value: '2.75' },
    { what: 'contact X pubkey', value: fx.pkX },
    { what: 'contact Y pubkey', value: fx.pkY },
    { what: 'group id', value: fx.contacts[0]!.groupId ?? '' },
    { what: 'secret key', value: fx.sk },
    { what: '12 words', value: fx.words },
    { what: 'first two words', value: fx.words.split(' ').slice(0, 2).join(' ') },
    { what: 'last two words', value: fx.words.split(' ').slice(-2).join(' ') },
    { what: 'my pubkey', value: pubkeyOf(fx.sk) },
    { what: 'offer id', value: 'offer-id-1' },
    { what: 'item name contacts', value: 'contacts' },
    { what: 'item name room:', value: 'room:' },
    { what: 'item name identity', value: 'identity' },
    { what: 'memo key draft:', value: 'draft:' },
    { what: 'memo key place', value: 'place' },
    // The field as the codec writes it (JSON): a bare 'USD' is 3 bytes and turns up in random ciphertext by chance.
    { what: 'currency', value: '"currency":"USD"' },
  ])
  check('at rest: no amount, fee, name, chat, draft, key, 12 words, id or item name in any stored byte', found.length === 0, found.join(', '))
})

// S-REC-11: the 12 words again, only after the lock is proven again.
await section('S-REC-11', async () => {
  const b = memoryBackend()
  const r1 = engineOn(storage(b))
  await started(r1)
  const a = r1.engine.actions
  const W = a.prepareIdentity()
  await a.createIdentity(pin(PIN))
  check('S-REC-11 createIdentity with a PIN -> ready, hasWords', r1.engine.store.getState().boot === 'ready' && r1.engine.store.getState().hasWords)
  check('S-REC-11 right after create the words come back without a new proof', same(a.revealMnemonic(), W))
  skew.ms += REAUTH_MS + 1_000
  await rejects('S-REC-11 after REAUTH_MS: revealMnemonic -> reauth-required', () => a.revealMnemonic(), 'reauth-required')
  await rejects('S-REC-11 a wrong PIN does not open it', a.reauth(WRONG), 'wrong-pin')
  await rejects('S-REC-11 still reauth-required', () => a.revealMnemonic(), 'reauth-required')
  await a.reauth(PIN)
  check('S-REC-11 after reauth(pin): the same 12 words', same(a.revealMnemonic(), W))
  await r1.engine.stop()
  // A relock is a reload: a new store instance on the same backend, a new engine.
  const r2 = engineOn(storage(b))
  const s2 = await started(r2)
  check('S-REC-11 after a reload it is locked, no words known', s2.boot === 'locked' && !s2.hasWords)
  await rejects('S-REC-11 locked: revealMnemonic -> not-allowed', () => r2.engine.actions.revealMnemonic(), 'not-allowed')
  await r2.engine.actions.unlock(PIN)
  check('S-REC-11 unlock opens the window: the same words without reauth', same(r2.engine.actions.revealMnemonic(), W))
  await r2.engine.stop()
  const found = plainTextIn(b, [
    { what: 'first two words', value: W.slice(0, 2).join(' ') },
    { what: 'words 6-7', value: W.slice(5, 7).join(' ') },
    { what: 'secret key', value: secretFromMnemonic(W.join(' ')) },
  ])
  check('S-REC-11 the stored bytes hold no two words in a row and no key (identity is encrypted)', found.length === 0, found.join(', '))
  skew.ms = 0
})

// readIdentity: no words is a restored identity; malformed words are damage.
await section('readIdentity', async () => {
  const words = newMnemonic()
  const sk = secretFromMnemonic(words)
  const made = async (identity: unknown) => {
    const b = memoryBackend()
    await storage(b).create(none, async (t) => t.kv.set('identity', identity))
    return b
  }
  const r1 = engineOn(storage(await made({ v: 1, sk })))
  const s1 = await started(r1)
  check('readIdentity: an identity without words opens, hasWords false', s1.boot === 'ready' && !s1.hasWords, `${s1.boot} ${s1.bootError}`)
  await rejects('readIdentity: and revealMnemonic is not-allowed', () => r1.engine.actions.revealMnemonic(), 'not-allowed')
  await r1.engine.stop()
  const r2 = engineOn(storage(await made({ v: 1, sk, words })))
  const s2 = await started(r2)
  check('readIdentity: with its 12 words opens, hasWords true', s2.boot === 'ready' && s2.hasWords)
  await r2.engine.stop()
  const bad: [string, unknown][] = [
    ['11 words', words.split(' ').slice(0, 11).join(' ')],
    ['13 words', `${words} ${words.split(' ')[0]}`],
    ['upper case', words.toUpperCase()],
    ['two spaces', words.replace(' ', '  ')],
    ['not a string', words.split(' ')],
    ['empty string', ''],
  ]
  for (const [what, w] of bad) {
    const r = engineOn(storage(await made({ v: 1, sk, words: w })))
    const s = await started(r)
    check(`readIdentity: words ${what} -> storage-damaged`, s.boot === 'error' && s.bootError === 'storage-damaged', `${s.boot} ${s.bootError}`)
    check(`readIdentity: words ${what} -> no key in memory`, s.me === null && !s.hasWords)
  }
})

await section(35, async () => {
  const r = engineOn(storage(memoryBackend(), { noLock: false }), { autoIdentity: true })
  const st = await started(r)
  check('35 engine: autoIdentity without noLock -> error not-allowed', st.boot === 'error' && st.bootError === 'not-allowed', `${st.boot} ${st.bootError}`)
})

await section(36, async () => {
  const b = await copyOf(pinBase)
  const r = engineOn(storage(b))
  check('36 reset: a PIN profile boots locked', (await started(r)).boot === 'locked')
  await r.engine.actions.resetAll()
  const raw = b.raw()
  check('36 reset: while locked, the whole store is gone', raw.data.size === 0 && raw.lock.record === undefined && raw.lock.device === undefined && raw.lock.format === undefined)
  check("36 reset: onReset({ reason: 'user' })", r.resets.length === 1 && r.resets[0]!.reason === 'user' && !('pubkey' in r.resets[0]!))
})

await section(37, async () => {
  const { b } = await fixture()
  const r = engineOn(storage(b, { format: STORE_FORMAT + 1 }))
  const st = await started(r)
  check("37 format: another format -> onReset({ reason: 'format' })", r.resets.length === 1 && r.resets[0]!.reason === 'format', JSON.stringify(r.resets))
  check('37 format: the store is empty, nothing was read', b.raw().data.size === 0 && b.raw().lock.record === undefined && st.contacts.length === 0)
})

await section(38, async () => {
  const { b } = await fixture()
  b.failNext('get')
  const r = engineOn(storage(b))
  const st = await started(r)
  check('38 engine: the first read after unlock fails -> error storage-unavailable', st.boot === 'error' && st.bootError === 'storage-unavailable', `${st.boot} ${st.bootError}`)
  check('38 engine: one storage-unavailable event', r.events.includes('storage-unavailable'), r.events.join(','))
})

await section(39, async () => {
  const at = (hostname: string, search = '?p=a') => ({ hostname, search })
  check('39 ?p=: the real address ignores it', getProfileNamespace(at('ilchon.org'), false) === 'ilchon:default' && getProfileNamespace(at('ilchon.example'), false) === 'ilchon:default')
  check('39 ?p=: a shipped build on localhost ignores it', getProfileNamespace(at('localhost'), false) === 'ilchon:default')
  check('39 ?p=: a branch preview takes it', getProfileNamespace(at('feat-x.ilchon.pages.dev'), false) === 'ilchon:a')
  check('39 ?p=: a development build takes it', getProfileNamespace(at('localhost'), true) === 'ilchon:a')
  check('39 ?p=: a bad name is ignored', getProfileNamespace(at('localhost', '?p=a/b'), true) === 'ilchon:default')
  check('39 ?p=: Node (no location) is the default', getProfileNamespace(undefined, true) === 'ilchon:default')
})

// ---------------------------------------------------------------- relock: the auto-lock clock
//
// src/engine/relock.ts on a fake wall clock and fake timers, as src/engine/browser.ts
// wires it. `frozen` is a hidden page whose timers do not
// run (iOS, a sleeping phone); otherwise they run (Android Chrome).

function relockRig(o: { minutes?: () => number } = {}) {
  const r = { t: Date.UTC(2026, 10, 13, 9), hidden: false, armed: true, mins: 5, locks: 0, frozen: false, covered: false, covers: 0, focused: true, touch: true }
  const timers: { at: number; fn: () => void; live: boolean }[] = []
  const watch = createRelockWatch({
    now: () => r.t,
    setTimer: (fn, ms) => {
      const h = { at: r.t + ms, fn, live: true }
      timers.push(h)
      return h
    },
    clearTimer: (h) => void ((h as { live: boolean }).live = false),
    armed: () => r.armed,
    minutes: o.minutes ?? (() => r.mins),
    hidden: () => r.hidden,
    lock: () => void r.locks++,
    cover: () => {
      r.covered = true
      r.covers++
    },
    uncover: () => void (r.covered = false),
    focused: () => r.focused,
    blurCovers: () => r.touch,
  })
  const rig = {
    watch,
    r,
    /** Moves the wall clock; timers due by then fire unless the hidden page is frozen. */
    pass(ms: number) {
      r.t += ms
      if (r.frozen && r.hidden) return
      for (const h of timers) {
        if (h.live && h.at <= r.t) {
          h.live = false
          h.fn()
        }
      }
    },
    hide() {
      r.hidden = true
      r.focused = false
      watch.hide()
    },
    show() {
      r.hidden = false
      r.frozen = false
      r.focused = true
      watch.show()
    },
    /** Out of view for `ms`, then back. */
    away(ms: number, frozen = true) {
      r.frozen = frozen
      rig.hide()
      rig.pass(ms)
      rig.show()
    },
    liveTimers: () => timers.filter((h) => h.live).length,
  }
  return rig
}
const MIN_MS = 60_000

await section('relock', async () => {
  let g = relockRig()
  g.away(5 * MIN_MS - 1_000)
  check('relock: 4:59 out of view (page frozen) -> not locked', g.r.locks === 0)
  g = relockRig()
  g.away(5 * MIN_MS)
  check('relock: 5:00 out of view (page frozen) -> locked on return', g.r.locks === 1)
  g = relockRig()
  g.away(5 * MIN_MS + 1)
  check('relock: 5:00.001 -> locked', g.r.locks === 1)

  // Timers run while hidden (Android Chrome): the key goes at 5:00, still hidden.
  g = relockRig()
  g.r.frozen = false
  g.hide()
  g.pass(5 * MIN_MS - 1_000)
  check('relock: hidden with timers, at 4:59 nothing yet', g.r.locks === 0)
  g.pass(1_000)
  check('relock: hidden with timers, at 5:00 it locks while still hidden', g.r.locks === 1)
  g.show()
  check('relock: and coming back does not lock twice', g.r.locks === 1)

  // A short trip to another app (the bank app for a transfer).
  g = relockRig()
  g.away(40_000, false)
  check('relock: 40 seconds in another app -> not locked', g.r.locks === 0)
  check('relock: the timer of that trip is cancelled', g.liveTimers() === 0)
  g.pass(10 * MIN_MS)
  check('relock: 10 minutes in view afterwards -> not locked (only time out of view counts)', g.r.locks === 0)
  // Several short trips do not add up.
  for (let i = 0; i < 6; i++) g.away(4 * MIN_MS, false)
  check('relock: six trips of 4 minutes each -> not locked', g.r.locks === 0)

  // The phone slept (the page and its timers stopped, the wall clock went on).
  g = relockRig()
  g.away(3 * 60 * MIN_MS)
  check('relock: the phone slept 3 hours -> locked on return', g.r.locks === 1)

  // The clock went back while out of view.
  g = relockRig()
  g.hide()
  g.r.t -= 10_000
  g.show()
  check('relock: the clock went back while hidden -> locked', g.r.locks === 1)

  // A second hide (pagehide after visibilitychange) keeps the first moment.
  g = relockRig()
  g.r.frozen = true
  g.hide()
  g.pass(3 * MIN_MS)
  g.hide()
  g.pass(2 * MIN_MS)
  g.show()
  check('relock: a second hide keeps the first moment (3 + 2 minutes -> locked)', g.r.locks === 1)

  // Not armed: locked, setup, starting without a key, lock 'none'.
  g = relockRig()
  g.r.armed = false
  g.away(60 * MIN_MS)
  check('relock: not armed when hidden -> never locks', g.r.locks === 0)
  g = relockRig()
  g.r.frozen = false
  g.hide()
  g.r.armed = false
  g.pass(6 * MIN_MS)
  g.show()
  check('relock: disarmed while hidden -> the timer and the return do nothing', g.r.locks === 0)

  // The setting right after a change: each hide uses the time chosen now.
  g = relockRig()
  g.r.mins = 1
  g.away(59_000)
  check('relock: set to 1 minute, 0:59 away -> not locked', g.r.locks === 0)
  g.away(60_000)
  check('relock: set to 1 minute, 1:00 away -> locked', g.r.locks === 1)
  g = relockRig()
  g.r.mins = 30
  g.away(6 * MIN_MS)
  check('relock: set to 30 minutes, 6 minutes away -> not locked', g.r.locks === 0)
  g.away(30 * MIN_MS - 1_000, false)
  check('relock: set to 30 minutes, 29:59 away with timers -> not locked', g.r.locks === 0)
  g.r.mins = 1
  g.away(61_000, false)
  check('relock: 30 changed to 1 just before leaving, 1:01 away -> locked', g.r.locks === 1)

  // With the engine's own setting, as browser.ts reads it: setSettings right before a hide.
  const { b } = await fixture()
  const run = engineOn(storage(b))
  await started(run)
  g = relockRig({ minutes: () => run.engine.store.getState().settings.relockMinutes })
  g.away(2 * MIN_MS)
  check('relock: engine default 5 -> 2 minutes away is not locked', g.r.locks === 0)
  await run.engine.actions.setSettings({ relockMinutes: 1 })
  g.away(60_000)
  check('relock: right after setSettings({ relockMinutes: 1 }), 1:00 away -> locked', g.r.locks === 1)
  await run.engine.stop()

  // The privacy cover: covered the moment the page is
  // hidden with a lock; on return off when no lock is due, kept under the lock's reload.
  g = relockRig()
  g.hide()
  check('cover: hidden while armed -> covered at once, before any timer', g.r.covered && g.r.covers === 1 && g.r.locks === 0)
  g.hide()
  check('cover: a second hide (pagehide) keeps one cover', g.r.covered)
  g.pass(40_000)
  g.show()
  check('cover: back after 40 seconds -> not locked, cover off (the screen as it was)', !g.r.covered && g.r.locks === 0)
  g = relockRig()
  g.away(5 * MIN_MS)
  check('cover: back after 5:00 (frozen page) -> locked, the cover stays for the reload', g.r.covered && g.r.locks === 1)
  g = relockRig()
  g.r.frozen = false
  g.hide()
  g.pass(5 * MIN_MS)
  check('cover: timers running, locked while hidden -> still covered', g.r.covered && g.r.locks === 1)
  g.show()
  check('cover: and the return after that lock does not take the cover off', g.r.covered && g.r.locks === 1)
  g = relockRig()
  g.r.armed = false
  g.away(60 * MIN_MS)
  check('cover: no lock in place (none, locked, setup) -> never covered', g.r.covers === 0 && !g.r.covered)
  g = relockRig()
  g.hide()
  g.r.armed = false
  g.pass(6 * MIN_MS)
  g.show()
  check('cover: disarmed while hidden -> no lock, the cover comes off', !g.r.covered && g.r.locks === 0)
  g = relockRig()
  g.show()
  check('cover: a show with no hide before it (pageshow on load) does nothing harmful', !g.r.covered && g.r.locks === 0)

  // The earlier trigger: on a touch device the cover
  // goes on at window blur, while the page is still drawn, before Android takes the
  // recent-apps picture; not for the app's own system sheets, never on a desktop.
  const blur = (x: ReturnType<typeof relockRig>) => {
    x.r.focused = false
    x.watch.blur()
  }
  const focus = (x: ReturnType<typeof relockRig>) => {
    x.r.focused = true
    x.watch.focus()
  }
  g = relockRig()
  blur(g)
  check('cover blur: a phone losing focus while armed -> covered at once, no lock timer', g.r.covered && g.liveTimers() === 0 && g.r.locks === 0)
  g.hide()
  g.pass(40_000)
  g.show()
  check('cover blur: then HOME, back after 40 s -> not locked, cover off', !g.r.covered && g.r.locks === 0)
  g = relockRig()
  blur(g)
  g.hide()
  g.pass(5 * MIN_MS)
  g.show()
  check('cover blur: then HOME, back after 5:00 -> locked, the cover never came off', g.r.covered && g.r.locks === 1)
  g = relockRig()
  blur(g)
  focus(g)
  check('cover blur: focus back without leaving (notification shade) -> cover off', !g.r.covered && g.r.locks === 0)
  g = relockRig()
  blur(g)
  g.watch.touch()
  check('cover blur: a touch on the cover takes it off', !g.r.covered)
  g = relockRig()
  g.r.touch = false
  blur(g)
  check('cover blur: a desktop (another window in front) -> no cover', !g.r.covered && g.r.covers === 0)
  g = relockRig()
  g.r.armed = false
  blur(g)
  check('cover blur: no lock in place -> no cover', g.r.covers === 0)
  g = relockRig()
  g.watch.tap()
  g.pass(300)
  blur(g)
  check('cover blur: a blur 0.3 s after a tap (passkey, camera or clipboard sheet) -> no cover', !g.r.covered && g.r.covers === 0)
  focus(g)
  g.pass(TAP_GRACE_MS)
  blur(g)
  check(`cover blur: a blur ${TAP_GRACE_MS / 1000} s after the last tap -> covered`, g.r.covered)
  g = relockRig()
  g.watch.tap()
  g.pass(300)
  blur(g)
  g.hide()
  check('cover blur: a sheet blur is skipped, but leaving after it still covers on hide', g.r.covered)
  g = relockRig()
  g.watch.touch()
  g.pass(300)
  blur(g)
  check('cover blur: a scroll touch (no click) then leaving 0.3 s later -> covered at blur', g.r.covered && g.r.covers === 1)
  // A tap on a link that hands off to another app (the pay button) gets no grace.
  g = relockRig()
  g.watch.tap(true)
  g.pass(300)
  blur(g)
  check('cover blur: a blur 0.3 s after tapping a lightning:/bitcoin: link (another app) -> covered', g.r.covered && g.r.covers === 1)
  g = relockRig()
  g.watch.tap()
  g.pass(200)
  g.watch.tap(true)
  g.pass(100)
  blur(g)
  check('cover blur: an earlier ordinary tap does not lend its grace to a pay-link tap', g.r.covered)
  const offs = ['lightning:lnbc1u1p', 'bitcoin:bc1qxy?amount=0.001', 'intent://pay#Intent;scheme=lightning;end', 'LIGHTNING:LNBC1', ' bitcoin:bc1q']
  const stays = ['https://ilchon.org/x', 'http://localhost:5173', '#top', '/settings', '', null, undefined, 'blob:https://ilchon.org/1', 'data:text/plain,x', 'javascript:void(0)']
  check(
    'cover blur: handsOffHref says which links leave for another app',
    offs.every((h) => handsOffHref(h)) && stays.every((h) => !handsOffHref(h)),
    [...offs.filter((h) => !handsOffHref(h)), ...stays.filter((h) => handsOffHref(h))].join(' | '),
  )
  g = relockRig()
  blur(g)
  g.hide()
  focus(g)
  check('cover blur: a focus while hidden does not take the cover off', g.r.covered)
  g.watch.touch()
  check('cover blur: nor does a touch while hidden', g.r.covered)

  // Return without a lock due: the cover stays until the page is visible and has focus.
  g = relockRig()
  g.hide()
  g.pass(40_000)
  g.r.hidden = false
  g.r.frozen = false
  g.watch.show()
  check('cover return: visible without focus yet -> still covered', g.r.covered && g.r.locks === 0)
  focus(g)
  check('cover return: then focus -> cover off', !g.r.covered && g.liveTimers() === 0)
  g = relockRig()
  g.hide()
  g.pass(40_000)
  g.r.hidden = false
  g.r.frozen = false
  g.watch.show()
  g.pass(FOCUS_WAIT_MS - 1)
  check('cover return: no focus event, just before the wait ends -> covered', g.r.covered)
  g.pass(1)
  check(`cover return: no focus event -> off after ${FOCUS_WAIT_MS} ms at the latest`, !g.r.covered)
  g = relockRig()
  g.hide()
  g.pass(40_000)
  g.r.hidden = false
  g.r.frozen = false
  g.watch.show()
  g.hide()
  g.pass(FOCUS_WAIT_MS)
  check('cover return: hidden again during the wait -> the wait does not uncover', g.r.covered)

  // The lock's reload waits for the cover's frame (the last frame kept on screen).
  const paint = (visible: boolean) => {
    const p = { frames: [] as (() => void)[], timers: [] as (() => void)[], runs: 0 }
    afterPaint({ visible: () => visible, frame: (fn) => void p.frames.push(fn), setTimer: (fn) => void p.timers.push(fn) }, () => void p.runs++)
    return p
  }
  let p = paint(false)
  check('cover paint: a hidden page reloads at once (nothing is drawn)', p.runs === 1 && p.frames.length === 0)
  p = paint(true)
  check('cover paint: visible -> not before a frame', p.runs === 0)
  p.frames.shift()!()
  check('cover paint: one frame is not enough (the cover is drawn in it)', p.runs === 0)
  p.frames.shift()!()
  check('cover paint: after the second frame -> reload', p.runs === 1)
  p.timers.shift()!()
  check(`cover paint: the ${PAINT_WAIT_MS} ms guard does not reload twice`, p.runs === 1)
  p = paint(true)
  p.timers.shift()!()
  check('cover paint: no frames (throttled) -> the guard reloads', p.runs === 1)
})

// ---------------------------------------------------------------- first-run path
// The lock submits as the path the user is on (SetupScreen: mode 'new' -> createIdentity,
// 'restore' -> restoreIdentity). Restore -> back -> Start fresh used to keep 'restore', so
// the lock called restoreIdentity('') and failed with 'not-checked'.
{
  const walk = (start: SetupFlow, events: SetupEvent[]): SetupFlow => events.reduce(nextSetup, start)
  const fresh = initialSetup(false)
  const afterReset = initialSetup(true)
  check('setup: a first visit starts at the start, on the new path', fresh.step === 'start' && fresh.mode === 'new')
  check('setup: after a reset (#restore) the restore field comes first', afterReset.step === 'restore' && afterReset.mode === 'restore')
  const aw = walk(fresh, ['restore', 'back', 'new'])
  check('setup: Restore -> back -> Start fresh: the words are on the new path', aw.step === 'words' && aw.mode === 'new', JSON.stringify(aw))
  const a = walk(fresh, ['restore', 'back', 'new', 'lock'])
  check('setup: Restore -> back -> Start fresh -> Next: the lock submits a new key', a.step === 'lock' && a.mode === 'new', JSON.stringify(a))
  const b = walk(afterReset, ['back', 'new', 'lock'])
  check('setup: #restore start -> back -> Start fresh -> Next: the lock submits a new key', b.step === 'lock' && b.mode === 'new', JSON.stringify(b))
  const c = walk(fresh, ['new', 'back', 'restore', 'lock'])
  check('setup: Start fresh -> back -> Restore -> found: the lock submits a restore', c.step === 'lock' && c.mode === 'restore', JSON.stringify(c))
  const d = walk(fresh, ['restore', 'lock', 'back'])
  check('setup: back from the lock of a restore goes to the restore field', d.step === 'restore' && d.mode === 'restore')
  const e = walk(fresh, ['new', 'lock', 'back'])
  check('setup: back from the lock of a new key goes to the words', e.step === 'words' && e.mode === 'new')
  const f = walk(fresh, ['restore', 'lock', 'back', 'back', 'new', 'lock'])
  check('setup: restore -> lock -> back -> back -> Start fresh -> Next: a new key', f.step === 'lock' && f.mode === 'new', JSON.stringify(f))
  const g = walk(fresh, ['new', 'lock', 'restore'])
  check('setup: a failed restore back to the field is on the restore path', g.step === 'restore' && g.mode === 'restore')
  check('setup: the start does not lead to the lock directly', walk(fresh, ['lock']).step === 'start')

  // The system back on the words: the words step has
  // one history entry; leaving it goes to the start, and the same words stay (the engine
  // keeps them until the page reloads, check-engine S-REC-12).
  const onWords = walk(fresh, ['new'])
  const popW = setupPop(onWords, false, true)
  check('setup back: system back on the words -> the start', popW === 'home' && nextSetup(onWords, popW!).step === 'start', String(popW))
  const onLock = walk(fresh, ['new', 'lock'])
  const popL = setupPop(onLock, false, true)
  check('setup back: system back on the lock of a new key -> the start', popL === 'home' && nextSetup(onLock, popL!).step === 'start', String(popL))
  const home = nextSetup(onLock, 'home')
  const again = walk(home, ['new', 'lock'])
  check('setup back: then Start fresh -> Next still submits a new key', again.step === 'lock' && lockSubmitKind(again) === 'create', JSON.stringify(again))
  check('setup back: on the restore path a popstate changes nothing', setupPop(walk(fresh, ['restore']), false, false) === null && setupPop(walk(fresh, ['restore', 'lock']), false, false) === null)
  check('setup back: on the start a back changes nothing', setupPop(fresh, false, true) === null)
  check('setup back: forward onto the entry on the start shows the same words again', setupPop(home, true, true) === 'new')
  check('setup back: forward onto the entry with no words made does nothing', setupPop(fresh, true, false) === null)

  // The entry on a fake tab: entering pushes once, the app bar's back and done() take it
  // with back(). A reload on the words: the entry there is the old page's, and a
  // back() onto the entry under it would load the app again (the unlock screen after the
  // key is made, the words lost on the app bar's back). So the new page clears the old
  // entry in place and pushes its own, and never calls back() for an entry it did not push.
  const entries: unknown[] = [null]
  let at = 0
  let backs = 0
  const tab: HistoryPort = {
    get state() {
      return entries[at]
    },
    pushState(d) {
      entries.splice(at + 1)
      entries.push(structuredClone(d))
      at++
    },
    replaceState(d) {
      entries[at] = structuredClone(d)
    },
    back() {
      backs++
      if (at > 0) at--
    },
  }
  const sh = createSetupHistory(tab)
  sh.enter()
  check(
    'setup entry: entering the words pushes one entry { ilchonOverlay: "setup" }',
    entries.length === 2 && at === 1 && JSON.stringify(entries[1]) === '{"ilchonOverlay":"setup"}',
    JSON.stringify(entries),
  )
  sh.enter()
  check('setup entry: entering again on the same page pushes nothing', entries.length === 2 && at === 1, JSON.stringify(entries))
  const reloaded = createSetupHistory(tab)
  reloaded.enter()
  check(
    "setup entry: a reload on the entry and Start fresh again -> one setup entry, the old page's cleared in place",
    entries.filter(isSetupMark).length === 1 && entries[1] === null && at === 2 && backs === 0,
    JSON.stringify(entries),
  )
  check("setup entry: the app bar's back takes this page's entry (back once)", reloaded.leave() && at === 1 && backs === 1)
  check('setup entry: leave() with no entry does nothing (the caller goes back by itself)', !reloaded.leave() && backs === 1)
  reloaded.enter()
  reloaded.done()
  check('setup entry: done() after the key is made takes the entry, no dead back on the board', at === 1 && backs === 2 && tab.state === null)
  reloaded.done()
  check('setup entry: done() with no entry does nothing', backs === 2)
  // The page reloaded on the entry, then the key is made or the app bar's back pressed
  // without entering again: no back() across pages, the old entry is cleared in place.
  const before = backs
  createSetupHistory(tab).enter()
  const third = createSetupHistory(tab)
  third.done()
  check("setup entry: done() on an earlier page's entry clears it in place, no back() (no reload of the app)", backs === before && tab.state === null)
  createSetupHistory(tab).enter()
  const fourth = createSetupHistory(tab)
  check("setup entry: the app bar's back on an earlier page's entry clears it, no back(); the screen goes back itself", !fourth.leave() && backs === before && tab.state === null)
}

// The restore mark meets the first-run path: a page loaded by the stop screen's
// reset (#restore) opens on the restore field; the user goes back and starts fresh. The
// lock's submit makes a new key, and the mark is gone, so a later reload or reset does not
// open on the restore field again.
await section('setup after the restore mark', async () => {
  const addr = ['https://ilchon.example/?p=a#restore']
  const fakeLoc: MarkLocation = {
    get hash() {
      const i = addr[0].indexOf('#')
      return i < 0 || i === addr[0].length - 1 ? '' : addr[0].slice(i)
    },
    replace(url: string) {
      addr[0] = addr[0].split('#')[0] + url
    },
  }
  const g = globalThis as { location?: unknown }
  const had = Object.hasOwn(g, 'location')
  const prev = g.location
  g.location = fakeLoc
  try {
    const page = (await import(`../src/screens/lock/after-reset.ts?setup=${Date.now()}`)) as typeof import('../src/screens/lock/after-reset.ts')
    const start = initialSetup(page.restoreAfterReset())
    check('setup + mark: the page opens on the restore field', start.step === 'restore' && start.mode === 'restore', JSON.stringify(start))
    const flow = (['back', 'new', 'lock'] as SetupEvent[]).reduce(nextSetup, start)
    check('setup + mark: back -> Start fresh -> Next reaches the lock on the new path', flow.step === 'lock' && lockSubmitKind(flow) === 'create', JSON.stringify(flow))
    const b = memoryBackend()
    const r = engineOn(storage(b))
    await started(r)
    const a = r.engine.actions
    const words = a.prepareIdentity()
    if (lockSubmitKind(flow) === 'create') await a.createIdentity(none)
    else await a.restoreIdentity('', none).catch(() => {})
    const s1 = r.engine.store.getState()
    check('setup + mark: the submit made a new key (ready, its own 12 words)', s1.boot === 'ready' && s1.hasWords && words.length === 12, `${s1.boot} ${s1.hasWords}`)
    await r.engine.stop()
    check('setup + mark: the mark is gone from the address afterwards', fakeLoc.hash === '' && !addr[0].includes('restore'), addr[0])
    const later = (await import(`../src/screens/lock/after-reset.ts?setup=${Date.now()}-later`)) as typeof import('../src/screens/lock/after-reset.ts')
    check('setup + mark: a later reload does not open on the restore field', initialSetup(later.restoreAfterReset()).step === 'start')
  } finally {
    if (had) g.location = prev
    else delete g.location
  }
})

console.log(failed ? `\n${failed} FAILED\n${failedNames.map((n) => `  FAILED: ${n}`).join('\n')}` : '\nALL PASS')
process.exit(failed ? 1 : 0)
