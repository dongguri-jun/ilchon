/**
 * Engine check scenarios: recovery (12 words, S-REC-*).
 * Run from scripts/check-engine.ts, which lists every scenario in its order.
 */
import type { PubkeyHex } from '../../../src/contracts'
import { type ListBody, decodeList, digest, encodeList } from '../../../src/engine/contact-list'
import { HOLDER_SCAN_TTL_MS, STORE_FORMAT } from '../../../src/engine/index'
import { tradeView } from '../../../src/engine/trade'
import { pubkeyOf } from '../../../src/lib/marmot/keys'
import { newMnemonic, secretFromMnemonic } from '../../../src/lib/seed/index'
import { payCopy } from '../../../src/screens/room/pay-copy'
import { type FakeHub, createHarnessKV } from '../../fake-transport'
import { CHANNEL_CHECK, chanRoom, expectSameEnvelopes, hasText, sameNewRoom, scanOnly } from '../helpers/channel'
import { converged, statusOf } from '../helpers/delivery'
import { ADDR_WPKH, sendsOne } from '../helpers/payment'
import { LIST_AB, onTime, rejectsWith, restoreWords, who } from '../helpers/recovery'
import { expectNoLeakToC, reopenTrio } from '../helpers/reopen'
import { dones, matched } from '../helpers/trade'
import { type TwinScript, twin } from '../helpers/twin'
import { AMOUNT, FEE } from '../markers'
import { Fail, expect } from '../report'
import { BOTH, MIN, type Peer, START_MS, type World, adoptKey, adv, deleteContact, finish, hasContact, link, makePeer, newWorld, orderedKeys, restart, sent, settled, until } from '../world'

/** S-REC-12: the order of prepareIdentity and createIdentity, on an empty profile in 'setup'. */
export async function sRec12(): Promise<void> {
  const w = newWorld()
  const A = makePeer(w, 'A', { bare: true, setup: true })
  await A.engine.start()
  expect(A.state().boot === 'setup' && !A.state().hasWords, `an empty profile stops in setup (${A.state().boot})`)
  await rejectsWith(A.a.createIdentity({ method: 'none' }), 'not-prepared', 'createIdentity before prepareIdentity')
  expect(A.kv.peek('identity') === undefined && A.state().boot === 'setup', 'no identity stored, still setup')
  await rejectsWith(() => A.a.revealMnemonic(), 'not-allowed', 'revealMnemonic in setup')
  const w1 = A.a.prepareIdentity()
  const w2 = A.a.prepareIdentity()
  expect(w1.length === 12 && w1.join(' ') === w2.join(' '), 'prepareIdentity twice gives the same 12 words')
  expect(A.kv.peek('identity') === undefined, 'prepareIdentity stores nothing')
  await A.a.createIdentity({ method: 'none' })
  expect(A.state().boot === 'ready' && A.state().hasWords, `createIdentity -> ready, hasWords (${A.state().boot})`)
  const id = A.kv.peek<{ v: number; sk: string; words?: string }>('identity')
  expect(id?.v === 1 && id.words === w1.join(' '), 'the identity keeps the words shown')
  expect(id?.sk === secretFromMnemonic(w1.join(' ')), 'and the key is the NIP-06 key (account 4242) of those words')
  adoptKey(A)
  expect(A.state().me?.pubkey === pubkeyOf(secretFromMnemonic(w1.join(' '))), 'my pubkey comes from the words')
  await rejectsWith(() => A.a.prepareIdentity(), 'not-allowed', 'prepareIdentity in ready')
  // Lock 'none' needs no proof (development and Node): the words come back as shown.
  expect(A.a.revealMnemonic().join(' ') === w1.join(' '), 'revealMnemonic gives the same words')
  await finish(w)
}

/** An identity without words (restored): opens, keeps no words, shows none. */
export async function sRecNoWords(): Promise<void> {
  const w = newWorld()
  const kv = createHarnessKV()
  const words = newMnemonic()
  kv.seed('identity', { v: 1, sk: secretFromMnemonic(words) })
  kv.seed('format', STORE_FORMAT)
  const A = makePeer(w, 'A', { kv, words })
  await A.engine.start()
  expect(A.state().boot === 'ready' && !A.state().hasWords, `a wordless identity opens without words (${A.state().boot})`)
  await rejectsWith(() => A.a.revealMnemonic(), 'not-allowed', 'revealMnemonic on a restored identity')
  await finish(w)
}
/** The first upload after a change waits 2 s; a run takes the fake relays' 20 ms answers. */
const LIST_SETTLE_MS = 5_000

/** The error code a call ends with ('' when it resolves). */
async function recCode(w: World, call: Promise<unknown>, maxMs = 60_000): Promise<string> {
  try {
    await onTime(w, call, maxMs)
    return ''
  } catch (e) {
    if (e instanceof Fail) throw e
    return e instanceof Error ? e.message : String(e)
  }
}

/** A peer of the S-REC scenarios: its list on LIST_AB. */
function recPeer(w: World, name: string, words?: string): Peer {
  return makePeer(w, name, { words, listRelays: LIST_AB })
}

/** The list key of `p` (the hub learnt it from p's transport or findList). */
function listKey(p: Peer): PubkeyHex {
  const k = p.world.hub.listKeyOf(p.pk)
  if (!k) throw new Fail(`${p.name}: the hub has not seen its list key`)
  return k
}

/** The copy of p's list on `relay`, read as the engine reads it (null: none or unreadable). */
function copyOn(p: Peer, relay: string): { body: ListBody; createdAt: number; payload: string } | null {
  const x = p.world.hub.listOf(relay, listKey(p))
  if (!x) return null
  const body = decodeList(x.payload, p.pk, p.world.clock.now())
  return body ? { body, createdAt: x.createdAt, payload: x.payload } : null
}

/** The phone's own list of `p`, in the same shape. */
function phoneWho(p: Peer): string {
  const tombs = p.kv.peek<Record<string, unknown>>('tombstones') ?? {}
  return who({ c: p.state().contacts.map((c) => [c.pubkey] as [string]), d: Object.keys(tombs).map((pk) => [pk] as [string]) })
}

/** p's publish attempts in the hub's list log. */
function listLogOf(p: Peer): FakeHub['listLog'][number][] {
  const k = p.world.hub.listKeyOf(p.pk)
  return p.world.hub.listLog.filter((x) => x.listPubkey === k)
}

