/**
 * pnpm check:inbox — the transport's received-message inbox (src/lib/marmot/durable-inbox.ts,
 * delivery 3 and "검사"). The real object over a memory store whose setItem and removeItem
 * can be held and let go. No network, no Marmot. Store calls are bounded by 50 ms here.
 *
 *   I-1  handled before its put ended: the removal still comes after the put
 *   I-2  a fulfilled entry goes, a rejected one and an unhandled one stay, in seq order
 *   I-3  pending() sorts by seq
 *   I-4  entries of another shape are not returned and are removed
 *   I-5  after close() nothing is written or removed
 *   I-6  close() with a put that never ends: done after timeoutMs, nothing leaks out
 *   I-7  a setItem that rejects: one warn, nothing leaks out, handled() still ends
 *   I-8  the size bound: beyond maxEntries a message is not stored (one 'inbox full' warn
 *        until the inbox went below the bound), a removal makes room again
 *   I-9  a stalled read (getItem hangs or rejects for one key): pending() gives [] after
 *        about timeoutMs and removes nothing; once the store answers, the entries come back
 *
 * And the transport's reorder buffer (src/lib/marmot/reorder.ts) on a fake clock:
 *   R-1  a burst handed over newest first goes out sorted, once REORDER_IDLE_MS passed quietly
 *   R-2  a catch-up during one long ingest goes out whole and sorted when the ingest ends
 *   R-3  ingests back to back without a pause (a long catch-up, or junk on the
 *        room's public h tag): a queued message goes out INGEST_HOLD_MAX_MS after it came,
 *        not later, while the ingests still go on; the next one gets its own bound
 *   R-4  held (invite/accept not returned): nothing goes, not even at the bound; release
 *        hands over on the next task
 */
import type { IncomingMessage } from '../src/contracts'
import { createDurableInbox, type InboxEntry } from '../src/lib/marmot/durable-inbox'
import { INGEST_HOLD_MAX_MS, REORDER_IDLE_MS, ReorderBuffers, type ReorderClock } from '../src/lib/marmot/reorder'

const TIMEOUT = 50

let failures = 0
const unhandled: unknown[] = []
process.on('unhandledRejection', (e) => unhandled.push(e))

function check(name: string, ok: boolean, detail = ''): void {
  if (ok) console.log(`PASS  ${name}`)
  else {
    failures++
    console.log(`FAIL  ${name}${detail ? `  (${detail})` : ''}`)
  }
}

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms))
const tick = () => new Promise<void>((r) => setImmediate(r))

type Call = { op: 'set' | 'remove'; key: string }

/** A memory store whose setItem / removeItem can be held (until let go) or made to fail. */
function testStore() {
  const data = new Map<string, unknown>()
  const calls: Call[] = []
  const held: (() => void)[] = []
  let holdSets = false
  let failSets = false
  let hangSets = false
  let hangGetKey: string | undefined
  let failGetKey: string | undefined
  const store = {
    async getItem(key: string) {
      if (key === hangGetKey) return new Promise<InboxEntry | null>(() => {})
      if (key === failGetKey) throw new Error('read failed')
      return (data.has(key) ? structuredClone(data.get(key)) : null) as InboxEntry | null
    },
    setItem(key: string, value: InboxEntry): Promise<InboxEntry> {
      calls.push({ op: 'set', key })
      if (failSets) return Promise.reject(new Error('QuotaExceededError'))
      if (hangSets) return new Promise<InboxEntry>(() => {})
      const apply = () => data.set(key, structuredClone(value))
      if (holdSets) {
        return new Promise<InboxEntry>((resolve) =>
          held.push(() => {
            apply()
            resolve(value)
          }),
        )
      }
      apply()
      return Promise.resolve(value)
    },
    async removeItem(key: string) {
      calls.push({ op: 'remove', key })
      data.delete(key)
    },
    async clear() {
      data.clear()
    },
    async keys() {
      return [...data.keys()]
    },
  }
  return {
    store,
    data,
    calls,
    hold: (on: boolean) => (holdSets = on),
    fail: (on: boolean) => (failSets = on),
    hang: (on: boolean) => (hangSets = on),
    hangGet: (key: string | undefined) => (hangGetKey = key),
    failGet: (key: string | undefined) => (failGetKey = key),
    release: () => {
      for (const f of held.splice(0)) f()
    },
  }
}

const hex = (n: number) => n.toString(16).padStart(64, '0')

