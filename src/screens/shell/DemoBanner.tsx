import { useId } from 'react'
import type { Lang } from '../../contracts'
import { actions } from '../../engine/browser'
import { setLang, useLang, useT } from '../../i18n'
import { LANG_GROUP_LABEL, langButtonLabel, langShort, offeredLangs } from '../../i18n/lang'

export function DemoBanner() {
  const t = useT('shell')
  const lang = useLang()
  const textId = useId()
  const switchLang = (next: Lang) => {
    setLang(next)
    // Every stage: before unlock the engine keeps it in memory and saves it once ready.
    void actions.setSettings({ lang: next }).catch(() => {
      // The engine updates settings immediately; the screen already switched.
    })
  }
  return (
    // A named region (landmark) so the notice and the language switch are not loose content.
    // Not a <header>: the room's and connect screen's app bars already are one.
    <section className="shell-banner" aria-labelledby={textId}>
      <span id={textId} className="shell-banner__text">
        {t('banner')}
      </span>
      <div className="shell-banner__languages" role="group" aria-label={LANG_GROUP_LABEL}>
        {offeredLangs().map((value) => (
          <button key={value} type="button" lang={value} aria-label={langButtonLabel(value)} aria-pressed={lang === value} onClick={() => switchLang(value)}>
            {langShort(value)}
          </button>
        ))}
      </div>
    </section>
  )
}
