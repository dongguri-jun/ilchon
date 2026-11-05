import { useT } from '../../i18n'

export function DemoBanner() {
  const t = useT('shell')
  return (
    <div className="shell-banner" role="note">
      <span className="shell-banner__text">{t('banner')}</span>
    </div>
  )
}
