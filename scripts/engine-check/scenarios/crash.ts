/**
 * Engine check scenarios: crashes at every write (S-CRASH-SWEEP, K-CRASH-MATCH).
 * Run from scripts/check-engine.ts, which lists every scenario in its order.
 */
import { HOLDER_SCAN_TTL_MS } from '../../../src/engine/index'
import type { HarnessKV, KvWrite } from '../../fake-transport'
import { ADDR_WPKH, LN_ADDRESS } from '../helpers/payment'
import { TRADE_RATES } from '../helpers/trade'
import { AMOUNT, CHAT, FEE } from '../markers'
import { Fail, errText, expect } from '../report'
import { BOTH, MIN, type Peer, type World, adv, deleteContact, fakeLnurl, finish, hasContact, makePeer, newWorld, orderedKeys, powerOff, until } from '../world'

// ---------------------------------------------------------------- S-CRASH-SWEEP, K-CRASH-MATCH

type SweepStep = { kind: 'act'; run: () => Promise<void> } | { kind: 'wait'; run: () => Promise<void> }

/**
 * A and B link, match with opposite offers and chat once. Steps that wait on the clock
 * run to the end; action steps race the crash, since an action can wait on a write
 * that never finishes.
 */
/** A call the power may cut: after a crash its rejection is expected and dropped. */
async function cutShort(p: Peer, call: Promise<unknown>): Promise<void> {
  try {
    await call
  } catch (e) {
    if (!p.dead) throw e
  }
}

function sweepSteps(w: World, A: Peer, B: Peer): SweepStep[] {
  let scans: Promise<void>[] = []
  const act = (run: () => Promise<void>): SweepStep => ({ kind: 'act', run })
  const wait = (pred: () => boolean, ms: number, what: string): SweepStep => ({
    kind: 'wait',
    run: () => until(w, () => A.dead || pred(), ms, what),
  })
  return [
    act(() => A.engine.start()),
    act(() => B.engine.start()),
    act(async () => {
      A.a.startConnect()
      B.a.startConnect()
      const pa = A.state().connect.myPayload ?? ''
      const pb = B.state().connect.myPayload ?? ''
      const [first, firstScans, second, secondScans] = A.pk < B.pk ? [A, pb, B, pa] : [B, pa, A, pb]
      scans = [first.a.submitScan(firstScans)]
      await w.clock.settle()
      scans.push(second.a.submitScan(secondScans))
    }),
    wait(() => hasContact(A, B) && hasContact(B, A), 120_000, 'link'),
    act(async () => {
      void scans
      A.a.cancelConnect()
      B.a.cancelConnect()
    }),
    act(() => B.a.postOffer({ side: 'sell', currency: 'KRW', amountMinor: 90000, feePct: 3, methods: BOTH })),
    act(() => A.a.postOffer({ side: 'buy', currency: 'KRW', amountMinor: AMOUNT, feePct: FEE, methods: BOTH })),
    wait(() => A.state().matches.length > 0 && B.state().matches.length > 0, 5 * MIN, 'match'),
    act(() => A.a.sendChat(B.pk, CHAT)),
    wait(() => (B.state().rooms[A.pk] ?? []).some((x) => x.kind === 'text' && x.text === CHAT), MIN, 'chat'),
    // Where A receives: the Lightning address write, an on-chain
    // request and a Lightning one (chat writes of the room) are crash points too.
    act(() => cutShort(A, A.a.setLightningAddress(LN_ADDRESS))),
    act(() => cutShort(A, A.a.sendPaymentRequest(B.pk, { method: 'onchain', amountMinor: 1000, address: ADDR_WPKH }))),
    wait(() => (B.state().rooms[A.pk] ?? []).some((x) => x.kind === 'text' && x.text.includes(ADDR_WPKH)), MIN, 'on-chain request'),
    act(() => cutShort(A, A.a.sendPaymentRequest(B.pk, { method: 'lightning', amountMinor: 1000 }))),
    wait(() => (B.state().rooms[A.pk] ?? []).filter((x) => x.kind === 'text' && !x.mine).length >= 3, MIN, 'Lightning request'),
    // A changes only its methods: a new offer id, the withdraw, a new
    // round and the match again on the one shared method are crash points too.
    act(() => A.a.postOffer({ side: 'buy', currency: 'KRW', amountMinor: AMOUNT, feePct: FEE, methods: ['lightning'] })),
    wait(() => A.state().matches.length > 0 && B.state().matches.some((m) => m.contactId === A.pk && m.offer.methods.join() === 'lightning'), 5 * MIN, 'match again after the method change'),
    // A guide step of B's room, so the delete also writes tradeSteps (in removeContact).
    act(() => A.a.setTradeStep(B.pk, 'receive')),
    // The delete is a crash point too: removeContact's writes in order.
    act(() => deleteContact(w, A, B)),
    // A (who deleted B, the lower key) re-adds B by scanning: the writes of the
    // tombstone's link (the scan, `moving`, the bind with the link following it, the
    // codes, completeLink) are crash points too.
    act(async () => {
      A.a.startConnect()
      B.a.startConnect()
      const pa = A.state().connect.myPayload ?? ''
      const pb = B.state().connect.myPayload ?? ''
      w.payloads.push(pa, pb)
      scans.push(A.a.submitScan(pb, 'camera'))
      await w.clock.settle()
      scans.push(B.a.submitScan(pa, 'camera'))
    }),
    wait(() => hasContact(A, B) && A.state().connect.phase === 'done', 3 * MIN, 'the re-add'),
    // The two holders scan each other again: the holder writes (the scan, its
    // proof, ack and pairing, the codes' holder proofs) are crash points too.
    act(async () => {
      A.a.cancelConnect()
      B.a.cancelConnect()
      await adv(w, 6 * MIN)
      A.a.startConnect()
      B.a.startConnect()
      const pa = A.state().connect.myPayload ?? ''
      const pb = B.state().connect.myPayload ?? ''
      w.payloads.push(pa, pb)
      scans.push(B.a.submitScan(pa, 'camera'))
      await w.clock.settle()
      scans.push(A.a.submitScan(pb, 'camera'))
    }),
    waitFor(w, A, HOLDER_SCAN_TTL_MS + MIN),
  ]
}

