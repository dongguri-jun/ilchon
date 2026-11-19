/**
 * Vectors for src/lib/pay: which chat tokens are payment requests, and what each one is.
 * Cases come first from scripts/check-bolt11.ts and scripts/check-trade.ts (C-1, C-2), then boundaries.
 */
import { hasPayRef, isPayCandidate, PAY_TOKEN_MAX, payRefOf, splitText } from '../../src/lib/pay'
import { build, COFFEE, DONATION, pad, TESTNET } from './bolt11'
import { type CaseSpec, defineFunction, EDGE_CHARS, type VectorFile } from './kit'

const ADDR = 'bc1qw508d6qejxtdg4y5r3zarvary0c5xw7kv8f3t4'
const P2PKH = '1BvBMSEYstWetqTFn5Au4m4GFg7xJaNVN2'
const P2SH = '3J98t1WpEZ73CNmQviecrnyiWrnqRhWNLy'
const P2TR = 'bc1p0xlxvlhemja6c4dqv22uapctqupfhlxm9h8z3k2e72q4k9hcz7vqzk5jj0'
const TB = 'tb1qw508d6qejxtdg4y5r3zarvary0c5xw7kxpjzsx'
const INV = build('lnbc1m')
const INV_LEN = INV.length

/** An invoice of exactly `chars` characters. */
const invoiceOfLength = (chars: number) => build('lnbc1m', pad(chars - INV_LEN))
/** A bitcoin: link carrying a valid invoice, `chars` characters in all. */
const unifiedOfLength = (chars: number) => `bitcoin:${ADDR}?lightning=${invoiceOfLength(chars - `bitcoin:${ADDR}?lightning=`.length)}`
const AT_MAX = invoiceOfLength(PAY_TOKEN_MAX)
const OVER_MAX = invoiceOfLength(PAY_TOKEN_MAX + 1)

const TOKENS: Array<[string, string]> = [
  ['bare invoice', INV],
  ['invoice with lightning: prefix', `lightning:${INV}`],
  ['invoice with LIGHTNING: prefix, upper case', `LIGHTNING:${INV.toUpperCase()}`],
  ['invoice upper case', INV.toUpperCase()],
  ['invoice mixed case', INV.slice(0, 30).toUpperCase() + INV.slice(30)],
  ['testnet invoice', build('lntb1m')],
  ['regtest invoice', build('lnbcrt1m')],
  ['signet invoice', build('lntbs1m')],
  ['no-amount invoice', build('lnbc')],
  ['spec coffee invoice', COFFEE],
  ['spec donation invoice', DONATION],
  ['spec testnet invoice', TESTNET],
  ['invoice with a trailing character', `${INV}q`],
  ['invoice cut short', INV.slice(0, 99)],
  ['invoice of exactly 4096 characters', AT_MAX],
  ['invoice of 4097 characters', OVER_MAX],
  ['lightning: prefix pushing it past 4096', `lightning:${invoiceOfLength(PAY_TOKEN_MAX - 5)}`],
  ['lightning: prefix with exactly 4096', `lightning:${invoiceOfLength(PAY_TOKEN_MAX - 10)}`],
  ['plain word ln', 'lnbc'],
  ['plain word hello', 'hello'],
  ['ln token of 100 characters that is not an invoice', `ln${'q'.repeat(98)}`],
  ['ln token of 99 characters', `ln${'q'.repeat(97)}`],
  ['lightning: with nothing', 'lightning:'],
  ['lightning: with a short word', 'lightning:abc'],
  ['bitcoin: link with amount', `bitcoin:${ADDR}?amount=0.001`],
  ['BITCOIN: upper case link and address', `BITCOIN:${ADDR.toUpperCase()}?amount=0.001&label=x`],
  ['bare bech32 address', ADDR],
  ['bare upper case address', ADDR.toUpperCase()],
  ['base58 p2pkh', P2PKH],
  ['base58 p2sh', P2SH],
  ['taproot address', P2TR],
  ['unified link with a lightning invoice', `bitcoin:${ADDR}?amount=0.001&lightning=${INV}`],
  ['unified link with an upper case invoice', `bitcoin:${ADDR}?lightning=${INV.toUpperCase()}`],
  ['unified link with a percent-encoded invoice', `bitcoin:${ADDR}?lightning=${encodeURIComponent(INV)}`],
  ['unified link with a testnet invoice', `bitcoin:${ADDR}?lightning=${build('lntb1m')}`],
  ['unified link with a broken invoice falls back to the address', `bitcoin:${ADDR}?amount=0.001&lightning=lnbc1xyz`],
  ['unified link, first lightning= broken, second good: the first decides', `bitcoin:${ADDR}?lightning=lnbc1xyz&lightning=${INV}`],
  ['unified link, first lightning= good, second broken', `bitcoin:${ADDR}?lightning=${INV}&lightning=lnbc1xyz`],
  ['unified link with a req- parameter and an invoice', `bitcoin:${ADDR}?req-foo=1&lightning=${INV}`],
  ['unified link with an invoice and a bad amount', `bitcoin:${ADDR}?amount=0&lightning=${INV}`],
  ['unified link with a bad address and an invoice', `bitcoin:${TB}?lightning=${INV}`],
  ['bitcoin: link without an address and an invoice', `bitcoin:?lightning=${INV}`],
  ['unified link whose invoice is over 4096 characters', `bitcoin:${ADDR}?lightning=${OVER_MAX}`],
  ['unified link of exactly 4096 characters carrying an invoice', unifiedOfLength(PAY_TOKEN_MAX)],
  ['unified link of 4097 characters carrying an invoice', unifiedOfLength(PAY_TOKEN_MAX + 1)],
  ['whole unified link over 4096 characters', `bitcoin:${ADDR}?amount=0.001&x=${'q'.repeat(4100)}`],
  ['bitcoin: link with an invoice as the address', `bitcoin:${INV}`],
  ['testnet link', `bitcoin:${TB}`],
  ['testnet address', TB],
  ['regtest address', 'bcrt1qw508d6qejxtdg4y5r3zarvary0c5xw7kygt080'],
  ['base58 testnet', 'mipcBbFg9gMiCh81Kj8tqqdgoZub1ZJRfn'],
  ['req- parameter', `bitcoin:${ADDR}?req-foo=1`],
  ['nine decimals', `bitcoin:${ADDR}?amount=0.000000001`],
  ['negative amount', `bitcoin:${ADDR}?amount=-1`],
  ['exponent amount', `bitcoin:${ADDR}?amount=1e-3`],
  ['amount twice', `bitcoin:${ADDR}?amount=0.001&amount=0.002`],
  ['mixed case address', 'bc1qw508d6qejxtdg4y5r3zarvary0c5xw7KV8F3T4'],
  ['zero-width space', 'bc1qw508d6qejxtdg4y5r3zarvary0c5xw7kv8f3\u200bt4'],
  ['Cyrillic a', 'bc1qw508d6qejxtdg4y5r3zarvary0c5xw7kv8f3t\u0430'],
  ['Kelvin sign in an upper case address', 'BC1QW508D6QEJXTDG4Y5R3ZARVARY0C5XW7KV8F3T4'.replace('K', '\u212a')],
  ['digits that look like base58', '1234567890123456789012345678'],
  ['a 26-character token starting with 1', '1BvBMSEYstWetqTFn5Au4m4GFg'],
  ['a 25-character token starting with 1', '1BvBMSEYstWetqTFn5Au4m4GF'],
  ['a 90-character token starting with bc1', `bc1${'q'.repeat(87)}`],
  ['a 91-character token starting with bc1', `bc1${'q'.repeat(88)}`],
  ['bc1 alone', 'bc1'],
  ['3 alone', '3'],
  ['BC1 upper case prefix, 26 characters', `BC1${'Q'.repeat(23)}`],
  ['a 26-character token starting with 2', `2${'a'.repeat(25)}`],
  ['a token starting with 1 but 91 characters', `1${'a'.repeat(90)}`],
  ['a token starting with 3, 90 characters', `3${'a'.repeat(89)}`],
  ['dotless i in the scheme', `l\u0131ghtning:${INV}`],
  ['dotless i in bitcoin:', `b\u0131tcoin:${ADDR}`],
  ['fullwidth ln', `ＬＮ${INV.slice(2)}`],
  ['an emoji pair counts as four code units', `${'🙂'.repeat(13)}`],
  ['26 code units made of astral characters starting with 1', `1${'🙂'.repeat(12)}a`],
  ['empty', ''],
  ['space', ' '],
  ['a token with an internal space', `${INV.slice(0, 50)} ${INV.slice(50)}`],
  ['a token with a leading space', ` ${INV}`],
  ['a token with a trailing newline', `${ADDR}\n`],
]

