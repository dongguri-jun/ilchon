/**
 * Checks src/lib/bolt11 against the BOLT11 spec test vectors. Run: pnpm check:bolt11
 * Vectors: https://github.com/lightning/bolts/blob/master/11-payment-encoding.md
 */
import { readFileSync } from 'node:fs'
import { decodeInvoice, EXPIRY_RECOUNT_SLACK_MS, invoiceCandidates, invoiceIssues, msUntilRecount, secondsLeft } from '../src/lib/bolt11/index'
import { PAY_TOKEN_MAX, payRefOf, splitText } from '../src/lib/pay/index'
import { bech32 } from '@scure/base'
import { buildInvoice, intWords, tagged } from './invoice-fixture'

let failed = 0
function check(name: string, ok: boolean, detail = ''): void {
  if (ok) console.log(`PASS ${name}`)
  else {
    failed++
    console.log(`FAIL ${name}${detail ? ` — ${detail}` : ''}`)
  }
}

const T = 1496314658 // timestamp shared by the spec vectors

const DONATION =
  'lnbc1pvjluezsp5zyg3zyg3zyg3zyg3zyg3zyg3zyg3zyg3zyg3zyg3zyg3zyg3zygspp5qqqsyqcyq5rqwzqfqqqsyqcyq5rqwzqfqqqsyqcyq5rqwzqfqypqdpl2pkx2ctnv5sxxmmwwd5kgetjypeh2ursdae8g6twvus8g6rfwvs8qun0dfjkxaq9qrsgq357wnc5r2ueh7ck6q93dj32dlqnls087fxdwk8qakdyafkq3yap9us6v52vjjsrvywa6rt52cm9r9zqt8r2t7mlcwspyetp5h2tztugp9lfyql'
const COFFEE =
  'lnbc2500u1pvjluezsp5zyg3zyg3zyg3zyg3zyg3zyg3zyg3zyg3zyg3zyg3zyg3zyg3zygspp5qqqsyqcyq5rqwzqfqqqsyqcyq5rqwzqfqqqsyqcyq5rqwzqfqypqdq5xysxxatsyp3k7enxv4jsxqzpu9qrsgquk0rl77nj30yxdy8j9vdx85fkpmdla2087ne0xh8nhedh8w27kyke0lp53ut353s06fv3qfegext0eh0ymjpf39tuven09sam30g4vgpfna3rh'
const NONSENSE =
  'lnbc2500u1pvjluezsp5zyg3zyg3zyg3zyg3zyg3zyg3zyg3zyg3zyg3zyg3zyg3zyg3zygspp5qqqsyqcyq5rqwzqfqqqsyqcyq5rqwzqfqqqsyqcyq5rqwzqfqypqdpquwpc4curk03c9wlrswe78q4eyqc7d8d0xqzpu9qrsgqhtjpauu9ur7fw2thcl4y9vfvh4m9wlfyz2gem29g5ghe2aak2pm3ps8fdhtceqsaagty2vph7utlgj48u0ged6a337aewvraedendscp573dxr'
const TESTNET =
  'lntb20m1pvjluezsp5zyg3zyg3zyg3zyg3zyg3zyg3zyg3zyg3zyg3zyg3zyg3zyg3zygshp58yjmdan79s6qqdhdzgynm4zwqd5d7xmw5fk98klysy043l2ahrqspp5qqqsyqcyq5rqwzqfqqqsyqcyq5rqwzqfqqqsyqcyq5rqwzqfqypqfpp3x9et2e20v6pu37c5d9vax37wxq72un989qrsgqdj545axuxtnfemtpwkc45hx9d2ft7x04mt8q7y6t0k2dge9e7h8kpy9p34ytyslj3yu569aalz2xdk8xkd7ltxqld94u8h2esmsmacgpghe9k8'
