/**
 * The support log module on its own.
 * No hub, no network, no DOM. Run: pnpm check:support-log
 *
 * The engine-level checks (S-LOG-REDACT, S-LOG-TWIN and its variants) are in
 * scripts/check-engine.ts.
 */
import { bucketOf, createSupportLog, engineLine, errorReason, relayLabel, scrub, serverCode, watchEngine, type StorageLike } from '../src/lib/support-log/index'

let failed = 0
function check(name: string, ok: boolean, detail = ''): void {
  if (ok) console.log(`PASS  ${name}`)
  else {
    failed++
    console.log(`FAIL  ${name}${detail ? `\n  ${detail}` : ''}`)
  }
}

const MIN = 60_000

/** A clock the test moves by hand. */
function clock(start = Date.UTC(2026, 10, 13, 3, 4, 5)) {
  let t = start
  return { now: () => t, move: (ms: number) => (t += ms) }
}

function memoryStorage(): StorageLike & { map: Map<string, string>; sets: number; failNext: number } {
  const map = new Map<string, string>()
  const s = {
    map,
    sets: 0,
    failNext: 0,
    getItem: (k: string) => map.get(k) ?? null,
    setItem(k: string, v: string) {
      s.sets++
      if (s.failNext > 0) {
        s.failNext--
        throw new Error('QuotaExceededError')
      }
      map.set(k, v)
    },
    removeItem: (k: string) => void map.delete(k),
  }
  return s
}

// ---------------------------------------------------------------- scrub

