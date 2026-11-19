/**
 * My contact list as one Nostr event.
 *
 * - Kind 30078 (NIP-78), one tag ['d', listD], no app name anywhere.
 * - Signed by a separate list key, never by my account key:
 *     listSecret = HKDF-SHA256(ikm = my secret key, salt "ilchon", info "contact-list/v1", 32 bytes)
 *     listD      = hex(HKDF-SHA256(ikm = listSecret, salt "ilchon", info "contact-list/d", 16 bytes))
 *   so my public npub does not show when my list changes, and nobody without my
 *   secret key can pick ilchon lists out with a fixed `d`.
 * - Content: NIP-44 v2 from the list key to the list key itself (only I can read it).
 *   The plaintext is always LIST_BYTES (src/engine/contact-list.ts), so every event
 *   has the same size whatever the list holds.
 * - Queries and publishes never answer NIP-42 auth.
 *
 * The engine deals in plaintext strings only; shaping and checking the plaintext is
 * src/engine/contact-list.ts.
 */
import { bytesToHex, verifyEvent, type NostrEvent } from 'applesauce-core/helpers/event'
import { getPublicKey } from 'applesauce-core/helpers/keys'
import { PrivateKeySigner } from 'applesauce-signers'
import { secp256k1 } from '@noble/curves/secp256k1.js'
import { hkdf } from '@noble/hashes/hkdf.js'
import { sha256 } from '@noble/hashes/sha2.js'
import { utf8ToBytes } from '@noble/hashes/utils.js'
import type { ListCopy, ListFetch, PubkeyHex } from '../../contracts'
import { secretKeyBytes } from './keys'
import { RelayNetwork, type PublishResults } from './network'

export const LIST_KIND = 30078
const SALT = utf8ToBytes('ilchon')
const INFO_KEY = utf8ToBytes('contact-list/v1')
const INFO_D = utf8ToBytes('contact-list/d')

/** The list key's secret, derived from my secret key. Throws Error('list-key') in the ~2^-128 case it is not a valid key. */
export function listSecretOf(secretKeyHex: string): Uint8Array {
  const secret = hkdf(sha256, secretKeyBytes(secretKeyHex), SALT, INFO_KEY, 32)
  if (!secp256k1.utils.isValidSecretKey(secret)) throw new Error('list-key')
  return secret
}

/** The list key's public key: the author of every copy of my list. */
export function listPubkeyOf(secretKeyHex: string): PubkeyHex {
  return getPublicKey(listSecretOf(secretKeyHex))
}

/** The `d` tag value of my list event (32 hex characters). */
export function listDOf(secretKeyHex: string): string {
  return bytesToHex(hkdf(sha256, listSecretOf(secretKeyHex), SALT, INFO_D, 16))
}

/** The query for my list: only the list key's kind 30078 with my `d`, newest one. */
export function listFilter(secretKeyHex: string): { kinds: number[]; authors: string[]; '#d': string[]; limit: number } {
  return { kinds: [LIST_KIND], authors: [listPubkeyOf(secretKeyHex)], '#d': [listDOf(secretKeyHex)], limit: 1 }
}

/** Encrypts `payload` to the list key itself and signs the kind 30078 event with it. */
export async function sealList(secretKeyHex: string, payload: string, createdAt: number): Promise<NostrEvent> {
  if (!Number.isSafeInteger(createdAt) || createdAt < 0) throw new Error('list created_at must be whole seconds')
  const signer = new PrivateKeySigner(listSecretOf(secretKeyHex))
  const pubkey = await signer.getPublicKey()
  const content = await signer.nip44.encrypt(pubkey, payload)
  return signer.signEvent({ kind: LIST_KIND, created_at: createdAt, tags: [['d', listDOf(secretKeyHex)]], content })
}

/**
 * The plaintext of one copy of my list, or null when it is not mine: wrong kind,
 * author other than my list key, a `d` other than mine, a bad signature, or content
 * my list key cannot decrypt.
 */
export async function openList(secretKeyHex: string, event: NostrEvent): Promise<string | null> {
  try {
    const listPubkey = listPubkeyOf(secretKeyHex)
    if (event.kind !== LIST_KIND || event.pubkey !== listPubkey) return null
    const d = event.tags.filter((tag) => tag[0] === 'd')
    if (d.length !== 1 || d[0][1] !== listDOf(secretKeyHex)) return null
    if (!verifyEvent(event)) return null
    const signer = new PrivateKeySigner(listSecretOf(secretKeyHex))
    return await signer.nip44.decrypt(listPubkey, event.content)
  } catch {
    return null
  }
}

/**
 * Asks `relays` for my list and waits for every one of them (the requestEach rules).
 * Per answering relay, the newest copy that opens. Rejects when no relay answered.
 */
export async function fetchCopies(network: RelayNetwork, relays: string[], secretKeyHex: string): Promise<ListFetch> {
  const each = await network.requestEach(relays, listFilter(secretKeyHex), { waitFor: relays })
  const copies: ListCopy[] = []
  for (const relay of each.answered) {
    const events = [...(each.byRelay[relay] ?? [])].sort((a, b) => b.created_at - a.created_at)
    for (const event of events) {
      const payload = await openList(secretKeyHex, event)
      if (payload === null) continue
      copies.push({ relay, payload, createdAt: event.created_at })
      break
    }
  }
  return { copies, answered: each.answered, asked: each.asked }
}

/** Publishes a sealed list event to `relays` and waits for each one's verdict. No auth. */
export function publishListEvent(network: RelayNetwork, relays: string[], event: NostrEvent): Promise<PublishResults> {
  if (!relays.length) return Promise.resolve({})
  return network.publishAll(relays, event)
}

/**
 * Restore only, on a network of its own that is closed
 * afterwards: my list on `relays`, every one awaited. The list is kept only on the
 * list relays only, so no kind 10002 lookup widens the query (a kind 10002 lookup would
 * only find my chat relays, which never hold it). Rejects when no relay answered.
 */
export async function findList(opts: { secretKeyHex: string; relays: string[] }): Promise<ListFetch> {
  const { secretKeyHex, relays } = opts
  if (!relays.length) throw new Error('no relay answered the request')
  // The signer only exists to satisfy the network; nothing here answers auth.
  const network = new RelayNetwork(relays, new PrivateKeySigner(secretKeyBytes(secretKeyHex)))
  try {
    return await fetchCopies(network, relays, secretKeyHex)
  } finally {
    network.close()
  }
}
