import { cx } from './cx'
import { useT } from '../i18n'
import './strings'
import './Spinner.css'

export interface SpinnerProps {
  /** Pixel size, default 24. */
  size?: number
  /** accent = brand color, inherit = currentColor, dim = secondary text. */
  tone?: 'accent' | 'inherit' | 'dim'
  className?: string
}

export function Spinner({ size = 24, tone = 'accent', className }: SpinnerProps) {
  const t = useT('ui')
  return (
    <span
      className={cx('ui-spinner', `ui-spinner--${tone}`, className)}
      style={{ width: size, height: size, borderWidth: Math.max(2, Math.round(size / 10)) }}
      role="status"
      aria-label={t('loading')}
    />
  )
}
