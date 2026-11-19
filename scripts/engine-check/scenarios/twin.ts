/**
 * Engine check scenarios: the twin worlds (S-TWIN).
 * Run from scripts/check-engine.ts, which lists every scenario in its order.
 */
import { type TwinScript, twin } from '../helpers/twin'
import { expect } from '../report'
import { MIN, finish, restart, sent } from '../world'

export async function sTwin(aLow: boolean): Promise<void> {
  const t0 = 0
  const script: TwinScript = {
    b: [
      // B picks one method only: the slots it leaves out are random too.
      { atMs: t0, act: (p) => p.a.postOffer({ side: 'sell', currency: 'KRW', amountMinor: 90000, feePct: 3, methods: ['onchain'] }) },
      // Past the 15 s round deadline twice before the next change.
      { atMs: 40_000, act: (p) => p.a.postOffer({ side: 'buy', currency: 'KRW', amountMinor: 90000, feePct: 3, methods: ['onchain'] }) },
      { atMs: 80_000, act: (p) => p.a.postOffer({ side: 'buy', currency: 'USD', amountMinor: 10_000, feePct: 3, methods: ['onchain'] }) },
      { atMs: 120_000, act: (p) => p.a.withdrawOffer() },
      { atMs: 130_000, act: (p) => p.a.sendChat(p.world.peers[0].pk, 'one') },
      { atMs: 140_000, act: (p) => p.a.sendChat(p.world.peers[0].pk, 'two') },
      { atMs: 150_000, act: (p) => restart(p) },
      { atMs: 150_000 + 60 * MIN, act: async () => {} },
    ],
    a: [
      { atMs: 10 * MIN, act: async (p) => p.engine.rearmRounds() },
      { atMs: 20 * MIN, act: (p) => restart(p) },
      { atMs: 40 * MIN, act: async (p) => p.engine.rearmRounds() },
    ],
  }
  const r = await twin(script, { aLow })
  const [s1, s2] = r.seqs
  const firstDiff = s1.findIndex((x, i) => x !== s2[i])
  expect(
    s1.length === s2.length && firstDiff < 0,
    `A→B envelopes differ between the worlds (world 1: ${s1.length}, world 2: ${s2.length}, first difference at ${firstDiff}: ${s1[firstDiff]} / ${s2[firstDiff]})`,
  )
  for (let i = 0; i < 2; i++) {
    const w = r.worlds[i]
    const after = sent(w, r.a[i], r.b[i]).filter((e) => e.t === 'offer' || (e.t === 'chat' && JSON.parse(e.json).text !== 'hi'))
    expect(after.length === 0, `world ${i + 1}: no offer or chat from A to B`)
  }
  for (const w of r.worlds) await finish(w)
}

/**
 * S-TWIN-CONFIRM: the inviter A still holds its confirmation for B (B sent
 * nothing yet) when the worlds split. A restarts: the confirmation goes again, whether A
 * deleted B or not, at the same moment and with the same size.
 */
export async function sTwinConfirm(): Promise<void> {
  const script: TwinScript = {
    b: [{ atMs: 20 * MIN, act: async () => {} }],
    a: [{ atMs: 10 * MIN, act: (p) => restart(p) }],
  }
  const r = await twin(script, { aLow: true, quietB: true })
  const [s1, s2] = r.seqs
  const firstDiff = s1.findIndex((x, i) => x !== s2[i])
  expect(s1.length === s2.length && firstDiff < 0, `A→B envelopes differ (world 1: ${s1.length}, world 2: ${s2.length}, first at ${firstDiff}: ${s1[firstDiff]} / ${s2[firstDiff]})`)
  for (let i = 0; i < 2; i++) {
    const w = r.worlds[i]
    const again = sent(w, r.a[i], r.b[i], 'hello').filter((e) => e.atMs >= w.clock.now() - 11 * MIN)
    expect(again.length >= 1, `world ${i + 1}: A sent its confirmation again after the restart`)
  }
  for (const w of r.worlds) await finish(w)
}
