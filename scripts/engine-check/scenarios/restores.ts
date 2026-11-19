/**
 * Engine check scenarios: restores, lost rooms, moves, spam.
 * Run from scripts/check-engine.ts, which lists every scenario in its order.
 */
import type { Transport } from '../../../src/contracts'
import { HOLDER_SCAN_TTL_MS } from '../../../src/engine/index'
import { randomHex } from '../../../src/lib/marmot/keys'
import type { FakeHub, KvWrite } from '../../fake-transport'
import {
  CHANNEL_CHECK,
  chanRec,
  chanRoom,
  dropThief,
  expectSameEnvelopes,
  expectWorking,
  hasText,
  invitesOf,
  linkedPair,
  off,
  on,
  payloadKp,
  restore,
  restoredKv,
  sameNewRoom,
  scanOnly,
  skew,
  thiefOf,
} from '../helpers/channel'
import { type TwinScript, expectSameInvites, twin } from '../helpers/twin'
import { Fail, errText, expect } from '../report'
import { BOTH, MIN, type Peer, START_MS, type World, adv, deleteContact, finish, hasContact, link, makePeer, newWorld, orderedKeys, powerOff, restart, sent, until } from '../world'

/**
 * S-CH-RESTORE-L / -H: A is restored (the lower key, or the higher one). A and B end in
 * one new room; A keeps B's name from its list, B keeps the chat; chats and matching work.
 */
export async function sChRestore(aLow: boolean): Promise<void> {
  const { w, A, B } = await linkedPair(aLow)
  const old = chanRoom(B, A)
  const t0 = w.clock.now()
  await restore(A)
  await adv(w, 3 * MIN)
  expect(sameNewRoom(A, B, old), `A and B share a new room (A ${chanRoom(A, B).slice(0, 6)}, B ${chanRoom(B, A).slice(0, 6)})`)
  expect(A.state().contacts.find((c) => c.pubkey === B.pk)?.name === '비', "A still calls B '비' (from its list)")
  expect(hasText(B, A, 'one') && hasText(B, A, 'two'), "B's chat with A stays")
  const ab = invitesOf(w, A, B, t0)
  const ba = invitesOf(w, B, A, t0)
  if (aLow) {
    expect(ab.length === 1 && ab[0].accepted && ba.length === 0, `A (lower) made one room, B joined it, B asked nothing (A→B ${ab.length}, B→A ${ba.length})`)
  } else {
    expect(ab.length === 1 && !ab[0].accepted, `A (higher) asked once and its Welcome was not joined (${ab.length})`)
    expect(ba.length === 1 && ba[0].accepted, `B (lower) made one room for A and A joined it (${ba.length})`)
  }
  // The lower side's pending is cleared by the next channel check once the peer is in.
  await adv(w, 10 * MIN)
  const lower = aLow ? A : B
  const higher = aLow ? B : A
  expect(chanRec(lower, higher)?.pending === undefined, 'the room the lower key made is no longer pending')
  await expectWorking(w, A, B, 'restore')
  await finish(w)
}

/** S-CH-BOTH-LOST: both restored at the same moment. One room in the end, made by L; L made at most 2. */
export async function sChBothLost(): Promise<void> {
  const { w, A, B } = await linkedPair(true)
  const old = chanRoom(A, B)
  const t0 = w.clock.now()
  await Promise.all([restore(A), restore(B)])
  await until(w, () => sameNewRoom(A, B, old), 3 * MIN, 'both restored ones share a new room')
  await adv(w, 3 * MIN)
  expect(sameNewRoom(A, B, old), 'and stay there')
  expect(invitesOf(w, A, B, t0).length <= 2, `L made at most 2 rooms (${invitesOf(w, A, B, t0).length})`)
  await expectWorking(w, A, B, 'both')
  await finish(w)
}

/** S-CH-ROOM-LOST: B's device loses the room (B the lower key, or the higher one). */
export async function sChRoomLost(bLow: boolean): Promise<void> {
  const { w, A, B } = await linkedPair(!bLow)
  const old = chanRoom(A, B)
  w.hub.loseGroup(B.pk, old)
  await until(w, () => sameNewRoom(A, B, old), CHANNEL_CHECK, 'a new room within one channel check')
  await adv(w, MIN)
  expect(A.state().contacts.find((c) => c.pubkey === B.pk)?.name === '비' && hasText(A, B, 'two') && hasText(B, A, 'one'), 'names and chats stay')
  await expectWorking(w, A, B, 'lost')
  await finish(w)
}

/** S-CH-STRANDED: the room's relays stay out of reach (at once a broken room). */
export async function sChStranded(): Promise<void> {
  const { w, A, B } = await linkedPair(true)
  const old = chanRoom(A, B)
  w.hub.strand(old)
  await adv(w, 20 * MIN)
  expect(sameNewRoom(A, B, old), 'both moved to a new room')
  expect(!w.hub.groupsOf(A.pk).includes(old) && !w.hub.groupsOf(B.pk).includes(old), 'the stranded room is gone from both')
  await expectWorking(w, A, B, 'stranded')
  await finish(w)
}

