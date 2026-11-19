/**
 * The privacy cover (src/engine/relock.ts says when).
 * An opaque layer over the whole app while the page is out of view with a lock in place,
 * so the recent-apps picture and the first frames after coming back show no chat, amount
 * or draft. It holds nothing: no text, no logo, no data. It is a sibling of the React
 * root, so the app under it (the open room, a draft being typed, scroll positions) is
 * not touched and comes back as it was.
 *
 * Styles are set through the CSSOM (element.style), which the CSP allows; no style
 * attribute is written into HTML. Some phones may take the recent-apps picture before
 * the cover paints (not yet confirmed on a phone).
 */
export interface PrivacyCover {
  show(): void
  hide(): void
}

export function createPrivacyCover(doc: Document): PrivacyCover {
  let el: HTMLDivElement | null = null
  return {
    show() {
      if (el?.isConnected) return
      el = doc.createElement('div')
      el.setAttribute('aria-hidden', 'true')
      el.dataset.ilchonCover = ''
      const s = el.style
      s.position = 'fixed'
      s.inset = '0'
      s.zIndex = '2147483647'
      // The page background (tokens.css --c-bg), opaque in both themes.
      s.background = 'var(--c-bg, #ffffff)'
      s.pointerEvents = 'auto'
      // Stays drawn when the lock hides the page root just before its reload.
      s.visibility = 'visible'
      doc.body.appendChild(el)
    },
    hide() {
      el?.remove()
      el = null
    },
  }
}

export interface PaintDeps {
  /** The page is in view, so frames are drawn (visibilityState 'visible'). */
  visible(): boolean
  frame(fn: () => void): void
  setTimer(fn: () => void, ms: number): void
}

/** The longest wait for the cover's frame before the lock reloads anyway. */
export const PAINT_WAIT_MS = 150

/**
 * Runs `fn` once the frame now pending (the cover) has been drawn: two animation frames,
 * or PAINT_WAIT_MS at the latest. A hidden page draws nothing, so then at once.
 * Seen on a phone: a lock on return reloaded straight away and the screen
 * kept the last frame the page had drawn, the unlocked room, for about a second. The
 * reload now leaves the cover as that last frame.
 */
export function afterPaint(d: PaintDeps, fn: () => void): void {
  let done = false
  const once = () => {
    if (done) return
    done = true
    fn()
  }
  if (!d.visible()) return once()
  d.frame(() => d.frame(once))
  d.setTimer(once, PAINT_WAIT_MS)
}