const PICO =
  'lnbc9678785340p1pwmna7lpp5gc3xfm08u9qy06djf8dfflhugl6p7lgza6dsjxq454gxhj9t7a0sd8dgfkx7cmtwd68yetpd5s9xar0wfjn5gpc8qhrsdfq24f5ggrxdaezqsnvda3kkum5wfjkzmfqf3jkgem9wgsyuctwdus9xgrcyqcjcgpzgfskx6eqf9hzqnteypzxz7fzypfhg6trddjhygrcyqezcgpzfysywmm5ypxxjemgw3hxjmn8yptk7untd9hxwg3q2d6xjcmtv4ezq7pqxgsxzmnyyqcjqmt0wfjjq6t5v4khxsp5zyg3zyg3zyg3zyg3zyg3zyg3zyg3zyg3zyg3zyg3zyg3zyg3zygsxqyjw5qcqp2rzjq0gxwkzc8w6323m55m4jyxcjwmy7stt9hwkwe2qxmy8zpsgg7jcuwz87fcqqeuqqqyqqqqlgqqqqn3qq9q9qrsgqrvgkpnmps664wgkp43l22qsgdw4ve24aca4nymnxddlnp8vh9v2sdxlu5ywdxefsfvm0fq3sesf08uf6q9a2ke0hc9j6z6wlxg5z5kqpu2v9wz'
const UPPER =
  'LNBC25M1PVJLUEZPP5QQQSYQCYQ5RQWZQFQQQSYQCYQ5RQWZQFQQQSYQCYQ5RQWZQFQYPQDQ5VDHKVEN9V5SXYETPDEESSP5ZYG3ZYG3ZYG3ZYG3ZYG3ZYG3ZYG3ZYG3ZYG3ZYG3ZYG3ZYG3ZYGS9Q5SQQQQQQQQQQQQQQQQSGQ2A25DXL5HRNTDTN6ZVYDT7D66HYZSYHQS4WDYNAVYS42XGL6SGX9C4G7ME86A27T07MDTFRY458RTJR0V92CNMSWPSJSCGT2VCSE3SGPZ3UAPA'

// ---- valid vectors

const d = decodeInvoice(DONATION)
check('donation: decodes', d !== null)
check('donation: mainnet', d?.network === 'mainnet')
check('donation: no amount', d?.amountSats === null && d?.amountMsat === null)
check('donation: timestamp', d?.createdAt === T, String(d?.createdAt))
check('donation: default expiry 3600', d?.expiresAt === T + 3600, String(d?.expiresAt))
check('donation: description', d?.description === 'Please consider supporting this project', String(d?.description))

const c = decodeInvoice(COFFEE)
check('coffee: 2500u = 250,000 sats', c?.amountSats === 250_000, String(c?.amountSats))
check('coffee: expiry 60s', c?.expiresAt === T + 60, String(c?.expiresAt))
check('coffee: description', c?.description === '1 cup coffee', String(c?.description))
check('coffee: lightning: prefix accepted', decodeInvoice(`lightning:${COFFEE}`)?.amountSats === 250_000)
check('coffee: LIGHTNING: prefix and spaces', decodeInvoice(`  LIGHTNING:${COFFEE}\n`)?.amountSats === 250_000)

const n = decodeInvoice(NONSENSE)
check('utf-8 description', n?.description === 'ナンセンス 1杯', String(n?.description))

const tn = decodeInvoice(TESTNET)
check('testnet: network', tn?.network === 'testnet', String(tn?.network))
check('testnet: 20m = 2,000,000 sats', tn?.amountSats === 2_000_000, String(tn?.amountSats))

const p = decodeInvoice(PICO)
check('pico: 9678785340p = 967,878,534 msat', p?.amountMsat === 967_878_534n, String(p?.amountMsat))
check('pico: floors to 967,878 sats', p?.amountSats === 967_878, String(p?.amountSats))

const up = decodeInvoice(UPPER)
check('all upper case: decodes', up?.amountSats === 2_500_000, String(up?.amountSats))
check('all upper case: stored lowercase', up?.invoice === UPPER.toLowerCase())

// ---- invalid vectors (spec "should fail" list plus junk)

