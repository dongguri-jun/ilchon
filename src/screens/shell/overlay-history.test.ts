import assert from 'node:assert/strict'
import { test } from 'node:test'
import type { PubkeyHex } from '../../contracts'
import { createOverlayNav, createSetupHistory, isSetupMark, isSheetMark, markOf, readPlace, type HistoryPort, type Overlay, type OverlayNav, type Place } from './overlay-history'
import type { SheetHandle } from '../../ui/sheet-back'

// The back button as a state machine, on a fake history that
// behaves like a browser tab: one list of entries, back() and forward() move in it and
// queue a popstate, which the test delivers with flush(). A reload or an auto-lock
// (location.reload) keeps the entries and makes a new page: a new nav, lastRoom gone.

const A = 'a'.repeat(64) as PubkeyHex
const B = 'b'.repeat(64) as PubkeyHex

class FakeTab implements HistoryPort {
  entries: unknown[] = [null]
  /**
   * Which page (document) each entry belongs to. A reload gives the current
   * entry a new page; a back or forward onto an entry of another page is a full load of the
   * app, not a popstate (counted in `loads`).
   */
  docs: number[] = [0]
  doc = 0
  loads = 0
  at = 0
  /** back() at the first entry: the browser leaves the app. */
  left = false
  pending: unknown[] = []
  backCalls = 0
  writes: unknown[] = []
  get state(): unknown {
    return this.entries[this.at]
  }
  pushState(data: unknown): void {
    this.writes.push(data)
    this.entries.splice(this.at + 1)
    this.docs.splice(this.at + 1)
    this.entries.push(structuredClone(data))
    this.docs.push(this.doc)
    this.at++
  }
  replaceState(data: unknown): void {
    this.writes.push(data)
    this.entries[this.at] = structuredClone(data)
  }
  back(): void {
    this.backCalls++
    this.press('back')
  }
  /** The system back or forward button (also what history.back() does). */
  press(dir: 'back' | 'forward'): void {
    if (dir === 'back' && this.at === 0) {
      this.left = true
      return
    }
    if (dir === 'forward' && this.at === this.entries.length - 1) return
    this.at += dir === 'back' ? -1 : 1
    if (this.docs[this.at] !== this.doc) {
      // Another page's entry: the browser loads the app again, nothing is queued.
      this.loads++
      this.reload()
      return
    }
    this.pending.push(this.state)
  }
  /** A reload (or auto-lock): the entries stay, the current one now belongs to a new page. */
  reload(): void {
    this.doc++
    this.docs[this.at] = this.doc
    this.pending = []
  }
}

interface Page {
  tab: FakeTab
  nav: OverlayNav
  shown(): Overlay
  shows: Overlay[]
}

function page(tab: FakeTab, contacts: Set<string>): Page {
  const shows: Overlay[] = []
  const nav = createOverlayNav(tab, { hasContact: (id) => contacts.has(id), show: (o) => shows.push(o) })
  return { tab, nav, shows, shown: () => (shows.length ? shows[shows.length - 1]! : null) }
}

/** Deliver the queued popstate events, as the browser does after back() or forward(). */
function flush(p: Page): void {
  while (p.tab.pending.length) p.nav.popState(p.tab.pending.shift())
}

function place(room: PubkeyHex | null, tab: Place['tab'] = 'board'): Place {
  return { tab, room, at: 1 }
}

test('markOf takes only the two kinds', () => {
  assert.equal(markOf({ ilchonOverlay: 'room' }), 'room')
  assert.equal(markOf({ ilchonOverlay: 'connect' }), 'connect')
  for (const bad of [null, undefined, 'room', 7, {}, { ilchonOverlay: 'sheet' }, { ilchonOverlay: { kind: 'room' } }, { kind: 'room' }]) {
    assert.equal(markOf(bad), null)
  }
})

test('readPlace keeps a valid tab and a 64-hex room only', () => {
  assert.deepEqual(readPlace({ tab: 'contacts', room: A, at: 5 }), { tab: 'contacts', room: A, at: 5 })
  assert.deepEqual(readPlace({ tab: 'board', room: 'xyz' }), { tab: 'board', room: null, at: 0 })
  assert.equal(readPlace({ tab: 'nowhere', room: A }), null)
  assert.equal(readPlace(null), null)
})