/** The two copies hold the same list (same digest). */
function sameCopies(p: Peer): boolean {
  const a = copyOn(p, 'fake://a')
  const b = copyOn(p, 'fake://b')
  return !!a && !!b && digest(a.body.c, a.body.d) === digest(b.body.c, b.body.d)
}

let recoverCount = 0

/**
 * The phone of `p` is lost (hub.wipe of its device, a new empty store on a new device)
 * and the same 12 words restore it for real: no harness-made list.
 */
async function recover(p: Peer, opts: { anyway?: boolean } = {}): Promise<{ found: boolean }> {
  const w = p.world
  if (!p.dead) {
    await p.engine.stop()
    p.kv.close(p.tag, 'stop')
  }
  w.hub.wipe(p.pk, p.device)
  const kv = createHarnessKV()
  w.kvs.push(kv)
  p.kv = kv
  p.device = `recovered${++recoverCount}`
  p.opts.setup = true
  p.spawn()
  await p.engine.start()
  return restoreWords(p, opts)
}

/** A (words W, list on LIST_AB) linked to the given names, list uploaded. */
async function recWorld(names: string[], opts: { words?: string; peerWords?: Record<string, string> } = {}): Promise<{ w: World; A: Peer; peers: Record<string, Peer> }> {
  const w = newWorld()
  const A = recPeer(w, 'A', opts.words)
  await A.engine.start()
  const peers: Record<string, Peer> = {}
  for (const name of names) {
    const P = makePeer(w, name, { words: opts.peerWords?.[name] })
    await P.engine.start()
    await link(w, A, P)
    peers[name] = P
  }
  await adv(w, LIST_SETTLE_MS)
  return { w, A, peers }
}

/** S-REC-1: the restore brings the key, the names and the tombstones back; channels reopen. */
export async function sRec1(): Promise<void> {
  const { w, A, peers } = await recWorld(['B', 'C', 'D'])
  const { B, C, D } = peers
  await A.a.renameContact(C.pk, '씨')
  await deleteContact(w, A, D)
  await adv(w, 10_000)
  expect(sameCopies(A) && who(copyOn(A, 'fake://a')?.body) === who({ c: [[B.pk], [C.pk]], d: [[D.pk]] }), `both relays hold B, C and the deleted D (${who(copyOn(A, 'fake://a')?.body)})`)
  // The restore comes well after the meeting: a request that comes while my QR was on
  // screen lately makes no reopened notice, and B, C or D may be the lower key.
  // "Lately" is judged on the request's own time too (codeShownNear): a code's life
  // (CODE_REDEEM_MS) plus the clock tolerance (FUTURE_SENT_S), 12 minutes. 10 minutes
  // was too short: when A was the highest key, B and C answered A's requests and drew no
  // line (one run in three failed).
  await adv(w, 15 * MIN)
  const pk = A.pk
  const r = await recover(A)
  expect(r.found, 'found: true')
  expect(A.state().me?.pubkey === pk, 'the same key comes back')
  const cs = A.state().contacts
  expect(who({ c: cs.map((c) => [c.pubkey] as [string]), d: [] }) === who({ c: [[B.pk], [C.pk]], d: [] }), 'the contacts are B and C')
  expect(cs.find((c) => c.pubkey === C.pk)?.name === '씨', 'C keeps the name 씨')
  expect(
    cs.every((c) => c.groupId === null),
    'no contact has a room yet',
  )
  const tombs = A.kv.peek<Record<string, { groupId: string | null }>>('tombstones') ?? {}
  expect(Object.keys(tombs).length === 1 && tombs[D.pk]?.groupId === null, 'D is a tombstone without a room')
  expect((A.kv.peek<{ pending: string[] }>('listSync')?.pending ?? ['x']).length === 0, 'listSync.pending is empty')
  const id = A.kv.peek<{ words?: string }>('identity')
  expect(id !== undefined && id.words === undefined && !A.state().hasWords, 'the restored identity keeps no words')
  await rejectsWith(() => A.a.revealMnemonic(), 'not-allowed', 'revealMnemonic on the restored identity')
  const before = listLogOf(A).length
  await adv(w, 10_000)
  expect(listLogOf(A).length === before, `the first run after the restore uploads nothing (${listLogOf(A).length - before})`)
  // Restores: every channel, the deleted one too, is reopened without meeting.
  await until(w, () => sameNewRoom(A, B) && sameNewRoom(A, C) && sameNewRoom(A, D), 10 * MIN, 'A reopens its channels with B, C and the deleted D')
  await A.a.sendChat(B.pk, 'back')
  await until(w, () => hasText(B, A, 'back'), 2 * MIN, 'B gets a chat from the restored A')
  // Whoever's channel was moved remotely gets one reopened notice, never more.
  await adv(w, 10 * MIN)
  const lines = [B, C].map((q) => (q.state().rooms[A.pk] ?? []).filter((m) => m.kind === 'reopened').length)
  expect(
    lines.every((n) => n <= 1),
    `at most one reopened line per room (${lines.join(',')})`,
  )
  expect(
    lines.some((n) => n === 1),
    `a contact whose channel the restored A moved sees the line (${lines.join(',')})`,
  )
  await finish(w)
}

/** S-REC-2: every change goes to both relays, newer each time, as it is. */
export async function sRec2(): Promise<void> {
  const { w, A } = await recWorld([])
  const B = makePeer(w, 'B')
  await B.engine.start()
  const sizes: number[] = []
  let last = 0
  const step = async (what: string, want: string): Promise<void> => {
    await adv(w, LIST_SETTLE_MS)
    const a = copyOn(A, 'fake://a')
    const b = copyOn(A, 'fake://b')
    expect(!!a && !!b && who(a.body) === want && who(b.body) === want, `${what}: both relays hold it (${who(a?.body)})`)
    expect(a!.createdAt > last && a!.createdAt === b!.createdAt, `${what}: created_at grows (${last} -> ${a!.createdAt})`)
    last = a!.createdAt
    sizes.push(utf8Len(a!.payload), utf8Len(b!.payload))
  }
  await link(w, A, B)
  await step('link', who({ c: [[B.pk]], d: [] }))
  await A.a.renameContact(B.pk, 'bee')
  await step('rename', who({ c: [[B.pk]], d: [] }))
  expect(copyOn(A, 'fake://a')?.body.c[0][1] === 'bee', 'the new name is in the copy')
  await deleteContact(w, A, B)
  await step('delete', who({ c: [], d: [[B.pk]] }))
  expect(
    sizes.every((n) => n === 32_768),
    `every payload is 32768 bytes (${[...new Set(sizes)].join(',')})`,
  )
  expectNoListLines(A, 'S-REC-2')
  await finish(w)
}