{
  // Each value: no piece of it of 4 characters or more may survive.
  const npub = 'npub1sg6plzptd64u62a878hep2kev88swjh3tw00gjsfl8f237lmu63q0uf63m'
  const cases: [string, string][] = [
    ['nsec', 'nsec1vl029mgpspedva04g90vltkh6fvh240zqtv9k0t9af8935ke9laqsnlfe5'],
    ['ncryptsec', 'ncryptsec1qgg9947rlpvqu76pj5ecreduf9jxhselq2nae2kghhvd5g7dgjtcxfqtd67p9m0w57lspw8gsq6yphnm8623nsl8xn9j4jdzz84zm3frztj3z7s35vpzmqf6ksu8r89qk5z2zxfmu5gv8th8wclt0h4p'],
    ['npub', npub],
    ['nprofile', 'nprofile1qqsrhuxx8l9ex335q7he0f09aej04zpazpl0ne2cgukyawd24mayt8gpp4mhxue69uhhytnc9e3k7mgpz4mhxue69uhkg6nzv9ejuumpv34kytnrdaksjlyr9p'],
    ['lnbc', 'lnbc2500u1pvjluezsp5zyg3zyg3zyg3zyg3zyg3zyg3zyg3zyg3zyg3zyg3zyg3zyg3zygspp5qqqsyqcyq5rqwzqfqqqsyqcyq5rqwzqfqqqsyqcyq5rqwzqfqypq'],
    ['lnurl', 'LNURL1DP68GURN8GHJ7UM9WFMXJCM99E3K7MF0V9CXJ0M385EKVCENXC6R2C35XVUKXEFCV5MKVV34X5EKZD3EV56NYD3HXQURZEPEXEJXXEPNXSCRVWFNV9NXZCN9XQ6XYEFHVGCXXCMYXYMNSERXFQ5FNS'],
    ['bc1 address', 'bc1qar0srrr7xfkvy5l643lydnw9re59gtzzwf5mdq'],
    ['base58 address', '1BvBMSEYstWetqTFn5Au4m4GFg7xJaNVN2'],
    // Where a buyer receives: none of it may reach a line.
    ['p2sh address', '3J98t1WpEZ73CNmQviecrnyiWrnqRhWNLy'],
    ['p2tr address', 'bc1p0xlxvlhemja6c4dqv22uapctqupfhlxm9h8z3k2e72q4k9hcz7vqzk5jj0'],
    ['upper-case bech32 address', 'BC1QW508D6QEJXTDG4Y5R3ZARVARY0C5XW7KV8F3T4'],
    ['lightning address', 'alice.b+c@pay.wallet.example'],
    ['QR content', 'ilchon:eyJ2IjoxLCJwayI6IjNiZjBjNjNmY2I5MzQ2MzQwN2FmOTdhNSJ9'],
    ['64 hex', '3bf0c63fcb93463407af97a5e5ee64fa883d107ef9e558472c4eb9aaaefa459d'],
    ['8 hex', 'deadbeef'],
    ['43 base64url', 'Qm9hcmRpbmcgcGFzcyBmb3IgdGhlIGlsY2hvbiB0ZXN'],
    ['base64url with hex inside', 'xY_3bf0c63fcb93463407af97a5e5ee64fa-ZZqq'],
    ['account number', '110-123-456789'],
    ['KRW five digits', '50000'],
    ['seven digits', '1234567'],
    ['fee', '2.75'],
  ]
  for (const [name, value] of cases) {
    const out = scrub(`error near ${value} here`)
    const pieces = value.length >= 4 ? Array.from({ length: value.length - 3 }, (_, i) => value.slice(i, i + 4)) : [value]
    const left = pieces.filter((p) => out.includes(p))
    check(`scrub: ${name} leaves no piece`, left.length === 0, `${out} (left: ${left.slice(0, 3).join(', ')})`)
  }
  // A receiving request as the chat carries it: the scheme word may stay, the address,
  // the invoice and the amount may not.
  const links: [string, string, string[]][] = [
    ['bitcoin: link with amount', 'bitcoin:bc1qrp33g0q5c5txsp9arysrx4k6zdkfs4nce4xj0gdcccefvpysxf3qccfmv3?amount=0.00098039', ['rp33', 'fmv3', '98039', '0009']],
    [
      'lightning: invoice in capitals',
      'lightning:LNBC2500U1PVJLUEZSP5ZYG3ZYG3ZYG3ZYG3ZYG3ZYG3ZYG3ZYG3ZYG3ZYG3ZYG3ZYG3ZYGSPP5QQQSYQCYQ5RQWZQFQQQSYQCYQ5RQWZQFQQQSYQCYQ5RQWZQFQYPQ',
      ['2500', 'PVJL', 'ZYG3', 'QYPQ'],
    ],
  ]
  for (const [name, value, gone] of links) {
    const out = scrub(`sent ${value} ok`)
    const left = gone.filter((g) => out.includes(g))
    check(`scrub: ${name} leaves no address, invoice or amount`, left.length === 0, `${out} (left: ${left.join(', ')})`)
  }
  const words = 'abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about'
  const w = scrub(`bad: ${words}`)
  check('scrub: the 12 words (NIP-06 test phrase)', !w.includes('abandon') && w.includes('<words>'), w)

  // The 12 words in every shape a paste or an error could carry them: no
  // two of them in a row may survive any entry point of the log.
  const vec = 'leader monkey parrot ring guide accident before fence cannon height naive bean'
  const vw = vec.split(' ')
  const shapes: [string, string][] = [
    ['one space', vec],
    ['upper case', vec.toUpperCase()],
    ['capitalized', vw.map((x) => x[0]!.toUpperCase() + x.slice(1)).join(' ')],
    ['line breaks', vw.join('\n')],
    ['tabs and CRLF', vw.join('\t\r\n')],
    ['ideographic space', vw.join('\u3000')],
    ['numbered list', vw.map((x, i) => `${i + 1}. ${x}`).join(' ')],
    ['numbered lines', vw.map((x, i) => `${i + 1}) ${x}`).join('\n')],
  ]
  const pairs = vw.slice(1).map((x, i) => `${vw[i]} ${x}`)
  const pairsLeft = (out: string) => {
    const flat = out
      .toLowerCase()
      .replace(/\s+/g, ' ')
      .replace(/\d{1,2}[.)] ?/g, '')
    return pairs.filter((p) => flat.includes(p))
  }
  for (const [shape, value] of shapes) {
    const out = scrub(`restore failed: ${value} end`)
    check(`scrub: 12 words, ${shape}`, pairsLeft(out).length === 0 && out.includes('<words>'), out)
    const log = createSupportLog({})
    log.add('engine', 'restore check', ` ${value}`)
    log.marmot('relay refused a subscription, retrying in', [4000, 'ms:', `blocked: ${value}`])
    log.marmot('group connect failed, retrying in', [8000, 'ms:', value])
    log.engine('task-error', { error: `boom ${value}` })
    log.error('error', new Error(`cannot read ${value}`))
    log.error('rejection', value)
    const dump = log.dump({ app: 'check', note: value })
    check(`log: 12 words (${shape}) through add, marmot, engine, error and the header leave no two words in a row`, pairsLeft(dump).length === 0, dump)
  }
  // A secret key in hex and its head, through the same doors.
  const sk = '3d1062416e2e14dc6e29d9deabd63c89d41fa4b663bd65597070995499f1503a'
  const kl = createSupportLog({})
  kl.add('engine', 'x', ` ${sk}`)
  kl.error('error', new Error(`bad key ${sk.slice(0, 16)}`))
  kl.engine('task-error', { error: sk })
  const kd = kl.dump({ key: sk })
  check('log: a secret key or its first 16 hex leaves no 8-hex piece', !kd.includes(sk.slice(0, 8)) && !kd.includes(sk.slice(16, 24)), kd)
  // Plain English of the app's own phrases is not mistaken for words: fewer than 8 in a row stay.
  check('scrub: seven words stay', scrub('the relay did not answer in time again') === 'the relay did not answer in time again')

  const relay = scrub('failed wss://u:p@relay.example:4430/path?token=abc now')
  check('scrub: a relay url keeps scheme, host and port only', relay === 'failed wss://relay.example:4430 now', relay)

  // Relays with a path per user: the path, user info and query never reach a line.
  const hex64 = '3bf0c63fcb93463407af97a5e5ee64fa883d107ef9e558472c4eb9aaaefa459d'
  const npubPath = 'npub1sg6plzptd64u62a878hep2kev88swjh3tw00gjsfl8f237lmu63q0uf63m'
  const perUser: [string, string, string[]][] = [
    [`wss://r.example/${hex64}`, 'wss://r.example', [hex64.slice(0, 8), hex64.slice(-8)]],
    [`wss://r.example/inbox/${npubPath}`, 'wss://r.example', ['npub1', npubPath.slice(5, 13), 'inbox']],
    ['wss://alice:s3cr3tpass@r.example:7777/', 'wss://r.example:7777', ['alice', 's3cr3t']],
    [`wss://r.example/?pubkey=${hex64}&name=alice`, 'wss://r.example', [hex64.slice(0, 8), 'pubkey', 'alice']],
    ['wss://r.example:443/x', 'wss://r.example', [':443', '/x']],
    [`wss://${hex64.slice(0, 16)}.r.example`, 'wss://<hex>.r.example', [hex64.slice(0, 8)]],
    // Run after the bech32 rule, the url rule would see its placeholder in the host.
    [`wss://${npubPath}.r.example/x`, 'wss://<redacted>.r.example', [npubPath.slice(5, 13), 'xn--']],
  ]
  for (const [url, label, gone] of perUser) {
    const l = relayLabel(url)
    check(`relayLabel: ${label} from a url with user parts`, l === label, l)
    const holder = createSupportLog({})
    holder.marmot('relay rejected authentication', [url])
    holder.add('relay', 'failed', ` at ${url} then`)
    const inText = scrub(`relay ${url} refused`)
    const dump = holder.dump({ relays: `${url} connected` })
    const all = `${l}\n${inText}\n${dump}`
    const left = gone.filter((g) => all.includes(g))
    check(`relayLabel: no user part of ${label} in line, scrub or dump`, left.length === 0, `${left.join(', ')} in ${all}`)
    check(`scrub: ${label} label kept inside text`, inText === `relay ${label} refused`, inText)
  }
  // A placeholder an earlier rule made must come back whole (urls go first).
  const mixed = scrub(`failed wss://r.example/${npubPath} and ${npubPath} near 110-123-456789 at wss://b.example:4430/${hex64}`)
  check('scrub: placeholders survive next to urls', mixed === 'failed wss://r.example and <redacted> near <num> at wss://b.example:4430', mixed)
  check('scrub: no broken placeholder', !/%EE|[-]/.test(mixed), mixed)
  const url = scrub('GET https://wallet.example/.well-known/lnurlp/alice failed')
  check('scrub: an https url is <url>', url === 'GET <url> failed', url)
  const address = scrub('pay to alice@wallet.example please')
  check('scrub: a lightning address is <address>', address === 'pay to <address> please', address)
  const ua = 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_4 like Mac OS X) AppleWebKit/605.1.15 Version/17.4 Mobile/15E148 Safari/604.1'
  check('scrub: digits false keeps Version/17.4 Mobile/15E148', scrub(ua, { digits: false }).includes('Version/17.4 Mobile/15E148'))
  check('scrub: cut at 240', scrub('x '.repeat(300)).length <= 240)
  check('relayLabel: fake://relay', relayLabel('fake://relay') === 'fake://relay', relayLabel('fake://relay'))
  check('relayLabel: not a url', relayLabel('nope') === '<relay>')
}