test('back closes the open room, then the connect screen, and only then leaves the app', () => {
  const p = page(new FakeTab(), new Set([A]))
  p.nav.start(null)
  p.nav.open({ kind: 'room', contactId: A })
  assert.deepEqual(p.tab.state, { ilchonOverlay: 'room' })
  assert.deepEqual(p.shown(), { kind: 'room', contactId: A })
  p.tab.press('back')
  flush(p)
  assert.equal(p.shown(), null)
  assert.equal(p.tab.left, false)
  p.nav.open({ kind: 'connect' })
  assert.deepEqual(p.tab.state, { ilchonOverlay: 'connect' })
  p.tab.press('back')
  flush(p)
  assert.equal(p.shown(), null)
  assert.equal(p.tab.left, false)
  // No layer: back leaves the app.
  p.tab.press('back')
  assert.equal(p.tab.left, true)
})

test('the close button goes back once, however fast it is pressed', () => {
  const p = page(new FakeTab(), new Set([A]))
  p.nav.start(null)
  p.nav.open({ kind: 'room', contactId: A })
  p.nav.close()
  p.nav.close()
  p.nav.close()
  assert.equal(p.tab.backCalls, 1)
  flush(p)
  assert.equal(p.shown(), null)
  assert.equal(p.tab.left, false)
  assert.equal(p.tab.at, 0)
  // After its popstate the button works again.
  p.nav.open({ kind: 'room', contactId: A })
  p.nav.close()
  flush(p)
  assert.equal(p.tab.backCalls, 2)
  assert.equal(p.tab.left, false)
})

test('a layer without an entry closes at once (nothing to go back to)', () => {
  const tab = new FakeTab()
  const p = page(tab, new Set([A]))
  p.nav.start(null)
  p.nav.open({ kind: 'room', contactId: A })
  // Something else emptied the entry (as the gone-contact rule does).
  tab.replaceState(null)
  p.nav.close()
  assert.equal(tab.backCalls, 0)
  assert.equal(p.shown(), null)
})

test('a reload or an auto-lock with a room open brings the same room back, with no new entry', () => {
  const tab = new FakeTab()
  const contacts = new Set([A, B])
  const p1 = page(tab, contacts)
  p1.nav.start(null)
  p1.nav.open({ kind: 'room', contactId: B })
  const length = tab.entries.length
  // location.reload(): the entries stay, the page is new. memo.place has the room.
  const p2 = page(tab, contacts)
  // Before the unlock (lock screen, opening screen) a back press shows nothing.
  const first = p2.nav.start(place(B, 'contacts'))
  assert.deepEqual(first, { tab: 'contacts', overlay: { kind: 'room', contactId: B } })
  assert.deepEqual(p2.shown(), { kind: 'room', contactId: B })
  assert.equal(tab.entries.length, length)
  p2.tab.press('back')
  flush(p2)
  assert.equal(p2.shown(), null)
  assert.equal(tab.left, false)
  p2.tab.press('back')
  assert.equal(tab.left, true)
})

test('back on the lock or opening screen shows nothing and cannot open a room past the lock', () => {
  const tab = new FakeTab()
  const contacts = new Set([A])
  const p1 = page(tab, contacts)
  p1.nav.start(null)
  p1.nav.open({ kind: 'room', contactId: A })
  // Re-lock: a new page, still locked (start not called yet).
  const p2 = page(tab, contacts)
  tab.press('back')
  flush(p2)
  tab.press('forward')
  flush(p2)
  assert.deepEqual(p2.shows, [])
  // Unlocked: the entry under is the room entry again (forward), memo.place names the room.
  p2.nav.start(place(A))
  assert.deepEqual(p2.shown(), { kind: 'room', contactId: A })
  assert.equal(tab.left, false)
})

test('the lock screen back that went past the room entry: the unlock opens the room from memo.place with one entry', () => {
  const tab = new FakeTab()
  const contacts = new Set([A])
  const p1 = page(tab, contacts)
  p1.nav.start(null)
  p1.nav.open({ kind: 'room', contactId: A })
  const p2 = page(tab, contacts)
  tab.press('back')
  flush(p2)
  assert.equal(tab.state, null)
  p2.nav.start(place(A))
  assert.deepEqual(p2.shown(), { kind: 'room', contactId: A })
  assert.deepEqual(tab.state, { ilchonOverlay: 'room' })
  tab.press('back')
  flush(p2)
  assert.equal(p2.shown(), null)
  assert.equal(tab.left, false)
})

