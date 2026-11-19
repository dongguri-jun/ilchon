/**
 * Engine check scenarios: re-add x matching, memo, timers.
 * Run from scripts/check-engine.ts, which lists every scenario in its order.
 */
import { HOLDER_SCAN_TTL_MS } from '../../../src/engine/index'
import type { Envelope } from '../../fake-transport'
import * as connectModule from '../../../src/lib/connect'
import { chanRec, chanRoom, expectSameEnvelopes, hasText, invitesOf, linkedPair, payloadKp, pinOf, restore, sameNewRoom, scanEachOther, skew } from '../helpers/channel'
import { converged, toldOf, verifiedOf } from '../helpers/delivery'
import { expectNoLeakToC, reopenTrio } from '../helpers/reopen'
import { dones, matched } from '../helpers/trade'
import { type TwinScript, twin } from '../helpers/twin'
import { dumpOf } from '../markers'
import { expect } from '../report'
import { MIN, type Peer, adv, deleteContact, finish, hasContact, powerOff, restart, sent, until } from '../world'

// ---------------------------------------------------------------- re-add x matching, memo, timers

/**
 * S-READD-MATCH: A (buy) and B (sell) matched, C matches
 * nobody. A's completion for B is refused (it stays 'failed'), then A deletes B. While B is
 * a tombstone A restarts (its reconfirm at the start must not reach B). Then A re-adds B
 * by scanning (A the lower key: A makes the room; the higher: B, the holder, binds the room
 * A asks for). After the re-add: matching starts over with B (no verified or match of B
 * survives the delete), both match again, each sends its offer into the current room at
 * most as often as at the first match, A's old completion never goes to B again (its chat
 * went with the delete, delivery 11), told is settled, and C sees nothing.
 */
export async function sReaddMatch(aHigh: boolean): Promise<void> {
  const { w, A, B, C, firstAB, firstBA } = await reopenTrio({ aHigh })
  const DONE = 10_000
  w.hub.failSend = (from, _g, msg) => (from === A.pk && msg.t === 'done' ? 'reject' : false)
  await A.a.markDone(B.pk, DONE)
  await adv(w, 5_000)
  expect(dones(A, B, true)[0]?.status === 'failed', `A's completion for B failed (${dones(A, B, true)[0]?.status})`)
  await deleteContact(w, A, B)
  const deletedAt = w.clock.now()
  expect(!(B.pk in verifiedOf(A)) && !matched(A, B), 'the delete drops the verified match and the shown one')
  await restart(A)
  await adv(w, 6 * MIN)
  expect(
    sent(w, A, B, 'm1').every((e) => e.atMs < deletedAt),
    'no round 1 of A reaches B while B is deleted (no reconfirm of a tombstone)',
  )
  w.hub.failSend = () => false
  const t1 = w.clock.now()
  await scanEachOther(w, A, B, 5_000)
  await until(w, () => A.state().connect.phase === 'done' && hasContact(A, B), 3 * MIN, 'A re-adds B')
  const readdAt = w.clock.now()
  expect(B.state().connect.phase === 'already', `B says 'already' (${B.state().connect.phase})`)
  expect(!matched(A, B) || A.state().matches.find((m) => m.contactId === B.pk)?.offer !== undefined, 'nothing of the old match is shown at A')
  expect(
    (A.state().rooms[B.pk] ?? []).every((m) => m.kind !== 'done'),
    "A's old completion did not come back with the re-add",
  )
  await until(w, () => converged(A, B), 5 * MIN, 'A and B match again after the re-add')
  await adv(w, 2 * MIN)
  expect(converged(A, B), 'and stay matched')
  const room = chanRoom(A, B)
  expect(room !== '' && room === chanRoom(B, A), 'one room')
  const offers = [sent(w, A, B, 'offer'), sent(w, B, A, 'offer')].map((xs) => xs.filter((e) => e.atMs >= t1))
  const counts = offers.map((xs) => xs.length)
  // As at the first match, or both sides as often as the starting side: the round the
  // holder's bind starts and the one the link starts cross at the re-add, and the late-m3
  // path runs (each sends first once, each answers once; S-REOPEN-RESTART).
  const same = JSON.stringify([...counts].sort()) === JSON.stringify([firstAB, firstBA].sort())
  expect(same || counts.every((n) => n === Math.max(firstAB, firstBA)), `each sent its offer again as at the first match (first ${firstAB}/${firstBA}, now ${counts.join('/')})`)
  expect(
    offers.flat().every((e) => e.groupId === room),
    'every offer after the re-add went into the shared room',
  )
  expect(sent(w, A, B, 'offer').filter((e) => e.atMs >= deletedAt && e.atMs < readdAt).length === 0, 'no offer of A to B while B was deleted')
  expect(sent(w, A, B, 'done').filter((e) => e.atMs >= deletedAt).length === 0, "A's completion from before the delete never went to B again")
  expect(toldOf(A)[B.pk]?.ok === true && toldOf(B)[A.pk]?.ok === true, 'both tolds were taken by a relay')
  expectNoLeakToC(w, A, B, C)
  await finish(w)
}