// ---------------------------------------------------------------- marmot (transport warnings)

{
  const c = clock()
  const log = createSupportLog({ now: c.now })
  log.marmot('relay refused a subscription, retrying in', [4000, 'ms:', 'wss://r.example', 'blocked 50000'])
  const lines = log.lines()
  const line = lines[0] ?? ''
  check('marmot: one relay-level line', lines.length === 1, lines.join(' | '))
  check('marmot: wait and relay kept', line.includes('retrying in 4000 ms: wss://r.example'), line)
  check('marmot: the relay text becomes a code', /\((refused|timeout|closed|auth)\)$/.test(line), line)
  check('marmot: no relay text, no number of it, no <num>', !line.includes('blocked') && !line.includes('50000') && !line.includes('<num>'), line)
  check('serverCode: auth', serverCode('auth-required: please sign in') === 'auth')
  check('serverCode: timeout', serverCode('Timeout') === 'timeout')
  check('serverCode: closed', serverCode('socket closed') === 'closed')
  check('serverCode: anything else is refused', serverCode('restricted: not allowed') === 'refused')
  check('serverCode: a NIP-01 prefix decides, not words after it', serverCode('blocked: auth timeout closed') === 'refused')
  const timedOut = createSupportLog({})
  timedOut.marmot('key package spread failed', [new Error('connection timed out')])
  check('marmot: an Error value becomes its code', timedOut.lines()[0]?.endsWith('key package spread failed (timeout)') === true, timedOut.lines()[0])
  const auth = createSupportLog({ now: c.now })
  auth.marmot('relay rejected authentication', ['wss://a.example/?k=npub1sg6plzptd64u62a878hep2kev88swjh3tw00gjsfl8f237lmu63q0uf63m'])
  check('marmot: rejected authentication carries the label and auth', auth.lines()[0]?.endsWith('relay rejected authentication wss://a.example (auth)') === true, auth.lines()[0])

  const room = createSupportLog({ now: c.now })
  room.marmot('group connect failed, retrying in', [8000, 'ms:', 'ab12cd34', 'x'])
  const r = room.lines()[0] ?? ''
  check('marmot: a room-level warning keeps the phrase only', r.endsWith('marmot  group connect failed, retrying in') && !r.includes('ab12cd34') && !r.includes('8000'), r)
  for (let i = 0; i < 6; i++) {
    c.move(50_000)
    room.marmot('group connect failed, retrying in', [8000, 'ms:', 'ab12cd34', 'x'])
  }
  check('marmot: seven times in five minutes, one line', room.size === 1, room.lines().join(' | '))
  c.move(11 * MIN)
  room.marmot('group connect failed, retrying in', [8000])
  check('marmot: eleven minutes later, a second line', room.size === 2, room.lines().join(' | '))

  // The start: the online step's lines and the room and inbox lines.
  const boot = createSupportLog({ now: c.now })
  boot.marmot('relays unreachable, retrying in', [15000, 'ms:'])
  boot.marmot('relays refused, retrying in', [60000, 'ms:'])
  boot.marmot('online step failed', ['storage-damaged'])
  boot.marmot('online step failed', [new Error('storage-unavailable')])
  boot.marmot('online step failed', ['blocked: signature mismatch at wss://r.example'])
  const b = boot.lines()
  check(
    "marmot: online step waits are lines of the source 'relay' with the wait, no colon left dangling at the end",
    b[0]?.endsWith('  relay  relays unreachable, retrying in 15000 ms') === true && b[1]?.endsWith('  relay  relays refused, retrying in 60000 ms') === true,
    b.join(' | '),
  )
  check(
    "marmot: a failed online step carries the app's own error key, no server code",
    b[2]?.endsWith('marmot  online step failed: storage-damaged') === true && b[3]?.endsWith('marmot  online step failed: storage-unavailable') === true,
    `${b[2]} | ${b[3]}`,
  )
  check(
    'marmot: a failed online step with any other text is "other", never the text or a server code',
    b[4]?.endsWith('online step failed: other') === true && !/\((refused|timeout|closed|auth)\)/.test(b.slice(2).join(' ')) && !b.join(' ').includes('signature') && !b.join(' ').includes('r.example'),
    b[4],
  )
  const rooms = createSupportLog({ now: c.now })
  rooms.marmot('stored room could not be loaded', [])
  rooms.marmot('inbox dropped (size, tags)', [])
  rooms.marmot('invite store trimmed', [])
  const rl = rooms.lines()
  check(
    'marmot: room and inbox lines are bare phrases',
    rl.length === 3 && rl[0].endsWith('marmot  stored room could not be loaded') && rl[1].endsWith('marmot  inbox dropped (size, tags)') && rl[2].endsWith('marmot  invite store trimmed'),
    rl.join(' | '),
  )
  // A Welcome refused before joining: the bare phrase, an
  // interval line like the other room-level transport lines, and the error a join throws
  // keeps only that head.
  const shape = createSupportLog({ now: c.now })
  shape.marmot('invite refused (shape)', [])
  shape.marmot('invite refused (shape)', [])
  const shl = shape.lines()
  check("marmot: 'invite refused (shape)' is one bare interval line", shl.length === 1 && shl[0].endsWith('marmot  invite refused (shape)'), shl.join(' | '))
  check("errorReason: 'invite refused (shape)' is the app's own words", errorReason('invite refused (shape)') === ': invite refused (shape)', errorReason('invite refused (shape)'))
  // The same line when the warning comes with values (a sender, a relay, a count): none
  // survives. It is a transport warning (source marmot), not an engine event: engineLine
  // has no such event.
  const shapeV = createSupportLog({ now: c.now })
  shapeV.marmot('invite refused (shape)', ['ab12cd34', 'wss://evil.example/npub1sg6plzptd64u62a878hep2kev88swjh3tw00gjsfl8f237lmu63q0uf63m', 9])
  const shv = shapeV.lines()
  check(
    "marmot: 'invite refused (shape)' with values is still the bare phrase",
    shv.length === 1 && shv[0].endsWith('marmot  invite refused (shape)') && !/ab12cd34|evil|npub1|9$/.test(shv[0]),
    shv.join(' | '),
  )
  check("engineLine: 'invite refused (shape)' is no engine event", engineLine('invite refused (shape)', {}) === null)
  const strands = createSupportLog({ now: c.now })
  strands.marmot('room relays unreachable', [])
  strands.marmot('room relays unreachable', [])
  const sl = strands.lines()
  check("marmot: a stranded room is one interval line of the source 'relay', the phrase alone", sl.length === 1 && sl[0].endsWith('  relay  room relays unreachable'), sl.join(' | '))
  check("errorReason: the send guards are the app's own words", errorReason('offline') === ': offline' && errorReason('group-unreadable') === ': group-unreadable')

  // The received-message inbox. Its failures are bare interval
  // lines (no reason, no error text, no count); 'inbox replay' makes no line at all.
  const dlv = createSupportLog({ now: c.now })
  dlv.marmot('inbox replay', [])
  dlv.marmot('inbox write failed', [new Error('QuotaExceededError: wss://r.example ab12cd34 storage full')])
  dlv.marmot('inbox write failed', ['timeout'])
  dlv.marmot('inbox full', [])
  dlv.engine('inbox-kept', { why: 'persist', peer: 'ab12cd34' })
  dlv.engine('inbox-kept', { why: 'stopped' })
  const dl = dlv.lines()
  check(
    "inbox: 'inbox replay' makes no line; write failed, full and kept are bare, once per interval",
    dl.length === 3 &&
      dl[0].endsWith('marmot  inbox write failed') &&
      dl[1].endsWith('marmot  inbox full') &&
      dl[2].endsWith('engine  inbox kept') &&
      !/replay|persist|stopped|ab12cd34|Quota|r\.example|timeout/.test(dl.join(' ')),
    dl.join(' | '),
  )

  // The switch to the default relays. Fixed phrases and a code-made
  // wait; relays appear only as their labels (the status lines), never a relay's text.
  const fb = createSupportLog({ now: c.now })
  fb.marmot('relay fallback probe unanswered, retrying in', [5000, 'ms:'])
  fb.marmot('relay fallback (unreachable)', [])
  fb.marmot('relay fallback (silent)', [])
  fb.marmot('relay fallback (refused)', ['blocked: paid relay npub1sg6plzptd64u62a878hep2kev88swjh3tw00gjsfl8f237lmu63q0uf63m'])
  const fl = fb.lines()
  check(
    "marmot: the fallback probe and switch are lines of the source 'relay'",
    fl.length === 4 &&
      fl[0].endsWith('  relay  relay fallback probe unanswered, retrying in 5000 ms') &&
      fl[1].endsWith('  relay  relay fallback (unreachable)') &&
      fl[2].endsWith('  relay  relay fallback (silent)') &&
      fl[3].endsWith('  relay  relay fallback (refused) (refused)') &&
      !fl.join(' ').includes('npub1') &&
      !fl.join(' ').includes('paid'),
    fl.join(' | '),
  )
  // The inbox's other phrases (src/lib/marmot/durable-inbox.ts): a
  // removal or a read that failed, an entry that could not be read. Bare interval lines.
  const dlv2 = createSupportLog({ now: c.now })
  dlv2.marmot('inbox remove failed', [new Error('AbortError: wss://r.example ab12cd34')])
  dlv2.marmot('inbox remove failed', ['timeout'])
  dlv2.marmot('inbox read failed', ['timeout'])
  dlv2.marmot('inbox entry could not be read', [])
  const dl2 = dlv2.lines()
  check(
    'inbox: remove failed, read failed and an unreadable entry are bare, once per interval',
    dl2.length === 3 &&
      dl2[0].endsWith('marmot  inbox remove failed') &&
      dl2[1].endsWith('marmot  inbox read failed') &&
      dl2[2].endsWith('marmot  inbox entry could not be read') &&
      !/ab12cd34|Abort|r\.example|timeout/.test(dl2.join(' ')),
    dl2.join(' | '),
  )
  // Answer sessions over their bound: a bare interval line.
  const cap = createSupportLog({ now: c.now })
  cap.engine('resp-capped', { peer: 'ab12cd34', n: 7 })
  cap.engine('resp-capped', {})
  const cl = cap.lines()
  check(
    'resp-capped: one bare line per interval, no sender, no count',
    cl.length === 1 && cl[0].endsWith('engine  answer sessions capped') && !/ab12cd34|7/.test(cl[0].split('engine')[1]),
    cl.join(' | '),
  )
}

