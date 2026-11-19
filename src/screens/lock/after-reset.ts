/**
 * Where the first screen opens after a reset that asked for it (the stop screen shown
 * when the same words were restored on another device resets, and the reload lands on
 * "Restore with 12 words", not on the start step). The mark is the address's fragment `#restore`, set right before the reset
 * (the reset's reload keeps it): no browser storage (check-storage 28) and no history
 * call (check-storage 30). It names a screen only, never a key, word, contact or room.
 *
 * The page reads the mark once when it loads and removes it at once, so a later reset
 * that did not ask for it (Settings, the unlock screen, the other boot screens) opens on
 * the start step. Setting and removing both go through
 * `location.replace` with a fragment only: a same-page fragment change that replaces the
 * current history entry instead of adding one, with no reload and no pushState or
 * replaceState (check-storage 30 allows those only in the overlay helper, with no URL).
 * Removing leaves an empty `#` at the end of the address.
 */
const MARK = 'restore'

/** The part of `location` the mark uses (a fake one in check-storage). */
export interface MarkLocation {
  readonly hash: string
  replace(url: string): void
}

function here(): MarkLocation | undefined {
  return typeof location === 'undefined' ? undefined : location
}

/** Sets the mark on `loc` without a new history entry. */
export function setRestoreMark(loc: MarkLocation | undefined = here()): void {
  try {
    loc?.replace(`#${MARK}`)
  } catch {
    // The start step then; "Restore with 12 words" is one tap away.
  }
}

/** Removes the mark from `loc`, if it is there, without a new history entry. */
export function clearRestoreMark(loc: MarkLocation | undefined = here()): void {
  try {
    if (loc?.hash === `#${MARK}`) loc.replace('#')
  } catch {
    // Nothing more to do: the next load reads and removes it.
  }
}

/** Whether `loc` carries the mark; it is removed right away. */
export function takeRestoreMark(loc: MarkLocation | undefined = here()): boolean {
  let marked = false
  try {
    marked = loc?.hash === `#${MARK}`
  } catch {
    return false
  }
  if (marked) clearRestoreMark(loc)
  return marked
}

/** The stop screen's reset asks the reload for the restore screen. */
export function openRestoreAfterReset(): void {
  setRestoreMark()
}

/** Read and removed once, when this module loads with the page. */
const taken = takeRestoreMark()

/** True when this page was loaded by such a reset (the same answer for every render). */
export function restoreAfterReset(): boolean {
  return taken
}
