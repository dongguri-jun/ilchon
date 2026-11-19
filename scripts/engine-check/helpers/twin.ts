/**
 * Shared engine check helpers: the twin comparison, of screens and of support logs.
 */
import type { EngineDeps, IlchonState, PubkeyHex } from '../../../src/contracts'
import { newMnemonic } from '../../../src/lib/seed/index'
import { expect } from '../report'
import { type Peer, START_MS, type World, adv, deleteContact, link, makePeer, newWorld, orderedKeys, peerOf, sent } from '../world'
import { aroundKeys } from './channel'

// ---------------------------------------------------------------- S-TWIN

interface Step {
  atMs: number
  act: (p: Peer) => Promise<void>
}
export interface TwinScript {
  a: Step[]
  b: Step[]
}

/**
 * Two worlds with the same key pair. In world 1 A keeps B as a contact without an
 * offer; in world 2 A deletes B at the same virtual moment. Both get the same
 * script. Assertion 1: A's envelopes to B are the same (t, atMs, json.length); the
 * caller checks it on `seqs`. Assertion 2: A's support log dumps, made at the same
 * virtual moment, are the same to the character; twin() itself checks it, so every
 * twin script (S-TWIN and the S-LOG-TWIN-* variants) is held to it.
 */
interface TwinOpts {
  aLow: boolean
  /** A also links C (same key in both worlds) before the twin premise (S-LOG-TWIN-OFFLINE). */
  withC?: boolean
  /** Runs in both worlds after the premise, right before the split (S-LOG-TWIN-STALE). */
  beforeSplit?: (w: World, A: Peer, B: Peer) => Promise<void>
  /** B sends nothing after the link, so the inviter A keeps its pending confirmation (S-TWIN-CONFIRM). */
  quietB?: boolean
  /**
   * World 1's own action at the moment of the split, where world 2 deletes B (in S-DLV-9:
   * A takes its offer down). Without it world 1 does nothing.
   */
  split1?: (w: World, A: Peer, B: Peer) => Promise<void>
  /** Engine tuning of A and B in both worlds (S-DLV-9: a short resend timer). */
  tuning?: EngineDeps['tuning']
  /** List relays of A in both worlds (S-REC-13: A keeps its contact list). */
  listRelays?: string[]
  /** A also has contacts C and D, keys just before and after B's (S-CH-TWIN-*). */
  around?: boolean
  /**
   * World 2's A re-adds B by scanning: its new room or request is a trace on the wire
   * that is allowed, so assertion 3 (A's invites) is not made. The logs still are.
   */
  relink?: boolean
}

export async function twin(script: TwinScript, opts: TwinOpts): Promise<{ worlds: [World, World]; seqs: string[][]; a: Peer[]; b: Peer[]; logs: [string, string] }> {
  const [lo, hi] = orderedKeys(2)
  const ak = opts.around ? aroundKeys(opts.aLow) : null
  const [wordsA, wordsB] = ak ? [ak.a, ak.b] : opts.aLow ? [lo.words, hi.words] : [hi.words, lo.words]
  const wordsC = newMnemonic()
  const worlds: World[] = []
  const as: Peer[] = []
  const bs: Peer[] = []
  const splits: number[] = []
  for (const which of [1, 2]) {
    const w = newWorld()
    const A = makePeer(w, 'A', { words: wordsA, tuning: opts.tuning, listRelays: opts.listRelays })
    const B = makePeer(w, 'B', { words: wordsB, tuning: opts.tuning })
    // Assertion 4: what B's screens show of A (the deleted side cannot tell).
    B.view = (st) => screenOf(st, A.pk)
    await A.engine.start()
    await B.engine.start()
    if (opts.withC) {
      const C = makePeer(w, 'C', { words: wordsC })
      await C.engine.start()
      await link(w, A, C)
      await C.a.sendChat(A.pk, 'hi')
      await adv(w, 5_000)
      await A.a.sendChat(C.pk, 'hi')
      await adv(w, 30_000)
    }
    if (ak) {
      for (const [name, words] of [
        ['C', ak.c],
        ['D', ak.d],
      ] as const) {
        const Q = makePeer(w, name, { words })
        await Q.engine.start()
        await link(w, A, Q)
        await Q.a.sendChat(A.pk, 'hi')
        await adv(w, 5_000)
        await A.a.sendChat(Q.pk, 'hi')
        await adv(w, 30_000)
      }
    }
    await link(w, A, B)
    // Traffic from both sides empties scans and the inviter's pending confirmation on
    // both (the invitee's message is what the inviter waits for).
    if (!opts.quietB) await B.a.sendChat(A.pk, 'hi')
    await adv(w, 5_000)
    await A.a.sendChat(B.pk, 'hi')
    await adv(w, 30_000)
    for (const p of [A, B]) {
      const keeps = opts.quietB && p === A && opts.aLow
      const pending = Object.keys(p.kv.peek<object>('confirms') ?? {}).length
      expect(keeps ? pending === 1 : pending === 0, `twin: ${p.name} has ${keeps ? 'its' : 'no'} pending confirmation (${pending})`)
      expect(Object.keys(p.kv.peek<object>('scans') ?? {}).length === 0, `twin: ${p.name} has no scan`)
    }
    if (opts.beforeSplit) await opts.beforeSplit(w, A, B)
    const split = w.clock.now()
    splits.push(split)
    if (which === 2) await deleteContact(w, A, B)
    else if (opts.split1) await opts.split1(w, A, B)
    const steps = [...script.b.map((s) => ({ ...s, who: B })), ...script.a.map((s) => ({ ...s, who: A }))].sort((x, y) => x.atMs - y.atMs)
    for (const s of steps) {
      const at = split + s.atMs
      if (at > w.clock.now()) await adv(w, at - w.clock.now())
      await s.act(s.who)
      await w.clock.settle()
    }
    worlds.push(w)
    as.push(A)
    bs.push(B)
  }
  const seqs = worlds.map((w, i) => sent(w, as[i], bs[i]).map((e) => `${e.t}@${e.atMs - START_MS}:${e.json.length}`))
  // Assertion 2.
  const logs = twinLogs({ worlds: worlds as [World, World], a: as })
  expect(logs[0].includes('boot  ready'), `the log has lines at all\n${logs[0]}`)
  expectSameLog(logs)
  // With it, A's diagnostics of hellos it threw away : debug events make no
  // support log line today, but a deleted contact must not leave one a living one does not.
  const rejected = as.map((a, i) =>
    a.events
      .filter((e) => e.event === 'hello-rejected' && e.atMs >= splits[i])
      .map((e) => e.atMs - splits[i])
      .join(','),
  )
  // A re-add by scanning runs a link of its own in a room of its own: not compared.
  if (!opts.relink) expect(rejected[0] === rejected[1], `A's 'hello-rejected' events differ (world 1: [${rejected[0]}], world 2: [${rejected[1]}])`)
  // Assertion 3, except for the re-add by scanning.
  if (!opts.relink) expectSameInvites(worlds as [World, World], as)
  // Assertion 4: B's screens show the same of A at every moment in both worlds, also when
  // A re-adds B by scanning: that trace is allowed on the wire only, never on B's screen.
  expectSameViews(bs)
  return { worlds: worlds as [World, World], seqs, a: as, b: bs, logs }
}