/** The address with each edge character after it: what the on-chain reader trims. */
const TRAILING: Array<[string, string]> = EDGE_CHARS.map(([label, ch]) => [`address then ${label}`, `${ADDR}${ch}`])

const TEXTS: Array<[string, string]> = [
  ['empty', ''],
  ['plain words', 'hello there'],
  ['address between words and a line break', `send to ${ADDR}\nthanks`],
  ['two invoices with double space', `pay ${INV}  and ${INV}`],
  ['a link with a unified invoice', `look: bitcoin:${ADDR}?lightning=${INV} ok`],
  ['only whitespace', ' \n\t '],
  ['leading and trailing whitespace', `  ${ADDR}  `],
  ['an address with punctuation after it', `${ADDR}.`],
  ['an address in parentheses', `(${ADDR})`],
  ['a token over 4096 characters between words', `a ${OVER_MAX} b`],
  ['no-break space separates tokens', `${ADDR}\u00a0${P2PKH}`],
  ['an invoice and an address', `${INV} ${ADDR}`],
  ['testnet and mainnet addresses', `${TB} ${ADDR}`],
  ['non-ASCII words', '결제 부탁 해요 🙂'],
  ['CRLF between tokens', `${ADDR}\r\n${P2SH}`],
  ['a link with a req- parameter then an address', `bitcoin:${ADDR}?req-x=1 ${ADDR}`],
]

export function payVectors(): VectorFile {
  return {
    module: 'pay',
    constants: { PAY_TOKEN_MAX },
    functions: {
      isPayCandidate: defineFunction(
        ['token'],
        isPayCandidate,
        [...TOKENS, ...TRAILING].map(([n, s]): CaseSpec => [n, [s]]),
      ),
      payRefOf: defineFunction(
        ['token'],
        payRefOf,
        [...TOKENS, ...TRAILING].map(([n, s]): CaseSpec => [n, [s]]),
      ),
      splitText: defineFunction(
        ['text'],
        splitText,
        TEXTS.map(([n, s]): CaseSpec => [n, [s]]),
      ),
      hasPayRef: defineFunction(
        ['text'],
        hasPayRef,
        TEXTS.map(([n, s]): CaseSpec => [n, [s]]),
      ),
    },
  }
}
