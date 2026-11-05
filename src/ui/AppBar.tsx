import type { ReactNode } from 'react'
import { cx } from './cx'
import { IconBack } from './icons'
import { IconButton } from './IconButton'
import { useT } from '../i18n'
import './strings'
import './AppBar.css'

export interface AppBarProps {
  title?: ReactNode
  /** Left slot. If omitted and onBack is given, a back button is shown. */
  left?: ReactNode
  /** Right slot: IconButtons, text buttons. */
  right?: ReactNode
  /** Convenience: renders a back IconButton in the left slot. */
  onBack?: () => void
  /** Hairline under the bar. */
  border?: boolean
  /** Stick to the top of the scroll container (default true). */
  sticky?: boolean
  className?: string
}

export function AppBar({ title, left, right, onBack, border, sticky = true, className }: AppBarProps) {
  const t = useT('ui')
  const leftNode =
    left ?? (onBack ? <IconButton icon={<IconBack />} label={t('back')} onClick={onBack} /> : null)
  return (
    <header className={cx('ui-appbar', sticky && 'is-sticky', border && 'has-border', className)}>
      <div className="ui-appbar__inner">
        <div className="ui-appbar__side ui-appbar__side--left">{leftNode}</div>
        <h1 className="ui-appbar__title">{title}</h1>
        <div className="ui-appbar__side ui-appbar__side--right">{right}</div>
      </div>
    </header>
  )
}
