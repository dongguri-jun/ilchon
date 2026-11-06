/**
 * Node check for src/lib/vault (NIP-49 + password/none lock paths).
 * Run: pnpm exec tsx scripts/check-vault.ts
 * Prints only pass/fail, never key material.
 */
import { bytesToHex, randomBytes } from '@noble/hashes/utils.js'
import { fromNcryptsec, lockSecret, toNcryptsec, unlockSecret } from '../src/lib/vault/index.ts'

// NIP-49 test vector (https://github.com/nostr-protocol/nips/blob/master/49.md)
const VEC_NCRYPTSEC =
  'ncryptsec1qgg9947rlpvqu76pj5ecreduf9jxhselq2nae2kghhvd5g7dgjtcxfqtd67p9m0w57lspw8gsq6yphnm8623nsl8xn9j4jdzz84zm3frztj3z7s35vpzmqf6ksu8r89qk5z2zxfmu5gv8th8wclt0h4p'
const VEC_PASSWORD = 'nostr'
const VEC_KEY = '3501454135014541350145413501453fefb02227e449e57cf4d3a3ce05378683'

let failed = 0
async function check(name: string, fn: () => Promise<boolean>) {
  const t = Date.now()
  let ok = false
  let note = ''
  try {
    ok = await fn()
  } catch (e) {
    note = ` (threw ${(e as Error).message})`
  }
  if (!ok) failed++
  console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${note} [${Date.now() - t}ms]`)
}
async function rejects(fn: () => Promise<unknown>, code: string): Promise<boolean> {
  try {
    await fn()
    return false
  } catch (e) {
    return (e as Error).message === code
  }
}

const sk = bytesToHex(randomBytes(32))
const pw = 'correct horse battery'

await check('NIP-49 test vector decrypts to expected key', async () =>
  (await fromNcryptsec(VEC_NCRYPTSEC, VEC_PASSWORD)) === VEC_KEY,
)
await check('NIP-49 round trip (fresh key, logN 16)', async () => {
  const enc = await toNcryptsec(sk, pw)
  return enc.startsWith('ncryptsec1') && (await fromNcryptsec(enc, pw)) === sk
})
await check('NFKC: decomposed/compatibility password forms match', async () => {
  const enc = await toNcryptsec(sk, 'ÅΩẛ̣', 12)
  return (await fromNcryptsec(enc, 'ÅΩṩ')) === sk
})
await check('wrong password -> wrong-password', () => rejects(() => fromNcryptsec(VEC_NCRYPTSEC, 'nostR'), 'wrong-password'))
await check('garbage -> invalid-ncryptsec', () => rejects(() => fromNcryptsec('hello world', pw), 'invalid-ncryptsec'))
await check('npub-style bech32 -> invalid-ncryptsec', () =>
  rejects(() => fromNcryptsec('npub1sn0wdenkukak0d9dfczzeacvhkrgz92ak56egt7vdgzn8pv2wfqqhrjdv9', pw), 'invalid-ncryptsec'),
)
await check('lock/unlock "password" round trip', async () => {
  const v = await lockSecret(sk, { method: 'password', password: pw }, 'test')
  return v.method === 'password' && (await unlockSecret(v, pw)) === sk
})
await check('unlock "password" with wrong password -> wrong-password', async () => {
  const v = await lockSecret(sk, { method: 'password', password: pw }, 'test')
  return rejects(() => unlockSecret(v, 'not the password'), 'wrong-password')
})
await check('lock "password" short password -> weak-password', () =>
  rejects(() => lockSecret(sk, { method: 'password', password: 'short' }, 'test'), 'weak-password'),
)
await check('lock/unlock "none" round trip', async () => {
  const v = await lockSecret(sk, { method: 'none' }, 'test')
  return v.method === 'none' && (await unlockSecret(v)) === sk
})
await check('lock rejects non-hex key -> invalid-key', () => rejects(() => lockSecret('zz', { method: 'none' }, 't'), 'invalid-key'))

console.log(failed ? `\n${failed} FAILED` : '\nall passed')
process.exit(failed ? 1 : 0)
