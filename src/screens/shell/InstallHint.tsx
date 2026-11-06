import { Button } from '../../ui'
import { useT } from '../../i18n'
import { isStandalone, platform, usePwaInstall } from '../../lib/pwa'
import './install-hint.css'
import './install-strings'

export function InstallHint({ compact }: { compact?: boolean }) {
  const t = useT('install')
  const { canPrompt, prompt, installed } = usePwaInstall()
  if (installed || isStandalone()) return null
  const p = platform()
  if (p === 'ios') {
    return (
      <div className={compact ? 'install-hint install-hint--compact' : 'install-hint'} role="note">
        <p className="install-hint__title t-bold">{t('iosTitle')}</p>
        <p className="install-hint__line">{t('iosStep')}</p>
        {!compact && <p className="install-hint__warn">{t('iosWarn')}</p>}
      </div>
    )
  }
  if (p === 'android' && canPrompt) {
    return (
      <div className={compact ? 'install-hint install-hint--compact' : 'install-hint'}>
        <p className="install-hint__line">{t('androidBody')}</p>
        <Button size="sm" variant="secondary" onClick={() => void prompt()}>
          {t('androidButton')}
        </Button>
      </div>
    )
  }
  return null
}