test('a reload over a room entry whose contact is gone, or with no room in memo.place, opens nothing and leaves the entry', () => {
  for (const [contacts, memoPlace] of [
    [new Set<string>(), place(A)],
    [new Set<string>([A]), place(null)],
    [new Set<string>([A]), null],
  ] as const) {
    const tab = new FakeTab()
    const p1 = page(tab, new Set([A]))
    p1.nav.start(null)
    p1.nav.open({ kind: 'room', contactId: A })
    const p2 = page(tab, new Set(contacts))
    const first = p2.nav.start(memoPlace)
    assert.equal(first.overlay, null)
    assert.deepEqual(p2.shows, [])
    // One back() over the room entry: no empty entry is left to stop at.
    assert.equal(tab.state, null)
    assert.equal(tab.at, 0)
    flush(p2)
    assert.equal(p2.shown(), null)
    assert.equal(tab.left, false)
    tab.press('back')
    assert.equal(tab.left, true)
  }
})

test('a reload with the connect screen open opens it again', () => {
  const tab = new FakeTab()
  const p1 = page(tab, new Set())
  p1.nav.start(null)
  p1.nav.open({ kind: 'connect' })
  const p2 = page(tab, new Set())
  assert.deepEqual(p2.nav.start(place(null, 'contacts')), { tab: 'contacts', overlay: { kind: 'connect' } })
  tab.press('back')
  flush(p2)
  assert.equal(p2.shown(), null)
  assert.equal(tab.left, false)
})

test('a fresh tab with memo.place opens the room with one entry, so back closes it', () => {
  const tab = new FakeTab()
  const p = page(tab, new Set([A]))
  assert.deepEqual(p.nav.start(place(A, 'contacts')), { tab: 'contacts', overlay: { kind: 'room', contactId: A } })
  assert.equal(tab.entries.length, 2)
  tab.press('back')
  flush(p)
  assert.equal(p.shown(), null)
  assert.equal(tab.left, false)
  // The first value runs once.
  assert.deepEqual(p.nav.start(place(A)), { tab: null, overlay: null })
})

test('forward reopens the room of this page; after a reload it goes back over the entry instead', () => {
  const tab = new FakeTab()
  const contacts = new Set([A])
  const p1 = page(tab, contacts)
  p1.nav.start(null)
  p1.nav.open({ kind: 'room', contactId: A })
  tab.press('back')
  flush(p1)
  tab.press('forward')
  flush(p1)
  assert.deepEqual(p1.shown(), { kind: 'room', contactId: A })
  tab.press('back')
  flush(p1)
  const p2 = page(tab, contacts)
  p2.nav.start(null)
  tab.press('forward')
  flush(p2)
  assert.equal(p2.shown(), null)
  assert.equal(tab.state, null)
  assert.equal(tab.at, 0)
  assert.equal(tab.left, false)
})

test('forward to a room whose contact was removed meanwhile goes back over the entry', () => {
  const tab = new FakeTab()
  const contacts = new Set([A])
  const p = page(tab, contacts)
  p.nav.start(null)
  p.nav.open({ kind: 'room', contactId: A })
  tab.press('back')
  flush(p)
  contacts.delete(A)
  tab.press('forward')
  flush(p)
  assert.equal(p.shown(), null)
  assert.equal(tab.state, null)
  assert.equal(tab.at, 0)
  // The next back leaves (no empty entry in between).
  tab.press('back')
  assert.equal(tab.left, true)
})

test('a contact removed while its room is open: the room closes at once, its entry goes, the app stays', () => {
  const tab = new FakeTab()
  const contacts = new Set([A, B])
  const p = page(tab, contacts)
  p.nav.start(null)
  p.nav.open({ kind: 'room', contactId: A })
  p.nav.contactsChanged({ kind: 'room', contactId: A })
  assert.deepEqual(p.shown(), { kind: 'room', contactId: A })
  contacts.delete(A)
  p.nav.contactsChanged({ kind: 'room', contactId: A })
  assert.equal(p.shown(), null)
  flush(p)
  assert.equal(p.shown(), null)
  assert.equal(tab.at, 0)
  assert.equal(tab.left, false)
  // The next back leaves (no empty entry left in between).
  tab.press('back')
  assert.equal(tab.left, true)
})