// ---------------------------------------------------------------- engineLine

{
  const expected: [string, Record<string, string | number | boolean>, string, string][] = [
    ['tx-failed', { t: 'm1' }, 'interval', 'send failing (other), retrying'],
    ['tx-failed', { t: 'hello' }, 'interval', 'send failing (link), retrying'],
    ['persist-failed', { key: 'contacts' }, 'session', 'save failed'],
    ['link-start', {}, 'every', 'started'],
    ['connect-failed', { errorKey: 'expired' }, 'every', 'failed: expired'],
    ['invite-retry', { peer: 'ab12cd34' }, 'every', 'invite retry'],
    ['invite-failed', { peer: 'ab12cd34', error: 'no key package for 3bf0c63fcb934634' }, 'every', 'invite failed (refused)'],
    ['accept-failed', { from: 'ab12cd34', error: 'boom' }, 'every', 'join failed (refused)'],
    ['task-error', { peer: 'ab12cd34', error: 'oops 50000' }, 'interval', 'task error (refused)'],
    [
      'invite-failed',
      { peer: 'ab12cd34', error: 'no KeyPackage found for peer 3bf0c63f: no relay answered the request (wss://alice-home.example blocked: pubkey not on whitelist of alice)' },
      'every',
      'invite failed: no KeyPackage found for peer (refused)',
    ],
    [
      'accept-failed',
      { from: 'ab12cd34', error: 'Welcome was not delivered: wss://inbox.bob.example rejected (restricted: paid relay, contact bob)' },
      'every',
      'join failed: Welcome was not delivered (refused)',
    ],
    ['invite-failed', { peer: 'ab12cd34', error: 'no relay answered the request (wss://r.example: connection timed out)' }, 'every', 'invite failed: no relay answered the request (timeout)'],
    [
      'task-error',
      { peer: 'ab12cd34', error: 'peer KeyPackage is not eligible: ciphersuite 0x0003 from wss://x.example not supported' },
      'interval',
      'task error: peer KeyPackage is not eligible (refused)',
    ],
    ['task-error', { peer: 'ab12cd34', error: 'halted' }, 'interval', 'task error: halted'],
    ['invite-failed', { peer: 'ab12cd34', error: 'relay unreachable: wss://carol.example' }, 'every', 'invite failed: relay unreachable'],
    ['reset-failed', {}, 'every', 'reset failed'],
    ['unlock-failed', { errorKey: 'wrong-pin' }, 'every', 'unlock failed: wrong-pin'],
    ['unlock-failed', { errorKey: 'pin-wait' }, 'every', 'unlock failed: pin-wait'],
    ['unlock-failed', { errorKey: 'passkey-cancelled' }, 'every', 'unlock failed: passkey-cancelled'],
    ['unlock-failed', { errorKey: '135790 ab12cd34' }, 'every', 'unlock failed: other'],
    ['storage-damaged', { errorKey: 'memo' }, 'every', 'damaged: memo'],
    ['storage-damaged', { errorKey: 'identity' }, 'every', 'damaged: identity'],
    ['storage-damaged', { errorKey: 'contacts' }, 'every', 'damaged: app'],
    // The contacts item, under a fixed name of its own.
    ['storage-damaged', { errorKey: 'contact-list' }, 'every', 'damaged: contact-list'],
    ['storage-unavailable', {}, 'interval', 'unavailable'],
    ['room-damaged', { peer: 'ab12cd34' }, 'interval', 'room item damaged'],
    ['inbox-kept', { why: 'persist' }, 'interval', 'inbox kept'],
    ['resp-capped', { peer: 'ab12cd34' }, 'interval', 'answer sessions capped'],
    // The channel and invite signals are bare interval lines;
    // whatever value an event carries (a peer, a count) never reaches the line.
    ['chan-fail', { peer: 'ab12cd34', n: 3 }, 'interval', 'channel reopen failing'],
    ['invite-buffer-full', { from: 'ab12cd34', n: 20 }, 'interval', 'invite buffer full'],
    ['invite-unbuffered', { from: 'ab12cd34' }, 'interval', 'invite unbuffered'],
  ]
  for (const [event, info, kind, text] of expected) {
    const l = engineLine(event, info)
    check(`engineLine: ${event} ${JSON.stringify(info)}`, !!l && l.kind === kind && l.text === text, JSON.stringify(l))
    const all = JSON.stringify(l)
    check(`engineLine: ${event} carries no peer value`, !all.includes('ab12cd34') && !all.includes('contacts'), all)
  }
  // Real shapes of transport errors: no url, no relay prose, no person survives.
  const relayTexts = [
    'no KeyPackage found for peer 3bf0c63f: no relay answered the request (wss://alice-home.example blocked: pubkey not on whitelist of alice)',
    'Welcome was not delivered: wss://inbox.bob.example rejected (restricted: paid relay, contact bob)',
    'relay list (kind 10002) was not accepted: wss://a.example error: rate-limited: slow down',
    'auth-required: we only accept members, ask alice',
    'Something odd https://evil.example/x?u=bob happened',
  ]
  for (const event of ['invite-failed', 'accept-failed', 'task-error']) {
    for (const error of relayTexts) {
      const t = engineLine(event, { peer: 'ab12cd34', error })?.text ?? ''
      check(
        `engineLine: ${event} drops relay text (${error.slice(0, 30)})`,
        t !== '' && !t.includes('://') && !/alice|bob|blocked|whitelist|restricted|paid|rate|slow|members|odd|evil|3bf0c63f|10002/.test(t) && /\((refused|timeout|closed|auth)\)$/.test(t),
        t,
      )
    }
  }
  check("engineLine: connect-failed 'already' makes no line", engineLine('connect-failed', { errorKey: 'already' }) === null)
  const dropped = [
    'rx',
    'tx',
    'tx-dropped',
    'scan',
    'invite',
    'contact',
    'match',
    'ready',
    'round-crossed',
    'round-deferred',
    'round-not-owner',
    'hello-rejected',
    'group-abandoned',
    'forget-failed',
    'zzz',
    'toString',
    '__proto__',
  ]
  for (const e of dropped) check(`engineLine: ${e} makes no line`, engineLine(e, { peer: 'ab12cd34', why: 'stale', t: 'm1' }) === null)
  check("bucketOf('hello') is link", bucketOf('hello') === 'link')
  check("bucketOf('m1') is other", bucketOf('m1') === 'other')
  check("bucketOf('zzz') is other", bucketOf('zzz') === 'other')
}

