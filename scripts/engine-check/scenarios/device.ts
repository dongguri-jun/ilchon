/**
 * Engine check scenarios: device timing (clock skew, slow catch-up, failed sends, restarts).
 * Run from scripts/check-engine.ts, which lists every scenario in its order.
 */
import type { ChatMessage } from '../../../src/contracts'
import { newMnemonic } from '../../../src/lib/seed/index'
import { chanRec, chanRoom, expectWorking, hasText, invitesOf, linkedPair, pinOf, restore, sameNewRoom, scanEachOther, scanOnly, skew, withChannel } from '../helpers/channel'
import { LIST_AB, restoreWords } from '../helpers/recovery'
import { expectNoLeakToC, reopenTrio } from '../helpers/reopen'
import { type TwinScript, screenOf, twin } from '../helpers/twin'
import { dumpOf, holdsNumber } from '../markers'
import { expect } from '../report'
import { BOTH, MIN, type Peer, START_MS, type World, adv, deleteContact, finish, hasContact, link, makePeer, restart, until } from '../world'

// ---------------------------------------------------------------- phone findings

const textsOf = (x: Peer, y: Peer): Extract<ChatMessage, { kind: 'text' }>[] => (x.state().rooms[y.pk] ?? []).filter((m): m is Extract<ChatMessage, { kind: 'text' }> => m.kind === 'text')

/**
 * S-DEV-ROOM-FULL: a room full of my own texts
 * (210) keeps the text that just came in, and the one before it when the next comes, also
 * after a restart; the room stays at ROOM_CAP. A contact flooding the room afterwards keeps
 * its newest 50 texts and pushes out no more than 50 of mine.
 */
export async function sDevRoomFull(): Promise<void> {
  const { w, A, B } = await linkedPair(true)
  for (let i = 0; i < 210; i++) {
    await A.a.sendChat(B.pk, `mine ${i}`)
    if (i % 25 === 24) await adv(w, 5_000)
  }
  await adv(w, 10_000)
  await B.a.sendChat(A.pk, 'new-1')
  await adv(w, 10_000)
  expect(hasText(A, B, 'new-1'), 'the text that just came in is in the room')
  expect((A.state().rooms[B.pk] ?? []).length === 200, `the room stays at 200 (${(A.state().rooms[B.pk] ?? []).length})`)
  expect(hasText(A, B, 'mine 209') && !hasText(A, B, 'mine 0'), 'my oldest text went, my newest stayed')
  await B.a.sendChat(A.pk, 'new-2')
  await adv(w, 10_000)
  expect(hasText(A, B, 'new-1') && hasText(A, B, 'new-2'), 'the next text does not push out the one before')
  await restart(A)
  await adv(w, 30_000)
  expect(hasText(A, B, 'new-1') && hasText(A, B, 'new-2'), 'both stay after a restart')
  for (let i = 0; i < 120; i++) {
    await B.a.sendChat(A.pk, `flood ${i}`)
    if (i % 25 === 24) await adv(w, 5_000)
  }
  await adv(w, 10_000)
  const texts = textsOf(A, B)
  const mine = texts.filter((m) => m.mine).length
  expect(texts.length === 200 && mine === 150 && hasText(A, B, 'flood 119') && hasText(A, B, 'mine 209'), `a flood keeps the contact's newest 50 and 150 of mine (${texts.length} texts, mine ${mine})`)
  await finish(w)
}

/**
 * S-DEV-CATCHUP-ORDER: A's page is frozen while
 * B sends bg-1..bg-5 55 s apart and then changes its amount. The catch-up hands them to A
 * newest first. A's room shows bg-1..bg-5 in sending order with the term change after
 * bg-5, also after a restart; A's own later text stays after them.
 */
export async function sDevCatchupOrder(): Promise<void> {
  const { w, A, B } = await linkedPair(true)
  await A.a.postOffer({ side: 'buy', currency: 'KRW', amountMinor: 100_000, feePct: 0, methods: BOTH })
  await B.a.postOffer({ side: 'sell', currency: 'KRW', amountMinor: 100_000, feePct: 0, methods: BOTH })
  await until(w, () => A.state().matches.some((m) => m.contactId === B.pk && m.offer.amountMinor === 100_000), 5 * MIN, 'A and B match')
  await adv(w, MIN)
  A.freeze()
  const t0 = w.clock.now()
  for (let i = 1; i <= 5; i++) {
    await B.a.sendChat(A.pk, `bg-${i}`)
    await adv(w, 55_000)
  }
  await B.a.postOffer({ side: 'sell', currency: 'KRW', amountMinor: 70_000, feePct: 0, methods: BOTH })
  await adv(w, 2 * MIN)
  const held = w.hub.held().filter((id) => w.hub.log.find((e) => e.id === id && e.to === A.pk && e.atMs >= t0))
  expect(held.length >= 6, `the five texts and the offer wait for A (${held.length})`)
  // The catch-up: newest first.
  for (const id of [...held].reverse()) w.hub.release(id)
  A.thaw()
  await adv(w, 30_000)
  const order = (): string =>
    (A.state().rooms[B.pk] ?? [])
      .filter((m) => (m.kind === 'text' && m.text.startsWith('bg-')) || m.kind === 'changed')
      .map((m) => (m.kind === 'text' ? m.text : 'changed'))
      .join(',')
  expect(order() === 'bg-1,bg-2,bg-3,bg-4,bg-5,changed', `sending order, the change after bg-5 (${order()})`)
  await A.a.sendChat(B.pk, 'after')
  await adv(w, 5_000)
  const room = A.state().rooms[B.pk] ?? []
  expect(room[room.length - 1]?.kind === 'text' && (room[room.length - 1] as { text: string }).text === 'after', 'my text after the catch-up goes last')
  await restart(A)
  await adv(w, 30_000)
  expect(order() === 'bg-1,bg-2,bg-3,bg-4,bg-5,changed', `the order stays after a restart (${order()})`)
  await finish(w)
}

/**
 * S-CATCHUP-AHEAD: as S-DEV-CATCHUP-ORDER, but B's clock runs 20
 * minutes ahead of A's, more than the age of the messages, so every claimed time is in A's
 * future and the shown time is clamped to A's handling time. The catch-up handed over
 * newest first still lands in sending order, the change after the fifth text; every shown
 * time stays within A's clock.
 */
export async function sCatchupAhead(): Promise<void> {
  const { w, A, B } = await linkedPair(true)
  await A.a.postOffer({ side: 'buy', currency: 'KRW', amountMinor: 100_000, feePct: 0, methods: BOTH })
  await B.a.postOffer({ side: 'sell', currency: 'KRW', amountMinor: 100_000, feePct: 0, methods: BOTH })
  await until(w, () => A.state().matches.some((m) => m.contactId === B.pk && m.offer.amountMinor === 100_000), 5 * MIN, 'A and B match')
  await adv(w, MIN)
  skew(B, 20 * MIN)
  A.freeze()
  const t0 = w.clock.now()
  for (let i = 1; i <= 5; i++) {
    await B.a.sendChat(A.pk, `ah-${i}`)
    await adv(w, 10_000)
  }
  await B.a.postOffer({ side: 'sell', currency: 'KRW', amountMinor: 70_000, feePct: 0, methods: BOTH })
  await adv(w, 2 * MIN)
  const held = w.hub.held().filter((id) => w.hub.log.find((e) => e.id === id && e.to === A.pk && e.atMs >= t0))
  expect(held.length >= 6, `the five texts and the offer wait for A (${held.length})`)
  for (const id of [...held].reverse()) w.hub.release(id)
  A.thaw()
  await adv(w, 30_000)
  const mine = (A.state().rooms[B.pk] ?? []).filter((m) => (m.kind === 'text' && m.text.startsWith('ah-')) || m.kind === 'changed')
  const order = mine.map((m) => (m.kind === 'text' ? m.text : 'changed')).join(',')
  expect(order === 'ah-1,ah-2,ah-3,ah-4,ah-5,changed', `sending order with B's clock 20 minutes ahead (${order})`)
  expect(
    mine.every((m) => m.at <= w.clock.now()),
    'every shown time is clamped to my clock',
  )
  skew(B, 0)
  await finish(w)
}

/**
 * S-OFFER-PARTS (transport INGEST_HOLD_MAX_MS): the transport hands a
 * long catch-up over in sorted parts, the newest part first. A and B matched at 100,000; A's
 * tab is frozen while B edits its amount to 90,000 and then to 70,000. The 70,000 offer comes
 * first, the older 90,000 one after it. A keeps 70,000 and one 'changed' line
 * (100,000 -> 70,000): the older offer neither replaces the match nor adds a line. Also a
 * withdraw older than the offer A took (it reaches A after B's next offer) does not undo it.
 */
export async function sOfferParts(): Promise<void> {
  const { w, A, B } = await linkedPair(true)
  await A.a.postOffer({ side: 'buy', currency: 'KRW', amountMinor: 100_000, feePct: 0, methods: BOTH })
  await B.a.postOffer({ side: 'sell', currency: 'KRW', amountMinor: 100_000, feePct: 0, methods: BOTH })
  await until(w, () => A.state().matches.some((m) => m.contactId === B.pk && m.offer.amountMinor === 100_000), 5 * MIN, 'A and B match')
  await adv(w, MIN)
  A.freeze()
  const t0 = w.clock.now()
  await B.a.postOffer({ side: 'sell', currency: 'KRW', amountMinor: 90_000, feePct: 0, methods: BOTH })
  await adv(w, 10_000)
  await B.a.postOffer({ side: 'sell', currency: 'KRW', amountMinor: 70_000, feePct: 0, methods: BOTH })
  await adv(w, MIN)
  const held = w.hub.held().filter((id) => w.hub.log.find((e) => e.id === id && e.to === A.pk && e.from === B.pk && e.t === 'offer' && e.atMs >= t0))
  expect(held.length === 2, `the two edits wait for A (${held.length})`)
  // Part 1 (the newest), then part 2 (the older one).
  w.hub.release(held[1])
  await adv(w, 1_000)
  w.hub.release(held[0])
  A.thaw()
  await adv(w, 30_000)
  const amount = A.state().matches.find((m) => m.contactId === B.pk)?.offer.amountMinor
  expect(amount === 70_000, `A keeps B's newest amount (${amount})`)
  const changed = (A.state().rooms[B.pk] ?? []).filter((m) => m.kind === 'changed') as { before: { amountMinor: number }; after: { amountMinor: number } }[]
  const desc = changed.map((c) => `${c.before.amountMinor}->${c.after.amountMinor}`).join(',')
  expect(desc === '100000->70000', `one 'changed' line, from 100,000 to 70,000 (${desc})`)
  // A withdraw older than the offer A took: B withdraws, then posts again; the withdraw
  // reaches A only after the new round and offer did (a later part of a catch-up).
  const route = w.hub.route
  w.hub.route = (e) => (e.to === A.pk && e.from === B.pk && e.t === 'withdraw' ? 'hold' : route(e))
  const t1 = w.clock.now()
  await B.a.withdrawOffer()
  await adv(w, 10_000)
  await B.a.postOffer({ side: 'sell', currency: 'KRW', amountMinor: 60_000, feePct: 0, methods: BOTH })
  await until(w, () => A.state().matches.some((m) => m.contactId === B.pk && m.offer.amountMinor === 60_000), 5 * MIN, "A matches B's new offer")
  w.hub.route = route
  const late = w.hub.held().filter((id) => w.hub.log.find((e) => e.id === id && e.to === A.pk && e.t === 'withdraw' && e.atMs >= t1))
  expect(late.length === 1, `B's withdraw waited (${late.length})`)
  for (const id of late) w.hub.release(id)
  await adv(w, 2 * MIN)
  expect(
    A.state().matches.some((m) => m.contactId === B.pk && m.offer.amountMinor === 60_000),
    'the match stays after the catch-up',
  )
  await finish(w)
}

/**
 * S-DEV-REOPEN-PIN: B (the higher key) deleted A and linked again,
 * twice, so A (L) pinned the room for 7 days. Then B is restored on a new phone. As
 * specified, A ignores B's room requests while pinned: no room for B, and B's texts fail.
 * B's room says why from B's own facts: its room is gone, then (third request) the scan
 * hint. A's room says nothing: a line made from B's request alone
 * would also show where B deleted A and scanned again, telling A. Scanning each other
 * reconnects at once and B's status goes.
 */
