import { useId, type HTMLInputTypeAttribute, type KeyboardEvent, type ReactNode, type Ref } from 'react'
import { cx } from './cx'
import './TextField.css'

export interface TextFieldProps {
  value: string
  onChange: (value: string) => void
  label?: string
  placeholder?: string
  /** Virtual keyboard hint: 'numeric' | 'decimal' | 'text' | 'search' | ... */
  inputMode?: 'none' | 'text' | 'tel' | 'url' | 'email' | 'numeric' | 'decimal' | 'search'
  type?: HTMLInputTypeAttribute
  /** Node shown inside the box before the input (e.g. a currency symbol). */
  prefix?: ReactNode
  /** Node shown inside the box after the input (e.g. 'KRW', a button). */
  suffix?: ReactNode
  /** Error message. Truthy turns the border red and replaces helper. */
  error?: string | false | null
  helper?: ReactNode
  disabled?: boolean
  readOnly?: boolean
  autoFocus?: boolean
  autoComplete?: string
  autoCapitalize?: 'off' | 'none' | 'on' | 'sentences' | 'words' | 'characters'
  spellCheck?: boolean
  maxLength?: number
  name?: string
  id?: string
  /** Render a <textarea> instead of an <input>. */
  multiline?: boolean
  rows?: number
  /** Use the number font (SpaceGrotesk, tabular figures) for the value. */
  numeric?: boolean
  onBlur?: () => void
  onFocus?: () => void
  /** Called on Enter (single-line only). */
  onEnter?: () => void
  /** Ref to the <input> (single-line only). */
  inputRef?: Ref<HTMLInputElement>
  className?: string
}

export function TextField({
  value,
  onChange,
  label,
  placeholder,
  inputMode,
  type = 'text',
  prefix,
  suffix,
  error,
  helper,
  disabled,
  readOnly,
  autoFocus,
  autoComplete,
  autoCapitalize,
  spellCheck,
  maxLength,
  name,
  id,
  multiline,
  rows = 3,
  numeric,
  onBlur,
  onFocus,
  onEnter,
  inputRef,
  className,
}: TextFieldProps) {
  const auto = useId()
  const inputId = id ?? auto
  const msgId = `${inputId}-msg`
  const message = error || helper
  const common = {
    id: inputId,
    name,
    value,
    placeholder,
    disabled,
    readOnly,
    autoFocus,
    autoComplete,
    autoCapitalize,
    spellCheck,
    maxLength,
    onBlur,
    onFocus,
    'aria-invalid': error ? true : undefined,
    'aria-describedby': message ? msgId : undefined,
    className: cx('ui-field__input', numeric && 'num'),
  }
  const onKeyDown = (e: KeyboardEvent) => {
    if (e.key === 'Enter' && onEnter && !e.nativeEvent.isComposing) onEnter()
  }

  return (
    <div className={cx('ui-field', error && 'is-error', disabled && 'is-disabled', className)}>
      {label && (
        <label className="ui-field__label" htmlFor={inputId}>
          {label}
        </label>
      )}
      <div className={cx('ui-field__box', multiline && 'is-multiline')}>
        {prefix != null && <span className="ui-field__affix ui-field__affix--pre">{prefix}</span>}
        {multiline ? (
          <textarea {...common} rows={rows} onChange={(e) => onChange(e.target.value)} />
        ) : (
          <input
            {...common}
            ref={inputRef}
            type={type}
            inputMode={inputMode}
            enterKeyHint={onEnter ? 'done' : undefined}
            onKeyDown={onKeyDown}
            onChange={(e) => onChange(e.target.value)}
          />
        )}
        {suffix != null && <span className="ui-field__affix ui-field__affix--post">{suffix}</span>}
      </div>
      {message && (
        <div id={msgId} className="ui-field__msg" role={error ? 'alert' : undefined}>
          {message}
        </div>
      )}
    </div>
  )
}
