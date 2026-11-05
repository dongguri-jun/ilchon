/**
 * The one engine instance of the browser app, wired to the real modules.
 * Screens import `actions`, `useIlchon` and call `bootEngine()` once.
 */
import { useStore } from 'zustand'
import {
  DEFAULT_RELAYS,
  type ConnectModule,
  type IlchonActions,
  type IlchonState,
  type MarmotModule,
} from '../contracts'
import { getLang, setLang } from '../i18n'
import * as connectModule from '../lib/connect'
import { createBrowserKV } from '../lib/kv'
import * as marmotModule from '../lib/marmot'
import { matchCrypto } from '../lib/match'
import { getProfileNamespace } from '../lib/profile'
import { createRatesSource } from '../lib/rates'
import { createEngine, transportNamespace } from './index'

const namespace = getProfileNamespace()
const marmot: MarmotModule = marmotModule
const connect: ConnectModule = connectModule

/** True when a storage name belongs to this profile and not to one whose name merely starts the same. */
function ownedByProfile(name: string): boolean {
  let from = 0
  for (;;) {
    const i = name.indexOf(namespace, from)
    if (i < 0) return false
    const next = name.charAt(i + namespace.length)
    if (next === '' || !/[A-Za-z0-9_-]/.test(next)) return true
    from = i + 1
  }
}

function deleteDatabase(name: string): Promise<void> {
  return new Promise((resolve) => {
    const req = indexedDB.deleteDatabase(name)
    req.onsuccess = req.onerror = req.onblocked = () => resolve()
  })
}

/**
 * The Transport contract has no "wipe" call, so reset removes every IndexedDB
 * database and localStorage entry named after this profile. The engine also
 * gives each identity its own transport namespace, so anything this sweep
 * misses is never read again.
 */
async function wipeProfileStores(): Promise<void> {
  try {
    const dbs = (await indexedDB.databases?.()) ?? []
    await Promise.all(dbs.flatMap((d) => (d.name && ownedByProfile(d.name) ? [deleteDatabase(d.name)] : [])))
  } catch {
    // best effort
  }
  try {
    for (let i = localStorage.length - 1; i >= 0; i--) {
      const key = localStorage.key(i)
      if (key && ownedByProfile(key)) localStorage.removeItem(key)
    }
  } catch {
    // best effort
  }
}

export const engine = createEngine(
  {
    kv: createBrowserKV(namespace),
    marmot,
    match: matchCrypto,
    connect,
    rates: createRatesSource(),
    relays: DEFAULT_RELAYS,
    namespace,
    persistence: 'indexeddb',
  },
  {
    defaultLang: getLang(),
    async onReset() {
      const pubkey = engine.store.getState().me?.pubkey
      // Named deletion first: indexedDB.databases() is missing in some browsers.
      if (pubkey) await marmotModule.purgeMarmotStorage(transportNamespace(namespace, pubkey), pubkey).catch(() => {})
      await wipeProfileStores()
      location.reload()
    },
    debug: import.meta.env.DEV ? (event, info) => console.debug('[ilchon]', event, info ?? '') : undefined,
  },
)

export const actions: IlchonActions = engine.actions

// The stored language wins over the browser default once settings are loaded.
engine.store.subscribe((s, prev) => {
  if (s.settings.lang !== prev.settings.lang) setLang(s.settings.lang)
})

let booting: Promise<void> | null = null

/** `?demo=1` turns demo mode on for this profile (stage devices), `?demo=0` off. */
function demoFlag(): boolean | undefined {
  try {
    const v = new URLSearchParams(location.search).get('demo')
    return v === '1' ? true : v === '0' ? false : undefined
  } catch {
    return undefined
  }
}

/** Idempotent. A failure ends in state.boot === 'error'; calling again retries. */
export function bootEngine(): Promise<void> {
  booting ??= engine
    .start()
    .then(async () => {
      const demo = demoFlag()
      if (demo !== undefined && engine.store.getState().settings.demoMode !== demo) {
        await actions.setSettings({ demoMode: demo })
      }
    })
    .catch(() => {
      booting = null
    })
  return booting
}

export function useIlchon<T>(selector: (s: IlchonState) => T): T {
  return useStore(engine.store, selector)
}
