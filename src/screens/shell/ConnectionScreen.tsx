import { useEffect, useLayoutEffect, useRef, useState, useSyncExternalStore, type RefObject } from 'react'
import { useIlchon } from '../../engine/browser'
import { useT } from '../../i18n'
import { BottomSheet, Button, Spinner } from '../../ui'
import { RelaySettings } from '../settings/RelaySettings'
import { CopyLogButton } from './CopyLogButton'
import { DemoBanner } from './DemoBanner'
import { ConnectionProblemGate, problemKind } from './connection-problem'

/**
 * The connection screen: the one thing the
 * app shows while it cannot reach its relays. No relay names, no counts, no
 * "try again": it continues by itself once connected.
 *
 *   mode 'boot'   boot 'starting': opening, or waiting for the first connection.
 *   mode 'cover'  boot 'ready': covers the app while the connection is gone. The app
 *                 underneath stays mounted (made inert by App), so the open room, the
 *                 draft and an open sheet are all still there when it comes back.
 *                 Sheets and dialogs live in portals on document.body, outside App:
 *                 the cover makes those inert too and takes the focus (useCoverInert),
 *                 all but the portals marked data-above-cover (the strict-mode relay
 *                 sheet and its dialogs).
 *
 * Strict mode (my own relays, "Don't switch automatically"): with the
 * problem shown, one line says so and [Relay settings] opens the relay card in a sheet,
 * so a user who chose this is never stuck. Automatic mode has neither: relays are
 * nothing for the user to look after there.
 */

/** The boot screen adds "this is taking a little longer" after this long. */
const BOOT_SLOW_MS = 20_000

function subscribeOnline(cb: () => void): () => void {
  window.addEventListener('online', cb)
  window.addEventListener('offline', cb)
  return () => {
    window.removeEventListener('online', cb)
    window.removeEventListener('offline', cb)
  }
}

/**
 * Whether the connection problem is shown now (ConnectionProblemGate): offline for 3 s,
 * or my relays (known once the transport exists) all without a socket for 10 s. Once
 * shown it stays until the browser is online and a relay of mine is connected; hiding
 * the page or a relay retry does not take it down (the boot screen does not flicker
 * back, the relay sheet above it stays open).
 */
export function useConnectionProblem(): boolean {
  const online = useSyncExternalStore(subscribeOnline, () => navigator.onLine !== false)
  const kind = useIlchon((s) => problemKind(online, s.relays))
  const [shown, setShown] = useState(false)
  const [gate, setGate] = useState<ConnectionProblemGate | null>(null)

  useEffect(() => {
    const g = new ConnectionProblemGate(setShown, !document.hidden)
    const onVisibility = () => g.setVisible(!document.hidden)
    document.addEventListener('visibilitychange', onVisibility)
    setGate(g)
    return () => {
      document.removeEventListener('visibilitychange', onVisibility)
      g.dispose()
    }
  }, [])

  useEffect(() => {
    gate?.setKind(kind)
  }, [gate, kind])

  return kind !== null && shown
}

/**
 * While the cover shows: every other child of document.body (the portals of sheets and
 * dialogs, also one that opens meanwhile) is inert, except the portals marked
 * data-above-cover (the relay sheet opened from the cover and its dialogs, and
 * the toast region, which is above the cover by z-index), and the focus moves to
 * the cover, so a field of an open sheet loses it (a phone drops its keyboard) and no
 * key or screen reader reaches what is covered. When it goes: each element gets back
 * its own inert, and the focus goes back where it was. Nothing is unmounted, so what
 * was typed stays.
 */
function useCoverInert(active: boolean, coverRef: RefObject<HTMLElement | null>): void {
  useLayoutEffect(() => {
    const cover = coverRef.current
    if (!active || !cover) return
    let appRoot: HTMLElement = cover
    while (appRoot.parentElement && appRoot.parentElement !== document.body) appRoot = appRoot.parentElement
    const before = new Map<HTMLElement, boolean>()
    const hide = (el: Element) => {
      if (!(el instanceof HTMLElement) || el === appRoot || before.has(el) || el.tagName === 'SCRIPT') return
      if (el.hasAttribute('data-above-cover')) return
      before.set(el, el.inert)
      el.inert = true
    }
    for (const el of Array.from(document.body.children)) hide(el)
    const watch = new MutationObserver((records) => {
      for (const r of records)
        r.addedNodes.forEach((n) => {
          if (n instanceof Element) hide(n)
        })
    })
    watch.observe(document.body, { childList: true })
    const focused = document.activeElement instanceof HTMLElement && document.activeElement !== document.body ? document.activeElement : null
    cover.focus({ preventScroll: true })
    return () => {
      watch.disconnect()
      for (const [el, was] of before) el.inert = was
      if (focused?.isConnected && !focused.closest('[inert]')) focused.focus({ preventScroll: true })
    }
  }, [active, coverRef])
}

