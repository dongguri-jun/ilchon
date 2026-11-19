import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import type { PubkeyHex } from './contracts'
import { engine, memo, useIlchon } from './engine/browser'
import { useT } from './i18n'
import { BottomNav, IconBoard, IconSettings, IconUsers } from './ui'
import { BoardScreen } from './screens/board/BoardScreen'
import { ContactsScreen } from './screens/contacts/ContactsScreen'
import { ConnectScreen } from './screens/connect/ConnectScreen'
import { RoomScreen } from './screens/room/RoomScreen'
import { SettingsScreen } from './screens/settings/SettingsScreen'
import { BootError } from './screens/shell/BootScreens'
import { SetupScreen } from './screens/lock/SetupScreen'
import { UnlockScreen } from './screens/lock/UnlockScreen'
import { ConnectionScreen, useConnectionProblem } from './screens/shell/ConnectionScreen'
import { DemoBanner } from './screens/shell/DemoBanner'
import { needsPhoneGate } from './screens/shell/device'
import { IntroCard } from './screens/shell/IntroCard'
import { PhoneGate } from './screens/shell/PhoneGate'
import { createOverlayNav, readPlace, type Overlay, type Place, type Tab } from './screens/shell/overlay-history'
import { setSheetBack } from './ui/sheet-back'
import './screens/shell/strings'
import './screens/shell/shell.css'

export default function App() {
  const t = useT('shell')
  const boot = useIlchon((s) => s.boot)
  const bootError = useIlchon((s) => s.bootError)
  const hasContacts = useIlchon((s) => s.contacts.length > 0)
  const matchCount = useIlchon((s) => s.matches.length)

  const [tab, setTab] = useState<Tab>('board')
  const [overlay, setOverlay] = useState<Overlay>(null)
  // Above the early returns: hooks run in the same order on every render.
  const connectionProblem = useConnectionProblem()
  const contacts = useIlchon((s) => s.contacts)

  // The back button: a room and the connect screen each get one
  // history entry holding only their kind; overlay-history.ts is the only caller of
  // pushState and replaceState. setOverlay is stable, so one nav serves the page.
  const [nav] = useState(() =>
    createOverlayNav(window.history, {
      hasContact: (id) => engine.store.getState().contacts.some((c) => c.id === id),
      show: setOverlay,
    }),
  )
  // Bottom sheets get their entry from the same nav, so the back button closes them.
  useEffect(() => {
    setSheetBack(nav)
    return () => setSheetBack(null)
  }, [nav])
  useEffect(() => {
    const onPop = (e: PopStateEvent) => nav.popState(e.state)
    window.addEventListener('popstate', onPop)
    return () => window.removeEventListener('popstate', onPop)
  }, [nav])
  // Back under the connection cover keeps the room or connect screen behind it.
  useLayoutEffect(() => {
    nav.setCovered(connectionProblem)
  }, [nav, connectionProblem])
  // A room on screen whose contact went away closes (the engine already
  // dropped its draft and memo.place.room when it removed the contact).
  useEffect(() => {
    if (boot === 'ready') nav.contactsChanged(overlay)
  }, [nav, boot, contacts, overlay])

  // Back to where I was, once, when the app first opens: the layer in history.state
  // (a reload or a re-lock in this tab), else memo.place, else the board. overlay-history
  // decides, including a room whose contact is gone (not opened).
  // After that, the place is written down while open: a tab change, a room opened or
  // closed. Not the connect screen (its QR changes every 30 seconds): the place stays
  // the tab under it. Nothing is written until the restored place is on screen, so the
  // board shown before it (or a second effect run in development) never overwrites it.
  const restored = useRef(false)
  const restoring = useRef<{ tab: Tab; room: PubkeyHex | null } | null>(null)
  useEffect(() => {
    if (boot !== 'ready') return
    if (!restored.current) {
      restored.current = true
      const first = nav.start(readPlace(memo.get('place')))
      const toTab = first.tab ?? tab
      const room = first.overlay?.kind === 'room' ? first.overlay.contactId : null
      // Already on screen (this tab, no layer): nothing to wait for.
      if (toTab !== tab || first.overlay !== null) restoring.current = { tab: toTab, room }
      setTab(toTab)
      return
    }
    if (overlay?.kind === 'connect') return
    const room = overlay?.kind === 'room' ? overlay.contactId : null
    const target = restoring.current
    if (target) {
      if (target.tab !== tab || target.room !== room) return
      restoring.current = null
    }
    const cur = readPlace(memo.get('place'))
    if (cur && cur.tab === tab && cur.room === room) return
    memo.set('place', { tab, room, at: Date.now() } satisfies Place)
  }, [nav, boot, tab, overlay])

  // Opening, or waiting for my relays however long: the app needs a relay to do anything.
  if (boot === 'starting') return <ConnectionScreen mode="boot" problem={connectionProblem} />
  if (boot === 'error') return <BootError message={bootError} />
  if (boot === 'setup') {
    // Only a device with no key yet: people with a key on a PC keep working.
    return needsPhoneGate(navigator.userAgent, navigator.maxTouchPoints, window.location.hostname) ? <PhoneGate /> : <SetupScreen />
  }
  if (boot === 'locked') return <UnlockScreen />

  const openRoom = (contactId: PubkeyHex) => nav.open({ kind: 'room', contactId })
  const openConnect = () => nav.open({ kind: 'connect' })
  const closeOverlay = () => nav.close()

  return (
    <div className="shell">
      <DemoBanner />
      <div className="shell__stage" inert={connectionProblem}>
        {/* One scroll container per tab so each tab starts at its own top. */}
        <main key={tab} className="shell__tab" inert={overlay !== null}>
          {tab === 'board' && <BoardScreen onOpenRoom={openRoom} onOpenConnect={openConnect} intro={hasContacts ? null : <IntroCard />} />}
          {tab === 'contacts' && <ContactsScreen onOpenConnect={openConnect} onOpenRoom={openRoom} />}
          {tab === 'settings' && <SettingsScreen />}
        </main>

        {overlay?.kind === 'connect' && (
          <div className="shell__overlay">
            <ConnectScreen onClose={closeOverlay} />
          </div>
        )}
        {overlay?.kind === 'room' && (
          <div className="shell__overlay">
            <RoomScreen key={overlay.contactId} contactId={overlay.contactId} onBack={closeOverlay} />
          </div>
        )}
      </div>

      {overlay === null && (
        // display: contents keeps the nav's own layout; inert only takes it out of reach.
        <div style={{ display: 'contents' }} inert={connectionProblem}>
          <BottomNav<Tab>
            value={tab}
            onChange={setTab}
            items={[
              { value: 'board', label: t('tabBoard'), icon: <IconBoard />, badge: matchCount > 0 ? matchCount : undefined },
              { value: 'contacts', label: t('tabContacts'), icon: <IconUsers /> },
              { value: 'settings', label: t('tabSettings'), icon: <IconSettings /> },
            ]}
          />
        </div>
      )}
      {/* While the connection is gone: covers the app, which stays as it is underneath. */}
      <ConnectionScreen mode="cover" problem={connectionProblem} />
    </div>
  )
}
