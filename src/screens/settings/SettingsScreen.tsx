import { useRef, useState, type KeyboardEvent } from 'react'
import { RELOCK_MINUTES, type Lang, type RelockMinutes } from '../../contracts'
import { actions, useIlchon } from '../../engine/browser'
import { setLang, useT } from '../../i18n'
import { langLabel, offeredLangs } from '../../i18n/lang'
import { APP_VERSION } from '../../lib/build'
import { AppBar, Badge, BottomSheet, Button, Card, Dialog, IconCheck, IconCopy, IconLock, IconTrash, ListRow, Segmented, useToast } from '../../ui'
import { RelaySettings } from './RelaySettings'
import { LightningAddressSetting } from './LightningAddress'
import { LockChooser } from '../lock/LockChooser'
import { ReauthGate } from '../lock/ReauthGate'
import { copyText } from '../lock/util'
import { WordGrid } from '../lock/WordGrid'
import { CopyLogButton } from '../shell/CopyLogButton'
import './strings'
import './settings.css'

function methodKey(m: 'passkey' | 'pin' | 'none' | null): string {
  return m === 'passkey' ? 'lockPasskey' : m === 'pin' ? 'lockPin' : m === 'none' ? 'lockNone' : 'lockUnknown'
}

/**
 * Mounted only after the reauth gate passed; the words live in this component's state
 * while the sheet is open and go with it when it closes.
 */
function SecretWords({ warn, phishing, close, onClose }: { warn: string; phishing: string; close: string; onClose: () => void }) {
  const [words] = useState(() => actions.revealMnemonic())
  return (
    <div className="ui-stack">
      <WordGrid words={words} />
      <p className="settings__warn t-body2">{warn}</p>
      <p className="settings__warn t-body2">{phishing}</p>
      <Button variant="secondary" fullWidth onClick={onClose}>
        {close}
      </Button>
    </div>
  )
}

function shortNpub(npub: string): string {
  return npub.length > 24 ? `${npub.slice(0, 14)}…${npub.slice(-8)}` : npub
}

