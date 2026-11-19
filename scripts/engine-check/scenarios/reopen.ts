/**
 * Engine check scenarios: reopen x matching x done.
 * Run from scripts/check-engine.ts, which lists every scenario in its order.
 */
import { HOLDER_PAIR_MS, HOLDER_SCAN_TTL_MS } from '../../../src/engine/index'
import { CHANNEL_CHECK, chanRec, chanRoom, linkedPair, payloadKp, sameNewRoom, scanOnly } from '../helpers/channel'
import { converged, statusOf, toldOf, verifiedOf } from '../helpers/delivery'
import { expectNoLeakToC, reopenTrio } from '../helpers/reopen'
import { dones, matched } from '../helpers/trade'
import { AMOUNT, dumpOf } from '../markers'
import { expect } from '../report'
import { MIN, type Peer, adv, deleteContact, finish, hasContact, powerOff, restart, sent, until } from '../world'

/**
 * S-REOPEN-MATCH: A and B matched, their room breaks (A, the lower key,
 * loses it, or B), the channel reopens. Right after the bind neither shows the other;
 * then both match again in the new room, each sending its offer there once,
 * and C, linked to both and matching nobody, gets nothing. `refuseWithdraw`: the withdraw
 * the bind owes (told stays) is refused in the new room for a while; the
 * offer still reaches the other side once it is matched again.
 */
export async function sReopenMatch(loser: 'L' | 'H', refuseWithdraw = false): Promise<void> {
  const { w, A, B, C, firstAB, firstBA } = await reopenTrio()
  const old = chanRoom(A, B)
  const t0 = w.clock.now()
  let refuse = refuseWithdraw
  if (refuseWithdraw) w.hub.failSend = (_from, g, msg) => (refuse && g !== old && msg.t === 'withdraw' ? 'reject' : false)
  w.hub.loseGroup(loser === 'L' ? A.pk : B.pk, old)
  await until(w, () => sameNewRoom(A, B, old), CHANNEL_CHECK, 'a new room')
  const room = chanRoom(A, B)
  if (refuseWithdraw) {
    await adv(w, 30_000)
    refuse = false
  }
  await until(w, () => converged(A, B), 5 * MIN, 'both match again in the new room')
  await adv(w, 2 * MIN)
  expect(converged(A, B), 'and stay matched')
  // What the first match cost each way (2 for the side that started the matching round:
  // the starting side's first send and onOffer's forced one; 1 for the answering side), in either order:
  // who starts the new room's round may differ. With the withdraw refused the starting
  // side's offer goes through told's resend instead (told still names it), so it may be
  // one less, never more.
  const now2 = [sent(w, A, B, 'offer'), sent(w, B, A, 'offer')].map((xs) => xs.filter((e) => e.atMs >= t0))
  const counts = now2.map((xs) => xs.length)
  const ok = refuseWithdraw
    ? counts.every((n) => n >= 1 && n <= Math.max(firstAB, firstBA)) && counts[0] + counts[1] <= firstAB + firstBA
    : JSON.stringify([...counts].sort()) === JSON.stringify([firstAB, firstBA].sort())
  expect(ok, `the offers of the reopen cost what the first match did (first ${firstAB}/${firstBA}, now ${counts.join('/')})`)
  expect(
    now2.flat().every((e) => e.groupId === room),
    'every offer after the break went into the new room',
  )
  for (const [x, y] of [
    [A, B],
    [B, A],
  ] as const) {
    expect(
      sent(w, x, y)
        .filter((e) => e.atMs >= t0)
        .every((e) => e.groupId === room),
      `${x.name} sent nothing into the old room after the break`,
    )
    expect(toldOf(x)[y.pk]?.ok === true, `${x.name}'s told of ${y.name} was taken by a relay`)
  }
  expectNoLeakToC(w, A, B, C)
  await finish(w)
}

/**
 * S-REOPEN-DONE: A and B matched; each marks a completion while their
 * room cannot carry it ('strand': the relays are out of reach; 'refused': A's done is
 * refused until its retries end, then B loses the room). After the reopen each record
 * reaches the other side once, in the new room only; each offer was cut once.
 */
