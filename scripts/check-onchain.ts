/**
 * Checks src/lib/onchain: mainnet address rules, bitcoin: links. No network.
 * Run: pnpm check:onchain
 *
 * Vectors copied from the BIP texts (fetched 2026-11-13):
 *   BIP-173 https://github.com/bitcoin/bips/blob/master/bip-0173.mediawiki  "Test vectors"
 *   BIP-350 https://github.com/bitcoin/bips/blob/master/bip-0350.mediawiki  "Test vectors"
 * A vector that is a valid segwit address but not one we accept (testnet, v1
 * that is not 32 bytes, v2+) is also decoded with @scure/base, so the check
 * shows it is refused by our rule and not by a broken decoder.
 */
import { sha256 } from '@noble/hashes/sha2.js'
import { bech32, bech32m, createBase58check } from '@scure/base'
import { listDictionaries } from '../src/i18n'
import { ADDRESS_PROBLEM_KEY } from '../src/screens/room/strings'
import { addressProblem, bip21, parseAddress, parseOnchainRequest, type AddressProblem } from '../src/lib/onchain/index'

let failed = 0
function check(name: string, ok: boolean, detail = ''): void {
  if (ok) console.log(`PASS ${name}`)
  else {
    failed++
    console.log(`FAIL ${name}${detail ? ` — ${detail}` : ''}`)
  }
}
const decodes = (coder: typeof bech32, s: string): boolean => {
  try {
    coder.decode(s as `${string}1${string}`, 90)
    return true
  } catch {
    return false
  }
}

// ---------------------------------------------------------------- the checksum library itself (BIP-173, BIP-350 string vectors)

const BECH32_VALID = [
  'A12UEL5L',
  'a12uel5l',
  'an83characterlonghumanreadablepartthatcontainsthenumber1andtheexcludedcharactersbio1tt5tgs',
  'abcdef1qpzry9x8gf2tvdw0s3jn54khce6mua7lmqqqxw',
  '11qqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqc8247j',
  'split1checkupstagehandshakeupstreamerranterredcaperred2y9e3w',
  '?1ezyfcl',
]
const BECH32_INVALID = [
  '\x201nwldj5',
  '\x7f1axkwrx',
  '\x801eym55h',
  'an84characterslonghumanreadablepartthatcontainsthenumber1andtheexcludedcharactersbio1569pvx',
  'pzry9x0s0muk',
  '1pzry9x0s0muk',
  'x1b4n0q5v',
  'li1dgmt3',
  'de1lg7wt\xff',
  'A1G7SGD8',
  '10a06t8',
  '1qzzfhee',
]
const BECH32M_VALID = [
  'A1LQFN3A',
  'a1lqfn3a',
  'an83characterlonghumanreadablepartthatcontainsthetheexcludedcharactersbioandnumber11sg7hg6',
  'abcdef1l7aum6echk45nj3s0wdvt2fg8x9yrzpqzd3ryx',
  '11llllllllllllllllllllllllllllllllllllllllllllllllllllllllllllllllllllllllllllllllllludsr8',
  'split1checkupstagehandshakeupstreamerranterredcaperredlc445v',
  '?1v759aa',
]
const BECH32M_INVALID = [
  '\x201xj0phk',
  '\x7f1g6xzxy',
  '\x801vctc34',
  'an84characterslonghumanreadablepartthatcontainsthetheexcludedcharactersbioandnumber11d6pts4',
  'qyrz8wqd2c9m',
  '1qyrz8wqd2c9m',
  'y1b0jsk6g',
  'lt1igcx5c0',
  'in1muywd',
  'mm1crxm3i',
  'au1s5cgom',
  'M1VUXWEZ',
  '16plkw9',
  '1p2gdwpf',
]
for (const s of BECH32_VALID) check(`bech32 valid: ${JSON.stringify(s.slice(0, 24))}`, decodes(bech32, s))
for (const s of BECH32_INVALID) check(`bech32 invalid: ${JSON.stringify(s.slice(0, 24))}`, !decodes(bech32, s))
for (const s of BECH32M_VALID) check(`bech32m valid: ${JSON.stringify(s.slice(0, 24))}`, decodes(bech32m, s))
for (const s of BECH32M_VALID) check(`bech32m valid is not bech32: ${JSON.stringify(s.slice(0, 24))}`, !decodes(bech32, s))
for (const s of BECH32M_INVALID) check(`bech32m invalid: ${JSON.stringify(s.slice(0, 24))}`, !decodes(bech32m, s))

