import { useState } from 'react'
import { actions, useIlchon } from '../../engine/browser'
import { useT } from '../../i18n'
import { Button, Dialog, IconLock, TextField } from '../../ui'
import { DemoBanner } from '../shell/DemoBanner'
import { errorCode, errorKey } from './util'
import './strings'
import './lock.css'

/** Identity exists but is locked. Passkey needs a user gesture (iOS), so no auto-trigger. */
export function UnlockScreen() {
  const t = useT('lock')
  const method = useIlchon((s) => s.lock.method ?? null)
  const backedUp = useIlchon((s) => s.lock.backedUp)
  // Consecutive "cancelled" results. WebAuthn also says NotAllowed when the passkey is gone.
  const [cancels, setCancels] = useState(0)
  const [pw, setPw] = useState('')
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState<string | null>(null)
  const [resetOpen, setResetOpen] = useState(false)
  const [resetting, setResetting] = useState(false)

  const isPassword = method === 'password'

  const unlock = async () => {
    if (busy || (isPassword && !pw)) return
    setBusy(true)
    setErr(null)
    try {
      await actions.unlock(isPassword ? pw : undefined)
    } catch (e) {
      const code = errorCode(e)
      setBusy(false)
      if (code === 'busy') return
      setCancels((n) => (code === 'passkey-cancelled' ? n + 1 : 0))
      setErr(t(errorKey(e, 'unlock')))
    }
  }

  const reset = async () => {
    setResetOpen(false)
    setResetting(true)
    try {
      await actions.resetAll()
    } catch (e) {
      setResetting(false)
      setErr(t(errorCode(e) === 'reset-failed' ? 'errResetFailed' : 'resetFailed'))
    }
  }

  return (
    <div className="shell">
      <DemoBanner />
      <div className="lock-screen">
        <div className="ui-page lock-body lock-body--center">
          <span className="lock-icon" aria-hidden="true">
            <IconLock size={36} />
          </span>
          <h1 className="lock-name">{t('appName')}</h1>
          <p className="t-body1 t-dim">{isPassword ? t('unlockPasswordBody') : t('unlockPasskeyBody')}</p>

          <div className="ui-stack lock-unlock">
            {isPassword && (
              <TextField
                type="password"
                label={t('password')}
                value={pw}
                onChange={(v) => {
                  setPw(v)
                  setErr(null)
                }}
                autoComplete="current-password"
                autoFocus
                disabled={busy}
                onEnter={() => void unlock()}
              />
            )}
            {err && (
              <p className="lock-err t-body2" role="alert">
                {err}
              </p>
            )}
            <Button
              size="lg"
              fullWidth
              loading={busy}
              disabled={isPassword && !pw}
              leading={<IconLock size={18} />}
              onClick={() => void unlock()}
            >
              {t('unlock')}
            </Button>
          </div>

          {!isPassword && cancels >= 2 && <p className="t-body2 t-dim">{t('passkeyMissingHint')}</p>}

          <button type="button" className="lock-link t-caption" disabled={resetting} onClick={() => setResetOpen(true)}>
            {t('resetLink')}
          </button>
        </div>
      </div>

      <Dialog
        open={resetOpen}
        tone="danger"
        title={t('resetTitle')}
        confirmLabel={t('resetConfirm')}
        onConfirm={() => void reset()}
        onCancel={() => setResetOpen(false)}
      >
        {backedUp ? t('resetBody') : t('resetBodyNoBackup')}
      </Dialog>
    </div>
  )
}
