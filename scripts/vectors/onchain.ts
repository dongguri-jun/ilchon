/**
 * Vectors for src/lib/onchain: mainnet addresses, why one was refused, bitcoin: links, the on-chain card values.
 * Address cases are the BIP-173, BIP-350 and base58 vectors of scripts/check-onchain.ts, then boundaries.
 */
import { sha256 } from '@noble/hashes/sha2.js'
import { bech32, bech32m, createBase58check } from '@scure/base'
import { addressProblem, bip21, btcText, onchainCardValues, parseAddress, parseOnchainRequest } from '../../src/lib/onchain'
import { aroundEdges, type CaseSpec, defineFunction, type VectorFile } from './kit'

const OUT = { outOfDomain: true } as const

const P2WPKH = 'bc1qw508d6qejxtdg4y5r3zarvary0c5xw7kv8f3t4'
const P2WSH = 'bc1qrp33g0q5c5txsp9arysrx4k6zdkfs4nce4xj0gdcccefvpysxf3qccfmv3'
const P2TR = 'bc1p0xlxvlhemja6c4dqv22uapctqupfhlxm9h8z3k2e72q4k9hcz7vqzk5jj0'
const P2PKH = '1BvBMSEYstWetqTFn5Au4m4GFg7xJaNVN2'
const P2SH = '3J98t1WpEZ73CNmQviecrnyiWrnqRhWNLy'
const TB = 'tb1qw508d6qejxtdg4y5r3zarvary0c5xw7kxpjzsx'
const INVOICE = 'lnbc2500u1pvjluezpp5qqqsyqcyq5rqwzqfqqqsyqcyq5rqwzqfqqqsyqcyq5rqwzqfqypqdpquwpc4curk03c9wlrswe78q4eyqc7d8d0x'
const LNURL = 'lnurl1dp68gurn8ghj7um9wfmxjcm99e3k7mf0v9cxj0m385ekvcenxc6r2c35xvukxefcv5mkvv34x5ekzd3ev56nyd3hxqurzepexejxxepnxscrvwfnv9nxzcn9xq6xyefhvgcxxcmyxymnserxfq5fns'
const BOLT12 = 'lno1pqps7sjqpgtyzm3qv4uxzmtsd3jjqer9wd3hy6tsw35k7msjzfpy7nz5yqcnygrfdej82um5wf5k2uckyypwa3eyt44h6txtxquqh7lz5djge4afgfjn7k4rgrkuag0jsd5xvxg'
const KELVIN = '\u212a'

const b58 = createBase58check(sha256)
const twenty = new Uint8Array(20).fill(9)
const withVersion = (v: number, body: Uint8Array = twenty) => b58.encode(Uint8Array.from([v, ...body]))

/** Well-formed segwit addresses of the BIPs that are still refused here (wrong network or an unpayable version). */
const WELLFORMED_REFUSED = [
  'tb1qrp33g0q5c5txsp9arysrx4k6zdkfs4nce4xj0gdcccefvpysxf3q0sl5k7',
  'tb1qqqqqp399et2xygdj5xreqhjjvcmzhxw4aywxecjdzew6hylgvsesrxh6hy',
  'tb1pqqqqp399et2xygdj5xreqhjjvcmzhxw4aywxecjdzew6hylgvsesf3hn0c',
  TB,
  'bc1pw508d6qejxtdg4y5r3zarvary0c5xw7kw508d6qejxtdg4y5r3zarvary0c5xw7kt5nd6y',
  'BC1SW50QGDZ25J',
  'bc1zw508d6qejxtdg4y5r3zarvaryvaxxpcs',
]

const BIP173_ONLY = ['bc1pw508d6qejxtdg4y5r3zarvary0c5xw7kw508d6qejxtdg4y5r3zarvary0c5xw7k7grplx', 'BC1SW50QA3JX3S', 'bc1zw508d6qejxtdg4y5r3zarvaryvg6kdaj']

