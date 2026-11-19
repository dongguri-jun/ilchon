/**
 * The support log of this page. src/main.tsx imports this first, so the
 * error handlers are on before the engine and Marmot chunks are evaluated. It never
 * imports the engine: when those chunks fail, this file still runs and the log can be
 * copied (from a plain button if React never started).
 *
 * Kept unencrypted in localStorage `<profile>:supportlog` (the one exception
 * to encrypted storage). Nothing is sent anywhere; the user copies it.
 */
import { APP_VERSION } from '../build'
import { getProfileNamespace } from '../profile'
import { copyText } from '../../screens/lock/util'
import { COPY } from './copy-log-copy'
import { fallbackLang } from './fallback'
import { createSupportLog, type StorageLike } from './index'

/** Saves wait this long to gather lines into one write. */
const SAVE_BATCH_MS = 1_000
/** A return to the page after this long hidden makes a line. */
const SHOWN_AFTER_MS = 30_000
/** After an uncaught error, how long React gets to draw something before the plain button appears. */
const FALLBACK_BUTTON_MS = 3_000
/** How long the button shows the result of a copy. */
export const COPY_RESULT_MS = 2_000

/** The localStorage key of this profile's log. A format wipe keeps it. */
export const SUPPORT_LOG_KEY = `${getProfileNamespace()}:supportlog`
const storageKey = SUPPORT_LOG_KEY

function browserStorage(): StorageLike | undefined {
  try {
    const s = globalThis.localStorage
    if (!s) return undefined
    // Private modes can throw on access; then the log lives in memory only.
    s.getItem(storageKey)
    return s
  } catch {
    return undefined
  }
}

let saveTimer: ReturnType<typeof setTimeout> | undefined

export const supportLog = createSupportLog({
  storage: browserStorage(),
  storageKey,
  onChange() {
    if (saveTimer !== undefined) return
    saveTimer = setTimeout(() => {
      saveTimer = undefined
      supportLog.flush()
    }, SAVE_BATCH_MS)
  },
})

/** What the engine adds to the header (src/engine/browser.ts registers it). */
export interface HeaderSource {
  lock: string
  boot: string
  relays: string
  lang: string
}

let headerSource: (() => HeaderSource) | null = null

export function setHeaderSource(fn: () => HeaderSource): void {
  headerSource = fn
}

let persisted = 'unknown'

function installed(): string {
  try {
    const nav = navigator as Navigator & { standalone?: boolean }
    return nav.standalone === true || window.matchMedia?.('(display-mode: standalone)').matches === true ? 'yes' : 'no'
  } catch {
    return 'unknown'
  }
}

function header(): Record<string, string> {
  let engine: HeaderSource = { lock: 'unknown', boot: 'unknown', relays: 'unknown', lang: fallbackLang() }
  try {
    if (headerSource) engine = headerSource()
  } catch {
    // keep the unknowns
  }
  return {
    app: `${APP_VERSION} (${import.meta.env.DEV ? 'development' : 'production'})`,
    time: new Date().toISOString().replace(/\.\d{3}Z$/, 'Z'),
    browser: typeof navigator === 'undefined' ? 'unknown' : navigator.userAgent,
    installed: installed(),
    lang: engine.lang,
    online: typeof navigator === 'undefined' ? 'unknown' : navigator.onLine ? 'yes' : 'no',
    'storage persisted': persisted,
    lock: engine.lock,
    boot: engine.boot,
    relays: engine.relays,
  }
}

/**
 * Builds the text and hands it to the clipboard in the same turn as the tap: no await
 * before copyText, because iPhone WebKit refuses a clipboard write once the user's
 * gesture is over.
 */
export function copySupportLog(): Promise<boolean> {
  let text: string
  try {
    supportLog.flush()
    text = supportLog.dump(header())
  } catch {
    return Promise.resolve(false)
  }
  return copyText(text)
}

/** The basename and line of a script location: no host, no path. */
function where(file: string | undefined, line: number | undefined): string | undefined {
  if (!file) return undefined
  const base = file.split(/[?#]/)[0].split('/').pop() || 'script'
  return line ? `${base}:${line}` : base
}

/** A plain DOM "Copy log" button for when React never drew anything. */
function fallbackButton(): void {
  const root = document.getElementById('root')
  if (!root || root.firstElementChild || document.getElementById('ilchon-copy-log')) return
  const copy = COPY[fallbackLang()] ?? COPY.en
  const button = document.createElement('button')
  button.id = 'ilchon-copy-log'
  button.type = 'button'
  button.textContent = copy.copy
  button.style.cssText =
    'position:fixed;left:50%;bottom:32px;transform:translateX(-50%);padding:12px 20px;font:16px system-ui,sans-serif;border-radius:12px;border:1px solid #8888;background:#fff;color:#111;z-index:2147483647'
  let timer: ReturnType<typeof setTimeout> | undefined
  button.addEventListener('click', () => {
    void copySupportLog().then((ok) => {
      button.textContent = ok ? copy.copied : copy.failed
      clearTimeout(timer)
      timer = setTimeout(() => (button.textContent = copy.copy), COPY_RESULT_MS)
    })
  })
  document.body.appendChild(button)
}

if (typeof window !== 'undefined' && typeof document !== 'undefined') {
  supportLog.marker(`app start ${APP_VERSION}`)

  let fallbackTimer: ReturnType<typeof setTimeout> | undefined
  const afterError = () => {
    if (fallbackTimer !== undefined) return
    fallbackTimer = setTimeout(() => {
      fallbackTimer = undefined
      fallbackButton()
    }, FALLBACK_BUTTON_MS)
  }

  window.addEventListener('error', (ev) => {
    supportLog.error('error', ev.error ?? ev.message, where(ev.filename, ev.lineno))
    afterError()
  })
  window.addEventListener('unhandledrejection', (ev) => {
    supportLog.error('rejection', ev.reason)
  })
  window.addEventListener('online', () => supportLog.add('net', 'online'))
  window.addEventListener('offline', () => supportLog.add('net', 'offline'))

  let hiddenAt = 0
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'hidden') {
      hiddenAt = Date.now()
      supportLog.flush()
      return
    }
    if (hiddenAt && Date.now() - hiddenAt > SHOWN_AFTER_MS) {
      supportLog.add('app', `shown after ${Math.round((Date.now() - hiddenAt) / 1000)} s`)
    }
    hiddenAt = 0
  })
  window.addEventListener('pagehide', () => supportLog.flush())

  try {
    void navigator.storage
      ?.persisted?.()
      .then((v) => (persisted = v ? 'yes' : 'no'))
      .catch(() => undefined)
  } catch {
    // stays unknown
  }
}
