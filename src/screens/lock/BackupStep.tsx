import { useT } from '../../i18n'
import { DemoBanner } from '../shell/DemoBanner'
import { BackupPanel } from './BackupPanel'
import { ReauthGate } from './ReauthGate'
import './strings'
import './lock.css'

/**
 * Shown while a passkey/password user has no saved backup (every launch until
 * one exists; "later" hides it for this session only).
 */
export function BackupStep({ onClose }: { onClose: () => void }) {
  const t = useT('lock')
  return (
    <div className="shell">
      <DemoBanner />
      <div className="lock-screen">
        <div className="ui-page lock-body">
          <header className="lock-head lock-head--left">
            <h1 className="t-h3">{t('backupTitle')}</h1>
          </header>
          <ReauthGate>
            <BackupPanel onDone={onClose} />
          </ReauthGate>
          <button type="button" className="lock-link t-caption" onClick={onClose}>
            {t('backupLater')}
          </button>
        </div>
      </div>
    </div>
  )
}
