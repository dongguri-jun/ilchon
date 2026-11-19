/**
 * End-to-end run of the demo scenario: three engines in one Node process,
 * real modules, real relays, fresh throwaway keys, nothing persisted.
 *
 *   pnpm exec tsx scripts/e2e.ts            # E2E_DEBUG=1 prints engine events
 *
 * A is connected to B and to C. B and C do not know each other.
 * D and E chose relays of their own that are all dead: D switches
 * to the default relays and connects to A; E turned switching off and keeps waiting.
 *
 * E2E_RELAYS=wss://a,wss://b replaces the default relays. Local addresses do not work
 * there: a ws:// url, localhost, an IP address or a private host name fails the check
 * every app makes before joining a room (src/lib/marmot/guard.ts roomShapeOk),
 * so no invite is ever joined and every link times out. Use public wss:// relays.
 */
import { DEFAULT_RELAYS, LIST_RELAYS, type ChatMessage, type ConnectModule, type IlchonState, type IncomingMessage, type KV, type MarmotModule, type PayMethod, type Transport } from '../src/contracts'
import { createEngine, type IlchonEngine } from '../src/engine/index'
import { tradeView } from '../src/engine/trade'
// --- real modules (the only lines a dry run with fakes replaces) ---
import * as connectModule from '../src/lib/connect'
import * as marmotModule from '../src/lib/marmot'
import { matchCrypto } from '../src/lib/match'
import { createRatesSource } from '../src/lib/rates'
// --- end real modules ---
import { sha256 } from '@noble/hashes/sha2.js'
import { bech32 } from '@scure/base'
import { createLnurl } from '../src/lib/lnurl'
import { payRefOf } from '../src/lib/pay'
import { buildInvoice, tagged } from './invoice-fixture'
import { npubOf } from '../src/lib/marmot/keys'
import { peerRelayUrl } from '../src/lib/marmot/guard'
import { createSupportLog, watchEngine, type SupportLog } from '../src/lib/support-log/index'
import { memoryBackend, type MemoryBackend } from '../src/lib/store/backend'
import { nodeStorage, plainTextIn } from './node-storage'

const marmot: MarmotModule = marmotModule
const connect: ConnectModule = connectModule

/** Both payment methods: every offer here posts them unless a step says otherwise. */
const BOTH: PayMethod[] = ['lightning', 'onchain']
const LN_ONLY: PayMethod[] = ['lightning']
const OC_ONLY: PayMethod[] = ['onchain']

/**
 * The buyer's wallet service for the receive steps: the real lookup
 * module (src/lib/lnurl) over a fetch that answers in this process, so no request leaves
 * it and nothing is paid. It serves LUD-16 for `buyer@wallet.example` and hands out a
 * hand-built mainnet invoice (scripts/invoice-fixture.ts) for exactly the msat asked.
 */
const WALLET_ADDRESS = 'buyer@wallet.example'
const WALLET_METADATA = JSON.stringify([['text/plain', 'e2e receive']])
const walletCalls: string[] = []
const walletFetch: typeof fetch = async (input) => {
  const url = new URL(String(input))
  walletCalls.push(url.origin + url.pathname)
  const json = (body: unknown) => new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } })
  if (url.href === 'https://wallet.example/.well-known/lnurlp/buyer') {
    return json({ tag: 'payRequest', callback: 'https://pay.wallet.example/cb', minSendable: 1000, maxSendable: 1_000_000_000_000, metadata: WALLET_METADATA })
  }
  if (url.origin + url.pathname === 'https://pay.wallet.example/cb') {
    const msat = Number(url.searchParams.get('amount'))
    if (!Number.isSafeInteger(msat) || msat % 1000 !== 0) return json({ status: 'ERROR', reason: 'amount' })
    const h = tagged(23, bech32.toWords(sha256(new TextEncoder().encode(WALLET_METADATA))))
    return json({ pr: buildInvoice(`lnbc${(msat / 1000) * 10}n`, Math.floor(Date.now() / 1000), [h]) })
  }
  return new Response('not found', { status: 404 })
}

const DEBUG = process.env.E2E_DEBUG === '1'
const RELAYS = process.env.E2E_RELAYS ? process.env.E2E_RELAYS.split(',') : DEFAULT_RELAYS
/** The contact list relays of the recovery step; E2E_LIST_RELAYS replaces them. */
const LIST_RELAYS_E2E = process.env.E2E_LIST_RELAYS ? process.env.E2E_LIST_RELAYS.split(',') : LIST_RELAYS
/** Relays of E2E_RELAYS a room may not name (the pre-join check refuses such a room). */
const LOCAL_RELAYS = RELAYS.filter((url) => peerRelayUrl(url) === null)
const LOCAL_HINT = LOCAL_RELAYS.length
  ? ` (E2E_RELAYS has ${LOCAL_RELAYS.join(', ')}: ws://, localhost, IP addresses and private hosts fail the pre-join room check, so links cannot complete; use public wss:// relays)`
  : ''
if (LOCAL_HINT) console.log(`NOTE${LOCAL_HINT}`)

/**
 * The holders' pairing window and deadline here (default 5 minutes): long enough for
 * real relays, short enough for a run. The holder scan lives 2x + 1 minute.
 */
const HOLDER_PAIR_MS = 60_000
const BOOT_MS = 90_000
const LINK_MS = 110_000
const ROUND_MS = 60_000
/** Longer than the demo answer window plus one retry, so a late match would show up. */
const SETTLE_MS = 15_000

interface Peer {
  name: string
  /** The engine's KV, through the encrypted store (open once the engine started). */
  readonly kv: KV
  /** What the store keeps at rest: only ciphertext. */
  backend: MemoryBackend
  engine: IlchonEngine
  /** Fed as src/engine/browser.ts feeds the app's support log. */
  log: SupportLog
  state(): IlchonState
  pk(): string
  /** Stored received-message inbox entries now (the transport's table). */
  inboxKeys(): Promise<string[]>
}

/**
 * The real marmot module whose transports can be told to reject the callback of the next
 * chat (as a failed write or a stop would): the message must stay in the inbox (delivery
 * "e2e", the Proxy way of check-link-late.ts).
 */
function rejectingMarmot(): { module: MarmotModule; armNextChat(): void; rejected(): number } {
  let armed = false
  let rejected = 0
  const module: MarmotModule = {
    ...marmotModule,
    createTransport(opts) {
      const inner: Transport = marmotModule.createTransport(opts)
      return new Proxy(inner, {
        get(target, prop, receiver) {
          if (prop !== 'onMessage') {
            const value = Reflect.get(target, prop, receiver)
            return typeof value === 'function' ? value.bind(target) : value
          }
          return (cb: (m: IncomingMessage) => void | Promise<void>) =>
            target.onMessage((m) => {
              if (armed && m.msg.t === 'chat') {
                armed = false
                rejected++
                return Promise.reject(new Error('persist'))
              }
              return cb(m)
            })
        },
      })
    },
  }
  return { module, armNextChat: () => void (armed = true), rejected: () => rejected }
}

/**
 * The real marmot module, keeping the last transport it made: the reopen step makes that
 * device lose one room, as a lost or broken room on a phone would.
 */
function capturingMarmot(): { module: MarmotModule; transport(): Transport | null } {
  let last: Transport | null = null
  const module: MarmotModule = {
    ...marmotModule,
    createTransport(opts) {
      last = marmotModule.createTransport(opts)
      return last
    },
  }
  return { module, transport: () => last }
}

const t0 = Date.now()

/**
 * The support log of the real transport: its warnings of all three engines (one process,
 * one sink), as src/engine/browser.ts passes them with setLogSink.
 */
const transportLog = createSupportLog({})
marmotModule.setLogSink((phrase, values) => transportLog.marmot(phrase, values))

/** Values that point at a person or a trade; none may appear in any support log. */
const secrets: { what: string; value: string }[] = []
function secret(what: string, value: string): void {
  if (value) secrets.push({ what, value })
}

