import { TextField } from '../../ui'
import './lock.css'

/**
 * The 6-digit PIN field of the lock screens (unlock, lock chooser, re-check). On Android
 * (Chrome 156) a `type="password"` field made the browser's password
 * manager treat the PIN as a login: it offered other sites' saved passwords and asked to
 * save the PIN into the synced password manager. So the PIN is not a
 * credential to the browser.
 *
 * - `type="text"` with `inputmode="numeric"` (the number pad) and the dots drawn by CSS
 *   (`-webkit-text-security: disc`, lock.css `.lock-pin`). No `<form>`, no submit.
 * - `autocomplete="off"` and a name that no password manager reads as a login field.
 *   Not `one-time-code`: that asks the phone to offer codes from text messages.
 * - Where the browser cannot draw the dots (CSS.supports says no), the field falls back
 *   to `type="password"`: a PIN in plain sight is worse than a save prompt.
 *
 * scripts/check-storage.ts ("PIN fields") holds every PIN field of src/ to this.
 */
export const PIN_FIELD_NAME = 'ilchon-lock-digits'

/** The browser can mask a text field (all Chromium and WebKit browsers; Firefox may not). */
export function canMaskText(): boolean {
  try {
    return typeof CSS !== 'undefined' && typeof CSS.supports === 'function' && CSS.supports('-webkit-text-security', 'disc')
  } catch {
    return false
  }
}

const MASKED = canMaskText()

export interface PinFieldProps {
  label: string
  value: string
  onChange: (value: string) => void
  onEnter?: () => void
  error?: string | null
  disabled?: boolean
  autoFocus?: boolean
}

export function PinField({ label, value, onChange, onEnter, error, disabled, autoFocus }: PinFieldProps) {
  return (
    <TextField
      className="lock-pin"
      type={MASKED ? 'text' : 'password'}
      inputMode="numeric"
      maxLength={6}
      name={PIN_FIELD_NAME}
      label={label}
      value={value}
      onChange={(v) => onChange(v)}
      autoComplete="off"
      autoCorrect="off"
      autoCapitalize="off"
      spellCheck={false}
      error={error}
      disabled={disabled}
      autoFocus={autoFocus}
      onEnter={onEnter}
    />
  )
}
