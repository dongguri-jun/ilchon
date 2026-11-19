import type { ReactNode } from 'react'
import { cx } from './cx'
import './Chip.css'

export interface ChipProps {
  children: ReactNode
  /** Selected state. Selected chips use the accent color and bold text. */
  selected?: boolean
  /** When given, the chip is a toggle button. Without it, a static label. */
  onClick?: () => void
  disabled?: boolean
  /** Optional icon before the label. */
  icon?: ReactNode
  className?: string
}

export function Chip({ children, selected, onClick, disabled, icon, className }: ChipProps) {
  const cls = cx('ui-chip', selected && 'is-selected', disabled && 'is-disabled', className)
  const inner = (
    <>
      {icon}
      <span className="ui-chip__label">{children}</span>
    </>
  )
  if (!onClick) return <span className={cls}>{inner}</span>
  return (
    <button type="button" className={cls} aria-pressed={!!selected} disabled={disabled} onClick={onClick}>
      {inner}
    </button>
  )
}
