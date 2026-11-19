import type { PubkeyHex } from '../../contracts'
import type { SheetBackPort, SheetHandle, SheetSlot } from '../../ui/sheet-back'

/**
 * The back button. This is the one file in src/
 * that calls pushState or replaceState (check-storage 30). It has no DOM: App passes
 * window.history and the popstate events, the checks pass a fake history.
 *
 * Opening a layer over the tabs (a room, the connect screen) adds one history entry and
 * the back button closes it. history.state holds only the kind of that layer,
 * `{ ilchonOverlay: 'room' | 'connect' }`: never a contact, a room id, a text or an
 * amount. Browsers keep history state on disk in plain text to restore tabs.
 * Which room is open lives in page memory (lastRoom) and in the encrypted memo.place
 * No URL is passed, so `?p=` stays as it is.
 *
 * Bottom sheets: while one or more sheets are open, one more
 * entry `{ ilchonOverlay: 'sheet' }` sits on top, and back closes the topmost sheet only
 * (a sheet that cannot be dismissed, or one under the connection cover, stays and gets its
 * entry back). A sheet closed any other way (its button, the backdrop, Escape) takes the
 * entry away with one back() whose popstate changes nothing. Only after the app has
 * started (the lock and opening screens have no entries). Not linked: dialogs and tab
 * changes.
 *
 * While the connection cover is up (setCovered), the
 * back button does not close the layer under it: the browser has already left its entry,
 * so the same `{ ilchonOverlay }` entry is pushed again and nothing on screen changes.
 * When the connection comes back, the user is where they were, and back closes it then.
 */

export type Tab = 'board' | 'contacts' | 'settings'
export const TABS: readonly Tab[] = ['board', 'contacts', 'settings']

/** Full-screen layer above the tabs. The tab underneath stays mounted. */
export type Overlay = { kind: 'connect' } | { kind: 'room'; contactId: PubkeyHex } | null
export type OverlayKind = 'room' | 'connect'

/**
 * The first-run words step: one entry while the new
 * key's 12 words (or the lock after them) are on screen, so the system back returns to
 * the start with the same words instead of leaving the app. Not a layer of App: markOf
 * does not return it, and the tabs' nav treats it as no layer.
 */
export type SetupKind = 'setup'

/** The open bottom sheets' one entry. Not a layer: markOf does not return it. */
export type SheetKind = 'sheet'

/** Everything this app ever puts in history.state: the kind and nothing else. */
export interface OverlayMark {
  readonly ilchonOverlay: OverlayKind | SetupKind | SheetKind
}

/**
 * Where I was: kept in the encrypted memo, never in history.state
 * or the URL. `at` is only written: it is read back with no time limit,
 * so whoever comes back after any auto-lock time finds the same room.
 */
export interface Place {
  tab: Tab
  room: PubkeyHex | null
  at: number
}

export function readPlace(v: unknown): Place | null {
  if (typeof v !== 'object' || v === null) return null
  const p = v as Record<string, unknown>
  if (!(TABS as readonly unknown[]).includes(p.tab)) return null
  const room = typeof p.room === 'string' && /^[0-9a-f]{64}$/.test(p.room) ? (p.room as PubkeyHex) : null
  return { tab: p.tab as Tab, room, at: typeof p.at === 'number' ? p.at : 0 }
}

/** The part of window.history this module uses. */
export interface HistoryPort {
  readonly state: unknown
  pushState(data: OverlayMark, unused: string): void
  replaceState(data: OverlayMark | null, unused: string): void
  back(): void
}

/** The kind of layer an entry is for, or null for anything else. */
export function markOf(state: unknown): OverlayKind | null {
  if (typeof state !== 'object' || state === null) return null
  const kind = (state as { ilchonOverlay?: unknown }).ilchonOverlay
  return kind === 'room' || kind === 'connect' ? kind : null
}

/** The first-run words entry (createSetupHistory). */
export function isSetupMark(state: unknown): boolean {
  return typeof state === 'object' && state !== null && (state as { ilchonOverlay?: unknown }).ilchonOverlay === 'setup'
}

/** The bottom sheets' entry. */
export function isSheetMark(state: unknown): boolean {
  return typeof state === 'object' && state !== null && (state as { ilchonOverlay?: unknown }).ilchonOverlay === 'sheet'
}

/** The only state this file writes: the kind and nothing else. */
const mark = (kind: OverlayKind | SetupKind | SheetKind): OverlayMark => ({ ilchonOverlay: kind })

/**
 * The first run's one history entry. SetupScreen calls enter() when
 * the new key's words show, leave() for the app bar's back on the words (the entry goes
 * with history.back(), whose popstate takes the screen to the start), and done() once the
 * key is made (the entry goes, so the first back on the board is not a dead press). The
 * popstate itself is read by SetupScreen with isSetupMark and setup-flow.ts setupPop.
 *
 * Across a reload: the entry may have been pushed by the page before it. The
 * entry under it then belongs to that old page, and history.back() would load the app
 * again from the start (after making the key the user would land on the unlock screen;
 * the app bar's back would lose the words). So back() is used only for an entry this page
 * pushed; one left by an earlier page is cleared in place with replaceState(null), and
 * enter() clears it the same way before pushing this page's own.
 */
