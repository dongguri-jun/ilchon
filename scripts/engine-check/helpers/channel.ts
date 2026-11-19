/**
 * Shared engine check helpers of the channel scenarios: rooms, restores, scans.
 */
import { STORE_FORMAT } from '../../../src/engine/index'
import { type Envelope, type FakeHub, type HarnessKV, createHarnessKV } from '../../fake-transport'
import * as connectModule from '../../../src/lib/connect'
import { expect } from '../report'
import { BOTH, MIN, type Peer, START_MS, type World, adv, link, makePeer, newWorld, orderedKeys, until } from '../world'

// ---------------------------------------------------------------- restores and lost rooms

export type ChanRec = { groupId: string | null; moves?: number[]; moving?: number; pending?: true; roomSentAt?: number; roomAt?: number; pinnedUntil?: number; peerSentAt?: number }

/** x's channel record of y as stored: the contact, or the tombstone. */
export function chanRec(x: Peer, y: Peer): ChanRec | undefined {
  const c = (x.kv.peek<(ChanRec & { pubkey: string })[]>('contacts') ?? []).find((r) => r.pubkey === y.pk)
  return c ?? (x.kv.peek<Record<string, ChanRec>>('tombstones') ?? {})[y.pk]
}

/** x's room with y ('' when none). */
export function chanRoom(x: Peer, y: Peer): string {
  return chanRec(x, y)?.groupId ?? ''
}

/** Both have the same room, and it is not `old`. */
export function sameNewRoom(x: Peer, y: Peer, old?: string): boolean {
  const g = chanRoom(x, y)
  return g !== '' && g === chanRoom(y, x) && g !== old
}

/** Welcomes from x to y in the hub's record since `since` (virtual ms). */
export function invitesOf(w: World, x: Peer, y: Peer, since = START_MS): FakeHub['invites'][number][] {
  return w.hub.invites.filter((r) => r.from === x.pk && r.to === y.pk && r.atMs >= since)
}

/** The engine stops and stays off (the app is closed); `on` starts it again. */
export async function off(p: Peer): Promise<void> {
  await p.engine.stop()
  p.kv.close(p.tag, 'stop')
  p.dead = true
}
export async function on(p: Peer): Promise<void> {
  p.spawn()
  await p.engine.start()
}

/** The peer's clock goes this far ahead from now on (engine and Welcome sentAt). */
export function skew(p: Peer, ms: number): void {
  p.offset = ms
  p.world.hub.setOffset(p.pk, p.device, ms)
}

/**
 * A new phone's store with the contact list of `p` as recovery puts it (made by the
 * harness): names kept, every room unknown (groupId null), the
 * tombstones too, no chats. The identity is a restored one (no words).
 */
export function restoredKv(p: Peer): HarnessKV {
  const contacts = (p.kv.peek<{ id: string; pubkey: string; name: string; createdAt: number }[]>('contacts') ?? []).map((c) => ({
    id: c.id,
    pubkey: c.pubkey,
    name: c.name,
    createdAt: c.createdAt,
    groupId: null,
  }))
  const tombs: Record<string, { at: number; groupId: null }> = {}
  for (const [pk, tb] of Object.entries(p.kv.peek<Record<string, { at: number }>>('tombstones') ?? {})) tombs[pk] = { at: tb.at, groupId: null }
  const kv = createHarnessKV()
  kv.seed('identity', { v: 1, sk: p.sk })
  kv.seed('format', STORE_FORMAT)
  kv.seed('contacts', contacts)
  kv.seed('tombstones', tombs)
  return kv
}

let restoreCount = 0
/**
 * The phone of `p` is lost; the same 12 words open the app on a new device (hub.wipe of
 * the old one, hub.marmot('restored…'), channel 검사). The Peer object stays (its name, its
 * support log); its KV and device are new.
 */
export async function restore(p: Peer, opts: { start?: boolean } = {}): Promise<void> {
  const kv = restoredKv(p)
  if (!p.dead) {
    await p.engine.stop()
    p.kv.close(p.tag, 'stop')
  }
  p.world.hub.wipe(p.pk, p.device)
  p.world.kvs.push(kv)
  p.kv = kv
  p.device = `restored${++restoreCount}`
  p.spawn()
  if (opts.start !== false) await p.engine.start()
}

/** A and B linked (A the lower key when aLow), A calls B '비', one chat each way. */
export async function linkedPair(aLow: boolean, opts: { skip?: string[] } = {}): Promise<{ w: World; A: Peer; B: Peer }> {
  const w = newWorld({ skip: opts.skip })
  const [lo, hi] = orderedKeys(2)
  const A = makePeer(w, 'A', { words: aLow ? lo.words : hi.words })
  const B = makePeer(w, 'B', { words: aLow ? hi.words : lo.words })
  await A.engine.start()
  await B.engine.start()
  await link(w, A, B)
  await A.a.renameContact(B.pk, '비')
  await A.a.sendChat(B.pk, 'one')
  await adv(w, 5_000)
  await B.a.sendChat(A.pk, 'two')
  await adv(w, 30_000)
  return { w, A, B }
}