/** S-CH-STALE: H is off while L makes R1, loses it and makes R2. H joins R2 only. */
export async function sChStale(): Promise<void> {
  const { w, A: L, B: H } = await linkedPair(true)
  const old = chanRoom(L, H)
  await off(H)
  w.hub.loseGroup(L.pk, old)
  await until(w, () => chanRoom(L, H) !== old, MIN, 'L made R1')
  const r1 = chanRoom(L, H)
  w.hub.loseGroup(L.pk, r1)
  await until(w, () => chanRoom(L, H) !== r1, 10 * MIN, 'L made R2')
  const r2 = chanRoom(L, H)
  await adv(w, MIN)
  await on(H)
  await until(w, () => chanRoom(H, L) === r2, MIN, 'H joins R2')
  await adv(w, MIN)
  const rec1 = w.hub.invites.find((r) => r.groupId === r1)
  expect(rec1 !== undefined && !rec1.accepted, 'R1 was never joined')
  expect(sameNewRoom(L, H, old), 'one room')
  await finish(w)
}

/**
 * S-CH-LOST-WELCOME: H is off and L is restored. (a) L's Welcome is lost at the relays,
 * (b) it is made for a key package H no longer has when it comes back, (c) L's invite call
 * fails after delivering it. Within 2 days one room; L made 2 rooms in (a)(b), 3 at most in (c).
 */
export async function sChLostWelcome(kind: 'a' | 'b' | 'c'): Promise<void> {
  const { w, A: L, B: H } = await linkedPair(true)
  const old = chanRoom(L, H)
  await off(H)
  const t0 = w.clock.now()
  if (kind === 'a') w.hub.dropInvite((r) => r.from === L.pk && r.to === H.pk)
  if (kind === 'c') w.hub.inviteFate(L.pk, 'deliver-then-throw')
  await restore(L)
  await until(w, () => invitesOf(w, L, H, t0).length >= 1 && chanRoom(L, H) !== '', MIN, "L's first new room")
  if (kind === 'b') w.hub.rotateKeyPackage(H.pk)
  await adv(w, 10 * MIN)
  await on(H)
  await until(w, () => sameNewRoom(L, H, old), 2 * 24 * 60 * MIN, 'one room within 2 days')
  const made = invitesOf(w, L, H, t0).length
  expect(made <= (kind === 'c' ? 3 : 2), `L made ${made} room(s)`)
  await adv(w, 15 * MIN)
  await finish(w)
}

/**
 * S-CH-SKEW-RESTORE: the old phone of L (5 minutes ahead) lost its room and made R1; a
 * minute later L is restored on a phone with a right clock. Within 2 days one room, no errors.
 * (The engine stores min(sentAt, my now) for room R1, so room R2 is not ignored as the
 * channel body expected; the end state is the same.)
 */
export async function sChSkewRestore(): Promise<void> {
  const { w, A: L, B: H } = await linkedPair(true)
  const old = chanRoom(L, H)
  skew(L, 5 * MIN)
  w.hub.loseGroup(L.pk, old)
  await until(w, () => chanRoom(H, L) !== old && chanRoom(H, L) === chanRoom(L, H), 2 * MIN, 'H moved to R1')
  await adv(w, MIN)
  skew(L, 0)
  await restore(L)
  await until(w, () => sameNewRoom(L, H, old) && chanRec(L, H)?.pending === undefined, 2 * 24 * 60 * MIN, 'one room within 2 days')
  const errors = [...L.events, ...H.events].filter((e) => e.event === 'task-error')
  expect(errors.length === 0, `no task errors (${JSON.stringify(errors[0]?.info)})`)
  await finish(w)
}

/** One move run for S-CH-CRASH-MOVE: A restored (A lower when aLow), X's KV armed right after the restore. */
async function moveRun(
  keys: { words: string }[],
  aLow: boolean,
  side: 'A' | 'B',
  crashAt: number | ((x: KvWrite, value: unknown) => boolean) | null,
): Promise<{ w: World; A: Peer; B: Peer; X: Peer; crashed: boolean; tag: string; old: string; armedAt: number }> {
  const w = newWorld()
  const [lo, hi] = keys
  const A = makePeer(w, 'A', { words: aLow ? lo.words : hi.words })
  const B = makePeer(w, 'B', { words: aLow ? hi.words : lo.words })
  await A.engine.start()
  await B.engine.start()
  await link(w, A, B)
  await A.a.sendChat(B.pk, 'one')
  await adv(w, 5_000)
  await B.a.sendChat(A.pk, 'two')
  await adv(w, 30_000)
  const old = chanRoom(B, A)
  await restore(A, { start: false })
  const X = side === 'A' ? A : B
  const tag = X.tag
  const armedAt = X.kv.writes.length
  let crashed = false
  const crashP =
    crashAt === null
      ? new Promise<void>(() => {})
      : (typeof crashAt === 'number' ? X.kv.crashAfter(crashAt) : X.kv.crashWhen(crashAt)).then(() => {
          crashed = true
          powerOff(X)
        })
  await Promise.race([A.engine.start(), crashP])
  await until(w, () => crashed || (sameNewRoom(A, B, old) && chanRec(aLow ? A : B, aLow ? B : A)?.pending === undefined), 15 * MIN, 'the move ends')
  return { w, A, B, X, crashed, tag, old, armedAt }
}