function makePeer(name: string, opts: { backend?: MemoryBackend; marmot?: MarmotModule; listRelays?: string[]; setup?: boolean } = {}): Peer {
  const log = createSupportLog({})
  const store = nodeStorage(`e2e:${name}`, opts.backend ?? memoryBackend())
  const engine = createEngine(
    {
      storage: store.storage,
      marmot: opts.marmot ?? marmot,
      match: matchCrypto,
      connect,
      rates: createRatesSource(),
      lnurl: createLnurl({ fetch: walletFetch }),
      relays: RELAYS,
      ...(opts.listRelays ? { listRelays: opts.listRelays } : {}),
      namespace: `e2e:${name}`,
      persistence: 'memory',
      // setup: an empty profile stops in 'setup' (the recovery step restores from 12 words).
      autoIdentity: !opts.setup,
      tuning: { holderPairMs: HOLDER_PAIR_MS },
    },
    {
      defaultLang: 'en',
      debug(event, info) {
        log.engine(event, info)
        if (DEBUG) console.log(`    [${name}] ${event}`, info ? JSON.stringify(info) : '')
      },
    },
  )
  watchEngine(log, engine.store, () => Date.now() - t0)
  return {
    name,
    get kv() {
      return store.kv()
    },
    backend: store.backend,
    engine,
    log,
    state: () => engine.store.getState(),
    pk: () => engine.store.getState().me?.pubkey ?? '',
    inboxKeys: () => store.tables().table('inbox').keys(),
  }
}

/**
 * A peer whose stored profile (lock 'none', a fresh identity) already holds these
 * settings, as a user who chose relays in Settings → Advanced and reopened the app.
 */
async function makeSeededPeer(name: string, settings: Record<string, unknown>): Promise<Peer> {
  const backend = memoryBackend()
  await nodeStorage(`e2e:${name}`, backend).storage.create({ method: 'none' }, async (t) => {
    await t.kv.set('identity', { v: 1, sk: marmotModule.generateSecretKeyHex() })
    await t.kv.set('settings', settings)
  })
  return makePeer(name, { backend })
}

// ---------------------------------------------------------------- reporting

