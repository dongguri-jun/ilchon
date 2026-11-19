/**
 * Engine check scenarios: rescans, holders, resume windows.
 * Run from scripts/check-engine.ts, which lists every scenario in its order.
 */
import { sha256 } from '@noble/hashes/sha2.js'
import { bytesToHex, utf8ToBytes } from '@noble/hashes/utils.js'
import { HOLDER_CODE_MS, HOLDER_PAIR_MS, HOLDER_SCAN_TTL_MS, RESUME_WINDOW_MAX_MS } from '../../../src/engine/index'
import { randomHex } from '../../../src/lib/marmot/keys'
import type { Envelope, FakeHub } from '../../fake-transport'
import * as connectModule from '../../../src/lib/connect'
import {
  CHANNEL_CHECK,
  type ChanRec,
  chanRec,
  chanRoom,
  codeOf,
  dropThief,
  expectSameEnvelopes,
  expectWorking,
  hasText,
  linkedPair,
  off,
  on,
  payloadKp,
  pinOf,
  sameNewRoom,
  scanEachOther,
  scanOnly,
  thiefOf,
  withChannel,
} from '../helpers/channel'
import { verifiedOf } from '../helpers/delivery'
import { type TwinScript, twin } from '../helpers/twin'
import { expect } from '../report'
import { BOTH, MIN, type Peer, START_MS, type World, adv, deleteContact, finish, hasContact, link, makePeer, newWorld, orderedKeys, sent, settled, until } from '../world'

/** Everything that went over the wire between x and y (both ways) since `since`. */
function wireSince(w: World, x: Peer, y: Peer, since: number): Envelope[] {
  return [...sent(w, x, y), ...sent(w, y, x)].filter((e) => e.atMs >= since)
}
const payloadCode = (p: string): string => connectModule.decodePayload(p)?.code ?? ''

/**
 * S-CH-RESCAN: two healthy contacts whose room is older than
 * HOLDER_PAIR_MS scan each other (A or B first, 5 s, 90 s or 4 min apart, A the lower or
 * the higher key). Both screens say 'already' with my QR still there (a new code on
 * rotate). Until the last scan + HOLDER_SCAN_TTL_MS: no invite, no group, no request;
 * room, names and chat stay, no pin, no reopened notice. On the lossless hub exactly two
 * hellos each way: my proof (the peer's code) and my echo of the peer's proof (my code).
 */
export async function sChRescan(aLow: boolean, aFirst: boolean, gapMs: number, matched = false): Promise<void> {
  const { w, A, B } = await linkedPair(aLow)
  await B.a.renameContact(A.pk, '에이')
  if (matched) {
    // S-BOT-HOLDER-RESCAN (나): they match first; the rescan leaves the match as it was.
    // Methods overlap only partly (A both, B on-chain only): the overlap still matches.
    await A.a.postOffer({ side: 'buy', currency: 'KRW', amountMinor: 90000, feePct: 1, methods: ['lightning', 'onchain'] })
    await B.a.postOffer({ side: 'sell', currency: 'KRW', amountMinor: 90000, feePct: 1, methods: ['onchain'] })
    await until(w, () => A.state().matches.some((m) => m.contactId === B.pk) && B.state().matches.some((m) => m.contactId === A.pk), 5 * MIN, 'they match before the rescan')
  }
  await adv(w, 6 * MIN)
  const verifiedBefore = JSON.stringify([verifiedOf(A)[B.pk], verifiedOf(B)[A.pk]])
  const matchesOf = () => JSON.stringify([A.state().matches, B.state().matches])
  const matchesBefore = matchesOf()
  const room = chanRoom(A, B)
  const groups = [w.hub.groupsOf(A.pk).join(), w.hub.groupsOf(B.pk).join()].join('|')
  const t0 = w.clock.now()
  const [first, second] = aFirst ? [A, B] : [B, A]
  const { p1, p2 } = await scanEachOther(w, first, second, gapMs)
  // first scanned second's QR (p2), second scanned first's (p1).
  const cB = payloadCode(aFirst ? p2 : p1)
  const cA = payloadCode(aFirst ? p1 : p2)
  for (const p of [A, B]) {
    const c = p.state().connect
    expect(c.phase === 'already' && !!c.myPayload && c.errorKey === undefined, `${p.name}: 'already' and my QR stays (${c.phase})`)
    const before = c.myPayload
    p.a.rotateConnectCode()
    expect(p.state().connect.myPayload !== before && p.state().connect.phase === 'already', `${p.name}: the QR still rotates in 'already'`)
  }
  await adv(w, HOLDER_SCAN_TTL_MS + MIN)
  const wire = wireSince(w, A, B, t0)
  const ab = wire.filter((e) => e.from === A.pk)
  const ba = wire.filter((e) => e.from === B.pk)
  expect(
    wire.every((e) => e.t === 'hello' && e.groupId === room),
    `only hellos, in the old room (${[...new Set(wire.map((e) => e.t))].join(',')})`,
  )
  expect(
    ab.length === 2 && ab.some((e) => codeOf(e) === cB) && ab.some((e) => codeOf(e) === cA),
    `A→B: its proof and its echo (${ab
      .map(codeOf)
      .map((c) => (c === cA ? 'cA' : c === cB ? 'cB' : '?'))
      .join(',')})`,
  )
  expect(ba.length === 2 && ba.some((e) => codeOf(e) === cA) && ba.some((e) => codeOf(e) === cB), `B→A: its proof and its echo (${ba.length})`)
  expect(w.hub.invites.filter((r) => r.atMs >= t0).length === 0, 'no invite, no request')
  expect([w.hub.groupsOf(A.pk).join(), w.hub.groupsOf(B.pk).join()].join('|') === groups && chanRoom(A, B) === room && chanRoom(B, A) === room, 'the same room, no new one')
  expect(A.state().contacts.find((c) => c.pubkey === B.pk)?.name === '비' && B.state().contacts.find((c) => c.pubkey === A.pk)?.name === '에이', 'names stay')
  expect(hasText(A, B, 'one') && hasText(A, B, 'two') && hasText(B, A, 'one') && hasText(B, A, 'two'), 'chats stay')
  expect(pinOf(A, B) === 0 && pinOf(B, A) === 0, 'no pin')
  expect(A.engine.sizes().notices === 0 && B.engine.sizes().notices === 0, 'no reopened notice')
  expect(Object.keys(A.kv.peek<object>('scans') ?? {}).length === 0 && Object.keys(B.kv.peek<object>('scans') ?? {}).length === 0, 'the holder scans ended')
  // S-CH-RESCAN: matches and verified as they were (nothing moved, no round started over).
  expect(matchesOf() === matchesBefore, 'matches unchanged')
  expect(JSON.stringify([verifiedOf(A)[B.pk], verifiedOf(B)[A.pk]]) === verifiedBefore, 'verified unchanged')
  if (matched) {
    expect(A.state().matches.some((m) => m.contactId === B.pk) && B.state().matches.some((m) => m.contactId === A.pk), 'the match stays')
    expect(JSON.stringify([verifiedOf(A)[B.pk], verifiedOf(B)[A.pk]]) === verifiedBefore && verifiedOf(A)[B.pk] !== undefined, 'the verified matches stay')
  }
  await finish(w)
}

/**
 * S-CH-RESCAN-FRESH: two contacts rescan each other right after their first link.
 * The pairing counts each other's proof in that room: no new room, and no pin (the room of
 * a first link was bound by the scans, not by a move or a tag).
 */
export async function sChRescanFresh(aLow: boolean): Promise<void> {
  const { w, A, B } = await linkedPair(aLow)
  const room = chanRoom(A, B)
  const t0 = w.clock.now()
  expect(t0 - (chanRec(A, B)?.roomAt ?? 0) < 2 * MIN && t0 - (chanRec(B, A)?.roomAt ?? 0) < 2 * MIN, 'the first link bound the room moments ago')
  await scanEachOther(w, A, B, 5_000)
  expect(A.state().connect.phase === 'already' && B.state().connect.phase === 'already', "both say 'already'")
  await adv(w, HOLDER_SCAN_TTL_MS + MIN)
  const wire = wireSince(w, A, B, t0)
  expect(wire.every((e) => e.t === 'hello') && wire.length === 4, `two hellos each way (${wire.length})`)
  expect(w.hub.invites.filter((r) => r.atMs >= t0).length === 0, 'no invite, no request')
  expect(chanRoom(A, B) === room && chanRoom(B, A) === room, 'the same room')
  expect(pinOf(A, B) === 0 && pinOf(B, A) === 0, 'no pin')
  await finish(w)
}

/**
 * S-CH-RESCAN-AFTER-MOVE: two healthy contacts rescan each other within
 * HOLDER_PAIR_MS of a remote reopen (the room was lost and moved). The proofs pair in the new
 * room: no new room, two hellos each way, and both pin the channel for 7 days (a room a
 * move bound in the last 7 days, proved by both scans). The moving side's reopened notice is
 * not drawn (it scanned, 12 나).
 */