/**
 * The cover's logo while offline. With no service worker,
 * an image the browser has to revalidate cannot load once the connection is gone (the dev
 * server marks it no-cache, so a cover mounted then showed a broken image). So the cover
 * keeps one logo element mounted, out of sight, from the time the app opens: it loads
 * while online, and the same element is shown when the cover comes up. The path stays a
 * literal (no computed image source, check-csp H6): the small logo of the other screens
 * (check-a11y A4).
 */
function Logo() {
  return (
    <h1 className="shell-boot__name">
      <img src="/brand/ilchon-logo-860.png" alt="ilchon" width={153} height={36} style={{ display: 'block', width: 'auto', height: 36, maxWidth: '100%', objectFit: 'contain' }} />
    </h1>
  )
}

export function ConnectionScreen({ mode, problem: given }: { mode: 'boot' | 'cover'; problem?: boolean }) {
  const t = useT('shell')
  const own = useConnectionProblem()
  const problem = given ?? own
  const strict = useIlchon((s) => s.settings.relays !== null && !s.settings.relayAuto)
  const relays = useIlchon((s) => s.relays)
  const [sheetOpen, setSheetOpen] = useState(false)
  const [slow, setSlow] = useState(false)
  const coverRef = useRef<HTMLDivElement>(null)
  // Stays on while the relay sheet is open: the sheet and its dialogs are marked
  // data-above-cover and, with the toast region, the only portals left usable; the sheet
  // takes the focus itself.
  useCoverInert(mode === 'cover' && problem, coverRef)
  // The problem is over (the cover goes): the sheet does not come back with the next one.
  useEffect(() => {
    if (!problem) setSheetOpen(false)
  }, [problem])
  useEffect(() => {
    if (mode !== 'boot') return
    const timer = setTimeout(() => setSlow(true), BOOT_SLOW_MS)
    return () => clearTimeout(timer)
  }, [mode])

  // The cover with no problem: only its logo, hidden, so the image is loaded before it is
  // needed. Same element tree as the cover below, so React keeps that <img> when it shows.
  if (mode === 'cover' && !problem) {
    return (
      <div ref={coverRef} className="shell-conn shell-conn--cover" tabIndex={-1} style={{ display: 'none' }} aria-hidden>
        <div className="shell-boot" role="status" aria-live="polite">
          <Logo />
        </div>
      </div>
    )
  }

  const body = (
    <div className="shell-boot" role="status" aria-live="polite">
      <Logo />
      <Spinner size={28} />
      {problem ? (
        <>
          <p className="t-h3">{t('connTitle')}</p>
          <p className="t-body2 t-dim">{t('connBody')}</p>
          {strict && (
            <>
              <p className="t-body2 t-dim">{t('connStrict')}</p>
              <Button size="sm" variant="secondary" onClick={() => setSheetOpen(true)}>
                {t('connRelaySettings')}
              </Button>
            </>
          )}
        </>
      ) : (
        <>
          <p className="t-body2 t-dim">{t('bootLine')}</p>
          {slow && <p className="t-body2 t-dim">{t('bootSlow')}</p>}
        </>
      )}
      <div className="shell-conn__log">
        <CopyLogButton variant="ghost" />
      </div>
      {strict && (
        <BottomSheet open={sheetOpen && problem} onClose={() => setSheetOpen(false)} title={t('connRelaySettings')} aboveCover>
          <RelaySettings status={relays} aboveCover />
        </BottomSheet>
      )}
    </div>
  )

  if (mode === 'cover') {
    return (
      <div ref={coverRef} className="shell-conn shell-conn--cover" tabIndex={-1}>
        {body}
      </div>
    )
  }
  return (
    <div className="shell">
      <DemoBanner />
      {body}
    </div>
  )
}