export async function sDevReopenPin(): Promise<void> {
  const { w, A, B } = await linkedPair(true)
  for (let i = 0; i < 2; i++) {
    await deleteContact(w, B, A)
    await adv(w, 2 * MIN)
    await link(w, A, B)
    w.deleted.get(B.pk)?.delete(A.pk)
    await adv(w, 2 * MIN)
  }
  expect(pinOf(A, B) > w.clock.now(), 'A pinned the room recovered by scanning')
  expect(!A.state().reopening[B.pk] && !B.state().reopening[A.pk], 'no status while the room works')
  const t0 = w.clock.now()
  await restore(B)
  await until(w, () => !!B.state().reopening[A.pk], MIN, "B's room says it is reconnecting")
  expect(B.state().reopening[A.pk]?.scan !== true, 'not the scan hint at first')
  await B.a.sendChat(A.pk, 'lost')
  await adv(w, 5_000)
  expect(textsOf(B, A).find((m) => m.text === 'lost')?.status === 'failed', "B's text fails while the room is reopened")
  await until(w, () => invitesOf(w, B, A, t0).length >= 1, 5 * MIN, "B's first request")
  await adv(w, 5_000)
  expect(!A.state().reopening[B.pk], `A's room shows nothing for a request it refused (${JSON.stringify(A.state().reopening[B.pk])})`)
  await until(w, () => B.state().reopening[A.pk]?.scan === true, 15 * MIN, "B's status turns to the scan hint after three requests")
  await adv(w, 60 * MIN)
  expect(invitesOf(w, A, B, t0).length === 0 && chanRoom(B, A) === '', 'A made no room for B while pinned (the pin stays)')
  expect(!A.state().reopening[B.pk], "still nothing in A's room after an hour of requests")
  const t1 = w.clock.now()
  await scanEachOther(w, A, B, 5_000)
  await until(w, () => sameNewRoom(A, B), 15 * MIN, 'they scan each other: one new room')
  expect(w.clock.now() - t1 <= 7 * MIN, `within the 5-minute pairing (${Math.round((w.clock.now() - t1) / 1000)} s)`)
  await until(w, () => !A.state().reopening[B.pk] && !B.state().reopening[A.pk], MIN, 'both statuses go')
  A.a.cancelConnect()
  B.a.cancelConnect()
  await expectWorking(w, A, B, 'pin')
  await finish(w)
}

/**
 * S-DEV-REOPEN-LIMIT (the move limit): A (L) already moved the room
 * twice in the last 24 hours and answered two requests of B (answers have
 * their own two a day; with only the moves used A answers at once, S-ANSWER-SEPARATE)
 * when B is restored. As specified, A makes B's room when
 * its window opens. Meanwhile B's room shows it is reconnecting (its room is gone); A's
 * room shows nothing (the wait comes from B's request alone). At the
 * window both share a room and B's status goes.
 */
export async function sDevReopenLimit(): Promise<void> {
  const { w, A, B } = await linkedPair(true)
  const n = w.clock.now()
  const moves = [n - 60 * MIN, n - 30 * MIN]
  await withChannel(A, B, { moves, answered: moves })
  await adv(w, MIN)
  expect(!A.state().reopening[B.pk], 'a full limit alone shows nothing while the room works')
  const t0 = w.clock.now()
  await restore(B)
  await until(w, () => invitesOf(w, B, A, t0).length >= 1, 5 * MIN, 'B asks A for a room')
  await adv(w, 30_000)
  expect(!A.state().reopening[B.pk], `A's room shows nothing for B's request (${JSON.stringify(A.state().reopening[B.pk])})`)
  expect(!!B.state().reopening[A.pk], "B's room shows it is reconnecting")
  await until(w, () => sameNewRoom(A, B), 24 * 60 * MIN, 'the room comes when the window opens')
  expect(w.clock.now() >= moves[0] + 24 * 60 * MIN, 'not before the window (the limit stays)')
  expect(invitesOf(w, A, B, t0).length === 1, `A made one room (${invitesOf(w, A, B, t0).length})`)
  await until(w, () => !A.state().reopening[B.pk] && !B.state().reopening[A.pk], 5 * MIN, 'both statuses go')
  await expectWorking(w, A, B, 'limit')
  await finish(w)
}

/**
 * S-DEV-ROOM-FLOOR-OLD (the room cap rule): the contact's newest
 * 50 texts are never dropped, also when they are older than all of my texts. B writes 50,
 * then A writes 160 (210 texts): my oldest go, all 50 of B's stay, the room stays at 200.
 */
export async function sDevRoomFloorOld(): Promise<void> {
  const { w, A, B } = await linkedPair(true)
  for (let i = 0; i < 50; i++) {
    await B.a.sendChat(A.pk, `old-theirs ${i}`)
    if (i % 25 === 24) await adv(w, 5_000)
  }
  await adv(w, 10_000)
  for (let i = 0; i < 160; i++) {
    await A.a.sendChat(B.pk, `late-mine ${i}`)
    if (i % 25 === 24) await adv(w, 5_000)
  }
  await adv(w, 10_000)
  const theirs = textsOf(A, B).filter((m) => !m.mine)
  const keptAll = Array.from({ length: 50 }, (_, i) => hasText(A, B, `old-theirs ${i}`)).every(Boolean)
  expect(keptAll, `all 50 of the contact's texts stay (${theirs.length} of the contact's in the room)`)
  expect((A.state().rooms[B.pk] ?? []).length === 200, `the room stays at 200 (${(A.state().rooms[B.pk] ?? []).length})`)
  expect(hasText(A, B, 'late-mine 159') && !hasText(A, B, 'late-mine 0'), 'my oldest text went, my newest stayed')
  await restart(A)
  await adv(w, 30_000)
  expect(hasText(A, B, 'old-theirs 0') && hasText(A, B, 'old-theirs 49'), "the contact's texts stay after a restart")
  await finish(w)
}

/**
 * S-DEV-PIN-STALE: A (L) has pinned
 * its room with B. B's room requests, one dated before A's room (sent before the bind,
 * delivered late) and one dated after it, both leave A's room without a status (a request
 * alone never makes one) and make no room while pinned. The room carries texts.
 */
export async function sDevPinStale(): Promise<void> {
  const { w, A, B } = await linkedPair(true)
  expect(A.pk < B.pk, 'A is the lower key (L)')
  await withChannel(A, B, { pinnedUntil: w.clock.now() + 7 * 24 * 60 * MIN })
  await adv(w, MIN)
  const room = chanRoom(A, B)
  const sentAt = chanRec(A, B)?.roomSentAt ?? 0
  expect(room !== '' && sentAt > 0, `A has a room and its time (${sentAt})`)
  const t0 = w.clock.now()
  w.hub.injectInvite(B.pk, A.pk, { sentAt: sentAt - 30 })
  w.hub.injectInvite(B.pk, A.pk, { sentAt })
  await adv(w, 30_000)
  expect(!A.state().reopening[B.pk], `a request from before the room leaves no status (${JSON.stringify(A.state().reopening[B.pk])})`)
  expect(chanRoom(A, B) === room && invitesOf(w, A, B, t0).length === 0, 'the room stays, no new room')
  await A.a.sendChat(B.pk, 'still here')
  await adv(w, 10_000)
  expect(hasText(B, A, 'still here'), 'the room carries texts')
  w.hub.injectInvite(B.pk, A.pk, { sentAt: Math.floor(w.clock.now() / 1000) })
  await adv(w, 30 * MIN)
  expect(!A.state().reopening[B.pk], `a request after the room leaves no status either (${JSON.stringify(A.state().reopening[B.pk])})`)
  expect(invitesOf(w, A, B, t0).length === 0 && chanRoom(A, B) === room, 'and no room while pinned')
  await finish(w)
}

/**
 * S-STALE-FREE: the stale-request rule holds on the unpinned branch
 * too. A (L) already moved the room twice in the last 24 hours. A request of B dated
 * before B first spoke in A's room (sent before the bind, delivered late) makes no status
 * and, once the window opens, no move. A request B sends now is taken: A makes the room.
 */
export async function sStaleFree(): Promise<void> {
  const { w, A, B } = await linkedPair(true)
  const n = w.clock.now()
  await withChannel(A, B, { moves: [n - 60 * MIN, n - 30 * MIN] })
  await adv(w, MIN)
  const room = chanRoom(A, B)
  const first = chanRec(A, B)?.peerSentAt ?? 0
  expect(room !== '' && first > 0, `A keeps B's first message time in the room (${first})`)
  expect(!((chanRec(A, B)?.pinnedUntil ?? 0) > w.clock.now()), 'not pinned')
  const t0 = w.clock.now()
  w.hub.injectInvite(B.pk, A.pk, { sentAt: first - 30 })
  await adv(w, 30_000)
  expect(!A.state().reopening[B.pk], `a stale request leaves no status (${JSON.stringify(A.state().reopening[B.pk])})`)
  await adv(w, 24 * 60 * MIN)
  expect(chanRoom(A, B) === room && invitesOf(w, A, B, t0).length === 0, `the window opened and the stale request moved nothing (${invitesOf(w, A, B, t0).length})`)
  await A.a.sendChat(B.pk, 'still here')
  await until(w, () => hasText(B, A, 'still here'), MIN, 'the room carries texts')
  w.hub.injectInvite(B.pk, A.pk, { sentAt: Math.floor(w.clock.now() / 1000) })
  await until(w, () => invitesOf(w, A, B, t0).length === 1, 5 * MIN, 'a request B sends now is taken: A makes the room')
  await until(w, () => sameNewRoom(A, B, room), 5 * MIN, 'B moves into it')
  await finish(w)
}

/**
 * S-SKEW-GENUINE (isolated from the fallback; on the unpinned branch, where the stale
 * rule acts): B (H) runs 20
 * minutes behind A (L). A's room with B (opened after A lost the old one, joined with right
 * clocks: a Welcome more than 10 minutes ahead of B's clock is not taken); B's clock
 * falls behind before B first speaks in it. Then B really loses it (restored, same clock).
 * B's request is dated more than 10 minutes before A's room time on A's clock, so even the
 * tolerant fallback would call it stale; it was sent after B first spoke in that room on
 * B's own clock: A takes it and makes a room (a stale room seen on a phone must not come back under
 * skew). A's room shows no status for it (a request alone never makes one).
 */
export async function sSkewGenuine(): Promise<void> {
  const { w, A, B } = await linkedPair(true)
  const old = chanRoom(A, B)
  w.hub.loseGroup(A.pk, old)
  await until(w, () => sameNewRoom(A, B, old), 5 * MIN, 'A reopened the room and B is in it')
  await adv(w, 30_000)
  expect(chanRec(A, B)?.peerSentAt === undefined, `B has not spoken in the new room yet (${chanRec(A, B)?.peerSentAt})`)
  skew(B, -20 * MIN)
  await B.a.sendChat(A.pk, 'behind')
  await until(w, () => hasText(A, B, 'behind'), MIN, 'the room works with B 20 minutes behind')
  const first = chanRec(A, B)?.peerSentAt ?? 0
  const roomSentAt = chanRec(A, B)?.roomSentAt ?? 0
  expect(first > 0 && first + 10 * 60 < roomSentAt, `A keeps B's first message time on B's clock (${first}), before A's room (${roomSentAt})`)
  await adv(w, MIN)
  expect(!A.state().reopening[B.pk], 'no status while the room works')
  const room = chanRoom(A, B)
  const t0 = w.clock.now()
  await restore(B, { start: false })
  skew(B, -20 * MIN)
  await B.engine.start()
  await until(w, () => invitesOf(w, B, A, t0).length >= 1, 5 * MIN, "B's first request")
  const req = invitesOf(w, B, A, t0)[0]
  expect(req.sentAt + 10 * 60 <= roomSentAt, `the request is dated more than 10 minutes before A's room on A's clock (${req.sentAt} vs ${roomSentAt}): the fallback alone calls it stale`)
  expect(req.sentAt > first, `and after B's first message on B's clock (${req.sentAt} > ${first})`)
  await until(w, () => invitesOf(w, A, B, t0).length >= 1, 5 * MIN, 'A takes the genuine request and makes a room')
  expect(!A.state().reopening[B.pk], `A's room shows no status for it (${JSON.stringify(A.state().reopening[B.pk])})`)
  // B's clock is too far behind to take A's Welcome; with the clock right they meet.
  skew(B, 0)
  await scanEachOther(w, A, B, 5_000)
  await until(w, () => sameNewRoom(A, B, room), 15 * MIN, 'they scan each other: one new room')
  A.a.cancelConnect()
  B.a.cancelConnect()
  await finish(w)
}

