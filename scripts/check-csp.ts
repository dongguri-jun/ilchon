/**
 * Response headers and CSP.
 * No network, no build: reads public/_headers, index.html, public/ and src/.
 *
 *  H1  public/_headers follows the Cloudflare Pages format: a rule line is an unindented
 *      path (`/…`) or `https://…` URL, header lines are indented `Name: value`, `#` starts
 *      a comment, at most 2,000 characters a line and 100 rules, no header twice in a rule.
 *  H2  `/*` carries every header of the expected list, and exactly one CSP (enforced or
 *      Report-Only). No other rule repeats a `/*` header (Pages joins repeats with commas,
 *      which breaks a CSP).
 *  H3  The CSP itself: script-src only 'self' (no inline, no eval, no other host),
 *      object-src 'none', base-uri 'none', frame-ancestors 'none', form-action 'none',
 *      img-src without `https:` or `*` (no remote pictures), worker-src allows the QR
 *      scanner's blob worker; Permissions-Policy is exactly the app's feature list
 *      (camera for the page itself, the rest off).
 *  H4  Every URL literal in the app code (src/, not tests) fits the CSP: `http(s)://` and
 *      `ws(s)://` literals against connect-src, `<img src>` against img-src, CSS `url()`
 *      against font-src/img-src. Since connect-src is `'self' https: wss:`, this fails only
 *      on http:// and ws:// literals and on schemes outside it; a new https/wss origin
 *      passes without being listed. It also checks that the relay and rate hosts stay
 *      allowed and that plain http: is not.
 *  H5  index.html and public/ have no inline script, no inline event handler and no
 *      `javascript:` URL, and every `<script>` is a same-origin file.
 *  H6  Profile pictures: no `<img>` with a computed `src` in src/, the
 *      Nostr profile keeps no `picture`, and NIP-05 is not checked while loading a profile.
 *  H7  Lightning address lookups: the URLs src/lib/lnurl really
 *      requests (the LUD-16 first step on the address's domain, the callback on another
 *      domain) are allowed by connect-src, which is why it keeps `https:`. connect-src
 *      allows every https host, private ones included, so the module's own host rule is
 *      the guard: it never requests http, an IP address, localhost or a private name.
 *
 * Run: pnpm check:csp
 */
import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join, relative } from 'node:path'
import { allows, evalProblems, inlineProblems, parseCsp, parseHeaders } from './csp-lib'
import { buildInvoice } from './invoice-fixture'
import { createLnurl } from '../src/lib/lnurl'

let failed = 0
function pass(id: string, note: string) {
  console.log(`PASS  ${id}  ${note}`)
}
function fail(id: string, note: string) {
  failed++
  console.log(`FAIL  ${id}  ${note}`)
}
function check(id: string, problems: string[], ok: string) {
  if (problems.length) fail(id, problems.join('\n        '))
  else pass(id, ok)
}

// ---------- H0: the checks catch what they should ----------

{
  const h0: string[] = []
  const bad = parseHeaders('/*\n  A: 1\n  A: 2\nnot-a-rule\n  B: x\n  C\n' + '/x\n  D: ' + 'y'.repeat(2001) + '\n')
  if (bad.problems.length < 4) h0.push(`parseHeaders found ${bad.problems.length} of 4 problems: ${bad.problems.join('; ')}`)
  const good = parseHeaders('# c\n/*\n  A: 1\n  ! B\n\n/m\n  C: 2\n')
  if (good.problems.length || good.rules.length !== 2) h0.push(`parseHeaders on a good file: ${good.problems.join('; ')}`)
  const list = ["'self'", 'https:', 'wss:']
  const cases: [string, boolean][] = [
    ['/assets/a.js', true],
    ['https://api.kraken.com', true],
    ['wss://nos.lol', true],
    ['http://example.com', false],
    ['ws://localhost:7777', false],
    ['ftp://x.y', false],
  ]
  for (const [u, want] of cases) if (allows(list, u) !== want) h0.push(`allows(${u}) should be ${want}`)
  if (!allows(['*.example.com'], 'https://a.example.com') || allows(['*.example.com'], 'https://example.com')) h0.push('wildcard host matching')
  if (inlineProblems('t', '<script>alert(1)</script><a onclick="x()" href="javascript:void 0">').length !== 3) h0.push('inlineProblems misses an inline script, handler or javascript: URL')
  if (inlineProblems('t', '<script type="module" crossorigin src="/assets/i.js"></script>').length) h0.push('inlineProblems flags a same-origin script')
  if (evalProblems('t', 'x=eval("1");y=new Function("a","b");setTimeout("z()",1)').length !== 3) h0.push('evalProblems misses eval, new Function or a string timer')
  if (evalProblems('t', 'o={eval(a,u,h=!1){return a}};p.eval(1);setTimeout(()=>1)').length) h0.push('evalProblems flags a method or a function timer')
  for (const bad of ['globalThis.eval("1")', 'window.eval(s)', 'self . eval(s)', 'WebAssembly.instantiateStreaming(r)', 'WebAssembly.compileStreaming(r)', 'WebAssembly.instantiate(b)']) {
    if (evalProblems('t', bad).length !== 1) h0.push(`evalProblems misses ${bad}`)
  }
  for (const good of ['a.window.eval(1)', 'my.self.eval(1)', 'x.globalThis.eval(1)', 'q={eval(a,u){return u}}', 'evaluate(1)', 'WebAssemblyLike.compileStreaming(r)']) {
    if (evalProblems('t', good).length) h0.push(`evalProblems flags ${good}`)
  }
  check('H0', h0, 'parsers and matchers catch bad cases and pass good ones')
}