// ---------------------------------------------------------------- interval lines

{
  const c = clock()
  const log = createSupportLog({ now: c.now })
  for (let i = 0; i < 5; i++) log.engine('tx-failed', { t: 'm1', peer: `p${i}` })
  check('interval: five tx-failed at once, one line', log.size === 1 && !log.lines()[0].includes('(x'), log.lines().join(' | '))
  c.move(9 * MIN)
  log.engine('tx-failed', { t: 'm1' })
  check('interval: nine minutes later, still one line', log.size === 1, log.lines().join(' | '))
  c.move(2 * MIN)
  log.engine('tx-failed', { t: 'm1' })
  check('interval: eleven minutes after the first, two lines', log.size === 2, log.lines().join(' | '))
  const save = createSupportLog({ now: c.now })
  for (let i = 0; i < 9; i++) save.engine('persist-failed', { key: `k${i}` })
  check('session: persist-failed nine times with other keys, one line without a key', save.size === 1 && save.lines()[0].endsWith('engine  save failed'), save.lines().join(' | '))
}

// ---------------------------------------------------------------- every lines: folding and the cap

{
  const c = clock()
  const log = createSupportLog({ now: c.now })
  for (let i = 0; i < 3; i++) log.add('net', 'offline')
  check('every: the same line three times folds into (x3)', log.size === 1 && log.lines()[0].endsWith('net  offline (x3)'), log.lines().join(' | '))
  const cap = createSupportLog({ now: c.now })
  for (let i = 0; i < 60; i++) {
    cap.add('relay', 'wss://a.example disconnected')
    cap.interval('engine', `other ${i}`)
  }
  const down = cap.lines().filter((l) => l.endsWith('disconnected')).length
  check('every: one text 60 times between others, 50 lines', down === 50, String(down))
  check('every: the rest counted as suppressed', cap.suppressed === 10, String(cap.suppressed))
  const many = createSupportLog({ now: c.now })
  for (let i = 0; i < 1200; i++) many.interval('engine', `line ${i}`)
  check('capacity: 1,200 lines keep the last 1,000', many.size === 1000 && many.lines()[0].endsWith('line 200'), many.lines()[0])
}