/**
 * S-SKEW-FIRST (not pinned): the anchor is B's
 * FIRST message in the room, not its newest. B (H) speaks in A's (L) room, and again two
 * hours later. B's phone is lost; the new phone (same key) runs 30 minutes behind the old
 * one. Its request is dated before B's newest message but after its first: A takes it and
 * makes a room (the newest message as anchor would drop it). The gap that stays (4.9 남는
 * 것): a request from a clock behind by more than the time since B first spoke is dated
 * before that first message and reads as stale (no room).
 */
export async function sSkewFirst(): Promise<void> {
  const { w, A, B } = await linkedPair(true)
  const old = chanRoom(A, B)
  w.hub.loseGroup(A.pk, old)
  await until(w, () => sameNewRoom(A, B, old), 5 * MIN, 'A reopened the room and B is in it')
  await B.a.sendChat(A.pk, 'first')
  await until(w, () => hasText(A, B, 'first'), MIN, 'B speaks first in the new room')
  const first = chanRec(A, B)?.peerSentAt ?? 0
  await adv(w, 2 * 60 * MIN)
  await B.a.sendChat(A.pk, 'later')
  await until(w, () => hasText(A, B, 'later'), MIN, 'B speaks again two hours later')
  const newest = Math.floor(w.clock.now() / 1000)
  expect(first > 0 && first < newest - 60 * 60, `B's first message is two hours before its newest (${first} vs ${newest})`)
  await restart(A)
  await adv(w, 30_000)
  const room = chanRoom(A, B)
  expect(chanRec(A, B)?.peerSentAt === first, `A stored B's first message time once, not the newest, and kept it over its restart (${chanRec(A, B)?.peerSentAt} vs ${first})`)
  const t0 = w.clock.now()
  // The gap: a new phone 3 hours behind asks; its request is dated before B's first message.
  w.hub.injectInvite(B.pk, A.pk, { sentAt: Math.floor((w.clock.now() - 3 * 60 * MIN) / 1000) })
  await adv(w, 5 * MIN)
  expect(
    invitesOf(w, A, B, t0).length === 0 && chanRoom(A, B) === room,
    `the known gap: a clock behind by more than the time since B first spoke reads as stale, no room (${invitesOf(w, A, B, t0).length})`,
  )
  const t1 = w.clock.now()
  await restore(B, { start: false })
  skew(B, -30 * MIN)
  await B.engine.start()
  await until(w, () => invitesOf(w, B, A, t1).length >= 1, 5 * MIN, "B's first request from the new phone")
  const req = invitesOf(w, B, A, t1)[0]
  expect(req.sentAt <= newest && req.sentAt > first, `the request is dated before B's newest message and after its first (${first} < ${req.sentAt} <= ${newest})`)
  await until(w, () => invitesOf(w, A, B, t1).length >= 1, 5 * MIN, 'A takes it and makes a room: the newest message as anchor would drop it')
  skew(B, 0)
  await scanEachOther(w, A, B, 5_000)
  await until(w, () => sameNewRoom(A, B, room), 15 * MIN, 'they scan each other: one new room')
  A.a.cancelConnect()
  B.a.cancelConnect()
  await finish(w)
}

/**
 * S-SKEW-FALLBACK (not pinned): B (H) never spoke
 * in A's (L) room, so there is no peer clock to judge by and A's room time decides, with the
 * 10-minute clock tolerance: a request dated more than 10 minutes before the room is stale (no room, also
 * after A restarts); one dated 5 minutes before it may be a genuine one from a clock behind
 * (A makes a room).
 */
export async function sSkewFallback(): Promise<void> {
  const { w, A, B } = await linkedPair(true)
  const old = chanRoom(A, B)
  w.hub.loseGroup(A.pk, old)
  await until(w, () => sameNewRoom(A, B, old), 5 * MIN, 'A reopened the room and B is in it')
  await adv(w, MIN)
  const room = chanRoom(A, B)
  const roomSentAt = chanRec(A, B)?.roomSentAt ?? 0
  expect(roomSentAt > 0 && chanRec(A, B)?.peerSentAt === undefined, `B never spoke in A's room (${chanRec(A, B)?.peerSentAt})`)
  const t0 = w.clock.now()
  w.hub.injectInvite(B.pk, A.pk, { sentAt: roomSentAt - 11 * 60 })
  await adv(w, 5 * MIN)
  expect(invitesOf(w, A, B, t0).length === 0 && chanRoom(A, B) === room, `a request 11 minutes before the room is stale, no room (${invitesOf(w, A, B, t0).length})`)
  await restart(A)
  await adv(w, 30_000)
  w.hub.injectInvite(B.pk, A.pk, { sentAt: roomSentAt - 11 * 60 - 1 })
  await adv(w, 5 * MIN)
  expect(invitesOf(w, A, B, t0).length === 0 && chanRoom(A, B) === room, `also after A restarts (${invitesOf(w, A, B, t0).length})`)
  w.hub.injectInvite(B.pk, A.pk, { sentAt: roomSentAt - 5 * 60 })
  await until(w, () => invitesOf(w, A, B, t0).length >= 1, 5 * MIN, 'a request 5 minutes before the room (within the clock tolerance) is taken: A makes a room')
  expect(!A.state().reopening[B.pk], `and no status in A's room for it (${JSON.stringify(A.state().reopening[B.pk])})`)
  await until(w, () => sameNewRoom(A, B, room), 5 * MIN, 'B moves into it')
  await finish(w)
}

/**
 * S-SKEW-RESTART: the anchor survives a restart between the
 * peer's proof and the request. A (L) reopened the room; B (H) has not spoken in it. B scans
 * A (holder): B's proof is its first message in A's room. A restarts; in the next session A
 * scans B and the proof stored before pins the room. The pins are then taken
 * off (harness: another restart of both) so the request rule acts (a pinned room
 * takes no request at all). A request B sent 5 minutes before A's room and delivered late is
 * stale: no room (the fallback alone would take it). A request B sends now is taken. In
 * an earlier form of this scenario (pinned, requests judged in the scanning session) the in-memory echo of
 * B's proof that came in the session after the first restart masked the behaviour check,
 * and only the stored-value check tied the scenario to persistence. Here
 * the restart that takes the pins off empties that memory, so the behaviour check depends on
 * the stored value too (both fail when peerSentAt is not stored).
 */
export async function sSkewRestart(): Promise<void> {
  const { w, A, B } = await linkedPair(true)
  const old = chanRoom(A, B)
  w.hub.loseGroup(A.pk, old)
  await until(w, () => sameNewRoom(A, B, old), 5 * MIN, 'A reopened the room and B is in it')
  await adv(w, 30_000)
  const room = chanRoom(A, B)
  const roomSentAt = chanRec(A, B)?.roomSentAt ?? 0
  expect(chanRec(A, B)?.peerSentAt === undefined, 'B has not spoken in the new room yet')
  const proofAt = Math.floor(w.clock.now() / 1000)
  await scanOnly(w, B, A)
  await adv(w, MIN)
  expect(!((chanRec(A, B)?.pinnedUntil ?? 0) > w.clock.now()), 'not pinned in the first session')
  A.a.cancelConnect()
  await restart(A)
  await adv(w, 30_000)
  await scanOnly(w, A, B)
  await adv(w, 30_000)
  expect((chanRec(A, B)?.pinnedUntil ?? 0) > w.clock.now(), 'A scans B in the next session: the stored proof pins the room')
  expect(chanRoom(A, B) === room, 'the room stays')
  A.a.cancelConnect()
  B.a.cancelConnect()
  await adv(w, 10 * MIN)
  await withChannel(A, B, { pinnedUntil: 0 })
  await withChannel(B, A, { pinnedUntil: 0 })
  await adv(w, 30_000)
  const first = chanRec(A, B)?.peerSentAt ?? 0
  expect(first >= proofAt && first <= proofAt + 60, `A stored the time of B's proof, its first message in the room (${first} vs ${proofAt})`)
  const t0 = w.clock.now()
  w.hub.injectInvite(B.pk, A.pk, { sentAt: roomSentAt - 5 * 60 })
  await adv(w, 5 * MIN)
  expect(invitesOf(w, A, B, t0).length === 0 && chanRoom(A, B) === room, `a request sent 5 minutes before A's room is stale, no room (${invitesOf(w, A, B, t0).length})`)
  w.hub.injectInvite(B.pk, A.pk, { sentAt: Math.floor(w.clock.now() / 1000) })
  await until(w, () => invitesOf(w, A, B, t0).length >= 1, 5 * MIN, 'a request B sends now is taken: A makes a room')
  await until(w, () => sameNewRoom(A, B, room), 5 * MIN, 'B moves into it')
  await finish(w)
}

/**
 * S-SKEW-STALE (not pinned): B (H) runs 8
 * minutes ahead of A (L), within the clock tolerance. A loses the room and opens a new one; B
 * joins and speaks in it. A request of B sent before that bind (B's clock) and delivered late
 * is dated after A's room time on A's clock, yet before B spoke in the room on B's own clock:
 * stale, so it moves nothing and shows nothing, also after A restarts. A request B sends
 * later is taken.
 */
export async function sSkewStale(): Promise<void> {
  const { w, A, B } = await linkedPair(true)
  skew(B, 8 * MIN)
  const old = chanRoom(A, B)
  const before = Math.floor((w.clock.now() + 8 * MIN) / 1000) - 30
  w.hub.loseGroup(A.pk, old)
  await until(w, () => sameNewRoom(A, B, old), 5 * MIN, 'A reopened the room and B is in it')
  await B.a.sendChat(A.pk, 'ahead')
  await until(w, () => hasText(A, B, 'ahead'), MIN, 'B speaks in the new room')
  await adv(w, MIN)
  const room = chanRoom(A, B)
  const roomSentAt = chanRec(A, B)?.roomSentAt ?? 0
  expect(before > roomSentAt, `the late request is dated after A's room on A's clock (${before} > ${roomSentAt}): the old comparison took it`)
  const t0 = w.clock.now()
  w.hub.injectInvite(B.pk, A.pk, { sentAt: before })
  await adv(w, 5 * MIN)
  expect(!A.state().reopening[B.pk], `a request from before the room leaves no status (${JSON.stringify(A.state().reopening[B.pk])})`)
  expect(chanRoom(A, B) === room && invitesOf(w, A, B, t0).length === 0, 'the room stays, no new room')
  await restart(A)
  await adv(w, 30_000)
  w.hub.injectInvite(B.pk, A.pk, { sentAt: before + 1 })
  await adv(w, 5 * MIN)
  expect(chanRoom(A, B) === room && invitesOf(w, A, B, t0).length === 0, 'also after A restarts')
  await A.a.sendChat(B.pk, 'still here')
  await until(w, () => hasText(B, A, 'still here'), MIN, 'the room carries texts')
  w.hub.injectInvite(B.pk, A.pk, { sentAt: Math.floor((w.clock.now() + 8 * MIN) / 1000) })
  await until(w, () => invitesOf(w, A, B, t0).length >= 1, 5 * MIN, 'a request B sends now is taken: A makes a room')
  await until(w, () => sameNewRoom(A, B, room), 5 * MIN, 'B moves into it')
  skew(B, 0)
  await finish(w)
}

/**
 * S-SEND-FAILED (a failed send seen on a phone): A's room
 * with B works as far as A can tell, but the relays refuse A's texts. Once A's newest text
 * failed, A's room says it is reconnecting (no time, no scan hint); a text that goes through
 * takes the status away. Nothing of B's decides it.
 */