export async function sChRescanAfterMove(aLow: boolean): Promise<void> {
  const { w, A, B } = await linkedPair(aLow)
  await adv(w, 6 * MIN)
  const was = chanRoom(A, B)
  w.hub.loseGroup(B.pk, was)
  await until(w, () => sameNewRoom(A, B, was), 5 * MIN, 'the room moves (remote reopen)')
  await adv(w, 30_000)
  const room = chanRoom(A, B)
  const groups = [w.hub.groupsOf(A.pk).join(), w.hub.groupsOf(B.pk).join()].join('|')
  const t0 = w.clock.now()
  await scanEachOther(w, A, B, 5_000)
  await adv(w, HOLDER_SCAN_TTL_MS + MIN)
  const wire = wireSince(w, A, B, t0)
  const ab = wire.filter((e) => e.from === A.pk).length
  const ba = wire.filter((e) => e.from === B.pk).length
  expect(wire.every((e) => e.t === 'hello') && ab === 2 && ba === 2, `two hellos each way (A ${ab}, B ${ba})`)
  expect(w.hub.invites.filter((r) => r.atMs >= t0).length === 0, 'no invite, no request')
  expect([w.hub.groupsOf(A.pk).join(), w.hub.groupsOf(B.pk).join()].join('|') === groups && chanRoom(A, B) === room && chanRoom(B, A) === room, 'the same room, no new one')
  expect(pinOf(A, B) > w.clock.now() + 6 * 24 * 60 * MIN && pinOf(B, A) > w.clock.now() + 6 * 24 * 60 * MIN, 'both pinned for 7 days (10 나)')
  expect(A.engine.sizes().notices === 0 && B.engine.sizes().notices === 0, 'no reopened notice')
  expect(A.state().contacts.find((c) => c.pubkey === B.pk)?.name === '비' && hasText(A, B, 'one') && hasText(B, A, 'two'), 'name and chat stay')
  await finish(w)
}

type OneSided = 'plain' | 'pinned' | 'full' | 'off-next-day'

/**
 * S-CH-RESCAN one-sided: only A scans. A as H: no invite or request, one
 * proof and its echo. A as L: at its scan + HOLDER_PAIR_MS A makes exactly one new room
 * for the key package in B's QR, tagged; B binds it by its tag (no pin, no reopened
 * notice), also when B's channel is pinned, B's move limit is full, or B is off from before
 * the deadline until the next day.
 */
export async function sChRescanOneSided(aLow: boolean, variant: OneSided): Promise<void> {
  const { w, A, B } = await linkedPair(aLow)
  await adv(w, 6 * MIN)
  const room = chanRoom(A, B)
  if (variant === 'pinned') await withChannel(B, A, { pinnedUntil: w.clock.now() + 3 * 24 * 60 * MIN })
  if (variant === 'full') await withChannel(B, A, { moves: [w.clock.now() - 2 * 60 * MIN, w.clock.now() - 60 * MIN] })
  await adv(w, 30_000)
  const t0 = w.clock.now()
  const pb = await scanOnly(w, A, B)
  expect(A.state().connect.phase === 'already', "A says 'already'")
  if (variant === 'off-next-day') {
    await adv(w, MIN)
    await off(B)
    await adv(w, 24 * 60 * MIN)
    await on(B)
  }
  await adv(w, HOLDER_SCAN_TTL_MS + MIN)
  const inv = w.hub.invites.filter((r) => r.atMs >= t0)
  if (!aLow) {
    const wire = wireSince(w, A, B, t0)
    expect(inv.length === 0, `A (H) asks for nothing (${inv.length})`)
    expect(wire.filter((e) => e.from === A.pk).length === 1 && wire.filter((e) => e.from === B.pk).length === 1, `one proof, one echo (${wire.length})`)
    expect(chanRoom(A, B) === room && chanRoom(B, A) === room, 'the same room')
  } else {
    expect(inv.length === 1 && inv[0].from === A.pk && inv[0].accepted, `A (L) made one room and B joined it (${inv.length})`)
    expect(inv[0].atMs >= t0 + 5 * MIN && inv[0].atMs < t0 + 5 * MIN + 10_000, `at the deadline (${inv[0].atMs - t0} ms)`)
    expect(inv[0].kpRef === payloadKp(pb), "for the key package in B's QR")
    expect(w.hub.tagOf(inv[0].groupId) !== undefined, 'tagged')
    // The tag and the pre-join room-shape check read one preview.
    expect(inv[0].previews === 1, `B decrypted the tagged Welcome once before joining it (${inv[0].previews})`)
    expect(sameNewRoom(A, B, room) && chanRoom(A, B) === inv[0].groupId, 'both in that room')
    if (variant !== 'pinned') expect(pinOf(A, B) === 0 && pinOf(B, A) === 0, 'no pin')
    expect((chanRec(B, A) as { boundBy?: string })?.boundBy === 'tag', 'B bound it by its tag')
  }
  expect(A.engine.sizes().notices === 0 && B.engine.sizes().notices === 0, 'no reopened notice')
  expect(hasText(A, B, 'one') && hasText(B, A, 'two') && B.state().connect.phase !== 'failed', 'chats stay, screens unchanged')
  await finish(w)
}

/**
 * S-CH-RESCAN 6 minutes apart: A (L) scans first, B 6 minutes later. A's deadline
 * makes one room, B binds it by its tag; B's scan pairs in it (10 나) and A gets B's proof
 * in the room it bound (10 가): one room, both pinned, no reopened notice.
 */
export async function sChRescanSixMin(): Promise<void> {
  const { w, A, B } = await linkedPair(true)
  await adv(w, 6 * MIN)
  const room = chanRoom(A, B)
  const t0 = w.clock.now()
  await scanEachOther(w, A, B, 6 * MIN)
  await adv(w, HOLDER_SCAN_TTL_MS + MIN)
  const inv = w.hub.invites.filter((r) => r.atMs >= t0)
  expect(inv.length === 1 && inv[0].from === A.pk && inv[0].accepted, `A made one new room (${inv.length})`)
  expect(sameNewRoom(A, B, room), 'one room, a new one')
  expect(pinOf(A, B) > w.clock.now() && pinOf(B, A) > w.clock.now(), 'both pinned')
  expect(A.engine.sizes().notices === 0 && B.engine.sizes().notices === 0, 'no reopened notice')
  await finish(w)
}

/**
 * S-CH-RESCAN background: A (L) scans and its app closes at once. (a) B scans
 * 4 minutes later and A opens again at 8 minutes: A pairs B's proof from the backlog, no
 * room moves. (b) Nobody else scans and A opens at 8 minutes, past its deadline + 1 minute:
 * no new room.
 */
export async function sChRescanBackground(bScans: boolean): Promise<void> {
  const { w, A, B } = await linkedPair(true)
  await adv(w, 6 * MIN)
  const room = chanRoom(A, B)
  const t0 = w.clock.now()
  A.a.startConnect()
  const pa = A.state().connect.myPayload ?? ''
  w.payloads.push(pa)
  await scanOnly(w, A, B)
  await adv(w, 2_000)
  await off(A)
  if (bScans) {
    await adv(w, 4 * MIN - 2_000)
    void B.a.submitScan(pa, 'camera').catch(() => {})
    await adv(w, 4 * MIN)
  } else await adv(w, 8 * MIN - 2_000)
  await on(A)
  await adv(w, HOLDER_SCAN_TTL_MS + MIN)
  expect(w.hub.invites.filter((r) => r.atMs >= t0).length === 0, 'no new room')
  expect(chanRoom(A, B) === room && chanRoom(B, A) === room, 'the same room')
  await finish(w)
}

/**
 * S-CH-RESCAN background return: A (L) and B scan each
 * other a second apart, and A's tab goes to the background at once and is frozen (A's
 * engine keeps running; its timers and incoming envelopes wait). B's proof is slow on the
 * relays, so it waits for A too. A comes back 20 s after its deadline: the deadline timer
 * fires late, either before the visibility event ('timers-first') or after it
 * ('visible-first'). Either way the deadline waits for the backlog (resumeUntil), counts
 * B's proof and no room moves. Without that A, as L, judged the deadline before reading
 * the backlog and opened a needless new room (which moves the channel and pins it).
 */
