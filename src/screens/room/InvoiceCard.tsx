import { useEffect, useState } from 'react'
import type { CardView, Currency } from '../../contracts'
import { invoiceIssues, msUntilRecount, secondsLeft, type Invoice, type InvoiceIssue } from '../../lib/bolt11'
import { useT, type TFn } from '../../i18n'
import { IconCopy, IconQr, IconWarning, cx } from '../../ui'
import { QrCode } from '../../ui/qr'
import { formatMoney, formatSats } from '../../lib/money'
import { PAY_COPY } from './pay-copy'
import { ROOM_NS } from './strings'
import './InvoiceCard.css'

/**
 * Re-renders every `ms` so countdowns stay current, and once more when `expiresAt` (unix
 * seconds) passes, so the card turns to "expired" with the room's guide.
 * Stops after that.
 */
export function useNow(ms: number, expiresAt: number): number {
  const [now, setNow] = useState(() => Date.now())
  useEffect(() => {
    let timer: ReturnType<typeof setTimeout> | undefined
    const schedule = () => {
      const wait = msUntilRecount(expiresAt, Date.now(), ms)
      if (wait === null) return
      timer = setTimeout(() => {
        setNow(Date.now())
        schedule()
      }, wait)
    }
    setNow(Date.now())
    schedule()
    return () => clearTimeout(timer)
  }, [ms, expiresAt])
  return now
}

const ISSUE_KEYS: Record<InvoiceIssue, string> = {
  expired: 'invIssueExpired',
  notMainnet: 'invIssueNetwork',
  noAmount: 'invIssueNoAmount',
  expiringSoon: 'invIssueSoon',
}

/** Issues that make paying a mistake, not just something to double-check. */
const BLOCKING: InvoiceIssue[] = ['expired', 'notMainnet']

export interface InvoiceCardProps {
  invoice: Invoice
  /** What this card is in the current trade (src/engine/trade.ts tradeView). */
  card: CardView
  /** I sent the message that carries it. */
  mine: boolean
  /** My offer's currency, for `card.fiatMinor`. */
  currency: Currency | null
  onCopy: (text: string) => void
}

const MEMO_MAX = 80

/**
 * One payment card. Only the active card of the current trade
 * shows its QR and copy, on both sides; only the seller who matches now
 * gets the pay button. Every other card is grey with its sats and at most one line
 * saying why.
 */
export function InvoiceCard({ invoice, card, mine, currency, onCopy }: InvoiceCardProps) {
  const t = useT(ROOM_NS)
  // Only the active card shows a countdown; 0 (long past) keeps the others from scheduling timers.
  const now = useNow(15_000, card.state === 'active' ? invoice.expiresAt : 0)
  const [qrOpen, setQrOpen] = useState(false)
  const amount = invoice.amountSats === null
    ? t('invAnyAmount')
    : <>{formatSats(invoice.amountSats)} <span className="inv__unit">sats</span></>

  if (card.state !== 'active') {
    const note = card.state === 'notPayer' ? 'invNotPayer' : mine ? null : 'invInactive'
    return (
      <div className="inv inv--inactive">
        <div className="inv__head">
          <span className="inv__label t-caption">{t('invLabel')}</span>
        </div>
        <div className="inv__amount num">{amount}</div>
        {note && (
          <p className={cx('inv__note', card.state === 'notPayer' && 'inv__note--warn')}>
            {card.state === 'notPayer' && <IconWarning size={16} />}<span>{t(note)}</span>
          </p>
        )}
      </div>
    )
  }

  const issues = invoiceIssues(invoice, now)
  const blocked = issues.some((i) => BLOCKING.includes(i))
  const left = secondsLeft(invoice, now)
  const payable = card.pay && !blocked
  const memo = invoice.description
    ? invoice.description.length > MEMO_MAX ? `${invoice.description.slice(0, MEMO_MAX)}…` : invoice.description
    : null
  const warnings: { key: string; text: string; blocking: boolean }[] = [
    ...issues.map((i) => ({ key: i, text: t(ISSUE_KEYS[i], { network: invoice.network }), blocking: BLOCKING.includes(i) })),
    ...(card.over ? [{ key: 'over', text: t(PAY_COPY.lightning.over), blocking: false }] : []),
  ]

  return (
    <div className={cx('inv', warnings.length > 0 && 'inv--warn', blocked && 'inv--blocked')}>
      <div className="inv__head">
        <span className="inv__label t-caption">{t('invLabel')}</span>
        {left <= 0 ? (
          // Expired: one label, for the eye and the screen reader alike.
          <span className="inv__expiry t-caption num">{t('invExpired')}</span>
        ) : (
          <>
            {/* Countdown text changes every 15 s; keep it out of the chat's live region. */}
            <span className="inv__expiry t-caption num" aria-hidden="true">{expiryText(t, left)}</span>
            <span className="sr-only">{t('invExpiresAt', { time: formatTime(invoice.expiresAt) })}</span>
          </>
        )}
      </div>
      <div className="inv__amount num">{amount}</div>
      {card.fiatMinor !== null && currency && (
        <p className="inv__fiat t-caption num">{t('invFiat', { amount: formatMoney(card.fiatMinor, currency) })}</p>
      )}
      {memo && <p className="inv__desc t-caption"><span className="inv__memo-label">{t('invMemo')}</span> {t('invMemoQuote', { memo })}</p>}

      {warnings.length > 0 && (
        <ul className="inv__issues">
          {warnings.map((w) => (
            <li key={w.key} className={cx('inv__issue', w.blocking && 'inv__issue--blocking')}>
              <IconWarning size={16} />
              <span>{w.text}</span>
            </li>
          ))}
        </ul>
      )}

      {!blocked && (
        <div className="inv__actions">
          {payable && (
            <a className="ui-btn ui-btn--primary ui-btn--sm inv__pay" href={`lightning:${invoice.invoice}`}>
              <span className="ui-btn__content"><span className="ui-btn__label">{t('invOpenWallet')}</span></span>
            </a>
          )}
          <button type="button" className="inv__action" onClick={() => onCopy(invoice.invoice)}>
            <IconCopy size={16} /><span>{t('copy')}</span>
          </button>
          <button type="button" className="inv__action" aria-expanded={qrOpen} onClick={() => setQrOpen((o) => !o)}>
            <IconQr size={16} /><span>{t(qrOpen ? 'invHideQr' : 'invShowQr')}</span>
          </button>
        </div>
      )}
      {payable && <p className="inv__hint">{t('invOpenHint')}</p>}
      {qrOpen && !blocked && (
        <div className="inv__qr">
          <QrCode text={`lightning:${invoice.invoice}`.toUpperCase()} size={232} />
        </div>
      )}
    </div>
  )
}

function formatTime(unixSec: number): string {
  const d = new Date(unixSec * 1000)
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`
}

function expiryText(t: TFn, left: number): string {
  if (left <= 0) return t('invExpired')
  if (left < 60) return t('invLeftSeconds', { n: left })
  if (left < 3600) return t('invLeftMinutes', { n: Math.floor(left / 60) })
  if (left < 86_400) return t('invLeftHours', { n: Math.floor(left / 3600) })
  return t('invLeftDays', { n: Math.floor(left / 86_400) })
}