/**
 * S-CH-CRASH-MOVE: the power goes off before each write of the moving peer during a
 * reopen (A restored as L or as H; the crash on A's side or on B's). Every time: a new
 * engine on the same store, and within 10 minutes one room, no errors, no late writes.
 * Also: H joined L's room and stops before the bind is stored, back after 30 s: L makes
 * R2 and R3, no more.
 */
export async function sChCrashMove(): Promise<void> {
  const keys = orderedKeys(2)
  for (const aLow of [true, false]) {
    for (const side of ['A', 'B'] as const) {
      const base = await moveRun(keys, aLow, side, null)
      // X's writes from the arm (right after the restore) to the end of the move.
      const total = base.X.kv.writes.slice(base.armedAt).filter((x) => x.tag === base.tag).length
      await finish(base.w)
      expect(total > 3, `${aLow ? 'L' : 'H'} restored, crash on ${side}: the move writes (${total})`)
      for (let n = 0; n < total; n++) {
        const what = `${aLow ? 'L' : 'H'} restored, crash on ${side} before write ${n + 1}`
        const r = await moveRun(keys, aLow, side, n)
        expect(r.crashed, `${what}: the power went off at that write`)
        r.X.spawn()
        try {
          await r.X.engine.start()
          await until(r.w, () => sameNewRoom(r.A, r.B, r.old), 10 * MIN, 'one room again')
          await adv(r.w, MIN)
        } catch (e) {
          throw new Fail(`${what}: ${errText(e)}`)
        }
        const errors = r.X.events.filter((e) => e.tag === r.X.tag && e.event === 'task-error')
        expect(errors.length === 0, `${what}: the new engine ran without errors (${JSON.stringify(errors[0]?.info)})`)
        try {
          await finish(r.w)
        } catch (e) {
          throw new Fail(`${what}: ${errText(e)}`)
        }
      }
    }
  }
  // H (B) joined A's room and stops before its bind is stored; back 30 s later.
  let joinedRoom = ''
  const isBind = (x: KvWrite, value: unknown): boolean => {
    if (x.key !== 'contacts' || !Array.isArray(value)) return false
    const g = (value as { groupId: string | null }[])[0]?.groupId ?? ''
    if (joinedRoom === '' && g !== '') joinedRoom = g
    return g !== joinedRoom
  }
  const r = await moveRun(keys, true, 'B', (x, v) => {
    // The first contacts write of B after the arm still names the old room (moving).
    return isBind(x, v)
  })
  expect(r.crashed, 'the bind write was where the power went off')
  const t0 = START_MS
  await adv(r.w, 30_000)
  r.B.spawn()
  await r.B.engine.start()
  await until(r.w, () => sameNewRoom(r.A, r.B, r.old), 10 * MIN, 'one room after the late bind')
  const made = invitesOf(r.w, r.A, r.B, t0).filter((x) => x.fromDevice !== 'main')
  expect(made.length === 2, `A (restored L) made R2 and R3 (${made.length})`)
  await finish(r.w)
}

/** A call of a raw transport, which waits on the virtual clock: time moves 100 ms meanwhile. */
async function onClock<T>(w: World, call: Promise<T>): Promise<T> {
  await adv(w, 100)
  return call
}

/** A transport of `p`'s key that no engine drives (a malicious contact), on p's device. */
async function rawTransport(p: Peer): Promise<Transport> {
  const t = p.world.hub.marmot(p.device).createTransport({
    secretKeyHex: p.sk,
    relays: ['fake://relay'],
    namespace: `raw:${p.name}`,
    persistence: 'memory',
    tables: {
      table: () => {
        throw new Error('the fake transport keeps no tables')
      },
    },
  })
  await t.start()
  return t
}

/**
 * S-CH-SPAM-MOVE: a malicious lower-key contact M sends A a new room 20 times in an hour.
 * A moves at most twice in 24 hours, asks M once when the window opens and sits in the
 * room M makes for that. A sends M nothing but round answers. Twin: the same when A
 * deleted M (A→M envelopes and A's invites).
 */