test('history only ever holds the kind: no contact, room or other field', () => {
  const tab = new FakeTab()
  const contacts = new Set([A, B])
  let p = page(tab, contacts)
  p.nav.start(place(A))
  p.nav.close()
  flush(p)
  p.nav.open({ kind: 'connect' })
  p.nav.close()
  flush(p)
  p.nav.open({ kind: 'room', contactId: B })
  p = page(tab, contacts)
  p.nav.start(place(B))
  contacts.delete(B)
  p.nav.contactsChanged({ kind: 'room', contactId: B })
  flush(p)
  tab.press('forward')
  flush(p)
  // Three layers opened; a gone room's entry is left with back(), never written over.
  assert.ok(tab.writes.length >= 3)
  for (const w of tab.writes) {
    if (w === null) continue
    assert.deepEqual(Object.keys(w as object), ['ilchonOverlay'])
    assert.ok(markOf(w))
  }
  const all = JSON.stringify([tab.writes, tab.entries])
  assert.ok(!all.includes(A.slice(0, 16)) && !all.includes(B.slice(0, 16)), all)
})

test("the connect screen's 'already' phase closes like any connect phase: close, back, reload, lock", () => {
  // The phase lives inside ConnectScreen; the helper sees one connect layer whatever it shows.
  // (1) Its close button: one back(), no entry left, the next back leaves the app.
  const tab = new FakeTab()
  const contacts = new Set([A])
  const p = page(tab, contacts)
  p.nav.start(null)
  p.nav.open({ kind: 'connect' })
  assert.equal(tab.entries.length, 2)
  p.nav.close()
  p.nav.close()
  assert.equal(tab.backCalls, 1)
  flush(p)
  assert.equal(p.shown(), null)
  assert.equal(tab.at, 0)
  tab.press('back')
  assert.equal(tab.left, true)
  // (2) The phone's back button.
  const tab2 = new FakeTab()
  const q = page(tab2, contacts)
  q.nav.start(null)
  q.nav.open({ kind: 'connect' })
  tab2.press('back')
  flush(q)
  assert.equal(q.shown(), null)
  assert.equal(tab2.at, 0)
  assert.equal(tab2.left, false)
  // (3) A reload while it is shown: the connect screen again (a new code), on the same entry.
  q.nav.open({ kind: 'connect' })
  const length = tab2.entries.length
  const q2 = page(tab2, contacts)
  assert.deepEqual(q2.nav.start(place(null, 'contacts')), { tab: 'contacts', overlay: { kind: 'connect' } })
  assert.equal(tab2.entries.length, length)
  // (4) A re-lock while it is shown: back and forward on the lock screen open nothing; the
  // unlock opens the connect screen, never a room.
  const q3 = page(tab2, contacts)
  tab2.press('back')
  flush(q3)
  tab2.press('forward')
  flush(q3)
  assert.deepEqual(q3.shows, [])
  assert.deepEqual(q3.nav.start(place(A)), { tab: 'board', overlay: { kind: 'connect' } })
  tab2.press('back')
  flush(q3)
  assert.equal(q3.shown(), null)
  assert.equal(tab2.at, 0)
  assert.equal(tab2.left, false)
})

test('back under the connection cover keeps the room and its entry; after the cover, back closes it', () => {
  const tab = new FakeTab()
  const contacts = new Set([A])
  const p = page(tab, contacts)
  p.nav.start(null)
  p.nav.open({ kind: 'room', contactId: A })
  p.nav.setCovered(true)
  const showsBefore = p.shows.length
  // Two presses while the cover is up: the room stays on screen and its entry comes back.
  for (let i = 0; i < 2; i++) {
    tab.press('back')
    flush(p)
    assert.equal(p.shows.length, showsBefore, 'nothing changes on screen under the cover')
    assert.deepEqual(tab.state, { ilchonOverlay: 'room' })
    assert.equal(tab.left, false)
  }
  assert.equal(tab.entries.length, 2, 'no extra entries pile up')
  // The connection is back: the same room is there and back closes it, then leaves.
  p.nav.setCovered(false)
  assert.deepEqual(p.shown(), { kind: 'room', contactId: A })
  tab.press('back')
  flush(p)
  assert.equal(p.shown(), null)
  assert.equal(tab.left, false)
  tab.press('back')
  assert.equal(tab.left, true)
})

test('the connect screen under the cover is kept the same way; with no layer, back is not held', () => {
  const tab = new FakeTab()
  const p = page(tab, new Set([A]))
  p.nav.start(null)
  p.nav.open({ kind: 'connect' })
  p.nav.setCovered(true)
  tab.press('back')
  flush(p)
  assert.deepEqual(p.shown(), { kind: 'connect' })
  assert.deepEqual(tab.state, { ilchonOverlay: 'connect' })
  p.nav.setCovered(false)
  p.nav.close()
  flush(p)
  assert.equal(p.shown(), null)
  // No layer under the cover: back leaves the app as it always does.
  p.nav.setCovered(true)
  tab.press('back')
  assert.equal(tab.left, true)
})