export async function sSendFailed(): Promise<void> {
  const { w, A, B } = await linkedPair(true)
  await adv(w, MIN)
  expect(!A.state().reopening[B.pk], 'no status while the room works')
  w.hub.failSend = (from, _g, msg) => (from === A.pk && msg.t === 'chat' ? 'reject' : false)
  await A.a.sendChat(B.pk, 'refused')
  await until(w, () => textsOf(A, B).find((m) => m.text === 'refused')?.status === 'failed', 10 * MIN, "A's text fails")
  const st = A.state().reopening[B.pk]
  expect(!!st && st.at === undefined && st.scan !== true, `A's room says it is reconnecting (${JSON.stringify(st)})`)
  w.hub.failSend = () => false
  await A.a.sendChat(B.pk, 'through')
  await until(w, () => hasText(B, A, 'through'), MIN, 'the next text goes through')
  await adv(w, 5_000)
  expect(!A.state().reopening[B.pk], `the status goes (${JSON.stringify(A.state().reopening[B.pk])})`)
  await finish(w)
}

/**
 * S-FAILED-LINE (the reconnecting line of S-SEND-FAILED unstuck). (a) One
 * relay hiccup fails A's newest text while B keeps talking in the working room: B's next
 * text takes A's line away. A resend of the failed text that goes through also does (and the
 * line comes back only with a new failure). (b) A text still 'sending' when A stops reads
 * back as 'failed' (load): the room shows no line at boot, nor later while nothing fails.
 */
export async function sFailedLine(): Promise<void> {
  const { w, A, B } = await linkedPair(true)
  await adv(w, MIN)
  w.hub.failSend = (from, _g, msg) => (from === A.pk && msg.t === 'chat' ? 'reject' : false)
  await A.a.sendChat(B.pk, 'hiccup')
  await until(w, () => textsOf(A, B).find((m) => m.text === 'hiccup')?.status === 'failed', 10 * MIN, "A's text fails")
  expect(!!A.state().reopening[B.pk], 'the failed text raises the line')
  await B.a.sendChat(A.pk, 'still talking')
  await until(w, () => hasText(A, B, 'still talking'), MIN, "B's text reaches A")
  await adv(w, 1_000)
  expect(!A.state().reopening[B.pk], `B's text in the room takes the line away (${JSON.stringify(A.state().reopening[B.pk])})`)
  // Fails again: the line comes back; then the resend goes through and takes it away.
  await A.a.sendChat(B.pk, 'hiccup 2')
  await until(w, () => textsOf(A, B).find((m) => m.text === 'hiccup 2')?.status === 'failed', 10 * MIN, "A's second text fails")
  expect(!!A.state().reopening[B.pk], 'a new failure after B spoke raises it again')
  w.hub.failSend = () => false
  const old = textsOf(A, B).find((m) => m.text === 'hiccup')!
  await A.a.retryChat(B.pk, old.id)
  await until(w, () => hasText(B, A, 'hiccup'), MIN, 'the resend of the older text goes through')
  await adv(w, 1_000)
  expect(!A.state().reopening[B.pk], `a resend that goes through takes the line away (${JSON.stringify(A.state().reopening[B.pk])})`)
  // (b) a text 'sending' at the stop.
  w.hub.failSend = (from, _g, msg) => (from === A.pk && msg.t === 'chat' ? { rejectAfterMs: 10 * MIN } : false)
  await A.a.sendChat(B.pk, 'in flight')
  await adv(w, 2_000)
  expect(textsOf(A, B).find((m) => m.text === 'in flight')?.status === 'sending', 'the text is still in flight')
  w.hub.failSend = () => false
  await restart(A)
  await adv(w, 30_000)
  expect(textsOf(A, B).find((m) => m.text === 'in flight')?.status === 'failed', "load() reads it back as 'failed'")
  expect(!A.state().reopening[B.pk], `no line at boot in a healthy room (${JSON.stringify(A.state().reopening[B.pk])})`)
  await adv(w, 10 * MIN)
  expect(!A.state().reopening[B.pk], 'nor later while nothing fails')
  await finish(w)
}

/**
 * S-CLOCK-BACK (placeOf within one catch-up batch): B's clock is corrected 10
 * minutes back in the middle of a session. B's texts after it come in live, after a gap, and
 * go below the ones A already had, whatever their claimed time says. A frozen A still gets a
 * catch-up of B's texts in sending order (the batch is ordered by B's claimed times).
 */
export async function sClockBack(): Promise<void> {
  const { w, A, B } = await linkedPair(true)
  await B.a.sendChat(A.pk, 'b-1')
  await adv(w, 30_000)
  await B.a.sendChat(A.pk, 'b-2')
  await adv(w, 30_000)
  skew(B, -10 * MIN)
  await B.a.sendChat(A.pk, 'b-3 after the correction')
  await adv(w, 30_000)
  await B.a.sendChat(A.pk, 'b-4')
  await adv(w, 30_000)
  const order = () =>
    textsOf(A, B)
      .filter((m) => !m.mine)
      .map((m) => m.text)
      .filter((x) => x.startsWith('b-'))
  expect(order().join('|') === 'b-1|b-2|b-3 after the correction|b-4', `live texts in arrival order after B's clock went back (${order().join('|')})`)
  A.freeze()
  for (let i = 5; i <= 9; i++) {
    await B.a.sendChat(A.pk, `b-${i}`)
    await adv(w, 2_000)
  }
  await adv(w, MIN)
  A.thaw()
  await until(w, () => hasText(A, B, 'b-9'), 2 * MIN, 'the catch-up reaches A')
  await adv(w, 5_000)
  expect(order().slice(4).join('|') === 'b-5|b-6|b-7|b-8|b-9', `the catch-up in sending order (${order().slice(4).join('|')})`)
  skew(B, 0)
  await finish(w)
}

/**
 * S-SHUTDOWN-RESET: the engine's memory-only state goes with a
 * stop, also when the same engine object starts again (a lock and unlock; fail() at boot
 * runs the same shutdown). (a) A (L) answers B's request, but every invite fails; A stops
 * and starts again; A's room still works, so the retry is still the answer (`answered`, not
 * `moves`): the answer under way is stored (`answerFrom`), as after a
 * restart of a new engine (S-RESTART-TWIN). (b) A's text fails in the new room (the line shows), and another
 * is still on its way at the stop; after a stop and start of the same engine both read back
 * as 'failed', and the room shows no line, also when the refusal of the old session's send
 * comes in the new one.
 */
export async function sShutdownReset(): Promise<void> {
  const { w, A, B } = await linkedPair(true)
  await adv(w, 15 * MIN)
  const room = chanRoom(A, B)
  const evAt = A.events.length
  w.hub.failInvite = (from, to) => from === A.pk && to === B.pk
  w.hub.injectInvite(B.pk, A.pk, { sentAt: Math.floor(w.clock.now() / 1000) })
  await until(w, () => A.events.slice(evAt).some((e) => e.event === 'chan-fail'), 5 * MIN, "A's answer fails to make a room")
  expect(chanRec(A, B)?.moving !== undefined, 'the channel waits for its move')
  await A.engine.stop()
  await A.engine.start()
  w.hub.failInvite = () => false
  await until(w, () => sameNewRoom(A, B, room), 15 * MIN, 'the retry after the start makes the room and B moves into it')
  const rec = chanRec(A, B) as { moves?: number[]; answered?: number[] } | undefined
  expect(
    (rec?.moves ?? []).length === 0 && (rec?.answered ?? []).length === 1,
    `the retry after a stop and start of the same engine is still the answer (moves ${JSON.stringify(rec?.moves)} / answered ${JSON.stringify(rec?.answered)})`,
  )
  // (b)
  await adv(w, 2 * MIN)
  w.hub.failSend = (from, _g, msg) => (from === A.pk && msg.t === 'chat' ? 'reject' : false)
  await A.a.sendChat(B.pk, 'refused here')
  await until(w, () => textsOf(A, B).find((m) => m.text === 'refused here')?.status === 'failed', 10 * MIN, "A's text fails")
  expect(!!A.state().reopening[B.pk], 'the failed text raises the line')
  // A text still on its way at the stop: its refusal comes in the next session.
  w.hub.failSend = (from, _g, msg) => (from === A.pk && msg.t === 'chat' ? { rejectAfterMs: 10 * MIN } : false)
  await A.a.sendChat(B.pk, 'in flight')
  await adv(w, 2_000)
  expect(textsOf(A, B).find((m) => m.text === 'in flight')?.status === 'sending', 'the text is still in flight')
  w.hub.failSend = () => false
  await A.engine.stop()
  await A.engine.start()
  await adv(w, 30_000)
  const st = (text: string) => textsOf(A, B).find((m) => m.text === text)?.status
  expect(st('refused here') === 'failed' && st('in flight') === 'failed', `the texts read back as 'failed' (${st('refused here')}, ${st('in flight')})`)
  expect(!A.state().reopening[B.pk], `no line after a stop and start of the same engine (${JSON.stringify(A.state().reopening[B.pk])})`)
  await adv(w, 11 * MIN)
  expect(!A.state().reopening[B.pk], `nor when the refusal of the last session's send comes (${JSON.stringify(A.state().reopening[B.pk])})`)
  await finish(w)
}

/**
 * S-SHUTDOWN-RESET (fail): the same reset when fail() is what stops the
 * running engine, not stop(). The words are restored on a second device (A2), so A's next
 * start runs the key-takeover check in the background (answering late, hub.elsewhereDelayMs). Meanwhile B (H)
 * asks for a room and A's answer fails. Then the key-takeover check answers: A stops with 'replaced' through
 * fail(). With 'replaced' cleared by hand, the same engine object starts again: the retry is
 * still the answer (`answered`, not `moves`; A's room works), as after stop() in (a).
 */
export async function sShutdownResetFail(): Promise<void> {
  const { w, A, B } = await linkedPair(true)
  await adv(w, 15 * MIN)
  const room = chanRoom(A, B)
  // A2 finds no list (A keeps none here) and is restored anyway: no contacts, only its key packages.
  const A2 = makePeer(w, 'A2', { words: A.words, bare: true, setup: true, listRelays: LIST_AB, device: 'second' })
  await A2.engine.start()
  await restoreWords(A2, { anyway: true })
  await adv(w, 10_000)
  await A2.engine.stop()
  A2.dead = true
  // The key-takeover check answers 5 minutes after the start: A's answer has failed by then (and its retry at
  // one minute), so the next try waits 10 minutes (CHANNEL_RETRY_MS), not hours.
  w.hub.elsewhereDelayMs = 5 * MIN
  await A.engine.stop()
  await A.engine.start()
  expect(A.state().boot === 'ready', `A is ready while the key-takeover check waits (${A.state().boot})`)
  const evAt = A.events.length
  w.hub.failInvite = (from, to) => from === A.pk && to === B.pk
  w.hub.injectInvite(B.pk, A.pk, { sentAt: Math.floor(w.clock.now() / 1000) })
  await until(w, () => A.events.slice(evAt).some((e) => e.event === 'chan-fail'), 5 * MIN, "A's answer fails to make a room")
  expect(chanRec(A, B)?.moving !== undefined, 'the channel waits for its move')
  await until(w, () => A.state().boot === 'error', 10 * MIN, 'the key-takeover check answers: A stops through fail()')
  expect(A.state().bootError === 'replaced', `with 'replaced' (${A.state().bootError})`)
  // The second device's key packages stay on the relays: the key-takeover check answers no more within this check.
  w.hub.elsewhereDelayMs = 48 * 60 * MIN
  w.hub.failInvite = () => false
  A.kv.seed('replaced', false)
  await A.engine.start()
  expect(A.state().boot === 'ready', `the same engine starts again (${A.state().boot})`)
  await until(w, () => sameNewRoom(A, B, room), 30 * MIN, 'the retry after the start makes the room and B moves into it')
  const rec = chanRec(A, B) as { moves?: number[]; answered?: number[] } | undefined
  expect(
    (rec?.moves ?? []).length === 0 && (rec?.answered ?? []).length === 1,
    `the retry after fail() and a start of the same engine is still the answer (moves ${JSON.stringify(rec?.moves)} / answered ${JSON.stringify(rec?.answered)})`,
  )
  await finish(w)
}

/**
 * S-OLD-ROOM-SETTLED: A's text goes into the room A and B share;
 * the first try is refused and the retry hangs at a slow relay. Meanwhile A answers B's
 * request with a new room, and A's text in the new room fails: the line shows. Then the
 * relay takes the old room's text after all. That says nothing of the new room: the line
 * stays.
 */
