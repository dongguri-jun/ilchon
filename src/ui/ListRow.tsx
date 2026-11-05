import type { ReactNode } from 'react'
import { cx } from './cx'
import { IconChevronRight } from './icons'
import './ListRow.css'

export interface ListRowProps {
  /** Left slot: Avatar, icon, etc. */
  leading?: ReactNode
  title: ReactNode
  subtitle?: ReactNode
  /** Right slot: Badge, value, Switch, etc. */
  trailing?: ReactNode
  /** When given the whole row is a pressable button. */
  onClick?: () => void
  /** Show a chevron after trailing (use with onClick). */
  chevron?: boolean
  /** Bottom hairline divider. */
  divider?: boolean
  disabled?: boolean
  className?: string
}

export function ListRow({
  leading,
  title,
  subtitle,
  trailing,
  onClick,
  chevron,
  divider,
  disabled,
  className,
}: ListRowProps) {
  const cls = cx('ui-row-item', divider && 'has-divider', onClick && 'is-pressable', className)
  const body = (
    <>
      {leading != null && <span className="ui-row-item__leading">{leading}</span>}
      <span className="ui-row-item__main">
        <span className="ui-row-item__title">{title}</span>
        {subtitle != null && <span className="ui-row-item__subtitle">{subtitle}</span>}
      </span>
      {trailing != null && <span className="ui-row-item__trailing">{trailing}</span>}
      {chevron && <IconChevronRight className="ui-row-item__chevron" size={18} />}
    </>
  )
  if (onClick) {
    return (
      <button type="button" className={cls} onClick={onClick} disabled={disabled}>
        {body}
      </button>
    )
  }
  return <div className={cls}>{body}</div>
}
