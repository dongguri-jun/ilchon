import { useEffect, type RefObject } from 'react'

/**
 * The visual viewport is this much shorter than the layout viewport (CSS px) before we
 * call the keyboard open. On-screen keyboards are well over 200 px tall; the browser's
 * own bars that come and go while scrolling are well under this.
 */
export const KEYBOARD_OPEN_MIN = 120

/**
 * Extra lift (CSS px) above the visual viewport's bottom while the keyboard is open in
 * Android Chrome and the composer has the focus.
 * Chrome draws its autofill bar (key, card and place icons) above the keyboard taller
 * than the room it takes out of the visual viewport: on one Android phone (Chrome 156, device
 * pixel ratio 2.8125) the bar was 64 CSS px tall but the visual viewport ended only 48.7
 * px above the keyboard, so about 15.3 px of the bar lay over the page where nothing can
 * measure it. 24 covers that with some room for other display sizes; it is a starting
 * value to confirm on more phones.
 */
export const ANDROID_KEYBOARD_BAR_ALLOWANCE = 24

export interface KeyboardGapExtra {
  /**
   * The layout height the keyboard does not shrink: document.documentElement.clientHeight
   * (the initial containing block). Not window.innerHeight: in Chrome on the main frame
   * innerHeight follows the visual viewport, so with the keyboard open it drops to about
   * the visual viewport's height and the keyboard would always read as closed. When given
   * and the visual viewport is less than KEYBOARD_OPEN_MIN shorter than it, the keyboard
   * is closed and there is no lift, whatever the composer's box says. A box still moving
   * in the room's opening animation (translateY(12px)) then cannot leave a lift
   * behind. If a browser resizes the layout for the keyboard (interactive-widget
   * resizes-content), this also reads closed; the layout then already ends above the
   * keyboard, so only the bar allowance is lost. On a phone, clientHeight stayed 739 with
   * the keyboard open, which confirmed it.
   */
  layoutHeight?: number
  /** Extra lift while the keyboard is open (ANDROID_KEYBOARD_BAR_ALLOWANCE). */
  bar?: number
}

/**
 * How far the bottom of the composer (where it would sit with no gap) reaches below the
 * part of the page the person can see (the visual viewport), plus `extra.bar`. Rounded
 * up to whole CSS px.
 * 0 while the page is pinch-zoomed (`scale`, visualViewport.scale, not 1): the visual
 * viewport then shrinks and pans with the fingers, not with the keyboard, and a lift
 * would make the composer jump with every zoom and pan.
 * 0 when `extra.layoutHeight` says the keyboard is closed.
 */
export function keyboardGap(naturalBottom: number, viewTop: number, viewHeight: number, scale = 1, extra: KeyboardGapExtra = {}): number {
  if (Math.abs(scale - 1) > 0.001) return 0
  if (extra.layoutHeight !== undefined && extra.layoutHeight - viewHeight < KEYBOARD_OPEN_MIN) return 0
  return Math.max(0, Math.ceil(naturalBottom - (viewTop + viewHeight - (extra.bar ?? 0))))
}

/**
 * What one measure of the composer reads.
 * `containerBottom` is where the composer ends with no lift: the bottom of the content box
 * of the room around it (the composer is its last child, the message list above it gives
 * up the space). It does not move with the lift, so it is the natural bottom.
 * The composer's own box and the lift now applied are not part of a sample: the old
 * estimate, composer bottom + applied lift, assumed the whole lift had moved the composer.
 * Once the message list could not shrink any further the composer stopped moving while the
 * lift kept growing (on a phone: 368 -> 453 -> 492 px), and a measure that ran before
 * Chrome's last pan left a 345 px lift where 241 was right. check-trade feeds samples that
 * carry a growing lift and a moving composer box anyway and checks the result stays put.
 */
export interface ComposerSample {
  containerBottom: number
  viewTop: number
  viewHeight: number
  scale: number
  layoutHeight?: number
  bar?: number
}

/** The lift for one measure: keyboardGap from the natural bottom, with no feedback from the lift itself. */
export function composerLift(s: ComposerSample): number {
  return keyboardGap(s.containerBottom, s.viewTop, s.viewHeight, s.scale, { layoutHeight: s.layoutHeight, bar: s.bar })
}

/**
 * Frames after the last trigger at which the composer is measured once more. Chrome
 * can move the visual viewport (its last pan as the keyboard opens) a frame or so after
 * the scroll or resize event that announced it; a measure in the next frame alone then
 * saw the old offsetTop and nothing measured again. Two frames is a starting value.
 */
export const SETTLE_FRAMES = 2

export interface FrameClock {
  request: (cb: () => void) => number
  cancel: (id: number) => void
}

/**
 * Coalesces measure triggers: after any `kick`, `measure` runs in the next frame, and
 * once more `settleFrames` frames after that, counted from the last kick. DOM-free so
 * check-trade can drive it with a fake clock.
 */
