import { useEffect, useState } from 'react'
import type { PubkeyHex } from './contracts'
import { useIlchon } from './engine/browser'
import { setLang, useT } from './i18n'
import { BottomNav, IconBoard, IconSettings, IconUsers } from './ui'
import { BoardScreen } from './screens/board/BoardScreen'
import { ContactsScreen } from './screens/contacts/ContactsScreen'
import { ConnectScreen } from './screens/connect/ConnectScreen'
import { RoomScreen } from './screens/room/RoomScreen'
import { SettingsScreen } from './screens/settings/SettingsScreen'
import { BootError, BootLoader } from './screens/shell/BootScreens'
import { BackupStep } from './screens/lock/BackupStep'
import { MigrateStep } from './screens/lock/MigrateStep'
import { SetupScreen } from './screens/lock/SetupScreen'
import { UnlockScreen } from './screens/lock/UnlockScreen'
import { DemoBanner } from './screens/shell/DemoBanner'
import { IntroCard } from './screens/shell/IntroCard'
import './screens/shell/strings'
import './screens/shell/shell.css'

type Tab = 'board' | 'contacts' | 'settings'

/** Full-screen layer above the tabs. The tab underneath stays mounted. */
type Overlay = { kind: 'connect' } | { kind: 'room'; contactId: PubkeyHex } | null

export default function App() {
  const t = useT('shell')
  const boot = useIlchon((s) => s.boot)
  const bootError = useIlchon((s) => s.bootError)
  const lang = useIlchon((s) => s.settings.lang)
  const hasContacts = useIlchon((s) => s.contacts.length > 0)
  const matchCount = useIlchon((s) => s.matches.length)
  const lockMethod = useIlchon((s) => s.lock.method)
  const backedUp = useIlchon((s) => s.lock.backedUp)
  const migrated = useIlchon((s) => s.lock.migrated)

  const [tab, setTab] = useState<Tab>('board')
  const [overlay, setOverlay] = useState<Overlay>(null)
  // "Later" on the backup step hides it for this session only; it returns on the next launch.
  const [backupSnoozed, setBackupSnoozed] = useState(false)

  // The stored language wins once the engine has loaded settings.
  useEffect(() => {
    if (boot !== 'ready' && boot !== 'locked') return
    setLang(lang)
    document.documentElement.lang = lang
  }, [boot, lang])

  if (boot === 'starting') return <BootLoader />
  if (boot === 'error') return <BootError message={bootError} />
  if (boot === 'setup') return <SetupScreen />
  if (boot === 'locked') return <UnlockScreen />
  // A key moved from the old plaintext storage: pick a lock once.
  if (migrated) return <MigrateStep />
  // Losing a passkey or password loses the key, so ask for a backup until one is saved.
  if (!backedUp && !backupSnoozed && (lockMethod === 'passkey' || lockMethod === 'password')) {
    return <BackupStep onClose={() => setBackupSnoozed(true)} />
  }

  const openRoom = (contactId: PubkeyHex) => setOverlay({ kind: 'room', contactId })
  const openConnect = () => setOverlay({ kind: 'connect' })
  const closeOverlay = () => setOverlay(null)

  return (
    <div className="shell">
      <DemoBanner />
      <div className="shell__stage">
        {/* One scroll container per tab so each tab starts at its own top. */}
        <main key={tab} className="shell__tab" inert={overlay !== null}>
          {tab === 'board' && (
            <BoardScreen onOpenRoom={openRoom} onOpenConnect={openConnect} intro={hasContacts ? null : <IntroCard />} />
          )}
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
        <BottomNav<Tab>
          value={tab}
          onChange={setTab}
          items={[
            { value: 'board', label: t('tabBoard'), icon: <IconBoard />, badge: matchCount > 0 ? matchCount : undefined },
            { value: 'contacts', label: t('tabContacts'), icon: <IconUsers /> },
            { value: 'settings', label: t('tabSettings'), icon: <IconSettings /> },
          ]}
        />
      )}
    </div>
  )
}
