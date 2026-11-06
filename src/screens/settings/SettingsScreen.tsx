import { useState } from 'react'
import type { Lang } from '../../contracts'
import { actions, useIlchon } from '../../engine/browser'
import { useT } from '../../i18n'
import {
  AppBar,
  Badge,
  BottomSheet,
  Button,
  Card,
  Dialog,
  IconCopy,
  IconLock,
  IconTrash,
  IconWarning,
  Segmented,
  Switch,
  useToast,
} from '../../ui'
import { BackupPanel } from '../lock/BackupPanel'
import { LockChooser } from '../lock/LockChooser'
import { ReauthGate } from '../lock/ReauthGate'
import { copyText } from '../lock/util'
import './strings'
import './settings.css'

const LANG_OPTIONS: { value: Lang; label: string }[] = [
  { value: 'ko', label: '한국어' },
  { value: 'en', label: 'English' },
]

function methodKey(m: 'passkey' | 'password' | 'none' | null): string {
  return m === 'passkey' ? 'lockPasskey' : m === 'password' ? 'lockPassword' : m === 'none' ? 'lockNone' : 'lockUnknown'
}

function shortNpub(npub: string): string {
  return npub.length > 24 ? `${npub.slice(0, 14)}…${npub.slice(-8)}` : npub
}