export function settleMeasure(clock: FrameClock, measure: () => void, settleFrames = SETTLE_FRAMES): { kick: () => void; stop: () => void } {
  let frame = 0
  let first = false
  let due = 0
  const tick = () => {
    frame = 0
    if (first) {
      first = false
      measure()
      if (due > 0) frame = clock.request(tick)
      return
    }
    due--
    if (due <= 0) {
      measure()
      return
    }
    frame = clock.request(tick)
  }
  return {
    kick: () => {
      first = true
      due = settleFrames
      if (!frame) frame = clock.request(tick)
    },
    stop: () => {
      if (frame) clock.cancel(frame)
      frame = 0
    },
  }
}

/**
 * The document events after which the composer is measured again: the end of an
 * animation or transition (or a cancelled animation) may have moved it. Listened to in the
 * capture phase on the document; check-trade pins the list.
 */
export const SETTLE_EVENTS = ['animationend', 'animationcancel', 'transitionend'] as const

/**
 * Whether an animation or transition that ended on `target` can have moved the composer
 * `el`: only one on the composer itself or on a box around it. DOM-free (check-trade).
 */
export function movesComposer(target: unknown, el: unknown): boolean {
  const t = target as { contains?: (other: unknown) => boolean } | null
  return !!t && typeof t.contains === 'function' && t.contains(el)
}

/** Chrome on Android (and browsers built on it), where the autofill bar sits over the keyboard. */
function androidChrome(ua: string): boolean {
  return /Android/i.test(ua) && /Chrome\//.test(ua) && !/Firefox\//.test(ua)
}

/**
 * On Android Chrome the bar the browser puts
 * above the keyboard (key, card and place icons) covered the bottom few px of the chat
 * field and the send button. While the visual viewport ends above the composer's bottom,
 * the composer is lifted by that much (--room-kb, a bottom margin), so the field and the
 * button sit fully above the keyboard; the message list gives up the space.
 * Android only: iOS Safari pans the page itself to show the field, and a second lift on
 * top of that was not tried on a phone.
 * The visual viewport does not count all of that bar, so while the
 * keyboard is open and the focus is in the composer, Chrome gets ANDROID_KEYBOARD_BAR_ALLOWANCE
 * more. The first measure runs while the room is still sliding in (the overlay's
 * translateY(12px)); a closed keyboard means no lift at all, and the end of any
 * animation or transition on the composer or around it measures again.
 * The natural bottom is the room's bottom, not the composer's box plus the
 * lift (composerLift), and every trigger measures again SETTLE_FRAMES frames later
 * (settleMeasure), so Chrome's last pan as the keyboard opens is always seen.
 */
export function useKeyboardGap(ref: RefObject<HTMLElement | null>): void {
  useEffect(() => {
    const vv = typeof window !== 'undefined' ? window.visualViewport : null
    const el = ref.current
    if (!vv || !el || !/Android/i.test(navigator.userAgent)) return
    const barAllowance = androidChrome(navigator.userAgent) ? ANDROID_KEYBOARD_BAR_ALLOWANCE : 0
    let gap = 0
    const measure = () => {
      const focused = el.contains(document.activeElement)
      const room = el.parentElement
      let containerBottom = document.documentElement.clientHeight
      if (room) {
        const cs = getComputedStyle(room)
        containerBottom = room.getBoundingClientRect().bottom - (parseFloat(cs.paddingBottom) || 0) - (parseFloat(cs.borderBottomWidth) || 0)
      }
      const next = composerLift({
        containerBottom,
        viewTop: vv.offsetTop,
        viewHeight: vv.height,
        scale: vv.scale,
        layoutHeight: document.documentElement.clientHeight,
        bar: focused ? barAllowance : 0,
      })
      if (next === gap) return
      gap = next
      if (gap) el.style.setProperty('--room-kb', `${gap}px`)
      else el.style.removeProperty('--room-kb')
    }
    const clock = settleMeasure(
      { request: (cb) => requestAnimationFrame(cb), cancel: (id) => cancelAnimationFrame(id) },
      measure,
    )
    const schedule = clock.kick
    // Only an animation on the composer or on a box around it moves the composer.
    const settled = (e: Event) => {
      if (movesComposer(e.target, el)) schedule()
    }
    vv.addEventListener('resize', schedule)
    vv.addEventListener('scroll', schedule)
    window.addEventListener('resize', schedule)
    for (const type of SETTLE_EVENTS) document.addEventListener(type, settled, true)
    el.addEventListener('focusin', schedule)
    el.addEventListener('focusout', schedule)
    schedule()
    return () => {
      clock.stop()
      vv.removeEventListener('resize', schedule)
      vv.removeEventListener('scroll', schedule)
      window.removeEventListener('resize', schedule)
      for (const type of SETTLE_EVENTS) document.removeEventListener(type, settled, true)
      el.removeEventListener('focusin', schedule)
      el.removeEventListener('focusout', schedule)
      el.style.removeProperty('--room-kb')
    }
  }, [ref])
}
