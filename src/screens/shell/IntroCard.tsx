import { useState } from 'react'
import { useT } from '../../i18n'
import { Card, IconButton, IconClose } from '../../ui'

const KEY = 'ilchon:intro-dismissed'

function wasDismissed(): boolean {
  try {
    return localStorage.getItem(KEY) === '1'
  } catch {
    return false
  }
}

/** One dismissible first-run card. Shown by the shell while there are no contacts. */
export function IntroCard() {
  const t = useT('shell')
  const [hidden, setHidden] = useState(wasDismissed)
  if (hidden) return null

  const dismiss = () => {
    setHidden(true)
    try {
      localStorage.setItem(KEY, '1')
    } catch {
      // Private mode: the card simply comes back next time.
    }
  }

  return (
    <div className="ui-page shell-intro">
      <Card tone="primary">
        <div className="shell-intro__head">
          <h2 className="t-body1 t-bold">{t('introTitle')}</h2>
          <IconButton icon={<IconClose size={20} />} label={t('introDismiss')} size="sm" onClick={dismiss} />
        </div>
        <ol className="shell-intro__list t-body2">
          <li>{t('intro1')}</li>
          <li>{t('intro2')}</li>
          <li>{t('intro3')}</li>
        </ol>
      </Card>
    </div>
  )
}