const utf8Len = (s: string) => new TextEncoder().encode(s).length

/** The first four fixed contact list lines never come from a run a change made. */
function expectNoListLines(p: Peer, what: string): void {
  const dump = p.dumpLog()
  for (const text of ['contact list sync failed', 'contact list sync incomplete', 'contact list too big', 'contact list copy could not be read']) {
    expect(!dump.includes(text), `${what}: no '${text}' line`)
  }
}

/** S-REC-3: refused uploads: the first try and four retries, then nothing until the app is seen again. */
export async function sRec3(): Promise<void> {
  const { w, A } = await recWorld([])
  const B = makePeer(w, 'B')
  await B.engine.start()
  w.hub.listFate = (_r, op) => (op === 'publish' ? 'reject' : 'ok')
  await link(w, A, B)
  await adv(w, 10 * MIN)
  expect(hasContact(A, B), 'B is a contact all the same')
  const tries = new Set(
    listLogOf(A)
      .filter((x) => !x.accepted && x.relay === 'fake://a')
      .map((x) => x.atMs),
  )
  expect(tries.size === 5, `one try and four retries at fake://a (${tries.size})`)
  expect(
    listLogOf(A).every((x) => !x.accepted),
    'none was taken',
  )
  w.hub.listFate = () => 'ok'
  A.engine.rearmRounds()
  await adv(w, LIST_SETTLE_MS)
  expect(who(copyOn(A, 'fake://a')?.body) === who({ c: [[B.pk]], d: [] }) && sameCopies(A), 'back in view: both relays get the list with B')
  expectNoListLines(A, 'S-REC-3')
  await finish(w)
}

/** S-REC-4: a relay that lost the copy gets it again at the next open, the other is left alone. */
export async function sRec4(): Promise<void> {
  const { w, A } = await recWorld(['B'])
  expect(sameCopies(A), 'synced')
  w.hub.loseList('fake://b', listKey(A))
  const before = listLogOf(A).length
  await restart(A)
  await adv(w, 10_000)
  const after = listLogOf(A).slice(before)
  expect(!!copyOn(A, 'fake://b') && sameCopies(A), 'fake://b holds the same list again')
  expect(
    after.every((x) => x.relay === 'fake://b'),
    `nothing new went to fake://a (${after.map((x) => x.relay).join(',')})`,
  )
  await finish(w)
}

/** S-REC-5: an old copy on a merged relay is not merged; the phone's list replaces it. */
export async function sRec5(): Promise<void> {
  const { w, A, peers } = await recWorld(['B', 'C', 'D'])
  const { B, C, D } = peers
  await deleteContact(w, A, D)
  await adv(w, LIST_SETTLE_MS)
  const old = encodeList({
    v: 1,
    c: [
      [B.pk, 'b', 1],
      [D.pk, 'd', 1],
    ],
    d: [],
  })
  w.hub.putList('fake://a', listKey(A), old, Math.floor(START_MS / 1000) - 3600)
  await restart(A)
  await adv(w, 10_000)
  expect(phoneWho(A) === who({ c: [[B.pk], [C.pk]], d: [[D.pk]] }), `the phone keeps B, C and the deleted D (${phoneWho(A)})`)
  expect(who(copyOn(A, 'fake://a')?.body) === phoneWho(A), 'fake://a gets the phone list again')
  await finish(w)
}

/**
 * S-REC-6: while no relay answers nothing is uploaded; once they answer the list goes up
 * whole: the contacts A has, the deleted D (its tombstone) and the new E.
 */
export async function sRec6(): Promise<void> {
  const { w, A, peers } = await recWorld(['B', 'D'])
  await deleteContact(w, A, peers.D)
  await adv(w, LIST_SETTLE_MS)
  expect(who(copyOn(A, 'fake://a')?.body) === who({ c: [[peers.B.pk]], d: [[peers.D.pk]] }), 'before: the relays hold B and the deleted D')
  const E = makePeer(w, 'E')
  await E.engine.start()
  w.hub.listFate = (_r, op) => (op === 'fetch' ? 'silent' : 'ok')
  await restart(A)
  const before = listLogOf(A).length
  await link(w, A, E)
  await adv(w, 30_000)
  expect(listLogOf(A).length === before, `30 s: nothing uploaded (${listLogOf(A).length - before})`)
  w.hub.listFate = () => 'ok'
  A.engine.rearmRounds()
  await adv(w, 10_000)
  const up = who(copyOn(A, 'fake://a')?.body)
  expect(up === who({ c: [[peers.B.pk], [E.pk]], d: [[peers.D.pk]] }) && sameCopies(A), `the copy holds B, E and the deleted D (${up})`)
  const failed = A.dumpLog()
    .split('\n')
    .filter((l) => l.includes('contact list sync failed')).length
  expect(failed === 1, `exactly one 'sync failed' line, from the open (${failed})`)
  await finish(w)
}