const INVALID: Array<[string, string]> = [
  [
    'bad checksum',
    'lnbc2500u1pvjluezpp5qqqsyqcyq5rqwzqfqqqsyqcyq5rqwzqfqqqsyqcyq5rqwzqfqypqdpquwpc4curk03c9wlrswe78q4eyqc7d8d0xqzpuyk0sg5g70me25alkluzd2x62aysf2pyy8edtjeevuv4p2d5p76r4zkmneet7uvyakky2zr4cusd45tftc9c5fh0nnqpnl2jfll544esqchsrnt',
  ],
  ['no separator', 'pvjluezpp5qqqsyqcyq5rqwzqfqqqsyqcyq5rqwzqfqqqsyqcyq5rqwzqfqypqdpl2pkx2ctnv5sxxmmwwd5kgetjypeh2ursdae8g6twvus8g6rfwvs8qun0dfjkxaq'],
  [
    'mixed case',
    'LNBC2500u1pvjluezpp5qqqsyqcyq5rqwzqfqqqsyqcyq5rqwzqfqqqsyqcyq5rqwzqfqypqdpquwpc4curk03c9wlrswe78q4eyqc7d8d0xqzpuyk0sg5g70me25alkluzd2x62aysf2pyy8edtjeevuv4p2d5p76r4zkmneet7uvyakky2zr4cusd45tftc9c5fh0nnqpnl2jfll544esqchsrny',
  ],
  ['too short', 'lnbc1pvjluezpp5qqqsyqcyq5rqwzqfqqqsyqcyq5rqwzqfqqqsyqcyq5rqwzqfqypqdpl2pkx2ctnv5sxxmmwwd5kgetjypeh2ursdae8g6na6hlh'],
  [
    'invalid multiplier',
    'lnbc2500x1pvjluezpp5qqqsyqcyq5rqwzqfqqqsyqcyq5rqwzqfqqqsyqcyq5rqwzqfqypqdq5xysxxatsyp3k7enxv4jsxqzpusp5zyg3zyg3zyg3zyg3zyg3zyg3zyg3zyg3zyg3zyg3zyg3zyg3zygs9qrsgqrrzc4cvfue4zp3hggxp47ag7xnrlr8vgcmkjxk3j5jqethnumgkpqp23z9jclu3v0a7e0aruz366e9wqdykw6dxhdzcjjhldxq0w6wgqcnu43j',
  ],
  [
    'sub-msat precision',
    'lnbc2500000001p1pvjluezpp5qqqsyqcyq5rqwzqfqqqsyqcyq5rqwzqfqqqsyqcyq5rqwzqfqypqdq5xysxxatsyp3k7enxv4jsxqzpusp5zyg3zyg3zyg3zyg3zyg3zyg3zyg3zyg3zyg3zyg3zyg3zyg3zygs9qrsgq0lzc236j96a95uv0m3umg28gclm5lqxtqqwk32uuk4k6673k6n5kfvx3d2h8s295fad45fdhmusm8sjudfhlf6dcsxmfvkeywmjdkxcp99202x',
  ],
  [
    'missing p field',
    'lnbc25m1pvjluezdq5vdhkven9v5sxyetpdeessp5zyg3zyg3zyg3zyg3zyg3zyg3zyg3zyg3zyg3zyg3zyg3zyg3zygs9q5sqqqqqqqqqqqqqqqqsgqjy08jd52dtj25pefkh0enc54lxtjtr8wnum2msrq2d8uztp9vhhpccq93ljpff0kkjgzkzcp2czlyenjphf6upazjlc8uxw7za0ynusqrfhg8u',
  ],
  ['plain text', 'hello this is not an invoice'],
  ['empty', ''],
  ['lightning address', 'satoshi@example.com'],
  ['onchain address', 'bc1qw508d6qejxtdg4y5r3zarvary0c5xw7kv8f3t4'],
  ['lnurl', 'lnurl1dp68gurn8ghj7um9wfmxjcm99e3k7mf0v9cxj0m385ekvcenxc6r2c35xvukxefcv5mkvv34x5ekzd3ev56nyd3hxqurzepexejxxepnxscrvwfnv9nxzcn9xq6xyefhvgcxxcmyxymnserxfq5fns'],
  ['zero amount', 'lnbc01pvjluezpp5qqqsyqcyq5rqwzqfqqqsyqcyq5rqwzqfqqqsyqcyq5rqwzqfqypq'],
]
for (const [name, s] of INVALID) check(`rejects ${name}`, decodeInvoice(s) === null)

// ---- issues