const INVALID_VECTORS: Array<[string, string]> = [
  ['tc1qw508d6qejxtdg4y5r3zarvary0c5xw7kg3g4ty', 'invalid hrp'],
  ['bc1qw508d6qejxtdg4y5r3zarvary0c5xw7kv8f3t5', 'invalid checksum (one character changed)'],
  ['BC13W508D6QEJXTDG4Y5R3ZARVARY0C5XW7KN40WF2', 'invalid witness version'],
  ['bc1rw5uspcuh', 'invalid program length'],
  ['bc10w508d6qejxtdg4y5r3zarvary0c5xw7kw508d6qejxtdg4y5r3zarvary0c5xw7kw5rljs90', 'invalid program length (long)'],
  ['BC1QR508D6QEJXTDG4Y5R3ZARVARYV98GJ9P', 'v0 program length (BIP-141)'],
  ['tb1qrp33g0q5c5txsp9arysrx4k6zdkfs4nce4xj0gdcccefvpysxf3q0sL5k7', 'mixed case'],
  ['bc1zw508d6qejxtdg4y5r3zarvaryvqyzf3du', 'zero padding of more than 4 bits'],
  ['tb1qrp33g0q5c5txsp9arysrx4k6zdkfs4nce4xj0gdcccefvpysxf3pjxtptv', 'non-zero padding'],
  ['bc1gmk9yu', 'empty data section'],
  ['tc1p0xlxvlhemja6c4dqv22uapctqupfhlxm9h8z3k2e72q4k9hcz7vq5zuyut', 'invalid hrp (taproot)'],
  ['bc1p0xlxvlhemja6c4dqv22uapctqupfhlxm9h8z3k2e72q4k9hcz7vqh2y7hd', 'v1 in bech32 instead of bech32m'],
  ['tb1z0xlxvlhemja6c4dqv22uapctqupfhlxm9h8z3k2e72q4k9hcz7vqglt7rf', 'v2 in bech32 instead of bech32m'],
  ['BC1S0XLXVLHEMJA6C4DQV22UAPCTQUPFHLXM9H8Z3K2E72Q4K9HCZ7VQ54WELL', 'v16 in bech32 instead of bech32m'],
  ['bc1qw508d6qejxtdg4y5r3zarvary0c5xw7kemeawh', 'v0 in bech32m instead of bech32'],
  ['tb1q0xlxvlhemja6c4dqv22uapctqupfhlxm9h8z3k2e72q4k9hcz7vq24jc47', 'v0 in bech32m instead of bech32 (testnet)'],
  ['bc1p38j9r5y49hruaue7wxjce0updqjuyyx0kh56v8s25huc6995vvpql3jow4', 'invalid character in checksum'],
  ['BC130XLXVLHEMJA6C4DQV22UAPCTQUPFHLXM9H8Z3K2E72Q4K9HCZ7VQ7ZWS8R', 'invalid witness version (upper)'],
  ['bc1pw5dgrnzv', 'v1 program of 1 byte'],
  ['bc1p0xlxvlhemja6c4dqv22uapctqupfhlxm9h8z3k2e72q4k9hcz7v8n0nx0muaewav253zgeav', 'v1 program of 41 bytes'],
  ['tb1p0xlxvlhemja6c4dqv22uapctqupfhlxm9h8z3k2e72q4k9hcz7vq47Zagq', 'mixed case (taproot)'],
  ['bc1p0xlxvlhemja6c4dqv22uapctqupfhlxm9h8z3k2e72q4k9hcz7v07qwwzcrf', 'zero padding of more than 4 bits (taproot)'],
  ['tb1p0xlxvlhemja6c4dqv22uapctqupfhlxm9h8z3k2e72q4k9hcz7vpggkg4j', 'non-zero padding (taproot)'],
]