// ---------------------------------------------------------------- addresses: accepted (mainnet)

const P2WPKH = 'bc1qw508d6qejxtdg4y5r3zarvary0c5xw7kv8f3t4'
const ACCEPT: Array<[string, string, string]> = [
  [P2WPKH, 'p2wpkh', P2WPKH],
  ['BC1QW508D6QEJXTDG4Y5R3ZARVARY0C5XW7KV8F3T4', 'p2wpkh', P2WPKH], // BIP-173 and BIP-350 valid vector, upper case
  ['bc1qrp33g0q5c5txsp9arysrx4k6zdkfs4nce4xj0gdcccefvpysxf3qccfmv3', 'p2wsh', 'bc1qrp33g0q5c5txsp9arysrx4k6zdkfs4nce4xj0gdcccefvpysxf3qccfmv3'],
  ['bc1p0xlxvlhemja6c4dqv22uapctqupfhlxm9h8z3k2e72q4k9hcz7vqzk5jj0', 'p2tr', 'bc1p0xlxvlhemja6c4dqv22uapctqupfhlxm9h8z3k2e72q4k9hcz7vqzk5jj0'], // BIP-350 valid
  ['1BvBMSEYstWetqTFn5Au4m4GFg7xJaNVN2', 'p2pkh', '1BvBMSEYstWetqTFn5Au4m4GFg7xJaNVN2'],
  ['3J98t1WpEZ73CNmQviecrnyiWrnqRhWNLy', 'p2sh', '3J98t1WpEZ73CNmQviecrnyiWrnqRhWNLy'],
  [`  ${P2WPKH}\n`, 'p2wpkh', P2WPKH],
]
for (const [input, kind, out] of ACCEPT) {
  const got = parseAddress(input)
  check(`accept ${kind} ${JSON.stringify(input.trim().slice(0, 14))}…`, got?.kind === kind && got.address === out, JSON.stringify(got))
}

// ---------------------------------------------------------------- addresses: refused

/** Well-formed segwit addresses (the BIP lists them as valid) that we still refuse: wrong network or unpayable version. */
const WELLFORMED_REFUSED: Array<[string, string, typeof bech32]> = [
  ['tb1qrp33g0q5c5txsp9arysrx4k6zdkfs4nce4xj0gdcccefvpysxf3q0sl5k7', 'BIP-173/350 valid, testnet', bech32],
  ['tb1qqqqqp399et2xygdj5xreqhjjvcmzhxw4aywxecjdzew6hylgvsesrxh6hy', 'BIP-173/350 valid, testnet', bech32],
  ['tb1pqqqqp399et2xygdj5xreqhjjvcmzhxw4aywxecjdzew6hylgvsesf3hn0c', 'BIP-350 valid, testnet p2tr', bech32m],
  ['tb1qw508d6qejxtdg4y5r3zarvary0c5xw7kxpjzsx', 'testnet p2wpkh', bech32],
  ['bc1pw508d6qejxtdg4y5r3zarvary0c5xw7kw508d6qejxtdg4y5r3zarvary0c5xw7kt5nd6y', 'BIP-350 valid, v1 with 40 bytes', bech32m],
  ['BC1SW50QGDZ25J', 'BIP-350 valid, v16', bech32m],
  ['bc1zw508d6qejxtdg4y5r3zarvaryvaxxpcs', 'BIP-350 valid, v2', bech32m],
]
for (const [s, why, coder] of WELLFORMED_REFUSED) {
  check(`refuse ${why}: decodes as ${coder === bech32 ? 'bech32' : 'bech32m'}`, decodes(coder, s.toLowerCase()))
  check(`refuse ${why}`, parseAddress(s) === null)
}

