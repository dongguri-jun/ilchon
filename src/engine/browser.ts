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
  type VaultModule,
} from '../contracts'
import { getLang, setLang } from '../i18n'
import * as connectModule from '../lib/connect'
import { createBrowserKV } from '../lib/kv'
import * as marmotModule from '../lib/marmot'
import { matchCrypto } from '../lib/match'
import { getProfileNamespace } from '../lib/profile'
import { createRatesSource } from '../lib/rates'
import * as vaultModule from '../lib/vault'
import { createEngine, transportNamespace } from './index'

const namespace = getProfileNamespace()
const marmot: MarmotModule = marmotModule
const connect: ConnectModule = connectModule
const vault: VaultModule = vaultModule

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

/** How long a deletion blocked by another open connection may take before it counts as failed. */
const DELETE_BLOCKED_MS = 5_000

/** Resolves true once the database is gone; false on error or when it stays blocked. */
function deleteDatabase(name: string): Promise<boolean> {
  return new Promise((resolve) => {
    let timer: ReturnType<typeof setTimeout> | undefined
    const done = (ok: boolean) => {
      if (timer !== undefined) clearTimeout(timer)
      resolve(ok)
    }
    const req = indexedDB.deleteDatabase(name)
    req.onsuccess = () => done(true)
    req.onerror = () => done(false)
    // Blocked may still turn into success when the other connection closes.
    req.onblocked = () => {
      timer ??= setTimeout(() => resolve(false), DELETE_BLOCKED_MS)
    }
  })
}

/**
 * The Transport contract has no "wipe" call, so reset removes every IndexedDB
 * database and localStorage entry named after this profile. The engine also
 * gives each identity its own transport namespace, so anything this sweep
 * misses is never read again. Resolves false when something could not be deleted.
 */
async function wipeProfileStores(): Promise<boolean> {
  let ok = true
  // indexedDB.databases() is missing in some browsers; the named purge in onReset covers that case.
  let names: string[] = []
  try {
    names = ((await indexedDB.databases?.()) ?? []).flatMap((d) => (d.name && ownedByProfile(d.name) ? [d.name] : []))
  } catch {
    names = []
  }
  const results = await Promise.all(names.map(deleteDatabase))
  if (results.includes(false)) ok = false
  try {
    for (let i = localStorage.length - 1; i >= 0; i--) {
      const key = localStorage.key(i)
      if (key && ownedByProfile(key)) localStorage.removeItem(key)
    }
  } catch {
    ok = false
  }
  return ok
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
    vault,
  },
  {
    defaultLang: getLang(),
    async onReset({ pubkey }) {
      let ok = true
      // Named deletion first: indexedDB.databases() is missing in some browsers.
      // `pubkey` comes from the engine, which knows it from storage even while locked.
      if (pubkey) {
        await marmotModule.purgeMarmotStorage(transportNamespace(namespace, pubkey), pubkey).catch(() => {
          ok = false
        })
      }
      if (!(await wipeProfileStores())) ok = false
      // The engine turns this into 'reset-failed'; reloading now would look like a finished wipe.
      if (!ok) throw new Error('reset-failed')
      location.reload()
    },
    onExternalChange() {
      // Another tab created, re-locked or wiped this profile's identity.
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

/** After this long in the background a locked identity is locked again (by reloading). */
const RELOCK_AFTER_MS = 5 * 60_000

if (typeof document !== 'undefined') {
  let hiddenAt = 0
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'hidden') {
      hiddenAt = Date.now()
      return
    }
    const s = engine.store.getState()
    if (hiddenAt && Date.now() - hiddenAt > RELOCK_AFTER_MS && s.boot === 'ready' && s.lock.method && s.lock.method !== 'none') {
      location.reload()
    }
    hiddenAt = 0
  })
}

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
