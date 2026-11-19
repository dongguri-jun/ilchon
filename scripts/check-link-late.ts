/**
 * A link must not end up on one side only when the inviter's
 * confirmation reaches the invitee late (phone asleep, app closed).
 *
 *   pnpm exec tsx scripts/check-link-late.ts      # real relays, throwaway keys
 *
 * Two engines link while the invitee's incoming messages from the inviter are
 * held back (except the inviter's first hello) for HOLD_MS, longer than the
 * shortened link timeout. Two runs:
 *   control: the old behaviour (replied invitee gives up at the link timeout)
 *            -> the inviter has the contact, the invitee does not
 *   fixed:   the default replied TTL -> both sides end up with the contact
 * Then a rescan case: the inviter gives up because the invitee's reply reaches
 * it late, and both scan each other again. The invitee's waiting link must not
 * block the new attempt.
 *
 * Not covered here: an app restart between reply and confirmation (Node runs
 * keep the transport in memory only). That path is the same code plus the
 * boot-time resend in resumeAfterBoot.
 *
 * E2E_RELAYS=wss://a,wss://b replaces the default relays. Local addresses do not work
 * there: a ws:// url, localhost, an IP address or a private host name fails the check
 * every app makes before joining a room (src/lib/marmot/guard.ts roomShapeOk), so no
 * invite is joined and every link times out. Use public wss:// relays.
 */
import { DEFAULT_RELAYS, type ConnectModule, type IncomingMessage, type IlchonState, type MarmotModule, type Transport } from '../src/contracts'
import { createEngine, type IlchonEngine } from '../src/engine/index'
import * as connectModule from '../src/lib/connect'
import * as marmotModule from '../src/lib/marmot'
import { peerRelayUrl } from '../src/lib/marmot/guard'
import { matchCrypto } from '../src/lib/match'
import { createRatesSource } from '../src/lib/rates'
import { createLnurl } from '../src/lib/lnurl'
import { nodeStorage } from './node-storage'

const RELAYS = process.env.E2E_RELAYS ? process.env.E2E_RELAYS.split(',') : DEFAULT_RELAYS
/** Relays of E2E_RELAYS a room may not name (the pre-join check refuses such a room), as scripts/e2e.ts says. */
const LOCAL_RELAYS = RELAYS.filter((url) => peerRelayUrl(url) === null)
const LOCAL_HINT = LOCAL_RELAYS.length
  ? ` (E2E_RELAYS has ${LOCAL_RELAYS.join(', ')}: ws://, localhost, IP addresses and private hosts fail the pre-join room check, so links cannot complete; use public wss:// relays)`
  : ''
if (LOCAL_HINT) console.log(`NOTE${LOCAL_HINT}`)
const LINK_TIMEOUT_MS = 8_000
const HOLD_MS = 20_000
const BOOT_MS = 90_000

