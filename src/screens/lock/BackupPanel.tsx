import { useState } from 'react'
import { actions } from '../../engine/browser'
import { useT } from '../../i18n'
import { Button, IconCheck, IconCopy, TextField, useToast } from '../../ui'
import { MIN_PASSWORD, copyText, errorKey } from './util'
import './strings'
import './lock.css'

export interface BackupPanelProps {
  /** Shown before a backup exists, e.g. "나중에 할게요". */
  onSkip?: () => void
  /** Shown after the backup is displayed. */
  onDone?: () => void
}

/** Backup password -> actions.exportBackup -> ncryptsec in a box with Copy. */
export function BackupPanel({ onSkip, onDone }: BackupPanelProps) {
  const t = useT('lock')
  const toast = useToast()
  const [pw, setPw] = useState('')
  const [pw2, setPw2] = useState('')
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState<string | null>(null)
  const [backup, setBackup] = useState<string | null>(null)

  const make = async () => {
    if (busy) return
    if (pw.length < MIN_PASSWORD) return setErr(t('errWeak'))
    if (pw !== pw2) return setErr(t('errMismatch'))
    setBusy(true)
    setErr(null)
    try {
      const out = await actions.exportBackup(pw)
      setPw('')
      setPw2('')
      setBackup(out)
    } catch (e) {
      setErr(t(errorKey(e)))
    } finally {
      setBusy(false)
    }
  }

  const copy = async () => {
    if (!backup) return
    const ok = await copyText(backup)
    toast.show(ok ? t('copied') : t('copyFailed'), ok ? 'success' : 'error')
    // The backup left the app: from now on the "no backup" reminder can go.
    if (ok) await actions.markBackedUp().catch(() => {})
  }

  const done = async () => {
    await actions.markBackedUp().catch(() => {})
    onDone?.()
  }

  if (backup) {
    return (
      <div className="ui-stack">
        <p className="t-body2">{t('backupReady')}</p>
        <div className="lock-code">{backup}</div>
        <Button variant="secondary" fullWidth leading={<IconCopy size={18} />} onClick={() => void copy()}>
          {t('copy')}
        </Button>
        {onDone && (
          <Button size="lg" fullWidth leading={<IconCheck size={18} />} onClick={() => void done()}>
            {t('backupDone')}
          </Button>
        )}
      </div>
    )
  }

  return (
    <div className="ui-stack">
      <p className="t-body2 t-dim">{t('backupBody')}</p>
      <TextField
        type="password"
        label={t('backupPassword')}
        value={pw}
        onChange={setPw}
        autoComplete="new-password"
        helper={t('passwordHelp')}
        error={pw.length > 0 && pw.length < MIN_PASSWORD ? t('errWeak') : null}
        disabled={busy}
      />
      <TextField
        type="password"
        label={t('passwordConfirm')}
        value={pw2}
        onChange={setPw2}
        autoComplete="new-password"
        error={pw2.length > 0 && pw !== pw2 ? t('errMismatch') : null}
        disabled={busy}
        onEnter={() => void make()}
      />
      {err && (
        <p className="lock-err t-body2" role="alert">
          {err}
        </p>
      )}
      <Button size="lg" fullWidth loading={busy} onClick={() => void make()}>
        {t('backupMake')}
      </Button>
      {onSkip && (
        <Button variant="ghost" fullWidth disabled={busy} onClick={onSkip}>
          {t('backupLater')}
        </Button>
      )}
    </div>
  )
}
