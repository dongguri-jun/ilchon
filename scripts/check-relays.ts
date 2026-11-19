/**
 * Checks the pure parts of src/lib/relays. Run: pnpm check:relays
 */
import { DEFAULT_RELAYS, LOOKUP_RELAYS } from '../src/contracts'
import { MAX_RELAYS, assessInfo, checkRelay, chosenRelayUrl, cleanRelayList, isDefaultList, normalizeRelayUrl, sharesDefault } from '../src/lib/relays/index'

let failed = 0
function check(name: string, ok: boolean, detail = ''): void {
  if (ok) console.log(`PASS ${name}`)
  else {
    failed++
    console.log(`FAIL ${name}${detail ? ` — ${detail}` : ''}`)
  }
}

// ---- URL normalisation

const cases: Array<[string, string | null]> = [
  ['wss://nostr.mom', 'wss://nostr.mom'],
  ['  WSS://Nostr.MOM/  ', 'wss://nostr.mom'],
  ['nostr.mom', 'wss://nostr.mom'],
  ['wss://relay.example.com/path/', 'wss://relay.example.com/path'],
  ['wss://relay.example.com:4443', 'wss://relay.example.com:4443'],
  ['ws://localhost:7777', 'ws://localhost:7777'],
  ['ws://relay.example.com', null],
  ['https://relay.example.com', null],
  ['wss://user:pw@relay.example.com', null],
  ['wss://relay.example.com/?x=1', null],
  ['wss://relay.example.com/#a', null],
  ['wss://localhostish', null],
  ['wss://[2001:db8::1]:7777', 'wss://[2001:db8::1]:7777'],
  ['ws://[::1]:7777', 'ws://[::1]:7777'],
  ['ws://[2001:db8::1]', null],
  ['', null],
  ['not a url', null],
]
for (const [input, want] of cases) {
  const got = normalizeRelayUrl(input)
  check(`normalize ${JSON.stringify(input)}`, got === want, `got ${got}`)
}
check('defaults are normalized and unique', new Set(DEFAULT_RELAYS.map(normalizeRelayUrl)).size === DEFAULT_RELAYS.length && DEFAULT_RELAYS.every((u) => normalizeRelayUrl(u) === u))
check(
  'lookup relays are normalized',
  LOOKUP_RELAYS.every((u) => normalizeRelayUrl(u) === u),
)
check('defaults have at least 2 relays', DEFAULT_RELAYS.length >= 2)
check('sharesDefault', sharesDefault(['wss://x.example', DEFAULT_RELAYS[0]]) && !sharesDefault(['wss://x.example', 'wss://y.example']))

// ---- the relay list I choose

