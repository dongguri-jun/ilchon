import type { ReactNode } from 'react'
import { cx } from './cx'
import './BottomNav.css'

export interface BottomNavItem<T extends string = string> {
  value: T
  label: string
  icon: ReactNode
  /** Red dot (true) or a count (number) on the icon. */
  badge?: boolean | number
}

export interface BottomNavProps<T extends string = string> {
  items: ReadonlyArray<BottomNavItem<T>>
  value: T
  onChange: (value: T) => void
  /** position: fixed to the bottom (default true). Pair pages with the .ui-has-nav class. */
  fixed?: boolean
  className?: string
}

export function BottomNav<T extends string = string>({
  items,
  value,
  onChange,
  fixed = true,
  className,
}: BottomNavProps<T>) {
  return (
    <nav className={cx('ui-nav', fixed && 'is-fixed', className)}>
      <div className="ui-nav__inner">
        {items.map((it) => {
          const active = it.value === value
          return (
            <button
              key={it.value}
              type="button"
              className={cx('ui-nav__item', active && 'is-active')}
              aria-current={active ? 'page' : undefined}
              onClick={() => onChange(it.value)}
            >
              <span className="ui-nav__icon">
                {it.icon}
                {it.badge ? (
                  <span className={cx('ui-nav__badge', typeof it.badge === 'number' && 'has-count')}>
                    {typeof it.badge === 'number' ? (it.badge > 99 ? '99+' : it.badge) : null}
                  </span>
                ) : null}
              </span>
              <span className="ui-nav__label">{it.label}</span>
            </button>
          )
        })}
      </div>
    </nav>
  )
}