function entry(n: number, seq = n): InboxEntry {
  const message: IncomingMessage = { id: hex(n), groupId: 'aa'.repeat(32), senderPubkey: 'bb'.repeat(32), msg: { t: 'chat', id: hex(n).slice(32), text: `m${n}` }, at: 1_700_000_000 + n }
  return { seq, message }
}

// I-1
{
  const s = testStore()
  const inbox = createDurableInbox(s.store, { timeoutMs: 10_000 })
  s.hold(true)
  inbox.put(hex(1), entry(1))
  inbox.handled(hex(1), Promise.resolve())
  await sleep(10)
  check('I-1 no removal while its put is held', !s.calls.some((c) => c.op === 'remove'), JSON.stringify(s.calls))
  s.release()
  await sleep(10)
  const order = s.calls.map((c) => c.op).join(',')
  check('I-1 the entry is gone at the end, removed after its put', !s.data.has(hex(1)) && order === 'set,remove', order)
}

// I-2
{
  const s = testStore()
  const inbox = createDurableInbox(s.store, { timeoutMs: TIMEOUT })
  for (const n of [1, 2, 3]) inbox.put(hex(n), entry(n))
  inbox.handled(hex(1), Promise.resolve())
  const rejected = Promise.reject(new Error('kept'))
  inbox.handled(hex(2), rejected)
  await sleep(10)
  const again = createDurableInbox(s.store, { timeoutMs: TIMEOUT })
  const left = (await again.pending()).map((e) => e.message.id)
  check('I-2 pending() gives the rejected and the unhandled entry, in seq order', left.join() === [hex(2), hex(3)].join(), left.map((x) => x.slice(-1)).join())
}

// I-3
{
  const s = testStore()
  const inbox = createDurableInbox(s.store, { timeoutMs: TIMEOUT })
  inbox.put(hex(13), entry(13, 3))
  inbox.put(hex(11), entry(11, 1))
  inbox.put(hex(12), entry(12, 2))
  await sleep(5)
  const seqs = (await inbox.pending()).map((e) => e.seq)
  check('I-3 pending() sorts by seq', seqs.join() === '1,2,3', seqs.join())
}

// I-4
{
  const s = testStore()
  const warns: string[] = []
  s.data.set(hex(1), { seq: 'x', message: entry(1).message })
  s.data.set(hex(2), { seq: 2, message: { ...entry(2).message, id: hex(99) } })
  s.data.set(hex(3), entry(3))
  s.data.set(hex(4), 'not an entry')
  const inbox = createDurableInbox(s.store, { timeoutMs: TIMEOUT, warn: (p) => warns.push(String(p)) })
  const got = (await inbox.pending()).map((e) => e.message.id)
  check('I-4 entries of another shape are not given back', got.join() === hex(3), got.join())
  check('I-4 and are removed from the store', [...s.data.keys()].join() === hex(3), [...s.data.keys()].join())
  check('I-4 each one warned without a value', warns.length === 3 && warns.every((w) => w === 'inbox entry could not be read'), warns.join('|'))
}

// I-5
{
  const s = testStore()
  const inbox = createDurableInbox(s.store, { timeoutMs: TIMEOUT })
  inbox.put(hex(1), entry(1))
  await sleep(5)
  const before = s.calls.length
  await inbox.close()
  inbox.put(hex(4), entry(4))
  inbox.handled(hex(1), Promise.resolve())
  await sleep(10)
  check('I-5 after close() no setItem and no removeItem', s.calls.length === before && s.data.has(hex(1)) && !s.data.has(hex(4)), JSON.stringify(s.calls.slice(before)))
}

// I-6
{
  const s = testStore()
  const inbox = createDurableInbox(s.store, { timeoutMs: TIMEOUT })
  s.hang(true)
  inbox.put(hex(1), entry(1))
  const t0 = Date.now()
  await inbox.close()
  const took = Date.now() - t0
  check('I-6 close() with a put that never ends is done after about timeoutMs', took >= TIMEOUT - 5 && took < TIMEOUT + 200, `${took} ms`)
  await sleep(20)
  check('I-6 no rejection leaks out', unhandled.length === 0, String(unhandled[0]))
}

