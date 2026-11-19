/**
 * Vectors for src/lib/bolt11: the invoice reader, the invoice candidates in pasted text, expiry timing and issues.
 * Cases come first from scripts/check-bolt11.ts (the spec test vectors and the hand-built invoices), then boundaries.
 * Hand-built invoices carry a zero signature: the reader does not check signatures.
 */
import { bech32 } from '@scure/base'
import { decodeInvoice, EXPIRING_SOON_SECONDS, EXPIRY_RECOUNT_SLACK_MS, invoiceCandidates, invoiceIssues, msUntilRecount, secondsLeft, stripLightningScheme } from '../../src/lib/bolt11'
import { buildInvoice, intWords, tagged } from '../invoice-fixture'
import { aroundEdges, type CaseSpec, defineFunction, type VectorFile } from './kit'

const OUT = { outOfDomain: true } as const

/** Timestamp shared by the spec vectors. */
export const T = 1496314658

export const DONATION =
  'lnbc1pvjluezsp5zyg3zyg3zyg3zyg3zyg3zyg3zyg3zyg3zyg3zyg3zyg3zyg3zygspp5qqqsyqcyq5rqwzqfqqqsyqcyq5rqwzqfqqqsyqcyq5rqwzqfqypqdpl2pkx2ctnv5sxxmmwwd5kgetjypeh2ursdae8g6twvus8g6rfwvs8qun0dfjkxaq9qrsgq357wnc5r2ueh7ck6q93dj32dlqnls087fxdwk8qakdyafkq3yap9us6v52vjjsrvywa6rt52cm9r9zqt8r2t7mlcwspyetp5h2tztugp9lfyql'
export const COFFEE =
  'lnbc2500u1pvjluezsp5zyg3zyg3zyg3zyg3zyg3zyg3zyg3zyg3zyg3zyg3zyg3zyg3zygspp5qqqsyqcyq5rqwzqfqqqsyqcyq5rqwzqfqqqsyqcyq5rqwzqfqypqdq5xysxxatsyp3k7enxv4jsxqzpu9qrsgquk0rl77nj30yxdy8j9vdx85fkpmdla2087ne0xh8nhedh8w27kyke0lp53ut353s06fv3qfegext0eh0ymjpf39tuven09sam30g4vgpfna3rh'
const NONSENSE =
  'lnbc2500u1pvjluezsp5zyg3zyg3zyg3zyg3zyg3zyg3zyg3zyg3zyg3zyg3zyg3zyg3zygspp5qqqsyqcyq5rqwzqfqqqsyqcyq5rqwzqfqqqsyqcyq5rqwzqfqypqdpquwpc4curk03c9wlrswe78q4eyqc7d8d0xqzpu9qrsgqhtjpauu9ur7fw2thcl4y9vfvh4m9wlfyz2gem29g5ghe2aak2pm3ps8fdhtceqsaagty2vph7utlgj48u0ged6a337aewvraedendscp573dxr'
export const TESTNET =
  'lntb20m1pvjluezsp5zyg3zyg3zyg3zyg3zyg3zyg3zyg3zyg3zyg3zyg3zyg3zyg3zygshp58yjmdan79s6qqdhdzgynm4zwqd5d7xmw5fk98klysy043l2ahrqspp5qqqsyqcyq5rqwzqfqqqsyqcyq5rqwzqfqqqsyqcyq5rqwzqfqypqfpp3x9et2e20v6pu37c5d9vax37wxq72un989qrsgqdj545axuxtnfemtpwkc45hx9d2ft7x04mt8q7y6t0k2dge9e7h8kpy9p34ytyslj3yu569aalz2xdk8xkd7ltxqld94u8h2esmsmacgpghe9k8'
