/**
 * Real Marmot transport for ilchon (marmot-ts 0.9 over Nostr relays).
 *
 *   keys.ts       key helpers
 *   stores.ts     Marmot tables over the profile's encrypted storage (src/lib/store)
 *   network.ts    relay adapter implementing marmot-ts's network contract
 *   wire.ts       WireMessage validation
 *   list.ts       my encrypted contact list event (kind 30078, own list key)
 *   transport.ts  Transport: start, invite, accept, send, receive
 */
import type { MarmotModule } from '../../contracts'
import { generateSecretKeyHex, npubOf, pubkeyOf } from './keys'
import { findList } from './list'
import { createTransport } from './transport'

// generateSecretKeyHex stays a named export for scripts/smoke-marmot.ts; the app makes keys from 12 words (src/lib/seed).
export { createTransport, findList, generateSecretKeyHex, npubOf, pubkeyOf }
export { setLogSink } from './log'

/** The module as one value, shaped like `MarmotModule`, for EngineDeps. */
export const marmot: MarmotModule = {
  createTransport,
  pubkeyOf,
  npubOf,
  findList,
}
