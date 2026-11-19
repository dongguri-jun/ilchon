import { useLayoutEffect, useRef } from 'react'

/**
 * Keeps the caret in place in a field whose text is reformatted on every
 * keystroke (thousands separators added or removed, a keystroke ignored).
 * Without it a controlled input jumps the caret to the end.
 *
 * Call the returned function with the raw text of the change, before setting
 * the state. `significant` matches the characters that survive formatting
 * (digits, plus the point for currencies with decimals); the caret goes back
 * after the same number of them. `countBefore`, when given, counts them in the
 * raw text instead (for text the formatter rewrites first, such as fullwidth
 * digits converted to ASCII: src/lib/money significantBefore).
 */
export function useKeepCaret(): (raw: string, significant: RegExp, countBefore?: (raw: string, pos: number) => number) => void {
  const caret = useRef<{ el: HTMLInputElement; sig: number; test: RegExp } | null>(null)
  const apply = () => {
    const c = caret.current
    if (!c) return
    caret.current = null
    if (document.activeElement !== c.el) return
    const v = c.el.value
    let pos = 0
    let seen = 0
    while (pos < v.length && seen < c.sig) {
      if (c.test.test(v.charAt(pos))) seen++
      pos++
    }
    try {
      c.el.setSelectionRange(pos, pos)
    } catch {
      // Some input types do not support selection; nothing to restore.
    }
  }
  useLayoutEffect(apply)
  return (raw, significant, countBefore) => {
    const el = document.activeElement
    if (!(el instanceof HTMLInputElement) || el.selectionStart === null) return
    const test = new RegExp(significant.source)
    let sig = 0
    if (countBefore) sig = countBefore(raw, el.selectionStart)
    else for (const ch of raw.slice(0, el.selectionStart)) if (test.test(ch)) sig++
    caret.current = { el, sig, test }
    // Runs even when the formatted text is unchanged and React skips the render.
    requestAnimationFrame(apply)
  }
}