export async function sChRescanBackgroundReturn(order: 'timers-first' | 'visible-first'): Promise<void> {
  const { w, A, B } = await linkedPair(true)
  await adv(w, 6 * MIN)
  const room = chanRoom(A, B)
  const t0 = w.clock.now()
  // B's envelopes to A are slow on the relays from here on.
  w.hub.route = (e) => (e.from === B.pk && e.to === A.pk ? 'hold' : 'deliver')
  await scanEachOther(w, A, B, 1_000)
  await adv(w, 1_000)
  A.freeze()
  await adv(w, 5 * MIN + 20_000 - (w.clock.now() - t0))
  expect(
    w.hub.held().some((id) => w.hub.log.find((e) => e.id === id)?.from === B.pk),
    "B's proof waits for A",
  )
  expect(w.hub.invites.filter((r) => r.atMs >= t0).length === 0, 'nothing while A is away')
  w.hub.route = () => 'deliver'
  if (order === 'visible-first') A.engine.rearmRounds()
  A.thaw()
  if (order === 'timers-first') A.engine.rearmRounds()
  await adv(w, HOLDER_SCAN_TTL_MS + MIN)
  expect(w.hub.invites.filter((r) => r.atMs >= t0).length === 0, 'no new room')
  expect(chanRoom(A, B) === room && chanRoom(B, A) === room, 'the same room')
  expect(pinOf(A, B) === 0 && pinOf(B, A) === 0, 'no pin')
  await finish(w)
}

/**
 * S-CH-RESCAN late return: A (L) scans B's QR alone (B never scans),
 * so A's deadline must open a new room. A is away over the deadline and comes back
 * `lateMs` after it: a frozen tab whose late timers fire first, a frozen tab whose
 * visibility event comes first, a frozen tab with all three signals of a browser return
 * spread over 5 s (late timers, debounced visibility, settled reconnect), or a closed app
 * that starts again. The judgment waits for
 * the backlog (resumeUntil, 15 s more), and the one-minute limit runs to the moment A came
 * back, not to that judgment: back 45 s or 60 s after the deadline, A opens one room for
 * the key package in B's QR and B binds it by its tag; back 2 minutes after, A gives up.
 */
export async function sChRescanLateReturn(how: 'timers-first' | 'visible-first' | 'browser-order' | 'restart', lateMs: number): Promise<void> {
  const { w, A, B } = await linkedPair(true)
  await adv(w, 6 * MIN)
  const room = chanRoom(A, B)
  const t0 = w.clock.now()
  const pb = await scanOnly(w, A, B)
  expect(A.state().connect.phase === 'already', "A says 'already'")
  const scanAt = (A.kv.peek<Record<string, { at: number }>>('scans') ?? {})[B.pk]?.at ?? t0
  await adv(w, 1_000)
  if (how === 'restart') await off(A)
  else A.freeze()
  await adv(w, scanAt + HOLDER_PAIR_MS + lateMs - w.clock.now())
  expect(w.hub.invites.filter((r) => r.atMs >= t0).length === 0, 'nothing while A is away')
  const back = w.clock.now()
  if (how === 'restart') await on(A)
  else {
    if (how === 'visible-first') A.engine.rearmRounds()
    A.thaw()
    if (how === 'timers-first') A.engine.rearmRounds()
    if (how === 'browser-order') {
      // As in a browser: the late timers fire on the thaw, the debounced visibility event
      // re-arms 2.5 s later, the reconnect after it settles 2.5 s after that. The minute
      // still runs to the first of them.
      await adv(w, 2_500)
      A.engine.rearmRounds()
      await adv(w, 2_500)
      A.engine.rearmRounds()
    }
  }
  await adv(w, HOLDER_SCAN_TTL_MS + MIN)
  const inv = w.hub.invites.filter((r) => r.atMs >= t0)
  if (lateMs <= MIN) {
    expect(inv.length === 1 && inv[0].from === A.pk && inv[0].accepted, `A (L) made one room and B joined it (${inv.length})`)
    expect(inv[0].atMs >= back && inv[0].atMs - back <= 30_000, `after the backlog had its chance (${inv[0].atMs - back} ms after the return)`)
    expect(inv[0].kpRef === payloadKp(pb), "for the key package in B's QR")
    expect(sameNewRoom(A, B, room) && chanRoom(A, B) === inv[0].groupId, 'both in that room')
    expect((chanRec(B, A) as { boundBy?: string })?.boundBy === 'tag', 'B bound it by its tag')
  } else {
    expect(inv.length === 0, `A gave up: no new room (${inv.length})`)
    expect(chanRoom(A, B) === room && chanRoom(B, A) === room, 'the same room')
  }
  expect(A.engine.sizes().notices === 0 && B.engine.sizes().notices === 0, 'no reopened notice')
  expect(hasText(A, B, 'one') && hasText(B, A, 'two'), 'chats stay')
  await finish(w)
}

/**
 * S-CH-QR-BEFORE-KP: A opens the connect screen right after
 * its app opened, before its key package is on a relay (here: offline at start). No QR is
 * shown and no code is used up: a QR without a real key package reference would fail every
 * scan. The moment the reference appears the first QR is shown; B (the lower key, so B
 * makes the room for the key package A's QR names) scans that very first QR and the link
 * completes.
 */
export async function sChQrBeforeKp(): Promise<void> {
  const w = newWorld()
  const [lo, hi] = orderedKeys(2)
  const B = makePeer(w, 'B', { words: lo.words })
  const A = makePeer(w, 'A', { words: hi.words })
  await B.engine.start()
  w.hub.setNetwork(A.pk, 'down')
  const boot = A.engine.start()
  await w.clock.settle()
  A.a.startConnect()
  const c0 = A.state().connect
  expect(c0.phase === 'showing' && c0.myPayload === undefined && c0.myCodeExpiresAt === undefined, `no QR before A's key package is on a relay (${c0.myPayload ? payloadKp(c0.myPayload) : 'none'})`)
  A.a.rotateConnectCode()
  expect(A.state().connect.myPayload === undefined, 'a rotation makes none either')
  expect((A.kv.peek<unknown[]>('codes') ?? []).length === 0, 'no code was used up')
  await adv(w, 20_000)
  expect(A.state().connect.myPayload === undefined, 'still none while offline')
  w.hub.setNetwork(A.pk, 'up')
  await boot
  await w.clock.settle()
  const pa = A.state().connect.myPayload ?? ''
  expect(pa !== '' && payloadKp(pa) === w.hub.kpRefOf(A.pk), "the first QR comes with A's key package reference")
  w.payloads.push(pa)
  B.a.startConnect()
  const pb = B.state().connect.myPayload ?? ''
  w.payloads.push(pb)
  void B.a.submitScan(pa, 'camera').catch(() => {})
  await adv(w, 2_000)
  void A.a.submitScan(pb, 'camera').catch(() => {})
  await until(w, () => hasContact(A, B) && hasContact(B, A), 2 * MIN, 'B scanned the first QR A showed and they link')
  expect(A.state().connect.phase === 'done' && B.state().connect.phase === 'done', `both 'done' (${A.state().connect.phase}/${B.state().connect.phase})`)
  await finish(w)
}

/**
 * S-CH-KP-ROTATE: a room made from a scan invites only the key
 * package the QR names, and the relays drop a key package once a rotation after a join puts
 * a newer one in its slot. A (the highest key) shows a QR, rotates it once, and joins B's
 * room for their first link: A's key package rotates. The QR on A's screen gets the new
 * reference at once (same code, same expiry), so C, who scans that QR afterwards, links.
 * D scans a picture of the QR taken before the join (the old reference): no key package
 * is found, D's link fails ('network') and nothing reaches A. That is the known limit
 * (README): a QR seen before a rotation is stale for a scan made after it.
 */
export async function sChKpRotate(): Promise<void> {
  const w = newWorld()
  const [kb, kc, kd, ka] = orderedKeys(4)
  const B = makePeer(w, 'B', { words: kb.words })
  const C = makePeer(w, 'C', { words: kc.words })
  const D = makePeer(w, 'D', { words: kd.words })
  const A = makePeer(w, 'A', { words: ka.words })
  for (const p of [A, B, C, D]) await p.engine.start()
  for (const p of [A, B, C, D]) p.a.startConnect()
  const pa1 = A.state().connect.myPayload ?? ''
  const pb = B.state().connect.myPayload ?? ''
  w.payloads.push(pa1, pb)
  void B.a.submitScan(pa1, 'camera').catch(() => {})
  await adv(w, 200)
  // The QR rotates while A has not scanned B yet: an unused code, the key package of now.
  A.a.rotateConnectCode()
  const stale = A.state().connect.myPayload ?? ''
  w.payloads.push(stale)
  const k1 = payloadKp(stale)
  expect(k1 !== '' && k1 === w.hub.kpRefOf(A.pk), "A's QR names its key package")
  void A.a.submitScan(pb, 'camera').catch(() => {})
  await until(w, () => hasContact(A, B) && hasContact(B, A), 2 * MIN, "A and B link (A joins B's room)")
  const now = A.state().connect.myPayload ?? ''
  expect(w.hub.kpRefOf(A.pk) !== k1, "A's key package rotated after the join")
  expect(payloadKp(now) === w.hub.kpRefOf(A.pk), `the QR on A's screen names the new key package (${payloadKp(now).slice(0, 6)})`)
  expect(payloadCode(now) === payloadCode(stale) && connectModule.decodePayload(now)?.exp === connectModule.decodePayload(stale)?.exp, 'same code and expiry: only the reference changed')
  // C scans the QR on screen now; A scans C.
  w.payloads.push(now)
  const t0 = w.clock.now()
  C.a.startConnect()
  const pc = C.state().connect.myPayload ?? ''
  w.payloads.push(pc)
  void C.a.submitScan(now, 'camera').catch(() => {})
  await adv(w, 200)
  A.a.startConnect()
  void A.a.submitScan(pc, 'camera').catch(() => {})
  await until(w, () => hasContact(A, C) && hasContact(C, A), 2 * MIN, 'C, who scanned the refreshed QR, links with A')
  // D scans the picture taken before the join.
  void D.a.submitScan(stale, 'camera').catch(() => {})
  await adv(w, MIN)
  const d = D.state().connect
  expect(d.phase === 'failed' && d.errorKey === 'network', `D's scan of the stale QR fails (${d.phase}/${d.errorKey})`)
  expect(w.hub.invites.filter((r) => r.atMs >= t0 && r.from === D.pk).length === 0 && !hasContact(A, D), 'nothing reaches A from D')
  await finish(w)
}

