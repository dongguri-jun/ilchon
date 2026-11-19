/**
 * The 12 words of an ilchon identity:
 * BIP-39 English list, 128 bits, no passphrase; the key is the NIP-06 path
 * m/44'/1237'/4242'/0/0. Key derivation is the installed, audited libraries
 * (@scure/bip39, applesauce-signers' SeedWordsSigner over @scure/bip32), never our own.
 *
 * Pure functions, the same in the browser, Node and the checks. Imported by the engine
 * directly (not through EngineDeps). Never put the input, a word or a key in an error
 * message or a log line.
 */
import { generateMnemonic, validateMnemonic } from '@scure/bip39'
import { wordlist } from '@scure/bip39/wordlists/english.js'
import { bytesToHex } from '@noble/hashes/utils.js'
import { SeedWordsSigner } from 'applesauce-signers/signers/seed-words-signer'

/** NIP-06 account of ilchon keys. Never 0, so no general-purpose Nostr seed maps to its usual npub. */
export const ILCHON_NIP06_ACCOUNT = 4242

const WORD_SET: ReadonlySet<string> = new Set(wordlist)

/** NFKD, lowercase, list numbers dropped, one space apart. Does not validate. */
export function normalizeWords(text: string): string {
  return String(text ?? '')
    .normalize('NFKD')
    .toLowerCase()
    .split(/\s+/)
    .map((piece) => piece.replace(/^\d+[.)]/, ''))
    .filter((piece) => piece !== '' && !/^\d+$/.test(piece))
    .join(' ')
}

/** For the restore screen: word count and 1-based positions of words not in the list. */
export function wordProblems(text: string): { count: number; unknown: number[] } {
  const words = normalizeWords(text).split(' ').filter(Boolean)
  const unknown: number[] = []
  words.forEach((w, i) => {
    if (!WORD_SET.has(w)) unknown.push(i + 1)
  })
  return { count: words.length, unknown }
}

/** 12 fresh words, lowercase, one space apart. */
export function newMnemonic(): string {
  return generateMnemonic(wordlist, 128)
}

/** NIP-06 key of `account`, 64-hex. Exported for the test vector. Throws 'invalid-mnemonic'. */
export function deriveNip06(words: string, account: number): string {
  if (typeof words !== 'string' || words.split(' ').length !== 12 || !validateMnemonic(words, wordlist)) {
    throw new Error('invalid-mnemonic')
  }
  let signer: SeedWordsSigner
  try {
    signer = SeedWordsSigner.fromWords(words, { wordlist, account })
  } catch {
    // The library's own message is not passed on.
    throw new Error('invalid-mnemonic')
  }
  const hex = bytesToHex(signer.key)
  signer.key.fill(0)
  return hex
}

/** My secret key from 12 words: deriveNip06(normalizeWords(words), ILCHON_NIP06_ACCOUNT). */
export function secretFromMnemonic(words: string): string {
  return deriveNip06(normalizeWords(words), ILCHON_NIP06_ACCOUNT)
}
