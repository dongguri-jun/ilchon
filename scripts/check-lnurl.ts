/**
 * Checks src/lib/lnurl against a fake fetch: no request leaves this machine.
 * Run: pnpm check:lnurl
 *
 * Invoices are hand-built with scripts/invoice-fixture.ts (signature zeros; the
 * reader does not check signatures).
 */
import { sha256 } from '@noble/hashes/sha2.js'
import { utf8ToBytes } from '@noble/hashes/utils.js'
import { bech32 } from '@scure/base'
import { createLnurl, LnurlFailure, LNURL_TIMEOUT_MS, MAX_BODY_BYTES, MAX_METADATA_BYTES } from '../src/lib/lnurl/index'
import { buildInvoice, intWords, tagged } from './invoice-fixture'

let failed = 0
function check(name: string, ok: boolean, detail = ''): void {
  if (ok) console.log(`PASS ${name}`)
  else {
    failed++
    console.log(`FAIL ${name}${detail ? ` — ${detail}` : ''}`)
  }
}

const NOW_MS = 1_800_000_000_000
const NOW_S = NOW_MS / 1000
const now = () => NOW_MS

const ADDRESS = 'alice@example.com'
const FIRST_URL = 'https://example.com/.well-known/lnurlp/alice'
const CALLBACK = 'https://pay.example.net/cb?k=1'
const SATS = 30_000
const MSAT = 30_000_000
const INVOICE_URL = 'https://pay.example.net/cb?k=1&amount=30000000'
const METADATA = JSON.stringify([
  ['text/plain', 'Pay alice'],
  ['text/identifier', ADDRESS],
])

const hashWords = (text: string) => bech32.toWords(sha256(utf8ToBytes(text)))
const hField = (text: string) => tagged(23, hashWords(text))
/** 30,000 sats = 300u. */
const invoice = (hrp = 'lnbc300u', fields: number[][] = [hField(METADATA)], createdAt = NOW_S) => buildInvoice(hrp, createdAt, fields)

// ---------------------------------------------------------------- fake fetch

type Reply = Response | (() => Response | Promise<Response>) | Error | 'hang'
interface Call {
  url: string
  init: RequestInit
}

const json = (v: unknown, status = 200) => new Response(JSON.stringify(v), { status, headers: { 'content-type': 'application/json' } })
const payRequest = (over: Record<string, unknown> = {}) => json({ tag: 'payRequest', callback: CALLBACK, minSendable: 1_000, maxSendable: 100_000_000_000, metadata: METADATA, ...over })

function fakeFetch(routes: Record<string, Reply>) {
  const calls: Call[] = []
  const f = ((input: RequestInfo | URL, init: RequestInit = {}) => {
    const url = String(input)
    calls.push({ url, init })
    const reply = routes[url]
    if (reply === undefined) return Promise.reject(new TypeError(`no route ${url}`))
    if (reply === 'hang') {
      // Never answers; rejects once aborted, like a real fetch.
      return new Promise<Response>((_, reject) => {
        init.signal?.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')))
      })
    }
    if (reply instanceof Error) return Promise.reject(reply)
    return Promise.resolve(typeof reply === 'function' ? reply() : reply)
  }) as typeof fetch
  return { f, calls }
}

/** Runs `invoice` (or `check`) and returns the string or the failure. */
async function run(routes: Record<string, Reply>, opts: { sats?: number; address?: string; only?: 'check'; timeoutMs?: number } = {}) {
  const { f, calls } = fakeFetch(routes)
  const ln = createLnurl({ fetch: f, timeoutMs: opts.timeoutMs ?? 50, now })
  try {
    const value = opts.only === 'check' ? await ln.check(opts.address ?? ADDRESS) : await ln.invoice(opts.address ?? ADDRESS, opts.sats ?? SATS)
    return { value, err: null as LnurlFailure | null, calls }
  } catch (e) {
    return { value: null, err: e as LnurlFailure, calls }
  }
}

const happy = (pr: string | Reply, first: Reply = payRequest()): Record<string, Reply> => ({
  [FIRST_URL]: first,
  [INVOICE_URL]: typeof pr === 'string' ? json({ pr, routes: [] }) : pr,
})

