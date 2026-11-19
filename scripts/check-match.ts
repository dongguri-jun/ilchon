/**
 * Checks src/lib/match (matching v2: two slots per round, labels bound to the round).
 * Run: pnpm exec tsx scripts/check-match.ts. No network.
 *
 * M1 to M12; the yen cases are part of M1.
 */
import { ristretto255 } from '@noble/curves/ed25519.js'
import { base64urlnopad } from '@scure/base'
import { CURRENCIES, type Currency, type MatchLabels, type MatchPair, type PayMethod, type Side } from '../src/contracts'
import { randomId } from '../src/engine/util'
import { parseWireMessage } from '../src/lib/marmot/wire'
import { matchCrypto as mc } from '../src/lib/match/index'

const ALICE = 'a1'.repeat(32)
const BOB = 'b2'.repeat(32)
const EVE = 'e3'.repeat(32)
const CONTEXT = 'check-match/group-1'
const LN: PayMethod[] = ['lightning']
const OC: PayMethod[] = ['onchain']
const BOTH: PayMethod[] = ['lightning', 'onchain']
const SIDES: Side[] = ['sell', 'buy']

type Intent = { side: Side; currency: Currency; methods: PayMethod[] } | null

let failed = 0
function check(name: string, ok: boolean): void {
  if (!ok) failed++
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}`)
}

function throws(fn: () => unknown): boolean {
  try {
    fn()
    return false
  } catch {
    return true
  }
}

/** False when the call throws: a refused value is never a match. */
function falseOrThrows(fn: () => boolean): boolean {
  try {
    return fn() === false
  } catch {
    return true
  }
}

const hex = (b: Uint8Array) => Buffer.from(b).toString('hex')
const o = (side: Side, currency: Currency, methods: PayMethod[]): Intent => ({ side, currency, methods })

function labels(me: string, peer: string, initiator: string, sid: string, offer: Intent, context = CONTEXT): MatchLabels {
  return mc.labelsFor({ context, myPubkey: me, peerPubkey: peer, initiator, sid, offer })
}

interface Run {
  alice: boolean
  bob: boolean
  m1: string
  m2: string
  m3: string
  values: string[]
  secret: string
}

/** One honest round. Alice starts, Bob answers; both label with initiator ALICE and the same sid. */
function run(alice: Intent, bob: Intent, opts: { aliceCtx?: string; bobCtx?: string } = {}): Run {
  const sid = randomId()
  const la = labels(ALICE, BOB, ALICE, sid, alice, opts.aliceCtx)
  const lb = labels(BOB, ALICE, ALICE, sid, bob, opts.bobCtx)
  const r1 = mc.round1(la)
  const r2 = mc.round2(lb, r1.p)
  const r3 = mc.round3(r1.secret, r2.q, r2.pq)
  return {
    alice: r3.matched,
    bob: mc.finish(r2.pq, r3.qp),
    m1: JSON.stringify({ t: 'm1', sid, p: r1.p }),
    m2: JSON.stringify({ t: 'm2', sid, q: r2.q, pq: r2.pq }),
    m3: JSON.stringify({ t: 'm3', sid, qp: r3.qp }),
    values: [...r1.p, ...r2.q, ...r2.pq, ...r3.qp],
    secret: r1.secret,
  }
}

function expectBoth(name: string, alice: Intent, bob: Intent, want: boolean): void {
  const r = run(alice, bob)
  check(name, r.alice === want && r.bob === want)
}

const swap = (p: MatchPair): MatchPair => [p[1], p[0]]

// ---------------------------------------------------------------- M1 the match table

expectBoth('M1 sell KRW {LN} vs buy KRW {LN} matches on both ends', o('sell', 'KRW', LN), o('buy', 'KRW', LN), true)
expectBoth('M1 {LN,OC} vs {OC} matches (one method in common)', o('sell', 'KRW', BOTH), o('buy', 'KRW', OC), true)
expectBoth('M1 {LN,OC} vs {LN,OC} matches', o('sell', 'KRW', BOTH), o('buy', 'KRW', BOTH), true)
expectBoth('M1 {LN} vs {OC} does not match (no method in common)', o('sell', 'KRW', LN), o('buy', 'KRW', OC), false)
expectBoth('M1 {OC} vs {LN} does not match', o('buy', 'USD', OC), o('sell', 'USD', LN), false)
expectBoth('M1 same side {LN,OC} twice does not match', o('sell', 'KRW', BOTH), o('sell', 'KRW', BOTH), false)
expectBoth('M1 buy vs buy does not match', o('buy', 'USD', BOTH), o('buy', 'USD', BOTH), false)
expectBoth('M1 different currency does not match', o('sell', 'KRW', BOTH), o('buy', 'USD', BOTH), false)
expectBoth('M1 null on the initiator does not match', null, o('buy', 'KRW', BOTH), false)
expectBoth('M1 null on the responder does not match', o('sell', 'KRW', BOTH), null, false)
expectBoth('M1 null on both does not match', null, null, false)
{
  const r = run(o('sell', 'KRW', BOTH), o('buy', 'KRW', BOTH), { aliceCtx: 'ctx-a', bobCtx: 'ctx-b' })
  check('M1 different context does not match', !r.alice && !r.bob)
}
// The yen (moved here with {LN,OC}).
expectBoth('M1 sell JPY vs buy JPY matches on both ends', o('sell', 'JPY', BOTH), o('buy', 'JPY', BOTH), true)
expectBoth('M1 buy JPY vs sell JPY matches (the other side starts)', o('buy', 'JPY', BOTH), o('sell', 'JPY', BOTH), true)
expectBoth('M1 sell JPY vs sell JPY does not match', o('sell', 'JPY', BOTH), o('sell', 'JPY', BOTH), false)
for (const other of ['KRW', 'USD'] as const) {
  expectBoth(`M1 sell JPY vs buy ${other} does not match`, o('sell', 'JPY', BOTH), o('buy', other, BOTH), false)
  expectBoth(`M1 buy JPY vs sell ${other} does not match`, o('buy', 'JPY', BOTH), o('sell', other, BOTH), false)
  expectBoth(`M1 sell ${other} vs buy JPY does not match`, o('sell', other, BOTH), o('buy', 'JPY', BOTH), false)
}
{
  const sid = randomId()
  const of = (c: Currency) =>
    labels(ALICE, BOB, ALICE, sid, o('sell', c, BOTH))
      .map(hex)
      .join()
  const [krw, usd, jpy] = [of('KRW'), of('USD'), of('JPY')]
  check('M1 JPY, KRW and USD labels differ for the same pair, side and round', jpy !== krw && jpy !== usd && krw !== usd)
}

// ---------------------------------------------------------------- M2 labels

{
  const sid = randomId()
  const both = labels(ALICE, BOB, ALICE, sid, o('sell', 'KRW', BOTH))
  check(
    'M2 both labels are 32 bytes',
    both.every((l) => l.length === 32),
  )
  check('M2 {LN,OC}: the two slot labels differ', hex(both[0]) !== hex(both[1]))
  const candidates = (method: PayMethod) => SIDES.flatMap((side) => CURRENCIES.map((c) => hex(labels(ALICE, BOB, ALICE, sid, o(side, c, [method]))[method === 'lightning' ? 0 : 1])))
  const ocCandidates = candidates('onchain')
  const lnCandidates = candidates('lightning')
  check('M2 there are 6 on-chain candidates and 6 Lightning ones (side 2 x currency 3)', new Set(ocCandidates).size === 6 && new Set(lnCandidates).size === 6)
  const ln = labels(ALICE, BOB, ALICE, sid, o('sell', 'KRW', LN))
  check('M2 {LN}: slot 1 differs from every on-chain candidate of the round', !ocCandidates.includes(hex(ln[1])))
  check('M2 {LN}: slot 0 is the real Lightning label', hex(ln[0]) === hex(both[0]))
  const n1 = labels(ALICE, BOB, ALICE, sid, null)
  const n2 = labels(ALICE, BOB, ALICE, sid, null)
  const all12 = [...ocCandidates, ...lnCandidates]
  check(
    'M2 null: both slots differ from all 12 candidates',
    n1.every((l) => !all12.includes(hex(l))),
  )
  check('M2 null: two calls give different labels', hex(n1[0]) !== hex(n2[0]) && hex(n1[1]) !== hex(n2[1]))
}

// ---------------------------------------------------------------- M3 bound to the round

{
  const offer = o('sell', 'KRW', BOTH)
  const s1 = randomId()
  const s2 = randomId()
  const a = labels(ALICE, BOB, ALICE, s1, offer).map(hex).join()
  check('M3 another sid gives other labels', a !== labels(ALICE, BOB, ALICE, s2, offer).map(hex).join())
  check('M3 the peer as initiator gives other labels', a !== labels(ALICE, BOB, BOB, s1, offer).map(hex).join())
  const bobView = labels(BOB, ALICE, ALICE, s1, o('buy', 'KRW', BOTH))
    .map(hex)
    .join()
  check('M3 two honest sides (same initiator and sid) get the same labels', a === bobView)
  check(
    'M3 a third key as initiator throws',
    throws(() => labels(ALICE, BOB, EVE, s1, offer)),
  )
  check('M3 the initiator check ignores case', !throws(() => labels(ALICE, BOB, BOB.toUpperCase(), s1, offer)))
}

// ---------------------------------------------------------------- M4 reflection

{
  const bobOffer = o('sell', 'KRW', BOTH)
  const results: boolean[] = []
  for (const sameSid of [true, false]) {
    // Bob starts a round with sid S.
    const s = randomId()
    const r1 = mc.round1(labels(BOB, ALICE, BOB, s, bobOffer))
    // The attacker (Alice's key) sends Bob's own p back as its m1; Bob answers as responder.
    const s2 = sameSid ? s : randomId()
    const r2 = mc.round2(labels(BOB, ALICE, ALICE, s2, bobOffer), r1.p)
    // That answer goes back to Bob's round as its m2, Bob's m3 back as the attacker's m3.
    const r3 = mc.round3(r1.secret, r2.q, r2.pq)
    results.push(r3.matched, mc.finish(r2.pq, r3.qp))
  }
  check('M4 a reflected round never matches (same sid and another sid, both roles)', results.length === 4 && results.every((x) => !x))
  // The scene is a real attack: with labels that ignore the round (v1), it matches.
  const s = randomId()
  const roleless = labels(BOB, ALICE, BOB, s, bobOffer)
  const r1 = mc.round1(roleless)
  const r2 = mc.round2(roleless, r1.p)
  const r3 = mc.round3(r1.secret, r2.q, r2.pq)
  check('M4 the same scene with round-less labels (v1) does match: the check is not empty', r3.matched && mc.finish(r2.pq, r3.qp))
}

// ---------------------------------------------------------------- M5 slot swaps

{
  const alice = o('buy', 'KRW', OC)
  const bob = o('sell', 'KRW', BOTH)
  const sid = randomId()
  const la = labels(ALICE, BOB, ALICE, sid, alice)
  const lb = labels(BOB, ALICE, ALICE, sid, bob)
  const r1 = mc.round1(la)
  const r2 = mc.round2(lb, r1.p)
  const honest = mc.round3(r1.secret, r2.q, r2.pq)
  check('M5 (가) honest {OC} vs {LN,OC} matches', honest.matched && mc.finish(r2.pq, honest.qp))
  check(
    'M5 (나) Bob q and pq slots swapped into Alice round3: no match',
    falseOrThrows(() => mc.round3(r1.secret, swap(r2.q), swap(r2.pq)).matched),
  )
  check(
    'M5 (다) Alice qp slots swapped into Bob finish: no match',
    falseOrThrows(() => mc.finish(r2.pq, swap(honest.qp))),
  )
  const r2s = mc.round2(lb, swap(r1.p))
  const r3s = mc.round3(r1.secret, r2s.q, r2s.pq)
  check('M5 (라) Alice p slots swapped into Bob: no match on either side', !r3s.matched && !mc.finish(r2s.pq, r3s.qp))
}

// ---------------------------------------------------------------- M6 shape and length

{
  const intents: Intent[] = [null]
  for (const methods of [LN, OC, BOTH]) for (const side of SIDES) for (const c of CURRENCIES) intents.push(o(side, c, methods))
  let base: [number, number, number] | null = null
  let sameLen = true
  let valueShape = true
  let secretShape = true
  let runs = 0
  for (const a of intents) {
    for (const b of intents) {
      const r = run(a, b)
      runs++
      const lens: [number, number, number] = [r.m1.length, r.m2.length, r.m3.length]
      base ??= lens
      if (lens.some((n, i) => n !== base![i])) sameLen = false
      if (!r.values.every((v) => /^[A-Za-z0-9_-]{43}$/.test(v))) valueShape = false
      if (!/^[A-Za-z0-9_-]{86}$/.test(r.secret)) secretShape = false
    }
  }
  check(`M6 every slot value is 43-char base64url (${runs} pairs of offers)`, valueShape)
  check('M6 every secret is 86-char base64url', secretShape)
  check(`M6 m1, m2, m3 have the same JSON length in every pair (${base?.join(', ')})`, sameLen)
}

// ---------------------------------------------------------------- M7 what a non-matching contact sees

{
  const bob = o('sell', 'KRW', LN)
  const others: Intent[] = [null, o('buy', 'KRW', OC), o('sell', 'KRW', LN), o('buy', 'USD', BOTH), o('sell', 'KRW', BOTH)]
  const seen = new Set<string>()
  let repeats = 0
  let anyMatch = false
  for (const a of others) {
    for (let i = 0; i < 50; i++) {
      const r = run(a, bob)
      if (r.alice || r.bob) anyMatch = true
      for (const v of r.values) {
        if (seen.has(v)) repeats++
        seen.add(v)
      }
    }
  }
  check('M7 250 runs against non-matching offers: never a match', !anyMatch)
  check('M7 no slot value repeats across runs (fresh blinding)', repeats === 0)
  const one = run(o('buy', 'KRW', OC), bob).m2.length
  const two = run(o('buy', 'KRW', OC), o('sell', 'KRW', BOTH)).m2.length
  check(`M7 Bob's m2 has the same length with one method and with two (${one}, ${two})`, one === two)
}

