import { useState } from 'react'
import { actions, useIlchon } from '../../engine/browser'
import { useT } from '../../i18n'
import type { LockChoice } from '../../contracts'
import { isStandalone, platform } from '../../lib/pwa'
import { AppBar, Button, Card, IconChevronRight, IconWarning, TextField } from '../../ui'
import { DemoBanner } from '../shell/DemoBanner'
import { InstallHint } from '../shell/InstallHint'
import { LockChooser } from './LockChooser'
import { errorKey } from './util'
import './strings'
import './lock.css'

type Step = 'start' | 'restore' | 'lock'

/**
 * First run: new key or restore from ncryptsec, then pick the lock. The backup
 * step after creation comes from persisted state (App: lock.backedUp).
 */
export function SetupScreen() {
  const t = useT('lock')
  const passkeySupported = useIlchon((s) => s.lock.passkeySupported ?? null)
  const [step, setStep] = useState<Step>('start')
  const [restore, setRestore] = useState(false)
  const [ncryptsec, setNcryptsec] = useState('')
  const [backupPw, setBackupPw] = useState('')
  const [restoreErr, setRestoreErr] = useState<string | null>(null)
  const [checking, setChecking] = useState(false)

  const iosBrowser = platform() === 'ios' && !isStandalone()

  const backupLooksValid = ncryptsec.trim().toLowerCase().startsWith('ncryptsec1') && !!backupPw

  // Decrypt here (scrypt takes seconds) so the lock step's tap goes straight to the passkey prompt.
  const checkBackup = async () => {
    if (checking || !backupLooksValid) return
    setChecking(true)
    setRestoreErr(null)
    try {
      await actions.checkBackup(ncryptsec.trim(), backupPw)
      setStep('lock')
    } catch (e) {
      setRestoreErr(t(errorKey(e)))
    } finally {
      setChecking(false)
    }
  }

  const submit = async (choice: LockChoice) => {
    if (restore) {
      try {
        await actions.restoreIdentity(ncryptsec.trim(), backupPw, choice)
      } catch (e) {
        const key = errorKey(e)
        // Backup problems are fixed on the previous step.
        if (key === 'errInvalid' || key === 'errWrongPassword' || key === 'errLogN') {
          setRestoreErr(t(key))
          setStep('restore')
          return
        }
        throw e
      }
      return
    }
    await actions.createIdentity(choice)
  }

  return (
    <div className="shell">
      <DemoBanner />
      <div className="lock-screen">
        {step !== 'start' && <AppBar onBack={() => setStep(step === 'lock' && restore ? 'restore' : 'start')} />}
        <div className="ui-page lock-body">
          {step === 'start' && (
            <>
              <InstallHint />
              {iosBrowser && (
                <div className="lock-note" role="note">
                  <IconWarning size={18} />
                  <span className="t-body2">{t('installFirst')}</span>
                </div>
              )}
              <header className="lock-head">
                <h1 className="lock-name">{t('appName')}</h1>
                <p className="t-body1 t-dim">{t('setupIntro')}</p>
              </header>
              <div className="ui-stack">
                <Card
                  onClick={() => {
                    setRestore(false)
                    setStep('lock')
                  }}
                >
                  <div className="lock-path">
                    <div className="ui-grow">
                      <div className="t-body1 t-bold">{t('pathNew')}</div>
                      <div className="t-caption t-dim">{t('pathNewHelp')}</div>
                    </div>
                    <IconChevronRight size={20} />
                  </div>
                </Card>
                <Card
                  tone="outline"
                  onClick={() => {
                    setRestore(true)
                    setStep('restore')
                  }}
                >
                  <div className="lock-path">
                    <div className="ui-grow">
                      <div className="t-body1 t-bold">{t('pathRestore')}</div>
                      <div className="t-caption t-dim">{t('pathRestoreHelp')}</div>
                    </div>
                    <IconChevronRight size={20} />
                  </div>
                </Card>
              </div>
            </>
          )}

          {step === 'restore' && (
            <div className="ui-stack">
              <h1 className="t-h3">{t('restoreTitle')}</h1>
              <TextField
                multiline
                rows={4}
                label={t('restoreField')}
                value={ncryptsec}
                onChange={(v) => {
                  setNcryptsec(v)
                  setRestoreErr(null)
                }}
                autoCapitalize="off"
                autoComplete="off"
                spellCheck={false}
                className="lock-mono"
              />
              <TextField
                type="password"
                label={t('restorePassword')}
                value={backupPw}
                onChange={(v) => {
                  setBackupPw(v)
                  setRestoreErr(null)
                }}
                autoComplete="current-password"
                disabled={checking}
                onEnter={() => void checkBackup()}
              />
              {restoreErr && (
                <p className="lock-err t-body2" role="alert">
                  {restoreErr}
                </p>
              )}
              <Button size="lg" fullWidth loading={checking} disabled={!backupLooksValid} onClick={() => void checkBackup()}>
                {t('next')}
              </Button>
            </div>
          )}

          {step === 'lock' && (
            <div className="ui-stack">
              <header className="lock-head lock-head--left">
                <h1 className="t-h3">{t('chooseTitle')}</h1>
                <p className="t-body2 t-dim">{t('chooseBody')}</p>
              </header>
              <LockChooser passkeySupported={passkeySupported} submitLabel={t('lockAction')} onSubmit={submit} />
            </div>
          )}
        </div>
      </div>
    </div>
  )
}
