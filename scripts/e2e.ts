/**
 * End-to-end run of the demo scenario: three engines in one Node process,
 * real modules, real relays, fresh throwaway keys, nothing persisted.
 *
 *   pnpm exec tsx scripts/e2e.ts            # E2E_DEBUG=1 prints engine events
 *
 * A is connected to B and to C. B and C do not know each other.
 */
import { DEFAULT_RELAYS, type ConnectModule, type IlchonState, type KV, type MarmotModule } from '../src/contracts'
import { createEngine, type IlchonEngine } from '../src/engine/index'
// --- real modules (the only lines a dry run with fakes replaces) ---
import * as connectModule from '../src/lib/connect'
import { createMemoryKV } from '../src/lib/kv'
import * as marmotModule from '../src/lib/marmot'
import { matchCrypto } from '../src/lib/match'
import { createRatesSource } from '../src/lib/rates'
// --- end real modules ---

const marmot: MarmotModule = marmotModule
const connect: ConnectModule = connectModule

const DEBUG = process.env.E2E_DEBUG === '1'
const RELAYS = process.env.E2E_RELAYS ? process.env.E2E_RELAYS.split(',') : DEFAULT_RELAYS

const BOOT_MS = 90_000
const LINK_MS = 110_000
const ROUND_MS = 60_000
/** Longer than the demo answer window plus one retry, so a late match would show up. */
const SETTLE_MS = 30_000

interface Peer {
  name: string
  kv: KV
  engine: IlchonEngine
  state(): IlchonState
  pk(): string
}

function makePeer(name: string): Peer {
  const kv = createMemoryKV()
  const engine = createEngine(
    {
      kv,
      marmot,
      match: matchCrypto,
      connect,
      rates: createRatesSource(),
      relays: RELAYS,
      namespace: `e2e:${name}`,
      persistence: 'memory',
    },
    {
      defaultLang: 'en',
      debug: DEBUG ? (event, info) => console.log(`    [${name}] ${event}`, info ? JSON.stringify(info) : '') : undefined,
    },
  )
  return {
    name,
    kv,
    engine,
    state: () => engine.store.getState(),
    pk: () => engine.store.getState().me?.pubkey ?? '',
  }
}

// ---------------------------------------------------------------- reporting

let failures = 0
const t0 = Date.now()