// ---------------------------------------------------------------- M8 delete twin

{
  const alice = o('buy', 'KRW', LN)
  const cases: [string, Intent][] = [
    ['deleted (null)', null],
    ['sell KRW {OC} (only the method differs)', o('sell', 'KRW', OC)],
    ['buy KRW {LN} (same side)', o('buy', 'KRW', LN)],
  ]
  const lens = new Set<number>()
  let none = true
  for (const [, bob] of cases) {
    const r = run(alice, bob)
    if (r.alice || r.bob) none = false
    lens.add(r.m2.length)
  }
  check('M8 deleted, method-only and same-side: no match on either side', none)
  check("M8 Bob's m2 length is the same in the three cases", lens.size === 1)
}

// ---------------------------------------------------------------- M9 malformed values

{
  const sid = randomId()
  const la = labels(ALICE, BOB, ALICE, sid, o('sell', 'KRW', BOTH))
  const r1 = mc.round1(la)
  const r2 = mc.round2(la, r1.p)
  const r3 = mc.round3(r1.secret, r2.q, r2.pq)
  const identity = base64urlnopad.encode(ristretto255.Point.ZERO.toBytes())
  const nonCanonical = base64urlnopad.encode(new Uint8Array(32).fill(0xff))
  const short = base64urlnopad.encode(new Uint8Array(31).fill(1))
  const badPoints = [identity, nonCanonical, short, '', r1.p[0] + '=']
  const badConfirms = [short, '', r2.pq[0] + '=', base64urlnopad.encode(new Uint8Array(33))]
  const each = (pair: MatchPair, bad: string[], fn: (p: MatchPair) => unknown) => bad.every((x) => throws(() => fn([x, pair[1]])) && throws(() => fn([pair[0], x])))
  check(
    'M9 round2 throws when either p slot is bad',
    each(r1.p, badPoints, (p) => mc.round2(la, p)),
  )
  check(
    'M9 round3 throws when either q slot is bad',
    each(r2.q, badPoints, (q) => mc.round3(r1.secret, q, r2.pq)),
  )
  check(
    'M9 round3 throws when either commitment is bad',
    each(r2.pq, badConfirms, (pq) => mc.round3(r1.secret, r2.q, pq)),
  )
  check(
    'M9 finish throws when either qp slot is bad',
    each(r3.qp, badPoints, (qp) => mc.finish(r2.pq, qp)),
  )
  check(
    'M9 finish throws when either commitment is bad',
    each(r2.pq, badConfirms, (pq) => mc.finish(pq, r3.qp)),
  )
  const zero = new Uint8Array(64)
  const halfZero = base64urlnopad.decode(r1.secret).slice()
  halfZero.fill(0, 32)
  check(
    'M9 round3 throws on a bad secret (empty, 32 bytes, 65 bytes, all zero, one zero scalar)',
    ['', base64urlnopad.encode(new Uint8Array(32).fill(1)), base64urlnopad.encode(new Uint8Array(65).fill(1)), base64urlnopad.encode(zero), base64urlnopad.encode(halfZero)].every((sec) =>
      throws(() => mc.round3(sec, r2.q, r2.pq)),
    ),
  )
  check(
    'M9 a pair of one or three values throws',
    [() => mc.round2(la, [r1.p[0]] as unknown as MatchPair), () => mc.round2(la, [...r1.p, r1.p[0]] as unknown as MatchPair), () => mc.finish(r2.pq, [r3.qp[0]] as unknown as MatchPair)].every(throws),
  )
  check(
    'M9 identity on every slot cannot fake a match',
    falseOrThrows(() => mc.finish([identity, identity], [identity, identity])),
  )
}

