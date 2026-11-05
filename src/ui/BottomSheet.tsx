import { useRef, type ReactNode } from 'react'
import { createPortal } from 'react-dom'
import { cx } from './cx'
import { IconClose } from './icons'
import { IconButton } from './IconButton'
import { usePresence, useModalBehavior, useScrollLock } from './overlay'
import { useT } from '../i18n'
import './strings'
import './BottomSheet.css'

export interface BottomSheetProps {
  open: boolean
  onClose: () => void
  title?: ReactNode
  children?: ReactNode
  /** Sticky area below the scrolling body, e.g. action buttons. */
  footer?: ReactNode
  /** Backdrop tap and Escape close the sheet (default true). */
  dismissible?: boolean
  /** Hide the header close button. */
  hideClose?: boolean
  className?: string
}

/** Slide-up sheet (Coconut: top radius 32, max 95% of the viewport). Rendered in a portal. */
export function BottomSheet({
  open,
  onClose,
  title,
  children,
  footer,
  dismissible = true,
  hideClose,
  className,
}: BottomSheetProps) {
  const t = useT('ui')
  const panelRef = useRef<HTMLDivElement>(null)
  const { render, closing } = usePresence(open, 220)
  useScrollLock(render)
  useModalBehavior(open, panelRef, dismissible ? onClose : undefined)
  if (!render || typeof document === 'undefined') return null

  return createPortal(
    <div className={cx('ui-sheet', closing && 'is-closing', className)}>
      <div className="ui-sheet__backdrop" onClick={dismissible ? onClose : undefined} />
      <div
        ref={panelRef}
        className="ui-sheet__panel"
        role="dialog"
        aria-modal="true"
        aria-label={typeof title === 'string' ? title : undefined}
        tabIndex={-1}
      >
        <div className="ui-sheet__grab" aria-hidden />
        {(title || !hideClose) && (
          <div className="ui-sheet__header">
            <h2 className="ui-sheet__title">{title}</h2>
            {!hideClose && (
              <IconButton
                icon={<IconClose size={22} />}
                label={t('close')}
                size="sm"
                onClick={onClose}
                className="ui-sheet__close"
              />
            )}
          </div>
        )}
        <div className="ui-sheet__body">{children}</div>
        {footer && <div className="ui-sheet__footer">{footer}</div>}
      </div>
    </div>,
    document.body,
  )
}