// I-7
{
  const s = testStore()
  const warns: { p: string; v: unknown[] }[] = []
  const inbox = createDurableInbox(s.store, { timeoutMs: TIMEOUT, warn: (p, ...v) => warns.push({ p: String(p), v }) })
  s.fail(true)
  inbox.put(hex(1), entry(1))
  let done = false
  inbox.handled(
    hex(1),
    Promise.resolve().then(() => void (done = true)),
  )
  await sleep(20)
  check('I-7 a failed write warns once', warns.length === 1 && warns[0].p === 'inbox write failed', JSON.stringify(warns.map((w) => w.p)))
  check('I-7 nothing leaks out, handled() goes on (its removal runs)', done && unhandled.length === 0 && s.calls.some((c) => c.op === 'remove'), JSON.stringify(s.calls))
  await inbox.close()
}

// I-8
{
  const s = testStore()
  const warns: string[] = []
  const inbox = createDurableInbox(s.store, { timeoutMs: TIMEOUT, maxEntries: 3, warn: (p) => warns.push(String(p)) })
  for (const n of [1, 2, 3, 4, 5]) inbox.put(hex(n), entry(n))
  await sleep(5)
  check('I-8 beyond the bound a message is not stored', [...s.data.keys()].sort().join() === [1, 2, 3].map(hex).join(), [...s.data.keys()].length.toString())
  check("I-8 one 'inbox full' warn, without a count", warns.join('|') === 'inbox full', warns.join('|'))
  inbox.put(hex(2), entry(2))
  check('I-8 an entry stored already can be written again', s.calls.filter((c) => c.op === 'set' && c.key === hex(2)).length === 2)
  inbox.handled(hex(1), Promise.resolve())
  await sleep(5)
  inbox.put(hex(6), entry(6))
  await sleep(5)
  check('I-8 a removal makes room again', s.data.has(hex(6)) && !s.data.has(hex(1)), [...s.data.keys()].length.toString())
  inbox.put(hex(7), entry(7))
  await sleep(5)
  check("I-8 full again: a second 'inbox full' warn", warns.length === 2 && !s.data.has(hex(7)), warns.join('|'))
  // A new instance (the next start) learns the stored entries from pending().
  const next = createDurableInbox(s.store, { timeoutMs: TIMEOUT, maxEntries: 3 })
  await next.pending()
  next.put(hex(8), entry(8))
  await sleep(5)
  check('I-8 the bound counts what pending() found', !s.data.has(hex(8)))
}

// I-9
{
  const s = testStore()
  for (const n of [1, 2, 3]) s.data.set(hex(n), entry(n))
  const warns: string[] = []
  const inbox = createDurableInbox(s.store, { timeoutMs: TIMEOUT, warn: (p) => warns.push(String(p)) })
  s.hangGet(hex(2))
  const t0 = Date.now()
  const got = await inbox.pending()
  const took = Date.now() - t0
  check('I-9 a hanging read: pending() gives [] after about timeoutMs', got.length === 0 && took >= TIMEOUT - 5 && took < TIMEOUT + 200, `${got.length} entries, ${took} ms`)
  check('I-9 nothing is removed, the stalled entry is still stored', !s.calls.some((c) => c.op === 'remove') && [1, 2, 3].every((n) => s.data.has(hex(n))), JSON.stringify(s.calls))
  check("I-9 one 'inbox read failed' warn, no 'could not be read'", warns.join('|') === 'inbox read failed', warns.join('|'))
  s.hangGet(undefined)
  s.failGet(hex(3))
  const got2 = await createDurableInbox(s.store, { timeoutMs: TIMEOUT }).pending()
  check('I-9 a rejecting read: [] and nothing removed', got2.length === 0 && !s.calls.some((c) => c.op === 'remove') && s.data.has(hex(3)))
  s.failGet(undefined)
  const got3 = (await createDurableInbox(s.store, { timeoutMs: TIMEOUT }).pending()).map((e) => e.seq)
  check('I-9 once the store answers, all entries come back', got3.join() === '1,2,3', got3.join())
}

// R: the reorder buffer on a fake clock.
function fakeClock(): ReorderClock & { advance(ms: number): void; t: number } {
  let seq = 0
  const due: { at: number; n: number; fn: () => void; live: boolean }[] = []
  const c = {
    t: 0,
    now: () => c.t,
    after(ms: number, fn: () => void) {
      const d = { at: c.t + ms, n: seq++, fn, live: true }
      due.push(d)
      return () => {
        d.live = false
      }
    },
    /** Runs every timer that comes due within `ms`, in time order. */
    advance(ms: number) {
      const end = c.t + ms
      for (;;) {
        const next = due.filter((d) => d.live && d.at <= end).sort((a, b) => a.at - b.at || a.n - b.n)[0]
        if (!next) break
        next.live = false
        c.t = Math.max(c.t, next.at)
        next.fn()
      }
      c.t = end
    },
  }
  return c
}
const rmsg = (id: string, at = 0): IncomingMessage => ({ groupId: 'g', senderPubkey: 'b'.repeat(64), msg: { t: 'chat', id, text: id } as IncomingMessage['msg'], at, id })

