import { useEffect, useRef, useState, type RefObject } from 'react'

/**
 * Keeps an overlay mounted for `exitMs` after `open` turns false so its exit
 * animation can play. `closing` is true during that window.
 */
export function usePresence(open: boolean, exitMs = 200): { render: boolean; closing: boolean } {
  const [mounted, setMounted] = useState(open)
  useEffect(() => {
    if (open) {
      setMounted(true)
      return
    }
    const t = setTimeout(() => setMounted(false), exitMs)
    return () => clearTimeout(t)
  }, [open, exitMs])
  return { render: open || mounted, closing: !open && mounted }
}

let lockCount = 0
let savedOverflow = ''

/** Locks page scroll while `active` (reference counted so overlays can stack). */
export function useScrollLock(active: boolean): void {
  useEffect(() => {
    if (!active) return
    if (lockCount === 0) {
      savedOverflow = document.body.style.overflow
      document.body.style.overflow = 'hidden'
    }
    lockCount++
    return () => {
      lockCount--
      if (lockCount === 0) document.body.style.overflow = savedOverflow
    }
  }, [active])
}

// Open modals, topmost last. Only the topmost one reacts to Escape/Tab.
const modalStack: object[] = []

const FOCUSABLE =
  'a[href],button:not([disabled]),input:not([disabled]),textarea:not([disabled]),select:not([disabled]),[tabindex]:not([tabindex="-1"])'

/**
 * Escape-to-close, basic Tab trapping and focus restore for a modal panel.
 * The panel needs tabIndex={-1}.
 */
export function useModalBehavior(
  active: boolean,
  panelRef: RefObject<HTMLElement | null>,
  onEscape: (() => void) | undefined,
): void {
  const escRef = useRef(onEscape)
  escRef.current = onEscape

  useEffect(() => {
    if (!active) return
    const token = {}
    modalStack.push(token)
    const previous = document.activeElement as HTMLElement | null
    const panel = panelRef.current
    panel?.focus({ preventScroll: true })

    const onKey = (e: KeyboardEvent) => {
      if (modalStack[modalStack.length - 1] !== token) return
      if (e.key === 'Escape') {
        if (escRef.current) {
          e.stopPropagation()
          escRef.current()
        }
        return
      }
      if (e.key !== 'Tab' || !panel) return
      const items = Array.from(panel.querySelectorAll<HTMLElement>(FOCUSABLE))
      if (items.length === 0) {
        e.preventDefault()
        return
      }
      const first = items[0]
      const last = items[items.length - 1]
      const cur = document.activeElement
      if (e.shiftKey && (cur === first || cur === panel)) {
        e.preventDefault()
        last.focus()
      } else if (!e.shiftKey && cur === last) {
        e.preventDefault()
        first.focus()
      }
    }
    document.addEventListener('keydown', onKey)
    return () => {
      document.removeEventListener('keydown', onKey)
      const at = modalStack.indexOf(token)
      if (at >= 0) modalStack.splice(at, 1)
      previous?.focus?.({ preventScroll: true })
    }
  }, [active, panelRef])
}
