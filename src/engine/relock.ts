/**
 * When the app locks again. No DOM here: the browser
 * wiring is in src/engine/browser.ts and scripts/check-storage.ts drives this with a
 * fake clock.
 *
 * What counts is the time the app is out of view (visibilitychange), not idle time in
 * front: a phone turns its screen off by itself, which hides the page, while a person
 * looking at a trade room waiting for a payment should not be locked out.
 *
 * - Going out of view while a key is in memory behind a real lock (passkey or PIN):
 *   note the time and set a timer for the auto-lock time. Where hidden pages keep
 *   running timers (Android Chrome, if slowly) the key goes early; when it fires it
 *   checks again and locks only if the page is still hidden and still armed.
 * - Coming back: cancel the timer. Lock when the time out of view reached the
 *   auto-lock time, or is negative (the clock went back). A phone that slept or a
 *   page the system froze (iOS) is caught here, by the wall clock.
 * - Locking is a reload: the screen is covered first so nothing of
 *   the unlocked app shows, then the page with its keys and plain state is dropped.
 *   The engine is not stopped: this is the power-off path, which the inbox and the
 *   crash sweep already cover.
 * - Privacy cover: Android Chrome runs no timers
 *   while hidden, so the lock only comes on return, and the unlocked room showed for a
 *   moment then and in the recent-apps thumbnail. So the moment the page goes out of
 *   view while armed, an opaque cover goes over the app (cover()). On return the rule
 *   above decides: a lock that is due reloads under the cover; otherwise the cover comes
 *   off (uncover()) and the screen, the open room and the draft are as they were.
 * - Earlier cover on phones: on Android the system
 *   takes the recent-apps picture as the app leaves, before Chrome tells the page it is
 *   hidden, and a hidden page paints nothing more; so a cover added on visibilitychange
 *   was in the page but not in the picture, and on return the last painted frame (the
 *   room) showed for about a second. The window loses focus (window 'blur') when the
 *   person starts leaving, while the page is still drawn, so on a touch device
 *   (blurCovers) the cover goes on then. Blur also comes from the app's own system
 *   sheets (passkey, camera or clipboard permission): a blur within TAP_GRACE_MS of a tap
 *   (a click, or Enter/Space on a control) is taken as one of those and covers nothing.
 *   A touch that starts a scroll is not a tap (no click follows it), so reading and
 *   scrolling a room then leaving still covers on blur. A blur cover comes off on focus
 *   or on the next touch. Desktops do not cover on blur: another window in front is
 *   still in view.
 * - Coming back without a lock due, the cover stays until the page is visible and has
 *   focus again (or a touch, or FOCUS_WAIT_MS at the latest, so a browser that sends no
 *   focus event does not leave a blank screen).
 */

/** A blur this soon after a tap in the page is the app's own system sheet, not leaving. */
export const TAP_GRACE_MS = 1_000
/** On return, how long the cover waits for focus before it comes off anyway. */
export const FOCUS_WAIT_MS = 1_000

/**
 * A link that leaves the browser for another app: any
 * scheme but the page's own kinds (http, https, blob, data, about) and in-page or relative
 * links. The pay buttons are lightning: and bitcoin: links; intent: is Android's hand-off.
 * The tap grace must not hide such a leave: the other app's screen is not a system sheet
 * over this one, and the recent-apps picture would show the unlocked room.
 */
export function handsOffHref(href: string | null | undefined): boolean {
  if (!href) return false
  const m = /^\s*([a-zA-Z][a-zA-Z0-9+.-]*):/.exec(href)
  if (!m) return false
  return !['http', 'https', 'blob', 'data', 'about', 'javascript'].includes(m[1].toLowerCase())
}