/**
 * S-CH-RESCAN same code: A shows one QR; B and C scan it within the same 30 s and
 * A scans both. The code counts for both (B branch ignores `used`): A opens no room with C
 * (nor with B), and A↔C carries two hellos each way.
 */
export async function sChRescanSameCode(): Promise<void> {
  const w = newWorld()
  const [k0, k1, k2] = orderedKeys(3)
  const A = makePeer(w, 'A', { words: k0.words })
  const B = makePeer(w, 'B', { words: k1.words })
  const C = makePeer(w, 'C', { words: k2.words })
  for (const p of [A, B, C]) await p.engine.start()
  await link(w, A, B)
  await link(w, A, C)
  await adv(w, 6 * MIN)
  const t0 = w.clock.now()
  A.a.startConnect()
  const pa = A.state().connect.myPayload ?? ''
  w.payloads.push(pa)
  void B.a.submitScan(pa, 'camera').catch(() => {})
  await adv(w, 2_000)
  void C.a.submitScan(pa, 'camera').catch(() => {})
  await adv(w, 2_000)
  await scanOnly(w, A, B)
  await adv(w, 2_000)
  await scanOnly(w, A, C)
  await adv(w, HOLDER_SCAN_TTL_MS + MIN)
  expect(w.hub.invites.filter((r) => r.atMs >= t0).length === 0, 'no new room with B or C')
  const ac = wireSince(w, A, C, t0)
  expect(ac.filter((e) => e.from === A.pk).length === 2 && ac.filter((e) => e.from === C.pk).length === 2, `A↔C: two hellos each way (${ac.length})`)
  await finish(w)
}

/**
 * S-CH-DELETER-RESCAN: A deleted B; they meet and scan each other (A lower or higher, A
 * or B first). A links from scratch: 'done', B under an empty name, no chat, no tombstone.
 * B says 'already' and keeps its name and chat. One room, and they chat and match in it.
 */
export async function sChDeleterRescan(aLow: boolean, aFirst: boolean): Promise<void> {
  const { w, A, B } = await linkedPair(aLow)
  await B.a.renameContact(A.pk, '에이')
  await deleteContact(w, A, B)
  await adv(w, 6 * MIN)
  const old = chanRoom(B, A)
  const t0 = w.clock.now()
  await scanEachOther(w, aFirst ? A : B, aFirst ? B : A, 5_000)
  await until(w, () => A.state().connect.phase === 'done' && hasContact(A, B), 3 * MIN, 'A (who deleted B) links again')
  // The deleter as H asks the holder L for the room; L answers from its holder scan with a
  // tagged room for A's QR key package. This is the slow path that e2e.ts also waits
  // through. At the moment the screen says
  // 'done' the store already holds the contact (stored first); the tombstone
  // goes in the next write, which a crash may cut (S-CRASH-SWEEP: load keeps the contact).
  if (!aLow) {
    const asked = w.hub.invites.filter((r) => r.atMs >= t0 && r.from === A.pk && r.to === B.pk)
    const answered = w.hub.invites.filter((r) => r.atMs >= t0 && r.from === B.pk && r.to === A.pk)
    expect(asked.length >= 1 && answered.length === 1 && w.hub.tagOf(answered[0].groupId) !== undefined, `A (H) asked and B (L) answered with one tagged room (${asked.length}/${answered.length})`)
  }
  expect(
    (A.kv.peek<{ pubkey: string }[]>('contacts') ?? []).some((c) => c.pubkey === B.pk),
    "at 'done' A's store holds B as a contact",
  )
  const ca = A.state().contacts.find((c) => c.pubkey === B.pk)
  expect(ca?.name === '' && (A.state().rooms[B.pk] ?? []).length === 0, 'A starts from scratch: an empty name, no chat')
  expect(ca?.via === 'camera', `A's new contact keeps how it was linked (${ca?.via})`)
  expect(!(B.pk in (A.kv.peek<Record<string, unknown>>('tombstones') ?? {})), "A's tombstone of B is gone")
  expect(B.state().connect.phase === 'already', `B's screen says 'already' (${B.state().connect.phase})`)
  expect(B.state().contacts.find((c) => c.pubkey === A.pk)?.name === '에이' && hasText(B, A, 'one') && hasText(B, A, 'two'), 'B keeps its name and chat')
  expect(sameNewRoom(A, B, old), `one new room (A ${chanRoom(A, B).slice(0, 6)}, B ${chanRoom(B, A).slice(0, 6)})`)
  await expectWorking(w, A, B, 'readd')
  await finish(w)
}

/**
 * S-CH-DELETER-ONESIDED: A deleted B and only A scans. A times out: no contact, and its
 * tombstone sits in the room B is in now (the move went through). B's rounds still get
 * A's random answers, no match.
 */
export async function sChDeleterOnesided(aLow: boolean): Promise<void> {
  const { w, A, B } = await linkedPair(aLow)
  await deleteContact(w, A, B)
  await adv(w, 6 * MIN)
  A.a.startConnect()
  B.a.startConnect()
  const pb = B.state().connect.myPayload ?? ''
  w.payloads.push(pb)
  void A.a.submitScan(pb, 'camera').catch(() => {})
  await adv(w, 3 * MIN)
  const c = A.state().connect
  expect(c.phase === 'failed' && c.errorKey === 'timeout', `A's link timed out (${c.phase}/${c.errorKey})`)
  expect(!hasContact(A, B), 'A has no contact B')
  const tomb = (A.kv.peek<Record<string, { groupId: string | null }>>('tombstones') ?? {})[B.pk]
  expect(!!tomb?.groupId && tomb.groupId === chanRoom(B, A), "A's tombstone keeps the room B is in")
  B.a.cancelConnect()
  await B.a.postOffer({ side: 'sell', currency: 'KRW', amountMinor: 90000, feePct: 1, methods: BOTH })
  await until(w, () => settled(B), 2 * MIN, "A answers B's round")
  expect(B.state().matches.length === 0, 'no match')
  await finish(w)
}

/**
 * S-CH-EXPIRY: L's confirmation never reaches H, so H gives up its replied link (L alone
 * has the contact), and L chats with H. They scan each other again: L says 'already', H
 * links ('done'), one new room, and L keeps its name and its chat through the re-link and
 * the room move.
 */
export async function sChExpiry(): Promise<void> {
  const w = newWorld()
  const [lo, hi] = orderedKeys(2)
  const L = makePeer(w, 'L', { words: lo.words })
  const H = makePeer(w, 'H', { words: hi.words, tuning: { repliedLinkTtlMs: 3 * MIN } })
  await L.engine.start()
  await H.engine.start()
  L.a.startConnect()
  H.a.startConnect()
  const pl = L.state().connect.myPayload ?? ''
  const ph = H.state().connect.myPayload ?? ''
  w.payloads.push(pl, ph)
  const hCode = connectModule.decodePayload(ph)?.code
  // Every hello of L but its first one (H's code) is lost: H never sees the confirmation.
  w.hub.route = (e) => (e.from === L.pk && e.t === 'hello' && (JSON.parse(e.json) as { code?: string }).code !== hCode ? 'drop' : 'deliver')
  void L.a.submitScan(ph).catch(() => {})
  await adv(w, 200)
  void H.a.submitScan(pl).catch(() => {})
  await until(w, () => hasContact(L, H), 2 * MIN, 'L makes the contact on H reply')
  await until(w, () => H.state().connect.phase === 'failed', 10 * MIN, 'H gives up its replied link')
  expect(!hasContact(H, L) && hasContact(L, H), 'L alone has the contact')
  // L chats with H now (H has no scan and no contact of L: it takes nothing of it). Not
  // before H gave up: any message of L in the link room would complete H's replied link.
  await L.a.sendChat(H.pk, 'before the re-link')
  expect(hasText(L, H, 'before the re-link'), "L's chat is there")
  w.hub.route = () => 'deliver'
  L.a.cancelConnect()
  H.a.cancelConnect()
  await L.a.renameContact(H.pk, 'h')
  await adv(w, 6 * MIN)
  const old = chanRoom(L, H)
  await scanEachOther(w, H, L, 5_000)
  await until(w, () => H.state().connect.phase === 'done' && hasContact(H, L), 3 * MIN, 'H links again')
  expect(L.state().connect.phase === 'already', `L says 'already' (${L.state().connect.phase})`)
  expect(L.state().contacts.find((c) => c.pubkey === H.pk)?.name === 'h', "L keeps H's name")
  expect(chanRoom(L, H) !== '' && chanRoom(L, H) === chanRoom(H, L) && chanRoom(L, H) !== old, 'one room, a new one')
  expect(hasText(L, H, 'before the re-link'), "L's chat survives the re-link and the room move")
  expect(!hasText(H, L, 'before the re-link'), 'H, linked from scratch, has none of it')
  await expectWorking(w, L, H, 'expiry')
  await finish(w)
}

