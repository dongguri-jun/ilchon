import { useEffect, useId, useRef, useState } from 'react'
import { actions, useIlchon } from '../../engine/browser'
import { useT } from '../../i18n'
import type { LockChoice } from '../../contracts'
import { isStandalone, platform } from '../../lib/pwa'
import { wordProblems } from '../../lib/seed'
import { AppBar, Button, Card, IconChevronRight, TextField } from '../../ui'
import { DemoBanner } from '../shell/DemoBanner'
import { isInAppBrowser } from '../shell/device'
import { InstallGuide, type InstallGuideKind } from '../shell/InstallGuide'
import { InstallHint } from '../shell/InstallHint'
import { restoreAfterReset } from './after-reset'
import { createSetupHistory, isSetupMark } from '../shell/overlay-history'
import { initialSetup, lockSubmitKind, nextSetup, setupPop, type SetupEvent, type SetupFlow } from './setup-flow'
import { LockChooser } from './LockChooser'
import { errorCode, errorKey, typedUnknown } from './util'
import { WordGrid } from './WordGrid'
import './strings'
import './lock.css'

/** What the restore field shows under it: a check of the words, an engine error, or "not found". */
type RestoreNote = { key: string; vars?: Record<string, string | number> } | null

/** Engine errors of the restore that send the user back to the words. */
const BACK_TO_WORDS = new Set(['invalid-mnemonic', 'network', 'not-checked'])

/**
 * First run. "Start fresh" shows the 12 words of the new key, the user
 * ticks that they wrote them down, then picks the lock. "Restore with 12 words" takes
 * the words, looks for the contact list on the list relays, then picks the lock; the
 * key and the list are stored together then. Nothing is stored before the lock is made.
 */