const PICO =
  'lnbc9678785340p1pwmna7lpp5gc3xfm08u9qy06djf8dfflhugl6p7lgza6dsjxq454gxhj9t7a0sd8dgfkx7cmtwd68yetpd5s9xar0wfjn5gpc8qhrsdfq24f5ggrxdaezqsnvda3kkum5wfjkzmfqf3jkgem9wgsyuctwdus9xgrcyqcjcgpzgfskx6eqf9hzqnteypzxz7fzypfhg6trddjhygrcyqezcgpzfysywmm5ypxxjemgw3hxjmn8yptk7untd9hxwg3q2d6xjcmtv4ezq7pqxgsxzmnyyqcjqmt0wfjjq6t5v4khxsp5zyg3zyg3zyg3zyg3zyg3zyg3zyg3zyg3zyg3zyg3zyg3zyg3zygsxqyjw5qcqp2rzjq0gxwkzc8w6323m55m4jyxcjwmy7stt9hwkwe2qxmy8zpsgg7jcuwz87fcqqeuqqqyqqqqlgqqqqn3qq9q9qrsgqrvgkpnmps664wgkp43l22qsgdw4ve24aca4nymnxddlnp8vh9v2sdxlu5ywdxefsfvm0fq3sesf08uf6q9a2ke0hc9j6z6wlxg5z5kqpu2v9wz'
const UPPER =
  'LNBC25M1PVJLUEZPP5QQQSYQCYQ5RQWZQFQQQSYQCYQ5RQWZQFQQQSYQCYQ5RQWZQFQYPQDQ5VDHKVEN9V5SXYETPDEESSP5ZYG3ZYG3ZYG3ZYG3ZYG3ZYG3ZYG3ZYG3ZYG3ZYG3ZYG3ZYG3ZYGS9Q5SQQQQQQQQQQQQQQQQSGQ2A25DXL5HRNTDTN6ZVYDT7D66HYZSYHQS4WDYNAVYS42XGL6SGX9C4G7ME86A27T07MDTFRY458RTJR0V92CNMSWPSJSCGT2VCSE3SGPZ3UAPA'

const SPEC_VECTORS: Array<[string, string]> = [
  ['spec donation, no amount', DONATION],
  ['spec coffee 2500u', COFFEE],
  ['spec utf-8 description', NONSENSE],
  ['spec testnet 20m with h', TESTNET],
  ['spec pico amount', PICO],
  ['spec all upper case', UPPER],
]

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

export const build = (hrp: string, fields: number[][] = [], createdAt = T) => buildInvoice(hrp, createdAt, fields)
const utf8 = (text: string) => bech32.toWords(new TextEncoder().encode(text))
const H32 = new Uint8Array(32).map((_, i) => i * 7 + 1)
const hashWords = bech32.toWords(H32)
/** A field of `n` extra words under tag 13 so the invoice string reaches `n` more characters. */
export const pad = (n: number): number[][] => {
  const out: number[][] = []
  while (n > 0) {
    const len = Math.min(n - 3, 1023)
    out.push(tagged(13, new Array(len).fill(0)))
    n -= len + 3
  }
  return out
}

