import { useRef, type ReactNode } from 'react'
import { createPortal } from 'react-dom'
import { cx } from './cx'
import { usePresence, useModalBehavior, useScrollLock } from './overlay'
import { useT } from '../i18n'
import './strings'
import './Dialog.css'

export interface DialogProps {
  open: boolean
  title?: string
  /** Description / body. */
  children?: ReactNode
  /** Default: localized "OK". */
  confirmLabel?: string
  /** Default: localized "Cancel". */
  cancelLabel?: string
  onConfirm: () => void
  /** Called by the cancel button, Escape and backdrop tap. */
  onCancel: () => void
  /** danger colors the confirm label red. */
  tone?: 'default' | 'danger'
  /** Single-button alert. */
  hideCancel?: boolean
  className?: string
}

/** Coconut popup: radius 16, centered title, full-width text buttons split by hairlines. */
export function Dialog({
  open,
  title,
  children,
  confirmLabel,
  cancelLabel,
  onConfirm,
  onCancel,
  tone = 'default',
  hideCancel,
  className,
}: DialogProps) {
  const t = useT('ui')
  const panelRef = useRef<HTMLDivElement>(null)
  const { render, closing } = usePresence(open, 160)
  useScrollLock(render)
  useModalBehavior(open, panelRef, onCancel)
  if (!render || typeof document === 'undefined') return null

  return createPortal(
    <div className={cx('ui-dialog', closing && 'is-closing', className)}>
      <div className="ui-dialog__backdrop" onClick={onCancel} />
      <div
        ref={panelRef}
        className="ui-dialog__panel"
        role="alertdialog"
        aria-modal="true"
        aria-label={title}
        tabIndex={-1}
      >
        <div className="ui-dialog__content">
          {title && <h2 className="ui-dialog__title">{title}</h2>}
          {children != null && <div className="ui-dialog__body">{children}</div>}
        </div>
        <div className="ui-dialog__actions">
          {!hideCancel && (
            <button type="button" className="ui-dialog__btn" onClick={onCancel}>
              {cancelLabel ?? t('cancel')}
            </button>
          )}
          <button
            type="button"
            className={cx('ui-dialog__btn ui-dialog__btn--confirm', tone === 'danger' && 'is-danger')}
            onClick={onConfirm}
          >
            {confirmLabel ?? t('confirm')}
          </button>
        </div>
      </div>
    </div>,
    document.body,
  )
}