/**
 * S-CH-EXPIRY at once (link-late 'prior' on the hub): L's confirmations never
 * reach H, and 10 s after the link both scan each other again (H first). H's repeated
 * replies in the first room carry a code of L's that H redeemed: they are echoed but are no
 * holder proof, so L does not pair with them; H starts over, asks, L answers from its scan
 * and H links in that new room.
 */
export async function sChExpirySoon(): Promise<void> {
  const w = newWorld()
  const [lo, hi] = orderedKeys(2)
  const L = makePeer(w, 'L', { words: lo.words })
  const H = makePeer(w, 'H', { words: hi.words })
  await L.engine.start()
  await H.engine.start()
  L.a.startConnect()
  H.a.startConnect()
  const pl = L.state().connect.myPayload ?? ''
  const ph = H.state().connect.myPayload ?? ''
  w.payloads.push(pl, ph)
  const hCode = payloadCode(ph)
  w.hub.route = (e) => (e.from === L.pk && e.t === 'hello' && codeOf(e) !== hCode ? 'drop' : 'deliver')
  void H.a.submitScan(pl).catch(() => {})
  await adv(w, 1_000)
  void L.a.submitScan(ph).catch(() => {})
  await until(w, () => hasContact(L, H), 2 * MIN, 'L makes the contact on H reply')
  const first = chanRoom(L, H)
  await adv(w, 10_000)
  w.hub.route = () => 'deliver'
  await scanEachOther(w, H, L, 1_000)
  await until(w, () => hasContact(H, L), 3 * MIN, 'H links by scanning again')
  expect(L.state().connect.phase === 'already', `L says 'already' (${L.state().connect.phase})`)
  expect(chanRoom(L, H) !== first && chanRoom(L, H) === chanRoom(H, L), 'one room, a new one')
  await adv(w, HOLDER_SCAN_TTL_MS)
  await finish(w)
}

type ScanOrder = 'holder-first' | 'lacking-first' | 'holder-90s-late' | 'moved-30s'

/**
 * S-CH-SCAN-ORDER: B is a contact of A (the holder), A deleted B (lacking). The holder is
 * L or H; the holder scans first, the lacking one first, the holder 90 s late, or the
 * holder first while its room moved 30 s before. Always: A 'done', B 'already', one room.
 */
export async function sChScanOrder(holderLow: boolean, order: ScanOrder): Promise<void> {
  const { w, A, B } = await linkedPair(!holderLow)
  await deleteContact(w, A, B)
  await adv(w, 6 * MIN)
  if (order === 'moved-30s') {
    const was = chanRoom(B, A)
    w.hub.loseGroup(B.pk, was)
    await until(w, () => sameNewRoom(A, B, was), 5 * MIN, "the holder's room moves")
    const boundAt = Math.max(chanRec(B, A)?.roomAt ?? 0, chanRec(A, B)?.roomAt ?? 0)
    if (boundAt + 30_000 > w.clock.now()) await adv(w, boundAt + 30_000 - w.clock.now())
  }
  const [first, second, gap] = order === 'lacking-first' ? [A, B, 5_000] : order === 'holder-90s-late' ? [A, B, 90_000] : [B, A, 5_000]
  await scanEachOther(w, first, second, gap)
  await until(w, () => A.state().connect.phase === 'done' && hasContact(A, B), 4 * MIN, 'the lacking side links')
  expect(B.state().connect.phase === 'already', `the holder says 'already' (${B.state().connect.phase})`)
  expect(chanRoom(A, B) !== '' && chanRoom(A, B) === chanRoom(B, A), 'one room')
  await finish(w)
}

/**
 * S-CH-DELETED-ONESIDED: B scans A only; A has B as a contact (world 1) or
 * deleted B (world 2). Both worlds: B says 'already', B's proof (A's code, old room) and A's
 * echo; A's envelopes and invites the same (twin assertions 1, 3). B as H: nothing else
 * until B's scan + HOLDER_SCAN_TTL_MS. B as L: at B's scan + HOLDER_PAIR_MS B makes one room
 * for the key package of A's QR, A joins it by its tag (world 2: a ghost channel), one
 * proof and one echo in it, nobody pinned, no reopened notice in world 1.
 */
export async function sChDeletedOnesided(bLow: boolean): Promise<void> {
  const SCAN = 10 * MIN
  const shown: string[] = []
  const script: TwinScript = {
    b: [
      {
        atMs: SCAN,
        act: async (B) => {
          const A = B.world.peers[0]
          shown.push(await scanOnly(B.world, B, A))
        },
      },
      { atMs: SCAN + HOLDER_SCAN_TTL_MS + MIN, act: async () => {} },
    ],
    a: [],
  }
  const r = await twin(script, { aLow: !bLow })
  expectSameEnvelopes(r.seqs)
  for (let i = 0; i < 2; i++) {
    const [w, A, B] = [r.worlds[i], r.a[i], r.b[i]]
    const t0 = START_MS + SCAN
    const cA = payloadCode(shown[i])
    expect(B.state().connect.phase === 'already', `world ${i + 1}: B says 'already'`)
    const inv = w.hub.invites.filter((x) => x.atMs >= t0)
    const ba = sent(w, B, A).filter((e) => e.atMs >= t0)
    const ab = sent(w, A, B).filter((e) => e.atMs >= t0)
    expect(ba.every((e) => e.t === 'hello' && codeOf(e) === cA) && ab.every((e) => e.t === 'hello' && codeOf(e) === cA), `world ${i + 1}: only B's proof and A's echo of it`)
    if (!bLow) {
      expect(inv.length === 0, `world ${i + 1}: no invite, no request, no new room (${inv.length})`)
      expect(ba.length === 1 && ab.length === 1, `world ${i + 1}: one proof, one echo (${ba.length}/${ab.length})`)
    } else {
      expect(inv.length === 1 && inv[0].from === B.pk && inv[0].accepted && inv[0].kpRef === payloadKp(shown[i]), `world ${i + 1}: B made one room for A's QR key package and A joined it`)
      expect(ba.length === 2 && ab.length === 2, `world ${i + 1}: a proof and an echo in each room (${ba.length}/${ab.length})`)
      expect(chanRoom(B, A) === inv[0].groupId && chanRoom(A, B) === inv[0].groupId, `world ${i + 1}: both in B's new room`)
    }
    expect(pinOf(A, B) === 0 && pinOf(B, A) === 0, `world ${i + 1}: nobody pinned`)
  }
  expect(r.a[0].engine.sizes().notices === 0, 'world 1: no reopened notice for A')
  expect(!hasContact(r.a[1], r.b[1]), 'world 2: A gets no contact B')
  for (const w of r.worlds) await finish(w)
}

/**
 * S-CH-FORGED-HELLO: B (a contact) puts hellos into A's room: an old code of A's
 * (past HOLDER_CODE_MS), someone else's code, and a code of A's that C used for its link
 * (B branch: `used` is not looked at). A's relation and room do not change; only the code
 * within HOLDER_CODE_MS is echoed, once each, within mayEcho.
 */