let failures = 0

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
  for (const v of payload.values()) secret('connection code', v)
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
    `${x.name}=${cx.phase}${cx.errorKey ? `/${cx.errorKey}` : ''} ${y.name}=${cy.phase}${cy.errorKey ? `/${cy.errorKey}` : ''}${LOCAL_HINT}`,
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
  let A = makePeer('A')
  const bMarmot = rejectingMarmot()
  let B = makePeer('B', { marmot: bMarmot.module })
  const cMarmot = capturingMarmot()
  const C = makePeer('C', { marmot: cMarmot.module })
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
  // One match round per contact per window, in either role. The scenario re-matches
  // the same pairs within minutes, so it relies on the 1 s window and on the
  // engines deferring a blocked round until the window passed.

  // ---- connect: one pair per path
  const ab = await connectPair(A, B, 'inviter-first')
  const ac = await connectPair(A, C, 'invitee-first')
  check('B and C are not contacts of each other', !B.state().contacts.some((c) => c.pubkey === C.pk()) && !C.state().contacts.some((c) => c.pubkey === B.pk()), Date.now())
  if (!ab || !ac) return

  // ---- B sells, C buys, A has nothing: A must see nothing
  started = Date.now()
  await B.engine.actions.postOffer({ side: 'sell', currency: 'KRW', amountMinor: 90000, feePct: 3, methods: BOTH })
  await C.engine.actions.postOffer({ side: 'buy', currency: 'KRW', amountMinor: 50000, feePct: 1, methods: BOTH })
  const answeredBoth = await waitFor(() => roundsSettled(B) && roundsSettled(C), ROUND_MS)
  check('A answers the rounds of B and C', answeredBoth, started)
  await sleep(2000)
  check('A sees no matches while it has no offer', A.state().matches.length === 0, started, `A.matches=${ids(A.state())}`)
  check('B and C see no matches either', B.state().matches.length === 0 && C.state().matches.length === 0, started)

  // ---- A buys: only B appears
  started = Date.now()
  await A.engine.actions.postOffer({ side: 'buy', currency: 'KRW', amountMinor: 100000, feePct: 1, methods: BOTH })
  const aOfferId = A.state().myOffer?.id ?? ''
  await waitFor(() => A.state().matches.length > 0 && B.state().matches.length > 0 && roundsSettled(A), ROUND_MS)
  const am = A.state().matches
  check(
    'A.matches is exactly [B] with amount 90000',
    am.length === 1 && am[0].contactId === B.pk() && am[0].offer.amountMinor === 90000 && am[0].offer.side === 'sell',
    started,
    `A.matches=${ids(A.state())}`,
  )
  const bm = B.state().matches
  check('B.matches is exactly [A] with amount 100000', bm.length === 1 && bm[0].contactId === A.pk() && bm[0].offer.amountMinor === 100000, started, `B.matches=${ids(B.state())}`)
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
  check('C keeps no round session and no verified match for A', Object.keys(cResp).length === 0 && !(A.pk() in cVerified), started, `sessions=${Object.keys(cResp).length}`)
  // A's pending state signals (told) are only about contacts its offer
  // matched. B is there (A's offer went to it), C never is.
  const aTold = (await A.kv.get<Record<string, unknown>>('told')) ?? {}
  check("A's KV told holds B and nothing about C", B.pk() in aTold && !(C.pk() in aTold), started, `told=${Object.keys(aTold).length}`)

  // ---- chat A -> B
  started = Date.now()
  const hello = `e2e ${Date.now()}`
  secret('chat text', hello)
  await A.engine.actions.sendChat(B.pk(), hello)
  const got = await waitFor(() => (B.state().rooms[A.pk()] ?? []).some((m) => m.kind === 'text' && !m.mine && m.text === hello), ROUND_MS)
  check('B receives the chat from A', got, started)
  // The chat travels under A's record id, so a retry of it goes in once.
  const aChat = (A.state().rooms[B.pk()] ?? []).find((m) => m.kind === 'text' && m.mine && m.text === hello)
  const bChat = (B.state().rooms[A.pk()] ?? []).find((m) => m.kind === 'text' && !m.mine && m.text === hello)
  check("B keeps A's chat under A's record id", !!aChat && aChat.id === bChat?.id, started, `A=${aChat?.id.slice(0, 8)} B=${bChat?.id.slice(0, 8)}`)
  check('C has no room traffic from A', (C.state().rooms[A.pk()] ?? []).length === 0, started)

  // ---- payment methods: one method in common is a match
  const methodsOf = (x: Peer, y: Peer) =>
    x
      .state()
      .matches.find((m) => m.contactId === y.pk())
      ?.offer.methods.join() ?? null
  const methodOfferIds: string[] = []
  // 1. A narrows to Lightning: a new offer and a new round; B {LN,OC} still shares one.
  started = Date.now()
  await A.engine.actions.postOffer({ side: 'buy', currency: 'KRW', amountMinor: 100000, feePct: 1, methods: LN_ONLY })
  methodOfferIds.push(A.state().myOffer?.id ?? '')
  const rematched = await waitFor(() => methodsOf(A, B) === 'lightning,onchain' && methodsOf(B, A) === 'lightning' && roundsSettled(A), ROUND_MS)
  check("A {LN} and B {LN,OC} match again; each sees the other's methods", rematched, started, `A sees ${methodsOf(A, B)}, B sees ${methodsOf(B, A)}`)
  // 2. B narrows to on-chain: no method in common with A any more.
  started = Date.now()
  await B.engine.actions.postOffer({ side: 'sell', currency: 'KRW', amountMinor: 90000, feePct: 3, methods: OC_ONLY })
  const apart = await waitFor(() => !methodsOf(A, B) && !methodsOf(B, A) && roundsSettled(B), ROUND_MS)
  check('A {LN} and B {OC} no longer match on either side', apart, started, `A.matches=${ids(A.state())} B.matches=${ids(B.state())}`)
  // 3. B goes back to both: the match comes back.
  started = Date.now()
  await B.engine.actions.postOffer({ side: 'sell', currency: 'KRW', amountMinor: 90000, feePct: 3, methods: BOTH })
  const together = await waitFor(() => methodsOf(A, B) === 'lightning,onchain' && methodsOf(B, A) === 'lightning' && roundsSettled(B), ROUND_MS)
  check('B {LN,OC} matches A {LN} again', together, started, `A.matches=${ids(A.state())} B.matches=${ids(B.state())}`)
  // 4. C sells KRW on-chain only: the opposite side and currency of A, but no method in
  // common. C and A must stay apart and learn nothing of each other.
  started = Date.now()
  await C.engine.actions.postOffer({ side: 'sell', currency: 'KRW', amountMinor: 50001, feePct: 2, methods: OC_ONLY })
  const cOcId = C.state().myOffer?.id ?? ''
  methodOfferIds.push(cOcId)
  await waitFor(() => roundsSettled(C), ROUND_MS)
  await sleep(4000)
  check('A {LN} buying and C {OC} selling KRW do not match', !methodsOf(A, C) && !methodsOf(C, A), started, `A.matches=${ids(A.state())} C.matches=${ids(C.state())}`)
  const aNowId = A.state().myOffer?.id ?? ''
  const cDumpM = { kv: await dumpKV(C.kv), state: { ...C.state(), rates: null } }
  const aDumpM = { kv: await dumpKV(A.kv), state: { ...A.state(), rates: null } }
  check(
    "C holds nothing of A's offer (amount 100000, its id), A nothing of C's (50001, its id)",
    !anywhere(cDumpM, (v) => v === 100000 || (aNowId !== '' && v === aNowId)) && !anywhere(aDumpM, (v) => v === 50001 || (cOcId !== '' && v === cOcId)),
    started,
  )
  const cVerM = (await C.kv.get<Record<string, unknown>>('verified')) ?? {}
  const aVerM = (await A.kv.get<Record<string, unknown>>('verified')) ?? {}
  check('neither verified the other', !(A.pk() in cVerM) && !(C.pk() in aVerM), started)
  // C buys KRW 50000 again, as the later steps expect.
  await C.engine.actions.postOffer({ side: 'buy', currency: 'KRW', amountMinor: 50000, feePct: 1, methods: BOTH })
  await waitFor(() => roundsSettled(C), ROUND_MS)
  await sleep(2000)

  await receiveSteps(A, B, C, methodOfferIds)

  // ---- a chat whose handling did not finish comes back after a restart, once
  started = Date.now()
  const kept = `e2e kept ${Date.now()}`
  secret('chat text', kept)
  bMarmot.armNextChat()
  await A.engine.actions.sendChat(B.pk(), kept)
  await waitFor(() => bMarmot.rejected() === 1, ROUND_MS)
  await sleep(1000)
  const keptKeys = await B.inboxKeys()
  check("B's callback refused the chat and it stays in B's inbox", bMarmot.rejected() === 1 && keptKeys.length >= 1, started, `entries=${keptKeys.length}`)
  check(
    "B's stored inbox is encrypted: no chat text or pubkey at rest",
    plainTextIn(B.backend, [
      { what: 'chat text', value: kept },
      { what: 'A pubkey', value: A.pk() },
    ]).length === 0,
    started,
  )
  await B.engine.stop()
  const bBackend = B.backend
  B = makePeer('B', { backend: bBackend })
  peers[1] = B
  const restartedOk = await Promise.race([B.engine.start().then(() => true), sleep(BOOT_MS).then(() => false)]).catch(() => false)
  check('B starts again on the same store', restartedOk && B.state().boot === 'ready', started)
  const back = await waitFor(() => (B.state().rooms[A.pk()] ?? []).some((m) => m.kind === 'text' && m.text === kept), ROUND_MS)
  await sleep(3000)
  const keptCount = (B.state().rooms[A.pk()] ?? []).filter((m) => m.kind === 'text' && m.text === kept).length
  check("after the restart B's room has the kept chat exactly once", back && keptCount === 1, started, `count=${keptCount}`)
  check("B's inbox is empty again", (await B.inboxKeys()).length === 0, started)
  check(
    'B still matches A after its restart',
    B.state().matches.some((m) => m.contactId === A.pk()),
    started,
    `B.matches=${ids(B.state())}`,
  )

  // ---- A reopens while A and B match. Its reconfirm round goes to
  // B only and changes nothing: both still match, no new 'matched' marker, C answers nothing.
  started = Date.now()
  const markersOf = (x: Peer, y: Peer) => (x.state().rooms[y.pk()] ?? []).filter((m) => m.kind === 'matched').length
  const marksBefore = [markersOf(A, B), markersOf(B, A)]
  const cAnsweredA = async () => ((await C.kv.get<Record<string, number>>('respondLog')) ?? {})[A.pk()] ?? 0
  const cBefore = await cAnsweredA()
  const bBefore = ((await B.kv.get<Record<string, number>>('respondLog')) ?? {})[A.pk()] ?? 0
  await A.engine.stop()
  A = makePeer('A', { backend: A.backend })
  peers[0] = A
  const aBack = await Promise.race([A.engine.start().then(() => true), sleep(BOOT_MS).then(() => false)]).catch(() => false)
  check('A starts again on the same store', aBack && A.state().boot === 'ready', started)
  await sleep(30_000)
  const bAfter = ((await B.kv.get<Record<string, number>>('respondLog')) ?? {})[A.pk()] ?? 0
  check("A's reconfirm round reached B (B answered a round of A after A reopened)", bAfter > bBefore, started)
  check(
    '30 s after A reopened both still match each other',
    A.state().matches.some((m) => m.contactId === B.pk()) && B.state().matches.some((m) => m.contactId === A.pk()),
    started,
    `A.matches=${ids(A.state())} B.matches=${ids(B.state())}`,
  )
  check("no new 'matched' marker in A's or B's room", markersOf(A, B) === marksBefore[0] && markersOf(B, A) === marksBefore[1], started, `${marksBefore} -> ${[markersOf(A, B), markersOf(B, A)]}`)
  check('C answered no round of A after A reopened (the reconfirm skips a contact that does not match)', (await cAnsweredA()) === cBefore, started)

  // ---- partial completion in minor units. A buys KRW 100,000, B sells 90,000.
  started = Date.now()
  let doneErr = ''
  await A.engine.actions.markDone(B.pk(), 30000).catch((e: Error) => (doneErr = e.message))
  check('A marks 30000 done: its open amount is 70000', doneErr === '' && A.state().myOffer?.amountMinor === 70000, started, doneErr || `A.amountMinor=${A.state().myOffer?.amountMinor}`)
  const aDone = (A.state().rooms[B.pk()] ?? []).find((m) => m.kind === 'done' && m.mine)
  const bGotDone = await waitFor(() => (B.state().rooms[A.pk()] ?? []).some((m) => m.kind === 'done' && !m.mine && m.amountMinor === 30000 && m.currency === 'KRW' && m.id === aDone?.id), ROUND_MS)
  check("B's room holds A's completion of 30000 under A's record id", bGotDone, started)
  // A's completion record follows its delivery: 'sent' once a relay took it.
  const aDoneSent = await waitFor(() => (A.state().rooms[B.pk()] ?? []).some((m) => m.kind === 'done' && m.mine && m.id === aDone?.id && m.status === 'sent'), ROUND_MS)
  check("A's completion record is 'sent'", aDoneSent, started)
  // B's trade view offers to answer it.
  const bPending = tradeView(B.state(), A.pk(), Date.now()).pendingDone
  check("B's trade view has A's 30000 pending", bPending.length === 1 && bPending[0].amountMinor === 30000, started, JSON.stringify(bPending))
  await B.engine.actions.markDone(A.pk(), 30000).catch((e: Error) => (doneErr = e.message))
  check('B marks 30000 done: its open amount is 60000', doneErr === '' && B.state().myOffer?.amountMinor === 60000, started, doneErr || `B.amountMinor=${B.state().myOffer?.amountMinor}`)
  const synced = await waitFor(
    () => A.state().matches.some((m) => m.contactId === B.pk() && m.offer.amountMinor === 60000) && B.state().matches.some((m) => m.contactId === A.pk() && m.offer.amountMinor === 70000),
    ROUND_MS,
  )
  check("A sees B's 60000 and B sees A's 70000", synced, started, `A.matches=${ids(A.state())} B.matches=${ids(B.state())}`)
  // e2e 5: both completions pair up, so neither side has anything left to answer.
  const aGotDone = await waitFor(() => (A.state().rooms[B.pk()] ?? []).some((m) => m.kind === 'done' && !m.mine && m.amountMinor === 30000), ROUND_MS)
  // Paired means: in each room the contact's done follows my own (or mine follows theirs),
  // both 30000 KRW. A's own record is the one B already holds under its id.
  const doneIdx = (room: ChatMessage[], mine: boolean) => room.findIndex((m) => m.kind === 'done' && m.mine === mine && m.amountMinor === 30000 && m.currency === 'KRW')
  const aRoom = A.state().rooms[B.pk()] ?? []
  const bRoom = B.state().rooms[A.pk()] ?? []
  const aMineIdx = doneIdx(aRoom, true)
  const aTheirsIdx = doneIdx(aRoom, false)
  const bMineIdx = doneIdx(bRoom, true)
  const bTheirsIdx = doneIdx(bRoom, false)
  check(
    "A's room holds B's mirrored completion after A's own (B's reached A), B's holds its own after A's",
    aGotDone && aMineIdx >= 0 && aRoom[aMineIdx].id === aDone?.id && aTheirsIdx > aMineIdx && bTheirsIdx >= 0 && bMineIdx > bTheirsIdx,
    started,
    `A mine@${aMineIdx} theirs@${aTheirsIdx}, B theirs@${bTheirsIdx} mine@${bMineIdx}`,
  )
  const pendingA = tradeView(A.state(), B.pk(), Date.now()).pendingDone.length
  const pendingB = tradeView(B.state(), A.pk(), Date.now()).pendingDone.length
  check('nothing pending on either side after both completions', pendingA === 0 && pendingB === 0, started, `A ${pendingA}, B ${pendingB}`)
  await sleep(2000)
  check('C still has no room traffic from A after the completions', (C.state().rooms[A.pk()] ?? []).length === 0, started)
  // 70000 and 60000 are A's and B's new amounts; C matched neither, so neither may reach it.
  const cDump2 = { kv: await dumpKV(C.kv), state: { ...C.state(), rates: null } }
  const leaksDone = anywhere(cDump2, (v) => v === 70000 || v === 60000 || v === 30000)
  // Positive control: the same search finds the amounts where they belong (A's own offer, B's view of A).
  const aDump2 = { kv: await dumpKV(A.kv), state: { ...A.state(), rates: null } }
  const bDump2 = { kv: await dumpKV(B.kv), state: { ...B.state(), rates: null } }
  check(
    'the completion-amount search finds them on A and B (positive control)',
    anywhere(aDump2, (v) => v === 70000) && anywhere(bDump2, (v) => v === 70000) && anywhere(bDump2, (v) => v === 30000),
    started,
  )
  check("C's state and KV hold none of the completion amounts (30000, 70000, 60000)", !leaksDone, started)

  // ---- A switches to USD: B must lose A
  started = Date.now()
  // A keeps Lightning only from the method steps on.
  await A.engine.actions.postOffer({ side: 'buy', currency: 'USD', amountMinor: 10_000, feePct: 1, methods: LN_ONLY })
  const lost = await waitFor(() => B.state().matches.length === 0, ROUND_MS)
  check('B loses A after A changes to buy USD', lost, started, `B.matches=${ids(B.state())}`)
  await waitFor(() => roundsSettled(A), ROUND_MS)
  check('A has no matches for buy USD', A.state().matches.length === 0, started, `A.matches=${ids(A.state())}`)

  // ---- JPY matches only JPY. Now A buys USD, B sells KRW 90000, C buys KRW 50000.
  // C switches to sell JPY, A to buy JPY: A and C match, B (KRW, never used JPY) learns nothing.
  started = Date.now()
  await C.engine.actions.postOffer({ side: 'sell', currency: 'JPY', amountMinor: 70001, feePct: 2, methods: BOTH })
  // Let C's round with A finish before A changes its offer, so the two do not cross.
  const cSettled = await waitFor(() => roundsSettled(C), ROUND_MS)
  check('A answers the round of C selling JPY', cSettled, started)
  // 123457 appears nowhere else in the scenario, so finding it on B means A's offer leaked.
  await A.engine.actions.postOffer({ side: 'buy', currency: 'JPY', amountMinor: 123457, feePct: 1, methods: LN_ONLY })
  const aJpyOfferId = A.state().myOffer?.id ?? ''
  await waitFor(() => A.state().matches.length > 0 && C.state().matches.length > 0 && roundsSettled(A) && roundsSettled(C), ROUND_MS)
  const amJ = A.state().matches
  check(
    'A.matches is exactly [C] selling JPY 70001',
    amJ.length === 1 && amJ[0].contactId === C.pk() && amJ[0].offer.side === 'sell' && amJ[0].offer.currency === 'JPY' && amJ[0].offer.amountMinor === 70001,
    started,
    `A.matches=${ids(A.state())}`,
  )
  const cmJ = C.state().matches
  check(
    'C.matches is exactly [A] buying JPY 123457',
    cmJ.length === 1 && cmJ[0].contactId === A.pk() && cmJ[0].offer.side === 'buy' && cmJ[0].offer.currency === 'JPY' && cmJ[0].offer.amountMinor === 123457,
    started,
    `C.matches=${ids(C.state())}`,
  )
  await sleep(4000)
  check('B.matches is empty while A buys JPY', B.state().matches.length === 0, started, `B.matches=${ids(B.state())}`)
  // B never used JPY, so even the string 'JPY' on B means the currency leaked. Rates hide as above.
  const bDump = { kv: await dumpKV(B.kv), state: { ...B.state(), rates: null } }
  const leaksJpy = anywhere(bDump, (v) => v === 123457 || (aJpyOfferId !== '' && v === aJpyOfferId) || v === 'JPY')
  // Round sessions are keyed `${contact}:${sid}`; verified is keyed by contact.
  const bResp = (await B.kv.get<Record<string, { contactId?: string }>>('resp')) ?? {}
  const bVerified = (await B.kv.get<Record<string, unknown>>('verified')) ?? {}
  const bRespForA = Object.values(bResp).filter((s) => s.contactId === A.pk()).length
  check("B's state and KV hold nothing about A's JPY offer (amount, id, 'JPY')", aJpyOfferId !== '' && !leaksJpy, started)
  check('B keeps no round session and no verified match for A', bRespForA === 0 && !(A.pk() in bVerified), started, `sessions=${bRespForA}`)

  // ---- B deletes A, A posts buy KRW again: no match, no error
  // C still sells JPY from the step above; A buying KRW does not match it, so A.matches stays empty.
  started = Date.now()
  await B.engine.actions.deleteContact(A.pk())
  check('B no longer lists A', !B.state().contacts.some((c) => c.pubkey === A.pk()), started)
  let postError = ''
  try {
    await A.engine.actions.postOffer({ side: 'buy', currency: 'KRW', amountMinor: 100000, feePct: 1, methods: LN_ONLY })
  } catch (e) {
    postError = e instanceof Error ? e.message : String(e)
  }
  await waitFor(() => roundsSettled(A), ROUND_MS)
  await sleep(SETTLE_MS)
  check('A posts again without error', postError === '' && A.state().boot === 'ready', started, postError)
  check('A gets no match (B deleted A, C sells JPY)', A.state().matches.length === 0, started, `A.matches=${ids(A.state())}`)
  check('B shows nothing from A', B.state().matches.length === 0 && B.state().rooms[A.pk()] === undefined, started)
  check(
    'A still lists B (the delete is invisible)',
    A.state().contacts.some((c) => c.pubkey === B.pk()),
    started,
  )
  // stored rooms: the tombstone keeps the channel (its room), and that room still answers
  // A's round with a random label, as a contact without an offer would.
  const progressA = A.state().matchProgress
  check('B, which deleted A, still answers A in the old room', progressA.asked > 0 && progressA.answered >= progressA.asked, started, `asked=${progressA.asked} answered=${progressA.answered}`)
  const bTomb = ((await B.kv.get<Record<string, { groupId?: string | null }>>('tombstones')) ?? {})[A.pk()]
  const roomAB = A.state().contacts.find((c) => c.pubkey === B.pk())?.groupId
  check("B's tombstone of A keeps the room of the channel", !!roomAB && bTomb?.groupId === roomAB, started)

  await relinkStep(A, B)

  await reopenStep(A, C, cMarmot.transport())

  await holderSteps(A, C)

  const D = await relaySettingsSteps(A)

  checkSupportLogs(D ? [...peers, D] : peers, [aOfferId, aJpyOfferId, ...methodOfferIds])
  if (D) await D.engine.stop().catch(() => {})
  await Promise.allSettled(peers.map((p) => p.engine.stop()))
  await checkAtRest(peers, hello, [aOfferId, aJpyOfferId, ...methodOfferIds])

  await recoveryStep()
}

