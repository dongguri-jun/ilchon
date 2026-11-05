import { useT } from '../../i18n'
import { Button, IconWarning, Spinner } from '../../ui'
import { DemoBanner } from './DemoBanner'

export function BootLoader() {
  const t = useT('shell')
  return (
    <div className="shell">
      <DemoBanner />
      <div className="shell-boot" role="status" aria-live="polite">
        <h1 className="shell-boot__name">{t('bootTitle')}</h1>
        <Spinner size={28} />
        <p className="t-body2 t-dim">{t('bootLine')}</p>
      </div>
    </div>
  )
}

/** Stable error message of the transport when another tab holds this profile. */
const PROFILE_LOCKED = 'profile-locked'

export function BootError({ message }: { message?: string }) {
  const t = useT('shell')
  const profileLocked = message === PROFILE_LOCKED
  return (
    <div className="shell">
      <DemoBanner />
      <div className="shell-boot" role="alert">
        <span className="shell-boot__warn">
          <IconWarning size={32} />
        </span>
        <h1 className="t-h3">{t('bootErrorTitle')}</h1>
        <p className="t-body2 t-dim">{t(profileLocked ? 'bootErrorTab' : 'bootErrorBody')}</p>
        {message && !profileLocked && <p className="shell-boot__detail t-caption">{message}</p>}
        {/* A reload is the only retry that is safe whatever state the engine stopped in. */}
        <Button size="lg" onClick={() => window.location.reload()}>
          {t('retry')}
        </Button>
      </div>
    </div>
  )
}
