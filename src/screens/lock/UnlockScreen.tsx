import { useState } from 'react'
import { actions, useIlchon } from '../../engine/browser'
import { useT } from '../../i18n'
import { Button, Dialog, IconLock } from '../../ui'
import { PinField } from './PinField'
import { CopyLogButton } from '../shell/CopyLogButton'
import { DemoBanner } from '../shell/DemoBanner'
import { errorCode, errorKey, pinDigits, useWaitLeft, waitText } from './util'
import './strings'
import './lock.css'

/** Identity exists but is locked. Passkey needs a user gesture (iOS), so no auto-trigger. */
export function UnlockScreen() {
  const t = useT('lock')
  const method = useIlchon((s) => s.lock.method ?? null)
  const waitUntil = useIlchon((s) => s.lock.waitUntil)
  // Consecutive "cancelled" results. WebAuthn also says NotAllowed when the passkey is gone.
  const [cancels, setCancels] = useState(0)
  const [pw, setPw] = useState('')
  const [busy, setBusy] = useState(false)
  // An i18n key, not the text, so a language switch on this screen also switches the error.
  const [err, setErr] = useState<string | null>(null)
  const [resetOpen, setResetOpen] = useState(false)
  const [resetting, setResetting] = useState(false)

  const isPin = method === 'pin'
  const waitLeft = useWaitLeft(isPin ? waitUntil : 0)
  const waiting = isPin && waitLeft > 0

  const unlock = async (pin?: string) => {
    if (busy || waiting || (isPin && pin?.length !== 6)) return
    setBusy(true)
    setErr(null)
    try {
      await actions.unlock(isPin ? pin : undefined)
    } catch (e) {
      const code = errorCode(e)
      setBusy(false)
      // A PIN that failed is cleared; the next one starts empty.
      setPw('')
      if (code === 'busy') return
      setCancels((n) => (code === 'passkey-cancelled' ? n + 1 : 0))
      // The wait has its own line with the time left.
      setErr(code === 'pin-wait' ? null : errorKey(e, 'unlock'))
    }
  }

  const reset = async () => {
    setResetOpen(false)
    setResetting(true)
    try {
      await actions.resetAll()
    } catch (e) {
      setResetting(false)
      // 'reset-failed' also moves the app to the reset-failed screen.
      const code = errorCode(e)
      setErr(code === 'reset-failed' ? errorKey(e) : 'resetFailed')
    }
  }

  return (
    <div className="shell">
      <DemoBanner />
      <main className="lock-screen">
        <div className="ui-page lock-body lock-body--center">
          <h1 className="lock-name"><img className="lock-logo" src="/brand/ilchon-logo-860.png" alt="ilchon" width={153} height={36} /></h1>
          <span className="lock-icon" aria-hidden="true">
            <IconLock size={36} />
          </span>
          <p className="t-body1 t-dim">{isPin ? t('unlockPinBody') : t('unlockPasskeyBody')}</p>

          <div className="ui-stack lock-unlock">
            {isPin && (
              <PinField
                label={t('pin')}
                value={pw}
                onChange={(v) => {
                  const next = pinDigits(v)
                  setPw(next)
                  setErr(null)
                  // Six digits unlock at once.
                  if (next.length === 6) void unlock(next)
                }}
                autoFocus
                disabled={busy || waiting}
                onEnter={() => void unlock(pw)}
              />
            )}
            {waiting && (
              <p className="lock-err t-body2" role="status">
                {t('errPinWait', { time: waitText(waitLeft) })}
              </p>
            )}
            {err && (
              <p className="lock-err t-body2" role="alert">
                {t(err)}
              </p>
            )}
            <Button
              size="lg"
              fullWidth
              loading={busy}
              disabled={isPin && (waiting || pw.length !== 6)}
              leading={<IconLock size={18} />}
              onClick={() => void unlock(pw)}
            >
              {t('unlock')}
            </Button>
          </div>

          {!isPin && cancels >= 2 && <p className="t-body2 t-dim">{t('passkeyMissingHint')}</p>}

          <CopyLogButton variant="ghost" size="sm" />

          <button type="button" className="lock-link t-caption" disabled={resetting} onClick={() => setResetOpen(true)}>
            {t('resetLink')}
          </button>
        </div>
      </main>

      <Dialog
        open={resetOpen}
        tone="danger"
        title={t('resetTitle')}
        confirmLabel={t('resetConfirm')}
        onConfirm={() => void reset()}
        onCancel={() => setResetOpen(false)}
      >
        {t('resetBody')}
      </Dialog>
    </div>
  )
}
