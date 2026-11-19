/**
 * Secret markers that must never show where they do not belong: the offer amount
 * 43219 (KRW, five digits), the fee 2.75, the chat text and the name a peer gives its
 * contact. Numbers are searched bare, whatever field (or array, or later field name)
 * holds them, but not inside a run of hex: a dump is full of random 64-digit hex in
 * which 43219 turns up by chance, and there it has a hex character on each side.
 * Texts carry letters no hex string has (ZQ-LEAK).
 */
import type { Peer } from './world'

export const AMOUNT = 43219
export const FEE = 2.75
/** S-DONE-USD's completions in cents (205 offered, 100 done, 105 left) and as shown ($2.05, $1.05). */
export const DONE_NUMBERS = [205, 105, 100, 2.05, 1.05]
export const CHAT = 'secret-chat-7f3a ZQ-LEAK-대화'
/** The name A gives its contact B (a local field; it must never travel). */
export const NAME = 'ZQ-LEAK-이름'

/**
 * Every key of the peer's KV (whatever keys later steps add), its stored received-message
 * inbox (the transport's table in the real app) and its state, as JSON, for
 * searching leaked values. Rates are public data.
 */
export function dumpOf(p: Peer): string {
  const kv: Record<string, unknown> = {}
  for (const k of p.kv.keys()) kv[k] = p.kv.peek(k)
  return JSON.stringify({ kv, inbox: p.world.hub.inboxEntries(p.pk), state: { ...p.state(), rates: null } })
}

/**
 * The number written out anywhere (any field, array item or plain text), but not as a
 * piece of a longer run of hex characters or digits: random hex holds 43219 by chance,
 * always with a hex character next to it.
 */
export function holdsNumber(dump: string, n: number): boolean {
  const lit = String(n).replace('.', '\\.')
  return new RegExp(`(?<![0-9a-fA-F.])${lit}(?![0-9a-fA-F])`).test(dump)
}
