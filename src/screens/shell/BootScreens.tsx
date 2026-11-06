import { useState } from 'react'
import { actions } from '../../engine/browser'
import { useT } from '../../i18n'
import { Button, IconWarning, Spinner } from '../../ui'
import { DemoBanner } from './DemoBanner'

/** bootError after a reset that could not delete everything (see IlchonActions.resetAll). */
const RESET_FAILED = 'reset-failed'

export function BootLoader() {
  const t = useT('shell')
  return (
    <div className="shell">
      <DemoBanner />
      <div className="shell-boot" role="status" aria-live="polite">
        <h1 className="shell-boot__name">
          <img src="/brand/ilchon-logo-transparent.png" alt="ilchon" height={36} style={{ display: 'block', width: 'auto', height: 36, maxWidth: '100%', objectFit: 'contain' }} />
        </h1>
        <Spinner size={28} />
        <p className="t-body2 t-dim">{t('bootLine')}</p>
      </div>
    </div>
  )
}

/** Stable error message of the transport when another tab holds this profile. */
const PROFILE_LOCKED = 'profile-locked'

/**
 * A reset deleted some of this profile but not all of it. The engine is stopped
 * and its key is gone, so the only ways on are finishing the reset or reloading.
 */
function ResetFailed() {
  const t = useT('shell')
  const [busy, setBusy] = useState(false)
  const [again, setAgain] = useState(false)
  const retry = async () => {
    setBusy(true)
    try {
      // Reloads on success.
      await actions.resetAll()
    } catch {
      setAgain(true)
    } finally {
      setBusy(false)
    }
  }
  return (
    <div className="shell">
      <DemoBanner />
      <div className="shell-boot" role="alert">
        <span className="shell-boot__warn">
          <IconWarning size={32} />
        </span>
        <h1 className="t-h3">{t('resetFailedTitle')}</h1>
        <p className="t-body2 t-dim">{t('resetFailedBody')}</p>
        {again && !busy && <p className="t-body2 t-dim">{t('resetFailedAgain')}</p>}
        <Button size="lg" loading={busy} onClick={() => void retry()}>
          {t('resetRetry')}
        </Button>
        <Button size="lg" variant="secondary" disabled={busy} onClick={() => window.location.reload()}>
          {t('reload')}
        </Button>
      </div>
    </div>
  )
}

export function BootError({ message }: { message?: string }) {
  const t = useT('shell')
  if (message === RESET_FAILED) return <ResetFailed />
  const profileLocked = message === PROFILE_LOCKED
  const cleanupFailed = message === 'cleanup-failed'
  return (
    <div className="shell">
      <DemoBanner />
      <div className="shell-boot" role="alert">
        <span className="shell-boot__warn">
          <IconWarning size={32} />
        </span>
        <h1 className="t-h3">{t('bootErrorTitle')}</h1>
        <p className="t-body2 t-dim">{t(profileLocked ? 'bootErrorTab' : cleanupFailed ? 'bootErrorCleanup' : 'bootErrorBody')}</p>
        {/* Unknown transport errors use the generic translated message above. */}
        {/* A reload is the only retry that is safe whatever state the engine stopped in. */}
        <Button size="lg" onClick={() => window.location.reload()}>
          {t('retry')}
        </Button>
      </div>
    </div>
  )
}