async function expectCode(name: string, routes: Record<string, Reply>, code: string, opts: Parameters<typeof run>[1] = {}) {
  const r = await run(routes, opts)
  check(`${name} -> ${code}`, r.err instanceof LnurlFailure && r.err.code === code && r.err.message === code, r.err ? String(r.err) : `value ${String(r.value).slice(0, 20)}`)
  return r
}

async function main() {
  // ---------------------------------------------------------------- address parsing (LUD-16)

  const ln = createLnurl({ fetch: fakeFetch({}).f, now })
  const ok: Array<[string, string]> = [
    ['alice@example.com', 'alice@example.com'],
    ['a.b+c_d-e@sub.example.co.kr', 'a.b+c_d-e@sub.example.co.kr'],
    ['x@xn--p1ai.example', 'x@xn--p1ai.example'],
    [' Alice@Example.COM ', 'alice@example.com'],
    ['ａｌｉｃｅ＠ｅｘａｍｐｌｅ．ｃｏｍ', 'alice@example.com'],
  ]
  for (const [input, want] of ok) check(`address ${JSON.stringify(input)} -> ${want}`, ln.parseAddress(input) === want, String(ln.parseAddress(input)))
  const bad = [
    '@example.com',
    'alice@',
    'alice@localhost',
    'alice@1.2.3.44',
    'alice@example.onion',
    'al ice@example.com',
    `${'a'.repeat(65)}@example.com`,
    'alice@printer.local',
    'alice@box.internal',
    'alice@router.lan',
    'alice@nas.home.arpa',
    'alice@app.localhost',
    'alicé@example.com',
    'alice@exämple.com',
    'alice@example.c',
    'alice@[127.0.0.1]',
    'alice@example.com/path',
    'alice@@example.com',
    'Not An Address',
    '',
  ]
  for (const input of bad) check(`address ${JSON.stringify(input.slice(0, 30))} -> null`, ln.parseAddress(input) === null)
  check(`address with 64-character name passes`, ln.parseAddress(`${'a'.repeat(64)}@example.com`) !== null)

  // ---------------------------------------------------------------- success

  {
    const r = await run(happy(invoice()))
    check('success: returns the invoice', r.value === invoice(), String(r.err))
    check('success: first URL is exact', r.calls[0]?.url === FIRST_URL, r.calls[0]?.url)
    check('success: invoice URL keeps the callback query and adds amount in msat', r.calls[1]?.url === INVOICE_URL, r.calls[1]?.url)
    check('success: two requests only', r.calls.length === 2)
    for (const [i, c] of r.calls.entries()) {
      const h = new Headers(c.init.headers)
      check(
        `request ${i + 1}: GET, credentials omit, redirect error, no-store, accept json, signal`,
        c.init.method === 'GET' &&
          c.init.credentials === 'omit' &&
          c.init.redirect === 'error' &&
          c.init.cache === 'no-store' &&
          h.get('accept') === 'application/json' &&
          c.init.signal instanceof AbortSignal,
        JSON.stringify(c.init),
      )
    }
  }
  {
    const upper = invoice().toUpperCase()
    const r = await run(happy(upper))
    check('success: upper-case invoice comes back lowercased', r.value === upper.toLowerCase(), String(r.err))
  }
  {
    const r = await run(happy(invoice('lnbc300u', [])))
    check('success: invoice without h passes (amount, network, expiry still checked)', r.value === invoice('lnbc300u', []), String(r.err))
  }
  {
    const r = await run(happy(invoice('lnbc300u', [hField(METADATA), tagged(6, intWords(86_400, 4))])))
    check('success: long expiry passes', typeof r.value === 'string', String(r.err))
  }
  {
    const cb = 'https://pay.example.net/cb'
    const r = await run({ [FIRST_URL]: payRequest({ callback: cb }), [`${cb}?amount=${MSAT}`]: json({ pr: invoice() }) })
    check('callback without a query gets ?amount=', r.value === invoice(), r.calls[1]?.url)
  }
  {
    const cb = 'https://other-service.example.org/lnurl/cb?k=1'
    const r = await run({ [FIRST_URL]: payRequest({ callback: cb }), [`${cb}&amount=${MSAT}`]: json({ pr: invoice() }) })
    check('callback on another domain than the address is allowed', r.value === invoice(), String(r.err))
  }
  {
    const r = await run({ [FIRST_URL]: payRequest({ callback: 'https://pay.example.net/cb?amount=1' }), ['https://pay.example.net/cb?amount=30000000']: json({ pr: invoice() }) })
    check("callback's own amount= is replaced, not doubled", r.value === invoice(), r.calls[1]?.url)
  }

  // ---------------------------------------------------------------- mismatch: the invoice is not what was asked

  await expectCode('invoice 1 msat more', happy(invoice('lnbc300000010p')), 'mismatch')
  await expectCode('invoice 1 msat less', happy(invoice('lnbc299999990p')), 'mismatch')
  await expectCode('invoice for 10x the amount', happy(invoice('lnbc3m')), 'mismatch')
  await expectCode('invoice without an amount', happy(invoice('lnbc')), 'mismatch')
  await expectCode('testnet invoice (lntb)', happy(invoice('lntb300u')), 'mismatch')
  await expectCode('signet invoice (lntbs)', happy(invoice('lntbs300u')), 'mismatch')
  await expectCode('regtest invoice (lnbcrt)', happy(invoice('lnbcrt300u')), 'mismatch')
  await expectCode('expired invoice', happy(invoice('lnbc300u', [hField(METADATA)], NOW_S - 4_000)), 'mismatch')
  await expectCode('invoice with 100 s left', happy(invoice('lnbc300u', [hField(METADATA)], NOW_S - 3_500)), 'mismatch')
  await expectCode('invoice with exactly 120 s left', happy(invoice('lnbc300u', [hField(METADATA)], NOW_S - 3_480)), 'mismatch')
  {
    const r = await run(happy(invoice('lnbc300u', [hField(METADATA)], NOW_S - 3_479)))
    check('invoice with 121 s left passes', typeof r.value === 'string', String(r.err))
  }
  await expectCode('h of other text', happy(invoice('lnbc300u', [hField('something else')])), 'mismatch')
  await expectCode('h of metadata with one byte changed', happy(invoice('lnbc300u', [hField(METADATA.replace('alice', 'alicf'))])), 'mismatch')
  await expectCode('pr is not an invoice', happy('hello'), 'mismatch')
  await expectCode('pr longer than 4,096 characters', happy(`${invoice()}${'q'.repeat(4_100)}`), 'mismatch')

  // ---------------------------------------------------------------- refused: the service said no or answered nonsense

  await expectCode('first step HTTP 404', { [FIRST_URL]: new Response('not found', { status: 404 }) }, 'refused')
  await expectCode('first step HTTP 500', { [FIRST_URL]: json({}, 500) }, 'refused')
  await expectCode('first step not JSON', { [FIRST_URL]: new Response('<html>hi</html>') }, 'refused')
  await expectCode('first step JSON array', { [FIRST_URL]: json([1, 2]) }, 'refused')
  await expectCode('first step JSON null', { [FIRST_URL]: json(null) }, 'refused')
  await expectCode('first step body not UTF-8', { [FIRST_URL]: new Response(new Uint8Array([0x7b, 0xff, 0x7d])) }, 'refused')
  {
    const r = await expectCode('first step status ERROR', { [FIRST_URL]: json({ status: 'ERROR', reason: 'secret server text' }) }, 'refused')
    check("the server's reason is not in the error", !String(r.err).includes('secret') && !JSON.stringify(r.err).includes('secret'))
  }
  await expectCode('tag is not payRequest', { [FIRST_URL]: payRequest({ tag: 'withdrawRequest' }) }, 'refused')
  await expectCode('callback is http:', { [FIRST_URL]: payRequest({ callback: 'http://pay.example.net/cb' }) }, 'refused')
  await expectCode('callback missing', { [FIRST_URL]: payRequest({ callback: undefined }) }, 'refused')
  await expectCode('callback not a URL', { [FIRST_URL]: payRequest({ callback: 'not a url' }) }, 'refused')
  await expectCode('minSendable > maxSendable', { [FIRST_URL]: payRequest({ minSendable: 2_000, maxSendable: 1_000 }) }, 'refused')
  await expectCode('minSendable 0', { [FIRST_URL]: payRequest({ minSendable: 0 }) }, 'refused')
  await expectCode('minSendable a string', { [FIRST_URL]: payRequest({ minSendable: '1000' }) }, 'refused')
  await expectCode('maxSendable not a safe integer', { [FIRST_URL]: payRequest({ maxSendable: 2 ** 60 }) }, 'refused')
  await expectCode('metadata missing', { [FIRST_URL]: payRequest({ metadata: undefined }) }, 'refused')
  await expectCode('metadata not a string', { [FIRST_URL]: payRequest({ metadata: [['text/plain', 'x']] }) }, 'refused')
  {
    const exact = JSON.stringify([['text/plain', 'x'.repeat(MAX_METADATA_BYTES - 19)]])
    check('fixture: metadata of exactly 8 KiB', utf8ToBytes(exact).length === MAX_METADATA_BYTES, String(utf8ToBytes(exact).length))
    const r = await run({ [FIRST_URL]: payRequest({ metadata: exact }), [INVOICE_URL]: json({ pr: invoice('lnbc300u', [hField(exact)]) }) })
    check('metadata of exactly 8 KiB passes', typeof r.value === 'string', String(r.err))
    await expectCode('metadata of 8 KiB + 1 byte', { [FIRST_URL]: payRequest({ metadata: exact.replace('x', 'xx') }) }, 'refused')
    const multibyte = JSON.stringify([['text/plain', '가'.repeat(2_800)]]) // under 8,192 characters, over 8 KiB in UTF-8
    check('fixture: multibyte metadata is under 8,192 chars but over 8 KiB', multibyte.length < 8_192 && utf8ToBytes(multibyte).length > MAX_METADATA_BYTES)
    await expectCode('metadata over 8 KiB counted in UTF-8 bytes', { [FIRST_URL]: payRequest({ metadata: multibyte }) }, 'refused')
  }
  {
    const pad = 'x'.repeat(MAX_BODY_BYTES)
    await expectCode('first step body over 64 KiB (stream)', { [FIRST_URL]: () => payRequest({ pad }) }, 'refused')
    const big = new Response(JSON.stringify({ tag: 'payRequest', pad }), { headers: { 'content-length': String(MAX_BODY_BYTES + 100) } })
    await expectCode('first step declares a body over 64 KiB', { [FIRST_URL]: big }, 'refused')
    await expectCode(
      'invoice step body over 64 KiB',
      happy(() => json({ pr: invoice(), pad })),
      'refused',
    )
    // A body that is just under the cap is read.
    const under = 'x'.repeat(MAX_BODY_BYTES - 400)
    const r = await run(happy(invoice(), () => payRequest({ under })))
    check('first step body just under 64 KiB is read', typeof r.value === 'string', String(r.err))
  }
  await expectCode(
    'invoice step status ERROR',
    happy(() => json({ status: 'ERROR', reason: 'no route' })),
    'refused',
  )
  await expectCode(
    'invoice step HTTP 400',
    happy(() => json({ pr: invoice() }, 400)),
    'refused',
  )
  await expectCode(
    'invoice step pr missing',
    happy(() => json({ routes: [] })),
    'refused',
  )
  await expectCode(
    'invoice step pr not a string',
    happy(() => json({ pr: 42 })),
    'refused',
  )
  await expectCode(
    'invoice step not JSON',
    happy(() => new Response('ok')),
    'refused',
  )

  // ---------------------------------------------------------------- callback host rule: never sent to a private host

  const PRIVATE_CALLBACKS = [
    'https://127.0.0.1/cb',
    'https://10.0.0.1/cb',
    'https://192.168.0.1/cb',
    'https://169.254.169.254/latest',
    'https://[::1]/cb',
    'https://[fd00::1]/cb',
    'https://0x7f.1/cb',
    'https://2130706433/cb',
    'https://localhost/cb',
    'https://localhost:8080/cb',
    'https://router/cb',
    'https://router.local/cb',
    'https://nas.home.arpa/cb',
    'https://svc.internal/cb',
    'https://box.lan/cb',
    'https://app.localhost/cb',
    'https://abcdefghijklmnop.onion/cb',
    'https://localhost./cb',
    'https://localhost../cb',
    'https://printer.local./cb',
    'https://x.onion./cb',
    'https://svc.internal./cb',
    'https://router./cb',
    'https://user:pw@pay.example.net/cb',
    'ftp://pay.example.net/cb',
    'javascript:alert(1)',
  ]
  for (const cb of PRIVATE_CALLBACKS) {
    const r = await expectCode(`callback ${cb}`, { [FIRST_URL]: payRequest({ callback: cb }) }, 'refused')
    check(`callback ${cb}: no second request`, r.calls.length === 1)
  }

  // ---------------------------------------------------------------- range

  const RANGE = { minSendable: 1_000_000, maxSendable: 50_000_000 }
  for (const sats of [500, 60_000]) {
    const r = await expectCode(`${sats} sats against 1,000-50,000`, { [FIRST_URL]: payRequest(RANGE) }, 'range', { sats })
    check(`${sats} sats: minSats 1000, maxSats 50000, no invoice request`, r.err?.minSats === 1_000 && r.err?.maxSats === 50_000 && r.calls.length === 1, JSON.stringify(r.err))
  }
  {
    const r = await expectCode('min 1,000,500 msat rounds up to 1001 sats', { [FIRST_URL]: payRequest({ minSendable: 1_000_500, maxSendable: 50_000_999 }) }, 'range', { sats: 1 })
    check('minSats is ceil, maxSats is floor', r.err?.minSats === 1_001 && r.err?.maxSats === 50_000, JSON.stringify(r.err))
  }
  for (const sats of [1_000, 50_000]) {
    const hrp = sats === 1_000 ? 'lnbc10u' : 'lnbc500u'
    const cbUrl = `https://pay.example.net/cb?k=1&amount=${sats * 1000}`
    const r = await run({ [FIRST_URL]: payRequest(RANGE), [cbUrl]: json({ pr: invoice(hrp) }) }, { sats })
    check(`${sats} sats at the edge of the range passes`, typeof r.value === 'string', String(r.err))
  }
  for (const sats of [0, -5, 1.5, Number.NaN]) {
    await expectCode(`sats ${sats}`, { [FIRST_URL]: payRequest() }, 'range', { sats })
  }

  // ---------------------------------------------------------------- unreachable

  await expectCode('fetch throws TypeError (network, CORS, offline)', { [FIRST_URL]: new TypeError('Failed to fetch') }, 'unreachable')
  {
    // With redirect: 'error' a browser's fetch rejects with TypeError on any redirect.
    const { f, calls } = fakeFetch({})
    const redirecting = ((input: RequestInfo | URL, init: RequestInit = {}) => {
      calls.push({ url: String(input), init })
      return init.redirect === 'error' ? Promise.reject(new TypeError('unexpected redirect')) : f(input, init)
    }) as typeof fetch
    const lnr = createLnurl({ fetch: redirecting, timeoutMs: 50, now })
    let code = ''
    try {
      await lnr.check(ADDRESS)
    } catch (e) {
      code = (e as LnurlFailure).code
    }
    check('redirect (fetch rejects under redirect: error) -> unreachable', code === 'unreachable' && calls[0]?.init.redirect === 'error', code)
  }
  await expectCode('a 302 response that slipped through -> unreachable', { [FIRST_URL]: new Response(null, { status: 302, headers: { location: 'https://evil.example/' } }) }, 'unreachable')
  {
    // A plain object shaped like a Response: a real one cannot be built with redirected = true.
    const redirected = { ok: true, status: 200, redirected: true, type: 'basic', headers: new Headers(), body: null, arrayBuffer: async () => new TextEncoder().encode('{}').buffer }
    await expectCode('a response marked redirected -> unreachable', { [FIRST_URL]: redirected as unknown as Response }, 'unreachable')
  }
  await expectCode('invoice step fetch throws', happy(new TypeError('Failed to fetch')), 'unreachable')
  {
    const t0 = Date.now()
    await expectCode('fetch never answers', { [FIRST_URL]: 'hang' }, 'unreachable')
    const took = Date.now() - t0
    check('... gives up after timeoutMs (50 ms), not much later', took >= 40 && took < 1_000, `${took} ms`)
  }
  {
    const slow = () => new Promise<Response>((resolve) => setTimeout(() => resolve(payRequest()), 200))
    await expectCode('answer after 200 ms against 50 ms', { [FIRST_URL]: slow }, 'unreachable')
  }
  {
    // Headers arrive at once, the body never ends.
    const stalled = () =>
      new Response(
        new ReadableStream({
          start(c) {
            c.enqueue(new TextEncoder().encode('{"tag":'))
          },
        }),
      )
    const t0 = Date.now()
    await expectCode('body that never ends', { [FIRST_URL]: stalled }, 'unreachable')
    check('... also within the time limit', Date.now() - t0 < 1_000)
  }
  await expectCode('invoice step never answers', { [FIRST_URL]: payRequest(), [INVOICE_URL]: 'hang' }, 'unreachable')
  check('default timeout is 6 s per request', LNURL_TIMEOUT_MS === 6_000)

  // ---------------------------------------------------------------- bad address never fetches

  {
    const r = await expectCode('bad address', {}, 'bad-address', { address: 'alice@localhost' })
    check('bad address: no request', r.calls.length === 0)
    const c = await expectCode('check with bad address', {}, 'bad-address', { address: 'Not An Address', only: 'check' })
    check('check with bad address: no request', c.calls.length === 0)
  }

  // ---------------------------------------------------------------- address host after URL normalisation
  // The regex only wants a letter in the last label, but the URL parser reads
  // a hex, octal or integer host as IPv4 (`127.0.0.0x1` -> 127.0.0.1). These
  // must be refused before any request leaves the device.

  const IP_SPELLINGS = [
    'u@127.0.0.0x1',
    'u@0x7f.0x1',
    'u@10.0.0.0xa',
    'u@192.168.1.0x1',
    'u@0177.0.0.1',
    'u@0177.0.0.0x1',
    'u@0x7f000001.0x',
    'u@2130706433',
    'u@0x7f000001',
    'u@[::1]',
    'u@[fd00::1]',
    'u@[::ffff:127.0.0.1]',
    '.@example.com',
    '..@example.com',
  ]
  for (const address of IP_SPELLINGS) {
    check(`address ${address} -> null`, ln.parseAddress(address) === null, String(ln.parseAddress(address)))
    const any = { [FIRST_URL]: payRequest(), [INVOICE_URL]: json({ pr: invoice() }) }
    const r = await expectCode(`invoice to ${address}`, any, 'bad-address', { address })
    check(`invoice to ${address}: fetch never called`, r.calls.length === 0, r.calls.map((c) => c.url).join(' '))
    const c = await expectCode(`check of ${address}`, any, 'bad-address', { address, only: 'check' })
    check(`check of ${address}: fetch never called`, c.calls.length === 0, c.calls.map((x) => x.url).join(' '))
  }
  {
    const r = await run(happy(invoice()), { address: 'alice@example.com' })
    check('control: an ordinary address still fetches the exact first URL and gets the invoice', r.value === invoice() && r.calls[0]?.url === FIRST_URL, String(r.err))
    const dotted = await run({ ['https://example.com/.well-known/lnurlp/a.b']: payRequest() }, { only: 'check', address: 'a.b@example.com' })
    check('control: a dotted name that is not . or .. still works', dotted.err === null && dotted.calls.length === 1, String(dotted.err))
  }

  // ---------------------------------------------------------------- check()

  {
    const r = await run({ [FIRST_URL]: payRequest() }, { only: 'check' })
    check('check: resolves on a good first step', r.err === null, String(r.err))
    check('check: one request, the first step only', r.calls.length === 1 && r.calls[0].url === FIRST_URL)
    const n = await run({ [FIRST_URL]: payRequest() }, { only: 'check', address: ' Alice@Example.COM ' })
    check('check: normalises the address before fetching', n.err === null && n.calls[0]?.url === FIRST_URL)
    await expectCode('check: callback http:', { [FIRST_URL]: payRequest({ callback: 'http://x.example/cb' }) }, 'refused', { only: 'check' })
    await expectCode('check: unreachable', { [FIRST_URL]: new TypeError('x') }, 'unreachable', { only: 'check' })
    const plus = await run({ ['https://example.com/.well-known/lnurlp/alice+tips']: payRequest() }, { only: 'check', address: 'alice+tips@example.com' })
    check('check: a +tag name goes into the path (LUD-16 tags)', plus.err === null, String(plus.err))
  }

  // ---------------------------------------------------------------- errors carry no address or invoice (support log)

  {
    const pr = invoice('lntb300u')
    const r = await run(happy(pr))
    const text = `${String(r.err)} ${JSON.stringify(r.err)} ${r.err?.stack ?? ''}`
    check('error text has no address, domain or invoice', !text.includes('alice') && !text.includes('example') && !text.includes(pr.slice(0, 20)), text.slice(0, 120))
  }

  console.log(failed ? `\n${failed} failed` : '\nall passed')
  process.exitCode = failed ? 1 : 0
}

void main()
