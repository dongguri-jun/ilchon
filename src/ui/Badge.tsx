import type { ReactNode } from 'react'
import { cx } from './cx'
import './Badge.css'

export type BadgeTone = 'neutral' | 'primary' | 'success' | 'warning' | 'danger' | 'info'

export interface BadgeProps {
  children: ReactNode
  tone?: BadgeTone
  /** Optional leading icon (use size 12-14). */
  icon?: ReactNode
  className?: string
}

export function Badge({ children, tone = 'neutral', icon, className }: BadgeProps) {
  return (
    <span className={cx('ui-badge', `ui-badge--${tone}`, className)}>
      {icon}
      {children}
    </span>
  )
}