// ---------- H1: _headers format ----------

const headersText = readFileSync('public/_headers', 'utf8')
const { rules, problems: formatProblems } = parseHeaders(headersText)
check('H1', formatProblems, `public/_headers: ${rules.length} rules in the Cloudflare Pages format`)

// ---------- H2: required headers on /* ----------

const all = rules.find((r) => r.pattern === '/*')
const get = (name: string) => all?.headers.find((h) => h.name.toLowerCase() === name.toLowerCase())?.value
const h2: string[] = []
if (!all) h2.push('no /* rule')
const REQUIRED: Record<string, string> = {
  'X-Content-Type-Options': 'nosniff',
  'Referrer-Policy': 'no-referrer',
  'X-Frame-Options': 'DENY',
  'Cross-Origin-Opener-Policy': 'same-origin',
}
for (const [name, value] of Object.entries(REQUIRED)) {
  if (get(name) !== value) h2.push(`/* needs ${name}: ${value} (has ${get(name) ?? 'none'})`)
}
const enforced = get('Content-Security-Policy')
const reportOnly = get('Content-Security-Policy-Report-Only')
if (enforced && reportOnly) h2.push('/* has both Content-Security-Policy and Content-Security-Policy-Report-Only')
if (!enforced && !reportOnly) h2.push('/* has no Content-Security-Policy')
const csp = enforced ?? reportOnly ?? ''
if (all) {
  for (const r of rules) {
    if (r === all) continue
    for (const h of r.headers) {
      if (all.headers.some((a) => a.name.toLowerCase() === h.name.toLowerCase())) {
        h2.push(`line ${h.line}: ${h.name} is already on /*; Pages would join the two values`)
      }
    }
  }
}
check('H2', h2, `/* has the expected headers, CSP ${enforced ? 'enforced' : 'Report-Only (switch after the preview check)'}`)

// ---------- H3: the CSP ----------

