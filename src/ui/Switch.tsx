import { cx } from './cx'
import './Switch.css'

export interface SwitchProps {
  checked: boolean
  onChange: (checked: boolean) => void
  disabled?: boolean
  /** Accessible name (required unless labelled externally via aria-labelledby). */
  label?: string
  id?: string
  className?: string
}

export function Switch({ checked, onChange, disabled, label, id, className }: SwitchProps) {
  return (
    <button
      type="button"
      role="switch"
      id={id}
      aria-checked={checked}
      aria-label={label}
      disabled={disabled}
      className={cx('ui-switch', checked && 'is-on', className)}
      onClick={() => onChange(!checked)}
    >
      <span className="ui-switch__thumb" />
    </button>
  )
}
