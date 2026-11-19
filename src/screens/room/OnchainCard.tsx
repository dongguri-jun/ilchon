import { useState } from 'react'
import type { CardView, Currency } from '../../contracts'
import { useT } from '../../i18n'
import { formatMoney, formatSats } from '../../lib/money'
import { onchainCardValues, type OnchainRequest } from '../../lib/onchain'
import { IconCopy, IconQr, IconWarning, cx } from '../../ui'
import { QrCode } from '../../ui/qr'
import { truncateMiddle } from './format'
import { PAY_COPY, onchainCardNotes } from './pay-copy'
import { ROOM_NS } from './strings'
import './InvoiceCard.css'

export interface OnchainCardProps {
  /** The request as parsed: `uri` is rebuilt by bip21, never the text as received. */
  req: OnchainRequest
  /** What this card is in the current trade (src/engine/trade.ts tradeView). */
  card: CardView
  /** I sent the message that carries it. */
  mine: boolean
  /** My offer's currency, for `card.fiatMinor`. */
  currency: Currency | null
  onCopy: (text: string) => void
}

/**
 * One on-chain receiving card. The same rules as InvoiceCard: only the active card
 * shows its QR and copy on both sides, only
 * the seller who matches now gets "Open in wallet", every other card is grey. No
 * expiry and no network warning: parseAddress takes mainnet addresses only. The address
 * is shortened in the middle on screen; copy and the QR always carry all of it.
 *
 * Its words are an address's, not an invoice's (PAY_COPY.onchain). The BTC line,
 * the QR, "Open in wallet" and "Copy link" all come from onchainCardValues, so the amount
 * shown is the amount the wallet gets. With an amount there are two copies: the link
 * (address and amount, for a wallet that reads it) and the address only (for one that
 * does not, the hint then says to type the card's amount).
 */
export function OnchainCard({ req, card, mine, currency, onCopy }: OnchainCardProps) {
  const t = useT(ROOM_NS)
  const [qrOpen, setQrOpen] = useState(false)
  const copy = PAY_COPY.onchain
  const v = onchainCardValues(req)
  const amount =
    req.sats === null ? (
      t('invAnyAmount')
    ) : (
      <>
        {formatSats(req.sats)} <span className="inv__unit">sats</span>
      </>
    )
  const btc = v.btc === null ? null : <p className="inv__fiat t-caption num">{v.btc} BTC</p>
  const address = (
    <p className="inv__address num" title={req.address}>
      {truncateMiddle(req.address, 10, 8)}
    </p>
  )

  const notes = onchainCardNotes(card, req.sats !== null, mine)
  if (card.state !== 'active') {
    const note = notes[0] ?? null
    return (
      <div className="inv inv--inactive">
        <div className="inv__head">
          <span className="inv__label t-caption">{t('onchainLabel')}</span>
        </div>
        <div className="inv__amount num">{amount}</div>
        {address}
        {note && (
          <p className={cx('inv__note', card.state === 'notPayer' && 'inv__note--warn')}>
            {card.state === 'notPayer' && <IconWarning size={16} />}
            <span>{t(note)}</span>
          </p>
        )}
      </div>
    )
  }

  const warnings: { key: string; text: string }[] = notes.map((key) => ({ key, text: t(key) }))

  return (
    <div className={cx('inv', warnings.length > 0 && 'inv--warn')}>
      <div className="inv__head">
        <span className="inv__label t-caption">{t('onchainLabel')}</span>
      </div>
      <div className="inv__amount num">{amount}</div>
      {btc}
      {card.fiatMinor !== null && currency && (
        <p className="inv__fiat t-caption num">{t('invFiat', { amount: formatMoney(card.fiatMinor, currency) })}</p>
      )}
      {address}

      {warnings.length > 0 && (
        <ul className="inv__issues">
          {warnings.map((w) => (
            <li key={w.key} className="inv__issue">
              <IconWarning size={16} />
              <span>{w.text}</span>
            </li>
          ))}
        </ul>
      )}

      <div className="inv__actions">
        {card.pay && (
          <a className="ui-btn ui-btn--primary ui-btn--sm inv__pay" href={v.link}>
            <span className="ui-btn__content">
              <span className="ui-btn__label">{t('invOpenWallet')}</span>
            </span>
          </a>
        )}
        {v.btc !== null && (
          <button type="button" className="inv__action" onClick={() => onCopy(v.link)}>
            <IconCopy size={16} />
            <span>{t('copyLink')}</span>
          </button>
        )}
        <button type="button" className="inv__action" onClick={() => onCopy(v.address)}>
          <IconCopy size={16} />
          <span>{t(v.btc !== null ? 'copyAddressOnly' : 'copyAddress')}</span>
        </button>
        <button type="button" className="inv__action" aria-expanded={qrOpen} onClick={() => setQrOpen((o) => !o)}>
          <IconQr size={16} />
          <span>{t(qrOpen ? 'invHideQr' : 'invShowQr')}</span>
        </button>
      </div>
      {card.pay && <p className="inv__hint">{t(v.btc !== null ? copy.openHint : copy.openHintNoAmount)}</p>}
      {qrOpen && (
        <div className="inv__qr">
          <QrCode text={v.link} size={232} />
        </div>
      )}
    </div>
  )
}