/** A wait step that only lets the clock run (or stops early when A is dead). */
function waitFor(w: World, A: Peer, ms: number): SweepStep {
  return {
    kind: 'wait',
    run: async () => {
      const end = w.clock.now() + ms
      while (!A.dead && w.clock.now() < end) await adv(w, Math.min(30_000, end - w.clock.now()))
    },
  }
}

interface SweepRun {
  w: World
  A: Peer
  B: Peer
  crashed: boolean
}

/** crashAt: before A's write number n+1 (a count), or at A's first write that matches (a predicate). */
async function sweepRun(keys: { words: string }[], crashAt: number | ((x: KvWrite, value: unknown) => boolean) | null, onWrite?: HarnessKV['onWrite']): Promise<SweepRun> {
  const w = newWorld()
  // A buys with a price and a wallet service, so its receive requests are part of the sweep.
  const A = makePeer(w, 'A', { words: keys[0].words, rates: { ...TRADE_RATES }, lnurl: fakeLnurl(w).module })
  const B = makePeer(w, 'B', { words: keys[1].words })
  A.kv.onWrite = onWrite
  let crashed = false
  const crashP =
    crashAt === null
      ? new Promise<void>(() => {})
      : (typeof crashAt === 'number' ? A.kv.crashAfter(crashAt) : A.kv.crashWhen(crashAt)).then(() => {
          crashed = true
          powerOff(A)
        })
  for (const step of sweepSteps(w, A, B)) {
    if (step.kind === 'wait') await step.run()
    else await Promise.race([step.run(), crashP])
    await w.clock.settle()
    if (crashed) break
  }
  return { w, A, B, crashed }
}

