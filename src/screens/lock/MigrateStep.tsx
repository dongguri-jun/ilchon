import { actions, useIlchon } from '../../engine/browser'
import { useT } from '../../i18n'
import { DemoBanner } from '../shell/DemoBanner'
import { LockChooser } from './LockChooser'
import './strings'
import './lock.css'

/**
 * One-time step for a key moved from the old plaintext storage. 'none' stays
 * possible but goes through the same warning as on setup.
 */
export function MigrateStep() {
  const t = useT('lock')
  const passkeySupported = useIlchon((s) => s.lock.passkeySupported ?? null)
  return (
    <div className="shell">
      <DemoBanner />
      <div className="lock-screen">
        <div className="ui-page lock-body">
          <header className="lock-head lock-head--left">
            <h1 className="t-h3">{t('migrateTitle')}</h1>
            <p className="t-body2 t-dim">{t('migrateBody')}</p>
          </header>
          <LockChooser
            passkeySupported={passkeySupported}
            current={null}
            submitLabel={t('lockSave')}
            onSubmit={(choice) => actions.changeLock(choice)}
          />
        </div>
      </div>
    </div>
  )
}