export async function sChSpamMove(): Promise<void> {
  const [lo, hi] = orderedKeys(2)
  const worlds: World[] = []
  const as: Peer[] = []
  const ms: Peer[] = []
  for (const which of [1, 2]) {
    const w = newWorld()
    const M = makePeer(w, 'M', { words: lo.words })
    const A = makePeer(w, 'A', { words: hi.words })
    await M.engine.start()
    await A.engine.start()
    await link(w, A, M)
    await M.a.sendChat(A.pk, 'hi')
    await adv(w, 5_000)
    await A.a.sendChat(M.pk, 'hi')
    await adv(w, 30_000)
    await off(M)
    const tm = await rawTransport(M)
    if (which === 2) await deleteContact(w, A, M)
    const t0 = w.clock.now()
    for (let i = 0; i < 20; i++) {
      await onClock(w, tm.invitePeer(A.pk))
      await adv(w, 3 * MIN)
    }
    const joined = () => w.hub.invites.filter((r) => r.from === M.pk && r.to === A.pk && r.accepted && r.atMs >= t0)
    expect(joined().length <= 2, `world ${which}: A moved at most twice in the spam hour (${joined().length})`)
    const firstMove = joined()[0]?.acceptedAtMs ?? t0
    // A asks once the 24 h window of its first move opens.
    await until(w, () => invitesOf(w, A, M, t0).length >= 1, 25 * 60 * MIN, `world ${which}: A asks M for a room`)
    const asked = invitesOf(w, A, M, t0)
    expect(asked.length === 1 && asked[0].atMs >= firstMove + 24 * 60 * MIN, `world ${which}: one request, when the window opened (${asked.length})`)
    expect(joined().length <= 2, `world ${which}: still at most two moves in 24 hours`)
    // M answers that request with a room; A sits in it.
    const { groupId } = await onClock(w, tm.invitePeer(A.pk))
    await until(w, () => chanRoom(A, M) === groupId, MIN, `world ${which}: A joins the room M made for its request`)
    await adv(w, MIN)
    const toM = sent(w, A, M).filter((e) => e.atMs >= t0)
    expect(
      toM.every((e) => e.t === 'm2' || e.t === 'mx'),
      `world ${which}: A sends M round answers only (${toM.map((e) => e.t).join(',')})`,
    )
    await tm.stop()
    worlds.push(w)
    as.push(A)
    ms.push(M)
  }
  const [s1, s2] = worlds.map((w, i) => sent(w, as[i], ms[i]).map((e) => `${e.t}@${e.atMs - START_MS}:${e.json.length}`))
  expect(s1.join() === s2.join(), `A→M envelopes are the same in both worlds (${s1.length} / ${s2.length})`)
  expectSameInvites(worlds as [World, World], as)
  for (const w of worlds) await finish(w)
}

/** S-CH-SPAM-REQ: a malicious higher-key contact asks 20 times: A makes at most one room a minute, two a day. */
export async function sChSpamReq(): Promise<void> {
  const { w, A, B: M } = await linkedPair(true)
  await off(M)
  const tm = await rawTransport(M)
  const t0 = w.clock.now()
  for (let i = 0; i < 20; i++) {
    const { groupId } = await onClock(w, tm.invitePeer(A.pk))
    await tm.forgetGroup(groupId)
    await adv(w, 10_000)
  }
  await adv(w, 23 * 60 * MIN)
  const made = invitesOf(w, A, M, t0)
  expect(made.length >= 1 && made.length <= 2, `A made 1 to 2 rooms in 23 hours (${made.length})`)
  for (let i = 1; i < made.length; i++) expect(made[i].atMs - made[i - 1].atMs >= MIN, 'at most one room a minute')
  await tm.stop()
  // M's device keeps the rooms it never joined; it is not checked (a raw transport).
  await finish(w)
}

/**
 * S-CH-QUIET: B deleted the app (never runs again) and A's room breaks. A restarts five
 * times a day for 10 days. As L, A makes 3 rooms at most; as H, A asks at most 7 times
 * the first day (CHANNEL_RETRY_MS: 0, 1 m, 11 m, 1 h 11 m, 7 h 11 m, 13 h 11 m, 19 h 11 m)
 * and at most once a day after.
 */
export async function sChQuiet(aLow: boolean): Promise<void> {
  const { w, A, B } = await linkedPair(aLow)
  await off(B)
  const t0 = w.clock.now()
  w.hub.loseGroup(A.pk, chanRoom(A, B))
  for (let day = 0; day < 10; day++) {
    for (let k = 0; k < 5; k++) {
      await adv(w, (24 * 60 * MIN) / 5)
      await restart(A)
    }
  }
  const mine = invitesOf(w, A, B, t0)
  if (aLow) {
    expect(mine.length <= 3, `A (L) made ${mine.length} rooms in 10 days`)
  } else {
    const day = 24 * 60 * MIN
    const first = mine.filter((r) => r.atMs < t0 + day).length
    expect(first <= 7, `A (H) asked ${first} times the first day`)
    for (let d = 1; d < 10; d++) {
      const n = mine.filter((r) => r.atMs >= t0 + d * day && r.atMs < t0 + (d + 1) * day).length
      expect(n <= 1, `A (H) asked ${n} times on day ${d + 1}`)
    }
  }
  // B never comes back: A and B stay apart (INV-L4 only compares running peers).
  await finish(w)
}

/**
 * S-CH-STRANGER: Welcomes of keys that are no contact, lower and higher, also from far in
 * the future. A joins nothing, keeps nothing (it showed no code) and uploads nothing.
 */
