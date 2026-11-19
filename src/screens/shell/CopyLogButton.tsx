import { useEffect, useRef, useState } from 'react'
import { getLang } from '../../i18n'
import { COPY_RESULT_MS, copySupportLog } from '../../lib/support-log/browser'
import { COPY } from '../../lib/support-log/copy-log-copy'
import { Button, type ButtonProps } from '../../ui'

/**
 * "Copy log": copies the support log for the user to send to the maker.
 * The same button on every screen, including the ones shown when the app does not open.
 * No registerStrings and no toast: it has to render when everything else failed (the
 * crash screen is outside ToastProvider). The label shows the result for two seconds.
 */
export function CopyLogButton({ variant = 'secondary', size = 'md', fullWidth }: Pick<ButtonProps, 'variant' | 'size' | 'fullWidth'>) {
  const [result, setResult] = useState<'ok' | 'failed' | null>(null)
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined)
  useEffect(() => () => clearTimeout(timer.current), [])
  const copy = COPY[getLang()] ?? COPY.en
  const onClick = () => {
    // No await before the copy: iPhone refuses a clipboard write after the tap is over.
    void copySupportLog().then((ok) => {
      setResult(ok ? 'ok' : 'failed')
      clearTimeout(timer.current)
      timer.current = setTimeout(() => setResult(null), COPY_RESULT_MS)
    })
  }
  return (
    <Button variant={variant} size={size} fullWidth={fullWidth} onClick={onClick} aria-live="polite">
      {result === 'ok' ? copy.copied : result === 'failed' ? copy.failed : copy.copy}
    </Button>
  )
}
