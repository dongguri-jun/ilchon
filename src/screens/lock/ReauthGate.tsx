import { useState, type ReactNode } from 'react'
import { actions, useIlchon } from '../../engine/browser'
import { useT } from '../../i18n'
import { Button, IconLock } from '../../ui'
import { PinField } from './PinField'
import { errorCode, errorKey, pinDigits, useWaitLeft, waitText } from './util'
import './strings'
import './lock.css'

/**
 * Shows `children` only after the current lock is proven again (passkey or
 * PIN; a PIN try counts like one at unlock). Skipped while a recent unlock/reauth window is open, and for 'none'.
 * The passkey prompt runs straight from the button tap (iOS needs the gesture).
 */
export function ReauthGate({ children }: { children: ReactNode }) {
  const t = useT('lock')
  const method = useIlchon((s) => s.lock.method)
  const waitUntil = useIlchon((s) => s.lock.waitUntil)
  const [ok, setOk] = useState(() => actions.reauthed())
  const [pw, setPw] = useState('')
  const [busy, setBusy] = useState(false)
  // An i18n key, not the text, so a language switch also switches the error.
  const [err, setErr] = useState<string | null>(null)

  const isPin = method === 'pin'
  const waitLeft = useWaitLeft(isPin ? waitUntil : 0)
  const waiting = isPin && waitLeft > 0

  if (ok) return <>{children}</>

  const go = async (pin?: string) => {
    if (busy || waiting || (isPin && pin?.length !== 6)) return
    setBusy(true)
    setErr(null)
    try {
      await actions.reauth(isPin ? pin : undefined)
      setPw('')
      setOk(true)
    } catch (e) {
      setPw('')
      const code = errorCode(e)
      if (code !== 'busy' && code !== 'pin-wait') setErr(errorKey(e, 'unlock'))
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="ui-stack">
      <p className="t-body2 t-dim">{isPin ? t('reauthPinBody') : t('reauthPasskeyBody')}</p>
      {isPin && (
        <PinField
          label={t('currentPin')}
          value={pw}
          onChange={(v) => {
            const next = pinDigits(v)
            setPw(next)
            setErr(null)
            if (next.length === 6) void go(next)
          }}
          disabled={busy || waiting}
          onEnter={() => void go(pw)}
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
        onClick={() => void go(pw)}
      >
        {t('reauthAction')}
      </Button>
    </div>
  )
}
