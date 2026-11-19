/**
 * The 12 words on their own (S-1 to S-8).
 * No network. Run: pnpm check:seed
 *
 * The NIP-06 vectors are the official ones of
 * https://github.com/nostr-protocol/nips/blob/master/06.md (read again on 2026-11-13):
 * a derivation that is not BIP-39 + BIP-32 on m/44'/1237'/<account>'/0/0 fails here.
 */
import { SeedWordsSigner } from 'applesauce-signers/signers/seed-words-signer'
import { bytesToHex } from '@noble/hashes/utils.js'
import { validateMnemonic } from '@scure/bip39'
import { wordlist } from '@scure/bip39/wordlists/english.js'
import { npubOf, pubkeyOf } from '../src/lib/marmot/keys'
import { typedUnknown } from '../src/screens/lock/util'
import { deriveNip06, ILCHON_NIP06_ACCOUNT, newMnemonic, normalizeWords, secretFromMnemonic, wordProblems } from '../src/lib/seed/index'

let failed = 0
function check(name: string, ok: boolean, detail = ''): void {
  if (ok) console.log(`PASS  ${name}`)
  else {
    failed++
    console.log(`FAIL  ${name}${detail ? `\n  ${detail}` : ''}`)
  }
}
function throwsInvalid(name: string, fn: () => unknown, words: string[]): void {
  try {
    fn()
    check(name, false, 'did not throw')
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e)
    // The exact code says it already; the token search is for a future message that adds text.
    const tokens = msg.toLowerCase().split(/[^a-z]+/)
    const leaked = words.filter((w) => tokens.includes(w))
    check(name, msg === 'invalid-mnemonic' && leaked.length === 0, `message ${JSON.stringify(msg)}`)
  }
}

// NIP-06 06.md, "Test vectors".
const VEC1 = {
  words: 'leader monkey parrot ring guide accident before fence cannon height naive bean',
  sk: '7f7ff03d123792d6ac594bfa67bf6d0c0ab55b6b1fdb6249303fe861f1ccba9a',
  pk: '17162c921dc4d2518f9a101db33695df1afb56ab82f5ff3e5da6eec3ca5cd917',
  npub: 'npub1zutzeysacnf9rru6zqwmxd54mud0k44tst6l70ja5mhv8jjumytsd2x7nu',
}
const VEC2 = {
  words: 'what bleak badge arrange retreat wolf trade produce cricket blur garlic valid proud rude strong choose busy staff weather area salt hollow arm fade',
  sk: 'c15d739894c81a2fcfd3a2df85a0d2c0dbc47a280d092799f144d73d7ae78add',
  pk: 'd41b22899549e1f3d335a31002cfd382174006e166d3e658e3a5eecdb6463573',
  npub: 'npub16sdj9zv4f8sl85e45vgq9n7nsgt5qphpvmf7vk8r5hhvmdjxx4es8rq74h',
}
// The ilchon key of VEC1 (account 4242), computed with the same libraries.
const ILCHON = {
  sk: '3d1062416e2e14dc6e29d9deabd63c89d41fa4b663bd65597070995499f1503a',
  pk: 'd13ce3936b2f4925c59422feaff22eda09467fe1fe706699bb443f2c893a22fb',
}

// S-1 the NIP-06 vector through deriveNip06, account 0.
{
  const sk = deriveNip06(VEC1.words, 0)
  check('S-1 NIP-06 vector 1: secret key', sk === VEC1.sk, sk)
  check('S-1 NIP-06 vector 1: public key', pubkeyOf(sk) === VEC1.pk)
  check('S-1 NIP-06 vector 1: npub', npubOf(pubkeyOf(sk)) === VEC1.npub)
  // The second official vector has 24 words. deriveNip06 takes 12 only, so the
  // same library call it makes is checked on it directly, and deriveNip06 refuses it.
  const signer = SeedWordsSigner.fromWords(VEC2.words, { wordlist, account: 0 })
  const sk2 = bytesToHex(signer.key)
  check('S-1 NIP-06 vector 2 (24 words): secret key through the same library call', sk2 === VEC2.sk, sk2)
  check('S-1 NIP-06 vector 2: public key and npub', pubkeyOf(sk2) === VEC2.pk && npubOf(VEC2.pk) === VEC2.npub)
  throwsInvalid('S-1 deriveNip06 refuses 24 words', () => deriveNip06(VEC2.words, 0), VEC2.words.split(' '))
}

// S-2 the ilchon key: account 4242.
{
  check('S-2 the ilchon account is 4242', ILCHON_NIP06_ACCOUNT === 4242)
  const sk = secretFromMnemonic(VEC1.words)
  check('S-2 secretFromMnemonic: account 4242 secret key', sk === ILCHON.sk, sk)
  check('S-2 secretFromMnemonic: public key', pubkeyOf(sk) === ILCHON.pk)
  check('S-2 not the usual Nostr key of the same words', sk !== VEC1.sk && pubkeyOf(sk) !== VEC1.pk)
  check('S-2 deriveNip06(words, 4242) is the same', deriveNip06(VEC1.words, 4242) === ILCHON.sk)
}

