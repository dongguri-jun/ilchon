import type { ButtonHTMLAttributes, ReactNode } from 'react'
import { cx } from './cx'
import { Spinner } from './Spinner'
import './Button.css'

export type ButtonVariant = 'primary' | 'secondary' | 'ghost' | 'danger'
export type ButtonSize = 'sm' | 'md' | 'lg'

export interface ButtonProps extends Omit<ButtonHTMLAttributes<HTMLButtonElement>, 'children'> {
  variant?: ButtonVariant
  size?: ButtonSize
  fullWidth?: boolean
  /** Shows a spinner, keeps the width, and ignores clicks. */
  loading?: boolean
  /** Icon shown before the label. */
  leading?: ReactNode
  children?: ReactNode
}

export function Button({
  variant = 'primary',
  size = 'md',
  fullWidth,
  loading,
  leading,
  disabled,
  type = 'button',
  className,
  children,
  ...rest
}: ButtonProps) {
  const inactive = disabled || loading
  return (
    <button
      {...rest}
      type={type}
      disabled={inactive}
      aria-busy={loading || undefined}
      className={cx(
        'ui-btn',
        `ui-btn--${variant}`,
        `ui-btn--${size}`,
        fullWidth && 'ui-btn--full',
        loading && 'is-loading',
        className,
      )}
    >
      <span className="ui-btn__content">
        {leading}
        {children != null && <span className="ui-btn__label">{children}</span>}
      </span>
      {loading && (
        <span className="ui-btn__spinner">
          <Spinner size={size === 'lg' ? 22 : 18} tone="inherit" />
        </span>
      )}
    </button>
  )
}
