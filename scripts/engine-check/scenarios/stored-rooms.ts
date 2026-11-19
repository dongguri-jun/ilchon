/**
 * Engine check scenarios: S-CH-SWEEP and the stored rooms.
 * Run from scripts/check-engine.ts, which lists every scenario in its order.
 */
import { isDeepStrictEqual } from 'node:util'
import { expectOnlyChannelRooms } from '../invariants'
import { expect } from '../report'
import { MIN, type Peer, START_MS, adv, deleteContact, finish, hasContact, link, makePeer, newWorld, orderedKeys, restart, until } from '../world'

/** S-CH-SWEEP: a first link only one side scanned times out; its room goes. Another pair links. */
export async function sChSweep(): Promise<void> {
  const w = newWorld()
  const [ka, kb, kc, kd] = orderedKeys(4)
  const A = makePeer(w, 'A', { words: ka.words })
  const B = makePeer(w, 'B', { words: kb.words })
  const C = makePeer(w, 'C', { words: kc.words })
  const D = makePeer(w, 'D', { words: kd.words })
  for (const p of [A, B, C, D]) await p.engine.start()
  await link(w, A, B)
  const roomAB = A.state().contacts[0]?.groupId ?? ''
  // C (the lower key) scans D, D never scans C: C makes a room and invites, D keeps the
  // Welcome a while and drops it. The link times out on C's side.
  C.a.startConnect()
  D.a.startConnect()
  void C.a.submitScan(D.state().connect.myPayload ?? '')
  await until(w, () => w.hub.groupsOf(C.pk).length === 1, MIN, 'C made the link room')
  // And the higher key scans the lower one without being scanned: no room at all.
  D.a.cancelConnect()
  const B2 = makePeer(w, 'B2')
  await B2.engine.start()
  B2.a.startConnect()
  A.a.startConnect()
  void (B2.pk > A.pk ? B2 : A).a.submitScan((B2.pk > A.pk ? A : B2).state().connect.myPayload ?? '')
  await adv(w, 10 * MIN)
  expect(C.state().connect.phase === 'failed' && C.state().connect.errorKey === 'timeout', `C's link timed out (${C.state().connect.phase})`)
  expect(w.hub.groupsOf(C.pk).length === 0 && w.hub.groupsOf(D.pk).length === 0, `the timed-out pair stores no room (C ${w.hub.groupsOf(C.pk).length}, D ${w.hub.groupsOf(D.pk).length})`)
  expect(w.hub.groupsOf(B2.pk).length === 0, 'the one-sided scan of the higher key made no room')
  for (const p of [A, B]) {
    const g = w.hub.groupsOf(p.pk)
    expect(g.length === 1 && g[0] === roomAB, `${p.name} stores only the channel room (${g.length})`)
  }
  expectOnlyChannelRooms(w)
  // A restart keeps the channel room (boot cleanup leaves rooms in use).
  await restart(A)
  await adv(w, MIN)
  expect(w.hub.groupsOf(A.pk).length === 1 && w.hub.health(A.pk, roomAB) === 'ok', 'after a restart A keeps its channel room')
  await A.a.sendChat(B.pk, 'still here')
  await until(w, () => (B.state().rooms[A.pk] ?? []).some((x) => x.kind === 'text' && x.text === 'still here'), MIN, 'the channel room still works')
  await finish(w)
}

/**
 * S-CH-UNREADABLE: a stored room that cannot be read and that nothing uses is removed by
 * the boot cleanup; an unreadable room a contact still uses stays (the channel reopens it).
 */