export async function sOldRoomSettled(): Promise<void> {
  const { w, A, B } = await linkedPair(true)
  await adv(w, 15 * MIN)
  const room = chanRoom(A, B)
  let oldTries = 0
  w.hub.failSend = (from, g, msg) => {
    if (from !== A.pk || msg.t !== 'chat') return false
    if (g === room && msg.text === 'old room') return ++oldTries === 1 ? 'reject' : { acceptAfterMs: 20 * MIN }
    return g === room ? false : 'reject'
  }
  await A.a.sendChat(B.pk, 'old room')
  await until(w, () => oldTries >= 2, MIN, 'the retry of the old room text hangs at the relay')
  w.hub.injectInvite(B.pk, A.pk, { sentAt: Math.floor(w.clock.now() / 1000) })
  await until(w, () => sameNewRoom(A, B, room), 5 * MIN, 'A answers the request with a room and B moves into it')
  await A.a.sendChat(B.pk, 'new room')
  await until(w, () => textsOf(A, B).find((m) => m.text === 'new room')?.status === 'failed', 10 * MIN, "A's text in the new room fails")
  expect(textsOf(A, B).find((m) => m.text === 'old room')?.status === 'sending', 'the old room text is still on its way')
  expect(!!A.state().reopening[B.pk], 'the failed text raises the line')
  await until(w, () => textsOf(A, B).find((m) => m.text === 'old room')?.status === 'sent', 30 * MIN, 'the relay takes the old room text')
  await adv(w, 1_000)
  expect(!!A.state().reopening[B.pk], `the old room's send leaves the new room's line (${JSON.stringify(A.state().reopening[B.pk])})`)
  w.hub.failSend = () => false
  await finish(w)
}

/**
 * S-CATCHUP-SLOW: a frozen A gets a catch-up from B newest first:
 * sl-4, sl-3, B's round 1, sl-2, sl-1, handed over at once. A's answer to the round 1 waits
 * 8 s on a slow relay, so sl-2 and sl-1 are handled more than CATCHUP_JOIN_MS after sl-3. They
 * still came in with it: A's room shows sl-1..sl-4 in sending order.
 */
export async function sCatchupSlow(): Promise<void> {
  const { w, A, B } = await linkedPair(true)
  await adv(w, MIN)
  A.freeze()
  const t0 = w.clock.now()
  for (let i = 1; i <= 2; i++) {
    await B.a.sendChat(A.pk, `sl-${i}`)
    await adv(w, 20_000)
  }
  await B.a.postOffer({ side: 'sell', currency: 'KRW', amountMinor: 100_000, feePct: 0, methods: BOTH })
  await adv(w, 20_000)
  for (let i = 3; i <= 4; i++) {
    await B.a.sendChat(A.pk, `sl-${i}`)
    await adv(w, 20_000)
  }
  await adv(w, MIN)
  const held = w.hub.held().filter((id) => w.hub.log.find((e) => e.id === id && e.to === A.pk && e.atMs >= t0))
  const m1s = held.filter((id) => w.hub.log.find((e) => e.id === id)?.t === 'm1').length
  expect(held.length >= 5 && m1s >= 1, `the four texts and B's round 1 wait for A (${held.length}, round 1 ${m1s})`)
  let slow = 0
  w.hub.failSend = (from, _g, msg) => {
    if (from !== A.pk || (msg.t !== 'm2' && msg.t !== 'mx')) return false
    slow++
    return { acceptAfterMs: 8_000 }
  }
  for (const id of [...held].reverse()) w.hub.release(id)
  A.thaw()
  await until(w, () => hasText(A, B, 'sl-1'), 2 * MIN, 'the catch-up reaches A')
  await adv(w, 30_000)
  expect(slow >= 1, `A's answer to the round 1 waited on the slow relay (${slow})`)
  const order = textsOf(A, B)
    .filter((m) => !m.mine && m.text.startsWith('sl-'))
    .map((m) => m.text)
    .join('|')
  expect(order === 'sl-1|sl-2|sl-3|sl-4', `the catch-up in sending order (${order})`)
  w.hub.failSend = () => false
  await finish(w)
}

/**
 * S-ANSWER-LINE: A (L) makes a room because B (H) asked for
 * one. Long after any QR of A's: the reopened notice shows once in A's room (a restored
 * phone or a key thief as H still shows it). While A's QR was on screen lately (CODE_RECENT_MS)
 * the request may be B's scan of it, a channel changed by meeting: no line, as
 * where B kept A and its holder scan asked nothing (S-TWIN-RESCAN).
 */
export async function sAnswerLine(qrShown: boolean): Promise<void> {
  const { w, A, B } = await linkedPair(true)
  await adv(w, 15 * MIN)
  if (qrShown) {
    A.a.startConnect()
    await adv(w, 2 * MIN)
    A.a.cancelConnect()
    await adv(w, MIN)
  }
  const room = chanRoom(A, B)
  const t0 = w.clock.now()
  w.hub.injectInvite(B.pk, A.pk, { sentAt: Math.floor(w.clock.now() / 1000) })
  await until(w, () => sameNewRoom(A, B, room), 5 * MIN, 'A answers the request with a room and B moves into it')
  expect(invitesOf(w, A, B, t0).length === 1, 'one room')
  await adv(w, 10 * MIN)
  const lines = (A.state().rooms[B.pk] ?? []).filter((m) => m.kind === 'reopened').length
  expect(lines === (qrShown ? 0 : 1), `the reopened notice in A's room: ${qrShown ? 'none after a recent QR' : 'once'} (${lines})`)
  await finish(w)
}

/**
 * S-TWIN-RESCAN: A is the higher key. World 2's A
 * deletes B; then they meet. World 2's A, a lacking H over a tombstone, asks B (L) for a room
 * (that trace on the wire is allowed); world 1's A is a holder and sends no request.
 * B's screens show the same of A in both worlds at every moment (twin assertion 4): a
 * request alone never makes a status line. `chan`: 'pin', B pinned the room within the last
 * 7 days (B's room once said 'meet and scan' in world
 * 2 only); 'limit', B already moved the room twice in 24 hours (before, B's room named
 * the time the limit opens in world 2 only); 'free', neither. `both`: they scan each other
 * (A first, 5 s apart); otherwise A scans B's QR only. The run goes past B's move window.
 */
export async function sTwinRescan(chan: 'pin' | 'limit' | 'free', both: boolean): Promise<void> {
  const END = chan === 'limit' ? 25 * 60 * MIN : 60 * MIN
  const script: TwinScript = {
    b: [{ atMs: END, act: async () => {} }],
    a: [
      {
        atMs: 10 * MIN,
        act: async (A) => {
          const B = A.world.peers[1]
          if (chan === 'pin') expect(pinOf(B, A) > A.world.clock.now(), "B's room is pinned when they meet")
          if (both) await scanEachOther(A.world, A, B, 5_000)
          else await scanOnly(A.world, A, B)
        },
      },
    ],
  }
  const r = await twin(script, {
    aLow: false,
    relink: true,
    beforeSplit: async (w, A, B) => {
      const n = w.clock.now()
      if (chan === 'pin') await withChannel(B, A, { pinnedUntil: n + 7 * 24 * 60 * MIN })
      if (chan === 'limit') await withChannel(B, A, { moves: [n - 60 * MIN, n - 30 * MIN] })
      await adv(w, MIN)
    },
  })
  const asked = r.worlds.map((w, i) => invitesOf(w, r.a[i], r.b[i], w.clock.now() - END + 9 * MIN).length)
  expect(asked[0] === 0 && asked[1] >= 1, `world 2's A asked B for a room, world 1's did not (${asked.join('/')}): the trace allowed for a re-add by scanning`)
  for (const w of r.worlds) await finish(w)
}

/**
 * S-TWIN-RESCAN-BREAK: S-TWIN-RESCAN with A scanning only,
 * where B (L) already moved the room once 60 minutes before. World 2's B answers A's request
 * by opening a room; world 1's B does not. Then, 2 hours after the scan (within B's 24-hour
 * move window), B's room breaks in both worlds. Once, world 2's B had used its
 * second move on the answer, so only there did its room wait for the move limit and name
 * the time it opens. A move made in answer to a request is kept apart from the move limit
 * (`answered`), so B's screens stay the same in both worlds (twin assertion 4), and B
 * reopens and A follows in both.
 */
export async function sTwinRescanBreak(): Promise<void> {
  const END = 3 * 60 * MIN
  const script: TwinScript = {
    b: [
      {
        atMs: 2 * 60 * MIN + 10 * MIN,
        act: async (B) => {
          const A = B.world.peers[0]
          B.world.hub.loseGroup(B.pk, chanRoom(B, A))
        },
      },
      { atMs: END, act: async () => {} },
    ],
    a: [
      {
        atMs: 10 * MIN,
        act: async (A) => {
          const B = A.world.peers[1]
          await scanOnly(A.world, A, B)
        },
      },
    ],
  }
  const rooms: string[] = []
  const r = await twin(script, {
    aLow: false,
    relink: true,
    beforeSplit: async (w, A, B) => {
      await withChannel(B, A, { moves: [w.clock.now() - 60 * MIN] })
      await adv(w, MIN)
      rooms.push(chanRoom(B, A))
    },
  })
  const asked = r.worlds.map((w, i) => invitesOf(w, r.a[i], r.b[i], w.clock.now() - END + 9 * MIN).length)
  expect(asked[0] === 0 && asked[1] >= 1, `world 2's A asked B for a room, world 1's did not (${asked.join('/')})`)
  const moves = r.b.map((b, i) => (chanRec(b, r.a[i]) as { moves?: number[] } | undefined)?.moves?.length ?? 0)
  expect(moves[0] === moves[1], `B's move limit counts the same moves in both worlds (${moves.join('/')})`)
  for (let i = 0; i < 2; i++) {
    const b = r.b[i]
    const a = r.a[i]
    expect(!b.state().reopening[a.pk], `world ${i + 1}: B's room works again at the end (${JSON.stringify(b.state().reopening[a.pk])})`)
    expect(sameNewRoom(b, a, rooms[i]), `world ${i + 1}: B and A share a new room after the break`)
  }
  for (const w of r.worlds) await finish(w)
}

/**
 * S-TWIN-RESCAN-BREAK-LOW: the mirrored key order of
 * S-TWIN-RESCAN-BREAK, with no move before the split. A (L) scans B's QR only, 10
 * minutes after the split. World 2's A, over its tombstone of B, makes a tagged room at once
 * (relinkFlow); world 1's A, keeping B, makes one only at its holder deadline, about 5
 * minutes later. B (H) joins either by its tag (acceptTagged). Then B's room breaks three
 * times, 2 h 10 min, 3 h and 3 h 50 min after the split, so a later break meets B's move
 * limit (A answers B's requests on a limit of its own, so the second break
 * no longer waits on A). Were the tagged join in B's `moves`, the time its limit opens (on
 * B's screen) would differ by those 5 minutes. The join goes to `answered` instead, so B's
 * screens stay the same in both worlds.
 */
export async function sTwinRescanBreakLow(): Promise<void> {
  const END = 3 * 60 * MIN
  const breakAt = (atMs: number) => ({
    atMs,
    act: async (B: Peer) => {
      const A = B.world.peers[0]
      B.world.hub.loseGroup(B.pk, chanRoom(B, A))
    },
  })
  const script: TwinScript = {
    b: [breakAt(2 * 60 * MIN + 10 * MIN), breakAt(END), breakAt(END + 50 * MIN), { atMs: END + 2 * 60 * MIN, act: async () => {} }],
    a: [
      {
        atMs: 10 * MIN,
        act: async (A) => {
          const B = A.world.peers[1]
          await scanOnly(A.world, A, B)
        },
      },
    ],
  }
  const r = await twin(script, { aLow: true, relink: true, beforeSplit: async (w) => adv(w, MIN) })
  const recs = r.b.map((b, i) => chanRec(b, r.a[i]) as { moves?: number[]; answered?: number[] } | undefined)
  const moves = recs.map((x) => JSON.stringify((x?.moves ?? []).map((m) => m - START_MS)))
  expect(moves[0] === moves[1], `B's move limit holds the same moves in both worlds (${moves.join(' / ')})`)
  const tagged = recs.map((x) => (x?.answered ?? []).length)
  expect(tagged[0] === 1 && tagged[1] === 1, `B's tagged join is in answered in both worlds (${tagged.join('/')})`)
  for (let i = 0; i < 2; i++) {
    const v = r.b[i].views.join('\n')
    expect(v.includes('reopen=at ') || v.includes('reopen=scan'), `world ${i + 1}: a later break meets B's move limit\n${v}`)
  }
  for (const w of r.worlds) await finish(w)
}