let failed = 0
function check(name: string, ok: boolean, detail = ''): void {
  if (!ok) failed++
  // A failure with local relays names them, as scripts/e2e.ts does (B7).
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? `  ${detail}` : ''}${ok ? '' : LOCAL_HINT}`)
}
const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms))
async function waitFor(pred: () => boolean, ms: number): Promise<boolean> {
  const end = Date.now() + ms
  while (Date.now() < end) {
    if (pred()) return true
    await sleep(150)
  }
  return pred()
}

/**
 * Holds messages to `holder` from `from`, except the first hello, until
 * `until`. Everything else passes through untouched.
 */
interface Hold {
  holder?: string
  from?: string
  until: number
  /** Let the first hello through (the invitee needs it to reply at all). */
  passFirstHello: boolean
  passedFirstHello: boolean
}

/** Messages held back so far, across all runs (sanity check that holding happened). */
let held = 0

function holdingMarmot(hold: Hold): MarmotModule {
  return {
    ...marmotModule,
    createTransport(opts) {
      const inner: Transport = marmotModule.createTransport(opts)
      const me = marmotModule.pubkeyOf(opts.secretKeyHex)
      return new Proxy(inner, {
        get(target, prop, receiver) {
          if (prop !== 'onMessage') {
            // Private class fields need the real transport as `this`.
            const value = Reflect.get(target, prop, receiver)
            return typeof value === 'function' ? value.bind(target) : value
          }
          // The callback's result goes back to the transport: a held
          // message settles its inbox entry only once it was let go and handled.
          return (cb: (m: IncomingMessage) => void | Promise<void>) =>
            target.onMessage((m) => {
              const applies = me === hold.holder && m.senderPubkey === hold.from && Date.now() < hold.until
              if (applies && hold.passFirstHello && m.msg.t === 'hello' && !hold.passedFirstHello) {
                hold.passedFirstHello = true
                return cb(m)
              }
              if (applies) {
                held++
                return new Promise<void>((resolve, reject) => {
                  // Poll: hold.until may move (or be 'never' until set), and a huge
                  // delay would overflow setTimeout and fire at once.
                  const release = () => {
                    if (Date.now() < hold.until) return void setTimeout(release, 200)
                    Promise.resolve(cb(m)).then(resolve, reject)
                  }
                  setTimeout(release, 200)
                })
              }
              return cb(m)
            })
        },
      })
    },
  }
}

function makeEngine(name: string, marmot: MarmotModule, tuning: { linkTimeoutMs?: number; repliedLinkTtlMs?: number }): IlchonEngine {
  return createEngine(
    {
      storage: nodeStorage(`link-late:${name}`).storage,
      marmot,
      match: matchCrypto,
      connect: connectModule as ConnectModule,
      rates: createRatesSource(),
      // Never called here: the real module, so the deps are the app's.
      lnurl: createLnurl(),
      relays: RELAYS,
      namespace: `link-late:${name}`,
      persistence: 'memory',
      autoIdentity: true,
      tuning,
    },
    { defaultLang: 'en' },
  )
}

async function run(label: string, repliedLinkTtlMs: number | undefined): Promise<{ inviterHas: boolean; inviteeHas: boolean; waitingShown: boolean }> {
  const hold: Hold = { until: 0, passFirstHello: true, passedFirstHello: false }
  const marmot = holdingMarmot(hold)
  const tuning = { linkTimeoutMs: LINK_TIMEOUT_MS, repliedLinkTtlMs }
  const x = makeEngine(`${label}-x`, marmot, tuning)
  const y = makeEngine(`${label}-y`, marmot, tuning)
  const st = (e: IlchonEngine): IlchonState => e.store.getState()
  try {
    // start() waits as long as there is no connection: bounded here.
    await Promise.race([Promise.all([x.start(), y.start()]), sleep(BOOT_MS)])
    const booted = await waitFor(() => st(x).boot === 'ready' && st(y).boot === 'ready', BOOT_MS)
    check(`${label}: both engines ready`, booted)
    if (!booted) return { inviterHas: false, inviteeHas: false, waitingShown: false }

    const xPk = st(x).me!.pubkey
    const yPk = st(y).me!.pubkey
    const [inviter, invitee, inviterPk, inviteePk] = xPk < yPk ? [x, y, xPk, yPk] : [y, x, yPk, xPk]
    hold.holder = inviteePk
    hold.from = inviterPk
    hold.until = Date.now() + HOLD_MS

    inviter.actions.startConnect()
    invitee.actions.startConnect()
    const inviterQr = st(inviter).connect.myPayload ?? ''
    const inviteeQr = st(invitee).connect.myPayload ?? ''
    await invitee.actions.submitScan(inviterQr)
    await sleep(1000)
    await inviter.actions.submitScan(inviteeQr)

    const inviterGotIt = await waitFor(() => st(inviter).contacts.some((c) => c.pubkey === inviteePk), 60_000)
    check(`${label}: inviter made the contact (it got the reply)`, inviterGotIt)

    // Past the link timeout while the confirmation is still held back.
    await sleep(Math.max(0, LINK_TIMEOUT_MS + 2_000))
    const waitingShown = st(invitee).connect.waitingPeer === true

    // Release, then give the confirmation time to arrive.
    await waitFor(() => Date.now() > hold.until, HOLD_MS + 5_000)
    await waitFor(() => st(invitee).contacts.some((c) => c.pubkey === inviterPk), 30_000)
    const ci = st(inviter).contacts.find((c) => c.pubkey === inviteePk)
    const ce = st(invitee).contacts.find((c) => c.pubkey === inviterPk)
    // A room of null (none on this device yet) is never "the same".
    if (ci && ce) check(`${label}: both sides on the same group`, !!ci.groupId && ci.groupId === ce.groupId)
    return { inviterHas: !!ci, inviteeHas: !!ce, waitingShown }
  } finally {
    await Promise.allSettled([x.stop(), y.stop()])
  }
}

async function linkBoth(inviter: IlchonEngine, invitee: IlchonEngine): Promise<void> {
  const st = (e: IlchonEngine): IlchonState => e.store.getState()
  inviter.actions.cancelConnect()
  invitee.actions.cancelConnect()
  inviter.actions.startConnect()
  invitee.actions.startConnect()
  const inviterQr = st(inviter).connect.myPayload ?? ''
  const inviteeQr = st(invitee).connect.myPayload ?? ''
  await invitee.actions.submitScan(inviterQr)
  await sleep(1000)
  await inviter.actions.submitScan(inviteeQr)
}

async function runRescan(): Promise<{ firstFailedOnInviter: boolean; inviterHas: boolean; inviteeHas: boolean }> {
  const hold: Hold = { until: 0, passFirstHello: false, passedFirstHello: false }
  const marmot = holdingMarmot(hold)
  const tuning = { linkTimeoutMs: LINK_TIMEOUT_MS }
  const x = makeEngine('rescan-x', marmot, tuning)
  const y = makeEngine('rescan-y', marmot, tuning)
  const st = (e: IlchonEngine): IlchonState => e.store.getState()
  try {
    // start() waits as long as there is no connection: bounded here.
    await Promise.race([Promise.all([x.start(), y.start()]), sleep(BOOT_MS)])
    const booted = await waitFor(() => st(x).boot === 'ready' && st(y).boot === 'ready', BOOT_MS)
    check('rescan: both engines ready', booted)
    if (!booted) return { firstFailedOnInviter: false, inviterHas: false, inviteeHas: false }
    const xPk = st(x).me!.pubkey
    const yPk = st(y).me!.pubkey
    const [inviter, invitee, inviterPk, inviteePk] = xPk < yPk ? [x, y, xPk, yPk] : [y, x, yPk, xPk]
    // The inviter does not hear the invitee's reply until after its own timeout.
    hold.holder = inviterPk
    hold.from = inviteePk
    hold.until = Date.now() + HOLD_MS
    await linkBoth(inviter, invitee)
    const firstFailedOnInviter = await waitFor(() => st(inviter).connect.phase === 'failed' && !st(inviter).contacts.some((c) => c.pubkey === inviteePk), 40_000)
    await waitFor(() => Date.now() > hold.until + 3_000, HOLD_MS + 10_000)
    // Both scan each other again, with nothing held back.
    await linkBoth(inviter, invitee)
    await waitFor(() => st(inviter).contacts.some((c) => c.pubkey === inviteePk) && st(invitee).contacts.some((c) => c.pubkey === inviterPk), 60_000)
    return {
      firstFailedOnInviter,
      inviterHas: st(inviter).contacts.some((c) => c.pubkey === inviteePk),
      inviteeHas: st(invitee).contacts.some((c) => c.pubkey === inviterPk),
    }
  } finally {
    await Promise.allSettled([x.stop(), y.stop()])
  }
}

/** Both sides have the contact, on the same group. */
function linkedOnSameGroup(a: IlchonEngine, b: IlchonEngine, aPk: string, bPk: string): { both: boolean; same: boolean } {
  const ca = a.store.getState().contacts.find((c) => c.pubkey === bPk)
  const cb = b.store.getState().contacts.find((c) => c.pubkey === aPk)
  return { both: !!ca && !!cb, same: !!ca && !!cb && !!ca.groupId && ca.groupId === cb.groupId }
}

/**
 * The inviter got the reply and made the contact, but its confirmation is held
 * from the invitee. Both scan each other again: the inviter is already linked
 * and its screen says 'already'; the invitee starts over (the
 * earlier replied link and its room go, there is no `prior`). As
 * the higher key it asks the inviter for a room after 10 s; the inviter makes
 * one, sends its proof there, and the invitee completes in that new room. The
 * inviter's messages to the invitee stay held until releaseAfterRescanMs after
 * the rescan: before the request ('prior') or after it ('fallback'). Default
 * link timeouts here: the rescan's request comes 10 s after the scan.
 */
async function runPrior(label: string, releaseAfterRescanMs: number): Promise<{ both: boolean; same: boolean; newRoom: boolean; inviterSaidAlready: boolean }> {
  const hold: Hold = { until: Number.MAX_SAFE_INTEGER, passFirstHello: true, passedFirstHello: false }
  const marmot = holdingMarmot(hold)
  const x = makeEngine(`${label}-x`, marmot, {})
  const y = makeEngine(`${label}-y`, marmot, {})
  const st = (e: IlchonEngine): IlchonState => e.store.getState()
  try {
    // start() waits as long as there is no connection: bounded here.
    await Promise.race([Promise.all([x.start(), y.start()]), sleep(BOOT_MS)])
    const booted = await waitFor(() => st(x).boot === 'ready' && st(y).boot === 'ready', BOOT_MS)
    check(`${label}: both engines ready`, booted)
    if (!booted) return { both: false, same: false, newRoom: false, inviterSaidAlready: false }
    const xPk = st(x).me!.pubkey
    const yPk = st(y).me!.pubkey
    const [inviter, invitee, inviterPk, inviteePk] = xPk < yPk ? [x, y, xPk, yPk] : [y, x, yPk, xPk]
    hold.holder = inviteePk
    hold.from = inviterPk
    await linkBoth(inviter, invitee)
    check(`${label}: inviter made the contact`, await waitFor(() => st(inviter).contacts.some((c) => c.pubkey === inviteePk), 60_000))
    const first = st(inviter).contacts.find((c) => c.pubkey === inviteePk)?.groupId ?? null
    await sleep(LINK_TIMEOUT_MS + 2_000)
    // Both scan again; the inviter, already linked, says 'already'.
    await linkBoth(inviter, invitee)
    const inviterSaidAlready = st(inviter).connect.phase === 'already'
    hold.until = Date.now() + releaseAfterRescanMs
    // The request after 10 s, the inviter's gap of a minute after its last room, the link.
    await waitFor(() => st(invitee).contacts.some((c) => c.pubkey === inviterPk), releaseAfterRescanMs + 120_000)
    const r = linkedOnSameGroup(inviter, invitee, inviterPk, inviteePk)
    const now = st(inviter).contacts.find((c) => c.pubkey === inviteePk)?.groupId ?? null
    return { ...r, newRoom: !!now && now !== first, inviterSaidAlready }
  } finally {
    await Promise.allSettled([x.stop(), y.stop()])
  }
}

async function main(): Promise<void> {
  const started = Date.now()
  // Control: the replied invitee gives up after the link timeout, like before the fix.
  const control = await run('control', LINK_TIMEOUT_MS)
  check('control: reproduces the bug (contact on the inviter only)', control.inviterHas && !control.inviteeHas, `inviter=${control.inviterHas} invitee=${control.inviteeHas}`)

  const fixed = await run('fixed', undefined)
  check('fixed: contact on both sides after a late confirmation', fixed.inviterHas && fixed.inviteeHas, `inviter=${fixed.inviterHas} invitee=${fixed.inviteeHas}`)
  check('fixed: invitee screen says only the confirmation is missing', fixed.waitingShown)

  const rescan = await runRescan()
  check('rescan: the first attempt failed on the inviter (setup)', rescan.firstFailedOnInviter)
  check('rescan: scanning again links both sides', rescan.inviterHas && rescan.inviteeHas, `inviter=${rescan.inviterHas} invitee=${rescan.inviteeHas}`)

  const heldBefore = held
  const prior = await runPrior('prior', 3_000)
  check('prior: confirmations were really held back (harness)', held > heldBefore, `held=${held - heldBefore}`)
  check("prior: the inviter's screen says 'already' (setup)", prior.inviterSaidAlready)
  check('prior: the invitee completes by scanning again', prior.both)
  check('prior: both sides on the same group, the new one the inviter made', prior.same && prior.newRoom)

  const heldBeforeFallback = held
  const fallback = await runPrior('fallback', LINK_TIMEOUT_MS + 6_000)
  check('fallback: confirmations were really held back (harness)', held > heldBeforeFallback, `held=${held - heldBeforeFallback}`)
  check("fallback: the inviter's screen says 'already' (setup)", fallback.inviterSaidAlready)
  check('fallback: the invitee completes although the inviter was held past its request', fallback.both)
  check('fallback: both sides on the same group, the new one the inviter made', fallback.same && fallback.newRoom)

  console.log(failed ? `\n${failed} failed in ${Date.now() - started} ms` : `\nall passed in ${Date.now() - started} ms`)
  process.exit(failed ? 1 : 0)
}

void main()