export async function sChStranger(): Promise<void> {
  const { w, A, B } = await linkedPair(true)
  // Past the codes A showed for the link: a stranger's Welcome is not even kept.
  await adv(w, 11 * MIN)
  const groups = w.hub.groupsOf(A.pk).join()
  const t0 = w.clock.now()
  const recs = [
    ...w.hub.injectInvites(6, A.pk),
    w.hub.injectInvite('0'.repeat(63) + '1', A.pk, { sentAt: Math.floor(t0 / 1000) + 10 * 365 * 24 * 3600 }),
    // Odd room info: never even looked at, a stranger is not a contact.
    ...oddRooms('0'.repeat(63) + '2').map((o) => w.hub.injectInvite('0'.repeat(63) + '2', A.pk, o)),
    ...oddRooms('f'.repeat(63) + 'e').map((o) => w.hub.injectInvite('f'.repeat(63) + 'e', A.pk, o)),
  ]
  await adv(w, MIN)
  expect(
    recs.every((r) => !r.accepted && r.dropped),
    'every stranger Welcome is marked read at once, none joined',
  )
  expect(A.engine.sizes().buffered === 0, 'A keeps none of them (no code shown lately)')
  expect(w.hub.groupsOf(A.pk).join() === groups && A.state().contacts.length === 1, 'no new room, no new contact')
  expect(!w.hub.log.some((e) => e.from === A.pk && e.atMs >= t0) && invitesOf(w, A, B, t0).length === 0, 'A uploaded nothing')
  await finish(w)
}

/** Room info an honest app never makes: each one is refused before joining. */
function oddRooms(from: string): { relays?: string[]; admins?: string[] }[] {
  return [
    { admins: [from, 'a'.repeat(64)] },
    { admins: ['a'.repeat(64)] },
    { relays: ['ws://relay.example.com'] },
    { relays: ['wss://203.0.113.7'] },
    { relays: ['wss://relay.home.arpa'] },
    { relays: Array.from({ length: 9 }, (_, i) => `wss://r${i}.example.com`) },
    { relays: [] },
  ]
}

/**
 * S-CH-ODD-ROOM: the lower-key contact M (or a thief with M's key) moves A's channel into
 * rooms whose info is odd: two admins, an admin who is not the sender, a ws:// relay, an IP
 * address, a private host, nine relays, none. A joins none of them (the pre-join check),
 * keeps the old room, then asks M for a fresh room and
 * sits in the room M makes. Twin: the same when A deleted M.
 */
export async function sChOddRoom(): Promise<void> {
  const [lo, hi] = orderedKeys(2)
  const worlds: World[] = []
  const as: Peer[] = []
  const ms: Peer[] = []
  for (const which of [1, 2]) {
    const w = newWorld()
    const M = makePeer(w, 'M', { words: lo.words })
    const A = makePeer(w, 'A', { words: hi.words })
    await M.engine.start()
    await A.engine.start()
    await link(w, A, M)
    await adv(w, 30_000)
    if (which === 2) await deleteContact(w, A, M)
    const old = chanRoom(A, M)
    const groups = w.hub.groupsOf(A.pk).join()
    await off(M)
    const t0 = w.clock.now()
    const recs: FakeHub['invites'][number][] = []
    for (const o of oddRooms(M.pk)) {
      await adv(w, 2_000)
      recs.push(w.hub.injectInvite(M.pk, A.pk, o))
      await adv(w, 10_000)
    }
    expect(
      recs.every((r) => !r.accepted && r.dropped),
      `world ${which}: no odd room is joined, each is marked read`,
    )
    expect(chanRoom(A, M) === old && w.hub.groupsOf(A.pk).join() === groups, `world ${which}: A keeps its room and is in no new group`)
    await on(M)
    await until(w, () => sameNewRoom(A, M, old), 30 * MIN, `world ${which}: A asks and sits in the room M makes`)
    expect(invitesOf(w, A, M, t0).length >= 1, `world ${which}: A asked M for a fresh room`)
    // M may answer each request A sent while M was off with its own room, a minute apart:
    // they settle on one room.
    await adv(w, 10 * MIN)
    expect(sameNewRoom(A, M, old), `world ${which}: A and M end in one new room`)
    worlds.push(w)
    as.push(A)
    ms.push(M)
  }
  const [s1, s2] = worlds.map((w, i) => sent(w, as[i], ms[i]).map((e) => `${e.t}@${e.atMs - START_MS}:${e.json.length}`))
  expect(s1.join() === s2.join(), `A→M envelopes are the same in both worlds (${s1.length} / ${s2.length})`)
  expectSameInvites(worlds as [World, World], as)
  for (const w of worlds) await finish(w)
}

/**
 * S-CH-TWIN-RESTORE: B is restored; A keeps B (world 1) or deleted B (world 2). A's rooms
 * with C and D (keys before and after B) break too. B posts offers (three rounds). All
 * three twin assertions hold, and world 2's A never gets B back as a contact.
 */