/**
 * S-READD-MEMO: A had a draft for B, B's room open and B's
 * linked profile (memo), then deleted B; memo.set of a key of B is refused while B is gone.
 * A re-adds B by scanning: none of the old values comes back, and memo.set of B's keys is
 * accepted again.
 */
export async function sReaddMemo(aLow: boolean): Promise<void> {
  const { w, A, B } = await linkedPair(aLow)
  const npub = `nostr:${B.pk}`
  expect(A.engine.memo.set(`draft:${B.pk}`, 'ZQ-READD-DRAFT') && A.engine.memo.set(npub, { name: 'ZQ-READD-PROFILE' }), 'a contact: its keys are kept')
  A.engine.memo.set('place', { tab: 'contacts', room: B.pk, at: w.clock.now() })
  await adv(w, 1_000)
  await deleteContact(w, A, B)
  await adv(w, 5_000)
  expect(!A.engine.memo.set(`draft:${B.pk}`, 'ZQ-READD-LATE'), 'deleted: a draft of B is refused')
  await adv(w, 6 * MIN)
  await scanEachOther(w, A, B, 5_000)
  await until(w, () => A.state().connect.phase === 'done' && hasContact(A, B), 3 * MIN, 'A re-adds B')
  expect(A.engine.memo.get(`draft:${B.pk}`) === undefined && A.engine.memo.get(npub) === undefined, 'no old draft or linked profile comes back')
  expect((A.engine.memo.get<{ room: string | null }>('place') ?? { room: null }).room === null, "the open room is not B's")
  expect(!dumpOf(A).includes('ZQ-READD-'), 'nothing of the old values is stored')
  expect(A.engine.memo.set(`draft:${B.pk}`, 'ZQ-NEW') && A.engine.memo.get(`draft:${B.pk}`) === 'ZQ-NEW', 'a contact again: its draft is kept')
  await restart(A)
  await adv(w, MIN)
  expect(A.engine.memo.get(`draft:${B.pk}`) === 'ZQ-NEW', 'and survives a restart')
  await finish(w)
}

/**
 * S-SENTAT-READD: A deleted B (A the higher key, lacking); B,
 * the holder and lower key, has its clock 5 minutes ahead. They scan each other; A asks, B
 * makes the room, its Welcome dated 5 minutes ahead. After the re-add A's roomSentAt is not
 * past A's clock. B's clock is put right and B is restored: A takes B's first room at once
 * (before the fix A refused it as older than the stored date until the clock caught up).
 */
export async function sSentAtReadd(): Promise<void> {
  const { w, A, B } = await linkedPair(false)
  await deleteContact(w, A, B)
  await adv(w, 6 * MIN)
  // B scans first with a right clock (A's QR would look expired to a clock 5 minutes
  // ahead), then its clock runs ahead before it makes the room A asks for.
  A.a.startConnect()
  B.a.startConnect()
  const pa = A.state().connect.myPayload ?? ''
  const pb = B.state().connect.myPayload ?? ''
  w.payloads.push(pa, pb)
  void B.a.submitScan(pa, 'camera').catch(() => {})
  await w.clock.settle()
  skew(B, 5 * MIN)
  await adv(w, 5_000)
  void A.a.submitScan(pb, 'camera').catch(() => {})
  await until(w, () => A.state().connect.phase === 'done' && hasContact(A, B), 3 * MIN, 'A re-adds B')
  const room = chanRoom(A, B)
  const welcome = invitesOf(w, B, A).find((r) => r.groupId === room)
  expect(!!welcome && welcome.sentAt * 1000 > w.clock.now() + 2 * MIN, `B's Welcome of the re-add was dated ahead (${welcome ? welcome.sentAt * 1000 - w.clock.now() : 'none'} ms)`)
  const rec = chanRec(A, B)
  expect((rec?.roomSentAt ?? Infinity) <= Math.floor(w.clock.now() / 1000), `A's roomSentAt is not past A's clock (${(rec?.roomSentAt ?? 0) * 1000 - w.clock.now()} ms ahead)`)
  // B's clock is put right and B is restored a minute later (its own gap no longer holds
  // it back): its first room is dated by the right clock, before the date the Welcome of
  // the re-add carried.
  skew(B, 0)
  await adv(w, MIN)
  await restore(B)
  await until(w, () => sameNewRoom(A, B, room), 3 * MIN, "with B's clock right, A takes B's next room")
  await finish(w)
}