function check(name: string, ok: boolean, startedAt: number, detail = ''): boolean {
  if (!ok) failures++
  const ms = Date.now() - startedAt
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}  (${ms} ms)${detail ? `  ${detail}` : ''}`)
  return ok
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

async function waitFor(pred: () => boolean, timeoutMs: number): Promise<boolean> {
  const end = Date.now() + timeoutMs
  for (;;) {
    if (pred()) return true
    if (Date.now() >= end) return false
    await sleep(150)
  }
}

function ids(s: IlchonState): string {
  return s.matches.map((m) => m.contactId.slice(0, 8)).join(',') || '-'
}

/** True when `test` holds for any value nested anywhere inside `value`. */
function anywhere(value: unknown, test: (v: unknown) => boolean): boolean {
  if (test(value)) return true
  if (Array.isArray(value)) return value.some((v) => anywhere(v, test))
  if (typeof value === 'object' && value !== null) return Object.values(value).some((v) => anywhere(v, test))
  return false
}

async function dumpKV(kv: KV): Promise<Record<string, unknown>> {
  const out: Record<string, unknown> = {}
  for (const key of await kv.keys()) {
    if (key === 'sk') continue
    out[key] = await kv.get<unknown>(key)
  }
  return out
}

// ---------------------------------------------------------------- steps

async function connectPair(x: Peer, y: Peer, order: 'inviter-first' | 'invitee-first'): Promise<boolean> {
  const started = Date.now()
  const label = `connect ${x.name}-${y.name} (${order})`
  x.engine.actions.startConnect()
  y.engine.actions.startConnect()
  const payload = new Map<Peer, string>([
    [x, x.state().connect.myPayload ?? ''],
    [y, y.state().connect.myPayload ?? ''],
  ])
  const [inviter, invitee] = x.pk() < y.pk() ? [x, y] : [y, x]
  const [first, second] = order === 'inviter-first' ? [inviter, invitee] : [invitee, inviter]

  await first.engine.actions.submitScan(payload.get(second) ?? '')
  // inviter-first: give the Welcome time to arrive before the invitee scans,
  // so the buffered-invite path is the one that runs.
  await sleep(order === 'inviter-first' ? 5000 : 1000)
  await second.engine.actions.submitScan(payload.get(first) ?? '')

  const phases = () => [x.state().connect, y.state().connect]
  await waitFor(() => phases().every((c) => c.phase === 'done') || phases().some((c) => c.phase === 'failed'), LINK_MS)
  const [cx, cy] = phases()
  const done = check(
    `${label}: both reach phase done`,
    cx.phase === 'done' && cy.phase === 'done',
    started,
    `${x.name}=${cx.phase}${cx.errorKey ? `/${cx.errorKey}` : ''} ${y.name}=${cy.phase}${cy.errorKey ? `/${cy.errorKey}` : ''}`,
  )
  const xHasY = x.state().contacts.some((c) => c.pubkey === y.pk())
  const yHasX = y.state().contacts.some((c) => c.pubkey === x.pk())
  check(`${label}: contact exists on both sides`, xHasY && yHasX, started)
  x.engine.actions.cancelConnect()
  y.engine.actions.cancelConnect()
  return done && xHasY && yHasX
}

/** Wait until every round of the peer's current offer was answered or refused. */
function roundsSettled(p: Peer): boolean {
  const { asked, answered } = p.state().matchProgress
  return asked > 0 && answered >= asked
}

async function main(): Promise<void> {
  const A = makePeer('A')
  const B = makePeer('B')
  const C = makePeer('C')
  const peers = [A, B, C]

  // ---- boot
  let started = Date.now()
  const boots = await Promise.allSettled(
    peers.map((p) =>
      Promise.race([
        p.engine.start(),
        sleep(BOOT_MS).then(() => {
          throw new Error('boot timeout')
        }),
      ]),
    ),
  )
  const bootOk = check(
    'A, B, C boot against real relays',
    peers.every((p) => p.state().boot === 'ready' && p.pk().length === 64),
    started,
    boots.map((b, i) => `${peers[i].name}=${b.status === 'fulfilled' ? 'ready' : String(b.reason)}`).join(' '),
  )
  if (!bootOk) return

  // ---- connect: one pair per path
  const ab = await connectPair(A, B, 'inviter-first')
  const ac = await connectPair(A, C, 'invitee-first')
  check('B and C are not contacts of each other', !B.state().contacts.some((c) => c.pubkey === C.pk()) && !C.state().contacts.some((c) => c.pubkey === B.pk()), Date.now())
  if (!ab || !ac) return

  // ---- B sells, C buys, A has nothing: A must see nothing
  started = Date.now()
  await B.engine.actions.postOffer({ side: 'sell', currency: 'KRW', amount: 90000, feePct: 3 })
  await C.engine.actions.postOffer({ side: 'buy', currency: 'KRW', amount: 50000, feePct: 1 })
  const answeredBoth = await waitFor(() => roundsSettled(B) && roundsSettled(C), ROUND_MS)
  check('A answers the rounds of B and C', answeredBoth, started)
  await sleep(2000)
  check('A sees no matches while it has no offer', A.state().matches.length === 0, started, `A.matches=${ids(A.state())}`)
  check('B and C see no matches either', B.state().matches.length === 0 && C.state().matches.length === 0, started)

  // ---- A buys: only B appears
  started = Date.now()
  await A.engine.actions.postOffer({ side: 'buy', currency: 'KRW', amount: 100000, feePct: 1 })
  const aOfferId = A.state().myOffer?.id ?? ''
  await waitFor(() => A.state().matches.length > 0 && B.state().matches.length > 0 && roundsSettled(A), ROUND_MS)
  const am = A.state().matches
  check(
    'A.matches is exactly [B] with amount 90000',
    am.length === 1 && am[0].contactId === B.pk() && am[0].offer.amount === 90000 && am[0].offer.side === 'sell',
    started,
    `A.matches=${ids(A.state())}`,
  )
  const bm = B.state().matches
  check(
    'B.matches is exactly [A] with amount 100000',
    bm.length === 1 && bm[0].contactId === A.pk() && bm[0].offer.amount === 100000,
    started,
    `B.matches=${ids(B.state())}`,
  )
  // C finishes its side of the round when A's third message arrives.
  await waitFor(() => roundsSettled(A), ROUND_MS)
  await sleep(4000)
  check('C.matches is empty', C.state().matches.length === 0, started, `C.matches=${ids(C.state())}`)
  // Rates are public market data; a round BTC price must not look like a leak.
  const cDump = { kv: await dumpKV(C.kv), state: { ...C.state(), rates: null } }
  const leaksOffer = anywhere(cDump, (v) => v === 100000 || (aOfferId !== '' && v === aOfferId))
  const cResp = (await C.kv.get<Record<string, unknown>>('resp')) ?? {}
  const cVerified = (await C.kv.get<Record<string, unknown>>('verified')) ?? {}
  check("C's state and KV hold nothing about A's offer", !leaksOffer, started)
  check(
    'C keeps no round session and no verified match for A',
    Object.keys(cResp).length === 0 && !(A.pk() in cVerified),
    started,
    `sessions=${Object.keys(cResp).length}`,
  )

  // ---- chat A -> B
  started = Date.now()
  const hello = `e2e ${Date.now()}`
  await A.engine.actions.sendChat(B.pk(), hello)
  const got = await waitFor(
    () => (B.state().rooms[A.pk()] ?? []).some((m) => m.kind === 'text' && !m.mine && m.text === hello),
    ROUND_MS,
  )
  check('B receives the chat from A', got, started)
  check('C has no room traffic from A', (C.state().rooms[A.pk()] ?? []).length === 0, started)

  // ---- A switches to USD: B must lose A
  started = Date.now()
  await A.engine.actions.postOffer({ side: 'buy', currency: 'USD', amount: 100, feePct: 1 })
  const lost = await waitFor(() => B.state().matches.length === 0, ROUND_MS)
  check('B loses A after A changes to buy USD', lost, started, `B.matches=${ids(B.state())}`)
  await waitFor(() => roundsSettled(A), ROUND_MS)
  check('A has no matches for buy USD', A.state().matches.length === 0, started, `A.matches=${ids(A.state())}`)

  // ---- B deletes A, A posts buy KRW again: no match, no error
  started = Date.now()
  await B.engine.actions.deleteContact(A.pk())
  check('B no longer lists A', !B.state().contacts.some((c) => c.pubkey === A.pk()), started)
  let postError = ''
  try {
    await A.engine.actions.postOffer({ side: 'buy', currency: 'KRW', amount: 100000, feePct: 1 })
  } catch (e) {
    postError = e instanceof Error ? e.message : String(e)
  }
  await waitFor(() => roundsSettled(A), ROUND_MS)
  await sleep(SETTLE_MS)
  check('A posts again without error', postError === '' && A.state().boot === 'ready', started, postError)
  check('A gets no match from the contact that deleted it', A.state().matches.length === 0, started, `A.matches=${ids(A.state())}`)
  check('B shows nothing from A', B.state().matches.length === 0 && B.state().rooms[A.pk()] === undefined, started)
  check('A still lists B (the delete is invisible)', A.state().contacts.some((c) => c.pubkey === B.pk()), started)

  await Promise.allSettled(peers.map((p) => p.engine.stop()))
}

process.on('unhandledRejection', (e) => {
  failures++
  console.log(`FAIL  unhandled rejection: ${e instanceof Error ? e.message : String(e)}`)
})

main()
  .catch((e: unknown) => {
    failures++
    console.log(`FAIL  scenario crashed: ${e instanceof Error ? (e.stack ?? e.message) : String(e)}`)
  })
  .finally(() => {
    console.log(`\n${failures === 0 ? 'ALL PASS' : `${failures} FAILED`}  (total ${Date.now() - t0} ms)`)
    process.exit(failures === 0 ? 0 : 1)
  })