/** The two "non-zero padding" vectors re-encoded under the mainnet prefix: the padding rule itself refuses them. */
function mainnetPaddingCopies(): Array<[string, string]> {
  return (
    [
      ['tb1qrp33g0q5c5txsp9arysrx4k6zdkfs4nce4xj0gdcccefvpysxf3pjxtptv', bech32],
      ['tb1p0xlxvlhemja6c4dqv22uapctqupfhlxm9h8z3k2e72q4k9hcz7vpggkg4j', bech32m],
    ] as const
  ).map(([tb, coder]) => {
    const { words } = coder.decode(tb as `${string}1${string}`)
    return [coder.encode('bc', words), 'mainnet copy of a non-zero padding vector'] as [string, string]
  })
}

/** Text around an address that must never be read as one. */
const LOOKALIKES: Array<[string, string]> = [
  [`${P2WPKH.slice(0, 20)}\u200b${P2WPKH.slice(20)}`, 'zero-width space inside'],
  [`${P2WPKH.slice(0, 20)}\u2060${P2WPKH.slice(20)}`, 'word joiner inside'],
  [`\ufeff${P2WPKH}`, 'byte order mark first'],
  [`${P2WPKH.slice(0, -1)}\u0430`, 'Cyrillic a at the end'],
  [`\u0412C1${P2WPKH.slice(3).toUpperCase()}`, 'Cyrillic B at the start'],
  [P2WPKH.replace('bc1', 'ｂｃ１'), 'full-width bc1'],
  [`bitcoin:${P2WPKH}`, 'a bitcoin: link'],
  [`lightning:${P2WPKH}`, 'a lightning: prefix'],
  [P2WPKH.slice(0, 10) + P2WPKH.slice(10).toUpperCase(), 'mixed case'],
  [`${P2WPKH} x`, 'a word after it'],
  [`${P2WPKH}\u00a0`, 'no-break space after it'],
  [`${P2WPKH}\u200b`, 'zero-width space after it'],
  [`\u00a0${P2WPKH}`, 'no-break space before it'],
  ['BC1QW508D6QEJXTDG4Y5R3ZARVARY0C5XW7KV8F3T4'.replace('K', KELVIN), 'upper case with the Kelvin sign for K'],
  [P2WPKH.toUpperCase().replace('Y', '\u0423'), 'upper case with a Cyrillic letter'],
  [`${P2PKH} `, 'base58 with a trailing space'],
  [`${P2PKH.slice(0, 10)} ${P2PKH.slice(10)}`, 'base58 with a space inside'],
  [`${P2PKH.slice(0, 5)}\u200b${P2PKH.slice(5)}`, 'base58 with a zero-width space'],
]

