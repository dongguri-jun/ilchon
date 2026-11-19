import { useT } from '../../i18n'
import { IconWarning } from '../../ui'
import { CopyLinkButton } from './CopyLinkButton'
import './install-hint.css'
import './install-strings'

export type InstallGuideKind = 'ios' | 'inapp'

/**
 * Takes over the setup screen where starting right here would likely lose the key.
 * Without `onContinue` there is no way past it (in-app browsers: no key is made there).
 */
export function InstallGuide({ kind, onContinue }: { kind: InstallGuideKind; onContinue?: () => void }) {
  const t = useT('install')
  const url = window.location.origin
  const inApp = kind === 'inapp'
  const steps = inApp ? ['inappStep1', 'inappStep2', 'inappStep3'] : ['iosStep1', 'iosStep2', 'iosStep3']
  return (
    <section className="install-guide">
      <img className="install-guide__logo" src="/brand/ilchon-logo-860.png" alt="ilchon" width={153} height={36} />
      <h1 className="t-h3">{t(inApp ? 'inappTitle' : 'iosTitle')}</h1>
      {inApp && <p className="t-body2 t-dim">{t('inappBody')}</p>}
      <ol className="install-guide__steps t-body1">
        {steps.map((key) => (
          <li key={key}>{t(key)}</li>
        ))}
      </ol>
      {inApp ? (
        <>
          <p className="install-url t-body2">{url}</p>
          <CopyLinkButton url={url} />
          <p className="t-caption t-dim">{t('inappMenuHint')}</p>
        </>
      ) : (
        <div className="install-guide__warn" role="note">
          <IconWarning size={18} />
          <span className="t-body2">{t('iosWarn')}</span>
        </div>
      )}
      {onContinue && (
        <button type="button" className="install-guide__skip t-body2" onClick={onContinue}>
          {t('iosContinue')}
        </button>
      )}
    </section>
  )
}