// ---------------------------------------------------------------- storage

{
  const c = clock()
  const st = memoryStorage()
  const a = createSupportLog({ now: c.now, storage: st, storageKey: 'ilchon:a:supportlog' })
  a.add('boot', 'ready (+10 ms)')
  a.add('net', 'online')
  a.flush()
  const b = createSupportLog({ now: c.now, storage: st, storageKey: 'ilchon:a:supportlog' })
  check('storage: a new instance reads the same lines', JSON.stringify(b.lines()) === JSON.stringify(a.lines()), JSON.stringify(b.lines()))

  st.map.set('ilchon:a:supportlog', '{"not":"an array"}')
  const broken = createSupportLog({ now: c.now, storage: st, storageKey: 'ilchon:a:supportlog' })
  check('storage: a broken value is emptied with one line', broken.size === 1 && broken.lines()[0].endsWith('app  support log was unreadable, started over'), broken.lines().join(' | '))
  st.map.set('ilchon:a:supportlog', '["ok", 3]')
  check('storage: a non-string item counts as broken', createSupportLog({ now: c.now, storage: st, storageKey: 'ilchon:a:supportlog' }).size === 1)

  const full = memoryStorage()
  const f = createSupportLog({ now: c.now, storage: full, storageKey: 'k' })
  for (let i = 0; i < 10; i++) f.interval('engine', `n${i}`)
  full.failNext = 1
  f.flush()
  const kept = JSON.parse(full.map.get('k') ?? '[]') as string[]
  check('storage: when full, the older half goes and the write is tried again', kept.length === 5 && kept[0].endsWith('n5'), JSON.stringify(kept))
  full.failNext = 2
  f.interval('engine', 'later')
  f.flush()
  check('storage: when it fails twice, this save is given up', JSON.parse(full.map.get('k') ?? '[]').length === 5)

  const cl = memoryStorage()
  const x = createSupportLog({ now: c.now, storage: cl, storageKey: 'k' })
  x.add('net', 'online')
  x.flush()
  x.clear()
  x.add('net', 'offline')
  x.flush()
  check('clear: the key is gone and flush does not write it again', !cl.map.has('k') && x.size === 1, String(cl.map.get('k')))

  const er = memoryStorage()
  let changes = 0
  const y = createSupportLog({ now: c.now, storage: er, storageKey: 'k', onChange: () => changes++ })
  y.error('screen', new Error('x'), 'Board')
  check('error(): written at once, without waiting for onChange', er.map.has('k') && changes === 1)
}