/**
 * S-REDEEMED-CODE: A deleted B (A the higher key, lacking). They
 * scan each other; B's proof carries A's code, A answers it (the code is now used by B), but
 * B's echo of A's answer is lost. A scans B again within 2 minutes and B scans A's QR again
 * (still the same code): B's proof of the same code, used by the same peer, is a proof again,
 * so A links.
 */
export async function sRedeemedCode(): Promise<void> {
  const { w, A, B } = await linkedPair(false)
  await deleteContact(w, A, B)
  await adv(w, 6 * MIN)
  A.a.startConnect()
  B.a.startConnect()
  const pa = A.state().connect.myPayload ?? ''
  const pb = B.state().connect.myPayload ?? ''
  w.payloads.push(pa, pb)
  const codeOf = (e: Envelope): string | undefined => (JSON.parse(e.json) as { code?: string }).code
  const cb = connectModule.decodePayload(pb)?.code
  const issued = w.clock.now()
  // B's echo of A's answer (B's own code cb) never reaches A.
  w.hub.route = (e) => (e.from === B.pk && e.t === 'hello' && codeOf(e) === cb ? 'drop' : 'deliver')
  void B.a.submitScan(pa, 'camera').catch(() => {})
  await adv(w, 5_000)
  void A.a.submitScan(pb, 'camera').catch(() => {})
  const replied = () => (A.kv.peek<Record<string, { replied?: boolean }>>('scans') ?? {})[B.pk]?.replied === true
  await until(w, replied, MIN, "A answers B's proof")
  expect(!hasContact(A, B), "without B's echo A is not linked")
  B.a.rotateConnectCode()
  const pb2 = B.state().connect.myPayload ?? ''
  w.payloads.push(pb2)
  void A.a.submitScan(pb2, 'camera').catch(() => {})
  await adv(w, 2_000)
  void B.a.submitScan(pa, 'camera').catch(() => {})
  expect(w.clock.now() - issued < 2 * MIN, "A's code is still within CODE_REDEEM_MS")
  await until(w, () => A.state().connect.phase === 'done' && hasContact(A, B), MIN, 'A links on the second attempt')
  expect(chanRoom(A, B) !== '' && chanRoom(A, B) === chanRoom(B, A), 'one room')
  await finish(w)
}

/**
 * S-REQUEST-RESTART (REQUEST_AFTER_MS): A deleted B (A the higher key,
 * lacking). B scans A first (its room is old: nothing goes), A scans B, and A's tab is
 * killed 3 seconds later, before its first request; A opens again 20 seconds after the scan.
 * The request timers come back from the stored scan time: A asks at once for the missed
 * point, B makes the room, A links.
 */
export async function sRequestRestart(): Promise<void> {
  const { w, A, B } = await linkedPair(false)
  await deleteContact(w, A, B)
  await adv(w, 6 * MIN)
  const t0 = w.clock.now()
  A.a.startConnect()
  B.a.startConnect()
  const pa = A.state().connect.myPayload ?? ''
  const pb = B.state().connect.myPayload ?? ''
  w.payloads.push(pa, pb)
  void B.a.submitScan(pa, 'camera').catch(() => {})
  await adv(w, 2_000)
  void A.a.submitScan(pb, 'camera').catch(() => {})
  await adv(w, 3_000)
  expect(invitesOf(w, A, B, t0).length === 0, 'no request before the tab is killed')
  powerOff(A)
  await adv(w, 17_000)
  A.spawn()
  await A.engine.start()
  await until(w, () => invitesOf(w, A, B, t0).length >= 1, 30_000, 'the restarted A asks B for the room')
  await until(w, () => hasContact(A, B), 2 * MIN, 'A links after the restart')
  expect(chanRoom(A, B) !== '' && chanRoom(A, B) === chanRoom(B, A), 'one room')
  await finish(w)
}

