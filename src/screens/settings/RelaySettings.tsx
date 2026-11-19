import { Fragment, useMemo, useRef, useState } from 'react'
import { DEFAULT_RELAYS, type RelayStatus } from '../../contracts'
import { actions, useIlchon } from '../../engine/browser'
import { useT } from '../../i18n'
import { MAX_RELAYS, MIN_RELAYS, checkRelay, chosenRelayUrl, isDefaultList, normalizeRelayUrl, sharesDefault, type RelayCheck } from '../../lib/relays'
import { Badge, Button, Card, Dialog, IconButton, IconTrash, IconWarning, Switch, TextField, useToast } from '../../ui'
// Also shown from the connection screen (strict mode), where the settings screen's strings may not be loaded yet.
import './strings'

function relayHost(url: string): string {
  return url.replace(/^wss?:\/\//, '').replace(/\/$/, '')
}

/** The host with a line-break chance after each dot, so a long one wraps at a dot on a narrow phone. */
function RelayHost({ url }: { url: string }) {
  return (
    <>
      {relayHost(url)
        .split('.')
        .map((part, i) => (
          <Fragment key={i}>
            {i > 0 && (
              <>
                .<wbr />
              </>
            )}
            {part}
          </Fragment>
        ))}
    </>
  )
}

/**
 * Relay list for this profile (Settings → Advanced). Defaults are the
 * tested relays; users may add a public relay (with a NIP-11 pre-flight warning) or
 * remove one, keeping at least MIN_RELAYS. With a list of their own, "Don't switch
 * automatically" keeps the app waiting for those relays instead of using the defaults
 * while none of them answer. Changes are kept in the engine's settings
 * and apply after a restart, to my relay lists and to chats created from then on;
 * existing chats keep the relays they were made with. `aboveCover`: shown in the sheet
 * of the connection cover, so its dialogs go above the cover too.
 */
export function RelaySettings({ status, aboveCover }: { status: RelayStatus[]; aboveCover?: boolean }) {
  const t = useT('settings')
  const toast = useToast()
  const chosen = useIlchon((s) => s.settings.relays)
  const savedStrict = useIlchon((s) => !s.settings.relayAuto)
  const fallingBack = useIlchon((s) => s.fallingBack)
  const saved = useMemo(() => chosen ?? [...DEFAULT_RELAYS], [chosen])
  const [draft, setDraft] = useState<string[]>(saved)
  const [strictDraft, setStrictDraft] = useState(savedStrict)
  const [saving, setSaving] = useState(false)
  const [input, setInput] = useState('')
  const [inputError, setInputError] = useState<string | null>(null)
  const [checking, setChecking] = useState(false)
  const [pending, setPending] = useState<RelayCheck | null>(null)
  const [applyOpen, setApplyOpen] = useState(false)
  const [defaultsOpen, setDefaultsOpen] = useState(false)
  /** Only the latest check may open the dialog. */
  const checkId = useRef(0)

  // While the defaults stand in, the status is theirs, not the chosen relays': no badges.
  const connected = new Map(fallingBack ? [] : status.map((s) => [s.url, s.connected]))
  const draftIsDefault = isDefaultList(draft)
  // The switch only means something for a list of my own; the defaults have no fallback.
  const strictNow = draftIsDefault ? false : strictDraft
  const listChanged = draft.length !== saved.length || draft.some((url, i) => url !== saved[i])
  const changed = listChanged || strictNow !== savedStrict

  async function check() {
    if (checking) return
    if (!normalizeRelayUrl(input)) return setInputError(t('relayErrUrl'))
    const url = chosenRelayUrl(input)
    if (!url) return setInputError(t('relayErrHost'))
    if (draft.includes(url)) return setInputError(t('relayErrDup'))
    if (draft.length >= MAX_RELAYS) return setInputError(t('relayErrMax', { n: MAX_RELAYS }))
    setInputError(null)
    setChecking(true)
    const id = ++checkId.current
    try {
      const result = await checkRelay(url)
      if (id === checkId.current) setPending(result)
    } finally {
      setChecking(false)
    }
  }

  function addPending() {
    if (!pending) return
    if (draft.length >= MAX_RELAYS) {
      setPending(null)
      setInputError(t('relayErrMax', { n: MAX_RELAYS }))
      return
    }
    setDraft((d) => (d.includes(pending.url) ? d : [...d, pending.url]))
    setPending(null)
    setInput('')
  }

  async function apply() {
    if (saving) return
    setApplyOpen(false)
    setSaving(true)
    try {
      await actions.setSettings({ relays: draft, relayAuto: !strictNow })
    } catch (error) {
      setSaving(false)
      const code = error instanceof Error ? error.message : ''
      const key = code === 'too-few-relays' ? 'relayErrMin' : code === 'too-many-relays' ? 'relayErrMax' : 'relayErrSave'
      toast.show(t(key, { n: code === 'too-many-relays' ? MAX_RELAYS : MIN_RELAYS }), 'error')
      return
    }
    location.reload()
  }

  async function restoreDefaults() {
    if (saving) return
    setDefaultsOpen(false)
    setSaving(true)
    try {
      await actions.setSettings({ relays: null, relayAuto: true })
    } catch {
      setSaving(false)
      toast.show(t('relayErrSave'), 'error')
      return
    }
    location.reload()
  }

  return (
    <Card>
      {fallingBack && (
        <p className="settings__relay-alert t-caption">
          <IconWarning size={14} />
          <span>{t('relayFallbackNow')}</span>
        </p>
      )}
      <ul className="settings__relays">
        {draft.map((url) => {
          const isNew = !saved.includes(url)
          const on = connected.get(url)
          return (
            <li key={url} className="settings__relay">
              <span className="settings__relay-url t-body2">
                <RelayHost url={url} />
              </span>
              <span className="settings__relay-side">
                {isNew ? <Badge tone="info">{t('relayNew')}</Badge> : on === undefined ? null : <Badge tone={on ? 'success' : 'danger'}>{on ? t('relayOn') : t('relayOff')}</Badge>}
                <IconButton
                  icon={<IconTrash size={18} />}
                  label={t('relayRemove', { host: relayHost(url) })}
                  disabled={draft.length <= MIN_RELAYS}
                  onClick={() => setDraft((d) => d.filter((u) => u !== url))}
                />
              </span>
            </li>
          )
        })}
      </ul>
      {draft.length <= MIN_RELAYS && <p className="t-caption t-dim settings__relay-note">{t('relayMinNote', { n: MIN_RELAYS })}</p>}
      {!sharesDefault(draft) && (
        <p className="settings__relay-alert t-caption">
          <IconWarning size={14} />
          <span>{t('relayNoDefault')}</span>
        </p>
      )}

      <div className="settings__divider" />
      <div className="settings__relay-add">
        <TextField
          label={t('relayAddLabel')}
          value={input}
          onChange={(v) => {
            setInput(v)
            setInputError(null)
            // A check still running is for the old text: ignore its result.
            checkId.current++
          }}
          placeholder="wss://relay.example.com"
          inputMode="url"
          autoCapitalize="off"
          autoComplete="off"
          spellCheck={false}
          maxLength={200}
          error={inputError}
          onEnter={() => void check()}
        />
        <Button size="sm" variant="secondary" loading={checking} disabled={!input.trim()} onClick={() => void check()}>
          {t('relayCheck')}
        </Button>
      </div>
      <p className="t-caption t-dim settings__relay-note">{t('relayAddHelp')}</p>

      {!draftIsDefault && (
        <>
          <div className="settings__divider" />
          <div className="settings__toggle">
            <div className="ui-grow">
              <div className="t-body2 t-bold">{t('relayStrict')}</div>
              <p className="t-caption t-dim">{t('relayStrictHelp')}</p>
            </div>
            <Switch checked={strictDraft} onChange={setStrictDraft} label={t('relayStrict')} />
          </div>
        </>
      )}

      {(changed || !isDefaultList(saved)) && <div className="settings__divider" />}
      {changed && (
        <div className="settings__relay-apply">
          <p className="t-caption t-dim">{t('relayApplyNote')}</p>
          <Button size="sm" loading={saving} onClick={() => setApplyOpen(true)}>
            {t('relayApply')}
          </Button>
        </div>
      )}
      {!changed && !isDefaultList(saved) && (
        <Button size="sm" variant="ghost" loading={saving} onClick={() => setDefaultsOpen(true)}>
          {t('relayDefaults')}
        </Button>
      )}

      <Dialog
        aboveCover={aboveCover}
        open={pending !== null}
        title={pending ? relayHost(pending.url) : ''}
        confirmLabel={pending?.warnings.length ? t('relayAddAnyway') : t('relayAdd')}
        tone={pending?.warnings.length ? 'danger' : 'default'}
        onConfirm={addPending}
        onCancel={() => setPending(null)}
      >
        {pending && <RelayCheckView check={pending} />}
      </Dialog>

      <Dialog aboveCover={aboveCover} open={applyOpen} title={t('relayApplyTitle')} confirmLabel={t('relayApply')} onConfirm={() => void apply()} onCancel={() => setApplyOpen(false)}>
        {t('relayApplyBody')}
        {!sharesDefault(draft) && (
          <>
            <br />
            <br />
            {t('relayNoDefault')}
          </>
        )}
      </Dialog>

      <Dialog
        aboveCover={aboveCover}
        open={defaultsOpen}
        title={t('relayDefaultsTitle')}
        confirmLabel={t('relayDefaultsConfirm')}
        onConfirm={() => void restoreDefaults()}
        onCancel={() => setDefaultsOpen(false)}
      >
        {t('relayDefaultsBody')}
      </Dialog>
    </Card>
  )
}

function RelayCheckView({ check }: { check: RelayCheck }) {
  const t = useT('settings')
  return (
    <div className="settings__relay-check">
      {check.reachable && (
        <dl className="settings__relay-facts t-caption">
          {check.name && (
            <>
              <dt>{t('relayName')}</dt>
              <dd>{check.name}</dd>
            </>
          )}
          {check.software && (
            <>
              <dt>{t('relaySoftware')}</dt>
              <dd>{check.software}</dd>
            </>
          )}
          <dt>{t('relaySubs')}</dt>
          <dd>{check.maxSubscriptions ?? t('relayUnknown')}</dd>
          <dt>{t('relaySize')}</dt>
          <dd>{check.maxMessageLength !== null ? `${Math.round(check.maxMessageLength / 1024)} KB` : t('relayUnknown')}</dd>
        </dl>
      )}
      {check.warnings.length === 0 ? (
        <p className="t-body2">{t('relayCheckOk')}</p>
      ) : (
        <ul className="settings__relay-warnings">
          {check.warnings.map((w) => (
            <li key={w}>
              <IconWarning size={16} />
              <span>{t(`relayWarn_${w}`)}</span>
            </li>
          ))}
        </ul>
      )}
      <p className="t-caption t-dim">{t('relayCheckLimit')}</p>
    </div>
  )
}
