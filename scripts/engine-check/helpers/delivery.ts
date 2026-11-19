/**
 * Shared engine check helpers of the delivery scenarios (steps 2 to 5).
 */
import type { ChatMessage, EngineDeps, Offer } from '../../../src/contracts'
import { AMOUNT, FEE } from '../markers'
import { expect } from '../report'
import { BOTH, MIN, type Peer, type PeerOpts, type World, adv, link, makePeer, newWorld, settled, until } from '../world'
import { groupOf, matched } from './trade'

export function roomOf(x: Peer, y: Peer): ChatMessage[] {
  return x.state().rooms[y.pk] ?? []
}
export function countText(x: Peer, y: Peer, text: string): number {
  return roomOf(x, y).filter((m) => m.kind === 'text' && m.text === text).length
}

/** Two linked peers with quiet rooms (traffic both ways, nothing pending). */
export async function pair(opts: { a?: PeerOpts; b?: PeerOpts; inboxMax?: number; keys?: { words: string }[] } = {}): Promise<{ w: World; A: Peer; B: Peer }> {
  const w = newWorld({ inboxMax: opts.inboxMax })
  const A = makePeer(w, 'A', { words: opts.keys?.[0].words, ...opts.a })
  const B = makePeer(w, 'B', { words: opts.keys?.[1].words, ...opts.b })
  await A.engine.start()
  await B.engine.start()
  await link(w, A, B)
  await B.a.sendChat(A.pk, 'hi')
  await adv(w, 5_000)
  await A.a.sendChat(B.pk, 'hi')
  await adv(w, 30_000)
  return { w, A, B }
}

// ---------------------------------------------------------------- S-DLV (told)

/** Short engine timers for the told checks: two quick retries, a 1 s resend timer. */
export const TOLD: EngineDeps['tuning'] = { sendRetryMs: [100, 100], resendBaseMs: 1_000 }

type Told = Record<string, { offer: { amountMinor: number; feePct: number }; ok: boolean }>

export function toldOf(p: Peer): Told {
  return p.kv.peek<Told>('told') ?? {}
}

/** What `y` shows of `x`'s offer: nothing, or the offer it holds. */
export function offerViewOf(y: Peer, x: Peer): Offer | undefined {
  return y.state().matches.find((m) => m.contactId === x.pk)?.offer as Offer | undefined
}

/** `y` shows exactly `x`'s current offer (every public field). */
export function showsCurrent(y: Peer, x: Peer): boolean {
  const v = offerViewOf(y, x)
  const cur = x.state().myOffer
  return !!v && !!cur && v.side === cur.side && v.currency === cur.currency && v.amountMinor === cur.amountMinor && v.feePct === cur.feePct && v.createdAt === cur.createdAt
}

/** A (buy) and B (sell) linked and matched, both with the short told timers. */
export async function matchedPair(opts: { keys?: { words: string }[] } = {}): Promise<{ w: World; A: Peer; B: Peer }> {
  const { w, A, B } = await pair({ a: { tuning: TOLD }, b: { tuning: TOLD }, keys: opts.keys })
  await B.a.postOffer({ side: 'sell', currency: 'KRW', amountMinor: 90_000, feePct: 3, methods: BOTH })
  await until(w, () => settled(B), 5 * MIN, "B's rounds")
  await A.a.postOffer({ side: 'buy', currency: 'KRW', amountMinor: AMOUNT, feePct: FEE, methods: BOTH })
  await until(w, () => matched(A, B) && matched(B, A), 5 * MIN, 'A and B match')
  await adv(w, 5_000)
  expect(toldOf(A)[B.pk]?.ok === true, "A's told holds B, taken by a relay")
  return { w, A, B }
}

/** Every send of A in its room with B is refused while `on()`. */
export function refuseFrom(w: World, A: Peer, B: Peer, on: () => boolean, types?: string[]): void {
  const g = groupOf(A, B)
  w.hub.failSend = (from, groupId, msg) => (on() && from === A.pk && groupId === g && (!types || types.includes(msg.t)) ? 'reject' : false)
}

// ---------------------------------------------------------------- S-DLV (convergence)

/** The short timers of delivery's S-DLV table: quick retries, 1 s resend, 1 s echo wait, 5 s reconfirm floor. */
export const CONV: EngineDeps['tuning'] = { sendRetryMs: [100, 100], resendBaseMs: 1_000, echoWaitMs: 1_000, reconfirmFloorMs: 5_000 }

export function verifiedOf(p: Peer): Record<string, string> {
  return p.kv.peek<Record<string, string>>('verified') ?? {}
}

/** Both show the other's current offer. */
export function converged(A: Peer, B: Peer): boolean {
  return showsCurrent(A, B) && showsCurrent(B, A)
}

// ---------------------------------------------------------------- S-DLV (record ids, completion status, resend)

/** The delivery status a record carries ('sending' | 'sent' | 'failed'), or undefined. */
export function statusOf(m: ChatMessage | undefined): string | undefined {
  return m && 'status' in m ? m.status : undefined
}