/**
 * S-RESCAN-AFTER-MOVE-TWIN: the room of two contacts moved (B lost it)
 * and within HOLDER_PAIR_MS they scan each other: A or B first; 5 s, 90 s or 4 min apart; A the
 * lower or the higher key; no restart, A restarted or B restarted 3 s after the second scan.
 * World 1: A keeps B, both holders. World 2: A deleted B. A the higher key links in that room
 * as a shaped link, which follows the holder rules on the wire: A's envelopes to B (kind,
 * moment, size), A's invites and A's support log are the same in both worlds,
 * also across the restarts and when B scanned first long before.
 * A the lower key makes a new tagged room in world 2 (the trace allowed for a re-add by scanning): world 1
 * makes none, world 2 exactly one, for B's QR key package. B says 'already' and keeps the
 * room, the name and the chat in both. A links in world 2 unless A scanned 2 minutes or more
 * after B: A's code in B's proof is too old for a link then (CODE_REDEEM_MS holds
 * for the A branch), so world 2's A ends with no contact and its screen in 'timeout'; that
 * outcome is asserted, not skipped. A the higher key pins (B's move bound the
 * room) in both worlds or in neither. `moveAfter`: 2 hours later B loses the room again and
 * reopens it without a tag; A takes or ignores it alike in both worlds.
 */
