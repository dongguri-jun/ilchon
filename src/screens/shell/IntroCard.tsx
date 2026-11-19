import { useState } from 'react'
import { memo } from '../../engine/browser'
import { useT } from '../../i18n'
import { Card, IconButton, IconClose } from '../../ui'

/** Closing the card is kept in the encrypted memo. */
const INTRO_KEY = 'intro'

/** One dismissible first-run card. Shown by the shell while there are no contacts. */
export function IntroCard() {
  const t = useT('shell')
  const [hidden, setHidden] = useState(() => memo.get(INTRO_KEY) === true)
  if (hidden) return null

  const dismiss = () => {
    setHidden(true)
    memo.set(INTRO_KEY, true)
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