function relayHost(url: string): string {
  return url.replace(/^wss?:\/\//, '').replace(/\/$/, '')
}

export function SettingsScreen() {
  const t = useT('settings')
  const toast = useToast()
  const settings = useIlchon((s) => s.settings)
  const relays = useIlchon((s) => s.relays)
  const npub = useIlchon((s) => s.me?.npub ?? '')
  const lock = useIlchon((s) => s.lock)

  const [lockSheet, setLockSheet] = useState(false)
  const [backupSheet, setBackupSheet] = useState(false)

  const [backupOpen, setBackupOpen] = useState(false)
  const [resetOpen, setResetOpen] = useState(false)
  const [resetting, setResetting] = useState(false)

  const copyNpub = async () => {
    if (!npub) return
    const ok = await copyText(npub)
    toast.show(ok ? t('copied') : t('copyFailed'), ok ? 'success' : 'error')
  }

  const confirmBackup = async () => {
    let ok = false
    try {
      // The key goes straight to the clipboard; it is never put in state or the DOM tree
      // (no textarea fallback: without the async clipboard API the copy just fails).
      ok = await copyText(actions.exportKey(), { legacy: false })
    } catch {
      ok = false
    }
    if (ok) setBackupOpen(false)
    toast.show(ok ? t('backupDone') : t('copyFailed'), ok ? 'success' : 'error')
  }

  const confirmReset = async () => {
    setResetOpen(false)
    setResetting(true)
    try {
      await actions.resetAll()
    } catch {
      setResetting(false)
      toast.show(t('resetFailed'), 'error')
    }
  }

  return (
    <div className="settings">
      <AppBar title={t('title')} />
      <div className="ui-page settings__body">
        <section className="settings__section">
          <h2 className="settings__heading">{t('secGeneral')}</h2>
          <Card>
            <div className="settings__field">
              <span className="t-body2 t-dim">{t('language')}</span>
              <Segmented<Lang>
                options={LANG_OPTIONS}
                value={settings.lang}
                onChange={(lang) => void actions.setSettings({ lang })}
                ariaLabel={t('language')}
              />
            </div>
            <div className="settings__divider" />
            <div className="settings__toggle">
              <div className="ui-grow">
                <div className="t-body1">{t('demoMode')}</div>
                <div className="t-caption t-dim">{t('demoModeHelp')}</div>
              </div>
              <Switch
                checked={settings.demoMode}
                onChange={(demoMode) => void actions.setSettings({ demoMode })}
                label={t('demoMode')}
              />
            </div>
          </Card>
        </section>

        <section className="settings__section">
          <h2 className="settings__heading">{t('secRelays')}</h2>
          <Card>
            {relays.length === 0 ? (
              <p className="t-body2 t-dim">{t('relaysEmpty')}</p>
            ) : (
              <ul className="settings__relays">
                {relays.map((r) => (
                  <li key={r.url} className="settings__relay">
                    <span className="settings__relay-url t-body2">{relayHost(r.url)}</span>
                    <Badge tone={r.connected ? 'success' : 'danger'}>{r.connected ? t('relayOn') : t('relayOff')}</Badge>
                  </li>
                ))}
              </ul>
            )}
          </Card>
        </section>

        <section className="settings__section">
          <h2 className="settings__heading">{t('secKey')}</h2>
          <Card>
            <div className="settings__toggle">
              <div className="ui-grow">
                <div className="t-caption t-dim">{t('npub')}</div>
                <div className="settings__npub num">{npub ? shortNpub(npub) : '—'}</div>
              </div>
              <Button
                variant="secondary"
                size="sm"
                leading={<IconCopy size={16} />}
                disabled={!npub}
                onClick={() => void copyNpub()}
              >
                {t('copy')}
              </Button>
            </div>
          </Card>
        </section>

        <section className="settings__section">
          <h2 className="settings__heading">{t('secProtect')}</h2>
          <Card>
            <div className="settings__toggle">
              <div className="ui-grow">
                <div className="t-caption t-dim">{t('lockMethod')}</div>
                <div className="t-body1 t-bold">{t(methodKey(lock?.method ?? null))}</div>
              </div>
              {lock?.method === 'none' && <Badge tone="danger">{t('lockNoneBadge')}</Badge>}
            </div>
            <div className="settings__divider" />
            <div className="settings__action">
              <Button variant="secondary" fullWidth leading={<IconLock size={18} />} onClick={() => setLockSheet(true)}>
                {t('lockChange')}
              </Button>
            </div>
            <div className="settings__divider" />
            <div className="settings__action">
              <div className="settings__toggle">
                <span className="t-body1 ui-grow">{t('backupNcrypt')}</span>
                {lock && !lock.backedUp && (
                  <Badge tone="warning" icon={<IconWarning size={14} />}>
                    {t('noBackup')}
                  </Badge>
                )}
              </div>
              <Button variant="secondary" fullWidth onClick={() => setBackupSheet(true)}>
                {t('backupMake')}
              </Button>
              <p className="t-caption t-dim">{t('backupNcryptHelp')}</p>
            </div>
            <div className="settings__divider" />
            <details className="settings__advanced">
              <summary className="t-body2">{t('advanced')}</summary>
              <div className="settings__action">
                <p className="settings__warn t-caption">{t('advancedWarn')}</p>
                <Button variant="danger" fullWidth leading={<IconCopy size={18} />} onClick={() => setBackupOpen(true)}>
                  {t('backup')}
                </Button>
                <p className="t-caption t-dim">{t('backupHelp')}</p>
              </div>
            </details>
          </Card>
        </section>

        <section className="settings__section">
          <h2 className="settings__heading">{t('secAbout')}</h2>
          <Card>
            <h3 className="t-body1 t-bold">{t('seeTitle')}</h3>
            <ul className="settings__list t-body2">
              <li>{t('see1')}</li>
              <li>{t('see2')}</li>
              <li>{t('see3')}</li>
            </ul>
            <div className="settings__divider" />
            <h3 className="t-body1 t-bold">{t('limitsTitle')}</h3>
            <ul className="settings__list t-body2">
              <li>{t('limit1')}</li>
              <li>{t('limit2')}</li>
              <li>{t('limit3')}</li>
              <li>{t('limit4')}</li>
              <li>{t('limit5')}</li>
            </ul>
          </Card>
        </section>

        <section className="settings__section">
          <h2 className="settings__heading">{t('secDanger')}</h2>
          <Card>
            <div className="settings__action">
              <Button
                variant="danger"
                fullWidth
                loading={resetting}
                leading={<IconTrash size={18} />}
                onClick={() => setResetOpen(true)}
              >
                {t('reset')}
              </Button>
              <p className="t-caption t-dim">{t('resetHelp')}</p>
            </div>
          </Card>
        </section>
      </div>

      {/* Raw key, password lock change and ncryptsec export all prove the current lock first. */}
      <BottomSheet open={backupOpen} onClose={() => setBackupOpen(false)} title={t('backupTitle')}>
        {backupOpen && (
          <ReauthGate>
            <div className="ui-stack">
              <p className="t-body2">{t('backupBody')}</p>
              <Button variant="danger" fullWidth leading={<IconCopy size={18} />} onClick={() => void confirmBackup()}>
                {t('backupConfirm')}
              </Button>
            </div>
          </ReauthGate>
        )}
      </BottomSheet>

      <BottomSheet open={lockSheet} onClose={() => setLockSheet(false)} title={t('lockChange')}>
        {lockSheet && (
          <ReauthGate>
            <LockChooser
              passkeySupported={lock?.passkeySupported ?? null}
              current={lock?.method ?? null}
              submitLabel={t('lockSave')}
              onSubmit={async (choice) => {
                await actions.changeLock(choice)
                setLockSheet(false)
                toast.show(t('lockChanged'), 'success')
              }}
            />
          </ReauthGate>
        )}
      </BottomSheet>

      <BottomSheet open={backupSheet} onClose={() => setBackupSheet(false)} title={t('backupNcrypt')}>
        {backupSheet && (
          <ReauthGate>
            <BackupPanel onDone={() => setBackupSheet(false)} />
          </ReauthGate>
        )}
      </BottomSheet>

      <Dialog
        open={resetOpen}
        tone="danger"
        title={t('resetTitle')}
        confirmLabel={t('resetConfirm')}
        onConfirm={() => void confirmReset()}
        onCancel={() => setResetOpen(false)}
      >
        {t('resetBody')}
      </Dialog>
    </div>
  )
}