export interface SetupHistory {
  enter(): void
  /** True when this page's entry was there and back() was called; the popstate moves the screen. */
  leave(): boolean
  done(): void
}

export function createSetupHistory(history: HistoryPort): SetupHistory {
  /** This page pushed a setup entry (entries it pushed stay its own until it unloads). */
  let pushed = false
  const leave = (): boolean => {
    if (!isSetupMark(history.state)) return false
    if (!pushed) {
      // An earlier page's entry: no back() across pages (that reloads the app).
      history.replaceState(null, '')
      return false
    }
    history.back()
    return true
  }
  return {
    enter() {
      if (isSetupMark(history.state) && pushed) return
      if (isSetupMark(history.state)) history.replaceState(null, '')
      history.pushState(mark('setup'), '')
      pushed = true
    },
    leave,
    done() {
      leave()
    },
  }
}

export interface OverlayNavDeps {
  /** The contact is in my list now. */
  hasContact(id: PubkeyHex): boolean
  /** Put this layer on screen (App's setOverlay). */
  show(overlay: Overlay): void
}

export interface OverlayNav extends SheetBackPort {
  /**
   * The first value, once, when boot first becomes ready: (1) a layer in
   * history.state (a reload or a re-lock in the same tab, at any age), (2) else
   * memo.place, (3) else nothing. Returns the tab of memo.place and the layer shown.
   */
  start(place: Place | null): { tab: Tab | null; overlay: Overlay }
  /** Open a room or the connect screen: one history entry (pushState, or replaceState over a layer's entry). */
  open(next: Exclude<Overlay, null>): void
  /** The close button: back() when the layer has an entry (popstate closes it), else close at once. */
  close(): void
  /** A popstate event (back or forward). Ignored before start: the boot and lock screens show no layer. */
  popState(state: unknown): void
  /** Contacts changed: a room on screen whose contact is gone closes. */
  contactsChanged(shown: Overlay): void
  /** The connection cover is up (true) or gone (false): while up, back keeps the layer underneath. */
  setCovered(covered: boolean): void
  /** A bottom sheet opened: the open sheets have one entry on top. */
  openSheet(slot: SheetSlot): SheetHandle
}