export async function sChForgedHello(): Promise<void> {
  const w = newWorld()
  const [k0, k1, k2] = orderedKeys(3)
  const A = makePeer(w, 'A', { words: k0.words })
  const B = makePeer(w, 'B', { words: k1.words })
  const C = makePeer(w, 'C', { words: k2.words })
  for (const p of [A, B, C]) await p.engine.start()
  A.a.startConnect()
  const old = payloadCode(A.state().connect.myPayload ?? '')
  w.payloads.push(A.state().connect.myPayload ?? '')
  // Past HOLDER_CODE_MS: the old code is no proof and no echo any more.
  await adv(w, HOLDER_CODE_MS + MIN)
  await link(w, A, B)
  await link(w, A, C)
  const usedByC = (A.kv.peek<{ code: string; usedBy?: string }[]>('codes') ?? []).find((c) => c.usedBy === C.pk)?.code ?? ''
  expect(usedByC !== '', 'C used a code of A')
  await adv(w, 30_000)
  const room = chanRoom(A, B)
  const t0 = w.clock.now()
  const other = randomHex(16)
  for (const code of [old, other, usedByC]) w.hub.inject(B.pk, room, JSON.stringify({ t: 'hello', v: 1, code }))
  await adv(w, MIN)
  const echoes = sent(w, A, B).filter((e) => e.atMs >= t0)
  expect(echoes.length === 1 && codeOf(echoes[0]) === usedByC, `only the code within HOLDER_CODE_MS was echoed (${echoes.map(codeOf).join(',')})`)
  for (let i = 0; i < 6; i++) w.hub.inject(B.pk, room, JSON.stringify({ t: 'hello', v: 1, code: usedByC }))
  await adv(w, 10_000)
  expect(sent(w, A, B).filter((e) => e.atMs >= t0).length <= 4, 'mayEcho caps the echoes')
  expect(chanRoom(A, B) === room && hasContact(A, B) && hasContact(A, C), "A's relations and room stay")
  expect(w.hub.invites.filter((x) => x.atMs >= t0).length === 0, 'no invite')
  await finish(w)
}

/**
 * S-CH-PREVIEW: a Welcome that is previewed but not joined changes nothing.
 * A (the higher key) scans B; while A's holder scan lives, B's key sends A Welcomes with no
 * tag, a wrong tag, and the tag of a code of A's too old to count. Each one is read
 * (previewInvite) and marked read: A's whole store and its groups stay as they were, and
 * none is joined.
 */
export async function sChPreview(): Promise<void> {
  const { w, A, B } = await linkedPair(false)
  A.a.startConnect()
  const oldCode = payloadCode(A.state().connect.myPayload ?? '')
  w.payloads.push(A.state().connect.myPayload ?? '')
  await adv(w, HOLDER_SCAN_TTL_MS + 3 * MIN)
  await scanOnly(w, A, B)
  await adv(w, 70_000)
  const store = JSON.stringify(Object.fromEntries(A.kv.keys().map((k) => [k, A.kv.peek(k)])))
  const groups = w.hub.groupsOf(A.pk).join()
  const tagOfCode = (code: string): string => bytesToHex(sha256(utf8ToBytes(code)).slice(0, 16))
  const sentAt = Math.floor(w.clock.now() / 1000)
  const recs = [w.hub.injectInvite(B.pk, A.pk, { sentAt }), w.hub.injectInvite(B.pk, A.pk, { sentAt, tag: randomHex(16) }), w.hub.injectInvite(B.pk, A.pk, { sentAt, tag: tagOfCode(oldCode) })]
  await adv(w, 10_000)
  expect(
    recs.every((r) => !r.accepted && r.dropped),
    'none joined, all marked read',
  )
  expect(JSON.stringify(Object.fromEntries(A.kv.keys().map((k) => [k, A.kv.peek(k)]))) === store, "A's store did not change")
  expect(w.hub.groupsOf(A.pk).join() === groups, "A's groups did not change")
  await adv(w, HOLDER_SCAN_TTL_MS)
  await finish(w)
}

/**
 * A thief of B's key moves A's channel with B to the thief's own room (as L it makes the
 * room, as H it asks A for one, which A makes for the thief's newer key package). The real
 * B keeps its old room: the channel is out of step. Returns the thief.
 */
async function thiefMoves(w: World, A: Peer, B: Peer): Promise<Peer> {
  const was = chanRoom(A, B)
  const T = await thiefOf(B)
  await until(w, () => chanRoom(A, B) !== was && chanRoom(A, B) !== '', 5 * MIN, "the thief moves A's channel")
  await adv(w, 30_000)
  expect(chanRoom(B, A) === was && chanRoom(A, B) !== was, 'A and the real B are out of step')
  expect(w.hub.kpRefOf(B.pk, T.device) !== null && w.hub.kpRefOf(B.pk, T.device) !== w.hub.kpRefOf(B.pk, B.device), "the thief's key package of B's key is on the relays too")
  return T
}

/**
 * S-BOT-HOLDER-RESCAN (가): a thief of B's key moved A's channel; the real A and B
 * meet and scan each other, 60 s or 4 min 50 s apart, A the lower or the higher key, either
 * first. By L's scan + HOLDER_PAIR_MS + 60 s A and the real B share one new room, made by L
 * for the key package of the real B's (or A's) QR; one newly bound room; both screens
 * 'already'; no reopened notice; A's chat stays; both pinned for 7 days. (다) Then, 6 days
 * later, a reopen or a request of B's key reaches A: A takes neither.
 */
export async function sBotHolderRescanThief(aLow: boolean, aFirst: boolean, gapMs: number): Promise<void> {
  const { w, A, B } = await linkedPair(aLow)
  await adv(w, 6 * MIN)
  const T = await thiefMoves(w, A, B)
  const thiefRoom = chanRoom(A, B)
  const t0 = w.clock.now()
  const [first, second] = aFirst ? [A, B] : [B, A]
  const { p1, p2 } = await scanEachOther(w, first, second, gapMs)
  // The thief's move itself leaves A a reopened notice when A did not scan within
  // HOLDER_PAIR_MS of it (it is one: B 4 min 50 s first); the new room adds none.
  const noticesBefore = A.engine.sizes().notices + B.engine.sizes().notices
  const lScanAt = (aLow ? aFirst : !aFirst) ? t0 : t0 + gapMs
  const L = aLow ? A : B
  const H = aLow ? B : A
  // The QR L scanned is H's.
  const hQr = L === first ? p2 : p1
  await until(w, () => sameNewRoom(A, B, thiefRoom) && chanRoom(B, A) !== '' && pinOf(A, B) > 0 && pinOf(B, A) > 0, lScanAt + 6 * MIN - w.clock.now(), 'A and the real B share a new room, pinned')
  const made = w.hub.invites.filter((r) => r.atMs >= t0 && r.from === L.pk && r.to === H.pk && r.fromDevice === L.device)
  expect(made.length === 1 && made[0].accepted && made[0].groupId === chanRoom(A, B), `L made one room and H joined it (${made.length})`)
  expect(made[0].kpRef === payloadKp(hQr) && made[0].toDevice === H.device, "for the key package of H's QR, on H's real device")
  const bound = chanRoom(A, B)
  for (const p of [A, B]) expect(p.state().connect.phase === 'already', `${p.name} says 'already'`)
  expect(A.engine.sizes().notices + B.engine.sizes().notices === noticesBefore, 'no reopened notice from the scans')
  expect(hasText(A, B, 'one') && hasText(A, B, 'two'), "A's chat with B stays")
  const pinA = pinOf(A, B)
  const pinB = pinOf(B, A)
  expect(Math.abs(pinA - pinB) < 3 * MIN && pinA > w.clock.now() + 6 * 24 * 60 * MIN, 'both pinned for 7 days from the bind')
  await adv(w, HOLDER_SCAN_TTL_MS + MIN)
  // (다) Six days later the thief tries again.
  await adv(w, 6 * 24 * 60 * MIN)
  const t1 = w.clock.now()
  const forged = w.hub.injectInvite(B.pk, A.pk)
  await adv(w, 2 * MIN)
  expect(!forged.accepted && chanRoom(A, B) === bound, `A takes no ${B.pk < A.pk ? 'reopen' : 'request'} of B's key while pinned`)
  expect(w.hub.invites.filter((r) => r.atMs >= t1 && r.from === A.pk).length === 0, 'and makes no room for it')
  await dropThief(T)
  await finish(w)
}

/**
 * S-BOT-HOLDER-RESCAN (마): a live thief of B's key (B the lower key, A the higher) moved
 * the channel and, from A's first proof on, sends A a Welcome every 10 s or every second
 * (both variants) dated now + 590 s
 * until A's scan ends; A's 24 h moves were used up by earlier moves. A joins none of them,
 * is never bound to a thief room after its scan, ends bound to the real B's deadline room
 * and pinned, keeps no candidate, and its moves hold only the real move.
 */