const coffee = c!
const atMs = (sec: number) => sec * 1000
// The coffee invoice expires 60 s after T, so it is always "expiring soon" here.
// Whether an amount fits the trade is tradeView's (check-trade A-15 to A-17).
check('issues: fresh coffee invoice has only "expiring soon"', invoiceIssues(coffee, atMs(T + 10)).join() === 'expiringSoon')
check('issues: expiring soon', invoiceIssues(coffee, atMs(T + 10)).includes('expiringSoon'))
check('issues: expired', invoiceIssues(coffee, atMs(T + 61)).includes('expired'))
check('issues: expired is not also expiring soon', !invoiceIssues(coffee, atMs(T + 61)).includes('expiringSoon'))
check('issues: long-lived invoice is not expiring soon', !invoiceIssues(d!, atMs(T + 10)).includes('expiringSoon'))
check('issues: no amount', invoiceIssues(d!, atMs(T + 10)).includes('noAmount'))
check('issues: testnet', invoiceIssues(tn!, atMs(T + 10)).includes('notMainnet'))

// ---- recount timing (the card and the room's guide turn to "expired" together)

const EXP = T + 60
check('recount: far from expiry, the plain interval', msUntilRecount(EXP, atMs(T), 15_000) === 15_000)
check('recount: 11 s left, wake at the expiry, not 15 s later', msUntilRecount(EXP, atMs(EXP - 11), 15_000) === 11_000 + EXPIRY_RECOUNT_SLACK_MS)
check('recount: the wake-up lands after the invoice counts as expired', secondsLeft(coffee, atMs(EXP) + msUntilRecount(EXP, atMs(EXP - 1), 15_000)!) <= 0)
check('recount: past the expiry nothing more to count', msUntilRecount(EXP, atMs(EXP) + EXPIRY_RECOUNT_SLACK_MS, 15_000) === null)
const cardSrc = readFileSync(new URL('../src/screens/room/InvoiceCard.tsx', import.meta.url), 'utf8')
check('recount: the invoice card recounts at its invoice expiry', /useNow\(15_000, card\.state === 'active' \? invoice\.expiresAt : 0\)/.test(cardSrc) && /msUntilRecount\(expiresAt, /.test(cardSrc))
const hookSrc = readFileSync(new URL('../src/engine/browser.ts', import.meta.url), 'utf8')
check('recount: the guide uses the same slack', hookSrc.includes('+ EXPIRY_RECOUNT_SLACK_MS'))

// ---- hand-built invoices (signature is zeros: the reader does not check it)

const build = (hrp: string, fields: number[][]) => buildInvoice(hrp, T, fields)

const twoX = decodeInvoice(build('lnbc1m', [tagged(6, intWords(60, 2)), tagged(6, intWords(86_400, 4))]))
check('duplicate x: first one wins', twoX?.expiresAt === T + 60, String(twoX && twoX.expiresAt - T))
const longX = build('lnbc1m', [tagged(6, new Array(30).fill(31))])
check('x longer than 10 words: rejected', decodeInvoice(longX) === null)
const threeWordX = decodeInvoice(build('lnbc1m', [tagged(6, intWords(86_400, 4))]))
check('x of 4 words: 1 day', threeWordX?.expiresAt === T + 86_400, String(threeWordX && threeWordX.expiresAt - T))
check('regtest prefix', decodeInvoice(build('lnbcrt1m', []))?.network === 'regtest')
check('signet prefix', decodeInvoice(build('lntbs1m', []))?.network === 'signet')
check('1m = 100,000 sats', decodeInvoice(build('lnbc1m', []))?.amountSats === 100_000)

// ---- payment request tokens in chat text (src/lib/pay)

{
  const ok = build('lnbc1m', [])
  const ref = payRefOf(ok)
  check('pay: an invoice token is a lightning request', ref?.kind === 'lightning' && ref.id === ok && ref.amountSats === 100_000 && ref.mainnet)
  check('pay: lightning: prefix and upper case read the same request', payRefOf(`lightning:${ok.toUpperCase()}`)?.id === ok)
  check('pay: a testnet invoice is a request that is not mainnet', payRefOf(build('lntb1m', []))?.mainnet === false)
  // Longer than 4,096 characters: never parsed, even if it decodes. A long `d` field keeps it a valid invoice.
  // Extra `d` fields that add exactly `n` characters (3 of each field are its tag and length; at most 1,023 words each).
  const pad = (n: number): number[][] => {
    const out: number[][] = []
    while (n > 0) {
      const len = Math.min(n - 3, 1023)
      out.push(tagged(13, new Array(len).fill(0)))
      n -= len + 3
    }
    return out
  }
  const long = build('lnbc1m', pad(PAY_TOKEN_MAX + 1 - ok.length))
  check('pay: the over-long invoice is itself well-formed', long.length === PAY_TOKEN_MAX + 1 && decodeInvoice(long) !== null, String(long.length))
  check('pay: a token over 4,096 characters is not a payment request', payRefOf(long) === null)
  const atMax = build('lnbc1m', pad(PAY_TOKEN_MAX - ok.length))
  check('pay: a token of exactly 4,096 characters is read', atMax.length === PAY_TOKEN_MAX && payRefOf(atMax) !== null, String(atMax.length))
  check('pay: plain words and short ln tokens are not parsed', payRefOf('lnbc') === null && payRefOf('hello') === null && payRefOf('ln' + 'q'.repeat(98)) === null)
  const parts = splitText(`pay ${ok}  and ${ok}`)
  check('pay: splitText keeps spaces as parts; cards at 2 and 6', parts.length === 7 && parts[2].ref !== null && parts[6].ref !== null && parts[1].text === ' ' && parts[5].text === ' ')
}
// ---- description hash (h, tag 23)

// The spec's testnet vector carries h: SHA256 of the long "One piece of chocolate cake, ..." text.
check('h: spec vector hash', tn?.descriptionHash === '3925b6f67e2c340036ed12093dd44e0368df1b6ea26c53dbe4811f58fd5db8c1', String(tn?.descriptionHash))
check('h: absent -> null', c?.descriptionHash === null && d?.descriptionHash === null)
const H32 = new Uint8Array(32).map((_, i) => i * 7 + 1)
const H32_HEX = Array.from(H32, (b) => b.toString(16).padStart(2, '0')).join('')
const withH = decodeInvoice(build('lnbc1m', [tagged(23, bech32.toWords(H32))]))
check('h: 52 words -> lowercase hex of the 32 bytes', withH?.descriptionHash === H32_HEX, String(withH?.descriptionHash))
const shortH = decodeInvoice(build('lnbc1m', [tagged(23, bech32.toWords(H32).slice(0, 51))]))
check('h: 51 words is skipped (null), invoice still decodes', shortH !== null && shortH.descriptionHash === null)
const longH = decodeInvoice(build('lnbc1m', [tagged(23, [...bech32.toWords(H32), 0])]))
check('h: 53 words is skipped (null)', longH !== null && longH.descriptionHash === null)
const twoH = decodeInvoice(build('lnbc1m', [tagged(23, bech32.toWords(H32)), tagged(23, bech32.toWords(new Uint8Array(32)))]))
check('h: first one wins', twoH?.descriptionHash === H32_HEX)
const badPadH = decodeInvoice(build('lnbc1m', [tagged(23, [...bech32.toWords(H32).slice(0, 51), 1])]))
check('h: non-zero padding bits is skipped (null)', badPadH !== null && badPadH.descriptionHash === null)

// ---- pasted text

check('candidates: BIP21 lightning= param', invoiceCandidates(`bitcoin:bc1qw508d6qejxtdg4y5r3zarvary0c5xw7kv8f3t4?amount=0.0025&lightning=${COFFEE}`)[0] === COFFEE)
check('candidates: url-encoded lightning= param', invoiceCandidates(`bitcoin:bc1q?lightning=${encodeURIComponent(COFFEE.toUpperCase())}`)[0] === COFFEE.toUpperCase())
check('candidates: bitcoin: without lightning is skipped', invoiceCandidates('bitcoin:bc1qabc?amount=1').length === 0)
check('candidates: plain words kept in order', invoiceCandidates('pay  this\nlnbc1x').join('|') === 'pay|this|lnbc1x')

console.log(failed ? `\n${failed} failed` : '\nall passed')
process.exitCode = failed ? 1 : 0
