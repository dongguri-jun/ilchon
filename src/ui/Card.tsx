import type { ReactNode } from 'react'
import { cx } from './cx'
import './Card.css'

export interface CardProps {
  children: ReactNode
  /** Inner padding: none | sm (12) | md (16/20, default) | lg (24). */
  padding?: 'none' | 'sm' | 'md' | 'lg'
  /** default = surface, outline = bordered, primary = lime tinted. */
  tone?: 'default' | 'outline' | 'primary'
  /** When given the card is a pressable button. */
  onClick?: () => void
  disabled?: boolean
  className?: string
}

export function Card({ children, padding = 'md', tone = 'default', onClick, disabled, className }: CardProps) {
  const cls = cx('ui-card', `ui-card--${tone}`, `ui-card--p-${padding}`, onClick && 'is-pressable', className)
  if (onClick) {
    return (
      <button type="button" className={cls} onClick={onClick} disabled={disabled}>
        {children}
      </button>
    )
  }
  return <div className={cls}>{children}</div>
}