export async function sReopenDone(kind: 'strand' | 'refused'): Promise<void> {
  const { w, A, B, C } = await reopenTrio()
  const old = chanRoom(A, B)
  const t0 = w.clock.now()
  const DONE = 10_000
  const oldTries: number[] = []
  let boundAt = Infinity
  w.hub.failSend = (from, g, msg) => {
    if (g !== old || msg.t !== 'done') return false
    if (from === A.pk && w.clock.now() >= boundAt) oldTries.push(w.clock.now())
    return kind === 'refused' && from === A.pk ? 'reject' : false
  }
  if (kind === 'strand') w.hub.strand(old)
  await A.a.markDone(B.pk, DONE)
  if (kind === 'refused') {
    await adv(w, 5_000)
    expect(dones(A, B, true)[0]?.status === 'failed', `A's completion failed in the old room (${dones(A, B, true)[0]?.status})`)
    w.hub.loseGroup(B.pk, old)
  } else {
    expect(dones(A, B, true)[0]?.status === 'failed', `A's completion fails at once in the stranded room (${dones(A, B, true)[0]?.status})`)
  }
  await B.a.markDone(A.pk, DONE)
  await until(w, () => sameNewRoom(A, B, old), 2 * CHANNEL_CHECK, 'a new room')
  boundAt = w.clock.now()
  const room = chanRoom(A, B)
  await until(w, () => dones(B, A, false).length > 0 && dones(A, B, false).length > 0, 5 * MIN, 'both completions arrive')
  await adv(w, 5 * MIN)
  expect(
    dones(A, B, true).length === 1 && dones(A, B, true)[0].status === 'sent',
    `A keeps one completion, sent (${dones(A, B, true)
      .map((d) => d.status)
      .join(', ')})`,
  )
  expect(dones(B, A, false).length === 1 && dones(B, A, false)[0].id === dones(A, B, true)[0].id, `B got A's completion once (${dones(B, A, false).length})`)
  expect(dones(A, B, false).length === 1 && dones(A, B, false)[0].id === dones(B, A, true)[0]?.id, `A got B's completion once (${dones(A, B, false).length})`)
  const aDone = sent(w, A, B, 'done').filter((e) => e.atMs >= t0)
  expect(aDone.length === 1 && aDone[0].groupId === room, `A's completion went up once, in the new room (${aDone.length})`)
  expect(oldTries.length === 0, `no try into the old room after the bind (${oldTries.length})`)
  expect(A.state().myOffer?.amountMinor === AMOUNT - DONE, `A's offer was cut once (${A.state().myOffer?.amountMinor})`)
  expect(B.state().myOffer?.amountMinor === 90_000 - DONE, `B's offer was cut once (${B.state().myOffer?.amountMinor})`)
  await until(w, () => converged(A, B), 5 * MIN, 'both match again with the cut amounts')
  expectNoLeakToC(w, A, B, C)
  await finish(w)
}

/**
 * S-DLV-19: A's completion is 'failed' (refused in the old
 * room until its retries end) when A's contact B is bound to a new room. bindRoom lives
 * inside the engine, so the hub starts the rebind: B loses the room (loseGroup) and A, the
 * lower key, opens the new one. Right after A binds, B is in neither A's matches nor
 * A's verified; the completion then goes up once, into the new room only, with nothing of A
 * into the old room after the bind; B's room holds it once; after the new round both match
 * again, and C (matching nobody) got nothing.
 */
