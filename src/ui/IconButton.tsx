import type { ButtonHTMLAttributes, ReactNode } from 'react'
import { cx } from './cx'
import './IconButton.css'

export interface IconButtonProps extends Omit<ButtonHTMLAttributes<HTMLButtonElement>, 'children' | 'aria-label'> {
  /** The icon element, e.g. <IconPlus />. */
  icon: ReactNode
  /** Accessible name (required: there is no visible text). */
  label: string
  variant?: 'ghost' | 'filled' | 'primary'
  size?: 'sm' | 'md' | 'lg'
}

export function IconButton({
  icon,
  label,
  variant = 'ghost',
  size = 'md',
  type = 'button',
  className,
  ...rest
}: IconButtonProps) {
  return (
    <button
      {...rest}
      type={type}
      aria-label={label}
      title={rest.title ?? label}
      className={cx('ui-iconbtn', `ui-iconbtn--${variant}`, `ui-iconbtn--${size}`, className)}
    >
      {icon}
    </button>
  )
}