test('a contact removed under the cover still closes its room and leaves its entry once', () => {
  const tab = new FakeTab()
  const contacts = new Set([A])
  const p = page(tab, contacts)
  p.nav.start(null)
  p.nav.open({ kind: 'room', contactId: A })
  p.nav.setCovered(true)
  contacts.delete(A)
  p.nav.contactsChanged({ kind: 'room', contactId: A })
  flush(p)
  assert.equal(p.shown(), null)
  assert.equal(tab.at, 0)
  assert.equal(tab.backCalls, 1)
  assert.equal(tab.entries.length, 2, 'our own back() is not undone by the cover rule')
  assert.equal(markOf(tab.state), null)
})

// The first run's words entry across a reload. The words step pushed its entry,
// then the page reloaded on it: the entry under it is the old page's, so history.back()
// would load the app again (after making the key: the unlock screen; app-bar back: the
// words lost). The new page clears that entry in place and never calls back() across pages.

test('setup entry on the same page: enter, leave with back(), the popstate comes, no load', () => {
  const tab = new FakeTab()
  const sh = createSetupHistory(tab)
  sh.enter()
  sh.enter()
  assert.equal(tab.entries.length, 2, 'one entry for the words')
  assert.equal(sh.leave(), true)
  assert.equal(tab.backCalls, 1)
  assert.deepEqual(tab.pending, [null], 'a popstate to the start comes')
  assert.equal(tab.loads, 0)
  // In again, forward and back by the system button, then the key is made.
  tab.pending = []
  sh.enter()
  tab.press('back')
  tab.press('forward')
  assert.equal(tab.loads, 0)
  assert.ok(isSetupMark(tab.state))
  sh.done()
  assert.equal(tab.loads, 0, 'done() on this page goes back without a load')
  assert.equal(isSetupMark(tab.state), false)
})

test('setup entry left by the page before a reload: done() clears it in place, no load', () => {
  const tab = new FakeTab()
  createSetupHistory(tab).enter()
  tab.reload()
  const sh = createSetupHistory(tab)
  assert.ok(isSetupMark(tab.state))
  sh.done()
  assert.equal(tab.backCalls, 0, 'no back() across pages')
  assert.equal(tab.loads, 0, 'the app is not loaded again after the key is made')
  assert.equal(tab.state, null)
})

test("setup entry left by the page before a reload: the app bar's back keeps the screen's own step", () => {
  const tab = new FakeTab()
  createSetupHistory(tab).enter()
  tab.reload()
  const sh = createSetupHistory(tab)
  assert.equal(sh.leave(), false, 'the caller goes back itself (the words stay in this page)')
  assert.equal(tab.backCalls, 0)
  assert.equal(tab.loads, 0)
  assert.equal(tab.state, null)
})

test('enter() after a reload on the old entry pushes this page its own; the system back is a popstate', () => {
  const tab = new FakeTab()
  createSetupHistory(tab).enter()
  tab.reload()
  const sh = createSetupHistory(tab)
  sh.enter()
  assert.ok(isSetupMark(tab.state))
  assert.equal(tab.entries.filter(isSetupMark).length, 1, 'the old entry was cleared, only this page has one')
  tab.press('back')
  assert.equal(tab.loads, 0, 'back from the words stays in this page')
  assert.deepEqual(tab.pending, [null])
  tab.pending = []
  tab.press('forward')
  sh.done()
  assert.equal(tab.loads, 0)
  assert.equal(isSetupMark(tab.state), false)
})

// ---- Bottom sheets ----
// A sheet as BottomSheet drives it: openSheet when it opens, handle.close() when it goes
// (any way), onBack calls the owner's onClose. The owner's state change and the effect
// that calls close() come after the popstate, so the tests call close() themselves.

interface FakeSheet {
  handle: SheetHandle
  backs: number
  dismissible: boolean
}

function sheet(p: Page, opts: { dismissible?: boolean; aboveCover?: boolean } = {}): FakeSheet {
  const s: FakeSheet = { handle: null as unknown as SheetHandle, backs: 0, dismissible: opts.dismissible ?? true }
  s.handle = p.nav.openSheet({
    onBack: () => {
      s.backs++
    },
    dismissible: () => s.dismissible,
    aboveCover: () => !!opts.aboveCover,
  })
  return s
}