/**
 * S-FAILED-LINE-TWIN: B's newest text failed before the
 * split, so B's room shows the reconnecting line; A scans B's QR only, 10 minutes after the
 * split. World 1's A (keeping B) sends its holder proof hello into B's room; world 2's A
 * (over a tombstone) asks for a room (A higher) or makes one (A lower), and B binds it. Neither
 * a hello (scan traffic) nor an answer bind (lineSince) ends the line, so B's screens stay the
 * same in both worlds, in both key orders.
 */
export async function sFailedLineTwin(aLow: boolean): Promise<void> {
  const script: TwinScript = {
    b: [{ atMs: 60 * MIN, act: async () => {} }],
    a: [
      {
        atMs: 10 * MIN,
        act: async (A) => {
          const B = A.world.peers[1]
          await scanOnly(A.world, A, B)
        },
      },
    ],
  }
  const r = await twin(script, {
    aLow,
    relink: true,
    beforeSplit: async (w, A, B) => {
      w.hub.failSend = (from, _g, msg) => (from === B.pk && msg.t === 'chat' ? 'reject' : false)
      await B.a.sendChat(A.pk, 'oops')
      await until(w, () => textsOf(B, A).find((m) => m.text === 'oops')?.status === 'failed', 10 * MIN, "B's text fails")
      w.hub.failSend = () => false
      expect(!!B.state().reopening[A.pk], "B's failed text raises the line before the split")
    },
  })
  const lines = r.b.map((b, i) => !!b.state().reopening[r.a[i].pk])
  expect(lines[0] === lines[1], `B's line is the same in both worlds at the end (${lines.join('/')})`)
  for (const w of r.worlds) await finish(w)
}

/**
 * S-ANSWER-LIMIT: rooms L makes in answer to requests are kept apart from the
 * move limit that shows, but not unbounded: answers have their own limit of two in 24 hours.
 * B (H) asks four times, 20 minutes apart, while A's room works: A
 * answers twice, and the third request waits for the window. A's own move limit (`moves`,
 * the one its screens read) has none of them.
 */
export async function sAnswerLimit(): Promise<void> {
  const { w, A, B } = await linkedPair(true)
  await adv(w, 15 * MIN)
  const t0 = w.clock.now()
  for (let i = 0; i < 4; i++) {
    w.hub.injectInvite(B.pk, A.pk, { sentAt: Math.floor(w.clock.now() / 1000) })
    await adv(w, 20 * MIN)
  }
  await adv(w, 2 * 60 * MIN)
  const n = invitesOf(w, A, B, t0).length
  expect(n === 2, `A answers two requests in 24 hours, not more (${n})`)
  const rec = chanRec(A, B) as { moves?: number[]; answered?: number[] } | undefined
  expect((rec?.moves ?? []).length === 0 && (rec?.answered ?? []).length === 2, `the answers are in answered, not moves (${JSON.stringify(rec?.moves)} / ${JSON.stringify(rec?.answered)})`)
  expect(!A.state().reopening[B.pk], `A's room shows no status (${JSON.stringify(A.state().reopening[B.pk])})`)
  await finish(w)
}

/**
 * S-ANSWER-SEPARATE: my own moves and my answers to the peer's requests
 * are counted apart, two each in 24 hours. A (L) already moved the room twice itself in the
 * last hour; B (H) asks three times, 20 minutes apart, while A's room works. A still answers
 * two of them at once (the third waits for its window), the answers go to `answered`, A's
 * own `moves` stay the two it had, and A's room shows no status line.
 */
export async function sAnswerSeparate(): Promise<void> {
  const { w, A, B } = await linkedPair(true)
  const n = w.clock.now()
  await withChannel(A, B, { moves: [n - 60 * MIN, n - 30 * MIN] })
  await adv(w, MIN)
  await A.a.sendChat(B.pk, 'room works')
  await until(w, () => hasText(B, A, 'room works'), MIN, 'the room carries texts')
  const t0 = w.clock.now()
  w.hub.injectInvite(B.pk, A.pk, { sentAt: Math.floor(w.clock.now() / 1000) })
  await until(w, () => invitesOf(w, A, B, t0).length === 1, 10 * MIN, 'A answers the first request although its own two moves are used')
  for (let i = 0; i < 2; i++) {
    await adv(w, 20 * MIN)
    w.hub.injectInvite(B.pk, A.pk, { sentAt: Math.floor(w.clock.now() / 1000) })
  }
  await adv(w, 2 * 60 * MIN)
  const sent = invitesOf(w, A, B, t0).length
  expect(sent === 2, `A answers two requests, not three (${sent})`)
  const rec = chanRec(A, B) as { moves?: number[]; answered?: number[] } | undefined
  expect(JSON.stringify(rec?.moves) === JSON.stringify([n - 60 * MIN, n - 30 * MIN]), `A's own moves stay the two it made (${JSON.stringify(rec?.moves)})`)
  expect((rec?.answered ?? []).length === 2, `the answers are counted in answered (${JSON.stringify(rec?.answered)})`)
  expect(!A.state().reopening[B.pk], `A's room shows no status (${JSON.stringify(A.state().reopening[B.pk])})`)
  // The answer budget alone gates the third answer, not the later of it and my own window.
  // My first two moves would age out before the answer window opens (24 hours after the
  // first answer), so A's own moves are set again to two made after the answers: A's own
  // window then stays closed until well after the answer window opens. The stop for that
  // drops the waiting request (memory only), so B asks again.
  const first = (rec?.answered ?? [])[0] ?? w.clock.now()
  const m = w.clock.now()
  const own = [m - 10 * MIN, m - 5 * MIN]
  await withChannel(A, B, { moves: own })
  w.hub.injectInvite(B.pk, A.pk, { sentAt: Math.floor(w.clock.now() / 1000) })
  await adv(w, Math.max(0, first + 24 * 60 * MIN - 5 * MIN - w.clock.now()))
  expect(invitesOf(w, A, B, t0).length === 2, `the third request waits for the answer window (${invitesOf(w, A, B, t0).length})`)
  await adv(w, 5 * MIN)
  await until(w, () => invitesOf(w, A, B, t0).length === 3, 10 * MIN, 'A answers the third request once the answer window opens, its own window still closed')
  const after = chanRec(A, B) as { moves?: number[]; answered?: number[] } | undefined
  expect(
    JSON.stringify(after?.moves) === JSON.stringify(own) && own[0] + 24 * 60 * MIN > w.clock.now(),
    `A's own two moves still close its own window when it answers (${JSON.stringify(after?.moves)})`,
  )
  expect((after?.answered ?? []).length === 2, `the third answer is in answered (${JSON.stringify(after?.answered)})`)
  // B's own limit counts the rooms it joined; once that opens the two settle in one room.
  await until(w, () => chanRoom(A, B) !== '' && chanRoom(A, B) === chanRoom(B, A), 3 * 60 * MIN, 'A and B settle in one room')
  await finish(w)
}

/**
 * S-ANSWER-RETRY: an answer that failed is tried again on
 * the answer limit, not my own. A (L) already moved the room twice itself in the last hour;
 * B (H) asks once while A's room works, and every invite of A fails, so the answer leaves
 * the channel waiting for its move (`moving`). Once invites work again, A retries within
 * minutes (CHANNEL_RETRY_MS), not when its own move window opens a day later; the room goes
 * to `answered`, A's own `moves` stay the two it had, and A's room shows no status line
 * while it waits or after (the answer is not my own fact).
 */
export async function sAnswerRetry(): Promise<void> {
  const { w, A, B } = await linkedPair(true)
  const n = w.clock.now()
  await withChannel(A, B, { moves: [n - 60 * MIN, n - 30 * MIN] })
  await adv(w, MIN)
  await A.a.sendChat(B.pk, 'room works')
  await until(w, () => hasText(B, A, 'room works'), MIN, 'the room carries texts')
  const room = chanRoom(A, B)
  const evAt = A.events.length
  w.hub.failInvite = (from, to) => from === A.pk && to === B.pk
  w.hub.injectInvite(B.pk, A.pk, { sentAt: Math.floor(w.clock.now() / 1000) })
  await until(w, () => A.events.slice(evAt).some((e) => e.event === 'chan-fail'), 5 * MIN, "A's answer fails to make a room")
  expect(chanRec(A, B)?.moving !== undefined, 'the channel waits for its move')
  expect(!A.state().reopening[B.pk], `A's room shows no status while the answer waits (${JSON.stringify(A.state().reopening[B.pk])})`)
  w.hub.failInvite = () => false
  await until(w, () => sameNewRoom(A, B, room), 30 * MIN, 'the failed answer is tried again within minutes and B moves into the room')
  const rec = chanRec(A, B) as { moves?: number[]; answered?: number[] } | undefined
  expect(JSON.stringify(rec?.moves) === JSON.stringify([n - 60 * MIN, n - 30 * MIN]), `A's own moves stay the two it made (${JSON.stringify(rec?.moves)})`)
  expect((rec?.answered ?? []).length === 1, `the retried answer is counted in answered (${JSON.stringify(rec?.answered)})`)
  expect(!A.state().reopening[B.pk], `A's room shows no status (${JSON.stringify(A.state().reopening[B.pk])})`)
  await finish(w)
}

/**
 * S-ANSWER-RETRY-TWIN: a failed answer must not change my own
 * status line once my room fails. A (L) moved the room twice itself 23 and 22 hours ago, so
 * its own move window opens in an hour. World 1: B (H) asks while A's room works, and A's
 * answer fails three times (invites refused; the next retry is an hour after the third).
 * World 2: B never asks. 15 minutes on, inside the answer's retry gap, A's room is stranded
 * in both worlds and invites work again. The reopen is now A's own: gated by A's own move
 * window and A's own run of attempts (none, so no scan hint and no retry gap past the
 * window), and counted in `moves`. A's screens of B
 * (its status line: whether, the time it names, the scan hint) are the same in both worlds
 * from the strand on, and both end in a new room with the same `moves` and `answered`.
 */
export async function sAnswerRetryTwin(): Promise<void> {
  const worlds: { w: World; A: Peer; B: Peer }[] = []
  for (const ask of [true, false]) {
    const { w, A, B } = await linkedPair(true)
    const n = w.clock.now()
    await withChannel(A, B, { moves: [n - 23 * 60 * MIN, n - 22 * 60 * MIN] })
    await adv(w, MIN)
    await A.a.sendChat(B.pk, 'room works')
    await until(w, () => hasText(B, A, 'room works'), MIN, 'the room carries texts')
    w.hub.failInvite = (from, to) => from === A.pk && to === B.pk
    const evAt = A.events.length
    if (ask) w.hub.injectInvite(B.pk, A.pk, { sentAt: Math.floor(w.clock.now() / 1000) })
    await adv(w, 15 * MIN)
    const fails = A.events.slice(evAt).filter((e) => e.event === 'chan-fail').length
    expect(ask ? fails >= 3 : fails === 0, `world ${ask ? 1 : 2}: A's answer ${ask ? 'failed' : 'was never asked for'} (${fails} failures)`)
    expect(!A.state().reopening[B.pk], `world ${ask ? 1 : 2}: A's room shows no status before the strand`)
    worlds.push({ w, A, B })
  }
  const rooms = worlds.map(({ A, B }) => chanRoom(A, B))
  for (const { w, A, B } of worlds) {
    A.view = (st) => screenOf(st, B.pk)
    w.hub.failInvite = () => false
    w.hub.strand(chanRoom(A, B))
  }
  // A's own window opens 24 hours after its first own move (about 45 minutes from here).
  for (const { w } of worlds) await adv(w, 30 * MIN)
  for (const [i, { A, B }] of worlds.entries()) {
    const r = A.state().reopening[B.pk]
    expect(!!r && r.at !== undefined && chanRoom(A, B) === rooms[i], `world ${i + 1}: A's line names its own window and A has not moved yet (${JSON.stringify(r)})`)
  }
  for (const { w } of worlds) await adv(w, 24 * 60 * MIN)
  for (const [i, { A, B }] of worlds.entries()) expect(sameNewRoom(A, B, rooms[i]), `world ${i + 1}: A and B end in a new room`)
  const recs = worlds.map(({ A, B }) => chanRec(A, B) as { moves?: number[]; answered?: number[] } | undefined)
  const counts = recs.map((x) => `${JSON.stringify((x?.moves ?? []).map((m) => m - START_MS))} answered=${(x?.answered ?? []).length}`)
  expect(counts[0] === counts[1], `A's moves and answers are the same in both worlds (${counts.join(' / ')})`)
  const [v1, v2] = worlds.map(({ A }) => A.views)
  const at = v1.findIndex((x, i) => x !== v2[i])
  expect(v1.length === v2.length && at < 0, `A's screens of B are the same in both worlds (first difference at ${at}: ${v1[at]} / ${v2[at]})\n${v1.join('\n')}\n--\n${v2.join('\n')}`)
  for (const { w } of worlds) await finish(w)
}