const policy = parseCsp(csp)
const dir = (name: string): string[] => policy.get(name) ?? policy.get('default-src') ?? []
const same = (a: string[], b: string[]) => a.length === b.length && a.every((v) => b.includes(v))
const h3: string[] = []
const expectExact: Record<string, string[]> = {
  'default-src': ["'self'"],
  'script-src': ["'self'"],
  'object-src': ["'none'"],
  'base-uri': ["'none'"],
  'form-action': ["'none'"],
  'frame-ancestors': ["'none'"],
  'manifest-src': ["'self'"],
  'font-src': ["'self'"],
}
for (const [name, values] of Object.entries(expectExact)) {
  const has = policy.get(name)
  if (!has || !same(has, values)) h3.push(`${name} must be ${values.join(' ')} (has ${has?.join(' ') ?? 'none'})`)
}
const img = policy.get('img-src') ?? []
if (img.some((v) => v === 'https:' || v === 'http:' || v === '*' || /^https?:\/\//.test(v))) {
  h3.push(`img-src must not allow remote images: ${img.join(' ')}`)
}
if (!dir('worker-src').includes('blob:')) h3.push('worker-src needs blob: for the QR scanner worker')
for (const v of [...dir('script-src'), ...dir('style-src')]) {
  if (v === "'unsafe-eval'" || v === "'wasm-unsafe-eval'") h3.push(`${v} is not allowed`)
}
// Exactly the expected list. No interest-cohort: Chrome no longer knows the feature
// and logs an error on every load, which would muddy the Report-Only console check.
const PERMISSIONS = ['camera=(self)', 'microphone=()', 'geolocation=()', 'payment=()', 'usb=()', 'bluetooth=()']
const pp = (get('Permissions-Policy') ?? '')
  .split(',')
  .map((v) => v.trim())
  .filter(Boolean)
if (pp.length !== PERMISSIONS.length || PERMISSIONS.some((v, i) => pp[i] !== v)) {
  h3.push(`Permissions-Policy must be exactly ${PERMISSIONS.join(', ')} (has ${pp.join(', ') || 'none'})`)
}
check('H3', h3, `CSP: script-src 'self' only, no remote images, frames and plugins off; ${policy.size} directives`)

// ---------- source matching ----------

// ---------- H4: every URL in the code is allowed ----------

function walk(d: string, keep: (p: string) => boolean): string[] {
  return readdirSync(d).flatMap((name) => {
    const p = join(d, name)
    return statSync(p).isDirectory() ? walk(p, keep) : keep(p) ? [p] : []
  })
}
const srcFiles = walk('src', (p) => /\.(ts|tsx|css)$/.test(p) && !/\.test\.tsx?$/.test(p))

/** URLs that are names, not requests. */
const NOT_REQUESTS = new Set(['http://www.w3.org/2000/svg'])
/** Files whose URLs are only shown or matched, never requested. */
const NOT_REQUESTED_IN = new Map<string, string>([
  ['src/lib/bolt11/index.ts', 'a link in a comment'],
  ['src/lib/support-log/index.ts', 'an example in a comment'],
  ['src/screens/settings/RelaySettings.tsx', 'a placeholder in the relay field'],
  ['src/screens/settings/strings.ts', 'text that names the wss:// prefix'],
])

const h4: string[] = []
const seen = new Map<string, string[]>()
for (const f of srcFiles) {
  const rel = relative('.', f)
  const text = readFileSync(f, 'utf8')
  for (const m of text.matchAll(/\b(https?|wss?):\/\/(\$\{[^}]*\}|[A-Za-z0-9._~-]+(?::\d+)?)/g)) {
    const url = m[0]
    if (NOT_REQUESTS.has(url) || url === 'http://www.w3.org') continue
    if (NOT_REQUESTED_IN.has(rel)) continue
    const target = url.includes('${') ? `${m[1]}://dynamic.invalid` : url
    const list = seen.get(url) ?? []
    list.push(rel)
    seen.set(url, list)
    if (!allows(dir('connect-src'), target)) h4.push(`${rel}: ${url} is not in connect-src (${dir('connect-src').join(' ')})`)
  }
  if (f.endsWith('.tsx')) {
    for (const m of text.matchAll(/<img\b[^>]*?\bsrc=("([^"]*)"|'([^']*)')/g)) {
      const src = m[2] ?? m[3]
      if (!allows(dir('img-src'), src)) h4.push(`${rel}: <img src="${src}"> is not in img-src`)
    }
  }
  if (f.endsWith('.css')) {
    for (const m of text.matchAll(/url\(\s*['"]?([^'")]+)['"]?\s*\)/g)) {
      const u = m[1]
      if (u.startsWith('data:')) continue
      const list = /\.(woff2?|ttf|otf)(\?|$)/.test(u) ? dir('font-src') : dir('img-src')
      if (!allows(list, u)) h4.push(`${rel}: url(${u}) is not allowed by the CSP`)
    }
  }
}
// The requests the CSP must keep working: relays and rates.
for (const must of ['wss://relay.damus.io', 'https://api.upbit.com', 'https://api.bithumb.com', 'https://api.coinbase.com', 'https://api.kraken.com', 'https://public.bitbank.cc']) {
  if (!allows(dir('connect-src'), must)) h4.push(`connect-src blocks ${must}`)
}
if (allows(dir('connect-src'), 'http://example.com')) h4.push('connect-src allows plain http:')
check('H4', h4, `${seen.size} URLs in src/ are allowed by the CSP (connect-src ${dir('connect-src').join(' ')})`)

// ---------- H5: no inline script ----------

const h5: string[] = [...inlineProblems('index.html', readFileSync('index.html', 'utf8'))]
for (const f of walk('public', (p) => /\.html?$/.test(p))) h5.push(...inlineProblems(f, readFileSync(f, 'utf8')))
for (const f of walk('public', (p) => p.endsWith('.js'))) {
  const t = readFileSync(f, 'utf8')
  h5.push(...evalProblems(f, t))
  if (/\.innerHTML\s*=/.test(t)) h5.push(`${f}: innerHTML`)
}
check('H5', h5, 'index.html and public/ have no inline script, handler or javascript: URL')

// ---------- H6: no remote profile picture, no automatic NIP-05 ----------