/** Reasons `addressProblem` names, with the input that causes each. */
const PROBLEMS: Array<[string, string]> = [
  [P2WPKH, 'mainnet p2wpkh'],
  [P2PKH, 'mainnet p2pkh'],
  [`  ${P2WPKH}\n`, 'padded mainnet'],
  [INVOICE, 'invoice'],
  [INVOICE.toUpperCase(), 'invoice upper case'],
  [`lightning:${INVOICE}`, 'lightning: link'],
  [`LIGHTNING:${INVOICE}`, 'LIGHTNING: link'],
  ['lntb2500u1pvjluezpp5qqqsyqcyq5rqwzqfqqqsyqcyq5rqwzqfqqqsyqcyq5rqwzqfq', 'testnet invoice is still an invoice'],
  ['lnbcrt1m', 'regtest invoice prefix'],
  [LNURL, 'LNURL'],
  [LNURL.toUpperCase(), 'LNURL upper case'],
  [BOLT12, 'BOLT12 offer'],
  ['lnbc', 'only the invoice prefix'],
  ['lightning:', 'only the scheme'],
  [TB, 'testnet p2wpkh'],
  ['tb1qrp33g0q5c5txsp9arysrx4k6zdkfs4nce4xj0gdcccefvpysxf3q0sl5k7', 'testnet p2wsh'],
  ['tb1pqqqqp399et2xygdj5xreqhjjvcmzhxw4aywxecjdzew6hylgvsesf3hn0c', 'testnet p2tr'],
  [TB.toUpperCase(), 'testnet upper case'],
  [bech32.encode('bcrt', [0, ...bech32.toWords(twenty)]), 'regtest p2wpkh'],
  ['mipcBbFg9gMiCh81Kj8tqqdgoZub1ZJRfn', 'testnet p2pkh'],
  ['2MzQwSSnBHWHqSAqtTVQ6v47XtaisrJa1Vc', 'testnet p2sh'],
  [withVersion(0x6f), 'testnet p2pkh built here'],
  [withVersion(0xc4), 'testnet p2sh built here'],
  [`bitcoin:${TB}?amount=0.1`, 'bitcoin: link to a testnet address'],
  ['bc1qw508d6qejxtdg4y5r3zarvary0c5xw7kv8f3t5', 'mainnet bech32, one character changed'],
  [`${TB.slice(0, -1)}y`, 'testnet prefix with a broken checksum is a typo, not testnet'],
  ['tb1qw508d6qejxtdg4y5r3zarvary0c5xw7kxpjzsX', 'testnet prefix, mixed case'],
  ['bc1qw508d6qejxtdg4y5r3zarvary0c5xw7kv8f3T4', 'mainnet, mixed case'],
  ['bc1qw508d6qejxt', 'short bech32 string, 15 characters'],
  ['bc1qw508d6qejx', 'short bech32 string, 14 characters'],
  ['bc1qw508d6qej', 'short bech32 string, 13 characters'],
  ['bcrt1qw508d6qejxtdg4y5r3zarvary0c5xw7kygt08x', 'regtest, broken checksum'],
  [P2PKH.slice(0, -1) + '3', 'base58 checksum fails'],
  [P2PKH.slice(0, -1) + '0', 'base58 with a 0'],
  [P2PKH.slice(0, -1) + 'l', 'base58 with an l'],
  ['3J98t1WpEZ73CNmQviecrnyiWrnqRhWNLz', 'p2sh, last letter changed'],
  ['mipcBbFg9gMiCh81Kj8tqqdgoZub1ZJRfm', 'testnet-looking base58, checksum fails'],
  ['1234567890123456789012345678', 'digits that look like base58'],
  ['123456789012345678901234567', 'digits, 27 characters, with a 0'],
  ['bc1zw508d6qejxtdg4y5r3zarvaryvaxxpcs', 'segwit v2'],
  ['BC1SW50QGDZ25J', 'segwit v16'],
  ['bc1pw508d6qejxtdg4y5r3zarvary0c5xw7kw508d6qejxtdg4y5r3zarvary0c5xw7kt5nd6y', 'v1 with 40 bytes'],
  ['BC1QR508D6QEJXTDG4Y5R3ZARVARYV98GJ9P', 'v0 with a wrong length'],
  [`bitcoin:${P2WPKH}?req-foo=1`, 'link with a req- parameter'],
  [`bitcoin:${P2WPKH}?amount=0`, 'link with a bad amount'],
  [`bitcoin:${P2WPKH}?amount=0.1`, 'link with a good address and amount is still unsupported here'],
  [`bitcoin:${P2WPKH.slice(0, -1)}q?amount=0.1`, 'link whose address has a typo'],
  [`bitcoin:${P2WPKH}`, 'link with a good address and no query'],
  ['bitcoin:bitcoin:' + P2WPKH, 'two schemes'],
  ['bitcoin:', 'no address'],
  ['bitcoin:?amount=1', 'no address, amount'],
  ['BITCOIN:' + INVOICE, 'bitcoin: link carrying an invoice'],
  ['tc1qw508d6qejxtdg4y5r3zarvary0c5xw7kg3g4ty', 'invalid hrp'],
  ['', 'empty'],
  ['   ', 'blank'],
  ['hello', 'plain word'],
  ['bc1', 'prefix only'],
  ['a'.repeat(200), 'too long'],
  ['bc1' + 'q'.repeat(88), 'bech32-looking, 91 characters'],
  ['bc1' + 'q'.repeat(87), 'bech32-looking, 90 characters'],
  [withVersion(0x30), 'other base58 version with a good checksum'],
  [b58.encode(new Uint8Array([0x80, ...new Array(32).fill(9)])), '33-byte base58check payload (private key)'],
  [b58.encode(new Uint8Array(78).fill(4)), '78-byte base58check payload (extended key)'],
  [withVersion(0x00, new Uint8Array(21)), 'base58 payload of 22 bytes'],
  [withVersion(0x00, new Uint8Array(19)), 'base58 payload of 20 bytes'],
  [`${P2WPKH.slice(0, 20)}\u200b${P2WPKH.slice(20)}`, 'zero-width space inside'],
  [`${P2WPKH.slice(0, -1)}\u0430`, 'Cyrillic a at the end'],
  ['BC1QW508D6QEJXTDG4Y5R3ZARVARY0C5XW7KV8F3T4'.replace('K', KELVIN), 'upper case with the Kelvin sign for K'],
  [TB.toUpperCase().replace('K', KELVIN), 'testnet upper case with the Kelvin sign for K'],
]