export interface RelockDeps {
  /** Wall clock in ms (Date.now): it runs on while the phone sleeps. */
  now(): number
  setTimer(fn: () => void, ms: number): unknown
  clearTimer(handle: unknown): void
  /** A key is in memory behind a passkey or PIN lock (not 'none', not locked, not setup). */
  armed(): boolean
  /** The auto-lock time now (Settings.relockMinutes). */
  minutes(): number
  /** The page is out of view now. */
  hidden(): boolean
  /** Cover the screen and reload. */
  lock(): void
  /** Put the opaque privacy cover over the app (idempotent). */
  cover(): void
  /** Take the privacy cover off (idempotent). */
  uncover(): void
  /** The page has input focus now (document.hasFocus()). */
  focused(): boolean
  /** A window blur covers (touch devices); false on desktops. */
  blurCovers(): boolean
}

export interface RelockWatch {
  /** The page went out of view (visibilitychange to hidden, pagehide). */
  hide(): void
  /** The page is in view again (visibilitychange to visible, pageshow). */
  show(): void
  /** The window lost focus (window 'blur'): on a phone, the person may be leaving. */
  blur(): void
  /** The window has focus again (window 'focus'). */
  focus(): void
  /**
   * A tap that can open a system sheet: a click (fires only for a touch without a
   * scroll) or Enter/Space on a control. Starts the TAP_GRACE_MS window, unless
   * `handsOff`: the tap follows a link that hands the person to another app (the pay
   * button's lightning: or bitcoin: link, any intent: link, handsOffHref), so the blur
   * that follows is leaving and covers at once.
   */
  tap(handsOff?: boolean): void
  /** Any touch or press in the page (pointerdown), scrolls included: takes a blur cover off. */
  touch(): void
}

export function createRelockWatch(d: RelockDeps): RelockWatch {
  /** When the page went out of view while armed; 0 when in view or not armed. */
  let hiddenAt = 0
  let timer: unknown = undefined
  let locked = false
  /** The cover is on for a blur or a return, not for a hide: focus or a touch takes it off. */
  let soft = false
  let lastTap = Number.NEGATIVE_INFINITY
  let waitTimer: unknown = undefined
  const stopWait = () => {
    if (waitTimer !== undefined) d.clearTimer(waitTimer)
    waitTimer = undefined
  }
  /** Off when in view, not locking and not hidden-armed. */
  const softOff = () => {
    if (!soft || locked || hiddenAt || d.hidden()) return
    soft = false
    stopWait()
    d.uncover()
  }
  const lockNow = () => {
    if (locked) return
    locked = true
    d.lock()
  }
  const cancel = () => {
    if (timer !== undefined) d.clearTimer(timer)
    timer = undefined
  }
  return {
    hide() {
      if (locked || !d.armed()) return
      // Covered at once, before the system takes the recent-apps picture if it can be.
      soft = false
      stopWait()
      d.cover()
      // A second hide (pagehide after visibilitychange) keeps the first moment.
      if (hiddenAt) return
      hiddenAt = d.now()
      const ms = d.minutes() * 60_000
      timer = d.setTimer(() => {
        timer = undefined
        if (d.hidden() && d.armed()) lockNow()
      }, ms)
    },
    show() {
      if (locked) return
      if (hiddenAt) {
        cancel()
        const away = d.now() - hiddenAt
        hiddenAt = 0
        if (d.armed() && (away < 0 || away >= d.minutes() * 60_000)) return lockNow()
      }
      // Not due (or not armed any more): the app as it was, once the page has focus again.
      // The reload keeps the cover.
      if (d.focused()) {
        soft = false
        stopWait()
        return d.uncover()
      }
      soft = true
      stopWait()
      waitTimer = d.setTimer(() => {
        waitTimer = undefined
        softOff()
      }, FOCUS_WAIT_MS)
    },
    blur() {
      if (locked || hiddenAt || d.hidden() || !d.blurCovers() || !d.armed()) return
      const since = d.now() - lastTap
      if (since >= 0 && since < TAP_GRACE_MS) return
      soft = true
      d.cover()
    },
    focus() {
      softOff()
    },
    tap(handsOff = false) {
      lastTap = handsOff ? Number.NEGATIVE_INFINITY : d.now()
      softOff()
    },
    touch() {
      softOff()
    },
  }
}
