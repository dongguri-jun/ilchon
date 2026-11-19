/**
 * The one engine instance of the browser app, wired to the real modules.
 * Screens import `actions`, `useIlchon` and call `bootEngine()` once.
 */
import { useEffect, useMemo, useState } from 'react'
import { useStore } from 'zustand'
import {
  DEFAULT_RELAYS,
  LIST_RELAYS,
  LOOKUP_RELAYS,
  type ChatMessage,
  type ConnectModule,
  type IlchonActions,
  type IlchonState,
  type MarmotModule,
  type Memo,
  type PubkeyHex,
  type TradeView,
} from '../contracts'
import { getLang, setLang } from '../i18n'
import * as connectModule from '../lib/connect'
import * as marmotModule from '../lib/marmot'
import { matchCrypto } from '../lib/match'
import { getProfileNamespace } from '../lib/profile'
import { requestPersistence } from '../lib/pwa'
import { createRatesSource } from '../lib/rates'
import { createLnurl } from '../lib/lnurl'
import { createProfileStorage } from '../lib/store'
import { indexedDbBackend } from '../lib/store/backend'
import { watchEngine } from '../lib/support-log'
import { SUPPORT_LOG_KEY, setHeaderSource, supportLog } from '../lib/support-log/browser'
import { createEngine, STORE_FORMAT } from './index'
import { afterPaint, createPrivacyCover } from './privacy-cover'
import { createRelockWatch, handsOffHref } from './relock'
import { tradeView } from './trade'
import { EXPIRY_RECOUNT_SLACK_MS } from '../lib/bolt11'

const namespace = getProfileNamespace()
const marmot: MarmotModule = marmotModule
const connect: ConnectModule = connectModule

/**
 * Old builds kept data in plain text: IndexedDB `ilchon` (the engine KV of every
 * profile), one `<namespace>/marmot/<pubkey>` database per identity, and some
 * localStorage keys. It is deleted, never read.
 * The new store has another name (`<namespace>/store`), so the order does not matter.
 * Failures are swallowed: the next start tries again. The support log is kept.
 *
 * The localStorage keys of every profile (the final set): the room
 * steps moved into the encrypted engine state (`tradeSteps`), the relay
 * list into Settings, the intro card and linked profiles into
 * the encrypted memo. None is moved: no stored data from older versions is kept. Now
 * the app writes no localStorage key but the support log.
 */
const LEGACY_SUFFIXES: readonly string[] = ['relays', 'room-step:', 'intro-dismissed', 'nostr:']
function dropLegacyLocal(): void {
  try {
    const profileKey = /^ilchon:[A-Za-z0-9_-]+:(.+)$/
    for (let i = localStorage.length - 1; i >= 0; i--) {
      const key = localStorage.key(i)
      if (!key || key === SUPPORT_LOG_KEY) continue
      const rest = profileKey.exec(key)?.[1] ?? ''
      const legacy = rest !== '' && LEGACY_SUFFIXES.some((s) => (s.endsWith(':') ? rest.startsWith(s) && rest.length > s.length : rest === s))
      if (key === 'ilchon:lang' || legacy) localStorage.removeItem(key)
    }
  } catch {
    // storage blocked: next start
  }
}
async function dropLegacyStorage(): Promise<void> {
  dropLegacyLocal()
  if (typeof indexedDB === 'undefined') return
  const names = ['ilchon']
  try {
    if (typeof indexedDB.databases === 'function') {
      for (const d of await indexedDB.databases()) if (d.name && d.name.includes('/marmot/')) names.push(d.name)
    }
  } catch {
    // no list: the named one only
  }
  for (const name of names) {
    try {
      // Not awaited for success: a blocked delete finishes once the other tab closes.
      indexedDB.deleteDatabase(name)
    } catch {
      // next start
    }
  }
}

// Transport warnings go to the support log too (relay-level ones with codes, room-level
// ones as bare phrases).
marmotModule.setLogSink((phrase, values) => supportLog.marmot(phrase, values))