/**
 * S-RESTART-TWIN: a failed answer survives a restart
 * without changing my own channel state. As S-ANSWER-RETRY-TWIN, A (L) moved the room
 * twice itself 23 and 22 hours ago. World 1: B (H) asks while A's room works and A's answer
 * fails three times. World 2: B never asks. Then A restarts (a new engine on the same store)
 * in both worlds. Before the fix the answer was memory only: after the restart A's `moving`
 * made it A's own reopen, gated by A's move window, counted in `moves` and with the answer's
 * attempts as A's own (the scan hint), where world 2 does nothing.
 * (a) `late` false: A's room keeps working. The answer still fails for two hours, then
 * invites work: world 1's answer lands at its next retry and counts in `answered` (the answer budget, the one
 * record the two worlds differ in by design), A's recent `moves` and A's screens
 * of B are the same in both worlds.
 * (b) `late` true: 5 minutes after the restart A's room is stranded in both worlds. The
 * reopen is A's own in both, as in S-ANSWER-RETRY-TWIN: A's own reopens fail for an hour
 * after its window opens (its own run of attempts, not the answer's), then invites work.
 * Same screens, same `moves` and `answered`.
 */
export async function sRestartTwin(late: boolean): Promise<void> {
  const worlds: { w: World; A: Peer; B: Peer }[] = []
  for (const ask of [true, false]) {
    const { w, A, B } = await linkedPair(true)
    const n = w.clock.now()
    await withChannel(A, B, { moves: [n - 23 * 60 * MIN, n - 22 * 60 * MIN] })
    await adv(w, MIN)
    await A.a.sendChat(B.pk, 'room works')
    await until(w, () => hasText(B, A, 'room works'), MIN, 'the room carries texts')
    w.hub.failInvite = (from, to) => from === A.pk && to === B.pk
    const evAt = A.events.length
    if (ask) w.hub.injectInvite(B.pk, A.pk, { sentAt: Math.floor(w.clock.now() / 1000) })
    await adv(w, 15 * MIN)
    const fails = A.events.slice(evAt).filter((e) => e.event === 'chan-fail').length
    expect(ask ? fails >= 3 : fails === 0, `world ${ask ? 1 : 2}: A's answer ${ask ? 'failed' : 'was never asked for'} (${fails} failures)`)
    expect(ask === (chanRec(A, B)?.moving !== undefined), `world ${ask ? 1 : 2}: ${ask ? 'the answer waits as a move' : 'no move'}`)
    await restart(A)
    // The screen after the restart is the first entry: a later change of the store alone
    // (world 1's stored attempts) records nothing unless the screen changes.
    A.view = (st) => screenOf(st, B.pk)
    A.views.push(`${w.clock.now() - START_MS} ${screenOf(A.state(), B.pk)}`)
    worlds.push({ w, A, B })
  }
  const rooms = worlds.map(({ A, B }) => chanRoom(A, B))
  const recOf = (A: Peer, B: Peer) => chanRec(A, B) as { moves?: number[]; answered?: number[] } | undefined
  // A's moves that its move limit still counts (bindRoom drops the older ones it rewrites).
  const recentMoves = (w: World, A: Peer, B: Peer) => JSON.stringify((recOf(A, B)?.moves ?? []).filter((m) => w.clock.now() - m < 24 * 60 * MIN).map((m) => m - START_MS))
  if (!late) {
    // A's own window opens about 45 minutes from here: the answer must not wait for it nor count in it.
    for (const { w } of worlds) await adv(w, 2 * 60 * MIN)
    for (const [i, { A, B }] of worlds.entries()) {
      expect(chanRoom(A, B) === rooms[i] && !A.state().reopening[B.pk], `world ${i + 1}: A keeps its working room and shows no status (${JSON.stringify(A.state().reopening[B.pk])})`)
    }
    // The answer's fourth attempt failed in those two hours: its next one is 6 hours later.
    for (const { w } of worlds) w.hub.failInvite = () => false
    for (const { w } of worlds) await adv(w, 7 * 60 * MIN)
    const [w1, w2] = worlds
    expect(sameNewRoom(w1.A, w1.B, rooms[0]), 'world 1: the answer lands after the restart and A and B share a new room')
    expect(chanRoom(w2.A, w2.B) === rooms[1], 'world 2: A stays in its room')
    const a = worlds.map(({ A, B }) => (recOf(A, B)?.answered ?? []).length)
    expect(a[0] === 1 && a[1] === 0, `the landed answer counts in answered in world 1 only (${a.join(' / ')})`)
  } else {
    for (const { w } of worlds) await adv(w, 5 * MIN)
    for (const { w, A, B } of worlds) w.hub.strand(chanRoom(A, B))
    for (const { w } of worlds) await adv(w, 30 * MIN)
    for (const [i, { A, B }] of worlds.entries()) {
      const r = A.state().reopening[B.pk]
      expect(!!r && r.at !== undefined && !r.scan && chanRoom(A, B) === rooms[i], `world ${i + 1}: A's line names its own window, no scan hint, and A has not moved yet (${JSON.stringify(r)})`)
    }
    // A's own window opens and A's own reopens fail for an hour: its run of attempts (the
    // retry gaps, the scan hint) starts from A's own count in both worlds, not the answer's.
    for (const { w } of worlds) await adv(w, 60 * MIN)
    for (const { w } of worlds) w.hub.failInvite = () => false
    for (const { w } of worlds) await adv(w, 24 * 60 * MIN)
    for (const [i, { A, B }] of worlds.entries()) expect(sameNewRoom(A, B, rooms[i]), `world ${i + 1}: A and B end in a new room`)
    const a = worlds.map(({ A, B }) => (recOf(A, B)?.answered ?? []).length)
    expect(a[0] === a[1], `A's answers are the same in both worlds (${a.join(' / ')})`)
  }
  const m = worlds.map(({ w, A, B }) => recentMoves(w, A, B))
  expect(m[0] === m[1], `A's moves are the same in both worlds (${m.join(' / ')})`)
  // The bound room ended the answer: no stored marker is left to make a later move of A's an answer.
  for (const [i, { A, B }] of worlds.entries()) {
    const rec = chanRec(A, B) as { moving?: number; answerFrom?: unknown } | undefined
    expect(rec?.answerFrom === undefined && rec?.moving === undefined, `world ${i + 1}: no answer or move left under way (${JSON.stringify(rec?.answerFrom)})`)
  }
  const [v1, v2] = worlds.map(({ A }) => A.views)
  const at = v1.findIndex((x, i) => x !== v2[i])
  expect(v1.length === v2.length && at < 0, `A's screens of B are the same in both worlds (first difference at ${at}: ${v1[at]} / ${v2[at]})\n${v1.join('\n')}\n--\n${v2.join('\n')}`)
  for (const { w } of worlds) await finish(w)
}

/**
 * S-RELINK-TWIN: a
 * deletion and a relink end an answer under way. A (L) moved the room twice itself 23 and 22
 * hours ago. World 1: B (H) asks while A's room works and A's answer fails three times.
 * World 2: B never asks. Then, in both worlds:
 * 1. A deletes B and invites work for 90 minutes. A deletion ends the answer: no answer lands
 *    in the tombstone's room (before the fix world 1's answer went on and counted in `answered`).
 * 2. Invites fail again; in world 1 B asks once more and A's answer on the tombstone fails.
 * 3. A scans B's QR and its relink invite fails (the scan goes). The relink's own `moving`
 *    must not read as that answer: the tombstone's channel reopens as A's own move in both
 *    worlds (before the fix world 1 waited on the answer's attempts and counted it in
 *    `answered`). Invites work again and the channel reopens.
 * 4. A and B scan each other's QR: the link completes and B is a contact again.
 * 5. A week later (B's pin of the re-add has ended; A's own move window is open) A's
 *    room breaks; A's own reopens fail for an hour (its run of attempts, the scan hint), then
 *    invites work and A and B end in a new room.
 * A's screens of B (whether a contact, the status line, its time and scan hint), its moves,
 * `answered` and its run of attempts are the same in both worlds from the answer on.
 */