/** Hand-built invoices, named for what the reader must do with them. */
export function builtInvoices(): Array<[string, string]> {
  const a = (hrp: string) => build(hrp)
  return [
    ['built: lnbc, no amount', a('lnbc')],
    ['built: 1m = 100,000 sats', a('lnbc1m')],
    ['built: 1u', a('lnbc1u')],
    ['built: 1n = 100 msat, 0 sats', a('lnbc1n')],
    ['built: 10n = 1 sat', a('lnbc10n')],
    ['built: 5n = 500 msat, 0 sats', a('lnbc5n')],
    ['built: 11n = 1100 msat, 1 sat', a('lnbc11n')],
    ['built: 10p = 1 msat, 0 sats', a('lnbc10p')],
    ['built: 20p = 2 msat', a('lnbc20p')],
    ['built: 9990p = 999 msat, 0 sats', a('lnbc9990p')],
    ['built: 10000p = 1000 msat, 1 sat', a('lnbc10000p')],
    ['built: 1p is below a millisatoshi', a('lnbc1p')],
    ['built: 15p is not a whole millisatoshi', a('lnbc15p')],
    ['built: 1 BTC (no multiplier)', a('lnbc1')],
    ['built: 21000000 BTC', a('lnbc21000000')],
    ['built: msat just under 2^63 (92233720 BTC)', a('lnbc92233720')],
    ['built: msat just over 2^63 (92233721 BTC)', a('lnbc92233721')],
    ['built: sats just under 2^53 (90071992 BTC)', a('lnbc90071992')],
    ['built: sats just over 2^53 (90071993 BTC)', a('lnbc90071993')],
    ['built: 9007199254740993 u, sats not exactly representable', a('lnbc9007199254740993u')],
    ['built: 20 nines of BTC', a(`lnbc${'9'.repeat(20)}`)],
    ['built: 100 nines of BTC', a(`lnbc${'9'.repeat(100)}`)],
    ['built: 2^64 msat in pico', a('lnbc184467440737095516160p')],
    ['built: 0 is not an amount', a('lnbc0')],
    ['built: 0m is not an amount', a('lnbc0m')],
    ['built: leading zero', a('lnbc01m')],
    ['built: multiplier only', a('lnbcm')],
    ['built: two multipliers', a('lnbc1mm')],
    ['built: unknown multiplier', a('lnbc1k')],
    ['built: sign in the amount', a('lnbc-1m')],
    ['built: decimal point in the amount', a('lnbc1.5m')],
    ['built: testnet', a('lntb1m')],
    ['built: testnet no amount', a('lntb')],
    ['built: signet', a('lntbs1m')],
    ['built: regtest', a('lnbcrt1m')],
    ['built: regtest no amount', a('lnbcrt')],
    ['built: regtest with trailing letters', a('lnbcrtx')],
    ['built: signet with trailing letters', a('lntbsx1m')],
    ['built: testnet prefix then a digit run', a('lntb2500u')],
    ['built: unknown network', a('lnxx1m')],
    ['built: only ln', a('ln1m')],
    ['built: bitcoin prefix without ln', a('bc1m')],
    ['built: simnet-like lnsb', a('lnsb1m')],
    ['built: upper case whole invoice', a('lnbc1m').toUpperCase()],
    ['built: mixed case', a('lnbc1m').replace('p', 'P')],
    ['built: created at 0', build('lnbc1m', [], 0)],
    ['built: created at 2^35 - 1', build('lnbc1m', [], 2 ** 35 - 1)],
    ['built: expiry x one word of 31', build('lnbc1m', [tagged(6, [31])])],
    ['built: expiry x of 0 words', build('lnbc1m', [tagged(6, [])])],
    ['built: expiry x of 2 words, 60 seconds', build('lnbc1m', [tagged(6, intWords(60, 2))])],
    ['built: expiry x of 4 words, 1 day', build('lnbc1m', [tagged(6, intWords(86_400, 4))])],
    ['built: expiry x of 10 words, the largest', build('lnbc1m', [tagged(6, intWords(2 ** 50 - 1, 10))])],
    ['built: expiry x of 10 words with created at 2^35 - 1', build('lnbc1m', [tagged(6, intWords(2 ** 50 - 1, 10))], 2 ** 35 - 1)],
    ['built: expiry x of 11 words is refused', build('lnbc1m', [tagged(6, new Array(11).fill(0))])],
    ['built: expiry x of 30 words is refused', build('lnbc1m', [tagged(6, new Array(30).fill(31))])],
    ['built: two x, first wins', build('lnbc1m', [tagged(6, intWords(60, 2)), tagged(6, intWords(86_400, 4))])],
    ['built: a second x of 30 words is ignored, not refused', build('lnbc1m', [tagged(6, intWords(60, 2)), tagged(6, new Array(30).fill(31))])],
    ['built: a first x of 0 words then a second x', build('lnbc1m', [tagged(6, []), tagged(6, intWords(60, 2))])],
    ['built: x after d', build('lnbc1m', [tagged(13, utf8('hi')), tagged(6, intWords(120, 2))])],
    ['built: d ascii', build('lnbc1m', [tagged(13, utf8('1 cup coffee'))])],
    ['built: d empty', build('lnbc1m', [tagged(13, [])])],
    ['built: d korean and an emoji', build('lnbc1m', [tagged(13, utf8('커피 한 잔 ☕🙂'))])],
    ['built: d japanese', build('lnbc1m', [tagged(13, utf8('ナンセンス 1杯'))])],
    ['built: d with NUL and a newline', build('lnbc1m', [tagged(13, utf8('a\u0000b\nc'))])],
    ['built: d with a byte order mark', build('lnbc1m', [tagged(13, utf8('\ufeffhi'))])],
    ['built: d with a lone surrogate encoded by hand', build('lnbc1m', [tagged(13, bech32.toWords(Uint8Array.from([0xed, 0xa0, 0x80])))])],
    ['built: d with invalid utf-8 bytes', build('lnbc1m', [tagged(13, bech32.toWords(Uint8Array.from([0xff, 0xfe, 0xfd])))])],
    ['built: d with a truncated multi-byte sequence', build('lnbc1m', [tagged(13, bech32.toWords(Uint8Array.from([0xe2, 0x82])))])],
    ['built: d with an overlong encoding', build('lnbc1m', [tagged(13, bech32.toWords(Uint8Array.from([0xc0, 0x80])))])],
    ['built: d of 1000 characters', build('lnbc1m', [tagged(13, utf8('x'.repeat(639)))])],
    ['built: two d, first wins', build('lnbc1m', [tagged(13, utf8('first')), tagged(13, utf8('second'))])],
    ['built: an invalid d then a valid d', build('lnbc1m', [tagged(13, bech32.toWords(Uint8Array.from([0xff]))), tagged(13, utf8('second'))])],
    ['built: an empty d then a second d', build('lnbc1m', [tagged(13, []), tagged(13, utf8('second'))])],
    ['built: h of 52 words', build('lnbc1m', [tagged(23, hashWords)])],
    ['built: h of 51 words is skipped', build('lnbc1m', [tagged(23, hashWords.slice(0, 51))])],
    ['built: h of 53 words is skipped', build('lnbc1m', [tagged(23, [...hashWords, 0])])],
    ['built: two h, first wins', build('lnbc1m', [tagged(23, hashWords), tagged(23, bech32.toWords(new Uint8Array(32)))])],
    ['built: a skipped h then a good h', build('lnbc1m', [tagged(23, hashWords.slice(0, 51)), tagged(23, hashWords)])],
    ['built: h with non-zero padding bits is skipped', build('lnbc1m', [tagged(23, [...hashWords.slice(0, 51), 1])])],
    ['built: h of all 255 bytes', build('lnbc1m', [tagged(23, bech32.toWords(new Uint8Array(32).fill(255)))])],
    ['built: h and d together', build('lnbc1m', [tagged(13, utf8('both')), tagged(23, hashWords)])],
    ['built: payment hash of 53 words only', encodeWithoutHash([tagged(1, new Array(53).fill(0))])],
    ['built: payment hash of 51 words only', encodeWithoutHash([tagged(1, new Array(51).fill(0))])],
    ['built: payment hash of 52 words, no fixture hash', encodeWithoutHash([tagged(1, new Array(52).fill(0))])],
    ['built: no payment hash at all', encodeWithoutHash([])],
    ['built: payment hash twice', encodeWithoutHash([tagged(1, new Array(52).fill(0)), tagged(1, new Array(52).fill(1))])],
    [
      'built: unknown tags are ignored',
      build('lnbc1m', [tagged(0, [1, 2, 3]), tagged(2, [1]), tagged(9, [0, 1]), tagged(16, new Array(52).fill(3)), tagged(24, [10]), tagged(27, [1, 2]), tagged(31, [])]),
    ],
    ['built: secret and features fields', build('lnbc1m', [tagged(16, new Array(52).fill(3)), tagged(5, [8, 2])])],
    ['built: a field longer than the data', encodeWithoutHash([tagged(1, new Array(52).fill(0)), [13, 1, 0, 1]])],
    ['built: one stray word after the fields', encodeWithoutHash([tagged(1, new Array(52).fill(0)), [13]])],
    ['built: two stray words after the fields', encodeWithoutHash([tagged(1, new Array(52).fill(0)), [13, 0]])],
    ['built: three words that are an empty field', encodeWithoutHash([tagged(1, new Array(52).fill(0)), [13, 0, 0]])],
    ['built: a field whose length word is 31 and the next 31', encodeWithoutHash([tagged(1, new Array(52).fill(0)), tagged(13, new Array(1023).fill(0))])],
    ['built: signature of 103 words', encodeSignatureWords(103)],
    ['built: signature of 104 words, no fields', encodeSignatureWords(104)],
    ['built: signature of 105 words', encodeSignatureWords(105)],
    ['built: fewer than 7 timestamp words', bech32.encode('lnbc1m', [1, 2, 3], false)],
    ['built: empty data', bech32.encode('lnbc1m', [], false)],
    ['built: exactly 111 words and no fields', bech32.encode('lnbc1m', new Array(111).fill(0), false)],
    ['built: 4097 characters, readable by the reader', build('lnbc1m', pad(4097 - a('lnbc1m').length))],
    ['built: 8000 characters', build('lnbc1m', pad(8000 - a('lnbc1m').length))],
    [
      'built: all 32 word values as description padding',
      build('lnbc1m', [
        tagged(
          13,
          Array.from({ length: 32 }, (_, i) => i),
        ),
      ]),
    ],
  ]
}