const A = P2WPKH
const AMOUNT_LINKS: Array<[string, string]> = [
  [`bitcoin:${A}?amount=0.001&label=x`, 'amount and label'],
  [`BITCOIN:${A.toUpperCase()}`, 'upper case link and address, no amount'],
  [`BITCOIN:${A.toUpperCase()}?AMOUNT=0.5`, 'upper case AMOUNT key'],
  [`bitcoin:${A}?amount=1.23456789&message=hi%20there&lightning=lnbc1xyz`, 'message and lightning ignored'],
  [`bitcoin:${A}?amount=21000000`, 'the cap'],
  [`bitcoin:${A}?amount=21000000.00000001`, 'one sat over the cap'],
  [`bitcoin:${A}?amount=20999999.99999999`, 'one sat under the cap'],
  [`bitcoin:${A}?amount=00000001`, 'leading zeros'],
  [`bitcoin:${A}?amount=00000000.00000001`, 'eight leading digits and one sat'],
  [`bitcoin:${A}?amount=123456789`, 'nine integer digits'],
  [`bitcoin:${A}?amount=12345678`, 'eight integer digits over the cap'],
  [`bitcoin:${A}?amount=1.`, 'trailing point'],
  [`bitcoin:${A}?amount=.5`, 'leading point'],
  [`bitcoin:${A}?amount=0.1.2`, 'two points'],
  [`bitcoin:${A}?amount= 0.1`, 'leading space in the amount'],
  [`bitcoin:${A}?amount=0.1%20`, 'percent-encoded space is not decoded'],
  [`bitcoin:${A}?amount=%30.1`, 'percent-encoded digit is not decoded'],
  [`bitcoin:${A}?amount=0.000000001`, '9 decimal places'],
  [`bitcoin:${A}?amount=-1`, 'negative'],
  [`bitcoin:${A}?amount=+1`, 'plus sign'],
  [`bitcoin:${A}?amount=1e-3`, 'exponent'],
  [`bitcoin:${A}?amount=21000001`, 'over 21M BTC'],
  [`bitcoin:${A}?amount=0`, 'zero'],
  [`bitcoin:${A}?amount=0.00000000`, 'zero with eight decimals'],
  [`bitcoin:${A}?amount=`, 'empty amount'],
  [`bitcoin:${A}?amount`, 'amount key without a value'],
  [`bitcoin:${A}?amount=1,5`, 'comma'],
  [`bitcoin:${A}?amount=0.1&amount=0.2`, 'amount given twice'],
  [`bitcoin:${A}?amount=0.1&AMOUNT=0.1`, 'amount given twice, one upper case'],
  [`bitcoin:${A}?req-foo=1`, 'req- parameter'],
  [`bitcoin:${A}?amount=0.1&REQ-foo=1`, 'req- parameter (upper case)'],
  [`bitcoin:${A}?req-foo`, 'req- parameter without a value'],
  [`bitcoin:${A}?Req-foo=1&amount=0.1`, 'req- parameter first'],
  [`bitcoin:${A}?label=req-foo`, 'req- only in a value'],
  [`bitcoin:${A}?x-req-foo=1&amount=0.1`, 'req- not at the start of the key'],
  [`bitcoin:${A}?&&amount=0.1&&`, 'empty pairs'],
  [`bitcoin:${A}?`, 'question mark and nothing after'],
  [`bitcoin:${A}?amount=0.1#frag`, 'a fragment after the amount'],
  [`bitcoin:${A}?label=a=b&amount=0.1`, 'an equals sign in another value'],
  [`bitcoin:${A}?amount=0.1=0.2`, 'an equals sign in the amount'],
  [`bitcoin:${A}?amount=٣`, 'Arabic-Indic digit'],
  [`bitcoin:${A}?amount=１`, 'fullwidth digit'],
  [`bitcoin:${A}?amount=1\n`, 'newline after the amount'],
  [`bitcoin:${A}?amount=1\u00a0`, 'no-break space after the amount'],
  [`  bitcoin:${A}?amount=0.1\n`, 'padded link'],
  [`bitcoin:${P2PKH}?amount=0.01`, 'base58 address'],
  [`bitcoin:${P2SH}`, 'base58 p2sh, no amount'],
  [`bitcoin:${P2TR}?amount=0.002`, 'taproot address'],
  [`bitcoin:${P2WSH.toUpperCase()}?amount=0.002`, 'p2wsh upper case'],
  [`bitcoin:${A.slice(0, 20)} ${A.slice(20)}`, 'a space inside the address'],
  ['bitcoin:tb1qw508d6qejxtdg4y5r3zarvary0c5xw7kxpjzsx?amount=0.1', 'testnet address'],
  ['bitcoin:', 'no address'],
  ['bitcoin:?amount=1', 'no address, amount'],
  [`bitcoin:bitcoin:${A}`, 'two schemes'],
  [`bitcoin://${A}`, 'a double slash'],
  [`bitcoin:${A}/?amount=0.1`, 'a slash before the query'],
  [`${A}?amount=0.1`, 'a bare address with a query'],
  [`lightning:${A}`, 'a lightning: prefix'],
  [`bitcoin:${A}?amount=0.1\u0000`, 'a NUL after the amount'],
  [`BiTcOiN:${A}`, 'mixed case scheme'],
  [A, 'bare address'],
  [A.toUpperCase(), 'bare upper case address'],
  [P2PKH, 'bare base58'],
  [`  ${A}\r\n`, 'bare, padded'],
  ['hello', 'plain word'],
  ['', 'empty'],
]

