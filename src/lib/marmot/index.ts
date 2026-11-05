/**
 * Real Marmot transport for ilchon (marmot-ts 0.9 over Nostr relays).
 *
 *   keys.ts       key helpers
 *   stores.ts     per-profile durable stores (IndexedDB) or memory
 *   network.ts    relay adapter implementing marmot-ts's network contract
 *   wire.ts       WireMessage validation
 *   transport.ts  Transport: start, invite, accept, send, receive
 */
import type { MarmotModule } from '../../contracts'
import { generateSecretKeyHex, npubOf, nsecOf, pubkeyOf } from './keys'
import { createTransport } from './transport'

export { createTransport, generateSecretKeyHex, npubOf, nsecOf, pubkeyOf }
export { purgeMarmotStorage } from './stores'

/** The module as one value, shaped like `MarmotModule`, for EngineDeps. */
export const marmot: MarmotModule = {
  createTransport,
  generateSecretKeyHex,
  pubkeyOf,
  npubOf,
  nsecOf,
}