export async function sRelinkTwin(): Promise<void> {
  const worlds: { w: World; A: Peer; B: Peer }[] = []
  const failAB = (w: World, A: Peer, B: Peer) => (w.hub.failInvite = (from, to) => from === A.pk && to === B.pk)
  const failsSince = (A: Peer, at: number, ev: string) => A.events.slice(at).filter((e) => e.event === ev).length
  for (const ask of [true, false]) {
    const { w, A, B } = await linkedPair(true)
    const n = w.clock.now()
    await withChannel(A, B, { moves: [n - 23 * 60 * MIN, n - 22 * 60 * MIN] })
    await adv(w, MIN)
    await A.a.sendChat(B.pk, 'room works')
    await until(w, () => hasText(B, A, 'room works'), MIN, 'the room carries texts')
    failAB(w, A, B)
    const evAt = A.events.length
    if (ask) w.hub.injectInvite(B.pk, A.pk, { sentAt: Math.floor(w.clock.now() / 1000) })
    await adv(w, 15 * MIN)
    const fails = failsSince(A, evAt, 'chan-fail')
    expect(ask ? fails >= 3 : fails === 0, `world ${ask ? 1 : 2}: A's answer ${ask ? 'failed' : 'was never asked for'} (${fails} failures)`)
    A.view = (st) => screenOf(st, B.pk)
    A.views.push(`${w.clock.now() - START_MS} ${screenOf(A.state(), B.pk)}`)
    worlds.push({ w, A, B })
  }
  const rooms = worlds.map(({ A, B }) => chanRoom(A, B))
  type Rec = { moves?: number[]; answered?: number[]; moving?: number; answerFrom?: unknown; tries?: number; triedAt?: number }
  const recOf = (A: Peer, B: Peer) => chanRec(A, B) as Rec | undefined
  const rel = (x: number | undefined) => (x === undefined ? '-' : String(x - START_MS))
  const facts = (A: Peer, B: Peer) => {
    const r = recOf(A, B)
    return `moves=${JSON.stringify((r?.moves ?? []).map((m) => m - START_MS))} answered=${JSON.stringify((r?.answered ?? []).map((m) => m - START_MS))} moving=${rel(r?.moving)} tries=${r?.tries ?? '-'}@${rel(r?.triedAt)}`
  }
  const same = (what: string) => {
    const f = worlds.map(({ A, B }) => facts(A, B))
    expect(f[0] === f[1], `${what}: A's channel facts are the same in both worlds (${f.join(' / ')})`)
  }
  // 1. The deletion ends the answer.
  for (const { w, A, B } of worlds) {
    await deleteContact(w, A, B)
    const r = recOf(A, B)
    expect(!hasContact(A, B) && r?.answerFrom === undefined && r?.moving === undefined, `the delete leaves no answer or move under way (${JSON.stringify(r)})`)
    w.hub.failInvite = () => false
  }
  same('after the delete')
  for (const { w } of worlds) await adv(w, 90 * MIN)
  for (const [i, { A, B }] of worlds.entries()) expect(chanRoom(A, B) === rooms[i], `world ${i + 1}: no answer lands in the tombstone's room`)
  same('90 minutes after the delete')
  // 2. B asks the tombstone in world 1; the answer fails.
  for (const [i, { w, A, B }] of worlds.entries()) {
    failAB(w, A, B)
    const evAt = A.events.length
    if (i === 0) w.hub.injectInvite(B.pk, A.pk, { sentAt: Math.floor(w.clock.now() / 1000) })
    await adv(w, 15 * MIN)
    const fails = failsSince(A, evAt, 'chan-fail')
    expect(i === 0 ? fails >= 3 : fails === 0, `world ${i + 1}: A's answer on the tombstone ${i === 0 ? 'failed' : 'was never asked for'} (${fails} failures)`)
  }
  // 3. A re-scans B; the relink invite fails and the scan goes.
  for (const [i, { w, A, B }] of worlds.entries()) {
    const evAt = A.events.length
    await scanOnly(w, A, B)
    await adv(w, 10_000)
    expect(failsSince(A, evAt, 'invite-failed') === 1 && !hasContact(A, B), `world ${i + 1}: A's relink invite failed`)
    const r = recOf(A, B)
    expect(r?.answerFrom === undefined && r?.moving !== undefined, `world ${i + 1}: the relink's move is under way and is no answer (${JSON.stringify(r)})`)
    B.a.cancelConnect()
  }
  same('after the failed relink')
  for (const { w } of worlds) await adv(w, 20 * MIN)
  same('20 minutes after the failed relink')
  for (const { w } of worlds) w.hub.failInvite = () => false
  for (const { w } of worlds) await adv(w, 90 * MIN)
  for (const [i, { A, B }] of worlds.entries()) expect(sameNewRoom(A, B, rooms[i]) && !hasContact(A, B), `world ${i + 1}: the tombstone's channel reopened in a new room`)
  same('after the reopen of the tombstone')
  // 4. A scans B again: the link completes.
  for (const [i, { w, A, B }] of worlds.entries()) {
    await scanEachOther(w, A, B, 5_000)
    await until(w, () => hasContact(A, B) && A.state().connect.phase === 'done', 3 * MIN, `world ${i + 1}: A re-adds B`)
    B.a.cancelConnect()
    A.a.cancelConnect()
    await adv(w, 5 * MIN)
    const r = recOf(A, B)
    expect(r?.answerFrom === undefined && r?.moving === undefined, `world ${i + 1}: the new contact has no answer or move under way (${JSON.stringify(r)})`)
  }
  same('after the re-add')
  // 5. A's room breaks a week later (B's pin of the re-add has ended; A's own move
  // window is open); A's own reopens fail for an hour, then work.
  for (const { w } of worlds) await adv(w, 7 * 24 * 60 * MIN + 60 * MIN)
  const relinked = worlds.map(({ A, B }) => chanRoom(A, B))
  for (const { w, A, B } of worlds) {
    failAB(w, A, B)
    w.hub.strand(chanRoom(A, B))
  }
  for (const { w } of worlds) await adv(w, 60 * MIN)
  same('an hour into the break')
  for (const [i, { A, B }] of worlds.entries()) {
    const r = A.state().reopening[B.pk]
    expect(!!r && chanRoom(A, B) === relinked[i], `world ${i + 1}: A's line shows while its reopens fail (${JSON.stringify(r)})`)
  }
  for (const { w } of worlds) w.hub.failInvite = () => false
  for (const { w } of worlds) await adv(w, 24 * 60 * MIN)
  for (const [i, { A, B }] of worlds.entries()) expect(sameNewRoom(A, B, relinked[i]) && !A.state().reopening[B.pk], `world ${i + 1}: A and B end in a new room (${facts(A, B)})`)
  same('at the end')
  const [v1, v2] = worlds.map(({ A }) => A.views)
  const at = v1.findIndex((x, i) => x !== v2[i])
  expect(v1.length === v2.length && at < 0, `A's screens of B are the same in both worlds (first difference at ${at}: ${v1[at]} / ${v2[at]})\n${v1.join('\n')}\n--\n${v2.join('\n')}`)
  expect(
    v1.some((v) => v.includes('reopen=scan')),
    `the break reached A's scan hint (its own run of attempts)\n${v1.join('\n')}`,
  )
  for (const { w } of worlds) await finish(w)
}

/**
 * S-RESTORE-RESCAN-CATCHUP (interaction of restore, the twin rescan and the
 * catch-up order). B also has a contact C (same keys in both worlds). Right after the split
 * (world 2's A deletes B) B's phone is restored (restoredKv, the store recovery leaves) and
 * B reopens its channels; A meets B 20 minutes later and scans B's QR. Then B's page is
 * frozen while C sends five texts, 2 s apart, and thaws. B's screens show the same of A in
 * both worlds at every moment (twin assertion 4), and C's texts land in sending order in both.
 */
export async function sRestoreRescanCatchup(bLow: boolean): Promise<void> {
  const wordsC = newMnemonic()
  const cs: Peer[] = []
  const END = 90 * MIN
  const script: TwinScript = {
    b: [
      { atMs: 0, act: (p) => restore(p) },
      {
        atMs: 40 * MIN,
        act: async (B) => {
          const w = B.world
          const C = cs[cs.length - 1]
          B.freeze()
          const t0 = w.clock.now()
          for (let i = 1; i <= 5; i++) {
            await C.a.sendChat(B.pk, `c-${i}`)
            await adv(w, 2_000)
          }
          await adv(w, MIN)
          // The catch-up hands them over newest first, as a relay backfill does.
          const held = w.hub.held().filter((id) => w.hub.log.find((e) => e.id === id && e.to === B.pk && e.from === C.pk && e.atMs >= t0))
          expect(held.length >= 5, `C's texts wait for the frozen B (${held.length})`)
          for (const id of [...held].reverse()) w.hub.release(id)
          B.thaw()
        },
      },
      { atMs: END, act: async () => {} },
    ],
    a: [{ atMs: 20 * MIN, act: async (A) => void (await scanOnly(A.world, A, A.world.peers[1])) }],
  }
  const r = await twin(script, {
    aLow: !bLow,
    relink: true,
    beforeSplit: async (w, _A, B) => {
      const C = makePeer(w, 'C', { words: wordsC })
      await C.engine.start()
      await link(w, B, C)
      await C.a.sendChat(B.pk, 'hi')
      await adv(w, 5_000)
      await B.a.sendChat(C.pk, 'hi')
      await adv(w, 30_000)
      cs.push(C)
    },
  })
  for (let i = 0; i < 2; i++) {
    const got = textsOf(r.b[i], cs[i])
      .filter((m) => !m.mine && m.text.startsWith('c-'))
      .map((m) => m.text)
    expect(got.join('|') === 'c-1|c-2|c-3|c-4|c-5', `world ${i + 1}: C's caught-up texts in sending order on the restored B (${got.join('|')})`)
    expect(hasContact(r.b[i], cs[i]) && hasContact(r.b[i], r.a[i]), `world ${i + 1}: B still has A and C`)
  }
  for (const w of r.worlds) await finish(w)
}

/**
 * S-TWIN-FROZEN: as S-TWIN-RESCAN ('free', A
 * scans only), but B leaves the connect screen and its phone sleeps the moment A scans: B's
 * tab is frozen and offline for 15 minutes, so world 2's request reaches B long after B's
 * last code (more than CODE_RECENT_MS). B's screens still show the same of A in both worlds
 * (twin assertion 4): the reopened notice is judged on the request's own time, not its
 * arrival (codeShownNear). Before the fix world 2's B showed 'reopened' after the thaw.
 */
export async function sTwinFrozen(): Promise<void> {
  const END = 60 * MIN
  const script: TwinScript = {
    b: [{ atMs: END, act: async () => {} }],
    a: [
      {
        atMs: 10 * MIN,
        act: async (A) => {
          const w = A.world
          const B = w.peers[1]
          B.a.startConnect()
          const py = B.state().connect.myPayload ?? ''
          expect(py !== '', "B's QR is on screen")
          w.payloads.push(py)
          void A.a.submitScan(py, 'camera').catch(() => {})
          B.a.cancelConnect()
          B.freeze()
          w.hub.setNetwork(B.pk, 'down')
          await w.clock.settle()
          await adv(w, 15 * MIN)
          w.hub.setNetwork(B.pk, 'up')
          B.thaw()
        },
      },
    ],
  }
  const r = await twin(script, { aLow: false, relink: true })
  const asked = r.worlds.map((w, i) => invitesOf(w, r.a[i], r.b[i], w.clock.now() - END + 9 * MIN).length)
  expect(asked[0] === 0 && asked[1] >= 1, `world 2's A asked B for a room, world 1's did not (${asked.join('/')})`)
  const lines = r.b.map((b, i) => (b.state().rooms[r.a[i].pk] ?? []).filter((m) => m.kind === 'reopened').length)
  expect(lines[0] === 0 && lines[1] === 0, `no reopened notice in B's room in either world (${lines.join('/')})`)
  for (const w of r.worlds) await finish(w)
}

/**
 * S-DEV-FROZEN-FLOOD: A and B matched, C linked to
 * both and matching nobody. A's room with B is near the cap (180 of my texts). A's tab is
 * frozen while B sends 60 texts and changes its amount after the 40th. The catch-up hands
 * them to A newest first. After the thaw: B's texts are in sending order, the 'changed'
 * line sits between the 40th and the 41st, B's newest 50 survive the cap, the room holds
 * no more than the cap and the trade records, and nothing reached C. Also after a restart.
 */
export async function sDevFrozenFlood(): Promise<void> {
  const { w, A, B, C } = await reopenTrio()
  for (let i = 0; i < 180; i++) {
    await A.a.sendChat(B.pk, `near ${i}`)
    if (i % 25 === 24) await adv(w, 5_000)
  }
  await adv(w, 30_000)
  A.freeze()
  const t0 = w.clock.now()
  for (let i = 0; i < 60; i++) {
    await B.a.sendChat(A.pk, `fl-${i}`)
    await adv(w, 2_000)
    if (i === 39) {
      await B.a.postOffer({ side: 'sell', currency: 'KRW', amountMinor: 80_000, feePct: 3, methods: BOTH })
      await adv(w, 2_000)
    }
  }
  await adv(w, 2 * MIN)
  const held = w.hub.held().filter((id) => w.hub.log.find((e) => e.id === id && e.to === A.pk && e.from === B.pk && e.atMs >= t0))
  expect(held.length >= 61, `the 60 texts and the offer wait for A (${held.length})`)
  for (const id of [...held].reverse()) w.hub.release(id)
  A.thaw()
  await adv(w, 60_000)
  const check = (when: string): void => {
    const room = A.state().rooms[B.pk] ?? []
    const seq = room.filter((m) => (m.kind === 'text' && !m.mine && m.text.startsWith('fl-')) || m.kind === 'changed').map((m) => (m.kind === 'text' ? m.text : 'changed'))
    const nums = seq.filter((x) => x !== 'changed').map((x) => Number(x.slice(3)))
    expect(
      nums.every((n, i) => i === 0 || nums[i - 1] < n),
      `${when}: B's texts in sending order (${nums.slice(0, 5).join(',')}…)`,
    )
    const newest = Array.from({ length: 50 }, (_, i) => `fl-${i + 10}`)
    expect(
      newest.every((t) => seq.includes(t)),
      `${when}: B's newest 50 survive the cap (${nums.length} of B's)`,
    )
    const c = seq.indexOf('changed')
    expect(c > 0 && seq[c - 1] === 'fl-39' && seq[c + 1] === 'fl-40', `${when}: the 'changed' line sits between fl-39 and fl-40 (${seq.slice(Math.max(0, c - 1), c + 2).join(',')})`)
    const texts = room.filter((m) => m.kind === 'text').length
    expect(texts <= 200, `${when}: the room keeps at most 200 texts (${texts})`)
    expect(hasText(A, B, 'near 179'), `${when}: my newest text stays`)
  }
  check('after the thaw')
  await restart(A)
  await adv(w, 30_000)
  check('after a restart')
  expectNoLeakToC(w, A, B, C)
  const cDump = dumpOf(C)
  expect(!holdsNumber(cDump, 80_000) && !holdsNumber(cDump, 90_000), "C holds no trace of B's amounts")
  expect(!(C.state().rooms[B.pk] ?? []).some((m) => m.kind === 'text' && m.text.startsWith('fl-')), "none of B's texts to A reached C's room")
  await finish(w)
}
