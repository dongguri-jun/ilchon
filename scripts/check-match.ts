/**
 * Checks src/lib/match. Run: pnpm exec tsx scripts/check-match.ts
 */
import { ristretto255 } from '@noble/curves/ed25519.js'
import { base64urlnopad } from '@scure/base'
import type { Currency, Side } from '../src/contracts'
import { matchCrypto as mc } from '../src/lib/match/index'

const ALICE = 'a1'.repeat(32)
const BOB = 'b2'.repeat(32)
const CONTEXT = 'check-match/group-1'

type Intent = { side: Side; currency: Currency } | null

/** Full four-message run. Alice initiates, Bob responds. */
function run(alice: Intent, bob: Intent): { alice: boolean; bob: boolean } {
  const la = mc.labelFor({ context: CONTEXT, myPubkey: ALICE, peerPubkey: BOB, offer: alice })
  const lb = mc.labelFor({ context: CONTEXT, myPubkey: BOB, peerPubkey: ALICE, offer: bob })
  const r1 = mc.round1(la)
  const r2 = mc.round2(lb, r1.p)
  const r3 = mc.round3(r1.secret, r2.q, r2.pq)
  return { alice: r3.matched, bob: mc.finish(r2.pq, r3.qp) }
}

let failed = 0
function check(name: string, ok: boolean): void {
  if (!ok) failed++
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}`)
}

function expectBoth(name: string, alice: Intent, bob: Intent, want: boolean): void {
  const r = run(alice, bob)
  check(name, r.alice === want && r.bob === want)
}

function throws(fn: () => unknown): boolean {
  try {
    fn()
    return false
  } catch {
    return true
  }
}

expectBoth('sell KRW vs buy KRW matches on both ends', { side: 'sell', currency: 'KRW' }, { side: 'buy', currency: 'KRW' }, true)
expectBoth('buy USD vs sell USD matches on both ends', { side: 'buy', currency: 'USD' }, { side: 'sell', currency: 'USD' }, true)
expectBoth('sell vs sell (same currency) does not match', { side: 'sell', currency: 'KRW' }, { side: 'sell', currency: 'KRW' }, false)
expectBoth('buy vs buy (same currency) does not match', { side: 'buy', currency: 'USD' }, { side: 'buy', currency: 'USD' }, false)
expectBoth('sell KRW vs buy USD does not match', { side: 'sell', currency: 'KRW' }, { side: 'buy', currency: 'USD' }, false)
expectBoth('null offer on initiator does not match', null, { side: 'buy', currency: 'KRW' }, false)
expectBoth('null offer on responder does not match', { side: 'sell', currency: 'KRW' }, null, false)
expectBoth('null offer on both does not match', null, null, false)

// Different context must not match even with opposite sides.
{
  const la = mc.labelFor({ context: 'ctx-a', myPubkey: ALICE, peerPubkey: BOB, offer: { side: 'sell', currency: 'KRW' } })
  const lb = mc.labelFor({ context: 'ctx-b', myPubkey: BOB, peerPubkey: ALICE, offer: { side: 'buy', currency: 'KRW' } })
  const r1 = mc.round1(la)
  const r2 = mc.round2(lb, r1.p)
  const r3 = mc.round3(r1.secret, r2.q, r2.pq)
  check('different context does not match', !r3.matched && !mc.finish(r2.pq, r3.qp))
}

// Malformed and identity points.
{
  const label = mc.labelFor({ context: CONTEXT, myPubkey: ALICE, peerPubkey: BOB, offer: { side: 'sell', currency: 'KRW' } })
  const r1 = mc.round1(label)
  const r2 = mc.round2(label, r1.p)
  const identity = base64urlnopad.encode(ristretto255.Point.ZERO.toBytes())
  const nonCanonical = base64urlnopad.encode(new Uint8Array(32).fill(0xff))
  const short = base64urlnopad.encode(new Uint8Array(31).fill(1))
  const bad = [identity, nonCanonical, short, '', 'not base64url!!', r1.p + '=']

  check('label is 32 bytes', label.length === 32)
  check('round2 rejects malformed/identity p', bad.every((x) => throws(() => mc.round2(label, x))))
  check('round3 rejects malformed/identity q', bad.every((x) => throws(() => mc.round3(r1.secret, x, r2.pq))))
  const badConfirm = [short, '', 'not base64url!!', r2.pq + '=', base64urlnopad.encode(new Uint8Array(33))]
  check('round3 rejects a malformed pq commitment', badConfirm.every((x) => throws(() => mc.round3(r1.secret, r2.q, x))))
  check('round3 rejects malformed secret', throws(() => mc.round3('', r2.q, r2.pq)) && throws(() => mc.round3(base64urlnopad.encode(new Uint8Array(32)), r2.q, r2.pq)))
  const r3 = mc.round3(r1.secret, r2.q, r2.pq)
  check(
    'finish rejects malformed commitments and malformed/identity points',
    badConfirm.every((x) => throws(() => mc.finish(x, r3.qp))) && bad.every((x) => throws(() => mc.finish(r2.pq, x))),
  )
  check('identity on both sides cannot fake a match', throws(() => mc.finish(identity, identity)))
}

// The responder's m2 must not let the initiator fake a match by echoing it back.
{
  const la = mc.labelFor({ context: CONTEXT, myPubkey: ALICE, peerPubkey: BOB, offer: { side: 'sell', currency: 'KRW' } })
  const lb = mc.labelFor({ context: CONTEXT, myPubkey: BOB, peerPubkey: ALICE, offer: { side: 'sell', currency: 'KRW' } })
  const r1 = mc.round1(la)
  const r2 = mc.round2(lb, r1.p)
  let echoed = false
  try {
    echoed = mc.finish(r2.pq, r2.pq)
  } catch {
    echoed = false
  }
  let echoedQ = false
  try {
    echoedQ = mc.finish(r2.pq, r2.q)
  } catch {
    echoedQ = false
  }
  check('echoing pq as qp must not match', !echoed && !echoedQ)
  // Same for an arbitrary p the attacker made up, with any reply it can build from m2.
  const r2b = mc.round2(lb, mc.round1(mc.labelFor({ context: CONTEXT, myPubkey: ALICE, peerPubkey: BOB, offer: null })).p)
  let fake = false
  try {
    fake = mc.finish(r2b.pq, r2b.pq) || mc.finish(r2b.pq, r2b.q)
  } catch {
    fake = false
  }
  check('arbitrary p plus an echo of m2 must not match', !fake)
}

// Fresh blinding every run.
{
  const label = mc.labelFor({ context: CONTEXT, myPubkey: ALICE, peerPubkey: BOB, offer: { side: 'sell', currency: 'KRW' } })
  const a = mc.round1(label)
  const b = mc.round1(label)
  check('same label gives different p each run', a.p !== b.p && a.secret !== b.secret)
  const q1 = mc.round2(label, a.p)
  const q2 = mc.round2(label, a.p)
  check('same label gives different q each run', q1.q !== q2.q && q1.pq !== q2.pq)
  check('points and commitment are unpadded base64url', [a.p, q1.q, q1.pq].every((x) => /^[A-Za-z0-9_-]{43}$/.test(x)))
}

console.log(failed === 0 ? '\nALL PASS' : `\n${failed} FAILED`)
if (failed > 0) process.exitCode = 1