export const engine = createEngine(
  {
    storage: createProfileStorage({
      backend: indexedDbBackend(`${namespace}/store`, () => location.reload()),
      namespace,
      format: STORE_FORMAT,
      // Development builds only: a shipped build drops this branch and the
      // no-lock chunk with it. pnpm build checks dist/ (scripts/check-dist.ts).
      noLock: import.meta.env.DEV ? () => import('../lib/vault/no-lock') : undefined,
    }),
    marmot,
    match: matchCrypto,
    connect,
    rates: createRatesSource(),
    // Straight from this browser to the user's own wallet service; no proxy.
    lnurl: createLnurl(),
    // The defaults; Settings.relays (encrypted) replaces them at start.
    relays: [...DEFAULT_RELAYS],
    lookupRelays: LOOKUP_RELAYS,
    // The contact list goes only to these; never to the chat relays.
    listRelays: [...LIST_RELAYS],
    namespace,
    persistence: 'indexeddb',
  },
  {
    defaultLang: getLang(),
    // The engine already deleted the profile's whole store.
    onReset({ reason }) {
      // An old build's plain keys (counterparty pubkeys, linked profiles) go now, not at
      // the next start. The support log is handled below.
      dropLegacyLocal()
      if (reason === 'format') {
        // The support log is kept: one line about it, written now.
        supportLog.add('app', 'stored data format changed, started over')
        supportLog.flush()
      } else {
        // A reset the user asked for leaves no log behind; nothing is saved after this.
        supportLog.clear()
      }
      location.reload()
    },
    onExternalChange() {
      // Another tab created, re-locked or wiped this profile's identity.
      location.reload()
    },
    debug(event, info) {
      // Only events on the support log's allow list make a line (ENGINE_LINES).
      supportLog.engine(event, info)
      if (import.meta.env.DEV) console.debug('[ilchon]', event, info ?? '')
    },
  },
)

export const actions: IlchonActions = engine.actions
/** The screens' small values, encrypted with everything else (Engine.memo). */
export const memo: Memo = engine.memo

watchEngine(supportLog, engine.store, () => (typeof performance === 'undefined' ? 0 : performance.now()))
setHeaderSource(() => {
  const s = engine.store.getState()
  return {
    lock: s.lock.method === 'none' ? 'dev' : (s.lock.method ?? 'none-yet'),
    boot: s.boot,
    relays: s.relays.length ? s.relays.map((r) => `${r.url} ${r.connected ? 'connected' : 'not connected'}`).join(', ') : 'none',
    lang: getLang(),
  }
})

// Before unlock screens follow the browser language; once ready the
// saved language wins, and later changes follow it.
engine.store.subscribe((s, prev) => {
  if (s.boot !== 'ready') return
  if (prev.boot !== 'ready' || s.settings.lang !== prev.settings.lang) setLang(s.settings.lang)
})

// Ask to keep the store once per page, when the app first opens: right
// after the identity is made and right after an unlock. The result goes to the support
// log header (storage persisted).
engine.store.subscribe((s, prev) => {
  if (s.boot === 'ready' && prev.boot !== 'ready' && !persistAsked) {
    persistAsked = true
    void requestPersistence()
  }
})
let persistAsked = false

let booting: Promise<void> | null = null

/** How long the app must stay in view or online before waiting rounds are re-armed. */
const RETURN_DEBOUNCE_MS = 2_500