/** BIP-173 "valid" segwit vectors made invalid by BIP-350 (v1+ written in bech32). */
const BIP173_ONLY = ['bc1pw508d6qejxtdg4y5r3zarvary0c5xw7kw508d6qejxtdg4y5r3zarvary0c5xw7k7grplx', 'BC1SW50QA3JX3S', 'bc1zw508d6qejxtdg4y5r3zarvaryvg6kdaj']
for (const s of BIP173_ONLY) check(`refuse v1+ in bech32 (BIP-173 era vector) ${s.slice(0, 14)}…`, parseAddress(s) === null)

/** BIP-173 and BIP-350 invalid segwit address vectors, each with the reason the BIP gives. */
const INVALID: Array<[string, string]> = [
  ['tc1qw508d6qejxtdg4y5r3zarvary0c5xw7kg3g4ty', 'invalid hrp'],
  ['bc1qw508d6qejxtdg4y5r3zarvary0c5xw7kv8f3t5', 'invalid checksum (one character changed)'],
  ['BC13W508D6QEJXTDG4Y5R3ZARVARY0C5XW7KN40WF2', 'invalid witness version'],
  ['bc1rw5uspcuh', 'invalid program length'],
  ['bc10w508d6qejxtdg4y5r3zarvary0c5xw7kw508d6qejxtdg4y5r3zarvary0c5xw7kw5rljs90', 'invalid program length'],
  ['BC1QR508D6QEJXTDG4Y5R3ZARVARYV98GJ9P', 'v0 program length (BIP-141)'],
  ['tb1qrp33g0q5c5txsp9arysrx4k6zdkfs4nce4xj0gdcccefvpysxf3q0sL5k7', 'mixed case'],
  ['bc1zw508d6qejxtdg4y5r3zarvaryvqyzf3du', 'zero padding of more than 4 bits'],
  ['tb1qrp33g0q5c5txsp9arysrx4k6zdkfs4nce4xj0gdcccefvpysxf3pjxtptv', 'non-zero padding'],
  ['bc1gmk9yu', 'empty data section'],
  ['tc1p0xlxvlhemja6c4dqv22uapctqupfhlxm9h8z3k2e72q4k9hcz7vq5zuyut', 'invalid hrp'],
  ['bc1p0xlxvlhemja6c4dqv22uapctqupfhlxm9h8z3k2e72q4k9hcz7vqh2y7hd', 'v1 in bech32 instead of bech32m'],
  ['tb1z0xlxvlhemja6c4dqv22uapctqupfhlxm9h8z3k2e72q4k9hcz7vqglt7rf', 'v2 in bech32 instead of bech32m'],
  ['BC1S0XLXVLHEMJA6C4DQV22UAPCTQUPFHLXM9H8Z3K2E72Q4K9HCZ7VQ54WELL', 'v16 in bech32 instead of bech32m'],
  ['bc1qw508d6qejxtdg4y5r3zarvary0c5xw7kemeawh', 'v0 in bech32m instead of bech32'],
  ['tb1q0xlxvlhemja6c4dqv22uapctqupfhlxm9h8z3k2e72q4k9hcz7vq24jc47', 'v0 in bech32m instead of bech32'],
  ['bc1p38j9r5y49hruaue7wxjce0updqjuyyx0kh56v8s25huc6995vvpql3jow4', 'invalid character in checksum'],
  ['BC130XLXVLHEMJA6C4DQV22UAPCTQUPFHLXM9H8Z3K2E72Q4K9HCZ7VQ7ZWS8R', 'invalid witness version'],
  ['bc1pw5dgrnzv', 'v1 program of 1 byte'],
  ['bc1p0xlxvlhemja6c4dqv22uapctqupfhlxm9h8z3k2e72q4k9hcz7v8n0nx0muaewav253zgeav', 'v1 program of 41 bytes'],
  ['tb1p0xlxvlhemja6c4dqv22uapctqupfhlxm9h8z3k2e72q4k9hcz7vq47Zagq', 'mixed case'],
  ['bc1p0xlxvlhemja6c4dqv22uapctqupfhlxm9h8z3k2e72q4k9hcz7v07qwwzcrf', 'zero padding of more than 4 bits'],
  ['tb1p0xlxvlhemja6c4dqv22uapctqupfhlxm9h8z3k2e72q4k9hcz7vpggkg4j', 'non-zero padding'],
]
for (const [s, why] of INVALID) check(`refuse BIP vector: ${why} (${s.slice(0, 10)}…)`, parseAddress(s) === null)