function encodeWithoutHash(fields: number[][]): string {
  return bech32.encode('lnbc1m', [...intWords(T, 7), ...fields.flat(), ...new Array(104).fill(0)], false)
}
function encodeSignatureWords(n: number): string {
  return bech32.encode('lnbc1m', [...intWords(T, 7), ...tagged(1, new Array(52).fill(0)), ...new Array(n).fill(0)], false)
}

const COFFEE_BIP21 = (extra: string) => `bitcoin:bc1qw508d6qejxtdg4y5r3zarvary0c5xw7kv8f3t4?${extra}`

const CANDIDATE_TEXTS: Array<[string, string]> = [
  ['BIP21 lightning= param', COFFEE_BIP21(`amount=0.0025&lightning=${COFFEE}`)],
  ['url-encoded lightning= param', `bitcoin:bc1q?lightning=${encodeURIComponent(COFFEE.toUpperCase())}`],
  ['bitcoin: without lightning is skipped', 'bitcoin:bc1qabc?amount=1'],
  ['plain words kept in order', 'pay  this\nlnbc1x'],
  ['empty text', ''],
  ['only spaces', '  \n\t '],
  ['bitcoin: without a question mark', 'bitcoin:bc1qabc'],
  ['bitcoin: with a question mark and nothing', 'bitcoin:bc1qabc?'],
  ['upper case BITCOIN: and LIGHTNING=', `BITCOIN:bc1q?LIGHTNING=${COFFEE}`],
  ['two lightning= params', `bitcoin:bc1q?lightning=${COFFEE}&lightning=${DONATION}`],
  ['an empty lightning= is skipped', `bitcoin:bc1q?lightning=&lightning=${COFFEE}`],
  ['lightning without a value is skipped', `bitcoin:bc1q?lightning&lightning=${COFFEE}`],
  ['malformed percent escape is skipped', 'bitcoin:bc1q?lightning=%E0%A4%A&lightning=%41'],
  ['malformed escape then a good one', `bitcoin:bc1q?lightning=%ZZ&lightning=${COFFEE}`],
  ['lightning value cut at a second equals sign', 'bitcoin:bc1q?lightning=abc=def'],
  ['lightning value that is itself percent-encoded twice', 'bitcoin:bc1q?lightning=%2541'],
  ['plus sign is not a space', 'bitcoin:bc1q?lightning=a+b'],
  ['percent-encoded UTF-8', 'bitcoin:bc1q?lightning=%ED%95%9C'],
  ['other keys are ignored', 'bitcoin:bc1q?label=x&message=y&amount=1'],
  ['lightning in the address part is not a param', 'bitcoin:lightning=abc'],
  ['a bitcoin: token and plain words around it', `look ${COFFEE_BIP21(`lightning=${COFFEE}`)} here`],
  ['an invoice with the lightning: scheme stays as a token', `lightning:${COFFEE} and ${DONATION}`],
  ['tokens split on any whitespace', 'a\tb\nc\r\nd\u00a0e\u2003f'],
  ['non-ASCII words', '결제 요청 ナンセンス 🙂'],
  ['leading and trailing whitespace', `  ${COFFEE}  `],
  ['two bitcoin: links', `${COFFEE_BIP21(`lightning=${COFFEE}`)} ${COFFEE_BIP21(`lightning=${DONATION}`)}`],
  ['bitcoin: scheme inside a longer word is a plain token', `xbitcoin:bc1q?lightning=${COFFEE}`],
]