export async function sChUnreadable(): Promise<void> {
  const w = newWorld()
  const A = makePeer(w, 'A')
  const B = makePeer(w, 'B')
  const C = makePeer(w, 'C')
  for (const p of [A, B, C]) await p.engine.start()
  await link(w, A, B)
  await link(w, A, C)
  const roomOf = (p: Peer, q: Peer) => p.state().contacts.find((c) => c.pubkey === q.pk)?.groupId ?? ''
  const roomAB = roomOf(A, B)
  const roomAC = roomOf(A, C)
  // A loses the record of C (as after a wipe of its list) while its room stays stored,
  // and that room cannot be read any more. The room with B cannot be read either.
  await A.engine.stop()
  A.kv.close(A.tag, 'stop')
  A.kv.seed(
    'contacts',
    (A.kv.peek<{ pubkey: string }[]>('contacts') ?? []).filter((c) => c.pubkey !== C.pk),
  )
  A.spawn()
  w.hub.unreadable(A.pk, roomAC)
  w.hub.unreadable(A.pk, roomAB)
  const restartedAt = w.clock.now()
  await A.engine.start()
  // Before the first channel check (15 s after boot), which reopens the contact's room.
  await adv(w, 10_000)
  expect(!w.hub.groupsOf(A.pk).includes(roomAC), 'the unreadable room nothing uses is gone from A')
  expect(w.hub.health(A.pk, roomAC) === 'missing', `and is 'missing' now (got ${w.hub.health(A.pk, roomAC)})`)
  expect(w.hub.groupsOf(A.pk).includes(roomAB) && w.hub.health(A.pk, roomAB) === 'unreadable', 'the unreadable room of a contact stays')
  expect(!A.events.some((e) => e.event === 'forget-failed'), 'no forget failed')
  // C, which still has A, is told nothing: A uploaded nothing in the room it dropped.
  expect(!w.hub.log.some((e) => e.from === A.pk && e.groupId === roomAC && e.atMs >= restartedAt), 'A uploaded nothing while dropping it')
  // The channel with B gets a new room, and the unreadable one goes with the bind.
  await until(w, () => roomOf(A, B) !== roomAB && roomOf(A, B) === roomOf(B, A), 5 * MIN, 'A and B share a new room')
  await adv(w, 30_000)
  expect(!w.hub.groupsOf(A.pk).includes(roomAB), 'the unreadable room of B is gone from A after the reopen')
  await finish(w)
}

/** removeContact keeps every channel field of the contact in the tombstone. */
export async function sChTombFields(): Promise<void> {
  const w = newWorld()
  const A = makePeer(w, 'A')
  const B = makePeer(w, 'B')
  for (const p of [A, B]) await p.engine.start()
  await link(w, A, B)
  await adv(w, 30_000)
  // Channel fields a later step sets (moves, a move in progress, attempts) stand in here.
  await A.engine.stop()
  A.kv.close(A.tag, 'stop')
  const stored = A.kv.peek<Record<string, unknown>[]>('contacts') ?? []
  const extra = { roomSentAt: 1_800_000_000, moves: [START_MS - 5 * MIN], moving: START_MS - MIN, pending: true, tries: 2, triedAt: START_MS - 2 * MIN }
  A.kv.seed(
    'contacts',
    stored.map((c) => ({ ...c, ...extra })),
  )
  A.spawn()
  await A.engine.start()
  const before = A.state().contacts.find((c) => c.pubkey === B.pk)
  expect(before?.moving === extra.moving, 'the contact read its channel fields')
  await deleteContact(w, A, B)
  const tomb = (A.kv.peek<Record<string, Record<string, unknown>>>('tombstones') ?? {})[B.pk]
  const { id: _i, pubkey: _p, name: _n, createdAt: _c, ...channel } = before as unknown as Record<string, unknown>
  const { at, ...kept } = tomb ?? {}
  expect(typeof at === 'number' && at === w.clock.now(), 'the tombstone has the time of the delete')
  expect(isDeepStrictEqual(kept, channel), `the tombstone keeps every channel field (${JSON.stringify(kept)} / ${JSON.stringify(channel)})`)
  expect(!hasContact(A, B) && !(A.kv.peek<{ pubkey: string }[]>('contacts') ?? []).some((c) => c.pubkey === B.pk), 'the contact is gone')
  expect(A.kv.peek(`room:${B.pk}`) === undefined, "the contact's chat item is gone")
  await finish(w)
}