// The two "non-zero padding" vectors are testnet, so their hrp alone refuses them.
// Re-encode the same words under `bc` (checksum valid) to show the padding rule
// itself refuses them on mainnet too.
for (const [tb, coder] of [
  ['tb1qrp33g0q5c5txsp9arysrx4k6zdkfs4nce4xj0gdcccefvpysxf3pjxtptv', bech32],
  ['tb1p0xlxvlhemja6c4dqv22uapctqupfhlxm9h8z3k2e72q4k9hcz7vpggkg4j', bech32m],
] as const) {
  const { words } = coder.decode(tb as `${string}1${string}`)
  const bc = coder.encode('bc', words)
  check(`mainnet copy of the padding vector decodes (${bc.slice(0, 6)})`, decodes(coder, bc))
  check(`refuse mainnet non-zero padding (${bc.slice(0, 6)})`, parseAddress(bc) === null)
}

// Our own refusals.
const b58 = createBase58check(sha256)
const twenty = new Uint8Array(20).fill(9)
const withVersion = (v: number, body = twenty) => b58.encode(Uint8Array.from([v, ...body]))
check('base58 p2pkh built here is accepted (control)', parseAddress(withVersion(0x00))?.kind === 'p2pkh')
check('base58 p2sh built here is accepted (control)', parseAddress(withVersion(0x05))?.kind === 'p2sh')
check('refuse base58 testnet p2pkh mipcBbFg…', parseAddress('mipcBbFg9gMiCh81Kj8tqqdgoZub1ZJRfn') === null)
check('refuse base58 testnet p2pkh (0x6f, built here)', parseAddress(withVersion(0x6f)) === null)
check('refuse base58 testnet p2sh (0xc4, built here)', parseAddress(withVersion(0xc4)) === null)
check('refuse base58 with 21 bytes of payload', parseAddress(withVersion(0x00, new Uint8Array(21))) === null)
check('refuse base58 checksum wrong (last character changed)', parseAddress('1BvBMSEYstWetqTFn5Au4m4GFg7xJaNVN3') === null)
check('refuse mixed-case bech32', parseAddress('bc1qw508d6qejxtdg4y5r3zarvary0c5xw7kV8F3T4') === null)
check('refuse checksum one character changed', parseAddress('bc1qw508d6qejxtdg4y5r3zarvary0c5xw7kv8f3t5') === null)
check('refuse regtest bcrt1', parseAddress(bech32.encode('bcrt', [0, ...bech32.toWords(twenty)])) === null)
check('refuse empty and spaces', parseAddress('') === null && parseAddress('   ') === null)
check('refuse over 90 characters', parseAddress(P2WPKH + 'q'.repeat(60)) === null)
check('refuse non-string', parseAddress(42 as never) === null)
check('refuse Lightning invoice text', parseAddress('lnbc1pvjluez') === null)

// ---------------------------------------------------------------- bip21

const A = P2WPKH
const BIP21: Array<[number | null, string]> = [
  [98039, `bitcoin:${A}?amount=0.00098039`],
  [100000, `bitcoin:${A}?amount=0.001`],
  [1, `bitcoin:${A}?amount=0.00000001`],
  [123456789, `bitcoin:${A}?amount=1.23456789`],
  [100000000, `bitcoin:${A}?amount=1`],
  [2_100_000_000_000_000, `bitcoin:${A}?amount=21000000`],
  [null, `bitcoin:${A}`],
]
for (const [sats, want] of BIP21) {
  const got = bip21(A, sats)
  check(`bip21(${sats})`, got === want, got)
}
for (const bad of [0, -1, 1.5, Number.NaN, 2_100_000_000_000_001]) {
  let threw = false
  try {
    bip21(A, bad)
  } catch (e) {
    threw = e instanceof RangeError
  }
  check(`bip21(${bad}) throws RangeError`, threw)
}

