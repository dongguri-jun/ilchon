import { Component, type ErrorInfo, type ReactNode } from 'react'
import { getLang } from '../../i18n'
import { supportLog } from '../../lib/support-log/browser'
import { Button, IconWarning } from '../../ui'
import { CopyLogButton } from './CopyLogButton'
import { COPY } from './crash-copy'
import './shell.css'

/** The first component name of a React component stack ("\n    at Foo (…)" or "\n    in Foo"). */
function firstComponent(stack: string | null | undefined): string | undefined {
  const m = /\n\s*(?:at|in)\s+([A-Za-z0-9_$.]+)/.exec(stack ?? '')
  return m?.[1]
}

/**
 * Last resort for render errors. Offers a reload and "Copy log": nothing here may
 * touch stored keys.
 */
export class CrashBoundary extends Component<{ children: ReactNode }, { crashed: boolean }> {
  override state = { crashed: false }

  static getDerivedStateFromError() {
    return { crashed: true }
  }

  override componentDidCatch(error: unknown, info: ErrorInfo) {
    supportLog.error('screen', error, firstComponent(info.componentStack))
  }

  override render() {
    if (!this.state.crashed) return this.props.children
    // The screen language in memory: the browser's before unlock, the saved one after.
    const copy = COPY[getLang()] ?? COPY.en
    return (
      <div className="shell">
        <div className="shell-boot" role="alert">
          <span className="shell-boot__warn">
            <IconWarning size={32} />
          </span>
          <h1 className="t-h3">{copy.title}</h1>
          <p className="t-body2 t-dim">{copy.body}</p>
          <Button size="lg" onClick={() => window.location.reload()}>
            {copy.reload}
          </Button>
          <CopyLogButton size="lg" />
        </div>
      </div>
    )
  }
}