/**
 * What a peer's screens show of contact `pk` (twin assertion 4): the room's reconnect status
 * (reopening: whether, the time it names, the scan hint), whether `pk` is a contact, and the
 * room's lines other than the contact's texts (system lines, and my texts with their
 * delivery status). The contact's texts are left out: in world 2 the deleting side sends none.
 */
export function screenOf(st: IlchonState, pk: PubkeyHex): string {
  const r = st.reopening[pk]
  const reopen = !r ? '-' : r.scan ? 'scan' : r.at !== undefined ? `at ${r.at - START_MS}` : 'soon'
  const contact = st.contacts.some((c) => c.pubkey === pk) ? 'contact' : 'none'
  const room = (st.rooms[pk] ?? []).filter((m) => m.kind !== 'text' || m.mine).map((m) => (m.kind === 'text' ? `me:${m.status ?? 'sent'}` : m.kind))
  return `${contact} reopen=${reopen} room=[${room.join(',')}]`
}

function expectSameViews(bs: Peer[]): void {
  const [v1, v2] = bs.map((b) => b.views)
  const found = v1.findIndex((x, i) => x !== v2[i])
  const at = found < 0 ? Math.min(v1.length, v2.length) : found
  expect(
    v1.length === v2.length && found < 0,
    `B's screens differ between the worlds (the deleted side must not tell; world 1: ${v1.length} changes, world 2: ${v2.length}, first difference at ${at}: ${v1[at]} / ${v2[at]})`,
  )
}

/**
 * Twin assertion 3: A's Welcomes in the hub's invites
 * record, the ones A sent as (to, atMs, sentAt) and the ones A joined as (from, the
 * moment of the join), are the same in both worlds. A deleted contact's channel opens,
 * asks and joins exactly when a living contact's does.
 */
function inviteSeq(w: World, a: Peer): string[] {
  return w.hub.invites
    .filter((r) => r.from === a.pk || (r.to === a.pk && r.accepted))
    .map((r) =>
      r.from === a.pk
        ? `sent ${peerOf(w, r.to)?.name ?? r.to.slice(0, 8)}@${r.atMs - START_MS}:${r.sentAt}`
        : `joined ${peerOf(w, r.from)?.name ?? r.from.slice(0, 8)}@${(r.acceptedAtMs ?? 0) - START_MS}`,
    )
}
export function expectSameInvites(worlds: [World, World], as: Peer[]): void {
  const [i1, i2] = worlds.map((w, i) => inviteSeq(w, as[i]))
  const firstDiff = i1.findIndex((x, i) => x !== i2[i])
  expect(
    i1.length === i2.length && firstDiff < 0,
    `A's invites differ between the worlds (world 1: ${i1.length}, world 2: ${i2.length}, first difference at ${firstDiff}: ${i1[firstDiff]} / ${i2[firstDiff]})`,
  )
}

/** A's support log in both worlds of a twin, made at the same virtual moment. */
function twinLogs(r: { worlds: [World, World]; a: Peer[] }): [string, string] {
  expect(r.worlds[0].clock.now() === r.worlds[1].clock.now(), 'the twin worlds end at the same virtual moment')
  return [r.a[0].dumpLog(), r.a[1].dumpLog()]
}

function expectSameLog([l1, l2]: [string, string]): void {
  const x = l1.split('\n')
  const y = l2.split('\n')
  const at = x.findIndex((line, i) => line !== y[i])
  const ok = l1 === l2
  const what = `A's support log differs between the worlds (line ${at + 1}: '${x[at] ?? ''}' / '${y[at] ?? ''}')\nworld 1:\n${l1}\nworld 2:\n${l2}`
  expect(ok, what)
}