export function SettingsScreen() {
  const t = useT('settings')
  const toast = useToast()
  const settings = useIlchon((s) => s.settings)
  const relays = useIlchon((s) => s.relays)
  const npub = useIlchon((s) => s.me?.npub ?? '')
  const lock = useIlchon((s) => s.lock)
  const hasWords = useIlchon((s) => s.hasWords)
  const tLock = useT('lock')

  const [lockSheet, setLockSheet] = useState(false)
  const [wordsOpen, setWordsOpen] = useState(false)
  const [resetOpen, setResetOpen] = useState(false)
  const [resetting, setResetting] = useState(false)
  /** Settings → Advanced → Relays, folded until tapped. Not stored. */
  const [relaysOpen, setRelaysOpen] = useState(false)

  // The language list is a WAI-ARIA radio group: only the checked row is a Tab stop,
  // and the arrow keys move to the next or previous language and choose it.
  const langGroup = useRef<HTMLDivElement>(null)
  const langs = offeredLangs()
  const chooseLang = (l: Lang) => {
    setLang(l)
    void actions.setSettings({ lang: l }).catch(() => {
      // 'save-failed': not stored; the screen already switched for this session.
    })
  }
  const langKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    const step = e.key === 'ArrowDown' || e.key === 'ArrowRight' ? 1 : e.key === 'ArrowUp' || e.key === 'ArrowLeft' ? -1 : 0
    if (!step || langs.length === 0) return
    e.preventDefault()
    const at = langs.indexOf(settings.lang)
    const next = at < 0 ? 0 : (at + step + langs.length) % langs.length
    chooseLang(langs[next])
    langGroup.current?.querySelectorAll<HTMLButtonElement>('[role="radio"]')[next]?.focus()
  }
  const langChecked = langs.includes(settings.lang) ? settings.lang : langs[0]

  // Auto-lock. A write that fails leaves the stored time
  // (setSettings undoes the change) and says so.
  const chooseRelock = (value: string) => {
    const m = Number(value) as RelockMinutes
    if (!RELOCK_MINUTES.includes(m) || m === settings.relockMinutes) return
    void actions.setSettings({ relockMinutes: m }).catch(() => toast.show(t('relockSaveFailed'), 'error'))
  }

  const copyNpub = async () => {
    if (!npub) return
    const ok = await copyText(npub)
    toast.show(ok ? t('copied') : t('copyFailed'), ok ? 'success' : 'error')
  }

  const confirmReset = async () => {
    setResetOpen(false)
    setResetting(true)
    try {
      await actions.resetAll()
    } catch (e) {
      setResetting(false)
      const code = e instanceof Error ? e.message : String(e)
      // A half-done reset moves the app to its own screen (boot 'error', 'reset-failed').
      if (code === 'reset-failed') return
      toast.show(t('resetFailed'), 'error')
    }
  }

  return (
    <div className="settings">
      <AppBar title={t('title')} />
      <div className="ui-page settings__body">
        <section className="settings__section">
          <h2 className="settings__heading">{t('secGeneral')}</h2>
          {/* A vertical list, not a Segmented: 日本語 (β) does not fit a third of 320px. */}
          <Card padding="none">
            <span id="settings-lang-label" className="settings__lang-label t-body2 t-dim">
              {t('language')}
            </span>
            <div role="radiogroup" aria-labelledby="settings-lang-label" ref={langGroup} onKeyDown={langKeyDown}>
              {langs.map((l, i, all) => (
                <ListRow
                  key={l}
                  className="settings__lang-row"
                  title={langLabel(l)}
                  checked={settings.lang === l}
                  tabIndex={l === langChecked ? 0 : -1}
                  trailing={settings.lang === l ? <IconCheck size={20} className="settings__lang-check" /> : undefined}
                  divider={i < all.length - 1}
                  onClick={() => chooseLang(l)}
                />
              ))}
            </div>
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
              <Button variant="secondary" size="sm" leading={<IconCopy size={16} />} disabled={!npub} onClick={() => void copyNpub()}>
                {t('copy')}
              </Button>
            </div>
            {/* Only an identity this app made keeps its words; a restored one has none to show. */}
            {hasWords && (
              <>
                <div className="settings__divider" />
                <div className="settings__action">
                  <Button variant="secondary" fullWidth onClick={() => setWordsOpen(true)}>
                    {t('secretWords')}
                  </Button>
                </div>
              </>
            )}
          </Card>
        </section>

        {/* Where I receive bitcoin: the Lightning address the trade room uses. */}
        <section className="settings__section">
          <h2 className="settings__heading">{t('secReceive')}</h2>
          <LightningAddressSetting />
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
            {/* Only a real lock locks again; the development 'none' has nothing to time. */}
            {lock?.method !== 'none' && (
              <>
                <div className="settings__divider" />
                <div className="settings__relock">
                  <span className="t-caption t-dim" aria-hidden>
                    {t('relockTitle')}
                  </span>
                  <Segmented
                    size="sm"
                    ariaLabel={t('relockTitle')}
                    options={RELOCK_MINUTES.map((m) => ({ value: String(m), label: t('relockMin', { n: m }) }))}
                    value={String(settings.relockMinutes)}
                    onChange={chooseRelock}
                  />
                  <p className="t-caption t-dim">{t('relockHelp')}</p>
                </div>
              </>
            )}
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
          <h2 className="settings__heading">{t('secSupport')}</h2>
          <Card>
            <div className="settings__action">
              <p className="t-body2">{t('supportBody')}</p>
              <CopyLogButton fullWidth />
              <p className="t-caption t-dim num">{t('supportVersion', { v: APP_VERSION })}</p>
            </div>
          </Card>
        </section>

        <section className="settings__section">
          <h2 className="settings__heading">{t('secDanger')}</h2>
          <Card>
            <div className="settings__action">
              <Button variant="danger" fullWidth loading={resetting} leading={<IconTrash size={18} />} onClick={() => setResetOpen(true)}>
                {t('reset')}
              </Button>
              <p className="t-caption t-dim">{t('resetHelp')}</p>
            </div>
          </Card>
        </section>

        {/* Relays are nothing to look after: folded at the very bottom. */}
        <section className="settings__section">
          <h2 className="settings__heading">{t('secAdvanced')}</h2>
          <Card padding="none">
            <ListRow title={t('relayRow')} chevron expanded={relaysOpen} onClick={() => setRelaysOpen((o) => !o)} />
          </Card>
          {relaysOpen && <RelaySettings status={relays} />}
        </section>
      </div>

      {/* The 12 words and a lock change both prove the current lock first. */}
      <BottomSheet open={wordsOpen} onClose={() => setWordsOpen(false)} title={t('wordsSheetTitle')}>
        {wordsOpen && (
          <ReauthGate>
            <SecretWords warn={t('wordsSheetWarn')} phishing={tLock('wordsPhishing')} close={t('close')} onClose={() => setWordsOpen(false)} />
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

      <Dialog open={resetOpen} tone="danger" title={t('resetTitle')} confirmLabel={t('resetConfirm')} onConfirm={() => void confirmReset()} onCancel={() => setResetOpen(false)}>
        {t('resetBody')}
      </Dialog>
    </div>
  )
}
