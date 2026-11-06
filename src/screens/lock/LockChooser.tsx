import { useEffect, useRef, useState } from 'react'
import { useT } from '../../i18n'
import type { LockChoice } from '../../contracts'
import { Badge, Button, Dialog, IconLock, IconWarning, TextField, cx } from '../../ui'
import { MIN_PASSWORD, errorCode, errorKey } from './util'
import './strings'
import './lock.css'

type Method = LockChoice['method']

export interface LockChooserProps {
  passkeySupported: boolean | null
  /** Method in use now (settings), marked and not re-submittable. */
  current?: Method | null
  submitLabel: string
  /** Rejects with an engine error code; shown inline. */
  onSubmit: (choice: LockChoice) => Promise<void>
}

/** Pick passkey / password / none, then submit. Shared by setup and settings. */
export function LockChooser({ passkeySupported, current, submitLabel, onSubmit }: LockChooserProps) {
  const t = useT('lock')
  const [method, setMethod] = useState<Method>(passkeySupported ? 'passkey' : 'password')
  const [pw, setPw] = useState('')
  const [pw2, setPw2] = useState('')
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState<string | null>(null)
  const [noneConfirm, setNoneConfirm] = useState(false)
  // A passkey attempt that said "no PRF" hides the option for the rest of this flow.
  const [prfFailed, setPrfFailed] = useState(false)
  const touched = useRef(false)

  const showPasskey = passkeySupported === true && !prfFailed

  // passkeySupported resolves after boot: follow it until the user picks something.
  useEffect(() => {
    if (!touched.current && showPasskey && method === 'password') setMethod('passkey')
  }, [showPasskey, method])
  useEffect(() => {
    if (!showPasskey && method === 'passkey') setMethod('password')
  }, [showPasskey, method])

  const pwTooShort = pw.length > 0 && pw.length < MIN_PASSWORD
  const pwMismatch = pw2.length > 0 && pw !== pw2

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
        setMethod('password')
      }
      setErr(t(key))
    } finally {
      setBusy(false)
    }
  }

  const submit = () => {
    if (busy) return
    if (method === 'password') {
      if (pw.length < MIN_PASSWORD) return setErr(t('errWeak'))
      if (pw !== pw2) return setErr(t('errMismatch'))
      void run({ method: 'password', password: pw })
    } else if (method === 'passkey') {
      void run({ method: 'passkey' })
    } else {
      setNoneConfirm(true)
    }
  }

  const option = (m: Method, title: string, help: string, danger = false) => (
    <button
      type="button"
      role="radio"
      aria-checked={method === m}
      className={cx('lock-opt', method === m && 'lock-opt--on', danger && 'lock-opt--danger')}
      onClick={() => pick(m)}
      disabled={busy}
    >
      <span className="lock-opt__dot" aria-hidden="true" />
      <span className="lock-opt__text">
        <span className="lock-opt__title t-body1 t-bold">
          {danger && <IconWarning size={16} />}
          {title}
          {current === m && <Badge tone="primary">{t('current')}</Badge>}
        </span>
        <span className="t-caption t-dim">{help}</span>
      </span>
    </button>
  )

  const disabled = busy || (current != null && current === method && method !== 'password')

  return (
    <div className="ui-stack">
      <div className="lock-opts" role="radiogroup" aria-label={t('chooseTitle')}>
        {showPasskey && option('passkey', t('choosePasskey'), t('choosePasskeyHelp'))}
        {option('password', t('choosePassword'), t('choosePasswordHelp'))}
        {option('none', t('chooseNone'), t('chooseNoneHelp'), true)}
      </div>

      {method === 'password' && (
        <div className="ui-stack">
          <TextField
            type="password"
            label={t('password')}
            value={pw}
            onChange={(v) => {
              touched.current = true
              setPw(v)
            }}
            autoComplete="new-password"
            helper={t('passwordHelp')}
            error={pwTooShort ? t('errWeak') : null}
            disabled={busy}
          />
          <TextField
            type="password"
            label={t('passwordConfirm')}
            value={pw2}
            onChange={setPw2}
            autoComplete="new-password"
            error={pwMismatch ? t('errMismatch') : null}
            disabled={busy}
            onEnter={submit}
          />
        </div>
      )}

      {err && (
        <p className="lock-err t-body2" role="alert">
          {err}
        </p>
      )}

      <Button
        size="lg"
        fullWidth
        variant={method === 'none' ? 'danger' : 'primary'}
        loading={busy}
        disabled={disabled}
        leading={method === 'none' ? undefined : <IconLock size={18} />}
        onClick={submit}
      >
        {submitLabel}
      </Button>

      <Dialog
        open={noneConfirm}
        tone="danger"
        title={t('noneWarnTitle')}
        confirmLabel={t('noneWarnConfirm')}
        onConfirm={() => {
          setNoneConfirm(false)
          void run({ method: 'none' })
        }}
        onCancel={() => setNoneConfirm(false)}
      >
        {t('noneWarnBody')}
      </Dialog>
    </div>
  )
}
