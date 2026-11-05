import { useCallback, useEffect, useRef, useState } from 'react'
import { CODE_DISPLAY_MS, type ConnectPhase, type ConnectState } from '../../contracts'
import { actions, engine, useIlchon } from '../../engine/browser'
import { decodePayload } from '../../lib/connect'
import { useT } from '../../i18n'
import {
  AppBar,
  Button,
  cx,
  EmptyState,
  IconButton,
  IconCheck,
  IconClose,
  IconCopy,
  IconQr,
  IconWarning,
  Segmented,
  Spinner,
  TextField,
  useToast,
} from '../../ui'
import { QrCode, QrScanner } from '../../ui/qr'
import { NS } from './strings'
import './connect.css'

export interface ConnectScreenProps {
  onClose: () => void
}

type View = 'mine' | 'scan'
type StepState = 'todo' | 'waiting' | 'done'

const NAME_MAX = 24

const CAMERA_ERRORS: Record<string, string> = {
  'Camera needs https': 'camHttps',
  'Camera permission denied': 'camDenied',
  'No camera found': 'camNone',
  'Camera is in use': 'camBusy',
}

function qrSize(): number {
  const w = typeof window === 'undefined' ? 360 : window.innerWidth
  return Math.max(200, Math.min(300, w - 96))
}

async function copyText(text: string): Promise<boolean> {
  try {
    if (navigator.clipboard?.writeText) {
      await navigator.clipboard.writeText(text)
      return true
    }
  } catch {
    // fall through to the legacy path
  }
  try {
    const ta = document.createElement('textarea')
    ta.value = text
    ta.setAttribute('readonly', '')
    ta.style.position = 'fixed'
    ta.style.opacity = '0'
    document.body.appendChild(ta)
    ta.select()
    const ok = document.execCommand('copy')
    document.body.removeChild(ta)
    return ok
  } catch {
    return false
  }
}