export async function sBotHolderRescanFlood(everyMs: number): Promise<void> {
  const { w, A, B } = await linkedPair(false)
  await adv(w, 6 * MIN)
  const T = await thiefMoves(w, A, B)
  const thiefRoom = chanRoom(A, B)
  await withChannel(A, B, { moves: [w.clock.now() - 3 * 60 * MIN, w.clock.now() - 2 * 60 * MIN] })
  const t0 = w.clock.now()
  const forged: FakeHub['invites'][number][] = []
  const seen = new Set<string>()
  const flood = async (): Promise<void> => {
    for (let i = 0; i < (12 * 60_000) / everyMs; i++) {
      forged.push(w.hub.injectInvite(B.pk, A.pk, { sentAt: Math.floor(w.clock.now() / 1000) + 590 }))
      seen.add(chanRoom(A, B))
      await adv(w, everyMs)
    }
  }
  await scanEachOther(w, A, B, 60_000)
  await flood()
  expect(
    forged.every((r) => !r.accepted),
    "A joined none of the thief's Welcomes",
  )
  const final = chanRoom(A, B)
  expect(
    [...seen].every((g) => g === thiefRoom || g === final),
    "A's channel was never one of the thief's new rooms",
  )
  expect(final !== thiefRoom && sameNewRoom(A, B, thiefRoom), "A ends in the real B's room")
  expect(pinOf(A, B) > w.clock.now() && pinOf(B, A) > w.clock.now(), 'both pinned')
  expect(A.engine.sizes().candidates === 0, 'no candidate is left')
  const moves = (chanRec(A, B)?.moves ?? []).filter((m) => m >= t0)
  expect(moves.length === 1, `A's moves hold only the real move (${moves.length})`)
  await dropThief(T)
  await finish(w)
}

/**
 * S-BOT-HOLDER-RESCAN (바): a thief of B's key (A the lower key) moved the channel and sends
 * A requests while A's scan lives and after: every room A makes in the scan is for the
 * key package of the real B's QR, and once pinned A answers no request.
 */
export async function sBotHolderRescanRequests(): Promise<void> {
  const { w, A, B } = await linkedPair(true)
  await adv(w, 6 * MIN)
  const T = await thiefMoves(w, A, B)
  const t0 = w.clock.now()
  const { p2 } = await scanEachOther(w, A, B, 60_000)
  for (let i = 0; i < 20; i++) {
    w.hub.injectInvite(B.pk, A.pk)
    await adv(w, 15_000)
  }
  const made = w.hub.invites.filter((r) => r.atMs >= t0 && r.from === A.pk && r.to === B.pk)
  expect(made.length >= 1 && made.every((r) => r.kpRef === payloadKp(p2) && r.toDevice === B.device), `A's rooms in the scan are for B's QR key package only (${made.length})`)
  expect(pinOf(A, B) > w.clock.now(), 'A is pinned')
  const t1 = w.clock.now()
  for (let i = 0; i < 5; i++) {
    w.hub.injectInvite(B.pk, A.pk)
    await adv(w, 2 * MIN)
  }
  expect(w.hub.invites.filter((r) => r.atMs >= t1 && r.from === A.pk).length === 0, 'pinned: no request is answered')
  await dropThief(T)
  await finish(w)
}

/**
 * S-BOT-HOLDER-RESCAN (아): a thief of A's key (A the lower key) moved B. B scans A,
 * A scans B 20 s later (B's QR is still valid then) and B's app closes at once; it opens
 * again 30 minutes later. A's deadline room waits for B: from the backlog B takes it as a
 * candidate (ages by the Welcome's and the hello's own times), binds it on A's proof and is
 * pinned; never the thief's room.
 */
export async function sBotHolderRescanAway(): Promise<void> {
  const { w, A, B } = await linkedPair(true)
  await adv(w, 6 * MIN)
  const T = await thiefMoves(w, B, A)
  const thiefRoom = chanRoom(B, A)
  await scanEachOther(w, B, A, 20_000)
  await adv(w, 1_000)
  await off(B)
  await adv(w, 30 * MIN)
  await on(B)
  await until(w, () => sameNewRoom(A, B, thiefRoom), 2 * MIN, "B is in A's deadline room after it is back")
  expect(pinOf(B, A) > w.clock.now(), 'B is pinned')
  await adv(w, HOLDER_SCAN_TTL_MS)
  expect(chanRoom(B, A) !== thiefRoom && sameNewRoom(A, B, thiefRoom), "B never went to the thief's room")
  await dropThief(T)
  await finish(w)
}

/**
 * S-BOT-HOLDER-RESCAN (아), second expectation: the same thief of A's key (A the
 * lower key) moved B; B scans A and A scans B 20 s later, and now A's app closes at once.
 * A opens again 8 minutes after its scan, more than a minute past its deadline: A, the L,
 * no longer opens anything (the scan is given up; they must scan again). No new room from
 * the real A, and the thief's room stays B's channel.
 */
export async function sBotHolderRescanAwayL(): Promise<void> {
  const { w, A, B } = await linkedPair(true)
  await adv(w, 6 * MIN)
  const T = await thiefMoves(w, B, A)
  const thiefRoom = chanRoom(B, A)
  const t0 = w.clock.now()
  await scanEachOther(w, B, A, 20_000)
  await adv(w, 1_000)
  await off(A)
  await adv(w, 8 * MIN - 21_000)
  await on(A)
  await adv(w, HOLDER_SCAN_TTL_MS + MIN)
  const made = w.hub.invites.filter((r) => r.atMs >= t0 && r.from === A.pk && r.fromDevice === A.device)
  expect(made.length === 0, `no new room from the real A (${made.length})`)
  expect(chanRoom(B, A) === thiefRoom, "B's channel is still the thief's room (scan again to win it back)")
  expect(pinOf(A, B) === 0 && pinOf(B, A) === 0, 'no pin')
  await dropThief(T)
  // The channel stays out of step on purpose (past a minute the scan opens nothing).
  w.skip.add('INV-L4')
  await finish(w)
}

/**
 * S-BOT-HOLDER-RESCAN (라): two healthy contacts, every envelope between them delayed by d,
 * L first by g. g + d within HOLDER_PAIR_MS: no move (4 min delay, 5 s gap; 50 s delay, 4 min
 * gap). Past it (2 min delay, 4 min gap): L makes one room, one channel, no reopened notice,
 * both pinned. H first with d within HOLDER_PAIR_MS: no move. One direction only (`dir`):
 * L→H 6 minutes, either order: no move (H's proof reaches L at once). H→L 6 minutes with L
 * first: L makes one room, one channel, no reopened notice, and only H pins (H's proof in
 * the new room reaches L after L's scan ended).
 * A is L (the lower key), B is H.
 */
export async function sBotHolderRescanDelay(lFirst: boolean, delayMs: number, gapMs: number, moves: boolean | 'h-pinned', dir: 'both' | 'lh' | 'hl' = 'both'): Promise<void> {
  const { w, A, B } = await linkedPair(true)
  await adv(w, 6 * MIN)
  const room = chanRoom(A, B)
  const lh = dir !== 'hl'
  const hl = dir !== 'lh'
  w.hub.route = (e) => ((lh && e.from === A.pk && e.to === B.pk) || (hl && e.from === B.pk && e.to === A.pk) ? { delayMs } : 'deliver')
  const t0 = w.clock.now()
  await scanEachOther(w, lFirst ? A : B, lFirst ? B : A, gapMs)
  await adv(w, HOLDER_SCAN_TTL_MS + delayMs + 2 * MIN)
  const inv = w.hub.invites.filter((r) => r.atMs >= t0)
  if (!moves) {
    expect(inv.length === 0 && chanRoom(A, B) === room && chanRoom(B, A) === room, `no move (${inv.length})`)
  } else {
    expect(inv.length === 1 && inv[0].from === A.pk && sameNewRoom(A, B, room), `L made one room (${inv.length})`)
    if (moves === 'h-pinned') expect(pinOf(B, A) > w.clock.now() && pinOf(A, B) === 0, `only H pinned (H ${pinOf(B, A) > 0}, L ${pinOf(A, B) > 0})`)
    else expect(pinOf(A, B) > w.clock.now() && pinOf(B, A) > w.clock.now(), 'both pinned')
  }
  expect(A.engine.sizes().notices === 0 && B.engine.sizes().notices === 0, 'no reopened notice')
  await finish(w)
}

/**
 * S-HOLDER-FLAP: A (L) scans B alone and is frozen
 * over its deadline; it comes back 30 s after it (backAt). `single`: one reconnect signal
 * 10 s after the return; it gets its full HOLDER_RESUME_GRACE_MS, so the deadline is
 * judged no earlier than backAt + 25 s (the old cap judged at backAt + 17 s, 7 s of
 * backlog). Else a flapping relay makes a reconnect signal every 10 s for 3 minutes:
 * each one gives the backlog 15 s more, but the return window closes at backAt +
 * RESUME_WINDOW_MAX_MS, and A opens its room then, never minutes later.
 */
