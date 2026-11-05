import type { ReactNode } from 'react'
import { cx } from './cx'
import './EmptyState.css'

export interface EmptyStateProps {
  title: string
  body?: ReactNode
  /** Optional icon element shown above the title. */
  icon?: ReactNode
  /** Usually a <Button>. */
  action?: ReactNode
  className?: string
}

export function EmptyState({ title, body, icon, action, className }: EmptyStateProps) {
  return (
    <div className={cx('ui-empty', className)}>
      {icon && <div className="ui-empty__icon">{icon}</div>}
      <h2 className="ui-empty__title">{title}</h2>
      {body && <p className="ui-empty__body">{body}</p>}
      {action && <div className="ui-empty__action">{action}</div>}
    </div>
  )
}