export async function sChTwinRestore(bLow: boolean): Promise<void> {
  const script: TwinScript = {
    b: [
      { atMs: 0, act: (p) => restore(p) },
      { atMs: 3 * MIN, act: (p) => p.a.postOffer({ side: 'buy', currency: 'KRW', amountMinor: 90000, feePct: 3, methods: BOTH }) },
      { atMs: 6 * MIN, act: (p) => p.a.postOffer({ side: 'sell', currency: 'KRW', amountMinor: 90000, feePct: 3, methods: BOTH }) },
      { atMs: 9 * MIN, act: (p) => p.a.postOffer({ side: 'buy', currency: 'USD', amountMinor: 10_000, feePct: 3, methods: BOTH }) },
      { atMs: 30 * MIN, act: async () => {} },
    ],
    a: [{ atMs: 0, act: async (p) => breakAround(p) }],
  }
  const r = await twin(script, { aLow: !bLow, around: true })
  expectSameEnvelopes(r.seqs)
  expect(!hasContact(r.a[1], r.b[1]), 'world 2: A never gets B back as a contact')
  expect(sameNewRoom(r.a[0], r.b[0]), 'world 1: A and B share the new room')
  for (const w of r.worlds) await finish(w)
}

/** A's rooms with C and D are lost on A's device (TwinOpts.around). */
function breakAround(A: Peer): void {
  const w = A.world
  for (const name of ['C', 'D']) {
    const q = w.peers.find((p) => p.name === name)
    if (q) w.hub.loseGroup(A.pk, chanRoom(A, q))
  }
}

/** S-CH-TWIN-DELETER-RESTORE: A (the one that deleted B in world 2) is restored. */
export async function sChTwinDeleterRestore(aLow: boolean): Promise<void> {
  const script: TwinScript = {
    b: [{ atMs: 3 * MIN, act: (p) => p.a.postOffer({ side: 'buy', currency: 'KRW', amountMinor: 90000, feePct: 3, methods: BOTH }) }],
    a: [
      { atMs: 0, act: (p) => restore(p) },
      { atMs: 30 * MIN, act: async () => {} },
    ],
  }
  const r = await twin(script, { aLow, around: true })
  expectSameEnvelopes(r.seqs)
  expect(!hasContact(r.a[1], r.b[1]), 'world 2: the restored A has B as a tombstone, not a contact')
  expect(chanRoom(r.a[1], r.b[1]) !== '' && chanRoom(r.a[1], r.b[1]) === chanRoom(r.b[1], r.a[1]), "world 2: A's tombstone channel is reopened like a contact's")
  for (const w of r.worlds) await finish(w)
}

/** S-CH-TWIN-MOVE: B's room strands; later B is off while A's room breaks and waits more than a day. */
export async function sChTwinMove(aLow: boolean): Promise<void> {
  const script: TwinScript = {
    b: [
      { atMs: 0, act: async (p) => p.world.hub.strand(chanRoom(p, p.world.peers[0])) },
      { atMs: 30 * MIN, act: (p) => off(p) },
      { atMs: 30 * MIN + 26 * 60 * MIN, act: (p) => on(p) },
      { atMs: 30 * MIN + 27 * 60 * MIN, act: async () => {} },
    ],
    a: [{ atMs: 31 * MIN, act: async (p) => p.world.hub.loseGroup(p.pk, chanRoom(p, p.world.peers[1])) }],
  }
  const r = await twin(script, { aLow })
  expectSameEnvelopes(r.seqs)
  expect(sameNewRoom(r.a[0], r.b[0]), 'world 1: one room in the end')
  for (const w of r.worlds) await finish(w)
}

/**
 * S-CH-TWO-DEVICES: A1 keeps running while the same key is restored as A2 on a second
 * phone. A day later B is in A2's room, B moved at most twice, and A1 made and joined no
 * room (A1 stops once it sees the key restored elsewhere).
 */
export async function sChTwoDevices(aLow: boolean): Promise<void> {
  const { w, A: A1, B } = await linkedPair(aLow, { skip: ['INV-L4'] })
  const t0 = w.clock.now()
  const A2 = makePeer(w, 'A2', { words: A1.words, kv: restoredKv(A1), device: 'second' })
  await A2.engine.start()
  await adv(w, 24 * 60 * MIN)
  expect(chanRoom(A2, B) !== '' && chanRoom(A2, B) === chanRoom(B, A2), 'B and A2 share a room')
  const bMoves = (chanRec(B, A2)?.moves ?? []).filter((m) => m >= t0)
  expect(bMoves.length <= 2, `B moved at most twice (${bMoves.length})`)
  const a1 = w.hub.invites.filter((r) => r.atMs >= t0 && ((r.from === A1.pk && r.fromDevice === A1.device) || (r.to === A1.pk && r.toDevice === A1.device && r.accepted)))
  expect(a1.length === 0, `A1 made or joined no room (${a1.length})`)
  await finish(w)
}

/**
 * S-BOT-SENTAT-FUTURE: a thief of B's key (hub.thief, its own engine, its clock set to
 * 2100) reopens A's channel: its Welcome dated 2100 is ignored. B's real reopen is taken.
 * A reopen of B with its clock 20 minutes ahead is ignored too (more than 10 minutes ahead). Then the
 * two meet: A scans B's QR (B, 20 minutes ahead, cannot scan A's: the QR check finds it
 * expired, as it is unchanged). A the lower key: A's deadline makes a room for B's QR key
 * package, tagged, and B binds it by its tag: they are together without waiting. A the
 * higher key (it makes no room): once B's clock is right, B's next reopen of its pending
 * room a day later brings them together.
 */
