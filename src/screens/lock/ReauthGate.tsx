import { useState, type ReactNode } from 'react'
import { actions, useIlchon } from '../../engine/browser'
import { useT } from '../../i18n'
import { Button, IconLock, TextField } from '../../ui'
import { errorCode, errorKey } from './util'
import './strings'
import './lock.css'

/**
 * Shows `children` only after the current lock is proven again (passkey or
 * password). Skipped while a recent unlock/reauth window is open, and for 'none'.
 * The passkey prompt runs straight from the button tap (iOS needs the gesture).
 */
export function ReauthGate({ children }: { children: ReactNode }) {
  const t = useT('lock')
  const method = useIlchon((s) => s.lock.method)
  const [ok, setOk] = useState(() => actions.reauthed())
  const [pw, setPw] = useState('')
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState<string | null>(null)

  if (ok) return <>{children}</>

  const isPassword = method === 'password'

  const go = async () => {
    if (busy || (isPassword && !pw)) return
    setBusy(true)
    setErr(null)
    try {
      await actions.reauth(isPassword ? pw : undefined)
      setPw('')
      setOk(true)
    } catch (e) {
      if (errorCode(e) !== 'busy') setErr(t(errorKey(e, 'unlock')))
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="ui-stack">
      <p className="t-body2 t-dim">{isPassword ? t('reauthPasswordBody') : t('reauthPasskeyBody')}</p>
      {isPassword && (
        <TextField
          type="password"
          label={t('currentPassword')}
          value={pw}
          onChange={(v) => {
            setPw(v)
            setErr(null)
          }}
          autoComplete="current-password"
          disabled={busy}
          onEnter={() => void go()}
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
        onClick={() => void go()}
      >
        {t('reauthAction')}
      </Button>
    </div>
  )
}