export async function sCrashSweep(): Promise<void> {
  const keys = orderedKeys(2)
  const base = await sweepRun(keys, null)
  const baseWrites = base.A.kv.writes.filter((x) => x.tag === base.A.tag)
  const total = baseWrites.length
  // The holder rescan ran in the swept sequence: A kept B's proof of its code.
  const heldProof = (base.A.kv.peek<{ holderUses?: Record<string, unknown> }[]>('codes') ?? []).some((c) => c.holderUses && base.B.pk in c.holderUses)
  expect(heldProof, "the swept sequence holds the holders' rescan (A kept B's proof)")
  await finish(base.w)
  expect(total > 10, `the sequence writes (${total})`)
  // The delete sequence is part of the sweep: tombstones, then contacts and the guide step.
  const tombAt = baseWrites.findIndex((x) => x.key === 'tombstones')
  expect(
    tombAt >= 0 && baseWrites.slice(tombAt).some((x) => x.key === 'tradeSteps') && baseWrites.slice(tombAt).some((x) => x.key === 'contacts'),
    'the swept sequence ends with the delete writes (tombstones, contacts, tradeSteps)',
  )
  // INV-M4 holds at every crash point, also between a round's init write and its owner
  // write while an older round owns the budget (an old defect, reachable by a
  // re-add): load() closes such a round. The window is in the sweep:
  const ownerWindow = baseWrites.some((x, j) => x.key === 'init' && baseWrites[j + 1]?.key === 'respondLog' && baseWrites[j + 2]?.key === 'roundOwner')
  expect(ownerWindow, 'the swept writes include a round written apart from its budget')
  // A crash right before each of A's writes (n = 0 .. total-1), and one after the last.
  for (let n = 0; n <= total; n++) {
    const r = await sweepRun(keys, n)
    // The power really went off before write n+1 (the run is the same as the base run);
    // only n = total, after the last write, is cut here.
    expect(n === total || r.crashed, `crash before write ${n + 1}: the power went off at that write`)
    if (!r.A.dead) powerOff(r.A)
    // A delete whose tombstone never reached storage did not happen: the restarted A
    // still has B as a contact and may match and send it my offer again (told).
    if (!(r.B.pk in (r.A.kv.peek<Record<string, unknown>>('tombstones') ?? {}))) r.w.deleted.delete(r.A.pk)
    r.A.spawn()
    try {
      await r.A.engine.start()
    } catch (e) {
      throw new Fail(`crash before write ${n + 1}: A does not start again (${errText(e)})`)
    }
    // 15 minutes: a crash right before the deleting L stores the bind of its tagged room
    // leaves B in that room as a candidate. The restarted A cannot invite the QR's key
    // package again (B's join replaced it on the relays, as the hub now models), and the
    // channel meets again only after B's holder scan ended (HOLDER_SCAN_TTL_MS, 11 minutes).
    try {
      await adv(r.w, 15 * MIN)
    } catch (e) {
      throw new Fail(`crash before write ${n + 1}: ${errText(e)}`)
    }
    expect(r.A.state().boot === 'ready', `crash before write ${n + 1}: A is ready`)
    // Once B was A's contact on disk, A has B as exactly one of contact and tombstone
    // after the crash: never both, never neither.
    if (r.A.kv.writes.some((x) => x.key === 'contacts')) {
      const asContact = hasContact(r.A, r.B) && (r.A.kv.peek<{ pubkey: string }[]>('contacts') ?? []).some((c) => c.pubkey === r.B.pk)
      const asTomb = r.B.pk in (r.A.kv.peek<Record<string, unknown>>('tombstones') ?? {})
      expect(asContact !== asTomb, `crash before write ${n + 1}: B is ${asContact && asTomb ? 'both a contact and a tombstone' : 'neither a contact nor a tombstone'} of A`)
      if (asTomb) {
        const tomb = (r.A.kv.peek<Record<string, { groupId?: string | null }>>('tombstones') ?? {})[r.B.pk]
        const roomB = r.B.state().contacts.find((c) => c.pubkey === r.A.pk)?.groupId
        expect(!!tomb?.groupId && tomb.groupId === roomB, `crash before write ${n + 1}: the tombstone keeps the room`)
        expect(r.A.kv.peek(`room:${r.B.pk}`) === undefined, `crash before write ${n + 1}: no chat item of the deleted contact is left`)
        expect(!(r.B.pk in (r.A.kv.peek<Record<string, unknown>>('tradeSteps') ?? {})), `crash before write ${n + 1}: no guide step of the deleted contact is left`)
      }
    }
    const errors = r.A.events.filter((e) => e.tag === r.A.tag && e.event === 'task-error')
    expect(errors.length === 0, `crash before write ${n + 1}: the new A ran without errors (${JSON.stringify(errors[0]?.info)})`)
    try {
      await finish(r.w)
    } catch (e) {
      throw new Fail(`crash before write ${n + 1}: ${errText(e)}`)
    }
  }
}

export async function kCrashMatch(): Promise<void> {
  const keys = orderedKeys(2)
  // The power goes off at A's write that stores its first match (postOffer writes an
  // empty list first, so the first non-empty one).
  const isMatchWrite = (x: KvWrite, value: unknown) => x.key === 'matches' && Array.isArray(value) && value.length > 0
  const r = await sweepRun(keys, isMatchWrite)
  expect(r.crashed, 'the crash happened at the match write')
  expect((r.A.kv.peek<unknown[]>('matches') ?? []).length === 0, 'the match write did not land')
  expect(r.A.kv.peek<Record<string, string>>('verified')?.[r.B.pk] !== undefined, 'A had verified B before the crash')
  r.A.spawn()
  await r.A.engine.start()
  await adv(r.w, 10 * MIN)
  expect(r.A.state().boot === 'ready', 'A is ready again after the crash')
  const aHasB = r.A.state().matches.some((m) => m.contactId === r.B.pk)
  const bHasA = r.B.state().matches.some((m) => m.contactId === r.A.pk)
  // The offer that made the match was in A's inbox when the power went off: delivered
  // again at the start, it makes the match again (the received-message inbox replaced the mark).
  expect(r.w.hub.inbox(r.A.pk).length === 0, `A's inbox is empty again (${r.w.hub.inbox(r.A.pk).length} left)`)
  await finish(r.w)
  expect(aHasB && bHasA, `both match each other after the crash (A has B: ${aHasB}, B has A: ${bHasA})`)
}