// R-1
{
  const clock = fakeClock()
  const out: { id: string; t: number }[] = []
  const r = new ReorderBuffers((m) => out.push({ id: m.id, t: clock.t }), clock)
  r.put('g', 3, rmsg('m3'))
  clock.advance(10)
  r.put('g', 2, rmsg('m2'))
  r.put('g', 1, rmsg('m1'))
  clock.advance(REORDER_IDLE_MS - 1)
  check('R-1 nothing before the burst went quiet', out.length === 0, out.map((o) => o.id).join())
  clock.advance(1)
  check('R-1 the burst goes out sorted', out.map((o) => o.id).join() === 'm1,m2,m3' && out.every((o) => o.t === 10 + REORDER_IDLE_MS), JSON.stringify(out))
}

// R-2
{
  const clock = fakeClock()
  const out: string[] = []
  const r = new ReorderBuffers((m) => out.push(m.id), clock)
  r.ingestStart('g')
  for (let i = 5; i >= 1; i--) {
    r.put('g', i, rmsg(`c${i}`))
    clock.advance(500)
  }
  check('R-2 nothing while the ingest runs', out.length === 0, out.join())
  r.ingestEnd('g')
  clock.advance(REORDER_IDLE_MS)
  check('R-2 the catch-up goes out whole and sorted after the ingest', out.join() === 'c1,c2,c3,c4,c5', out.join())
}

// R-3
{
  const clock = fakeClock()
  const out: { id: string; t: number }[] = []
  const r = new ReorderBuffers((m) => out.push({ id: m.id, t: clock.t }), clock)
  let open = 0
  let overlapped = true
  // Ingests back to back, each 30 ms, the next starting 1 ms before the previous one ends,
  // for 12 s: the room is never without an ingest.
  r.ingestStart('g')
  open++
  clock.advance(29)
  let first = -1
  let second = -1
  while (clock.t < 12_000) {
    if (first < 0 && clock.t >= 1_000) {
      first = clock.t
      r.put('g', 2, rmsg('real-b'))
      r.put('g', 1, rmsg('real-a'))
    }
    if (second < 0 && first >= 0 && out.length) {
      second = clock.t
      r.put('g', 3, rmsg('next'))
    }
    r.ingestStart('g')
    open++
    clock.advance(1)
    r.ingestEnd('g')
    open--
    clock.advance(28)
    if (open !== 1) overlapped = false
  }
  check('R-3 the ingests ran back to back the whole time', overlapped && open === 1, `open ${open}`)
  const got = out.filter((o) => o.id.startsWith('real'))
  check(
    'R-3 the queued messages go out sorted INGEST_HOLD_MAX_MS after the first came in, while ingests go on',
    got.map((o) => o.id).join() === 'real-a,real-b' && got.every((o) => o.t === first + INGEST_HOLD_MAX_MS),
    JSON.stringify(got.map((o) => ({ ...o, t: o.t - first }))),
  )
  const next = out.find((o) => o.id === 'next')
  check('R-3 the next message gets its own bound', !!next && next.t === second + INGEST_HOLD_MAX_MS, JSON.stringify(next && { t: next.t - second }))
  r.ingestEnd('g')
}

// R-4
{
  const clock = fakeClock()
  const out: string[] = []
  const r = new ReorderBuffers((m) => out.push(m.id), clock)
  r.hold('g')
  r.ingestStart('g')
  r.put('g', 2, rmsg('h2'))
  r.put('g', 1, rmsg('h1'))
  clock.advance(INGEST_HOLD_MAX_MS + 1_000)
  check('R-4 nothing goes while held, not even at the bound', out.length === 0, out.join())
  r.ingestEnd('g')
  r.release('g')
  check('R-4 not inside the release call', out.length === 0)
  clock.advance(0)
  check('R-4 release hands over sorted on the next task', out.join() === 'h1,h2', out.join())
  r.discard('g')
}

await tick()
await sleep(TIMEOUT + 20)
check('no unhandled rejections', unhandled.length === 0, unhandled.map(String).join('; '))
console.log(failures ? `\n${failures} FAILED` : '\nALL PASS')
process.exit(failures ? 1 : 0)