// ---------------------------------------------------------------- M10 echo

{
  const sid = randomId()
  const la = labels(ALICE, BOB, ALICE, sid, o('sell', 'KRW', BOTH))
  const lb = labels(BOB, ALICE, ALICE, sid, o('sell', 'KRW', BOTH))
  const r1 = mc.round1(la)
  const r2 = mc.round2(lb, r1.p)
  check(
    'M10 finish(pq, pq) throws or is false',
    falseOrThrows(() => mc.finish(r2.pq, r2.pq)),
  )
  check(
    'M10 finish(pq, q) throws or is false',
    falseOrThrows(() => mc.finish(r2.pq, r2.q)),
  )
  // An arbitrary p the attacker made up, with any reply it can build from m2.
  const r2b = mc.round2(lb, mc.round1(labels(ALICE, BOB, ALICE, sid, null)).p)
  check('M10 arbitrary p plus an echo of m2 does not match', falseOrThrows(() => mc.finish(r2b.pq, r2b.pq)) && falseOrThrows(() => mc.finish(r2b.pq, r2b.q)))
}

// ---------------------------------------------------------------- M11 wire parsing

{
  const sid = randomId()
  const ok = (p: unknown, s: unknown = sid) => parseWireMessage(JSON.stringify({ t: 'm1', sid: s, p }))
  const pair = ['a'.repeat(43), 'b'.repeat(43)]
  check('M11 a well-formed m1 parses', ok(pair) !== null)
  check(
    'M11 m1 with p of length 1, 3, numbers or a string is dropped',
    [[pair[0]], [...pair, pair[0]], [1, 2], pair[0]].every((p) => ok(p) === null),
  )
  check(
    'M11 m1 with sid of 31, 33 chars, upper-case hex or "evsid1" is dropped',
    [sid.slice(1), sid + 'a', sid.toUpperCase(), 'evsid1'].every((s) => ok(pair, s) === null),
  )
  const m2 = (q: unknown, pq: unknown) => parseWireMessage(JSON.stringify({ t: 'm2', sid, q, pq }))
  check('M11 m2 needs two pairs', m2(pair, pair) !== null && m2(pair, pair[0]) === null && m2([pair[0]], pair) === null)
  check('M11 m3 needs a pair', parseWireMessage(JSON.stringify({ t: 'm3', sid, qp: pair })) !== null && parseWireMessage(JSON.stringify({ t: 'm3', sid, qp: 'x' })) === null)
  check('M11 mx needs a 32-hex sid', parseWireMessage(JSON.stringify({ t: 'mx', sid })) !== null && parseWireMessage(JSON.stringify({ t: 'mx', sid: 'evsid1' })) === null)
  const parsed = ok([...pair])
  check('M11 a parsed pair is rebuilt without extra fields', parsed?.t === 'm1' && Array.isArray(parsed.p) && parsed.p.length === 2)
  const offer = (methods: unknown) => parseWireMessage(JSON.stringify({ t: 'offer', offer: { side: 'sell', currency: 'KRW', amountMinor: 1000, feePct: 1, createdAt: 1, methods } }))
  const missing = parseWireMessage(JSON.stringify({ t: 'offer', offer: { side: 'sell', currency: 'KRW', amountMinor: 1000, feePct: 1, createdAt: 1 } }))
  check("M11 offer methods [], ['ln'] or missing is dropped", offer([]) === null && offer(['ln']) === null && missing === null)
  const dup = offer(['onchain', 'lightning', 'onchain'])
  check("M11 offer methods ['onchain','lightning','onchain'] become ['lightning','onchain']", dup?.t === 'offer' && dup.offer.methods.join() === 'lightning,onchain')
  const twice = offer(['lightning', 'lightning'])
  check("M11 offer methods ['lightning','lightning'] become ['lightning']", twice?.t === 'offer' && twice.offer.methods.join() === 'lightning')
}

// ---------------------------------------------------------------- M12 fresh blinding

{
  const la = labels(ALICE, BOB, ALICE, randomId(), o('sell', 'KRW', BOTH))
  const a = mc.round1(la)
  const b = mc.round1(la)
  check('M12 same labels give different p and secret each run', a.p[0] !== b.p[0] && a.p[1] !== b.p[1] && a.secret !== b.secret)
  const q1 = mc.round2(la, a.p)
  const q2 = mc.round2(la, a.p)
  check('M12 same labels give different q and pq each run', q1.q[0] !== q2.q[0] && q1.q[1] !== q2.q[1] && q1.pq[0] !== q2.pq[0] && q1.pq[1] !== q2.pq[1])
}

console.log(failed === 0 ? '\nALL PASS' : `\n${failed} FAILED`)
if (failed > 0) process.exitCode = 1