// ---------------------------------------------------------------- parseOnchainRequest

const r1 = parseOnchainRequest(`bitcoin:${A}?amount=0.001&label=x`)
check('link with amount and label -> 100000 sats', r1?.sats === 100000 && r1.address === A, JSON.stringify(r1))
check('rebuilt uri equals bip21(address, sats)', r1?.uri === bip21(A, 100000), r1?.uri)
const r2 = parseOnchainRequest(`BITCOIN:${A.toUpperCase()}`)
check('BITCOIN: upper-case link passes, no amount, address lowercased', r2?.address === A && r2.sats === null && r2.uri === `bitcoin:${A}`, JSON.stringify(r2))
const r3 = parseOnchainRequest(`BITCOIN:${A.toUpperCase()}?AMOUNT=0.5`)
check('upper-case AMOUNT key is read', r3?.sats === 50_000_000, JSON.stringify(r3))
const r4 = parseOnchainRequest(A)
check('bare address -> sats null, uri bitcoin:address', r4?.sats === null && r4.uri === `bitcoin:${A}`)
const r5 = parseOnchainRequest(`bitcoin:${A}?amount=1.23456789&message=hi%20there&lightning=lnbc1xyz`)
check('amount 1.23456789 -> 123456789 sats exactly; message and lightning ignored', r5?.sats === 123_456_789 && r5.uri === `bitcoin:${A}?amount=1.23456789`, JSON.stringify(r5))
check('amount=21000000 (the cap) passes', parseOnchainRequest(`bitcoin:${A}?amount=21000000`)?.sats === 2_100_000_000_000_000)
const NULLS: Array<[string, string]> = [
  [`bitcoin:${A}?amount=0.000000001`, '9 decimal places'],
  [`bitcoin:${A}?amount=-1`, 'negative'],
  [`bitcoin:${A}?amount=1e-3`, 'exponent'],
  [`bitcoin:${A}?amount=21000001`, 'over 21M BTC'],
  [`bitcoin:${A}?amount=0`, 'zero'],
  [`bitcoin:${A}?amount=`, 'empty amount'],
  [`bitcoin:${A}?amount=1,5`, 'comma'],
  [`bitcoin:${A}?amount=0.1&amount=0.2`, 'amount given twice'],
  [`bitcoin:${A}?req-foo=1`, 'req- parameter'],
  [`bitcoin:${A}?amount=0.1&REQ-foo=1`, 'req- parameter (upper case)'],
  ['bitcoin:tb1qw508d6qejxtdg4y5r3zarvary0c5xw7kxpjzsx?amount=0.1', 'testnet address'],
  ['bitcoin:', 'no address'],
  ['bitcoin:?amount=1', 'no address, amount'],
  ['hello', 'plain word'],
]
for (const [s, why] of NULLS) check(`parseOnchainRequest null: ${why}`, parseOnchainRequest(s) === null)

// What a paste or a chat can carry around an address: invisible
// characters and look-alike letters are not an address; neither is a link or an invoice
// where an address is asked for (parseAddress, the engine's check 11).
const LOOKALIKES: [string, string][] = [
  [`${P2WPKH.slice(0, 20)}\u200b${P2WPKH.slice(20)}`, 'zero-width space inside'],
  [`\ufeff${P2WPKH}`.slice(0, 1) + P2WPKH.slice(0, 20) + '\u2060' + P2WPKH.slice(20), 'word joiner inside'],
  [`${P2WPKH.slice(0, -1)}\u0430`, 'Cyrillic a at the end'],
  [`\u0412C1${P2WPKH.slice(3).toUpperCase()}`, 'Cyrillic B at the start'],
  [P2WPKH.replace('bc1', 'ｂｃ１'), 'full-width bc1'],
  [`bitcoin:${P2WPKH}`, 'a bitcoin: link'],
  [`lightning:${P2WPKH}`, 'a lightning: prefix'],
  [P2WPKH.slice(0, 10) + P2WPKH.slice(10).toUpperCase(), 'mixed case'],
]
for (const [s, why] of LOOKALIKES) check(`parseAddress null: ${why}`, parseAddress(s) === null)
check('parseAddress keeps a trailing line break and spaces out', parseAddress(`${P2WPKH} \r\n`)?.address === P2WPKH)