// ---------------------------------------------------------------- screen errors

{
  const log = createSupportLog({})
  log.error('screen', new Error('JSON at position 110-123-456789 50000 2.75'), 'OfferSheet')
  const line = log.lines()[0] ?? ''
  const message = line.split('screen crashed: ')[1] ?? ''
  check('error: the line names the screen error and the component', line.includes('ui  screen crashed: Error: JSON at position <num> <num> <num>') && line.includes('(OfferSheet)'), line)
  check('error: only <num> left of the numbers', !/110|123|456789|50000|2\.75/.test(message), message)
  log.error('screen', new Error('y'.repeat(500)))
  check('error: a screen error message is cut at 120', (log.lines()[1] ?? '').length < 220, String(log.lines()[1]?.length))
}

// ---------------------------------------------------------------- dump

{
  const c = clock()
  const log = createSupportLog({ now: c.now })
  log.add('boot', 'starting (+120 ms)')
  log.add('net', 'online')
  const ua = 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_4 like Mac OS X) Version/17.4 Mobile/15E148 Safari/604.1'
  const out = log.dump({
    app: '2026-11-12 08c3f7c (production)',
    time: '2026-11-12T03:04:05Z',
    browser: ua,
    installed: 'yes',
    lang: 'ko',
    online: 'yes',
    'storage persisted': 'yes',
    lock: 'passkey 3bf0c63fcb934634',
    boot: 'ready',
    relays: 'wss://a.example connected, wss://b.example:4430 not connected',
  })
  check('dump: a string, synchronously', typeof out === 'string')
  const lines = out.split('\n')
  check(
    'dump: header order',
    lines[0] === 'ilchon support log' &&
      lines[1] === 'app: 2026-11-12 08c3f7c (production)' &&
      lines[2].startsWith('time: ') &&
      lines[3].startsWith('browser: ') &&
      lines[4].startsWith('installed: yes') &&
      lines[5].startsWith('lock: ') &&
      lines[6] === 'boot: ready' &&
      lines[7].startsWith('relays: ') &&
      lines[8] === 'log: 2 lines, 0 suppressed, redaction on' &&
      lines[9] === '---',
    lines.slice(0, 10).join(' | '),
  )
  check('dump: the lines follow, oldest first', lines[10]?.includes('boot  starting') && lines[11]?.includes('net  online'), lines.slice(10).join(' | '))
  check('dump: header values are scrubbed', lines[5] === 'lock: passkey <hex>', lines[5])
  check('dump: the browser keeps its version numbers', lines[3].includes('Version/17.4 Mobile/15E148'), lines[3])
  check('dump: relay labels with ports', lines[7] === 'relays: wss://a.example connected, wss://b.example:4430 not connected', lines[7])
}