export function SetupScreen() {
  const t = useT('lock')
  const passkeySupported = useIlchon((s) => s.lock.passkeySupported ?? null)
  // After the stop screen's reset (the same words were restored on another device) the restore step comes first.
  // The step and the path move together (setup-flow.ts): the lock submits as the path the user is on.
  const [flow, setFlow] = useState<SetupFlow>(() => initialSetup(restoreAfterReset()))
  const { step, mode } = flow
  const go = (ev: SetupEvent) => setFlow((f) => nextSetup(f, ev))
  const [words, setWords] = useState<string[]>([])
  const [saved, setSaved] = useState(false)
  const [text, setText] = useState('')
  const [note, setNote] = useState<RestoreNote>(null)
  const [notFound, setNotFound] = useState(false)
  const [checking, setChecking] = useState(false)
  /** The last check failed for the network: the same words are checked again once the browser is online. */
  const [offline, setOffline] = useState(false)
  const fieldId = useId()

  // In a browser inside another app a key is not made at all:
  // its storage is not Safari's or Chrome's, so the key would seem lost later. The iOS guide
  // can be skipped; it is asked again on the next visit while there is no key yet.
  const [guide, setGuide] = useState<InstallGuideKind | null>(() => {
    if (isStandalone()) return null
    if (isInAppBrowser(navigator.userAgent)) return 'inapp'
    return platform() === 'ios' ? 'ios' : null
  })

  // The words step has one history entry, so the system back returns to
  // the start with the same words instead of leaving the app (and making a new key on return).
  const [setupHistory] = useState(() => createSetupHistory(window.history))
  const hasWords = useRef(false)
  hasWords.current = words.length > 0
  useEffect(() => {
    const onPop = (e: PopStateEvent) => {
      const onEntry = isSetupMark(e.state)
      setFlow((f) => {
        const ev = setupPop(f, onEntry, hasWords.current)
        return ev ? nextSetup(f, ev) : f
      })
    }
    window.addEventListener('popstate', onPop)
    return () => window.removeEventListener('popstate', onPop)
  }, [])

  const startNew = () => {
    // The same words until the page reloads (the engine keeps them until the lock is made).
    setWords(actions.prepareIdentity())
    setSaved(false)
    setupHistory.enter()
    go('new')
  }

  const startRestore = () => go('restore')

  const editText = (value: string) => {
    setText(value)
    setNote(null)
    setNotFound(false)
    setOffline(false)
  }

  /** The words go to the engine only once there are 12 and all are in the list. */
  const check = async () => {
    if (checking) return
    setNote(null)
    setNotFound(false)
    setOffline(false)
    const problems = wordProblems(text)
    if (problems.count !== 12) return setNote({ key: 'restoreCount', vars: { n: problems.count } })
    if (problems.unknown.length)
      return setNote({ key: problems.unknown.length > 1 ? 'restoreUnknownMany' : 'restoreUnknown', vars: { list: problems.unknown.join(', ') } })
    setChecking(true)
    try {
      const { found } = await actions.checkMnemonic(text)
      if (found) go('lock')
      else setNotFound(true)
    } catch (e) {
      if (errorCode(e) === 'busy') return
      setNote({ key: errorKey(e) })
      if (errorCode(e) === 'network') setOffline(true)
    } finally {
      setChecking(false)
    }
  }

  // Once the connection is back the check goes on by itself, with the same words.
  useEffect(() => {
    if (!offline || step !== 'restore') return
    const onOnline = () => void check()
    window.addEventListener('online', onOnline, { once: true })
    return () => window.removeEventListener('online', onOnline)
    // check reads the current words; a change of them clears `offline` first.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [offline, step, text])

  // Each finished word is checked against the list as it is typed; Next still checks them all.
  const unknownNow = typedUnknown(text)
  const fieldNote = note && !notFound ? t(note.key, note.vars) : unknownNow.length ? t(unknownNow.length > 1 ? 'restoreNotInListMany' : 'restoreNotInList', { list: unknownNow.join(', ') }) : null

  // The "not found" result could appear behind the open keyboard. When it
  // appears the field lets go of the keyboard and the result scrolls into view, once more
  // after the keyboard has closed (the visual viewport grows back).
  const resultRef = useRef<HTMLDivElement>(null)
  useEffect(() => {
    if (!notFound) return
    const field = document.getElementById(fieldId)
    if (field && document.activeElement === field) field.blur()
    const show = () => resultRef.current?.scrollIntoView({ block: 'end', behavior: 'smooth' })
    const frame = requestAnimationFrame(show)
    const vv = window.visualViewport
    vv?.addEventListener('resize', show)
    const stop = setTimeout(() => vv?.removeEventListener('resize', show), 1_000)
    return () => {
      cancelAnimationFrame(frame)
      clearTimeout(stop)
      vv?.removeEventListener('resize', show)
    }
  }, [notFound, fieldId])

  const retype = () => {
    setNotFound(false)
    document.getElementById(fieldId)?.focus()
  }

  const submit = async (choice: LockChoice) => {
    if (lockSubmitKind(flow) === 'create') {
      await actions.createIdentity(choice)
      return setupHistory.done()
    }
    try {
      await actions.restoreIdentity(text, choice)
      setupHistory.done()
    } catch (e) {
      // Back to the words with the reason (the lock chooser shows the rest itself).
      if (!BACK_TO_WORDS.has(errorCode(e))) throw e
      setNote({ key: errorKey(e) })
      if (errorCode(e) === 'network') setOffline(true)
      go('restore')
    }
  }

  // The app bar's back on the words takes the entry with it; its popstate goes to the start.
  const back = () => {
    if (step === 'words' && setupHistory.leave()) return
    go('back')
  }

  return (
    <div className="shell">
      <DemoBanner />
      <main className="lock-screen">
        {step !== 'start' && <AppBar onBack={back} />}
        <div className="ui-page lock-body">
          {step === 'start' && guide && (
            <InstallGuide kind={guide} onContinue={guide === 'inapp' ? undefined : () => setGuide(null)} />
          )}

          {step === 'start' && !guide && (
            <>
              <InstallHint />
              <header className="lock-head">
                <h1 className="lock-name"><img className="lock-logo" src="/brand/ilchon-logo-860.png" alt="ilchon" width={153} height={36} /></h1>
                <p className="t-body1 t-dim">{t('setupIntro')}</p>
              </header>
              <div className="ui-stack">
                <Card onClick={startNew}>
                  <div className="lock-path">
                    <div className="ui-grow">
                      <div className="t-body1 t-bold">{t('pathNew')}</div>
                      <div className="t-caption t-dim">{t('pathNewHelp')}</div>
                    </div>
                    <IconChevronRight size={20} />
                  </div>
                </Card>
                <Card onClick={startRestore}>
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
              <header className="lock-head lock-head--left">
                <h1 className="t-h3">{t('restoreTitle')}</h1>
              </header>
              <TextField
                id={fieldId}
                label={t('restoreField')}
                value={text}
                onChange={editText}
                multiline
                rows={4}
                autoComplete="off"
                autoCorrect="off"
                autoCapitalize="off"
                spellCheck={false}
                error={fieldNote}
                helper={t('restoreHelp')}
              />
              <p className="lock-warn t-body2">{t('wordsPhishing')}</p>
              {notFound ? (
                <div ref={resultRef} className="ui-stack lock-restore-result">
                  <p className="t-body2" role="alert">{t('restoreNotFound')}</p>
                  <Button size="lg" fullWidth onClick={retype}>
                    {t('restoreRetype')}
                  </Button>
                  <Button size="lg" fullWidth variant="ghost" onClick={() => go('lock')}>
                    {t('restoreContinue')}
                  </Button>
                </div>
              ) : (
                <Button size="lg" fullWidth loading={checking} onClick={() => void check()}>
                  {t('next')}
                </Button>
              )}
            </div>
          )}

          {step === 'words' && (
            <div className="ui-stack">
              <header className="lock-head lock-head--left">
                <h1 className="t-h3">{t('wordsTitle')}</h1>
                <p className="t-body2 t-dim">{t('wordsBody')}</p>
              </header>
              <WordGrid words={words} />
              <p className="lock-warn t-body2">{t('wordsPhishing')}</p>
              <label className="lock-check t-body1">
                <input type="checkbox" checked={saved} onChange={(e) => setSaved(e.target.checked)} />
                <span>{t('wordsSaved')}</span>
              </label>
              <Button size="lg" fullWidth disabled={!saved} onClick={() => go('lock')}>
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
              <LockChooser passkeySupported={passkeySupported} submitLabel={t('lockAction')} noneLabel={t('startNoLockDev')} onSubmit={submit} />
            </div>
          )}
        </div>
      </main>
    </div>
  )
}