/** S-REC-6b: after a restore only the answering relay gets uploads; the silent one is merged when it answers. */
export async function sRec6b(): Promise<void> {
  const { w, A, peers } = await recWorld(['B', 'C', 'D'])
  const { B, C, D } = peers
  await deleteContact(w, A, D)
  await adv(w, LIST_SETTLE_MS)
  const real = w.hub.listOf('fake://b', listKey(A))!
  w.hub.loseList('fake://a', listKey(A))
  w.hub.listFate = (r, op) => (r === 'fake://b' && op === 'fetch' ? 'silent' : 'ok')
  const r = await recover(A, { anyway: true })
  expect(!r.found && A.state().contacts.length === 0, 'found: false, continue anyway with no contacts')
  expect((A.kv.peek<{ pending: string[] }>('listSync')?.pending ?? []).join() === 'fake://b', 'fake://b stays pending')
  const E = makePeer(w, 'E')
  await E.engine.start()
  await link(w, A, E)
  await adv(w, 30_000)
  const nowB = w.hub.listOf('fake://b', listKey(A))
  expect(nowB?.payload === real.payload && nowB.createdAt === real.createdAt, 'fake://b still holds the real copy')
  expect(who(copyOn(A, 'fake://a')?.body) === who({ c: [[E.pk]], d: [] }), 'fake://a holds E only')
  w.hub.listFate = () => 'ok'
  await adv(w, 70_000)
  const want = who({ c: [[B.pk], [C.pk], [E.pk]], d: [[D.pk]] })
  expect(phoneWho(A) === want, `A has B, C, E and the deleted D (${phoneWho(A)})`)
  expect(who(copyOn(A, 'fake://a')?.body) === want && sameCopies(A), 'both relays hold the merged list')
  expect((A.kv.peek<{ pending: string[] }>('listSync')?.pending ?? ['x']).length === 0, 'listSync.pending is empty')
  expect(!A.dumpLog().includes('list changed elsewhere'), 'a first merge writes no changed-elsewhere line')
  await finish(w)
}

/** S-REC-7: a key with no list: nothing found; a stranger's copy written later is never merged. */
export async function sRec7(): Promise<void> {
  const w = newWorld()
  const A = makePeer(w, 'A', { bare: true, setup: true, listRelays: LIST_AB })
  await A.engine.start()
  const B = makePeer(w, 'B')
  const F = makePeer(w, 'F')
  await B.engine.start()
  await F.engine.start()
  A.words = newMnemonic()
  A.sk = secretFromMnemonic(A.words)
  A.pk = pubkeyOf(A.sk)
  const r = await restoreWords(A, { anyway: true })
  expect(!r.found && A.state().contacts.length === 0, 'found: false, no contacts')
  expect((A.kv.peek<{ pending: string[] }>('listSync')?.pending ?? ['x']).length === 0, 'both relays answered: nothing pending')
  for (const relay of LIST_AB) w.hub.putList(relay, listKey(A), encodeList({ v: 1, c: [[B.pk, 'b', w.clock.now()]], d: [] }), Math.floor(w.clock.now() / 1000) + 5)
  await link(w, A, F)
  await adv(w, 10_000)
  expect(phoneWho(A) === who({ c: [[F.pk]], d: [] }), `A's only contact is F (${phoneWho(A)})`)
  expect(who(copyOn(A, 'fake://a')?.body) === who({ c: [[F.pk]], d: [] }) && sameCopies(A), 'the next copies hold F only')
  await finish(w)
}

/** S-REC-8: no relay answers the restore check: 'network' after 8 s, nothing stored, no restore. */
export async function sRec8(): Promise<void> {
  const w = newWorld()
  const A = makePeer(w, 'A', { bare: true, setup: true, listRelays: LIST_AB })
  await A.engine.start()
  w.hub.listFate = (_r, op) => (op === 'fetch' ? 'silent' : 'ok')
  const t0 = w.clock.now()
  const code = await recCode(w, A.a.checkMnemonic(A.words))
  expect(code === 'network', `checkMnemonic rejects 'network' (${code})`)
  expect(w.clock.now() - t0 <= 8_100, `after about 8 s (${w.clock.now() - t0} ms)`)
  expect(A.kv.peek('identity') === undefined, 'no identity stored')
  expect((await recCode(w, A.a.restoreIdentity(A.words, { method: 'none' }))) === 'not-checked', "restoreIdentity: 'not-checked'")
  expect((await recCode(w, A.a.checkMnemonic('leader monkey parrot'))) === 'invalid-mnemonic', "wrong words: 'invalid-mnemonic'")
  await finish(w)
}

/** S-REC-9: the relay with the real copy answers only much later: it is merged once, then the phone rules. */
export async function sRec9(): Promise<void> {
  const { w, A, peers } = await recWorld(['B', 'C', 'D'])
  const { B, C, D } = peers
  await deleteContact(w, A, D)
  await adv(w, LIST_SETTLE_MS)
  w.hub.loseList('fake://a', listKey(A))
  w.hub.listFate = (r, op) => (r === 'fake://b' && op === 'fetch' ? 'silent' : 'ok')
  await recover(A, { anyway: true })
  const news: Peer[] = []
  for (const name of ['E', 'F', 'G']) {
    const P = makePeer(w, name)
    await P.engine.start()
    await link(w, A, P)
    news.push(P)
    await adv(w, 10 * MIN)
  }
  for (const round of [1, 2]) {
    for (const P of news) {
      await A.a.renameContact(P.pk, `${P.name}${round}`)
      await adv(w, 10 * MIN)
    }
  }
  w.hub.listFate = () => 'ok'
  await restart(A)
  await adv(w, 10_000)
  const want = who({ c: [[B.pk], [C.pk], ...news.map((p) => [p.pk] as [string])], d: [[D.pk]] })
  expect(phoneWho(A) === want, `A has B, C, E, F, G and the deleted D (${phoneWho(A)})`)
  expect(sameCopies(A) && who(copyOn(A, 'fake://b')?.body) === want, 'both relays hold the same list')
  expect((A.kv.peek<{ pending: string[] }>('listSync')?.pending ?? ['x']).length === 0, 'fake://b was merged: nothing pending')
  expect(!A.dumpLog().includes('list changed elsewhere'), 'the first merge writes no changed-elsewhere line')
  // Merged once: a different copy now is not taken, and the phone's list goes back up.
  const X = makePeer(w, 'X')
  w.hub.putList('fake://b', listKey(A), encodeList({ v: 1, c: [[X.pk, 'x', w.clock.now() - 1000]], d: [] }), Math.floor(w.clock.now() / 1000) + 1)
  await restart(A)
  await adv(w, 10_000)
  expect(phoneWho(A) === want, `the other copy is not merged (${phoneWho(A)})`)
  expect(who(copyOn(A, 'fake://b')?.body) === want, "fake://b gets the phone's list again")
  const lines = A.dumpLog()
    .split('\n')
    .filter((l) => l.includes('list changed elsewhere')).length
  expect(lines === 1, `one changed-elsewhere line (${lines})`)
  await finish(w)
}

