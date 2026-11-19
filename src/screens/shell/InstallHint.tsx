import { Button } from '../../ui'
import { useT } from '../../i18n'
import { platform, usePwaInstall } from '../../lib/pwa'
import { isInAppBrowser } from './device'
import './install-hint.css'
import './install-strings'

/** Android only: iOS and in-app browsers get InstallGuide instead. */
export function InstallHint() {
  const t = useT('install')
  const { canPrompt, prompt, installed } = usePwaInstall()
  if (installed || platform() !== 'android' || isInAppBrowser(navigator.userAgent)) return null
  return (
    <div className="install-hint install-hint--compact" role="note">
      <p className="install-hint__line">{t('androidBody')}</p>
      {canPrompt ? (
        <Button size="sm" variant="secondary" onClick={() => void prompt()}>
          {t('androidButton')}
        </Button>
      ) : (
        <p className="install-hint__line">{t('androidManual')}</p>
      )}
    </div>
  )
}