// ---------------------------------------------------------------- watchEngine

{
  const c = clock()
  const log = createSupportLog({ now: c.now })
  type S = { boot: string; bootError?: string; relays: { url: string; connected: boolean }[] }
  let s: S = { boot: 'starting', relays: [] }
  const subs = new Set<() => void>()
  const store = { getState: () => s, subscribe: (fn: () => void) => (subs.add(fn), () => void subs.delete(fn)) }
  const set = (next: S) => {
    s = next
    for (const f of subs) f()
  }
  let since = 120
  const stop = watchEngine(log, store, () => since)
  since = 2310
  set({
    boot: 'ready',
    relays: [
      { url: 'wss://a.example', connected: true },
      { url: 'wss://b.example', connected: true },
    ],
  })
  set({
    boot: 'ready',
    relays: [
      { url: 'wss://a.example', connected: true },
      { url: 'wss://b.example', connected: false },
    ],
  })
  const lines = log.lines()
  check('watchEngine: boot starting with its time', lines[0]?.endsWith('boot  starting (+120 ms)') === true, lines[0])
  check('watchEngine: boot ready with its time', lines[1]?.endsWith('boot  ready (+2310 ms)') === true, lines[1])
  check(
    'watchEngine: a relay disconnects',
    lines.some((l) => l.endsWith('relay  wss://b.example disconnected')),
    lines.join(' | '),
  )
  set({ boot: 'error', bootError: 'failed at 3bf0c63fcb934634', relays: [] })
  check(
    'watchEngine: boot error becomes a code',
    log.lines().some((l) => l.endsWith('boot  error (refused)')),
    log.lines().join(' | '),
  )
  set({ boot: 'error', bootError: 'relay list (kind 10002) was not accepted: wss://alice-home.example blocked: not on whitelist of alice', relays: [] })
  const be = log.lines()[log.size - 1] ?? ''
  check('watchEngine: boot error keeps only the head and a code', be.endsWith('boot  error: relay list not accepted (refused)') && !be.includes('://') && !be.includes('alice'), be)
  set({ boot: 'error', bootError: 'profile-locked', relays: [] })
  check('watchEngine: an engine error key is kept', log.lines()[log.size - 1]?.endsWith('boot  error: profile-locked') === true, log.lines()[log.size - 1])
  stop()
}

console.log(failed ? `\n${failed} FAILED` : '\nALL PASS')
if (failed) process.exit(1)