/** S-REC-10: copies dated an hour ahead: the next upload is dated after them. */
export async function sRec10(): Promise<void> {
  const { w, A, peers } = await recWorld(['B'])
  const ahead = Math.floor(w.clock.now() / 1000) + 3600
  const cur = w.hub.listOf('fake://a', listKey(A))!
  for (const relay of LIST_AB) w.hub.putList(relay, listKey(A), cur.payload, ahead)
  await A.a.renameContact(peers.B.pk, 'later')
  await adv(w, LIST_SETTLE_MS)
  const a = copyOn(A, 'fake://a')
  expect(!!a && a.createdAt > ahead && a.body.c[0][1] === 'later', `the new copy is dated after the one ahead (${a?.createdAt} > ${ahead})`)
  await finish(w)
}

/** S-REC-14: only an old copy answers at the restore; the newer one deletes X at its first merge. */
export async function sRec14(): Promise<void> {
  const w = newWorld()
  const A = makePeer(w, 'A', { bare: true, setup: true, listRelays: LIST_AB })
  const B = makePeer(w, 'B')
  const X = makePeer(w, 'X')
  await A.engine.start()
  await B.engine.start()
  await X.engine.start()
  A.sk = secretFromMnemonic(A.words)
  A.pk = pubkeyOf(A.sk)
  // The hub learns A's list key from findList; seed both copies through a first look.
  w.hub.listFate = () => 'silent'
  await recCode(w, A.a.checkMnemonic(A.words))
  w.hub.listFate = () => 'ok'
  const t = w.clock.now()
  const s = Math.floor(t / 1000)
  w.hub.putList(
    'fake://a',
    listKey(A),
    encodeList({
      v: 1,
      c: [
        [B.pk, 'b', t - 50_000],
        [X.pk, 'x', t - 40_000],
      ],
      d: [],
    }),
    s - 100,
  )
  w.hub.putList('fake://b', listKey(A), encodeList({ v: 1, c: [[B.pk, 'b', t - 50_000]], d: [[X.pk, t - 30_000]] }), s - 50)
  w.hub.listFate = (r, op) => (r === 'fake://b' && op === 'fetch' ? 'silent' : 'ok')
  const r = await restoreWords(A)
  expect(r.found && hasContact(A, X), 'found: true, X comes in from the old copy')
  await adv(w, 10_000)
  w.hub.listFate = () => 'ok'
  await adv(w, 70_000)
  const tombs = A.kv.peek<Record<string, unknown>>('tombstones') ?? {}
  expect(!hasContact(A, X) && tombs[X.pk] !== undefined, "X is deleted at fake://b's first merge")
  expect(sameCopies(A), 'both relays hold the same list')
  expect((A.kv.peek<{ pending: string[] }>('listSync')?.pending ?? ['x']).length === 0, 'nothing pending')
  expect(!A.dumpLog().includes('list changed elsewhere'), 'no changed-elsewhere line (a first merge)')
  // X's channel was opened from the old copy and became a ghost one; that is accepted (recovery 경계 상황).
  w.skip.add('INV-L4')
  await finish(w)
}

/** S-REC-15: only one relay takes the list: not uploaded; back in view both get it. */
export async function sRec15(): Promise<void> {
  const { w, A, peers } = await recWorld(['B'])
  w.hub.listFate = (r, op) => (r === 'fake://b' && op === 'publish' ? 'reject' : 'ok')
  await A.a.renameContact(peers.B.pk, 'name-one')
  await adv(w, 10 * MIN)
  expect(copyOn(A, 'fake://a')?.body.c[0][1] === 'name-one' && copyOn(A, 'fake://b')?.body.c[0][1] !== 'name-one', 'only fake://a holds the new list')
  expect(A.dumpLog().includes('list single relay'), "a 'list single relay' line")
  w.hub.listFate = () => 'ok'
  A.engine.rearmRounds()
  await adv(w, LIST_SETTLE_MS)
  expect(sameCopies(A) && copyOn(A, 'fake://b')?.body.c[0][1] === 'name-one', 'back in view: both relays hold it')
  await finish(w)
}

/** S-REC-16: the same words restored on a second device stop the first at its next open. */
export async function sRec16(): Promise<void> {
  const { w, A, peers } = await recWorld(['B'])
  await adv(w, MIN)
  const A2 = makePeer(w, 'A2', { words: A.words, bare: true, setup: true, listRelays: LIST_AB, device: 'second' })
  await A2.engine.start()
  const r = await restoreWords(A2)
  expect(r.found && hasContact(A2, peers.B), 'A2 restores with B')
  await adv(w, MIN)
  let code = ''
  try {
    await restart(A)
  } catch (e) {
    code = e instanceof Error ? e.message : String(e)
  }
  await adv(w, 10_000)
  expect(A.state().boot === 'error' && A.state().bootError === 'replaced', `A stops with 'replaced' (${A.state().boot} ${A.state().bootError} ${code})`)
  expect(A.kv.peek('replaced') === true, 'and remembers it')
  expect(A.dumpLog().includes('key used on another device'), "a 'key used on another device' line")
  // At every later open it stops before going online.
  code = ''
  try {
    await restart(A)
  } catch (e) {
    code = e instanceof Error ? e.message : String(e)
  }
  expect(code === 'replaced' && A.state().bootError === 'replaced', `the next open stops at once (${code})`)
  // Its owner takes it back with the words: a reset and a restore here (A2 goes away).
  await A2.engine.stop()
  A2.dead = true
  w.hub.wipe(A2.pk, A2.device)
  await onTime(w, A.a.resetAll())
  A.opts.setup = true
  A.kv.close(A.tag, 'stop')
  A.spawn()
  await A.engine.start()
  await restoreWords(A)
  await adv(w, 10_000)
  expect(A.state().boot === 'ready' && hasContact(A, peers.B), 'restored again on the first device: ready, with B')
  await finish(w)
}

/**
 * S-REC-16-LIST: the words are restored on a second device,
 * which changes the list (a rename of C). The first phone then opens: the key-takeover check answers late (the
 * real transport asks the relays), after the list fetch. The start is not held up, the
 * phone stops with 'replaced', and it puts nothing on the list relays: the second device's
 * copy stays on both.
 */