export async function sBotSentAtFuture(aLow: boolean): Promise<void> {
  const { w, A, B } = await linkedPair(aLow)
  const old = chanRoom(A, B)
  const t0 = w.clock.now()
  const T = await thiefOf(B, { nowOffsetMs: Date.UTC(2100, 0, 1) - w.clock.now() })
  await until(w, () => w.hub.invites.some((r) => r.from === B.pk && r.fromDevice === T.device && r.to === A.pk), MIN, "the thief's engine reopens A's channel")
  await adv(w, MIN)
  const forged = w.hub.invites.filter((r) => r.from === B.pk && r.fromDevice === T.device && r.to === A.pk && r.atMs >= t0)
  expect(forged.length >= 1 && forged.every((r) => r.sentAt > Math.floor(Date.UTC(2099, 0, 1) / 1000)), `the thief's Welcomes are dated 2100 (${forged.map((r) => r.sentAt).join(',')})`)
  // (A request still on its way at this moment is dropped the same way once it arrives.)
  expect(forged.every((r) => !r.accepted && (r.dropped || r.atMs > w.clock.now() - 1_000)) && chanRoom(A, B) === old, 'the Welcome dated 2100 is not taken')
  await dropThief(T)
  w.hub.loseGroup(B.pk, old)
  await until(w, () => sameNewRoom(A, B, old), 2 * MIN, "B's real reopen is taken")
  const room2 = chanRoom(A, B)
  // B's next channel check sees A in it (pending cleared, its attempts start over).
  await until(w, () => chanRec(B, A)?.pending === undefined, CHANNEL_CHECK + MIN, "B's room is no longer pending")
  skew(B, 20 * MIN)
  const t1 = w.clock.now()
  w.hub.loseGroup(B.pk, room2)
  await until(w, () => invitesOf(w, B, A, t1).length >= 1, 2 * MIN, 'B (20 minutes ahead) reopens')
  await adv(w, MIN)
  expect(chanRoom(A, B) === room2 && !invitesOf(w, B, A, t1)[0].accepted, 'A ignores the room from 20 minutes ahead')
  if (aLow) {
    const pb = await scanOnly(w, A, B)
    A.a.startConnect()
    const pa = A.state().connect.myPayload ?? ''
    w.payloads.push(pa)
    await B.a.submitScan(pa, 'camera').catch(() => {})
    expect(B.state().connect.phase === 'failed' && B.state().connect.errorKey === 'expired', `B, 20 minutes ahead, finds A's QR expired (${B.state().connect.phase}/${B.state().connect.errorKey})`)
    const t2 = w.clock.now()
    await until(w, () => sameNewRoom(A, B, room2), 7 * MIN, "A's scan brings them together")
    const made = invitesOf(w, A, B, t2)
    expect(made.length === 1 && made[0].kpRef === payloadKp(pb) && made[0].accepted, "A's deadline room, for B's QR key package, taken by its tag")
    expect(chanRoom(A, B) === made[0].groupId, 'they share that room')
    await adv(w, HOLDER_SCAN_TTL_MS)
    skew(B, 0)
    await finish(w)
    return
  }
  skew(B, 0)
  await until(w, () => sameNewRoom(A, B, room2), 26 * 60 * MIN, 'with a right clock, B reopens its pending room and A takes it')
  await finish(w)
}

/**
 * S-BOT-REOPEN-BURST: A with 30 contacts (A lower for 15, higher for 15) is
 * restored. Within 10 minutes all 30 share a room with A; nobody moved more than twice,
 * A joined one room at a time, no move is left unfinished, A's names stay, and A's device
 * keeps one room per peer at most two.
 */
export async function sBotReopenBurst(): Promise<void> {
  // A join takes 2 s here, so the 15 rooms made for A at once would overlap without the limit on joins at once.
  const w = newWorld({ acceptDelayMs: 2_000 })
  const keys = orderedKeys(31)
  const A = makePeer(w, 'A', { words: keys[15].words })
  const others = keys.filter((_, i) => i !== 15).map((k, i) => makePeer(w, `P${i}`, { words: k.words }))
  for (const p of [A, ...others]) await p.engine.start()
  for (const p of others) {
    await link(w, A, p)
    await A.a.renameContact(p.pk, `n-${p.name}`)
    // A chat each way, really sent: the peer's side must keep both after A's restore.
    await A.a.sendChat(p.pk, `to-${p.name}`)
    await adv(w, 2_000)
    await p.a.sendChat(A.pk, `from-${p.name}`)
  }
  await until(w, () => others.every((p) => hasText(p, A, `to-${p.name}`) && hasText(A, p, `from-${p.name}`)), 2 * MIN, 'every chat arrived before the restore')
  await adv(w, 30_000)
  const names = JSON.stringify(
    A.state()
      .contacts.map((c) => [c.pubkey, c.name])
      .sort(),
  )
  const t0 = w.clock.now()
  await restore(A)
  await until(w, () => others.every((p) => chanRoom(A, p) !== '' && chanRoom(A, p) === chanRoom(p, A)), 10 * MIN, 'all 30 share a room with A')
  await adv(w, CHANNEL_CHECK)
  for (const p of others) {
    const moves = (chanRec(p, A)?.moves ?? []).filter((m) => m >= t0)
    expect(moves.length <= 2, `${p.name} moved ${moves.length} times`)
    expect(chanRec(p, A)?.moving === undefined && chanRec(A, p)?.moving === undefined, `no unfinished move with ${p.name}`)
    const rooms = w.hub.groupsOf(A.pk).filter((g) => w.hub.invites.some((r) => r.groupId === g && (r.from === p.pk || r.to === p.pk)))
    expect(rooms.length <= 2, `A's device keeps ${rooms.length} rooms with ${p.name}`)
  }
  expect(w.hub.peakAccepts(A.pk) <= 1, `A joined one room at a time (peak ${w.hub.peakAccepts(A.pk)})`)
  expect(
    JSON.stringify(
      A.state()
        .contacts.map((c) => [c.pubkey, c.name])
        .sort(),
    ) === names,
    "A's names stay",
  )
  for (const p of others) {
    expect(hasText(p, A, `to-${p.name}`) && hasText(p, A, `from-${p.name}`), `${p.name}'s chat with A stays`)
  }
  await finish(w)
}

