import { useEffect, useRef, useState } from 'react'
import { useT } from '../../i18n'
import type { LockChoice } from '../../contracts'
import { checkPin } from '../../lib/vault'
import { Badge, Button, IconLock, cx } from '../../ui'
import { PinField } from './PinField'
import { errorCode, errorKey, pinDigits } from './util'
import './strings'
import './lock.css'

type Method = LockChoice['method']

export interface LockChooserProps {
  passkeySupported: boolean | null
  /** Method in use now (settings), marked and not re-submittable (a PIN may change to another PIN). */
  current?: Method | null
  submitLabel: string
  /** The button's label while the development-only lock-free choice is picked (setup); submitLabel otherwise. */
  noneLabel?: string
  /** Rejects with an engine error code; shown inline. */
  onSubmit: (choice: LockChoice) => Promise<void>
}

/** Lock is required. The lock-free choice exists in development builds only. */
const DEV = import.meta.env.DEV

/**
 * Pick the lock, then submit. Shared by setup and settings. A passkey where the phone
 * has one; a 6-digit PIN only where it has none or the passkey gave no PRF.
 */
export function LockChooser({ passkeySupported, current, submitLabel, noneLabel, onSubmit }: LockChooserProps) {
  const t = useT('lock')
  const [method, setMethod] = useState<Method>(passkeySupported ? 'passkey' : 'pin')
  const [pin, setPin] = useState('')
  const [pin2, setPin2] = useState('')
  const [busy, setBusy] = useState(false)
  // An i18n key, not the text, so a language switch on this screen also switches the error.
  const [err, setErr] = useState<string | null>(null)
  // A passkey attempt that said "no PRF" hides the option for the rest of this flow.
  const [prfFailed, setPrfFailed] = useState(false)
  const touched = useRef(false)

  const showPasskey = passkeySupported === true && !prfFailed
  const showPin = !showPasskey

  // passkeySupported resolves after boot: follow it until the user picks something.
  useEffect(() => {
    if (!touched.current && showPasskey && method === 'pin') setMethod('passkey')
  }, [showPasskey, method])
  useEffect(() => {
    if (!showPasskey && method === 'passkey') setMethod('pin')
  }, [showPasskey, method])

  const pinMismatch = pin2.length === 6 && pin !== pin2

  const pick = (m: Method) => {
    touched.current = true
    setMethod(m)
    setErr(null)
  }

  const run = async (choice: LockChoice) => {
    setBusy(true)
    setErr(null)
    try {
      await onSubmit(choice)
    } catch (e) {
      if (errorCode(e) === 'busy') return
      const key = errorKey(e)
      if (key === 'errPrf') {
        touched.current = true
        setPrfFailed(true)
        setMethod('pin')
      }
      setErr(key)
    } finally {
      setBusy(false)
    }
  }

  const submit = () => {
    if (busy) return
    if (method === 'pin') {
      // The same rule the store applies (checkPin), before the slow PBKDF2 starts.
      try {
        checkPin(pin)
      } catch {
        return setErr('errWeakPin')
      }
      // A full second PIN already shows the mismatch under its field; say it once.
      if (pin !== pin2) return pinMismatch ? undefined : setErr('errPinMismatch')
      void run({ method: 'pin', pin })
    } else if (method === 'passkey') {
      void run({ method: 'passkey' })
    } else if (DEV) {
      void run({ method: 'none' })
    }
  }

  const option = (m: Method, title: string, help?: string) => (
    <button
      type="button"
      role="radio"
      aria-checked={method === m}
      className={cx('lock-opt', method === m && 'lock-opt--on', !help && 'lock-opt--plain')}
      onClick={() => pick(m)}
      disabled={busy}
    >
      <span className="lock-opt__dot" aria-hidden="true" />
      <span className="lock-opt__text">
        <span className="lock-opt__title t-body1 t-bold">
          {title}
          {current === m && <Badge tone="primary">{t('current')}</Badge>}
        </span>
        {help && <span className="t-caption t-dim">{help}</span>}
      </span>
    </button>
  )

  const disabled = busy || (current != null && current === method && method !== 'pin')

  return (
    <div className="ui-stack">
      <div className="lock-opts" role="radiogroup" aria-label={t('chooseTitle')}>
        {showPasskey && option('passkey', t('choosePasskey'), t('choosePasskeyHelp'))}
        {showPin && option('pin', t('choosePin'), t('choosePinHelp'))}
        {DEV && option('none', t('chooseNoneDev'))}
      </div>
      <p className="t-body3 t-dim">{t('lockScope')}</p>

      {method === 'pin' && (
        <div className="ui-stack">
          <PinField
            label={t('pin')}
            value={pin}
            onChange={(v) => {
              touched.current = true
              setPin(pinDigits(v))
              setErr(null)
            }}
            disabled={busy}
          />
          <PinField
            label={t('pinConfirm')}
            value={pin2}
            onChange={(v) => {
              setPin2(pinDigits(v))
              setErr(null)
            }}
            error={pinMismatch ? t('errPinMismatch') : null}
            disabled={busy}
            onEnter={submit}
          />
        </div>
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
        disabled={disabled || (method === 'pin' && (pin.length !== 6 || pin2.length !== 6))}
        leading={method === 'none' ? undefined : <IconLock size={18} />}
        onClick={submit}
      >
        {method === 'none' && noneLabel ? noneLabel : submitLabel}
      </Button>
    </div>
  )
}