export async function sRec16List(): Promise<void> {
  const { w, A, peers } = await recWorld(['B', 'C'])
  await adv(w, MIN)
  const A2 = makePeer(w, 'A2', { words: A.words, bare: true, setup: true, listRelays: LIST_AB, device: 'second' })
  await A2.engine.start()
  const r = await restoreWords(A2)
  expect(r.found && hasContact(A2, peers.B) && hasContact(A2, peers.C), 'A2 restores with B and C')
  await A2.a.renameContact(peers.C.pk, 'renamed-on-second')
  await adv(w, LIST_SETTLE_MS + 10_000)
  const theirs = ['fake://a', 'fake://b'].map((relay) => copyOn(A, relay))
  expect(
    theirs.every((c) => c?.body.c.some((e) => e[1] === 'renamed-on-second')),
    "both relays hold the second device's list",
  )
  await A2.engine.stop()
  A2.dead = true
  const before = listLogOf(A).length
  w.hub.elsewhereDelayMs = 10_000
  let code = ''
  try {
    await restart(A)
  } catch (e) {
    code = e instanceof Error ? e.message : String(e)
  }
  expect(code === '' && A.state().boot === 'ready', `the start is not held up by the key-takeover check (${code} ${A.state().boot})`)
  await adv(w, 30_000)
  w.hub.elsewhereDelayMs = 0
  // The stopped phone keeps its old rooms; the second device moved the channels.
  w.skip.add('INV-L4')
  expect(A.state().boot === 'error' && A.state().bootError === 'replaced', `A stops with 'replaced' (${A.state().boot} ${A.state().bootError})`)
  expect(listLogOf(A).length === before, `the replaced phone put nothing on the list relays (${listLogOf(A).length - before} attempts)`)
  const after = ['fake://a', 'fake://b'].map((relay) => copyOn(A, relay)?.payload)
  expect(after[0] === theirs[0]?.payload && after[1] === theirs[1]?.payload, "the second device's copies are untouched")
  await finish(w)
}

/**
 * S-REC-LIST-STOP: a list run is waiting for a slow fetch when the engine
 * stops and starts again (a lock and unlock, a restart of the same engine). The new
 * session does not wait on the old run: it syncs once by itself and the change goes up.
 */
export async function sRecListStop(): Promise<void> {
  const { w, A, peers } = await recWorld(['B'])
  w.hub.listFate = (_r, op) => (op === 'fetch' ? 'silent' : 'ok')
  await A.a.renameContact(peers.B.pk, 'while-a-run-waits')
  await adv(w, 3_000)
  w.hub.listFate = () => 'ok'
  await A.engine.stop()
  await A.engine.start()
  await adv(w, 10_000)
  const names = ['fake://a', 'fake://b'].map((relay) => copyOn(A, relay)?.body.c.find((e) => e[0] === peers.B.pk)?.[1])
  expect(
    names.every((n) => n === 'while-a-run-waits'),
    `the new session synced: both relays hold the rename (${names.join(', ')})`,
  )
  await finish(w)
}

/**
 * S-REC-RESCAN (a restore meets a scan): A is restored; B and C came back from the list
 * without a room. Before A's channel step runs, A scans B's QR (B never scans). The channel
 * with B is reopened exactly once (one room, both sides in it), B sees the reopened
 * notice at most once (the noticeAfter rule decides), and once A posts an offer that only B
 * matches, C (selling in another currency) gets nothing.
 */
export async function sRecRescan(aLow: boolean): Promise<void> {
  const [lo, hi] = orderedKeys(2)
  const { w, A, peers } = await recWorld(['B', 'C'], { words: aLow ? lo.words : hi.words, peerWords: { B: aLow ? hi.words : lo.words } })
  const { B, C } = peers
  await B.a.postOffer({ side: 'sell', currency: 'KRW', amountMinor: 90_000, feePct: 3, methods: BOTH })
  await C.a.postOffer({ side: 'sell', currency: 'USD', amountMinor: 50_000, feePct: 1, methods: BOTH })
  await until(w, () => settled(B) && settled(C), 5 * MIN, 'rounds of B and C')
  const old = chanRoom(B, A)
  const r = await recover(A)
  expect(r.found && hasContact(A, B) && chanRoom(A, B) === '', 'A is restored with B, without a room')
  const t0 = w.clock.now()
  await scanOnly(w, A, B)
  expect(A.state().connect.phase === 'already', `A says 'already' (${A.state().connect.phase})`)
  await until(w, () => sameNewRoom(A, B, old), CHANNEL_CHECK, 'A and B share a new room')
  await adv(w, HOLDER_SCAN_TTL_MS + 2 * MIN)
  const ab = w.hub.invites.filter((x) => x.atMs >= t0 && ((x.from === A.pk && x.to === B.pk) || (x.from === B.pk && x.to === A.pk)))
  const joined = ab.filter((x) => x.accepted)
  expect(joined.length === 1, `the channel was reopened once: one room joined (${ab.length} made, ${joined.length} joined)`)
  expect(chanRoom(A, B) === joined[0]?.groupId && chanRoom(B, A) === joined[0]?.groupId, 'both sides are in that room')
  const lines = (B.state().rooms[A.pk] ?? []).filter((m) => m.kind === 'reopened').length
  expect(lines <= 1, `B sees the reopened line at most once (${lines})`)
  await A.a.postOffer({ side: 'buy', currency: 'KRW', amountMinor: AMOUNT, feePct: FEE, methods: BOTH })
  await until(w, () => converged(A, B), 5 * MIN, 'A and B match')
  await adv(w, 30_000)
  expect(!matched(A, C) && !matched(C, A), 'C matches nobody')
  expectNoLeakToC(w, A, B, C)
  await finish(w)
}

/**
 * S-REC-RESCAN-TWIN (the deleted side cannot tell, also across a scan): A is restored in both worlds (world 1
 * keeps B, world 2 deleted B before the restore); then B scans A's QR. A's envelopes to B,
 * its support log and B's reopened lines are the same in both worlds.
 */