/**
 * Recovery: R keeps its contact list on the list relays.
 * R's phone is lost: a fresh profile restores from the same 12 words, gets
 * S back under the name R gave it, and the channel reopens without meeting: chats go
 * both ways within minutes. Throwaway keys only.
 */
const RECOVERY_NAME = 'zq-recover-name'
async function recoveryStep(): Promise<void> {
  let started = Date.now()
  const R = makePeer('R', { listRelays: LIST_RELAYS_E2E })
  const S = makePeer('S')
  await Promise.all([R.engine.start(), S.engine.start()])
  if (!(await connectPair(R, S, 'invitee-first'))) return
  await R.engine.actions.renameContact(S.pk(), RECOVERY_NAME)
  const id = await R.kv.get<{ sk: string; words?: string }>('identity')
  const words = id?.words ?? ''
  check('recovery: R was made from 12 words', words.split(' ').length === 12, started)
  // The list goes up 2 s after the change; the check looks for it as a new phone would.
  let found = 0
  for (let i = 0; i < 12 && found < 2; i++) {
    await sleep(5_000)
    try {
      const f = await marmot.findList({ secretKeyHex: id?.sk ?? '', relays: LIST_RELAYS_E2E })
      found = f.copies.length
    } catch {
      found = 0
    }
  }
  check("recovery: at least two list relays hold R's list", found >= 2, started, `copies=${found} of ${LIST_RELAYS_E2E.length}`)
  const sk = id?.sk ?? ''
  await R.engine.stop()

  // A new phone: an empty profile, the same words.
  started = Date.now()
  const R2 = makePeer('R2', { listRelays: LIST_RELAYS_E2E, setup: true })
  await R2.engine.start()
  check('recovery: an empty profile waits in setup', R2.state().boot === 'setup', started, R2.state().boot)
  let result: { found: boolean } | null = null
  try {
    result = await R2.engine.actions.checkMnemonic(words)
  } catch (e) {
    check('recovery: checkMnemonic', false, started, e instanceof Error ? e.message : String(e))
    return
  }
  check('recovery: the 12 words find the contact list', result.found, started)
  await Promise.race([R2.engine.actions.restoreIdentity(words, { method: 'none' }), sleep(BOOT_MS)])
  const st = R2.state()
  check('recovery: restored with the same key', st.boot === 'ready' && st.me?.pubkey === R.pk(), started, `${st.boot} ${st.me?.pubkey?.slice(0, 8)}`)
  const back = st.contacts.find((c) => c.pubkey === S.pk())
  check('recovery: S is back under the name R gave it', back?.name === RECOVERY_NAME, started, back?.name ?? 'missing')
  const stored = await R2.kv.get<{ sk: string; words?: string }>('identity')
  check('recovery: the restored identity keeps no words', stored?.sk === sk && stored.words === undefined && !st.hasWords, started)

  // The channel reopens without meeting: chats both ways.
  started = Date.now()
  const roomOfR = () => R2.state().contacts.find((c) => c.pubkey === S.pk())?.groupId ?? null
  const reopened = await waitFor(() => !!roomOfR() && S.state().contacts.find((c) => c.pubkey === R2.pk())?.groupId === roomOfR(), 4 * 60_000)
  check(
    'recovery: R and S share a reopened room',
    reopened,
    started,
    `R=${roomOfR()?.slice(0, 8)} S=${S.state()
      .contacts.find((c) => c.pubkey === R2.pk())
      ?.groupId?.slice(0, 8)}`,
  )
  if (reopened) {
    await R2.engine.actions.sendChat(S.pk(), 'back again')
    const toS = await waitFor(() => (S.state().rooms[R2.pk()] ?? []).some((m) => m.kind === 'text' && m.text === 'back again'), 2 * 60_000)
    await S.engine.actions.sendChat(R2.pk(), 'welcome back')
    const toR = await waitFor(() => (R2.state().rooms[S.pk()] ?? []).some((m) => m.kind === 'text' && m.text === 'welcome back'), 2 * 60_000)
    check('recovery: chats go both ways after the restore', toS && toR, started, `toS=${toS} toR=${toR}`)
    // S's room gets at most one "reopened" line, however often the restored side reconnects.
    await sleep(HOLDER_PAIR_MS + 5_000)
    const lines = (S.state().rooms[R2.pk()] ?? []).filter((m) => m.kind === 'reopened').length
    check("recovery: S's room has at most one reopened line", lines <= 1, started, `lines=${lines}`)
  }
  for (const p of [R2, S]) {
    const text = p.log.dump({ app: 'e2e', time: new Date().toISOString() })
    check(`recovery: ${p.name}'s support log holds no key, words or name`, !text.includes(sk) && !text.includes(words) && !text.includes(RECOVERY_NAME) && !text.includes(S.pk()), started)
  }
  await Promise.allSettled([R2.engine.stop(), S.engine.stop()])
}

