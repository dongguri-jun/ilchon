/**
 * Shared engine check helpers of the payment-match scenarios.
 */
import type { ChatMessage, IlchonActions } from '../../../src/contracts'
import { expect } from '../report'
import { MIN, type Peer, type World, until } from '../world'
import { rejectOf } from './trade'

// ---------------------------------------------------------------- PM-7, PM-8 and the receive checks

/** Mainnet addresses of BIP-173 and BIP-350 (p2wpkh, p2wsh, p2tr). */
export const ADDR_WPKH = 'bc1qw508d6qejxtdg4y5r3zarvary0c5xw7kv8f3t4'
export const ADDR_TR = 'bc1p0xlxvlhemja6c4dqv22uapctqupfhlxm9h8z3k2e72q4k9hcz7vqzk5jj0'
export const LN_ADDRESS = 'alice@example.com'

export type PayReq = Parameters<IlchonActions['sendPaymentRequest']>[1]

/** My texts in x's room of y, oldest first. */
export function myTexts(x: Peer, y: Peer): Extract<ChatMessage, { kind: 'text' }>[] {
  return (x.state().rooms[y.pk] ?? []).filter((m): m is Extract<ChatMessage, { kind: 'text' }> => m.kind === 'text' && m.mine)
}

/** A request that goes: one new text of A's in B's room, its support log unchanged. Returns the text. */
export async function sendsOne(w: World, A: Peer, B: Peer, req: PayReq, what: string): Promise<string> {
  const before = myTexts(A, B).length
  const log = A.log.lines().join('\n')
  const err = await rejectOf(A.a.sendPaymentRequest(B.pk, req))
  expect(err === '', `${what}: sent (${err})`)
  const mine = myTexts(A, B)
  expect(mine.length === before + 1, `${what}: one new text in A's room (${mine.length - before})`)
  const last = mine[mine.length - 1]
  await until(w, () => (B.state().rooms[A.pk] ?? []).some((m) => m.kind === 'text' && !m.mine && m.id === last.id), MIN, `${what}: B gets it`)
  expect(A.log.lines().join('\n') === log, `${what}: the support log is unchanged`)
  return last.text
}