export function createOverlayNav(history: HistoryPort, deps: OverlayNavDeps): OverlayNav {
  let started = false
  /**
   * back() was called and its popstate has not come yet: do not call it again. 'layer':
   * a layer's entry goes (the popstate closes the layer). 'sheet': the sheets' entry goes
   * (the popstate changes nothing on screen).
   */
  let closing: 'layer' | 'sheet' | null = null
  /** The open sheets, topmost last. */
  const sheets: SheetSlot[] = []
  /** The current entry is this page's sheet entry. */
  let sheetEntry = false
  /** The layer whose entry is under the sheet entry, when it was pushed. */
  let under: OverlayKind | null = null
  /** Waits for the sheet entry's own popstate (a close or an open made meanwhile). */
  let afterSheet: (() => void) | null = null
  /** The room of this page's room entries (page memory only; a reload loses it). */
  let lastRoom: PubkeyHex | null = null
  /** The connection cover is up (setCovered). */
  let covered = false
  /** The layer last put on screen, to keep it while covered. */
  let shown: Overlay = null
  const show = (overlay: Overlay): void => {
    shown = overlay
    deps.show(overlay)
  }

  /**
   * The one rule for a room whose contact is not here: no
   * room opens, and the room's entry goes with one back(), so no empty entry is left for
   * the back button to stop at. The caller takes the room off the screen. Used by the
   * first value, popstate (back or forward onto the entry) and a removal while the room
   * is open.
   */
  function roomOrLeave(id: PubkeyHex | null): PubkeyHex | null {
    if (id !== null && deps.hasContact(id)) return id
    lastRoom = null
    // A sheet open in the room: its entry goes first, then the room's.
    if (leaveSheetEntryThen(() => roomOrLeave(null))) return null
    if (markOf(history.state) === 'room') back()
    return null
  }

  function back(): void {
    if (closing) return
    closing = 'layer'
    history.back()
  }

  /**
   * The sheet entry is on top (or its back() is on the way): take it away and run `then`
   * on its popstate, when the entry under it is current. False when there is none.
   */
  function leaveSheetEntryThen(then: () => void): boolean {
    if (sheetEntry && !closing) dropSheetEntry()
    if (closing !== 'sheet') return false
    afterSheet = then
    return true
  }

  function dropSheetEntry(): void {
    sheetEntry = false
    closing = 'sheet'
    history.back()
  }

  /** The one rule for sheets: an entry while any sheet is open, none when none is. */
  function syncSheets(): void {
    if (!started || closing) return
    if (sheets.length > 0 && !sheetEntry) {
      under = markOf(history.state)
      history.pushState(mark('sheet'), '')
      sheetEntry = true
    } else if (sheets.length === 0 && sheetEntry) dropSheetEntry()
  }

  function open(next: Exclude<Overlay, null>): void {
    if (closing === 'sheet') {
      afterSheet = () => open(next)
      return
    }
    if (sheetEntry && under === null) {
      // A sheet over a tab opens a layer (it closes itself): the layer takes the sheet's entry.
      sheetEntry = false
      history.replaceState(mark(next.kind), '')
    } else if (sheetEntry) {
      // Over a layer's entry: the sheet's entry goes first, then the layer is replaced as below.
      leaveSheetEntryThen(() => open(next))
      return
    } else if (markOf(history.state)) history.replaceState(mark(next.kind), '')
    else history.pushState(mark(next.kind), '')
    if (next.kind === 'room') lastRoom = next.contactId
    show(next)
  }

  function close(): void {
    // A sheet's button closes the layer under it: the sheet's entry goes first.
    if (leaveSheetEntryThen(close)) return
    if (markOf(history.state)) back()
    else show(null)
  }

  /** Back left the sheet entry (not a back() of ours). True when it was the sheets'. */
  function sheetBack(): boolean {
    if (!sheetEntry) return false
    sheetEntry = false
    const top = sheets[sheets.length - 1]
    if (!top) return true
    // Not to be dismissed, or under the connection cover: the sheet stays, so does its entry.
    if (!top.dismissible() || (covered && !top.aboveCover())) {
      history.pushState(mark('sheet'), '')
      sheetEntry = true
      return true
    }
    // Its owner closes it; when it goes, the next sheet (if any) gets the entry (syncSheets).
    top.onBack()
    return true
  }

  return {
    start(place) {
      if (started) return { tab: null, overlay: null }
      started = true
      const tab = place?.tab ?? null
      if (isSheetMark(history.state)) {
        // A sheet entry left by the page before a reload (sheets push only after start): no
        // sheet is open now. It is replaced in place, never left with back() (that loads the
        // app again): by the room of memo.place, as a reload with that room open would find
        // it, or by nothing.
        const room = place?.room && deps.hasContact(place.room) ? place.room : null
        const next: Exclude<Overlay, null> | null = room ? { kind: 'room', contactId: room } : null
        if (!next) {
          history.replaceState(null, '')
          return { tab, overlay: null }
        }
        history.replaceState(mark(next.kind), '')
        lastRoom = room
        show(next)
        return { tab, overlay: next }
      }
      const kind = markOf(history.state)
      if (kind === 'room') {
        // The entry was made when this room opened, and memo.place got the same room then.
        const id = roomOrLeave(place?.room ?? null)
        if (!id) return { tab, overlay: null }
        lastRoom = id
        const overlay: Overlay = { kind: 'room', contactId: id }
        show(overlay)
        return { tab, overlay }
      }
      if (kind === 'connect') {
        const overlay: Overlay = { kind: 'connect' }
        show(overlay)
        return { tab, overlay }
      }
      if (place?.room && deps.hasContact(place.room)) {
        const overlay: Overlay = { kind: 'room', contactId: place.room }
        open(overlay)
        return { tab, overlay }
      }
      return { tab, overlay: null }
    },

    open,

    close,

    popState(state) {
      const ours = closing
      closing = null
      if (!started) return
      if (ours === 'sheet') {
        // Our own back() off the sheet entry: nothing on screen changes.
        const then = afterSheet
        afterSheet = null
        then?.()
        syncSheets()
        return
      }
      if (!ours && sheetBack()) return
      if (!ours && isSheetMark(state)) {
        // Forward onto a sheet entry of this page with no sheet open: step back over it.
        if (sheets.length > 0) sheetEntry = true
        else dropSheetEntry()
        return
      }
      // Back under the connection cover (not a back() of ours, which the gone-contact rule
      // makes after it took the room off the screen): the layer stays and gets its entry back.
      if (covered && !ours && shown !== null) {
        if (markOf(state) !== shown.kind) history.pushState(mark(shown.kind), '')
        return
      }
      const kind = markOf(state)
      if (kind === 'connect') show({ kind: 'connect' })
      else if (kind === 'room') {
        const id = roomOrLeave(lastRoom)
        show(id ? { kind: 'room', contactId: id } : null)
      } else show(null)
    },

    contactsChanged(shown) {
      if (!started || shown?.kind !== 'room' || deps.hasContact(shown.contactId)) return
      // Off the screen at once (nothing of the contact stays drawn), then the one rule.
      show(null)
      roomOrLeave(shown.contactId)
    },

    setCovered(on) {
      covered = on
    },

    openSheet(slot) {
      sheets.push(slot)
      syncSheets()
      let gone = false
      return {
        close() {
          if (gone) return
          gone = true
          const at = sheets.indexOf(slot)
          if (at >= 0) sheets.splice(at, 1)
          syncSheets()
        },
        restore() {
          if (!gone) syncSheets()
        },
      }
    },
  }
}
