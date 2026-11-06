import type { Lang } from '../../contracts'
import { actions, useIlchon } from '../../engine/browser'
import { getLang, setLang, useT } from '../../i18n'

export function DemoBanner() {
  const t = useT('shell')
  const boot = useIlchon((s) => s.boot)
  const lang = getLang()
  const switchLang = (next: Lang) => {
    setLang(next)
    if (boot === 'ready') void actions.setSettings({ lang: next }).catch(() => {
      // The engine updates settings immediately; the browser choice remains saved.
    })
  }
  return (
    <div className="shell-banner" role="note">
      <span className="shell-banner__text">{t('banner')}</span>
      <div className="shell-banner__languages" role="group" aria-label="언어 / Language">
        {(['ko', 'en'] as const).map((value) => (
          <button
            key={value}
            type="button"
            aria-label={value === 'ko' ? '한국어' : 'English'}
            aria-pressed={lang === value}
            onClick={() => switchLang(value)}
          >
            {value === 'ko' ? 'KO' : 'EN'}
          </button>
        ))}
      </div>
    </div>
  )
}
