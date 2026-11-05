import type { CSSProperties, ReactNode } from 'react'
import { cx } from './cx'
import './Segmented.css'

export interface SegmentedOption<T extends string = string> {
  value: T
  label: ReactNode
  disabled?: boolean
}

export interface SegmentedProps<T extends string = string> {
  options: ReadonlyArray<SegmentedOption<T>>
  value: T
  onChange: (value: T) => void
  /** Stretch to the container width (default true). */
  fullWidth?: boolean
  /** md = 44px tall (default), sm = 36px. */
  size?: 'md' | 'sm'
  disabled?: boolean
  /** Accessible name of the group. */
  ariaLabel?: string
  className?: string
}

/** Coconut segmented control: gray track, dark sliding thumb. */
export function Segmented<T extends string = string>({
  options,
  value,
  onChange,
  fullWidth = true,
  size = 'md',
  disabled,
  ariaLabel,
  className,
}: SegmentedProps<T>) {
  const index = Math.max(
    0,
    options.findIndex((o) => o.value === value),
  )
  const style = { '--n': options.length, '--i': index } as CSSProperties
  return (
    <div
      className={cx('ui-seg', `ui-seg--${size}`, fullWidth && 'ui-seg--full', className)}
      role="radiogroup"
      aria-label={ariaLabel}
    >
      <div className="ui-seg__inner" style={style}>
        <span className="ui-seg__thumb" aria-hidden />
        {options.map((o) => {
          const selected = o.value === value
          return (
            <button
              key={o.value}
              type="button"
              role="radio"
              aria-checked={selected}
              disabled={disabled || o.disabled}
              className={cx('ui-seg__item', selected && 'is-selected')}
              onClick={() => {
                if (!selected) onChange(o.value)
              }}
            >
              <span className="ui-seg__label">{o.label}</span>
            </button>
          )
        })}
      </div>
    </div>
  )
}