export async function sHolderFlap(single: boolean): Promise<void> {
  const { w, A, B } = await linkedPair(true)
  await adv(w, 6 * MIN)
  const old = chanRoom(A, B)
  const t0 = w.clock.now()
  const pb = await scanOnly(w, A, B)
  const scanAt = (A.kv.peek<Record<string, { at: number }>>('scans') ?? {})[B.pk]?.at ?? w.clock.now()
  await adv(w, 1_000)
  A.freeze()
  await adv(w, scanAt + HOLDER_PAIR_MS + 30_000 - w.clock.now())
  A.thaw()
  const backAt = w.clock.now()
  if (single) {
    await adv(w, 10_000)
    A.engine.rearmRounds()
    await adv(w, 3 * MIN)
  } else {
    for (let i = 0; i < 18; i++) {
      A.engine.rearmRounds()
      await adv(w, 10_000)
    }
    await adv(w, 2 * MIN)
  }
  const made = w.hub.invites.filter((r) => r.atMs >= t0 && r.from === A.pk)
  // The judgment, and the invite's own way through the hub (at most 5 s).
  const from = backAt + (single ? 10_000 + 15_000 : 0)
  const by = backAt + (single ? 10_000 + 15_000 : RESUME_WINDOW_MAX_MS) + 5_000
  const when = made.map((r) => `${(r.atMs - backAt) / 1000} s`).join(', ')
  expect(made.length === 1, `A, back 30 s after its deadline, opens one room (${made.length})`)
  expect(
    made.every((r) => r.atMs >= from),
    `not before the reconnect's full grace ran out (${when})`,
  )
  expect(
    made.every((r) => r.atMs <= by),
    `${single ? 'right after that grace' : 'by the bound of the return window'}, not minutes later (${when})`,
  )
  expect(made[0]?.kpRef === payloadKp(pb), "for the key package in B's QR")
  await until(w, () => sameNewRoom(A, B, old), CHANNEL_CHECK, 'B joins the new room')
  await finish(w)
}

/**
 * S-RESUME-FLAP: every user of the return window closes with
 * it, at most RESUME_WINDOW_MAX_MS after the return's first signal, while a flapping relay
 * keeps sending reconnect signals. A (the H) shows its QR (code cA) and scans B; then A is
 * frozen for 20 minutes, during which B (the L, already paired by A's proof) scans A's QR,
 * so B's proofs with cA wait
 * for A. Back, A counts them (the backlog of the return), and a relay flaps every 10 s
 * for 3 minutes. By the window's bound: A's holder scan has ended (TTL long gone), the
 * codes nobody proved with lately are pruned, and a move Welcome from B's key tagged
 * with cA, dated before the freeze, is not taken by its tag after the window closed, even inside
 * the next window a later flap opens (its date stands in for now no further back than
 * the close). Twin and no-leak checks are unchanged (no terms are on the wire here).
 */
export async function sResumeFlap(): Promise<void> {
  const { w, A, B } = await linkedPair(false)
  await adv(w, 6 * MIN)
  const old = chanRoom(A, B)
  // A first code on the screen: nobody proves with it, so only its age keeps it.
  A.a.startConnect()
  const cA2 = payloadCode(A.state().connect.myPayload ?? '')
  await adv(w, 35_000)
  A.a.startConnect()
  const pa = A.state().connect.myPayload ?? ''
  const cA = payloadCode(pa)
  await scanOnly(w, A, B)
  const frozenAt = w.clock.now()
  A.freeze()
  await adv(w, 5_000)
  w.payloads.push(pa)
  void B.a.submitScan(pa, 'camera').catch(() => {})
  await w.clock.settle()
  await adv(w, frozenAt + 20 * MIN - w.clock.now())
  A.thaw()
  const backAt = w.clock.now()
  const codesOf = () => (A.kv.peek<{ code: string; createdAt: number }[]>('codes') ?? []).map((c) => c.code)
  const scanOfB = () => (A.kv.peek<Record<string, unknown>>('scans') ?? {})[B.pk]
  expect(cA !== '' && cA2 !== '' && cA !== cA2, `A showed two codes before the freeze (${cA !== cA2})`)
  let tagged: FakeHub['invites'][number] | undefined
  for (let i = 0; i < 18; i++) {
    A.engine.rearmRounds()
    await adv(w, 10_000)
    const at = w.clock.now() - backAt
    if (at === RESUME_WINDOW_MAX_MS + 10_000) {
      // The window closed at backAt + 60 s; the flap at 60 s did not reopen it.
      expect(scanOfB() === undefined, "A's holder scan ended when the window closed")
      expect(!codesOf().includes(cA2), `the code nobody proved with was pruned (${codesOf().length} kept)`)
      expect(codesOf().includes(cA), 'the code B proved with in the backlog is kept (holderUses, 5 min)')
    }
    if (at === RESUME_WINDOW_MAX_MS + 20_000) {
      // The flap at 70 s opened a new window: B's key sends a Welcome tagged with cA, dated
      // before the freeze. At that date cA was young; at the close of the last window it
      // was 20 minutes old.
      tagged = w.hub.injectInvite(B.pk, A.pk, { sentAt: Math.floor((frozenAt + 30_000) / 1000), tag: bytesToHex(sha256(utf8ToBytes(cA)).slice(0, 16)) })
    }
  }
  await adv(w, 2 * MIN)
  const rec = chanRec(A, B) as (ChanRec & { boundBy?: string }) | undefined
  expect(tagged !== undefined, 'the tagged Welcome was sent')
  // Untagged by then, it is an ordinary move of B's key, which may take it; the tag
  // must not (a binding by tag skips the ordinary move checks: older room, move limit, pin).
  expect(
    rec?.boundBy !== 'tag',
    `A did not take the old-dated Welcome by its tag (boundBy ${rec?.boundBy ?? '-'}, ${rec?.groupId === old ? 'old room' : rec?.groupId === tagged?.groupId ? 'its room' : 'other room'})`,
  )
  // That ordinary move may put A in a room the real B is not in (the hub's forged Welcome
  // has no device of B behind it): the same as a thief's move, out of this scenario's scope.
  w.skip.add('INV-L4')
  await finish(w)
}

/**
 * S-RESUME-LATE-CLOSE: A (the H) comes into view
 * (rearmRounds opens a return window of HOLDER_RESUME_GRACE_MS), shows its QR (code cA)
 * and scans B; inside that window A goes to the background and is frozen for 20 minutes,
 * while B (the L) scans A's QR and sends its proofs with cA. On the thaw the window's
 * close timer runs late, before any other held timer: it counts as a return (a new
 * window), so cA, older than HOLDER_CODE_MS by then and not yet used, is not pruned before
 * the backlog with B's proofs is handled. A counts B's proof and keeps the code.
 */
export async function sResumeLateClose(): Promise<void> {
  const { w, A, B } = await linkedPair(false)
  await adv(w, 6 * MIN)
  A.engine.rearmRounds()
  A.a.startConnect()
  const pa = A.state().connect.myPayload ?? ''
  const cA = payloadCode(pa)
  await scanOnly(w, A, B)
  const frozenAt = w.clock.now()
  A.freeze()
  await adv(w, 5_000)
  w.payloads.push(pa)
  void B.a.submitScan(pa, 'camera').catch(() => {})
  await w.clock.settle()
  await adv(w, frozenAt + 20 * MIN - w.clock.now())
  A.thaw()
  await adv(w, 30_000)
  type Code = { code: string; createdAt: number; holderUses?: Record<string, { at: number }> }
  const rec = (A.kv.peek<Code[]>('codes') ?? []).find((c) => c.code === cA)
  expect(cA !== '', 'A showed a code before the freeze')
  expect(rec !== undefined, 'the code B proved with during the freeze is kept after the thaw')
  expect(rec?.holderUses?.[B.pk] !== undefined, "B's proof from the backlog was counted (holderUses)")
  await finish(w)
}

/**
 * S-RESUME-LATE-EXPIRE: A's holder scan of B comes to the end of its
 * life inside a return window, so its end waits for the window's close. A reconnect then
 * moves the close on (the scan's wait still points at the first close), and A is frozen
 * for 20 minutes before either fires. On the thaw the scan's wait runs first, late: that is
 * a return, so a new window opens and the scan is not deleted before that return's
 * backlog. It ends when the new window closes.
 */
export async function sResumeLateExpire(): Promise<void> {
  const { w, A, B } = await linkedPair(false)
  await adv(w, 6 * MIN)
  await scanOnly(w, A, B)
  const scanOfB = () => (A.kv.peek<Record<string, { at: number }>>('scans') ?? {})[B.pk]
  const at = scanOfB()?.at
  expect(at !== undefined, 'A holds a holder scan of B')
  if (at === undefined) return finish(w)
  await adv(w, at + HOLDER_SCAN_TTL_MS - 5_000 - w.clock.now())
  // Back in view 5 s before the scan's end: the window closes 15 s later.
  A.engine.rearmRounds()
  await adv(w, 10_000)
  expect(scanOfB() !== undefined, "the scan's end waits for the window's close")
  // A reconnect 10 s into the window: the close moves to 25 s; the scan still waits for 15 s.
  A.engine.rearmRounds()
  await adv(w, 1_000)
  A.freeze()
  await adv(w, 20 * MIN)
  A.thaw()
  await w.clock.settle()
  expect(scanOfB() !== undefined, "the scan's late wait is a return: the scan stays for that return's backlog")
  await adv(w, RESUME_WINDOW_MAX_MS + 5_000)
  expect(scanOfB() === undefined, 'the scan ends when the new window closes')
  await finish(w)
}
