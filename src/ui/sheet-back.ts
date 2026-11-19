import { useEffect, useRef } from 'react'

/**
 * The back button closes an open bottom sheet. BottomSheet calls
 * useSheetBack; the history side is overlay-history.ts (the one file that calls pushState),
 * which App hands in with setSheetBack. Without a port (before App runs, or in a check
 * that renders a sheet alone) a sheet works as before and has no history entry.
 */

/** One open sheet, as the history side sees it. Read on every back, so always current. */
export interface SheetSlot {
  /** The back button left this sheet's entry: close the sheet (its onClose). */
  onBack(): void
  /** false: back keeps the sheet (and its entry) instead of closing it. */
  dismissible(): boolean
  /** The sheet stays above the connection cover, so back closes it while covered. */
  aboveCover(): boolean
}

export interface SheetHandle {
  /** The sheet is gone (any way but the back button): its entry goes if it was the last. */
  close(): void
  /** onBack did not close the sheet after all: give it its entry back. */
  restore(): void
}

export interface SheetBackPort {
  openSheet(slot: SheetSlot): SheetHandle
}

let port: SheetBackPort | null = null

/** App sets the page's overlay nav once (null takes it away). */
export function setSheetBack(next: SheetBackPort | null): void {
  port = next
}

/** How long onBack gets to close the sheet before its entry comes back (a refused close). */
const RESTORE_MS = 150

export function useSheetBack(open: boolean, onClose: () => void, dismissible: boolean, aboveCover: boolean): void {
  const live = useRef({ onClose, dismissible, aboveCover })
  live.current = { onClose, dismissible, aboveCover }
  useEffect(() => {
    if (!open || !port) return
    let timer: ReturnType<typeof setTimeout> | undefined
    const handle = port.openSheet({
      onBack() {
        live.current.onClose()
        // The owner may refuse (a busy guard in onClose): the sheet is still here then.
        clearTimeout(timer)
        timer = setTimeout(() => handle.restore(), RESTORE_MS)
      },
      dismissible: () => live.current.dismissible,
      aboveCover: () => live.current.aboveCover,
    })
    return () => {
      clearTimeout(timer)
      handle.close()
    }
  }, [open])
}