export async function sDlv19(): Promise<void> {
  const { w, A, B, C } = await reopenTrio()
  const old = chanRoom(A, B)
  const t0 = w.clock.now()
  const DONE = 10_000
  // A refused send never reaches hub.log (failSend rejects before publish), so the
  // attempts of A into the old room are recorded here, every one with its time, and judged
  // afterwards against the bind (an attempt in the bind's own millisecond counts too).
  const oldTries: { at: number; t: string }[] = []
  w.hub.failSend = (from, g, msg) => {
    if (from !== A.pk || g !== old) return false
    oldTries.push({ at: w.clock.now(), t: msg.t })
    return msg.t === 'done' ? 'reject' : false
  }
  await A.a.markDone(B.pk, DONE)
  await adv(w, 5_000)
  expect(statusOf(dones(A, B, true)[0]) === 'failed', `A's completion failed in the old room (${statusOf(dones(A, B, true)[0])})`)
  expect(dones(B, A, false).length === 0, 'nothing reached B while refused')
  w.hub.loseGroup(B.pk, old)
  await until(w, () => chanRoom(A, B) !== '' && chanRoom(A, B) !== old, 2 * CHANNEL_CHECK, "A binds B's channel to a new room")
  const boundAt = w.clock.now()
  const room = chanRoom(A, B)
  expect(!matched(A, B), "right after the bind B is not in A's matches")
  expect(!(B.pk in verifiedOf(A)), "right after the bind B is not in A's verified")
  await until(w, () => sameNewRoom(A, B, old), CHANNEL_CHECK, 'B joins the new room')
  await until(w, () => dones(B, A, false).length > 0, 5 * MIN, "A's completion arrives")
  await until(w, () => converged(A, B), 5 * MIN, 'both match again after the new round')
  await adv(w, 2 * MIN)
  const rec = dones(A, B, true)
  expect(rec.length === 1 && statusOf(rec[0]) === 'sent', `A keeps one completion, sent (${rec.map((d) => statusOf(d)).join(', ')})`)
  const theirs = dones(B, A, false)
  expect(theirs.length === 1 && theirs[0].id === rec[0].id, `B's room holds A's completion once (${theirs.length})`)
  const up = sent(w, A, B, 'done').filter((e) => e.atMs >= t0)
  expect(up.length === 1 && up[0].groupId === room, `A's completion went up once, into the new room (${up.length})`)
  const intoOld = sent(w, A, B).filter((e) => e.atMs >= boundAt && e.groupId === old)
  expect(intoOld.length === 0, `no envelope of A into the old room after the bind (${intoOld.map((e) => e.t).join(', ')})`)
  expect(
    oldTries.some((x) => x.t === 'done' && x.at < boundAt),
    'the recorder saw the refused tries before the bind',
  )
  const doneTries = oldTries.filter((x) => x.t === 'done' && x.at >= boundAt)
  expect(doneTries.length === 0, `no try of A's completion into the old room after the bind, refused ones included (${doneTries.length})`)
  expect(matched(A, B) && matched(B, A), 'after the new round both show each other')
  expect(A.state().myOffer?.amountMinor === AMOUNT - DONE, `A's offer was cut once (${A.state().myOffer?.amountMinor})`)
  expectNoLeakToC(w, A, B, C)
  await finish(w)
}

/**
 * S-DLV-19-HOLDER (a failed completion meets a holder scan): A (the lower key) and B
 * matched; A's completion is 'failed' in the old room (refused until its retries end, as
 * S-DLV-19). Then A scans B's QR alone (B never scans), so A's holder deadline must open a
 * tagged room; A's tab is frozen over the deadline and comes back 60 s after it in a
 * phone's order (late timers, visibility 2.5 s later, reconnect 2.5 s after that). The
 * return opens one room for the key package in B's QR, B binds it by its tag, and the
 * pending completion then goes up once, into the new room only (no try into the old room
 * after the bind, refused ones included); right after the bind B is in neither A's matches
 * nor A's verified, both sides hold the same completion once, both match again, and C
 * (matching nobody) got nothing.
 */
