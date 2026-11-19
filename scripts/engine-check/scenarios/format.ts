/**
 * Engine check scenarios: store format and reset retry (S-FORMAT).
 * Run from scripts/check-engine.ts, which lists every scenario in its order.
 */
import { STORE_FORMAT } from '../../../src/engine/index'
import { type HarnessKV, createHarnessKV } from '../../fake-transport'
import { expect } from '../report'
import { adoptKey, adv, finish, hasContact, link, makePeer, newWorld, restart } from '../world'

// ---------------------------------------------------------------- S-FORMAT

/** A new KV holding a copy of every key of `from`. */
function copyKV(from: HarnessKV): HarnessKV {
  const kv = createHarnessKV()
  for (const k of from.keys()) kv.seed(k, from.peek(k))
  return kv
}

export async function sFormat(): Promise<void> {
  const w = newWorld()
  // (a) An empty KV: a new install stores the format and goes on.
  const kvA = createHarnessKV()
  const A = makePeer(w, 'A', { kv: kvA, bare: true })
  await A.engine.start()
  adoptKey(A)
  expect(kvA.peek('format') === STORE_FORMAT, `(a) a new install stores the format (${String(kvA.peek('format'))})`)
  expect(A.resets.length === 0 && A.state().boot === 'ready', '(a) no wipe, ready')
  const B = makePeer(w, 'B')
  await B.engine.start()
  await link(w, A, B)
  await adv(w, 30_000)
  const contacts = kvA.peek<{ pubkey: string }[]>('contacts') ?? []
  expect(
    contacts.some((c) => c.pubkey === B.pk),
    '(a) A stored its contact',
  )

  // (b) The same data under another format: wiped without being read.
  const kvB = copyKV(kvA)
  kvB.seed('format', 0)
  const A2 = makePeer(w, 'A2', { kv: kvB, words: A.words })
  await A2.engine.start()
  expect(A2.resets.length === 1 && A2.resets[0].reason === 'format', `(b) one format wipe (${JSON.stringify(A2.resets)})`)
  expect(kvB.keys().length === 0, `(b) nothing is left in the KV (${kvB.keys().join(', ')})`)
  expect(A2.state().contacts.length === 0 && A2.state().boot !== 'ready', '(b) the engine read no contact and did not open')

  // (c) Data without any format: wiped the same way.
  const kvC = createHarnessKV()
  kvC.seed('contacts', contacts)
  const A3 = makePeer(w, 'A3', { kv: kvC, words: A.words, bare: true })
  await A3.engine.start()
  expect(A3.resets.length === 1 && A3.resets[0].reason === 'format', `(c) one format wipe (${JSON.stringify(A3.resets)})`)
  expect(kvC.keys().length === 0, `(c) nothing is left in the KV (${kvC.keys().join(', ')})`)
  expect(A3.state().contacts.length === 0 && A3.state().boot !== 'ready', '(c) the engine read no contact and did not open')

  // (d) The KV of (a) again: same format, nothing wiped.
  await restart(A)
  expect(A.resets.length === 0 && A.state().boot === 'ready', '(d) no wipe, ready')
  expect(hasContact(A, B), '(d) A keeps its contact')
  expect(kvA.peek('format') === STORE_FORMAT, '(d) the format is unchanged')

  // The reset the user asks for is reason 'user'.
  await A.a.resetAll()
  expect(A.resets.length === 1 && A.resets[0].reason === 'user', `a user reset says 'user' (${JSON.stringify(A.resets)})`)
  expect(kvA.keys().length === 0, 'a user reset leaves nothing in the KV')
  // A reset deletes the whole profile store, the Marmot state with it (src/lib/store).
  // The hub keeps a device's Marmot store apart from the engine KV and does not see the
  // reset, so its rooms are dropped here as the real reset drops them (INV-CH3 in finish).
  for (const g of w.hub.groupsOf(A.pk)) w.hub.loseGroup(A.pk, g)
  await finish(w)
}

// ---------------------------------------------------------------- reset retry and stores

/**
 * A format wipe at boot whose store deletion fails ends on the 'reset-failed' screen;
 * its retry button (actions.resetAll) must finish it as a format wipe, not as a reset
 * the user asked for (that one would drop the support log and may refuse without a
 * database list).
 */
export async function sFormatRetry(): Promise<void> {
  const w = newWorld()
  const A = makePeer(w, 'A')
  await A.engine.start()
  const kv = copyKV(A.kv)
  kv.seed('format', 0)
  const A2 = makePeer(w, 'A2', { kv, words: A.words, failResets: 1 })
  await A2.engine.start().catch(() => {})
  expect(A2.state().boot === 'error' && A2.state().bootError === 'reset-failed', `a failed format wipe ends in reset-failed (${A2.state().boot} ${A2.state().bootError})`)
  expect(A2.resets.length === 1 && A2.resets[0].reason === 'format', `(${JSON.stringify(A2.resets)})`)
  expect(
    A2.log.lines().some((l) => l.endsWith('engine  reset failed')),
    'the support log has the reset failed line',
  )
  await A2.a.resetAll()
  expect(A2.resets.length === 2 && A2.resets[1].reason === 'format', `the retry is a format wipe again (${JSON.stringify(A2.resets)})`)
  expect(kv.keys().length === 0, 'the retry left nothing in the KV')
  await finish(w)
}