/**
 * rescans: B, which deleted A, meets A again and both scan. B links from
 * scratch: 'done', A under an empty name, no chat, no tombstone left. A's
 * screen says 'already' and A keeps B's name and the chat. One room,
 * chats go both ways in it.
 */
async function relinkStep(A: Peer, B: Peer): Promise<void> {
  const started = Date.now()
  const nameBefore = A.state().contacts.find((c) => c.pubkey === B.pk())?.name
  const chatBefore = (A.state().rooms[B.pk()] ?? []).length
  A.engine.actions.startConnect()
  B.engine.actions.startConnect()
  const pa = A.state().connect.myPayload ?? ''
  const pb = B.state().connect.myPayload ?? ''
  secret('connection code', pa)
  secret('connection code', pb)
  await B.engine.actions.submitScan(pa, 'camera')
  await sleep(2000)
  await A.engine.actions.submitScan(pb, 'camera')
  await waitFor(() => B.state().connect.phase === 'done' || B.state().connect.phase === 'failed', 3 * 60_000)
  const cb = B.state().connect
  const linked = check(
    'relink: B, which deleted A, links again by scanning',
    cb.phase === 'done' && B.state().contacts.some((c) => c.pubkey === A.pk()),
    started,
    `B=${cb.phase}${cb.errorKey ? `/${cb.errorKey}` : ''} A=${A.state().connect.phase}${LOCAL_HINT}`,
  )
  check("relink: A's screen says 'already'", A.state().connect.phase === 'already', started, A.state().connect.phase)
  A.engine.actions.cancelConnect()
  B.engine.actions.cancelConnect()
  if (!linked) return
  // The name and the room are read from the state at once: B's own round with A starts
  // when the link completes and matches within seconds (both trade), adding a 'matched'
  // marker that is not old chat. The tombstone is read from the store, which the engine
  // writes after the state, one write at a time (contacts, then tombstones; completeLink
  // does not wait for them). Read at once it may still hold the tombstone while the write
  // is queued (one failed run read it 1 ms after 'done', on the path
  // where B, the higher key, asks A for the room and many writes are queued). So that
  // read waits for the writes; the tombstone must be gone from the store all the same.
  const ba = B.state().contacts.find((c) => c.pubkey === A.pk())
  const bRoomNow = B.state().rooms[A.pk()] ?? []
  check("relink: B starts from scratch: A's name is empty", ba?.name === '', started, `name=${ba?.name === '' ? 'empty' : 'set'}`)
  check('relink: B starts from scratch: no chat in its room', bRoomNow.length === 0, started, `room=[${bRoomNow.map((m) => m.kind).join(',')}]`)
  const bTombAt = async () => ((await B.kv.get<Record<string, unknown>>('tombstones')) ?? {})[A.pk()]
  const tombEnd = Date.now() + 10_000
  let btomb = await bTombAt()
  while (btomb !== undefined && Date.now() < tombEnd) {
    await sleep(150)
    btomb = await bTombAt()
  }
  check("relink: B starts from scratch: no tombstone of A in B's store", btomb === undefined, started, `tomb=${btomb !== undefined}`)
  check("relink: A keeps B's name and the chat", A.state().contacts.find((c) => c.pubkey === B.pk())?.name === nameBefore && (A.state().rooms[B.pk()] ?? []).length >= chatBefore, started)
  const ab = A.state().contacts.find((c) => c.pubkey === B.pk())?.groupId
  check('relink: one room on both sides', !!ab && ab === ba?.groupId, started)
  const toB = `e2e relinked to B ${Date.now()}`
  const toA = `e2e relinked to A ${Date.now()}`
  secret('chat text', toB)
  secret('chat text', toA)
  await A.engine.actions.sendChat(B.pk(), toB)
  const gotB = await waitFor(() => (B.state().rooms[A.pk()] ?? []).some((m) => m.kind === 'text' && !m.mine && m.text === toB), ROUND_MS)
  await B.engine.actions.sendChat(A.pk(), toA)
  const gotA = await waitFor(() => (A.state().rooms[B.pk()] ?? []).some((m) => m.kind === 'text' && !m.mine && m.text === toA), ROUND_MS)
  check('relink: chats go both ways in the room', gotB && gotA, started, `A->B ${gotB} B->A ${gotA}`)
}