const SHEET = { ilchonOverlay: 'sheet' }
const ROOM = { ilchonOverlay: 'room' }

test('a sheet over a tab: back closes only the sheet, the app stays; the next back leaves', () => {
  const p = page(new FakeTab(), new Set([A]))
  p.nav.start(null)
  const s = sheet(p)
  assert.deepEqual(p.tab.state, SHEET)
  p.tab.press('back')
  flush(p)
  assert.equal(s.backs, 1, 'the sheet was asked to close')
  assert.equal(p.tab.left, false)
  s.handle.close()
  assert.equal(p.tab.backCalls, 0, 'the entry is already gone: no back() of ours')
  assert.equal(p.tab.state, null)
  p.tab.press('back')
  assert.equal(p.tab.left, true)
})

test('a sheet over a room: back closes the sheet, a second back the room, a third leaves', () => {
  const p = page(new FakeTab(), new Set([A]))
  p.nav.start(null)
  p.nav.open({ kind: 'room', contactId: A })
  const s = sheet(p)
  assert.deepEqual(p.tab.entries, [null, ROOM, SHEET])
  const showsBefore = p.shows.length
  p.tab.press('back')
  flush(p)
  s.handle.close()
  assert.equal(s.backs, 1)
  assert.equal(p.shows.length, showsBefore, 'the room is not touched')
  assert.deepEqual(p.tab.state, ROOM)
  p.tab.press('back')
  flush(p)
  assert.equal(p.shown(), null)
  assert.equal(p.tab.left, false)
  p.tab.press('back')
  assert.equal(p.tab.left, true)
})

test('a sheet over the connect screen closes first in the same way', () => {
  const p = page(new FakeTab(), new Set([A]))
  p.nav.start(null)
  p.nav.open({ kind: 'connect' })
  const s = sheet(p)
  p.tab.press('back')
  flush(p)
  s.handle.close()
  assert.deepEqual(p.shown(), { kind: 'connect' })
  p.tab.press('back')
  flush(p)
  assert.equal(p.shown(), null)
  assert.equal(p.tab.left, false)
})

test('a sheet closed by its button, the backdrop or Escape takes its entry with it and nothing else', () => {
  const p = page(new FakeTab(), new Set([A]))
  p.nav.start(null)
  p.nav.open({ kind: 'room', contactId: A })
  const s = sheet(p)
  const showsBefore = p.shows.length
  s.handle.close()
  s.handle.close()
  assert.equal(p.tab.backCalls, 1, 'one back(), however often close() is called')
  flush(p)
  assert.equal(p.shows.length, showsBefore, 'the popstate of that back() changes nothing on screen')
  assert.deepEqual(p.tab.state, ROOM)
  assert.equal(s.backs, 0)
  // No dead press: back closes the room at once, then leaves.
  p.tab.press('back')
  flush(p)
  assert.equal(p.shown(), null)
  p.tab.press('back')
  assert.equal(p.tab.left, true)
})

test('a sheet that opens another: back closes the top one, then the one under it', () => {
  const p = page(new FakeTab(), new Set([A]))
  p.nav.start(null)
  p.nav.open({ kind: 'room', contactId: A })
  const s1 = sheet(p)
  const s2 = sheet(p)
  assert.deepEqual(p.tab.entries, [null, ROOM, SHEET], 'one entry for all the open sheets')
  p.tab.press('back')
  flush(p)
  assert.deepEqual([s1.backs, s2.backs], [0, 1], 'only the top sheet closes')
  s2.handle.close()
  assert.deepEqual(p.tab.entries, [null, ROOM, SHEET], 'the sheet left open gets the entry back')
  p.tab.press('back')
  flush(p)
  assert.deepEqual([s1.backs, s2.backs], [1, 1])
  s1.handle.close()
  assert.deepEqual(p.tab.state, ROOM)
  assert.deepEqual(p.shown(), { kind: 'room', contactId: A })
  p.tab.press('back')
  flush(p)
  assert.equal(p.shown(), null)
  assert.equal(p.tab.left, false)
})