export async function sDlv19HolderLate(): Promise<void> {
  const { w, A, B, C } = await reopenTrio()
  const old = chanRoom(A, B)
  const t0 = w.clock.now()
  const DONE = 10_000
  // Every attempt into the old room with its time, judged afterwards (as S-DLV-19).
  const oldTries: { at: number; t: string }[] = []
  w.hub.failSend = (from, g, msg) => {
    if (from !== A.pk || g !== old) return false
    oldTries.push({ at: w.clock.now(), t: msg.t })
    return msg.t === 'done' ? 'reject' : false
  }
  await A.a.markDone(B.pk, DONE)
  await adv(w, 5_000)
  expect(statusOf(dones(A, B, true)[0]) === 'failed', `A's completion failed in the old room (${statusOf(dones(A, B, true)[0])})`)
  const pb = await scanOnly(w, A, B)
  expect(A.state().connect.phase === 'already', "A says 'already'")
  const scanAt = (A.kv.peek<Record<string, { at: number }>>('scans') ?? {})[B.pk]?.at ?? w.clock.now()
  await adv(w, 1_000)
  A.freeze()
  await adv(w, scanAt + HOLDER_PAIR_MS + MIN - w.clock.now())
  expect(w.hub.invites.filter((r) => r.atMs >= t0).length === 0, 'nothing while A is away')
  expect(dones(B, A, false).length === 0, 'nothing reached B while A was away')
  A.thaw()
  await adv(w, 2_500)
  A.engine.rearmRounds()
  await adv(w, 2_500)
  A.engine.rearmRounds()
  await until(w, () => chanRoom(A, B) !== '' && chanRoom(A, B) !== old, HOLDER_SCAN_TTL_MS, "A binds B's channel to the tagged room")
  const boundAt = w.clock.now()
  const room = chanRoom(A, B)
  expect(!matched(A, B), "right after the bind B is not in A's matches")
  expect(!(B.pk in verifiedOf(A)), "right after the bind B is not in A's verified")
  await until(w, () => sameNewRoom(A, B, old), CHANNEL_CHECK, 'B joins the new room')
  const inv = w.hub.invites.filter((r) => r.atMs >= t0)
  expect(inv.length === 1 && inv[0].from === A.pk && inv[0].accepted && inv[0].groupId === room, `A (L) made one room and B joined it (${inv.length})`)
  expect(inv[0].kpRef === payloadKp(pb), "for the key package in B's QR")
  expect((chanRec(B, A) as { boundBy?: string })?.boundBy === 'tag', 'B bound it by its tag')
  await until(w, () => dones(B, A, false).length > 0, 5 * MIN, "A's completion arrives")
  await until(w, () => converged(A, B), 5 * MIN, 'both match again after the new round')
  await adv(w, 2 * MIN)
  const rec = dones(A, B, true)
  expect(rec.length === 1 && statusOf(rec[0]) === 'sent', `A keeps one completion, sent (${rec.map((d) => statusOf(d)).join(', ')})`)
  const theirs = dones(B, A, false)
  expect(theirs.length === 1 && theirs[0].id === rec[0].id, `B's room holds A's completion once (${theirs.length})`)
  const up = sent(w, A, B, 'done').filter((e) => e.atMs >= t0)
  expect(up.length === 1 && up[0].groupId === room, `A's completion went up once, into the new room (${up.map((e) => (e.groupId === room ? 'new' : 'other')).join(', ')})`)
  expect(
    oldTries.some((x) => x.t === 'done' && x.at < boundAt),
    'the recorder saw the refused tries before the bind',
  )
  const doneTries = oldTries.filter((x) => x.t === 'done' && x.at >= boundAt)
  expect(doneTries.length === 0, `no try of A's completion into the old room after the bind, refused ones included (${doneTries.length})`)
  expect(sent(w, A, B).filter((e) => e.atMs >= boundAt && e.groupId === old).length === 0, 'no envelope of A into the old room after the bind')
  expect(matched(A, B) && matched(B, A), 'after the new round both show each other')
  expect(A.state().myOffer?.amountMinor === AMOUNT - DONE, `A's offer was cut once (${A.state().myOffer?.amountMinor})`)
  expectNoLeakToC(w, A, B, C)
  await finish(w)
}

/**
 * S-REOPEN-RESTART: A and B matched, A (the lower key) loses the
 * room and makes a new one; before B joins it, one side restarts: B (its start-time reconfirm then
 * goes into the old room, which nobody reads; with `relock` through the auto-lock reload and
 * the PIN), or A (pending in the new room, its verified already gone). Both converge in the
 * new room. Rounds: each side starts one round in the new room when it binds; B's reconfirm
 * in the old room is the only extra one; no round 1 after the match settled.
 */