/**
 * restores and lost rooms: C's device loses its room with A (the stored group is gone, as
 * after a broken store). Without anyone scanning, the lower key makes a new room (or the
 * higher one asks for it), both end in it within a few minutes, the old one is gone, the
 * chat and the names stay, and chats go both ways again.
 */
async function reopenStep(A: Peer, C: Peer, cTransport: Transport | null): Promise<void> {
  const started = Date.now()
  const room = (x: Peer, y: Peer) => x.state().contacts.find((c) => c.pubkey === y.pk())?.groupId ?? null
  const old = room(A, C)
  const nameBefore = C.state().contacts.find((c) => c.pubkey === A.pk())?.name
  const chatBefore = (C.state().rooms[A.pk()] ?? []).length
  if (!cTransport || !old || room(C, A) !== old) {
    check('reopen: A and C share a room before the step', false, started)
    return
  }
  await cTransport.forgetGroup(old)
  check("reopen: C's room with A is gone from C's device", cTransport.groupHealth(old) === 'missing', started)
  const moved = await waitFor(() => {
    const g = room(A, C)
    return g !== null && g !== old && g === room(C, A)
  }, 4 * 60_000)
  check('reopen: A and C share a new room without scanning', moved, started, `A ${room(A, C)?.slice(0, 8)} C ${room(C, A)?.slice(0, 8)}`)
  if (!moved) return
  check("reopen: C keeps A's name and the chat", C.state().contacts.find((c) => c.pubkey === A.pk())?.name === nameBefore && (C.state().rooms[A.pk()] ?? []).length >= chatBefore, started)
  const toC = `e2e reopened to C ${Date.now()}`
  const toA = `e2e reopened to A ${Date.now()}`
  secret('chat text', toC)
  secret('chat text', toA)
  await A.engine.actions.sendChat(C.pk(), toC)
  const gotC = await waitFor(() => (C.state().rooms[A.pk()] ?? []).some((m) => m.kind === 'text' && !m.mine && m.text === toC), ROUND_MS)
  await C.engine.actions.sendChat(A.pk(), toA)
  const gotA = await waitFor(() => (A.state().rooms[C.pk()] ?? []).some((m) => m.kind === 'text' && !m.mine && m.text === toA), ROUND_MS)
  check('reopen: chats go both ways in the new room', gotC && gotA, started, `A->C ${gotC} C->A ${gotA}`)
}

/** x's room with y, or null. */
function roomOf(x: Peer, y: Peer): string | null {
  return x.state().contacts.find((c) => c.pubkey === y.pk())?.groupId ?? null
}

/** x scans y's QR now and y scans x's `gapMs` later; returns when both scans were handed over. */
async function scanBoth(x: Peer, y: Peer, gapMs: number): Promise<void> {
  x.engine.actions.startConnect()
  y.engine.actions.startConnect()
  const py = y.state().connect.myPayload ?? ''
  secret('connection code', py)
  await x.engine.actions.submitScan(py, 'camera')
  await sleep(gapMs)
  y.engine.actions.rotateConnectCode()
  x.engine.actions.rotateConnectCode()
  const px = x.state().connect.myPayload ?? ''
  secret('connection code', px)
  await y.engine.actions.submitScan(px, 'camera')
}

/**
 * holder rescans on real relays:
 * 1. A thief of A's key (a second engine with A's key and contact list, on its own store)
 *    moves C's channel to a room of its own; the real A keeps the old one: the channel is
 *    out of step, and neither screen shows it. A and C meet and scan each other: both say
 *    'already', and after the deadline (HOLDER_PAIR_MS here) the lower key makes a new room
 *    for the key package in the other's QR; both end in it, chats go both ways, names and
 *    chat stay.
 * 2. Then A and C, now in step, scan each other again: nothing moves (the proofs pair).
 */
async function holderSteps(A: Peer, C: Peer): Promise<void> {
  let started = Date.now()
  const before = roomOf(A, C)
  if (!before || roomOf(C, A) !== before) {
    check('holder: A and C share a room before the step', false, started)
    return
  }
  const nameC = C.state().contacts.find((c) => c.pubkey === A.pk())?.name
  const chatC = (C.state().rooms[A.pk()] ?? []).length
  // The thief: A's key and A's contact C (room unknown), on a store of its own.
  const id = await A.kv.get<{ sk: string }>('identity')
  const backend = memoryBackend()
  await nodeStorage('e2e:thief', backend).storage.create({ method: 'none' }, async (t) => {
    await t.kv.set('identity', { v: 1, sk: id?.sk })
    await t.kv.set('contacts', [{ id: C.pk(), pubkey: C.pk(), name: '', createdAt: Date.now(), groupId: null }])
  })
  const T = makePeer('T', { backend })
  await T.engine.start().catch(() => {})
  const moved = await waitFor(() => {
    const g = roomOf(C, A)
    return g !== null && g !== before
  }, 4 * 60_000)
  await T.engine.stop().catch(() => {})
  const outOfStep = check(
    "holder: a thief of A's key moved C's channel; the real A stays in the old room",
    moved && roomOf(A, C) === before,
    started,
    `A ${roomOf(A, C)?.slice(0, 8)} C ${roomOf(C, A)?.slice(0, 8)}`,
  )
  if (!outOfStep) return
  const thiefRoom = roomOf(C, A)
  // C just joined the thief's room, so its key package is being replaced on the relays: a
  // QR shown before that ends names the old one, which a room made from the scan can no
  // longer invite (a known limit of the QR's kp). Give the rotation time.
  await sleep(20_000)
  started = Date.now()
  await scanBoth(A, C, 5_000)
  const together = await waitFor(
    () => {
      const g = roomOf(A, C)
      return g !== null && g !== before && g !== thiefRoom && g === roomOf(C, A)
    },
    4 * HOLDER_PAIR_MS + 2 * 60_000,
  )
  check(
    'holder: out of step, A and C scan each other and end in one new room',
    together,
    started,
    `A ${roomOf(A, C)?.slice(0, 8)} C ${roomOf(C, A)?.slice(0, 8)} (old ${before.slice(0, 8)}, thief ${thiefRoom?.slice(0, 8)})${LOCAL_HINT}`,
  )
  check("holder: both screens say 'already'", A.state().connect.phase === 'already' && C.state().connect.phase === 'already', started, `${A.state().connect.phase}/${C.state().connect.phase}`)
  check("holder: C keeps A's name and the chat", C.state().contacts.find((c) => c.pubkey === A.pk())?.name === nameC && (C.state().rooms[A.pk()] ?? []).length >= chatC, started)
  A.engine.actions.cancelConnect()
  C.engine.actions.cancelConnect()
  if (together) {
    const toC = `e2e holder to C ${Date.now()}`
    const toA = `e2e holder to A ${Date.now()}`
    secret('chat text', toC)
    secret('chat text', toA)
    await A.engine.actions.sendChat(C.pk(), toC)
    const gotC = await waitFor(() => (C.state().rooms[A.pk()] ?? []).some((m) => m.kind === 'text' && !m.mine && m.text === toC), ROUND_MS)
    await C.engine.actions.sendChat(A.pk(), toA)
    const gotA = await waitFor(() => (A.state().rooms[C.pk()] ?? []).some((m) => m.kind === 'text' && !m.mine && m.text === toA), ROUND_MS)
    check('holder: chats go both ways in the new room', gotC && gotA, started, `A->C ${gotC} C->A ${gotA}`)
  }

  // 2. In step now: a rescan moves nothing.
  started = Date.now()
  const room = roomOf(A, C)
  await scanBoth(C, A, 5_000)
  await sleep(HOLDER_PAIR_MS + 45_000)
  check(
    'holder: in step, A and C scan each other again and keep their room',
    !!room && roomOf(A, C) === room && roomOf(C, A) === room,
    started,
    `A ${roomOf(A, C)?.slice(0, 8)} C ${roomOf(C, A)?.slice(0, 8)} (was ${room?.slice(0, 8)})`,
  )
  check("holder: both screens say 'already' again", A.state().connect.phase === 'already' && C.state().connect.phase === 'already', started)
  A.engine.actions.cancelConnect()
  C.engine.actions.cancelConnect()
}