test('a sheet that closes and opens the next in one go keeps one entry (also a double effect run)', () => {
  const p = page(new FakeTab(), new Set([A]))
  p.nav.start(null)
  const s1 = sheet(p)
  s1.handle.close()
  const s2 = sheet(p)
  flush(p)
  assert.deepEqual(p.tab.entries, [null, SHEET])
  p.tab.press('back')
  flush(p)
  assert.equal(s2.backs, 1)
  s2.handle.close()
  assert.equal(p.tab.state, null)
  p.tab.press('back')
  assert.equal(p.tab.left, true)
})

test('a sheet over a tab that opens a room (and closes): the room takes the entry, back closes it', () => {
  const p = page(new FakeTab(), new Set([A]))
  p.nav.start(null)
  const s = sheet(p)
  // The button's handler: the sheet's onClose and openRoom, then the sheet's effect cleanup.
  p.nav.open({ kind: 'room', contactId: A })
  assert.deepEqual(p.shown(), { kind: 'room', contactId: A }, 'the room shows at once')
  assert.deepEqual(p.tab.entries, [null, ROOM], 'it took the sheet entry in place')
  s.handle.close()
  assert.equal(p.tab.backCalls, 0, 'no back() was needed')
  flush(p)
  assert.deepEqual(p.tab.entries, [null, ROOM])
  assert.deepEqual(p.shown(), { kind: 'room', contactId: A })
  p.tab.press('back')
  flush(p)
  assert.equal(p.shown(), null)
  p.tab.press('back')
  assert.equal(p.tab.left, true)
})

test('a sheet in a room that leaves the room: both entries go, the app stays, back leaves next', () => {
  const p = page(new FakeTab(), new Set([A]))
  p.nav.start(null)
  p.nav.open({ kind: 'room', contactId: A })
  const s = sheet(p)
  p.nav.close()
  p.nav.close()
  s.handle.close()
  flush(p)
  assert.equal(p.shown(), null)
  assert.equal(p.tab.state, null)
  assert.equal(p.tab.backCalls, 2, 'one back() for the sheet entry, one for the room entry')
  assert.equal(p.tab.left, false)
  p.tab.press('back')
  assert.equal(p.tab.left, true)
})

test('a sheet in a room that opens the connect screen: it replaces the room, as from the room itself', () => {
  const p = page(new FakeTab(), new Set([A]))
  p.nav.start(null)
  p.nav.open({ kind: 'room', contactId: A })
  const s = sheet(p)
  p.nav.open({ kind: 'connect' })
  s.handle.close()
  flush(p)
  assert.deepEqual(p.shown(), { kind: 'connect' })
  assert.deepEqual(p.tab.entries.slice(0, p.tab.at + 1), [null, { ilchonOverlay: 'connect' }])
  p.tab.press('back')
  flush(p)
  assert.equal(p.shown(), null)
  p.tab.press('back')
  assert.equal(p.tab.left, true)
})

test('a sheet that cannot be dismissed stays on back, and back never leaves the app', () => {
  const p = page(new FakeTab(), new Set([A]))
  p.nav.start(null)
  const s = sheet(p, { dismissible: false })
  for (let i = 0; i < 3; i++) {
    p.tab.press('back')
    flush(p)
    assert.equal(s.backs, 0)
    assert.deepEqual(p.tab.state, SHEET)
    assert.equal(p.tab.left, false)
  }
  assert.equal(p.tab.entries.length, 2, 'no entries pile up')
  // Dismissible again (busy is over): back closes it.
  s.dismissible = true
  p.tab.press('back')
  flush(p)
  assert.equal(s.backs, 1)
})

test('an owner that refuses the close gets its entry back (restore)', () => {
  const p = page(new FakeTab(), new Set([A]))
  p.nav.start(null)
  p.nav.open({ kind: 'room', contactId: A })
  const s = sheet(p)
  p.tab.press('back')
  flush(p)
  assert.equal(s.backs, 1)
  s.handle.restore()
  assert.deepEqual(p.tab.state, SHEET)
  p.tab.press('back')
  flush(p)
  s.handle.close()
  s.handle.restore()
  assert.deepEqual(p.tab.state, ROOM, 'a closed sheet is not restored')
  assert.deepEqual(p.shown(), { kind: 'room', contactId: A })
})