// ---------------------------------------------------------------- why an address was refused (addressProblem)
// The receiving sheet shows one line per cause. The network is judged only after the
// checksum passes, never from the prefix alone; null exactly when parseAddress accepts.

const INVOICE = 'lnbc2500u1pvjluezpp5qqqsyqcyq5rqwzqfqqqsyqcyq5rqwzqfqqqsyqcyq5rqwzqfqypqdpquwpc4curk03c9wlrswe78q4eyqc7d8d0x'
const TB = 'tb1qw508d6qejxtdg4y5r3zarvary0c5xw7kxpjzsx'
const PROBLEMS: Array<[string, AddressProblem | null, string]> = [
  [P2WPKH, null, 'mainnet p2wpkh'],
  ['1BvBMSEYstWetqTFn5Au4m4GFg7xJaNVN2', null, 'mainnet p2pkh'],
  [`  ${P2WPKH}\n`, null, 'padded mainnet'],
  [INVOICE, 'lightning', 'invoice'],
  [INVOICE.toUpperCase(), 'lightning', 'invoice upper case'],
  [`lightning:${INVOICE}`, 'lightning', 'lightning: link'],
  ['lntb2500u1pvjluezpp5qqqsyqcyq5rqwzqfqqqsyqcyq5rqwzqfqqqsyqcyq5rqwzqfq', 'lightning', 'testnet invoice is still an invoice'],
  ['lnurl1dp68gurn8ghj7um9wfmxjcm99e3k7mf0v9cxj0m385ekvcenxc6r2c35xvukxefcv5mkvv34x5ekzd3ev56nyd3hxqurzepexejxxepnxscrvwfnv9nxzcn9xq6xyefhvgcxxcmyxymnserxfq5fns', 'lightning', 'LNURL'],
  [TB, 'testnet', 'testnet p2wpkh'],
  ['tb1qrp33g0q5c5txsp9arysrx4k6zdkfs4nce4xj0gdcccefvpysxf3q0sl5k7', 'testnet', 'testnet p2wsh'],
  ['tb1pqqqqp399et2xygdj5xreqhjjvcmzhxw4aywxecjdzew6hylgvsesf3hn0c', 'testnet', 'testnet p2tr'],
  ['TB1QW508D6QEJXTDG4Y5R3ZARVARY0C5XW7KXPJZSX', 'testnet', 'testnet upper case'],
  ['mipcBbFg9gMiCh81Kj8tqqdgoZub1ZJRfn', 'testnet', 'testnet p2pkh'],
  ['2MzQwSSnBHWHqSAqtTVQ6v47XtaisrJa1Vc', 'testnet', 'testnet p2sh'],
  [`bitcoin:${TB}?amount=0.1`, 'testnet', 'bitcoin: link to a testnet address'],
  ['bc1qw508d6qejxtdg4y5r3zarvary0c5xw7kv8f3t5', 'typo', 'mainnet bech32, one character changed'],
  [`${TB.slice(0, -1)}y`, 'typo', 'testnet prefix with a broken checksum is a typo, not testnet'],
  ['tb1qw508d6qejxtdg4y5r3zarvary0c5xw7kxpjzsX', 'typo', 'testnet prefix, mixed case'],
  ['bc1qw508d6qejxtdg4y5r3zarvary0c5xw7kv8f3T4', 'typo', 'mainnet, mixed case'],
  ['1BvBMSEYstWetqTFn5Au4m4GFg7xJaNVN3', 'typo', 'base58 checksum fails'],
  ['1BvBMSEYstWetqTFn5Au4m4GFg7xJaNVN0', 'typo', 'base58 with a 0'],
  ['3J98t1WpEZ73CNmQviecrnyiWrnqRhWNLz', 'typo', 'p2sh, last letter changed'],
  ['mipcBbFg9gMiCh81Kj8tqqdgoZub1ZJRfm', 'typo', 'testnet-looking base58, checksum fails'],
  ['bc1zw508d6qejxtdg4y5r3zarvaryvaxxpcs', 'unsupported', 'segwit v2'],
  ['BC1SW50QGDZ25J', 'unsupported', 'segwit v16'],
  ['bc1pw508d6qejxtdg4y5r3zarvary0c5xw7kw508d6qejxtdg4y5r3zarvary0c5xw7kt5nd6y', 'unsupported', 'v1 with 40 bytes'],
  ['BC1QR508D6QEJXTDG4Y5R3ZARVARYV98GJ9P', 'unsupported', 'v0 with a wrong length'],
  [`bitcoin:${P2WPKH}?req-foo=1`, 'unsupported', 'link with a req- parameter'],
  [`bitcoin:${P2WPKH}?amount=0`, 'unsupported', 'link with a bad amount'],
  [`bitcoin:${P2WPKH.slice(0, -1)}q?amount=0.1`, 'typo', 'link whose address has a typo'],
  ['tc1qw508d6qejxtdg4y5r3zarvary0c5xw7kg3g4ty', 'invalid', 'invalid hrp'],
  ['', 'invalid', 'empty'],
  ['   ', 'invalid', 'blank'],
  ['hello', 'invalid', 'plain word'],
  ['bc1', 'invalid', 'prefix only'],
  ['bitcoin:', 'invalid', 'no address'],
  ['a'.repeat(200), 'invalid', 'too long'],
]
for (const [s, want, why] of PROBLEMS) {
  const got = addressProblem(s)
  check(`addressProblem ${want ?? 'null'}: ${why}`, got === want, `got ${got}`)
  check(`addressProblem agrees with parseAddress: ${why}`, (got === null) === (parseAddress(s) !== null), `got ${got}`)
}
// Not a valid-looking address at all, but with a good checksum from another coin or a key: never "typo".
const base58 = createBase58check(sha256)
const foreign = base58.encode(new Uint8Array([0x30, ...new Array(20).fill(7)]))
check('addressProblem unsupported: other base58 version with a good checksum', addressProblem(foreign) === 'unsupported', String(addressProblem(foreign)))

