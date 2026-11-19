/**
 * Shared engine check helpers of the trade scenarios.
 */
import type { Currency, IlchonState, Side, WireMessage } from '../../../src/contracts'
import { Fail } from '../report'
import { BOTH, MIN, type Peer, type World, adv, link, makePeer, newWorld, sent, settled, until } from '../world'

// ---------------------------------------------------------------- S-DONE-USD and S-TRD (B-1 to B-13, B-15)

/**
 * A and B linked and matched: A takes `aSide` with `aMinor`, B the other side with
 * `bMinor`, both in `currency`. Built only through the actions (the KV is not
 * filled in advance).
 */
export async function tradePair(opts: { aSide?: Side; currency?: Currency; aMinor: number; bMinor?: number; rates?: boolean }): Promise<{ w: World; A: Peer; B: Peer }> {
  const w = newWorld()
  const rates = opts.rates ? TRADE_RATES : undefined
  const A = makePeer(w, 'A', { rates })
  const B = makePeer(w, 'B', { rates })
  await A.engine.start()
  await B.engine.start()
  await link(w, A, B)
  const aSide = opts.aSide ?? 'buy'
  const currency = opts.currency ?? 'KRW'
  await B.a.postOffer({ side: aSide === 'buy' ? 'sell' : 'buy', currency, amountMinor: opts.bMinor ?? opts.aMinor, feePct: 1, methods: BOTH })
  await A.a.postOffer({ side: aSide, currency, amountMinor: opts.aMinor, feePct: 0, methods: BOTH })
  await until(w, () => matched(A, B) && matched(B, A) && settled(A), 5 * MIN, 'A and B match')
  await adv(w, 10_000)
  return { w, A, B }
}

export function matched(x: Peer, y: Peer): boolean {
  return x.state().matches.some((m) => m.contactId === y.pk)
}

export function groupOf(x: Peer, y: Peer): string {
  const c = x.state().contacts.find((k) => k.pubkey === y.pk)
  if (!c?.groupId) throw new Fail(`${x.name} has no contact ${y.name} with a room`)
  return c.groupId
}

type DoneRec = Extract<IlchonState['rooms'][string][number], { kind: 'done' }>

export function dones(x: Peer, y: Peer, mine?: boolean): DoneRec[] {
  return (x.state().rooms[y.pk] ?? []).filter((m): m is DoneRec => m.kind === 'done' && (mine === undefined || m.mine === mine))
}

export function markers(x: Peer, y: Peer): number {
  return (x.state().rooms[y.pk] ?? []).filter((m) => m.kind === 'matched').length
}

/** Wire messages A sent B of type t, parsed. */
export function sentMsgs(w: World, from: Peer, to: Peer, t: string): WireMessage[] {
  return sent(w, from, to, t).map((e) => JSON.parse(e.json) as WireMessage)
}

export async function rejectOf(p: Promise<unknown>): Promise<string> {
  try {
    await p
    return ''
  } catch (e) {
    return e instanceof Error ? e.message : String(e)
  }
}

// ---------------------------------------------------------------- trade: B-14

/**
 * Fixed stand-in rates. The trade checks give them to the peers' rate source
 * (PeerOpts.rates), so the engine's own state carries them: setTradeStep's internal
 * tradeView and the card's `over` / `fiatMinor` are computed with a rate.
 */
export const TRADE_RATES = { KRW: 150_000_000, USD: 100_000 }