/**
 * Relays of my own that are all dead (e2e D and E). D (automatic, the default) opens on the default relays and A and D connect and
 * chat both ways; E ("Don't switch automatically") stays 'starting' for 30 s and sends
 * nothing anywhere. Returns D for the support log check (null if it did not boot).
 */
async function relaySettingsSteps(A: Peer): Promise<Peer | null> {
  const started = Date.now()
  const dead = ['wss://dead1.ilchon.invalid', 'wss://dead2.ilchon.invalid']
  const D = await makeSeededPeer('D', { lang: 'en', sort: 'amount', relays: dead, relayAuto: true })
  const E = await makeSeededPeer('E', { lang: 'en', sort: 'amount', relays: dead, relayAuto: false })
  const eBoots: string[] = []
  E.engine.store.subscribe((s) => eBoots.push(s.boot))
  void E.engine.start().catch(() => {})
  const dBoot = await Promise.race([
    D.engine.start().then(
      () => 'started',
      (e: unknown) => (e instanceof Error ? e.message : String(e)),
    ),
    sleep(BOOT_MS).then(() => 'boot timeout'),
  ])
  const ds = D.state()
  const dOk = check(
    'D (dead relays of its own, automatic switching) opens on the default relays',
    ds.boot === 'ready' && ds.fallingBack && ds.relays.every((r) => !dead.includes(r.url)) && JSON.stringify(ds.settings.relays) === JSON.stringify(dead),
    started,
    `boot=${ds.boot} fallingBack=${ds.fallingBack} ${dBoot}`,
  )
  let linked = false
  if (dOk) {
    linked = await connectPair(A, D, 'invitee-first')
    if (linked) {
      const t1 = Date.now()
      const toD = `e2e to D ${Date.now()}`
      const toA = `e2e to A ${Date.now()}`
      secret('chat text', toD)
      secret('chat text', toA)
      await A.engine.actions.sendChat(D.pk(), toD)
      const gotD = await waitFor(() => (D.state().rooms[A.pk()] ?? []).some((m) => m.kind === 'text' && !m.mine && m.text === toD), ROUND_MS)
      await D.engine.actions.sendChat(A.pk(), toA)
      const gotA = await waitFor(() => (A.state().rooms[D.pk()] ?? []).some((m) => m.kind === 'text' && !m.mine && m.text === toA), ROUND_MS)
      check('A and D chat both ways after the switch', gotD && gotA, t1, `A->D ${gotD} D->A ${gotA}`)
    }
  }
  // E started together with D: at least 30 s have passed before E is looked at.
  await waitFor(() => Date.now() - started >= 30_000, 40_000)
  const es = E.state()
  check(
    "E (dead relays of its own, don't switch) still waits after 30 s, never an error",
    es.boot === 'starting' && !eBoots.includes('error') && !es.fallingBack && es.relays.every((r) => dead.includes(r.url)),
    started,
    `boot=${es.boot} fallingBack=${es.fallingBack}`,
  )
  await E.engine.stop().catch(() => {})
  return dOk ? D : (await D.engine.stop().catch(() => {}), null)
}

/**
 * What each peer's store keeps at rest: the chat it sent or
 * got, any pubkey (its own and its contacts'), group ids, offer ids and amounts appear
 * nowhere in the stored bytes, neither as UTF-8 nor as base64url in an entry name.
 * The engine's own view of the same store still holds them (the store really ran).
 */
async function checkAtRest(peers: Peer[], chat: string, offerIds: string[]): Promise<void> {
  const started = Date.now()
  const needles: { what: string; value: string }[] = [{ what: 'chat text', value: chat }]
  for (const p of peers) {
    needles.push({ what: `${p.name} pubkey`, value: p.pk() })
    for (const c of p.state().contacts) if (c.groupId) needles.push({ what: 'group id', value: c.groupId })
  }
  for (const id of offerIds) if (id) needles.push({ what: 'offer id', value: id })
  for (const n of AMOUNTS) needles.push({ what: `amount ${n}`, value: String(n) })
  needles.push(...restNeedles)
  const problems: string[] = []
  for (const p of peers) {
    for (const what of plainTextIn(p.backend, needles)) problems.push(`${p.name}: ${what}`)
  }
  const sizes = peers.map((p) => `${p.name} ${p.backend.raw().data.size}`).join(', ')
  check('stores at rest hold no chat, pubkey, group id, offer id, amount, address or invoice', problems.length === 0, started, problems.length ? problems.join('; ') : `entries: ${sizes}`)
  // A sent the chat to B and still lists B: its chat item for B reads back through the store.
  const [A, B] = peers
  const aRoom = (await A.kv.get<{ text?: string }[]>(`room:${B.pk()}`).catch(() => undefined)) ?? []
  check(
    "the encrypted store gives A's engine its chat with B back",
    aRoom.some((m) => m.text === chat),
    started,
  )
}

/** Values of the receive steps that must never be stored in the clear (checkAtRest). */
const restNeedles: { what: string; value: string }[] = []

/**
 * Where the buyer receives: A buys KRW 100,000 with both
 * methods, B sells 90,000 at +3%. A sends an on-chain address, then a Lightning invoice
 * from its Lightning address (the in-process wallet service above), as chat texts to B
 * only. B's trade view makes each one the active card with the pay button; the sats are
 * requestSats at B's premium. Nothing is paid. C, A's contact that does not match, gets
 * nothing. No request leaves the process for the invoice.
 */
async function receiveSteps(A: Peer, B: Peer, C: Peer, offerIds: string[]): Promise<void> {
  // The steps' own error, if any, is the one that surfaces: a failure of the restore below
  // is logged and never replaces it.
  let first: { error: unknown } | null = null
  try {
    await receiveStepsBoth(A, B, C, offerIds)
  } catch (error) {
    first = { error }
  }
  try {
    // The steps after the method steps run with A on {LN}.
    // Sending an address needs on-chain in common, so A widened to both above; it goes
    // back to exactly the offer of method step 1, whatever happened in between.
    const started = Date.now()
    const methodsOf = (x: Peer, y: Peer) =>
      x
        .state()
        .matches.find((m) => m.contactId === y.pk())
        ?.offer.methods.join() ?? null
    await A.engine.actions.postOffer({ side: 'buy', currency: 'KRW', amountMinor: 100000, feePct: 1, methods: LN_ONLY })
    offerIds.push(A.state().myOffer?.id ?? '')
    const back = await waitFor(() => methodsOf(A, B) === 'lightning,onchain' && methodsOf(B, A) === 'lightning' && roundsSettled(A), ROUND_MS)
    check('A is back on buy KRW 100,000 {LN} and matches B {LN,OC} again', back, started, `A sees ${methodsOf(A, B)}, B sees ${methodsOf(B, A)}`)
  } catch (restoreError) {
    if (!first) throw restoreError
    console.error(`receive steps: restoring A's offer also failed: ${restoreError instanceof Error ? restoreError.message : String(restoreError)}`)
  }
  if (first) throw first.error
}