const SATS_VALUES: number[] = [1, 2, 9, 10, 99, 100, 1000, 98039, 100_000, 123_456_789, 99_999_999, 100_000_000, 100_000_001, 1_000_000_000, 2_100_000_000_000_000, 2_099_999_999_999_999]

export function onchainVectors(): VectorFile {
  const sats: CaseSpec[] = SATS_VALUES.map((n): CaseSpec => [`${n}`, [n]])
  const badSats: CaseSpec[] = [
    ['0', [0]],
    ['-1', [-1]],
    ['1.5', [1.5]],
    ['0.5', [0.5]],
    ['NaN', [Number.NaN]],
    ['Infinity', [Infinity]],
    ['-Infinity', [-Infinity]],
    ['negative zero', [-0]],
    ['one over 21M BTC', [2_100_000_000_000_001]],
    ['2^53 - 1 is over 21M BTC', [2 ** 53 - 1]],
    ['2^53', [2 ** 53]],
    ['1e21', [1e21]],
  ]
  return {
    module: 'onchain',
    constants: { MAX_ADDRESS: 90, SATS_PER_BTC: 100_000_000, MAX_SATS: 2_100_000_000_000_000 },
    functions: {
      parseAddress: defineFunction(['text'], parseAddress, [
        ['mainnet p2wpkh', [P2WPKH]],
        ['upper case p2wpkh', ['BC1QW508D6QEJXTDG4Y5R3ZARVARY0C5XW7KV8F3T4']],
        ['p2wsh', [P2WSH]],
        ['p2tr', [P2TR]],
        ['p2pkh', [P2PKH]],
        ['p2sh', [P2SH]],
        ['padded with spaces and a line break', [`  ${P2WPKH}\n`]],
        ['padded with CRLF', [`${P2WPKH} \r\n`]],
        ['padded with tabs', [`\t${P2WPKH}\t`]],
        ['upper case p2wsh', [P2WSH.toUpperCase()]],
        ['upper case p2tr', [P2TR.toUpperCase()]],
        ['base58 built here: p2pkh control', [withVersion(0x00)]],
        ['base58 built here: p2sh control', [withVersion(0x05)]],
        ...WELLFORMED_REFUSED.map((s): CaseSpec => [`well-formed but refused ${s.slice(0, 14)}`, [s]]),
        ...BIP173_ONLY.map((s): CaseSpec => [`v1+ in bech32 (BIP-173 era) ${s.slice(0, 14)}`, [s]]),
        ...INVALID_VECTORS.map(([s, why]): CaseSpec => [`BIP vector: ${why} ${s.slice(0, 12)}`, [s]]),
        ...mainnetPaddingCopies().map(([s, why]): CaseSpec => [`${why} ${s.slice(0, 6)}`, [s]]),
        ['mixed-case bech32', ['bc1qw508d6qejxtdg4y5r3zarvary0c5xw7kV8F3T4']],
        ['checksum one character changed', ['bc1qw508d6qejxtdg4y5r3zarvary0c5xw7kv8f3t5']],
        ['base58 checksum wrong', ['1BvBMSEYstWetqTFn5Au4m4GFg7xJaNVN3']],
        ['base58 testnet p2pkh', ['mipcBbFg9gMiCh81Kj8tqqdgoZub1ZJRfn']],
        ['base58 testnet p2pkh built here', [withVersion(0x6f)]],
        ['base58 testnet p2sh built here', [withVersion(0xc4)]],
        ['base58 with 21 bytes of payload', [withVersion(0x00, new Uint8Array(21))]],
        ['base58 with 19 bytes of payload', [withVersion(0x00, new Uint8Array(19))]],
        ['base58 version 0x30', [withVersion(0x30)]],
        ['regtest bcrt1', [bech32.encode('bcrt', [0, ...bech32.toWords(twenty)])]],
        ['mainnet p2wpkh built here (20 bytes of 9)', [bech32.encode('bc', [0, ...bech32.toWords(twenty)])]],
        ['mainnet v0 with 21 bytes', [bech32.encode('bc', [0, ...bech32.toWords(new Uint8Array(21).fill(9))])]],
        ['mainnet v0 with 33 bytes', [bech32.encode('bc', [0, ...bech32.toWords(new Uint8Array(33).fill(9))])]],
        ['mainnet v1 in bech32m with 32 bytes', [bech32m.encode('bc', [1, ...bech32.toWords(new Uint8Array(32).fill(9))])]],
        ['mainnet v1 in bech32m with 31 bytes', [bech32m.encode('bc', [1, ...bech32.toWords(new Uint8Array(31).fill(9))])]],
        ['mainnet v0 in bech32m with 20 bytes', [bech32m.encode('bc', [0, ...bech32.toWords(twenty)])]],
        ['mainnet v0 in bech32 with 32 bytes', [bech32.encode('bc', [0, ...bech32.toWords(new Uint8Array(32).fill(9))])]],
        ['empty', ['']],
        ['spaces', ['   ']],
        ['over 90 characters', [P2WPKH + 'q'.repeat(60)]],
        ['exactly 90 characters, not an address', ['bc1' + 'q'.repeat(87)]],
        ['non-string number', [42], OUT],
        ['non-string null', [null], OUT],
        ['non-string undefined', [undefined], OUT],
        ['Lightning invoice text', ['lnbc1pvjluez']],
        ...LOOKALIKES.map(([s, why]): CaseSpec => [why, [s]]),
        ...aroundEdges(P2WPKH),
        ...aroundEdges(P2PKH).map(([n, a]): CaseSpec => [`base58, ${n}`, a]),
      ]),
      addressProblem: defineFunction(['text'], addressProblem, [
        ...PROBLEMS.map(([s, why]): CaseSpec => [why, [s]]),
        ...WELLFORMED_REFUSED.map((s): CaseSpec => [`well-formed but refused ${s.slice(0, 14)}`, [s]]),
        ...INVALID_VECTORS.map(([s, why]): CaseSpec => [`BIP vector: ${why} ${s.slice(0, 12)}`, [s]]),
        ...mainnetPaddingCopies().map(([s, why]): CaseSpec => [`${why} ${s.slice(0, 6)}`, [s]]),
        ...LOOKALIKES.map(([s, why]): CaseSpec => [`look-alike: ${why}`, [s]]),
        ['non-string number', [42], OUT],
        ['non-string null', [null], OUT],
        ...aroundEdges(P2WPKH),
      ]),
      btcText: defineFunction(['sats'], btcText, [...sats, ...badSats]),
      bip21: defineFunction(['address', 'sats'], bip21, [
        [`98039`, [A, 98039]],
        ['100000', [A, 100000]],
        ['1', [A, 1]],
        ['123456789', [A, 123456789]],
        ['100000000', [A, 100000000]],
        ['21M BTC', [A, 2_100_000_000_000_000]],
        ['no amount', [A, null]],
        ...badSats.map(([n, a]): CaseSpec => [`bad amount ${n}`, [A, a[0]]]),
        ['the address is not checked', ['not an address', 1000]],
        ['empty address', ['', null]],
        ['address as given, upper case', [A.toUpperCase(), 1000]],
      ]),
      parseOnchainRequest: defineFunction(['token'], parseOnchainRequest, [
        ...AMOUNT_LINKS.map(([s, why]): CaseSpec => [why, [s]]),
        ['non-string number', [42], OUT],
        ['non-string null', [null], OUT],
        ...aroundEdges(`bitcoin:${A}?amount=0.1`),
        ...aroundEdges(A).map(([n, a]): CaseSpec => [`bare address, ${n}`, a]),
      ]),
      onchainCardValues: defineFunction(['req'], onchainCardValues, [
        ...SATS_VALUES.map((n): CaseSpec => [`${n} sats`, [{ address: A, sats: n, uri: `bitcoin:${A}?amount=${btcText(n)}` }]]),
        ['no amount', [{ address: A, sats: null, uri: `bitcoin:${A}` }]],
        ['base58 address', [{ address: P2PKH, sats: 100_000, uri: `bitcoin:${P2PKH}?amount=0.001` }]],
        ['the uri field is not read', [{ address: A, sats: 1000, uri: 'something else' }]],
        ['a sats value outside the range throws', [{ address: A, sats: 0, uri: '' }]],
        ['a fractional sats value throws', [{ address: A, sats: 1.5, uri: '' }]],
      ]),
    },
  }
}