export async function sRecRescanTwin(aLow: boolean): Promise<void> {
  const script: TwinScript = {
    b: [],
    a: [
      { atMs: LIST_SETTLE_MS, act: async (p) => void (await recover(p)) },
      {
        atMs: LIST_SETTLE_MS + MIN,
        act: async (p) => {
          const B = p.world.peers.find((q) => q.name === 'B')
          if (B) await scanOnly(p.world, B, p)
        },
      },
      { atMs: 30 * MIN, act: async () => {} },
    ],
  }
  const r = await twin(script, { aLow, around: true, listRelays: LIST_AB })
  expectSameEnvelopes(r.seqs)
  const lines = r.b.map((b, i) => (b.state().rooms[r.a[i].pk] ?? []).filter((m) => m.kind === 'reopened').length)
  expect(lines[0] === lines[1] && lines[0] <= 1, `B's reopened lines are the same in both worlds, at most one (${lines.join(' / ')})`)
  expect(!hasContact(r.a[1], r.b[1]) && hasContact(r.a[0], r.b[0]), 'world 2: the restored A has B as a tombstone, world 1 as a contact')
  for (const w of r.worlds) await finish(w)
}

/**
 * S-REC-DONE (a restore meets S-DLV-19): A and B matched; B got A's
 * on-chain address, and A's completion is 'failed' in the old room. A's phone is lost
 * and restored. The restored A's rooms are empty and it sends no completion for a trade
 * it has no record of (no try at all, refused ones included); the done sheet's wording
 * comes only from tradeView: on-chain on the old phone (doneNotice1Onchain), the plain
 * one on the restored phone, which has no card. C, matching nobody, gets nothing.
 */
export async function sRecDone(): Promise<void> {
  const { w, A, B, C } = await reopenTrio({ listA: true, rates: true })
  await adv(w, LIST_SETTLE_MS)
  const old = chanRoom(A, B)
  await sendsOne(w, A, B, { method: 'onchain', amountMinor: 10_000, address: ADDR_WPKH }, 'A sends where it receives')
  const before = tradeView(A.state(), B.pk, w.clock.now())
  expect(before.activeKind === 'onchain' && payCopy(before.activeKind, before.methods).doneNotice === 'doneNotice1Onchain', `the old phone's done sheet says on-chain (${before.activeKind})`)
  const tries: { at: number; t: string; g: string }[] = []
  w.hub.failSend = (from, g, msg) => {
    if (from !== A.pk) return false
    tries.push({ at: w.clock.now(), t: msg.t, g })
    return msg.t === 'done' ? 'reject' : false
  }
  await A.a.markDone(B.pk, 10_000)
  await adv(w, 5_000)
  expect(statusOf(dones(A, B, true)[0]) === 'failed', `A's completion failed in the old room (${statusOf(dones(A, B, true)[0])})`)
  const r = await recover(A)
  const t1 = w.clock.now()
  expect(r.found && hasContact(A, B), 'A is restored with B')
  const rooms = A.state().rooms
  expect(
    Object.values(rooms).every((list) => list.length === 0),
    `the restored A's rooms are empty (${Object.values(rooms)
      .map((l) => l.length)
      .join(',')})`,
  )
  await until(w, () => sameNewRoom(A, B, old), CHANNEL_CHECK, 'the channel with B is reopened')
  await adv(w, 5 * MIN)
  const doneTries = tries.filter((x) => x.t === 'done' && x.at >= t1)
  expect(doneTries.length === 0 && sent(w, A, B, 'done').filter((e) => e.atMs >= t1).length === 0, `no completion from the restored A, refused ones included (${doneTries.length})`)
  expect(dones(B, A, false).length === 0, 'B never got the completion the lost phone held')
  expect(dones(A, B, true).length === 0, 'the restored A holds no completion record')
  const after = tradeView(A.state(), B.pk, w.clock.now())
  const words = payCopy(after.activeKind, after.methods)
  expect(after.activeKind === null && words.doneNotice === 'doneNotice1', `the restored phone has no card, so its done sheet has the plain words (${after.activeKind} ${words.doneNotice})`)
  // B keeps its chat with A (the side that gets the reopened notice): the address card stays there, in its
  // on-chain words only while B's own tradeView holds it active.
  const theirs = tradeView(B.state(), A.pk, w.clock.now())
  expect(theirs.activeKind !== 'lightning', `B's view of A has no Lightning card (${theirs.activeKind})`)
  expectNoLeakToC(w, A, B, C)
  await finish(w)
}

/**
 * S-REC-MERGE-STOP: a relay answers for the first time after the
 * restore and its copy is merged; the app stops (a lock) the moment the merged contacts are
 * written. The relay's move from pending to merged is stored with that merge: once the
 * merged contacts are in the store, the relay is no longer pending.
 */
export async function sRecMergeStop(): Promise<void> {
  const { w, A, peers } = await recWorld(['B', 'C'])
  w.hub.loseList('fake://a', listKey(A))
  w.hub.listFate = (r, op) => (r === 'fake://b' && op === 'fetch' ? 'silent' : 'ok')
  const r = await recover(A, { anyway: true })
  expect(!r.found && (A.kv.peek<{ pending: string[] }>('listSync')?.pending ?? []).join() === 'fake://b', 'restored without a list, fake://b pending')
  w.hub.listFate = () => 'ok'
  let stoppedAt = -1
  A.kv.onWrite = (x, value) => {
    if (stoppedAt >= 0 || x.key !== 'contacts' || !Array.isArray(value) || !value.some((c) => (c as { pubkey?: string }).pubkey === peers.B.pk)) return
    stoppedAt = w.clock.now()
    void A.engine.stop()
  }
  A.engine.rearmRounds()
  await adv(w, 10_000)
  A.kv.onWrite = undefined
  expect(stoppedAt >= 0, 'the merge of fake://b wrote B and the app stopped right then')
  const pending = A.kv.peek<{ pending: string[] }>('listSync')?.pending ?? ['none']
  expect(!pending.includes('fake://b'), `the merged relay is no longer pending (${pending.join(',')})`)
  A.dead = true
  w.skip.add('INV-L4')
  await finish(w)
}

