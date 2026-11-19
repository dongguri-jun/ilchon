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
  /** With onClick: the row opens and closes content below it (aria-expanded; the chevron turns down when open). */
  expanded?: boolean
  /** Bottom hairline divider. */
  divider?: boolean
  disabled?: boolean
  /** With onClick: the row is one choice of a radio group (role radio, aria-checked). */
  checked?: boolean
  /** With onClick: the button's tabIndex (a radio group keeps only the checked row in the Tab order). */
  tabIndex?: number
  className?: string
}

export function ListRow({ leading, title, subtitle, trailing, onClick, chevron, expanded, divider, disabled, checked, tabIndex, className }: ListRowProps) {
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
      <button
        type="button"
        className={cls}
        onClick={onClick}
        disabled={disabled}
        role={checked === undefined ? undefined : 'radio'}
        aria-checked={checked}
        aria-expanded={expanded}
        tabIndex={tabIndex}
      >
        {body}
      </button>
    )
  }
  return <div className={cls}>{body}</div>
}