export async function sReopenRestart(who: 'A' | 'B' | 'B-relock'): Promise<void> {
  const PIN = '246810'
  const { w, A, B, C, firstAB, firstBA } = await reopenTrio(who === 'B-relock' ? { pinB: PIN } : {})
  const old = chanRoom(A, B)
  const t0 = w.clock.now()
  // B's Welcome waits while the restart happens (the transport hands invites to the engine).
  w.hub.setNetwork(B.pk, 'down')
  w.hub.loseGroup(A.pk, old)
  await until(w, () => chanRoom(A, B) !== old && chanRoom(A, B) !== '', MIN, 'A made a new room')
  const room = chanRoom(A, B)
  expect(chanRec(A, B)?.pending === true, 'the new room is pending')
  expect(!(B.pk in verifiedOf(A)) && !matched(A, B), 'right after the bind A neither verified nor shows B')
  if (who === 'A') {
    await restart(A)
    w.hub.setNetwork(B.pk, 'up')
  } else {
    w.hub.setNetwork(B.pk, 'up')
    if (who === 'B') await restart(B)
    else {
      powerOff(B)
      B.spawn()
      await B.engine.start()
      expect(B.state().boot === 'locked', `after the reload B is locked (${B.state().boot})`)
      await adv(w, 5_000)
      await B.a.unlock(PIN)
    }
  }
  await until(w, () => sameNewRoom(A, B, old) && converged(A, B), 10 * MIN, 'both match in the new room')
  const settledAt = w.clock.now()
  await adv(w, 3 * MIN)
  expect(converged(A, B) && chanRoom(A, B) === room, 'and stay matched there')
  const m1 = (x: Peer, y: Peer, g?: string) => sent(w, x, y, 'm1').filter((e) => e.atMs >= t0 && (g === undefined || e.groupId === g))
  // Rounds are counted by sid: a crossed start sends the same round 1 again (onM1).
  const rounds = (x: Peer, y: Peer, g?: string) => new Set(m1(x, y, g).map((e) => (JSON.parse(e.json) as { sid: string }).sid)).size
  expect(
    m1(A, B).every((e) => e.groupId === room),
    'A ran no round in the old room',
  )
  // Each side's bind starts one round. A restart of A, the lower key, re-arms the round it
  // had open (load), which then crosses B's bind round: B's yielded round comes back while
  // A's next round holds the window, A refuses it (mx), and B retries it once more (onMx,
  // armDeferred), so 3 for A (bind, re-armed, echo round) and 4 for B there. Nothing beyond.
  const most = who === 'A' ? 4 : 2
  expect(rounds(A, B, room) <= most && rounds(B, A, room) <= most, `at most ${most} rounds each in the new room (A ${rounds(A, B, room)}, B ${rounds(B, A, room)})`)
  expect(rounds(B, A, old) <= (who === 'A' ? 0 : 1), `B's only round in the old room is its start's reconfirm, and only when B restarted (${rounds(B, A, old)})`)
  expect(
    [...m1(A, B), ...m1(B, A)].every((e) => e.atMs <= settledAt),
    'no round 1 after both match',
  )
  const now2 = [sent(w, A, B, 'offer'), sent(w, B, A, 'offer')].map((xs) => xs.filter((e) => e.atMs >= t0))
  const counts = now2.map((xs) => xs.length)
  // As at the first match, or (A restarted) both sides once the starting side: B's answer
  // to A's round was cut short (not the window's owner), so B starts the round that settles
  // it and the late-m3 path runs (each sends first once, each answers once).
  const same = JSON.stringify([...counts].sort()) === JSON.stringify([firstAB, firstBA].sort())
  const ok = who === 'A' ? same || counts.every((n) => n === Math.max(firstAB, firstBA)) : same
  expect(ok, `the offers of the reopen cost what the first match did (first ${firstAB}/${firstBA}, now ${counts.join('/')})`)
  expect(
    now2.flat().every((e) => e.groupId === room),
    'every offer after the break went into the new room',
  )
  expectNoLeakToC(w, A, B, C)
  await finish(w)
}

/**
 * S-TOMB-MEMO: A had a draft for B and B's room open (memo), then deleted
 * B. B loses the room and the channel reopens to A's tombstone (A the lower key, or the
 * higher). The draft and the open room stay gone at A, also after A restarts; B still has
 * A as a contact in the new room.
 */
export async function sTombMemo(aLow: boolean): Promise<void> {
  const { w, A, B } = await linkedPair(aLow)
  A.engine.memo.set(`draft:${B.pk}`, 'ZQ-REOPEN-DRAFT')
  A.engine.memo.set('place', { tab: 'contacts', room: B.pk, at: w.clock.now() })
  await adv(w, 1_000)
  await deleteContact(w, A, B)
  await adv(w, 5_000)
  const gone = (when: string) => {
    expect(A.engine.memo.get(`draft:${B.pk}`) === undefined, `${when}: A's draft for B is gone`)
    expect((A.engine.memo.get<{ room: string | null }>('place') ?? { room: null }).room === null, `${when}: A's open room is not B's`)
    expect(!dumpOf(A).includes('ZQ-REOPEN-DRAFT'), `${when}: nothing of the draft is stored at A`)
  }
  gone('after the delete')
  const old = chanRoom(A, B)
  w.hub.loseGroup(B.pk, old)
  await until(w, () => sameNewRoom(A, B, old), 2 * CHANNEL_CHECK, "the tombstone's channel reopens")
  await adv(w, MIN)
  gone('after the reopen')
  expect(hasContact(B, A) && !hasContact(A, B), 'B keeps A as a contact; A keeps B deleted')
  await restart(A)
  await adv(w, MIN)
  gone('after a restart')
  await finish(w)
}