export function ConnectScreen({ onClose }: ConnectScreenProps) {
  const t = useT(NS)
  const toast = useToast()
  const connect = useIlchon((s) => s.connect)
  const phase = connect.phase

  const [view, setView] = useState<View>('mine')
  const [size] = useState(qrSize)
  const [camError, setCamError] = useState<string | null>(null)
  const [pasteText, setPasteText] = useState('')
  const [submitting, setSubmitting] = useState(false)
  /** i18n key of a scan or paste that was refused before reaching the engine. */
  const [scanError, setScanError] = useState<string | null>(null)
  const submittingRef = useRef(false)

  const hasMe = useIlchon((s) => s.me !== null)

  useEffect(() => {
    actions.startConnect()
    return () => actions.cancelConnect()
  }, [])

  // Opened before the engine finished booting: start once my key exists.
  useEffect(() => {
    if (hasMe && phase === 'idle') actions.startConnect()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [hasMe])

  // After I scan the peer, show my QR so the peer can scan me.
  const prevPhase = useRef<ConnectPhase>(phase)
  useEffect(() => {
    if (phase === 'scanned' && prevPhase.current !== 'scanned') setView('mine')
    prevPhase.current = phase
  }, [phase])

  const submit = useCallback(
    async (text: string) => {
      const value = text.trim()
      if (!value || submittingRef.current) return
      // A bad, expired or own code only explains itself here; it must not end
      // the whole connect flow and rotate my own code.
      const parsed = decodePayload(value)
      const myPk = engine.store.getState().me?.pubkey
      const problem = !parsed ? 'invalid' : parsed.pk === myPk ? 'self' : parsed.exp < Date.now() ? 'expired' : null
      if (problem) {
        setScanError(`err.${problem}`)
        return
      }
      setScanError(null)
      submittingRef.current = true
      setSubmitting(true)
      try {
        await actions.submitScan(value)
        setPasteText('')
      } catch {
        toast.show(t('err.unknown'), 'error')
      } finally {
        submittingRef.current = false
        setSubmitting(false)
      }
    },
    [t, toast],
  )

  const onPaste = async () => {
    if (pasteText.trim()) {
      await submit(pasteText)
      return
    }
    let clip = ''
    try {
      clip = (await navigator.clipboard.readText()).trim()
    } catch {
      // clipboard read blocked: the user types instead
    }
    if (!clip) {
      toast.show(t('pasteEmpty'), 'warning')
      return
    }
    setPasteText(clip)
    await submit(clip)
  }

  const onCopy = async () => {
    // A fresh code, so the paste on the other side gets the full display window.
    actions.rotateConnectCode()
    const payload = engine.store.getState().connect.myPayload
    if (!payload) return
    const ok = await copyText(payload)
    toast.show(t(ok ? 'copied' : 'copyFailed'), ok ? 'success' : 'error')
  }

  const changeView = (v: View) => {
    setCamError(null)
    setScanError(null)
    setView(v)
  }

  const retry = () => {
    setView('mine')
    setCamError(null)
    setScanError(null)
    setPasteText('')
    actions.startConnect()
  }

  const exchanging = phase === 'showing' || phase === 'scanned'
  const step1: StepState = phase === 'done' ? 'done' : phase === 'scanned' || phase === 'linking' ? 'waiting' : 'todo'
  const step2: StepState = phase === 'scanned' || phase === 'linking' || phase === 'done' ? 'done' : 'todo'

  return (
    <div className="connect" role="dialog" aria-modal="true" aria-label={t('title')}>
      <AppBar
        title={t('title')}
        left={<IconButton icon={<IconClose />} label={t('close')} onClick={onClose} />}
      />

      <div className="connect__scroll">
        <div className="ui-page connect__page">
          {phase === 'idle' && (
            <div className="connect__status">
              <Spinner size={32} />
              <p className="t-body1 t-dim">{t('preparing')}</p>
            </div>
          )}

          {(exchanging || phase === 'linking') && (
            <>
              <p className="connect__lead t-body2 t-dim">{t('lead')}</p>
              <ol className="connect__steps">
                <Step n={1} label={t('step1')} state={step1} t={t} />
                <Step n={2} label={t('step2')} state={step2} t={t} />
              </ol>
            </>
          )}

          {exchanging && (
            <>
              <Segmented<View>
                ariaLabel={t('viewLabel')}
                value={view}
                onChange={changeView}
                options={[
                  { value: 'mine', label: t('tabMine') },
                  { value: 'scan', label: t('tabScan') },
                ]}
              />

              {view === 'mine' && (
                <MyQr connect={connect} size={size} scanned={phase === 'scanned'} onCopy={onCopy} />
              )}

              {view === 'scan' && phase === 'scanned' && (
                <div className="connect__panel connect__panel--note">
                  <span className="connect__okmark" aria-hidden>
                    <IconCheck size={28} />
                  </span>
                  <p className="t-body1">{t('scanDone')}</p>
                  <Button leading={<IconQr size={20} />} onClick={() => changeView('mine')}>
                    {t('goMine')}
                  </Button>
                </div>
              )}

              {view === 'scan' && phase === 'showing' && (
                <div className="connect__panel">
                  <div className="connect__scanner">
                    <QrScanner
                      active={!submitting}
                      onResult={submit}
                      onError={(m) => setCamError(CAMERA_ERRORS[m] ?? 'camUnavailable')}
                    />
                  </div>
                  <p
                    className={cx('connect__hint t-body2', camError || scanError ? 'connect__hint--warn' : 't-dim')}
                    role={camError || scanError ? 'alert' : undefined}
                  >
                    {scanError ? t(scanError) : camError ? t(camError) : t('scanHint')}
                  </p>

                  <div className="connect__paste">
                    <TextField
                      label={t('pasteLabel')}
                      value={pasteText}
                      onChange={(v) => {
                        setPasteText(v)
                        setScanError(null)
                      }}
                      placeholder={t('pastePlaceholder')}
                      helper={t('pasteHelper')}
                      error={scanError ? t(scanError) : null}
                      autoComplete="off"
                      autoCapitalize="off"
                      spellCheck={false}
                      onEnter={() => void submit(pasteText)}
                    />
                    <Button variant="secondary" fullWidth loading={submitting} onClick={onPaste}>
                      {pasteText.trim() ? t('pasteSubmit') : t('paste')}
                    </Button>
                  </div>
                </div>
              )}
            </>
          )}

          {phase === 'linking' && (
            <>
              <div className="connect__linking" role="status">
                <Spinner size={22} />
                <div className="ui-grow">
                  <p className="t-body1 t-bold">{t('linking')}</p>
                  <p className="t-body3 t-dim">{t('linkingBody')}</p>
                </div>
              </div>
              {/* The peer may still need my QR: the inviter links before being scanned. */}
              <MyQr connect={connect} size={size} scanned onCopy={onCopy} />
            </>
          )}

          {phase === 'done' && <Done contactId={connect.contactId} onClose={onClose} />}

          {phase === 'failed' && (
            <EmptyState
              icon={<IconWarning size={30} />}
              title={t('failedTitle')}
              body={t(`err.${connect.errorKey ?? 'unknown'}`)}
              action={
                <Button size="lg" onClick={retry}>
                  {t('retry')}
                </Button>
              }
            />
          )}
        </div>
      </div>
    </div>
  )
}

function Step({
  n,
  label,
  state,
  t,
}: {
  n: number
  label: string
  state: StepState
  t: (key: string) => string
}) {
  return (
    <li className={cx('connect__step', `is-${state}`)}>
      <span className="connect__step-mark num" aria-hidden>
        {state === 'done' ? <IconCheck size={16} strokeWidth={2.4} /> : n}
      </span>
      <span className="connect__step-label t-body1">{label}</span>
      <span className="connect__step-state t-body3">
        {state === 'done' ? t('stepDone') : state === 'waiting' ? t('stepWaiting') : t('stepTodo')}
      </span>
    </li>
  )
}

function MyQr({
  connect,
  size,
  scanned,
  onCopy,
}: {
  connect: ConnectState
  size: number
  scanned: boolean
  onCopy: () => void
}) {
  const t = useT(NS)
  return (
    <div className="connect__panel connect__panel--center">
      <p className={cx('connect__hint t-body2', scanned ? 'connect__hint--accent' : 't-dim')}>
        {scanned ? t('scannedHint') : t('mineHint')}
      </p>
      <div className="connect__qr" style={{ width: size, height: size }}>
        {connect.myPayload ? <QrCode text={connect.myPayload} size={size} /> : <Spinner />}
      </div>
      <Countdown expiresAt={connect.myCodeExpiresAt} />
      <Button
        variant="secondary"
        leading={<IconCopy size={18} />}
        disabled={!connect.myPayload}
        onClick={onCopy}
      >
        {t('copy')}
      </Button>
    </div>
  )
}

const RING_R = 15
const RING_C = 2 * Math.PI * RING_R

/** Ring + seconds for the current code. Asks the engine for a new code at zero. */
function Countdown({ expiresAt }: { expiresAt: number | undefined }) {
  const t = useT(NS)
  const [now, setNow] = useState(() => Date.now())
  const rotatedFor = useRef<number | null>(null)

  useEffect(() => {
    const id = window.setInterval(() => setNow(Date.now()), 200)
    return () => window.clearInterval(id)
  }, [])

  const left = expiresAt === undefined ? CODE_DISPLAY_MS : Math.max(0, expiresAt - now)

  useEffect(() => {
    if (expiresAt === undefined || left > 0) return
    // One request per code; the engine answers with a new myCodeExpiresAt.
    if (rotatedFor.current === expiresAt) return
    rotatedFor.current = expiresAt
    actions.rotateConnectCode()
  }, [expiresAt, left])

  const frac = Math.min(1, left / CODE_DISPLAY_MS)
  const seconds = Math.ceil(left / 1000)

  return (
    <div className="connect__timer" role="timer" aria-live="off">
      <svg className="connect__ring" width="40" height="40" viewBox="0 0 40 40" aria-hidden>
        <circle className="connect__ring-track" cx="20" cy="20" r={RING_R} />
        <circle
          className={cx('connect__ring-bar', seconds <= 5 && 'is-low')}
          cx="20"
          cy="20"
          r={RING_R}
          strokeDasharray={RING_C}
          strokeDashoffset={RING_C * (1 - frac)}
          transform="rotate(-90 20 20)"
        />
        <text className="connect__ring-num num" x="20" y="20" textAnchor="middle" dominantBaseline="central">
          {seconds}
        </text>
      </svg>
      <span className="t-body3 t-dim">{t('rotatesIn', { s: seconds })}</span>
    </div>
  )
}

function Done({ contactId, onClose }: { contactId: string | undefined; onClose: () => void }) {
  const t = useT(NS)
  const toast = useToast()
  const [name, setName] = useState('')
  const [saving, setSaving] = useState(false)

  const finish = async () => {
    const value = name.trim()
    if (saving) return
    if (value && contactId) {
      setSaving(true)
      try {
        await actions.renameContact(contactId, value)
      } catch {
        setSaving(false)
        toast.show(t('saveFailed'), 'error')
        return
      }
    }
    onClose()
  }

  return (
    <div className="connect__done">
      <span className="connect__okmark connect__okmark--lg" aria-hidden>
        <IconCheck size={36} strokeWidth={2.2} />
      </span>
      <h2 className="t-h3">{t('doneTitle')}</h2>
      <p className="t-body2 t-dim connect__status-body">{t('doneBody')}</p>

      <div className="connect__done-form">
        <TextField
          label={t('nameLabel')}
          value={name}
          onChange={setName}
          placeholder={t('namePlaceholder')}
          helper={t('nameHelper')}
          maxLength={NAME_MAX}
          autoComplete="off"
          autoFocus
          onEnter={finish}
        />
        <Button fullWidth size="lg" loading={saving} onClick={finish}>
          {name.trim() ? t('saveAndClose') : t('skip')}
        </Button>
      </div>
    </div>
  )
}