export const hasText = (x: Peer, y: Peer, text: string): boolean => (x.state().rooms[y.pk] ?? []).some((m) => m.kind === 'text' && m.text === text)

/** Chats both ways in the room they share now, and opposite offers match. */
export async function expectWorking(w: World, A: Peer, B: Peer, tag: string): Promise<void> {
  await A.a.sendChat(B.pk, `${tag}-a`)
  await B.a.sendChat(A.pk, `${tag}-b`)
  await until(w, () => hasText(B, A, `${tag}-a`) && hasText(A, B, `${tag}-b`), 2 * MIN, `${tag}: chats both ways in the new room`)
  await A.a.postOffer({ side: 'buy', currency: 'KRW', amountMinor: 90000, feePct: 1, methods: BOTH })
  await B.a.postOffer({ side: 'sell', currency: 'KRW', amountMinor: 90000, feePct: 1, methods: BOTH })
  await until(w, () => A.state().matches.some((m) => m.contactId === B.pk) && B.state().matches.some((m) => m.contactId === A.pk), 5 * MIN, `${tag}: they match in the new room`)
}
export const CHANNEL_CHECK = 10 * MIN

/** Keys for A, B and two more contacts C < B < D (TwinOpts.around). */
export function aroundKeys(aLow: boolean): { a: string; b: string; c: string; d: string } {
  const k = orderedKeys(4).map((x) => x.words)
  return aLow ? { a: k[0], c: k[1], b: k[2], d: k[3] } : { c: k[0], b: k[1], d: k[2], a: k[3] }
}

export function expectSameEnvelopes([s1, s2]: string[][]): void {
  const firstDiff = s1.findIndex((x, i) => x !== s2[i])
  expect(
    s1.length === s2.length && firstDiff < 0,
    `A→B envelopes differ between the worlds (world 1: ${s1.length}, world 2: ${s2.length}, first difference at ${firstDiff}: ${s1[firstDiff]} / ${s2[firstDiff]})`,
  )
}

/**
 * A thief of `victim`'s key (hub.thief): a second participant of the
 * hub on a device of its own, running its own transport and engine, with the victim's
 * contact list as a restore puts it. `nowOffsetMs` moves its clock (and its Welcomes'
 * sentAt).
 */
export async function thiefOf(victim: Peer, opts: { nowOffsetMs?: number } = {}): Promise<Peer> {
  const w = victim.world
  const device = w.hub.thief(victim.pk)
  const T = makePeer(w, `thief-of-${victim.name}`, { words: victim.words, kv: restoredKv(victim), device, nowOffsetMs: opts.nowOffsetMs })
  await T.engine.start()
  return T
}

/** The thief's engine stops for good and its device is forgotten (it would get Welcomes to the victim's key). */
export async function dropThief(T: Peer): Promise<void> {
  if (!T.dead) await off(T)
  T.world.hub.wipe(T.pk, T.device)
}

// ---------------------------------------------------------------- rescans

/**
 * `first` scans `second`'s QR, `gapMs` later `second` scans `first`'s (a fresh code then,
 * as the screen rotates it every 30 s). Both by camera. Returns the two payloads scanned:
 * `first` scanned `second`'s (p2), `second` scanned `first`'s (p1).
 */
export async function scanEachOther(w: World, first: Peer, second: Peer, gapMs: number): Promise<{ p1: string; p2: string }> {
  first.a.startConnect()
  second.a.startConnect()
  const p2 = second.state().connect.myPayload ?? ''
  w.payloads.push(p2)
  void first.a.submitScan(p2, 'camera').catch(() => {})
  await adv(w, gapMs)
  first.a.rotateConnectCode()
  const p1 = first.state().connect.myPayload ?? ''
  w.payloads.push(p1)
  void second.a.submitScan(p1, 'camera').catch(() => {})
  await w.clock.settle()
  return { p1, p2 }
}

/** `x` scans `y`'s QR only (by camera); returns the payload. */
export async function scanOnly(w: World, x: Peer, y: Peer): Promise<string> {
  y.a.startConnect()
  const py = y.state().connect.myPayload ?? ''
  w.payloads.push(py)
  void x.a.submitScan(py, 'camera').catch(() => {})
  await w.clock.settle()
  return py
}

export const codeOf = (e: Envelope): string | undefined => (JSON.parse(e.json) as { code?: string }).code
export const payloadKp = (p: string): string => connectModule.decodePayload(p)?.kp ?? ''

/** x's stored pin of y's channel, 0 for none. */
export function pinOf(x: Peer, y: Peer): number {
  return (chanRec(x, y) as { pinnedUntil?: number } | undefined)?.pinnedUntil ?? 0
}

/** A peer of a linked pair whose channel record is put in place while it is off (harness setup). */
export async function withChannel(p: Peer, q: Peer, patch: Record<string, unknown>): Promise<void> {
  await off(p)
  const contacts = (p.kv.peek<Record<string, unknown>[]>('contacts') ?? []).map((c) => (c.pubkey === q.pk ? { ...c, ...patch } : c))
  p.kv.seed('contacts', contacts)
  await on(p)
  p.dead = false
}