/**
 * S-BOT-UNBUFFERED: 100 strangers' Welcomes while A showed no code: none
 * kept. A shows a code and restarts: an honest stranger's Welcome is kept for its scan.
 */
export async function sBotUnbuffered(): Promise<void> {
  const w = newWorld()
  const A = makePeer(w, 'A')
  await A.engine.start()
  const recs = w.hub.injectInvites(100, A.pk)
  await adv(w, 10_000)
  expect(A.engine.sizes().buffered === 0 && recs.every((r) => r.dropped), `none kept, all marked read (${A.engine.sizes().buffered})`)
  A.a.startConnect()
  await adv(w, 1_000)
  await restart(A)
  let lower = randomHex(32)
  while (lower >= A.pk) lower = randomHex(32)
  const honest = w.hub.injectInvite(lower, A.pk)
  await adv(w, 1_000)
  expect(A.engine.sizes().buffered === 1 && !honest.dropped, 'after the restart the stored code keeps the Welcome for a scan')
  await adv(w, 6 * MIN)
  expect(A.engine.sizes().buffered === 0 && honest.dropped, 'and drops it when no scan came')
  await finish(w)
}

/**
 * S-BOT-BUFFER-CAP (hub.injectInvites): A shows a
 * code and 100 strangers send Welcomes (half higher keys, half lower). The higher keys'
 * are marked read at once, the lower keys' are kept for a scan but never more than 20
 * senders (the oldest goes first). A joins nothing, gains no contact, uploads nothing,
 * and once the keep time is over every one of them is marked read.
 */
export async function sBotBufferCap(): Promise<void> {
  const w = newWorld()
  const A = makePeer(w, 'A')
  await A.engine.start()
  A.a.startConnect()
  await adv(w, 1_000)
  const groups = w.hub.groupsOf(A.pk).join()
  const t0 = w.clock.now()
  const recs = w.hub.injectInvites(100, A.pk)
  await adv(w, 10_000)
  const higher = recs.filter((r) => r.from > A.pk)
  const lower = recs.filter((r) => r.from < A.pk)
  expect(higher.length === 50 && lower.length === 50, `50 higher and 50 lower keys (${higher.length}/${lower.length})`)
  expect(
    higher.every((r) => r.dropped && !r.accepted),
    "the higher keys' Welcomes are marked read at once",
  )
  expect(A.engine.sizes().buffered === 20, `A keeps 20 senders at most (${A.engine.sizes().buffered})`)
  const kept = lower.filter((r) => !r.dropped)
  expect(kept.length === 20 && kept.every((r) => lower.indexOf(r) >= 30), `the 20 newest lower-key Welcomes are kept, the 30 older ones marked read (${kept.length})`)
  expect(recs.every((r) => !r.accepted) && w.hub.groupsOf(A.pk).join() === groups, 'A joined no room')
  expect(A.state().contacts.length === 0, 'no contact')
  expect(
    w.hub.kpLog.some((k) => k.pubkey === A.pk && k.atMs < t0),
    "the hub records key packages (A's first one is there)",
  )
  // Uploaded nothing: no group message, no Welcome of its own, no new key package (a join
  // would have rotated it) and no contact list.
  const up = {
    messages: w.hub.log.filter((e) => e.from === A.pk && e.atMs >= t0).length,
    welcomes: w.hub.invites.filter((r) => r.from === A.pk && r.atMs >= t0).length,
    keyPackages: w.hub.kpLog.filter((k) => k.pubkey === A.pk && k.atMs >= t0).length,
    lists: w.hub.listLog.filter((x) => x.atMs >= t0).length,
  }
  expect(
    Object.values(up).every((n) => n === 0),
    `A uploaded nothing (${JSON.stringify(up)})`,
  )
  await adv(w, 6 * MIN)
  expect(A.engine.sizes().buffered === 0 && recs.every((r) => r.dropped && !r.accepted), 'after the keep time every one is marked read')
  await finish(w)
}