if (typeof document !== 'undefined') {
  // Auto-lock: out of view for Settings.relockMinutes.
  // While out of view with a lock in place an opaque cover hides the app.
  const privacyCover = createPrivacyCover(document)
  const relock = createRelockWatch({
    now: () => Date.now(),
    setTimer: (fn, ms) => setTimeout(fn, ms),
    clearTimer: (h) => clearTimeout(h as ReturnType<typeof setTimeout>),
    armed: () => {
      const s = engine.store.getState()
      // The key is in memory from openIdentity on, also while waiting for relays:
      // a phone put away while starting locks again too.
      const keyInMemory = s.boot === 'ready' || (s.boot === 'starting' && s.me !== null)
      return keyInMemory && (s.lock.method === 'passkey' || s.lock.method === 'pin')
    },
    minutes: () => engine.store.getState().settings.relockMinutes,
    hidden: () => document.visibilityState === 'hidden',
    lock: () => {
      // Nothing of the unlocked app may show while the page reloads: the cover is drawn
      // first, so the frame the screen keeps through the reload is the cover.
      privacyCover.show()
      afterPaint(
        {
          visible: () => document.visibilityState === 'visible',
          frame: (fn) => requestAnimationFrame(fn),
          setTimer: (fn, ms) => setTimeout(fn, ms),
        },
        () => {
          document.documentElement.style.visibility = 'hidden'
          location.reload()
        },
      )
    },
    cover: () => privacyCover.show(),
    uncover: () => privacyCover.hide(),
    focused: () => document.hasFocus(),
    // Touch devices only: on a desktop another window in front is still in view.
    blurCovers: () => typeof matchMedia === 'function' && matchMedia('(hover: none) and (pointer: coarse)').matches,
  })
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'hidden') relock.hide()
    else relock.show()
  })
  // A page kept in the back-forward cache comes back with its memory: same rule.
  window.addEventListener('pagehide', () => relock.hide())
  window.addEventListener('pageshow', () => {
    if (document.visibilityState === 'visible') relock.show()
  })
  // Earlier than visibilitychange on Android: the window loses
  // focus while the page is still drawn, before the system takes the recent-apps picture.
  // Only the window's own blur and focus, not those of an element inside the page.
  window.addEventListener('blur', (e) => {
    if (e.target === window) relock.blur()
  })
  window.addEventListener('focus', (e) => {
    if (e.target === window) relock.focus()
  })
  // Any touch takes a blur cover off; only a real tap starts the system-sheet grace. A
  // touch that becomes a scroll gets pointercancel and no click, so it is not a tap.
  document.addEventListener('pointerdown', () => relock.touch(), true)
  // A tap on a link to another app (the pay button) gets no grace: its blur is leaving.
  const handsOff = (t: EventTarget | null) => t instanceof Element && handsOffHref(t.closest('a[href]')?.getAttribute('href'))
  document.addEventListener('click', (e) => relock.tap(handsOff(e.target)), true)
  document.addEventListener(
    'keydown',
    (e) => {
      if (e.key !== 'Enter' && e.key !== ' ') return
      // Typing in a field (the composer's Enter) opens no system sheet.
      const t = e.target
      if (t instanceof HTMLElement && (t.isContentEditable || t.tagName === 'INPUT' || t.tagName === 'TEXTAREA')) return
      relock.tap(handsOff(t))
    },
    true,
  )

  // Sockets need a moment to come back, and app switches arrive in bursts.
  let returnTimer: ReturnType<typeof setTimeout> | undefined
  const onReturn = () => {
    if (document.visibilityState !== 'visible') return
    clearTimeout(returnTimer)
    returnTimer = setTimeout(() => {
      if (document.visibilityState === 'visible') engine.rearmRounds()
    }, RETURN_DEBOUNCE_MS)
  }
  document.addEventListener('visibilitychange', onReturn)
  window.addEventListener('online', onReturn)
}

/** Idempotent. A failure ends in state.boot === 'error'; calling again retries. */
export function bootEngine(): Promise<void> {
  if (!booting) void dropLegacyStorage()
  booting ??= engine.start().catch(() => {
    booting = null
  })
  return booting
}

export function useIlchon<T>(selector: (s: IlchonState) => T): T {
  return useStore(engine.store, selector)
}

const NO_MESSAGES: ChatMessage[] = []

/**
 * The trade room of one contact (src/engine/trade.ts tradeView). Subscribes to that
 * room only, and counts again when the live card runs out.
 */
export function useTradeView(contactId: PubkeyHex): TradeView {
  const myOffer = useIlchon((s) => s.myOffer)
  const matches = useIlchon((s) => s.matches)
  const rates = useIlchon((s) => s.rates)
  const messages = useIlchon((s) => s.rooms[contactId] ?? NO_MESSAGES)
  const rec = useIlchon((s) => s.tradeSteps[contactId])
  const [tick, setTick] = useState(0)
  const view = useMemo(
    () => tradeView({ myOffer, matches, rates, rooms: { [contactId]: messages }, tradeSteps: rec ? { [contactId]: rec } : {} }, contactId, Date.now()),
    // tick has no value of its own: it asks for a recount when the live card runs out.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [myOffer, matches, rates, messages, rec, contactId, tick],
  )
  useEffect(() => {
    if (!view.receiveExpiresAt) return
    const wait = Math.min(Math.max(view.receiveExpiresAt * 1000 - Date.now(), 0) + EXPIRY_RECOUNT_SLACK_MS, 2 ** 31 - 1)
    const timer = setTimeout(() => setTick((n) => n + 1), wait)
    return () => clearTimeout(timer)
  }, [view.receiveExpiresAt])
  return view
}