/** S-REC-DAMAGED-CONTACTS: a damaged contacts item opens empty; the relays' copies bring the list back. */
export async function sRecDamagedContacts(): Promise<void> {
  const { w, A, peers } = await recWorld(['B', 'C'])
  await deleteContact(w, A, peers.C)
  await adv(w, LIST_SETTLE_MS)
  await A.engine.stop()
  A.kv.close(A.tag, 'stop')
  A.dead = true
  A.kv.damage('contacts')
  A.spawn()
  await A.engine.start()
  await adv(w, 10_000)
  expect(A.state().boot === 'ready', `the app opens (${A.state().boot})`)
  expect(phoneWho(A) === who({ c: [[peers.B.pk]], d: [[peers.C.pk]] }), `B and the deleted C come back (${phoneWho(A)})`)
  expect(A.dumpLog().includes('damaged: contact-list'), "a 'damaged: contact-list' line")
  // The contact came back without its room on this device: its channel is reopened.
  await until(w, () => sameNewRoom(A, peers.B), 10 * MIN, 'A reopens its channel with B')
  await finish(w)
}

/** S-REC-DAMAGED-TOMBSTONES: only the tombstones item is damaged: the contacts stay, the deleted C comes back. */
export async function sRecDamagedTombstones(): Promise<void> {
  const { w, A, peers } = await recWorld(['B', 'C'])
  await deleteContact(w, A, peers.C)
  await adv(w, LIST_SETTLE_MS)
  await A.engine.stop()
  A.kv.close(A.tag, 'stop')
  A.dead = true
  A.kv.damage('tombstones')
  A.spawn()
  await A.engine.start()
  await adv(w, 10_000)
  expect(A.state().boot === 'ready', `the app opens (${A.state().boot})`)
  expect(phoneWho(A) === who({ c: [[peers.B.pk]], d: [[peers.C.pk]] }), `B stays and the deleted C comes back as a tombstone (${phoneWho(A)})`)
  expect(!hasContact(A, peers.C), 'C is not a contact again')
  const lines = A.dumpLog().split('damaged: contact-list').length - 1
  expect(lines === 1, `one 'damaged: contact-list' line (${lines})`)
  expect((A.kv.peek<{ pending: string[] }>('listSync')?.pending ?? ['x']).length === 0, 'both list relays were merged')
  await finish(w)
}

/**
 * S-REC-RETRY: the store fails once at restoreIdentity (a cancelled passkey, a broken
 * store). The checked words are kept: the same call again restores without a new check.
 */
export async function sRecRetry(): Promise<void> {
  const { w, A, peers } = await recWorld(['B'])
  const pk = A.pk
  await A.engine.stop()
  A.kv.close(A.tag, 'stop')
  w.hub.wipe(A.pk, A.device)
  const kv = createHarnessKV()
  w.kvs.push(kv)
  A.kv = kv
  A.device = `recovered${++recoverCount}`
  A.opts.setup = true
  A.spawn()
  await A.engine.start()
  expect(A.state().boot === 'setup', `A waits in setup (${A.state().boot})`)
  const r = await onTime(w, A.a.checkMnemonic(A.words), 30_000)
  expect(r.found, 'found: true')
  const checks = () => A.events.filter((e) => e.event === 'restore-check').length
  const before = checks()
  A.kv.failNext('identity')
  const code = await recCode(w, A.a.restoreIdentity(A.words, { method: 'none' }))
  expect(code !== '', 'the first restoreIdentity rejects')
  expect(A.state().boot === 'setup', `A is still in setup (${A.state().boot})`)
  expect(A.kv.peek('identity') === undefined, 'no identity was stored')
  await onTime(w, A.a.restoreIdentity(A.words, { method: 'none' }), 60_000)
  expect(A.state().boot === 'ready', `the retry restores (${A.state().boot})`)
  expect(checks() === before, 'no second checkMnemonic was needed')
  expect(A.state().me?.pubkey === pk && hasContact(A, peers.B), 'the same key and B come back')
  await rejectsWith(() => A.a.restoreIdentity(A.words, { method: 'none' }), 'not-allowed', 'a restore once ready')
  await until(w, () => sameNewRoom(A, peers.B), 10 * MIN, 'A reopens its channel with B')
  await finish(w)
}

/**
 * S-BOT-LIST-INSERT: a thief with A's key writes "3 deleted + a fake X" to A's relays.
 * A has never been restored: nothing is merged, A keeps its 5 contacts and puts its list back.
 */
export async function sBotListInsert(): Promise<void> {
  const { w, A, peers } = await recWorld(['B', 'C', 'D', 'E', 'F'])
  const keep = phoneWho(A)
  const X = makePeer(w, 'X')
  const t = w.clock.now()
  const ps = Object.values(peers)
  w.hub.injectListCopy(A.pk, {
    v: 1,
    c: [
      [ps[0].pk, 'b', t - 1000],
      [X.pk, 'x', t - 1000],
    ],
    d: ps.slice(1, 4).map((p) => [p.pk, t] as [string, number]),
  })
  await restart(A)
  await adv(w, 10_000)
  expect(phoneWho(A) === keep && !hasContact(A, X), `A keeps its 5 contacts and has no X (${phoneWho(A)})`)
  expect(who(copyOn(A, 'fake://a')?.body) === keep && sameCopies(A), 'A puts its own list back')
  expect(A.dumpLog().includes('list changed elsewhere'), "a 'list changed elsewhere' line")
  await finish(w)
}

/**
 * S-REC-13 (with channel's twin): world 1 A keeps B, world 2 A deleted B; A
 * is restored from the 12 words in both. B gets the same envelopes and the same reopened-notice
 * lines; the list events are not compared.
 */
export async function sRec13(aLow: boolean): Promise<void> {
  const script: TwinScript = {
    b: [{ atMs: 3 * MIN, act: (p) => p.a.postOffer({ side: 'buy', currency: 'KRW', amountMinor: 90000, feePct: 3, methods: BOTH }) }],
    a: [
      { atMs: LIST_SETTLE_MS, act: async (p) => void (await recover(p)) },
      { atMs: 30 * MIN, act: async () => {} },
    ],
  }
  const r = await twin(script, { aLow, around: true, listRelays: LIST_AB })
  expectSameEnvelopes(r.seqs)
  const lines = r.b.map((b, i) => (b.state().rooms[r.a[i].pk] ?? []).filter((m) => m.kind === 'reopened').length)
  expect(lines[0] === lines[1], `B's reopened lines are the same in both worlds (${lines.join(' / ')})`)
  expect(!hasContact(r.a[1], r.b[1]) && hasContact(r.a[0], r.b[0]), 'world 2: the restored A has B as a tombstone, world 1 as a contact')
  for (const w of r.worlds) await finish(w)
}