async function receiveStepsBoth(A: Peer, B: Peer, C: Peer, offerIds: string[]): Promise<void> {
  let started = Date.now()
  const methodsOf = (x: Peer, y: Peer) =>
    x
      .state()
      .matches.find((m) => m.contactId === y.pk())
      ?.offer.methods.join() ?? null
  await A.engine.actions.postOffer({ side: 'buy', currency: 'KRW', amountMinor: 100000, feePct: 1, methods: BOTH })
  offerIds.push(A.state().myOffer?.id ?? '')
  const both = await waitFor(() => methodsOf(A, B) === 'lightning,onchain' && methodsOf(B, A) === 'lightning,onchain' && roundsSettled(A), ROUND_MS)
  check('A {LN,OC} and B {LN,OC} match on both methods', both, started, `A sees ${methodsOf(A, B)}, B sees ${methodsOf(B, A)}`)
  const priced = await waitFor(() => A.state().rates.KRW !== undefined && B.state().rates.KRW !== undefined, ROUND_MS)
  check('A and B have a KRW price', priced, started)
  if (!both || !priced) return

  const lastMine = () => [...(A.state().rooms[B.pk()] ?? [])].reverse().find((m) => m.kind === 'text' && m.mine)
  const reachedB = (id: string) => waitFor(() => (B.state().rooms[A.pk()] ?? []).some((m) => m.kind === 'text' && !m.mine && m.id === id), ROUND_MS)
  /** The sats the request may carry: requestSats at B's +3% with A's price just before or after the call. */
  const expectSats = (rates: number[]) => rates.map((r) => Math.floor((90000 * 1e8 * 100) / (1 * r * 103)))

  // On-chain: pasted in capitals with a line break, sent lower case with the amount.
  started = Date.now()
  const ADDR = 'bc1qw508d6qejxtdg4y5r3zarvary0c5xw7kv8f3t4'
  secret('on-chain address', ADDR)
  restNeedles.push({ what: 'on-chain address', value: ADDR })
  const r1 = A.state().rates.KRW as number
  let err = ''
  await A.engine.actions.sendPaymentRequest(B.pk(), { method: 'onchain', amountMinor: 90000, address: `${ADDR.toUpperCase()}\n` }).catch((e: Error) => (err = e.message))
  const r2 = A.state().rates.KRW as number
  const oc = lastMine()
  const ocRef = oc?.kind === 'text' ? payRefOf(oc.text) : null
  check(
    'A sends a bitcoin: link for the address with the sats of the request',
    err === '' && ocRef?.kind === 'onchain' && ocRef.id === ADDR && ocRef.amountSats !== null && expectSats([r1, r2]).includes(ocRef.amountSats) && oc?.kind === 'text' && oc.text === ocRef.req.uri,
    started,
    err || (oc?.kind === 'text' ? oc.text : 'no text'),
  )
  const ocArrived = oc ? await reachedB(oc.id) : false
  const bView1 = tradeView(B.state(), A.pk(), Date.now())
  check(
    "B gets it: the on-chain card is active with B's pay button",
    ocArrived && bView1.activeKind === 'onchain' && bView1.receive === 'live' && Object.values(bView1.cards).some((c) => c.state === 'active' && c.pay),
    started,
    `kind=${bView1.activeKind}`,
  )
  err = ''
  const before = (A.state().rooms[B.pk()] ?? []).length
  await A.engine.actions.sendPaymentRequest(B.pk(), { method: 'onchain', amountMinor: 90000, address: ADDR }).catch((e: Error) => (err = e.message))
  check("the same address again is refused ('reused') and nothing is added", err === 'reused' && (A.state().rooms[B.pk()] ?? []).length === before, started, err)

  // Lightning: the address is checked once, then the invoice comes from the wallet service.
  started = Date.now()
  secret('lightning address', WALLET_ADDRESS)
  restNeedles.push({ what: 'lightning address', value: WALLET_ADDRESS })
  err = ''
  await A.engine.actions.setLightningAddress(` ${WALLET_ADDRESS.toUpperCase()} `).catch((e: Error) => (err = e.message))
  check('A saves its Lightning address after one lookup', err === '' && A.state().settings.lnAddress === WALLET_ADDRESS, started, err)
  const r3 = A.state().rates.KRW as number
  await A.engine.actions.sendPaymentRequest(B.pk(), { method: 'lightning', amountMinor: 90000 }).catch((e: Error) => (err = e.message))
  const r4 = A.state().rates.KRW as number
  const ln = lastMine()
  const lnRef = ln?.kind === 'text' ? payRefOf(ln.text) : null
  check(
    'A sends a mainnet invoice for exactly the sats of the request',
    err === '' && lnRef?.kind === 'lightning' && lnRef.mainnet && lnRef.amountSats !== null && expectSats([r3, r4]).includes(lnRef.amountSats),
    started,
    err || `sats=${lnRef?.amountSats}`,
  )
  if (ln?.kind === 'text') {
    secret('invoice', ln.text)
    restNeedles.push({ what: 'invoice', value: ln.text })
  }
  const lnArrived = ln ? await reachedB(ln.id) : false
  const bView2 = tradeView(B.state(), A.pk(), Date.now())
  const bOcKey = Object.keys(bView2.cards).find((k) => oc && k.startsWith(`${oc.id}:`))
  check(
    'B: the invoice is the active card now and the on-chain card is grey',
    lnArrived && bView2.activeKind === 'lightning' && bOcKey !== undefined && bView2.cards[bOcKey].state === 'inactive' && !bView2.cards[bOcKey].pay,
    started,
  )
  check(
    'only the wallet service was asked (first step and callback), nothing else',
    walletCalls.length >= 2 && walletCalls.every((u) => u === 'https://wallet.example/.well-known/lnurlp/buyer' || u === 'https://pay.wallet.example/cb'),
    started,
    walletCalls.join(' '),
  )
  await sleep(2000)
  const cDump = JSON.stringify({ kv: await dumpKV(C.kv), state: { ...C.state(), rates: null } })
  const lnText = ln?.kind === 'text' ? ln.text : '\u0000none'
  check(
    'C (no match with A) holds neither the address, the invoice nor the Lightning address',
    !cDump.includes(ADDR) && !cDump.includes(lnText) && !cDump.includes(WALLET_ADDRESS) && (C.state().rooms[A.pk()] ?? []).length === 0,
    started,
  )
  const bDump = JSON.stringify({ kv: await dumpKV(B.kv), state: { ...B.state(), rates: null } })
  check('the Lightning address itself never reaches B (only the invoice does)', !bDump.includes(WALLET_ADDRESS) && bDump.includes(ADDR), started)
}

/** Amounts of this scenario, searched bare (not inside hex or a longer number). */
const AMOUNTS = [90000, 50000, 100000, 70001, 123457, 30000, 70000, 60000]
/** Words of the trade and contact side that no support log line has. */
const LOG_WORDS = ['match', 'contact', 'round', 'rx', 'peer=', 'from=', 'offer', 'verified', 'jpy']

/**
 * The support logs after the whole scenario: no pubkey or a
 * part of one, npub, group id, connection code, offer id, chat text, amount, and no
 * line about matches, contacts or rounds. Lines must exist (the log really runs).
 */
function checkSupportLogs(peers: Peer[], offerIds: string[]): void {
  const started = Date.now()
  for (const p of peers) {
    secret(`${p.name} pubkey`, p.pk())
    secret(`${p.name} pubkey head`, p.pk().slice(0, 8))
    secret(`${p.name} npub`, npubOf(p.pk()))
    for (const c of p.state().contacts) {
      if (!c.groupId) continue
      secret('group id', c.groupId)
      secret('group id head', c.groupId.slice(0, 8))
    }
  }
  for (const id of offerIds) secret('offer id', id)
  const header = { app: 'e2e', time: new Date().toISOString(), browser: 'node', lang: 'en', boot: 'ready' }
  const dumps = [...peers.map((p) => ({ name: p.name, text: p.log.dump(header) })), { name: 'transport', text: transportLog.dump(header) }]
  const problems: string[] = []
  for (const d of dumps) {
    for (const s of secrets) if (d.text.includes(s.value)) problems.push(`${d.name}: ${s.what}`)
    // Code-made times and waits are numbers too; they are not searched.
    const numbers = d.text.replace(/\(\+\d+ ms\)|retrying in \d+ ms/g, '')
    for (const n of AMOUNTS) if (new RegExp(`(?<![0-9a-fA-F.])${n}(?![0-9a-fA-F])`).test(numbers)) problems.push(`${d.name}: amount ${n}`)
    for (const w of LOG_WORDS) if (d.text.toLowerCase().includes(w)) problems.push(`${d.name}: '${w}'`)
  }
  const lines = dumps.map((d) => `${d.name} ${d.text.split('\n').length - 10}`).join(', ')
  check('support logs hold no trade or person values', problems.length === 0, started, problems.length ? problems.slice(0, 8).join('; ') : `lines: ${lines}`)
  const a = dumps[0].text
  check("A's support log has its boot and link lines", a.includes('boot  ready') && a.includes('link  started'), started)
  if (DEBUG) for (const d of dumps) console.log(d.text)
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