/** An invoice and a moment: what the issue and timer functions read. */
const NOW_CASES: Array<[string, string, number]> = []
function addNow(label: string, invoice: string, expiresAt: number): void {
  const fromCreation = [-1500, -1, 0, 1, 999, 1000, 59_999, 60_000, 3_599_999, 3_600_000]
  const aroundExpiry = expiresAt - T < 1e9 ? [-121_000, -120_001, -120_000, -119_999, -1001, -1000, -999, -1, 0, 1, 999, 1000, 1001] : []
  const moments = new Set<number>(fromCreation.map((dt) => T * 1000 + dt))
  for (const e of aroundExpiry) moments.add(expiresAt * 1000 + e)
  for (const at of [...moments].sort((x, y) => x - y)) NOW_CASES.push([`${label} at ${at}`, invoice, at])
}

export function bolt11Vectors(): VectorFile {
  const coffeeBuilt = build('lnbc1m', [tagged(6, intWords(60, 2))])
  const noAmountBuilt = build('lnbc')
  const regtestBuilt = build('lnbcrt1m')
  const expiryZero = build('lnbc1m', [tagged(6, [])])
  const hugeExpiry = build('lnbc1m', [tagged(6, intWords(2 ** 50 - 1, 10))])
  const testnetNoAmount = build('lntb')
  addNow('coffee', COFFEE, T + 60)
  addNow('donation', DONATION, T + 3600)
  addNow('testnet', TESTNET, T + 3600)
  addNow('built 60s', coffeeBuilt, T + 60)
  addNow('built no amount', noAmountBuilt, T + 3600)
  addNow('built regtest', regtestBuilt, T + 3600)
  addNow('built expiry 0', expiryZero, T)
  addNow('built huge expiry', hugeExpiry, T + 2 ** 50 - 1)
  addNow('built testnet no amount', testnetNoAmount, T + 3600)
  for (const at of [-1500, -1001, -1000, -1, 0]) NOW_CASES.push([`coffee before 1970 at ${at}`, COFFEE, at])

  const issuesWithText = (text: string, nowMs: number) => {
    const inv = decodeInvoice(text)
    if (!inv) throw new Error('the vector invoice must decode')
    return invoiceIssues(inv, nowMs)
  }
  const secondsLeftWithText = (text: string, nowMs: number) => {
    const inv = decodeInvoice(text)
    if (!inv) throw new Error('the vector invoice must decode')
    return secondsLeft(inv, nowMs)
  }

  const recount: CaseSpec[] = []
  const EXP = T + 60
  for (const [label, nowMs, interval] of [
    ['far from expiry', T * 1000, 15_000],
    ['11 s left, wake at the expiry', (EXP - 11) * 1000, 15_000],
    ['1 s left', (EXP - 1) * 1000, 15_000],
    ['1 ms before the expiry second', EXP * 1000 - 1, 15_000],
    ['at the expiry second', EXP * 1000, 15_000],
    ['499 ms after the expiry', EXP * 1000 + 499, 15_000],
    ['exactly at the end of the slack', EXP * 1000 + EXPIRY_RECOUNT_SLACK_MS, 15_000],
    ['1 ms after the slack', EXP * 1000 + EXPIRY_RECOUNT_SLACK_MS + 1, 15_000],
    ['long after', (EXP + 3600) * 1000, 15_000],
    ['interval shorter than the time left', (EXP - 100) * 1000, 1000],
    ['interval equal to the time left', EXP * 1000 + EXPIRY_RECOUNT_SLACK_MS - 15_000, 15_000],
    ['interval zero', (EXP - 100) * 1000, 0],
    ['interval negative', (EXP - 100) * 1000, -5],
    ['interval fractional', (EXP - 100) * 1000, 0.5],
    ['now before 1970', -5000, 15_000],
    ['now fractional', EXP * 1000 + 0.5, 15_000],
    ['now NaN', Number.NaN, 15_000],
    ['interval NaN', (EXP - 100) * 1000, Number.NaN],
    ['interval Infinity', (EXP - 100) * 1000, Infinity],
  ] as Array<[string, number, number]>) {
    recount.push([label, [EXP, nowMs, interval]])
  }
  recount.push(['expiry 0', [0, 0, 15_000]], ['expiry 0 one ms later', [0, 1, 15_000]], ['expiry huge', [2 ** 50, 0, 15_000]], ['expiry NaN', [Number.NaN, 0, 15_000], OUT])

  return {
    module: 'bolt11',
    constants: { EXPIRING_SOON_SECONDS, EXPIRY_RECOUNT_SLACK_MS, DEFAULT_EXPIRY_SECONDS: 3600 },
    functions: {
      stripLightningScheme: defineFunction(['text'], stripLightningScheme, [
        ['no scheme', [COFFEE]],
        ['lightning: scheme', [`lightning:${COFFEE}`]],
        ['LIGHTNING: scheme', [`LIGHTNING:${COFFEE}`]],
        ['mixed case scheme', [`LiGhTnInG:${COFFEE}`]],
        ['space inside after the scheme is kept', ['lightning: abc']],
        ['padded', [`  lightning:${COFFEE}\n`]],
        ['scheme twice, one removed', ['lightning:lightning:abc']],
        ['scheme in the middle', ['abc lightning:def']],
        ['only the scheme', ['lightning:']],
        ['only spaces', ['   ']],
        ['empty', ['']],
        ['no-break space is trimmed', ['\u00a0lightning:abc\u00a0']],
        ['zero-width space is not trimmed', ['\u200blightning:abc']],
        ['byte order mark is trimmed', ['\ufefflightning:abc']],
        ['dotless i does not match', ['l\u0131ghtning:abc']],
        ['Kelvin sign does not matter, no k in the scheme', ['lightning:\u212a']],
      ]),
      decodeInvoice: defineFunction(['text'], decodeInvoice, [
        ...SPEC_VECTORS.map(([n, s]): CaseSpec => [n, [s]]),
        ['coffee with lightning: prefix', [`lightning:${COFFEE}`]],
        ['coffee with LIGHTNING: prefix and spaces', [`  LIGHTNING:${COFFEE}\n`]],
        ['coffee with a space after the scheme', [`lightning: ${COFFEE}`]],
        ['coffee with the scheme twice', [`lightning:lightning:${COFFEE}`]],
        ['coffee with a space inside', [`${COFFEE.slice(0, 50)} ${COFFEE.slice(50)}`]],
        ['coffee with a zero-width space around', [`\u200b${COFFEE}`]],
        ['coffee in mixed case', [COFFEE.slice(0, 40).toUpperCase() + COFFEE.slice(40)]],
        ['coffee with a trailing character', [`${COFFEE}q`]],
        ['coffee with the first character removed', [COFFEE.slice(1)]],
        ['coffee with a changed last character', [`${COFFEE.slice(0, -1)}q`]],
        ...INVALID.map(([n, s]): CaseSpec => [`rejects ${n}`, [s]]),
        ...builtInvoices().map(([n, s]): CaseSpec => [n, [s]]),
        ['non-string null', [null], OUT],
        ['non-string number', [5], OUT],
        ...aroundEdges(COFFEE).map(([n, a]): CaseSpec => [`coffee, ${n}`, a]),
      ]),
      invoiceCandidates: defineFunction(
        ['text'],
        invoiceCandidates,
        CANDIDATE_TEXTS.map(([n, s]): CaseSpec => [n, [s]]),
      ),
      secondsLeft: defineFunction(
        ['invoice', 'nowMs'],
        secondsLeftWithText,
        NOW_CASES.map(([n, inv, now]): CaseSpec => [n, [inv, now]]),
      ),
      msUntilRecount: defineFunction(['expiresAt', 'nowMs', 'intervalMs'], msUntilRecount, recount),
      invoiceIssues: defineFunction(
        ['invoice', 'nowMs'],
        issuesWithText,
        NOW_CASES.map(([n, inv, now]): CaseSpec => [n, [inv, now]]),
      ),
    },
  }
}