function throws(fn: () => unknown): string {
  try {
    fn()
    return ''
  } catch (e) {
    return e instanceof Error ? e.message : String(e)
  }
}
const X = 'wss://x.example'
const Y = 'wss://y.example'
const Z = 'wss://z.example'
const defaults = [...DEFAULT_RELAYS]
check(
  'cleanRelayList: normalizes, drops repeats and invalid ones, keeps the order',
  JSON.stringify(cleanRelayList(['  WSS://Y.example/ ', X, 'y.example', 'not a url', 42, X], defaults)) === JSON.stringify([Y, X]),
)
check('cleanRelayList: one relay -> too-few-relays', throws(() => cleanRelayList([X], defaults)) === 'too-few-relays')
check('cleanRelayList: nothing -> too-few-relays', throws(() => cleanRelayList([], defaults)) === 'too-few-relays')
const nine = Array.from({ length: MAX_RELAYS + 1 }, (_, i) => `wss://r${i}.example`)
check('cleanRelayList: nine relays -> too-many-relays', throws(() => cleanRelayList(nine, defaults)) === 'too-many-relays')
check('cleanRelayList: eight relays are kept', cleanRelayList(nine.slice(0, MAX_RELAYS), defaults)?.length === MAX_RELAYS)
check('cleanRelayList: the defaults in another order -> null (stored as the defaults)', cleanRelayList([...defaults].reverse(), defaults) === null)
check('cleanRelayList: the defaults plus one is a choice', cleanRelayList([...defaults, X], defaults)?.length === defaults.length + 1)
const refused = [
  'ws://relay.example.com',
  'ws://localhost:7777',
  'wss://localhost:7777',
  'wss://127.0.0.1',
  'wss://10.0.0.5:7777',
  'wss://192.168.1.10',
  'wss://169.254.1.1',
  'wss://[::1]:7777',
  'wss://[fe80::1]',
  'wss://[2001:db8::1]:7777',
  'wss://relay.local',
  'wss://relay.internal',
  'wss://box.lan',
  'wss://nas.home.arpa',
  'wss://abcdefghij234567.onion',
  'wss://user:pass@relay.example.com',
  'wss://user@relay.example.com',
  `wss://${'a'.repeat(190)}.example`,
]
const passed = refused.filter((u) => chosenRelayUrl(u) !== null)
check('chosenRelayUrl: ws://, IP, localhost, link-local, private names, user info and long ones are refused', passed.length === 0, passed.join(', '))
check('chosenRelayUrl: a public wss relay passes', chosenRelayUrl('Relay.Example.com/') === 'wss://relay.example.com' && chosenRelayUrl(42) === null)
check('cleanRelayList: refused hosts are dropped, the rest kept', JSON.stringify(cleanRelayList([...refused, X, Z], defaults)) === JSON.stringify([X, Z]))
check('cleanRelayList: refused hosts leave fewer than two -> too-few-relays', throws(() => cleanRelayList(['wss://127.0.0.1', 'ws://localhost:7777', X], defaults)) === 'too-few-relays')
check('isDefaultList ignores order', isDefaultList([...DEFAULT_RELAYS].reverse()) && !isDefaultList(DEFAULT_RELAYS.slice(1)) && !isDefaultList([...DEFAULT_RELAYS, X]))
check(
  'the defaults pass the host rule',
  DEFAULT_RELAYS.every((u) => chosenRelayUrl(u) === u),
)

// ---- NIP-11 assessment

const good = assessInfo({ name: 'x', software: 'strfry', limitation: { max_subscriptions: 200, max_message_length: 131072 } })
check('good relay: no warnings', good.warnings.length === 0, JSON.stringify(good.warnings))
const primalLike = assessInfo({ limitation: { max_subscriptions: 20, max_message_length: 1_000_000 } })
check('20 subscriptions: warned', primalLike.warnings.includes('fewSubscriptions'))
const small = assessInfo({ limitation: { max_subscriptions: 300, max_message_length: 65_535 } })
check('64 KB messages: warned', small.warnings.includes('smallMessages'))
const gated = assessInfo({ limitation: { auth_required: true, payment_required: true, restricted_writes: true } })
check(
  'auth/payment/restricted: all warned',
  ['authRequired', 'paymentRequired', 'restrictedWrites'].every((w) => gated.warnings.includes(w as never)),
)
const missing = assessInfo({})
check('no limitation object: no warnings, unknown limits', missing.warnings.length === 0 && missing.maxSubscriptions === null && missing.maxMessageLength === null)
const junk = assessInfo({ name: 42, limitation: { max_subscriptions: '200' } } as never)
check('wrong types are ignored', junk.name === null && junk.maxSubscriptions === null)

// ---- checkRelay with a fake fetch (no network)

const seen: string[] = []
const fakeFetch = (async (url: string, init?: RequestInit) => {
  seen.push(`${url} ${(init?.headers as Record<string, string>)?.Accept}`)
  return new Response(JSON.stringify({ name: 'fake', limitation: { max_subscriptions: 20 } }), { status: 200 })
}) as typeof fetch
const r = await checkRelay('wss://relay.example.com', fakeFetch)
check('checkRelay: asks NIP-11 over https', seen[0] === 'https://relay.example.com application/nostr+json', seen[0])
check('checkRelay: reachable and warned', r.reachable && r.warnings.includes('fewSubscriptions') && r.name === 'fake')
const failing = (async () => new Response('no', { status: 404 })) as typeof fetch
const r2 = await checkRelay('wss://relay.example.com', failing)
check('checkRelay: unreachable -> noInfo', !r2.reachable && r2.warnings.join() === 'noInfo')
const rLocal = await checkRelay('ws://localhost:7777', async (url) => {
  seen.push(String(url))
  return new Response('{}', { status: 200 })
})
check('checkRelay: ws -> http', seen[seen.length - 1] === 'http://localhost:7777' && rLocal.reachable)

console.log(failed ? `\n${failed} failed` : '\nall passed')
process.exitCode = failed ? 1 : 0
