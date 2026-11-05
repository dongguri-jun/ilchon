import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import { createPortal } from 'react-dom'
import { cx } from './cx'
import { IconCheck, IconInfo, IconWarning } from './icons'
import './Toast.css'

export type ToastTone = 'info' | 'success' | 'warning' | 'error'

export interface ToastApi {
  /** Show a toast. durationMs defaults to 3000 (4500 for error). */
  show: (message: string, tone?: ToastTone, durationMs?: number) => void
  /** Remove all toasts. */
  clear: () => void
}

interface ToastItem {
  id: number
  message: string
  tone: ToastTone
  leaving: boolean
}

const MAX_VISIBLE = 3
const LEAVE_MS = 180

const noop: ToastApi = { show: () => {}, clear: () => {} }
const ToastContext = createContext<ToastApi>(noop)

const ICONS = { info: IconInfo, success: IconCheck, warning: IconWarning, error: IconWarning } as const

export function ToastProvider({ children }: { children: ReactNode }) {
  const [items, setItems] = useState<ToastItem[]>([])
  const nextId = useRef(1)
  const timers = useRef(new Map<number, ReturnType<typeof setTimeout>>())

  const remove = useCallback((id: number) => {
    const timer = timers.current.get(id)
    if (timer) clearTimeout(timer)
    timers.current.delete(id)
    setItems((xs) => xs.map((x) => (x.id === id ? { ...x, leaving: true } : x)))
    setTimeout(() => setItems((xs) => xs.filter((x) => x.id !== id)), LEAVE_MS)
  }, [])

  const show = useCallback(
    (message: string, tone: ToastTone = 'info', durationMs?: number) => {
      const id = nextId.current++
      setItems((xs) => [...xs.filter((x) => !x.leaving).slice(-(MAX_VISIBLE - 1)), { id, message, tone, leaving: false }])
      timers.current.set(
        id,
        setTimeout(() => remove(id), durationMs ?? (tone === 'error' ? 4500 : 3000)),
      )
    },
    [remove],
  )

  const clear = useCallback(() => {
    timers.current.forEach((t) => clearTimeout(t))
    timers.current.clear()
    setItems([])
  }, [])

  useEffect(() => {
    const map = timers.current
    return () => {
      map.forEach((t) => clearTimeout(t))
      map.clear()
    }
  }, [])

  const api = useMemo<ToastApi>(() => ({ show, clear }), [show, clear])

  return (
    <ToastContext.Provider value={api}>
      {children}
      {typeof document !== 'undefined' &&
        createPortal(
          <div className="ui-toasts" role="status" aria-live="polite">
            {items.map((it) => {
              const I = ICONS[it.tone]
              return (
                <div
                  key={it.id}
                  className={cx('ui-toast', `ui-toast--${it.tone}`, it.leaving && 'is-leaving')}
                  onClick={() => remove(it.id)}
                >
                  <I size={18} className="ui-toast__icon" />
                  <span className="ui-toast__msg">{it.message}</span>
                </div>
              )
            })}
          </div>,
          document.body,
        )}
    </ToastContext.Provider>
  )
}

/** toast.show('Copied', 'success'). Safe (no-op) outside a ToastProvider. */
export function useToast(): ToastApi {
  return useContext(ToastContext)
}