test('under the connection cover a sheet stays on back; one above the cover closes', () => {
  const p = page(new FakeTab(), new Set([A]))
  p.nav.start(null)
  p.nav.open({ kind: 'room', contactId: A })
  const s = sheet(p)
  p.nav.setCovered(true)
  const showsBefore = p.shows.length
  for (let i = 0; i < 2; i++) {
    p.tab.press('back')
    flush(p)
    assert.equal(s.backs, 0)
    assert.equal(p.shows.length, showsBefore)
    assert.deepEqual(p.tab.state, SHEET)
    assert.equal(p.tab.left, false)
  }
  // The relay sheet opened from the cover sits above it: back closes that one only.
  const relay = sheet(p, { aboveCover: true })
  p.tab.press('back')
  flush(p)
  assert.deepEqual([s.backs, relay.backs], [0, 1])
  relay.handle.close()
  assert.deepEqual(p.tab.state, SHEET)
  p.tab.press('back')
  flush(p)
  assert.equal(s.backs, 0, 'still covered: the room sheet stays')
  p.nav.setCovered(false)
  p.tab.press('back')
  flush(p)
  assert.equal(s.backs, 1)
  s.handle.close()
  assert.deepEqual(p.tab.state, ROOM)
  assert.deepEqual(p.shown(), { kind: 'room', contactId: A })
  assert.equal(p.tab.entries.length, 3)
})

test('a contact removed with a sheet open in its room: the sheet and room entries both go', () => {
  const contacts = new Set([A])
  const p = page(new FakeTab(), contacts)
  p.nav.start(null)
  p.nav.open({ kind: 'room', contactId: A })
  const s = sheet(p)
  contacts.delete(A)
  p.nav.contactsChanged({ kind: 'room', contactId: A })
  s.handle.close()
  assert.equal(p.shown(), null)
  flush(p)
  assert.equal(p.tab.state, null)
  assert.equal(p.tab.left, false)
  p.tab.press('back')
  assert.equal(p.tab.left, true)
})

test('forward onto a sheet entry with no sheet open steps back over it', () => {
  const p = page(new FakeTab(), new Set([A]))
  p.nav.start(null)
  p.nav.open({ kind: 'room', contactId: A })
  const s = sheet(p)
  p.tab.press('back')
  flush(p)
  s.handle.close()
  const showsBefore = p.shows.length
  p.tab.press('forward')
  flush(p)
  assert.deepEqual(p.tab.state, ROOM)
  assert.equal(p.shows.length, showsBefore, 'the room stays, nothing closes')
})

test('no sheet entry before the app has started (opening and lock screens)', () => {
  const p = page(new FakeTab(), new Set([A]))
  const s = sheet(p)
  assert.equal(p.tab.state, null)
  assert.equal(p.tab.writes.length, 0)
  s.handle.close()
  assert.equal(p.tab.backCalls, 0)
})

test('a reload with a sheet on top: the old sheet entry is replaced in place, back is never trapped', () => {
  for (const [memoPlace, expected] of [
    [place(A), ROOM],
    [place(null), null],
  ] as const) {
    const tab = new FakeTab()
    const contacts = new Set([A])
    const p1 = page(tab, contacts)
    p1.nav.start(null)
    if (memoPlace.room) p1.nav.open({ kind: 'room', contactId: A })
    sheet(p1)
    tab.reload()
    let p = page(tab, contacts)
    const first = p.nav.start(memoPlace)
    assert.deepEqual(tab.state, expected)
    assert.equal(isSheetMark(tab.state), false)
    assert.deepEqual(first.overlay, memoPlace.room ? { kind: 'room', contactId: A } : null)
    // Back, again and again (a load of the app starts a new page): it ends outside the app.
    for (let i = 0; i < 10 && !tab.left; i++) {
      const loads = tab.loads
      tab.press('back')
      if (tab.loads !== loads) {
        p = page(tab, contacts)
        p.nav.start(place(null))
      } else flush(p)
      assert.equal(isSheetMark(tab.state), false, 'no sheet entry comes back')
    }
    assert.equal(tab.left, true, 'back reaches out of the app')
  }
})

test('the sheet entry holds the kind only', () => {
  const p = page(new FakeTab(), new Set([A, B]))
  p.nav.start(place(A))
  const s = sheet(p)
  p.tab.press('back')
  flush(p)
  s.handle.close()
  sheet(p).handle.close()
  flush(p)
  for (const w of p.tab.writes) {
    if (w === null) continue
    assert.deepEqual(Object.keys(w as object), ['ilchonOverlay'])
    assert.ok(markOf(w) !== null || isSheetMark(w), JSON.stringify(w))
  }
  assert.ok(p.tab.writes.some(isSheetMark))
  assert.ok(!JSON.stringify(p.tab.entries).includes('a'.repeat(16)))
})