// S-3 case, line breaks, the ideographic space, spaces around.
{
  const messy = '  LEADER monkey\nparrot　ring guide accident before fence cannon height naive BEAN '
  check('S-3 normalizeWords', normalizeWords(messy) === VEC1.words, normalizeWords(messy))
  check('S-3 messy input -> the same key', secretFromMnemonic(messy) === ILCHON.sk)
  const tabs = 'leader\tmonkey\r\nparrot ring  guide accident before fence cannon height naive bean'
  check('S-3 tabs and CRLF -> the same key', secretFromMnemonic(tabs) === ILCHON.sk)
}

// S-4 a numbered paste.
{
  const numbered = VEC1.words
    .split(' ')
    .map((w, i) => `${i + 1}. ${w}`)
    .join(' ')
  check('S-4 "1. leader 2. monkey …" -> the same key', secretFromMnemonic(numbered) === ILCHON.sk, normalizeWords(numbered))
  const glued = VEC1.words
    .split(' ')
    .map((w, i) => `${i + 1}.${w}`)
    .join('\n')
  check('S-4 "1.leader" on lines -> the same key', secretFromMnemonic(glued) === ILCHON.sk, normalizeWords(glued))
  const paren = VEC1.words
    .split(' ')
    .map((w, i) => `${i + 1}) ${w}`)
    .join(' ')
  check('S-4 "1) leader" -> the same key', secretFromMnemonic(paren) === ILCHON.sk)
}

// S-5 rejections, with no word in the message.
{
  const w = VEC1.words.split(' ')
  throwsInvalid('S-5 11 words', () => secretFromMnemonic(w.slice(0, 11).join(' ')), w)
  throwsInvalid('S-5 13 words', () => secretFromMnemonic([...w, 'bean'].join(' ')), w)
  throwsInvalid('S-5 checksum: last word naive', () => secretFromMnemonic([...w.slice(0, 11), 'naive'].join(' ')), w)
  throwsInvalid('S-5 two words swapped (checksum)', () => secretFromMnemonic([w[1], w[0], ...w.slice(2)].join(' ')), w)
  throwsInvalid('S-5 not in the list: leeder', () => secretFromMnemonic(['leeder', ...w.slice(1)].join(' ')), [...w, 'leeder'])
  throwsInvalid('S-5 empty', () => secretFromMnemonic(''), w)
  throwsInvalid('S-5 deriveNip06 does not normalize', () => deriveNip06(VEC1.words.toUpperCase(), 0), w)
}

// S-6 wordProblems.
{
  const w = VEC1.words.split(' ')
  const p11 = wordProblems(w.slice(0, 11).join(' '))
  check('S-6 11 words -> count 11', p11.count === 11 && p11.unknown.length === 0, JSON.stringify(p11))
  const pBad = wordProblems(['leeder', ...w.slice(1)].join(' '))
  check('S-6 leeder first -> unknown [1]', pBad.count === 12 && JSON.stringify(pBad.unknown) === '[1]', JSON.stringify(pBad))
  const pTwo = wordProblems(`1. ${w.slice(0, 4).join(' ')} xyz ${w.slice(4, 10).join(' ')} 2abc`)
  check('S-6 numbers dropped, positions counted after them', JSON.stringify(pTwo.unknown) === '[5,12]' && pTwo.count === 12, JSON.stringify(pTwo))
  check('S-6 empty -> count 0', wordProblems('  ').count === 0)
}

// S-7 fresh words.
{
  const seen = new Set<string>()
  let bad = 0
  for (let i = 0; i < 100; i++) {
    const m = newMnemonic()
    if (m.split(' ').length !== 12 || !validateMnemonic(m, wordlist) || normalizeWords(m) !== m) bad++
    seen.add(m)
  }
  check('S-7 newMnemonic x100: 12 valid, normalized words each time', bad === 0, `${bad} bad`)
  check('S-7 newMnemonic x100: all different', seen.size === 100)
}

// S-8 the restore field checks each word as it is typed.
// biome-ignore lint/complexity/noUselessLoneBlockStatements: the block groups one section of checks and keeps its names local
{
  check('S-8 a word still being typed is not flagged', typedUnknown('abandon abil').length === 0)
  check('S-8 a finished unknown word is flagged at once', typedUnknown('abandon abil ').join() === '2')
  check('S-8 the word being typed is flagged once the next one starts', typedUnknown('abandon abil zoo').join() === '2')
  check('S-8 each unknown finished word, by position', typedUnknown('qqq abandon xyz zoo ').join() === '1,3')
  check('S-8 known words: nothing', typedUnknown(`${VEC1.words} `).length === 0)
}

console.log(failed ? `\n${failed} FAILED` : '\nALL PASS')
process.exit(failed ? 1 : 0)