export async function sRescanAfterMoveTwin(aFirst: boolean, gapMs: number, aLow: boolean, restartWho: 'none' | 'A' | 'B', moveAfter = false): Promise<void> {
  const MOVE_AT = 10 * MIN
  // Both scans within HOLDER_PAIR_MS of the move (the second one up to 4.5 minutes after it).
  const SCAN_AT = MOVE_AT + 30_000
  const shown: { p1: string; p2: string }[] = []
  const scanned: number[] = []
  /** moveAfter: whether A had pinned B's channel right after the scans, per world. */
  const pinAt: boolean[] = []
  /** moveAfter: whether A followed B's untagged move, per world. */
  const followed: boolean[] = []
  const restartAt = SCAN_AT + gapMs + 3_000
  const script: TwinScript = {
    b: [
      {
        atMs: MOVE_AT,
        act: async (B) => {
          const A = B.world.peers[0]
          B.world.hub.loseGroup(B.pk, chanRoom(B, A))
          await B.world.clock.settle()
        },
      },
      {
        atMs: SCAN_AT,
        act: async (B) => {
          const A = B.world.peers[0]
          scanned.push(B.world.clock.now())
          shown.push(await scanEachOther(B.world, aFirst ? A : B, aFirst ? B : A, gapMs))
        },
      },
      ...(restartWho === 'B' ? [{ atMs: restartAt, act: (B: Peer) => restart(B) }] : []),
      {
        // A hello with a code that is no code of A's, in the room A is in:
        // a holder and a shaped link throw it away alike, without a trace.
        atMs: SCAN_AT + gapMs + 30_000,
        act: async (B: Peer) => {
          const A = B.world.peers[0]
          B.world.hub.inject(B.pk, chanRoom(B, A), JSON.stringify({ t: 'hello', v: 1, code: 'f'.repeat(32) }))
          await B.world.clock.settle()
        },
      },
      { atMs: SCAN_AT + gapMs + HOLDER_SCAN_TTL_MS + 2 * MIN, act: async () => {} },
      ...(moveAfter
        ? [
            {
              atMs: SCAN_AT + gapMs + HOLDER_SCAN_TTL_MS + 2 * MIN + 1,
              act: async (B: Peer) => {
                const A = B.world.peers[0]
                pinAt.push(pinOf(A, B) > B.world.clock.now())
              },
            },
            {
              atMs: SCAN_AT + 2 * 60 * MIN,
              act: async (B: Peer) => {
                const A = B.world.peers[0]
                B.world.hub.loseGroup(B.pk, chanRoom(B, A))
                await B.world.clock.settle()
              },
            },
            {
              atMs: SCAN_AT + 2 * 60 * MIN + 20 * MIN,
              act: async (B: Peer) => {
                const A = B.world.peers[0]
                followed.push(chanRoom(A, B) === chanRoom(B, A))
                // A pinned channel heals by meeting: they scan each other again, B (L)
                // opens a tagged room at its deadline and A takes it by the tag.
                await scanEachOther(B.world, B, A, 5_000)
              },
            },
            { atMs: SCAN_AT + 2 * 60 * MIN + 20 * MIN + HOLDER_SCAN_TTL_MS + 2 * MIN, act: async () => {} },
          ]
        : []),
    ],
    a: restartWho === 'A' ? [{ atMs: restartAt, act: (A: Peer) => restart(A) }] : [],
  }
  const r = await twin(script, { aLow, relink: aLow })
  if (!aLow) expectSameEnvelopes(r.seqs)
  // The 2-minute redeem window: A links when B's proof carries a code A showed within CODE_REDEEM_MS (B scanned
  // after A, or less than 2 minutes before), and A's own link has not given up by then
  // (2 minutes for the lower key's relink; a shaped link waits while its scan is fresh).
  const linkable = aFirst ? !aLow || gapMs < 2 * MIN : gapMs < 2 * MIN
  if (!aLow) {
    // The deleting side pairs and pins exactly as the holder does, so B cannot tell.
    const pins = r.worlds.map((w, i) => pinOf(r.a[i], r.b[i]) > w.clock.now())
    if (linkable) expect(pins[0] === pins[1], `A pins B in both worlds or in neither (${pins.join('/')})`)
    if (moveAfter) {
      expect(pinAt.length === 2 && pinAt[0] && pinAt[1], `A pinned B after the scans in both worlds (${pinAt.join('/')})`)
      expect(followed.length === 2 && followed[0] === followed[1] && !followed[0], `A ignores B's untagged move in both worlds (pinned) (${followed.join('/')})`)
      r.worlds.forEach((_, i) => {
        expect(chanRoom(r.a[i], r.b[i]) !== '' && chanRoom(r.a[i], r.b[i]) === chanRoom(r.b[i], r.a[i]), `world ${i + 1}: meeting again heals the pinned channel`)
      })
      for (const w of r.worlds) await finish(w)
      return
    }
  }
  for (let i = 0; i < 2; i++) {
    const [w, A, B] = [r.worlds[i], r.a[i], r.b[i]]
    const scanAt = scanned[i]
    const room = chanRoom(B, A)
    expect(room !== '' && room === chanRoom(A, B), `world ${i + 1}: one room`)
    // A restarted B shows no connect screen any more. World 2 with A the lower key first and
    // 4 minutes apart: A's link (2 minutes) failed before B scanned, so A's
    // screen no longer showed a QR B could scan (it is expired).
    const lateLink = i === 1 && aLow && aFirst && gapMs >= 2 * MIN
    expect((restartWho === 'B' || lateLink || B.state().connect.phase === 'already') && hasText(B, A, 'hi'), `world ${i + 1}: B says 'already' and keeps its chat`)
    const inv = w.hub.invites.filter((x) => x.atMs >= scanAt)
    if (!aLow || i === 0) {
      expect(inv.length === 0, `world ${i + 1}: no invite, no request after the scans (${inv.length})`)
      const fromA = sent(w, A, B).filter((e) => e.atMs >= scanAt)
      expect(fromA.length > 0 && fromA.every((e) => e.t === 'hello' && e.groupId === room), `world ${i + 1}: A sent only hellos, into that room (${fromA.map((e) => e.t).join(',')})`)
    } else {
      const qrB = aFirst ? shown[i].p2 : shown[i].p1
      expect(
        inv.length === 1 && inv[0].from === A.pk && inv[0].kpRef === payloadKp(qrB) && w.hub.tagOf(inv[0].groupId) !== undefined,
        `world 2: A made one tagged room for B's QR key package (${inv.length})`,
      )
    }
    if (i === 0 || linkable) expect(hasContact(A, B), `world ${i + 1}: A has B as a contact at the end`)
    else {
      // The redeem window limit, asserted: the deleting side cannot re-add from a scan of B that old.
      const c = A.state().connect
      expect(!hasContact(A, B), 'world 2: A, who scanned 2 minutes or more after B, has no contact B (the 2-minute redeem window)')
      expect(restartWho === 'A' || (c.phase === 'failed' && c.errorKey === 'timeout') || c.phase === 'showing', `world 2: A's screen ends in 'timeout' (${c.phase}/${c.errorKey})`)
    }
  }
  for (const w of r.worlds) await finish(w)
}