const h6: string[] = []
for (const f of srcFiles.filter((p) => p.endsWith('.tsx'))) {
  const text = readFileSync(f, 'utf8')
  for (const m of text.matchAll(/<img\b[^>]*?\bsrc=\{/g)) h6.push(`${relative('.', f)}: <img src={…}> draws a computed image (offset ${m.index})`)
}
const profileLib = readFileSync('src/lib/nostr-profile/index.ts', 'utf8')
if (/^\s*picture\s*[:?]/m.test(profileLib) || /picture\s*:/.test(profileLib.replace(/\/\*[\s\S]*?\*\//g, ''))) {
  h6.push('src/lib/nostr-profile/index.ts keeps a picture field')
}
if (/nip05Verified/.test(profileLib)) h6.push('src/lib/nostr-profile/index.ts stores a NIP-05 result (a badge source)')
const profileUi = readFileSync('src/screens/contacts/NostrProfile.tsx', 'utf8')
const load = /const load = async \(\) => \{([\s\S]*?)\n {2}\}\n/.exec(profileUi)?.[1]
if (load === undefined) h6.push('src/screens/contacts/NostrProfile.tsx: could not find load(); update this check')
else if (/verifyNip05/.test(load)) h6.push('NostrProfile.tsx load() checks NIP-05 by itself; only the button may')
const list = readFileSync('src/screens/contacts/ContactsScreen.tsx', 'utf8')
if (/nip05|nostrVerified/i.test(list)) h6.push('ContactsScreen.tsx shows a NIP-05 badge or result in the list')
// README names exactly the keys a linked profile is stored with (in the encrypted memo;
// src/lib/nostr-profile STORED_PROFILE_KEYS; the unit test
// checks what is written).
const README_PROFILE = '(its public key, name, display name, "about" text and NIP-05 address, nothing else)'
const stored = /STORED_PROFILE_KEYS = \[([^\]]*)\]/
  .exec(profileLib)?.[1]
  .match(/'[^']+'/g)
  ?.map((k) => k.slice(1, -1))
  .sort()
  .join(',')
if (stored !== 'about,display_name,name,nip05,pubkey') h6.push(`STORED_PROFILE_KEYS is ${stored ?? 'missing'}; update README "What is encrypted" and this check together`)
if (!readFileSync('README.md', 'utf8').includes(README_PROFILE)) h6.push(`README.md no longer says the linked profile is stored as ${README_PROFILE}`)
check('H6', h6, 'no remote picture, NIP-05 only on the button, no badge in the list, README names the stored profile keys')

// ---------- H7: the Lightning address lookups fit the CSP ----------

{
  const h7: string[] = []
  const metadata = '[["text/plain","x"]]'
  /** A wallet service in this process: the first step names `callback`. */
  const lookups = async (callback: string, sats = 1000): Promise<string[]> => {
    const asked: string[] = []
    const fetch: typeof globalThis.fetch = async (input) => {
      const url = String(input)
      asked.push(url)
      const json = (body: unknown) => new Response(JSON.stringify(body), { status: 200 })
      if (url.includes('/.well-known/lnurlp/')) return json({ tag: 'payRequest', callback, minSendable: 1000, maxSendable: 1e11, metadata })
      return json({ pr: buildInvoice(`lnbc${sats * 10}n`, Math.floor(Date.now() / 1000)) })
    }
    await createLnurl({ fetch })
      .invoice('alice@wallet.example', sats)
      .catch(() => {})
    return asked
  }
  const asked = await lookups('https://pay.other.example/cb?k=1')
  if (asked.length !== 2) h7.push(`expected the first step and the callback, got ${asked.length}: ${asked.join(' ')}`)
  for (const url of asked) if (!allows(dir('connect-src'), url)) h7.push(`connect-src blocks the lookup ${url}`)
  for (const cb of ['http://pay.other.example/cb', 'https://192.168.0.1/cb', 'https://localhost/cb', 'https://printer.local/cb', 'https://0x7f.0x1/cb']) {
    const got = await lookups(cb)
    if (got.length !== 1) h7.push(`the module requested the callback ${cb} (${got.length} requests)`)
  }
  // The CSP alone would let a private https host through: the module is the guard (README limits).
  if (!allows(dir('connect-src'), 'https://192.168.0.1/cb')) h7.push('connect-src no longer allows any https host: update this check and the README')
  check('H7', h7, `Lightning address lookups: ${asked.length} requests allowed by connect-src; http, IP, localhost and private callbacks never requested`)
}

if (failed) {
  console.log(`\n${failed} FAILED`)
  process.exit(1)
}
console.log('\nALL PASS')