// A key that is not an address (WIF-sized and xpub-sized base58check payloads) is invalid, not "unsupported".
check('addressProblem invalid: 33-byte base58check payload (private key)', addressProblem(base58.encode(new Uint8Array([0x80, ...new Array(32).fill(9)]))) === 'invalid')
check('addressProblem invalid: 78-byte base58check payload (extended key)', addressProblem(base58.encode(new Uint8Array(78).fill(4))) === 'invalid')
check(
  'addressProblem lightning: BOLT12 offer',
  addressProblem('lno1pqps7sjqpgtyzm3qv4uxzmtsd3jjqer9wd3hy6tsw35k7msjzfpy7nz5yqcnygrfdej82um5wf5k2uckyypwa3eyt44h6txtxquqh7lz5djge4afgfjn7k4rgrkuag0jsd5xvxg') === 'lightning',
)
// The sheet shows its cause through ADDRESS_PROBLEM_KEY: every cause has a key that exists in ko and en.
const room = listDictionaries().get('room')
for (const cause of ['lightning', 'testnet', 'typo', 'unsupported', 'invalid'] as const) {
  const key = ADDRESS_PROBLEM_KEY[cause]
  check(`sheet line for ${cause} exists in ko and en`, !!(room?.ko as Record<string, string>)?.[key] && !!(room?.en as Record<string, string>)?.[key], key)
}

console.log(failed ? `\n${failed} failed` : '\nall passed')
process.exitCode = failed ? 1 : 0
