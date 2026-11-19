import { useState } from 'react'
import { actions } from '../../engine/browser'
import { useT } from '../../i18n'
import { Button, Dialog, IconWarning } from '../../ui'
import { CopyLogButton } from './CopyLogButton'
import { DemoBanner } from './DemoBanner'
import { clearRestoreMark, openRestoreAfterReset } from '../lock/after-reset'
import '../lock/strings'

/** bootError after a reset that could not delete everything (see IlchonActions.resetAll). */
const RESET_FAILED = 'reset-failed'

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
      // Reloads on success. Retries for the reason the reset began with (a format wipe
      // at boot stays one), see IlchonActions.resetAll.
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
        <CopyLogButton size="lg" variant="ghost" />
      </div>
    </div>
  )
}

/**
 * Stored data cannot be read: the only way on is a reset, then the
 * 12 words. The reset asks first.
 */
function StorageDamaged() {
  const t = useT('shell')
  const tl = useT('lock')
  const [confirm, setConfirm] = useState(false)
  const [busy, setBusy] = useState(false)
  const reset = async () => {
    setConfirm(false)
    setBusy(true)
    try {
      // Reloads on success; a failure moves to the reset-failed screen.
      await actions.resetAll()
    } catch {
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
        <h1 className="t-h3">{t('storageDamagedTitle')}</h1>
        <p className="t-body2 t-dim">{t('storageDamagedBody')}</p>
        <Button size="lg" variant="danger" loading={busy} onClick={() => setConfirm(true)}>
          {t('storageReset')}
        </Button>
        <Button size="lg" variant="secondary" disabled={busy} onClick={() => window.location.reload()}>
          {t('reload')}
        </Button>
        <CopyLogButton size="lg" variant="ghost" />
      </div>
      <Dialog open={confirm} tone="danger" title={tl('resetTitle')} confirmLabel={tl('resetConfirm')} onConfirm={() => void reset()} onCancel={() => setConfirm(false)}>
        {tl('resetBody')}
      </Dialog>
    </div>
  )
}

/**
 * The same 12 words were restored on another device, so this one stopped. It never goes
 * online again; the way on is a reset here and a restore with the 12 words (one button,
 * asked first, and the log).
 */
function Replaced() {
  const t = useT('shell')
  const tl = useT('lock')
  const [confirm, setConfirm] = useState(false)
  const [busy, setBusy] = useState(false)
  const reset = async () => {
    setConfirm(false)
    setBusy(true)
    // The reload after the reset opens the restore screen itself.
    openRestoreAfterReset()
    try {
      await actions.resetAll()
    } catch {
      // No reload came: the mark must not wait for a later, unrelated reset.
      clearRestoreMark()
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
        <h1 className="t-h3">{t('replacedTitle')}</h1>
        <p className="t-body2 t-dim">{t('replacedBody')}</p>
        <Button size="lg" loading={busy} onClick={() => setConfirm(true)}>
          {t('replacedRestore')}
        </Button>
        <CopyLogButton size="lg" variant="ghost" />
      </div>
      <Dialog open={confirm} tone="danger" title={tl('resetTitle')} confirmLabel={tl('resetConfirm')} onConfirm={() => void reset()} onCancel={() => setConfirm(false)}>
        {tl('resetBody')}
      </Dialog>
    </div>
  )
}

/** The browser store failed: reopening usually helps. No reset is offered. */
function StorageUnavailable() {
  const t = useT('shell')
  return (
    <div className="shell">
      <DemoBanner />
      <div className="shell-boot" role="alert">
        <span className="shell-boot__warn">
          <IconWarning size={32} />
        </span>
        <h1 className="t-h3">{t('storageUnavailableTitle')}</h1>
        <p className="t-body2 t-dim">{t('storageUnavailableBody')}</p>
        <Button size="lg" onClick={() => window.location.reload()}>
          {t('reload')}
        </Button>
        <CopyLogButton size="lg" variant="secondary" />
      </div>
    </div>
  )
}

export function BootError({ message }: { message?: string }) {
  const t = useT('shell')
  if (message === RESET_FAILED) return <ResetFailed />
  if (message === 'storage-damaged') return <StorageDamaged />
  if (message === 'storage-unavailable') return <StorageUnavailable />
  if (message === 'replaced') return <Replaced />
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
        {/* Unknown transport errors use the generic translated message above. */}
        {/* A reload is the only retry that is safe whatever state the engine stopped in. */}
        <Button size="lg" onClick={() => window.location.reload()}>
          {t('retry')}
        </Button>
        <CopyLogButton size="lg" variant="secondary" />
      </div>
    </div>
  )
}
