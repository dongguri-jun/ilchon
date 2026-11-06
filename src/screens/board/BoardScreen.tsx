import { useMemo, useState, type ReactNode } from 'react'
import type { Currency, Offer, PubkeyHex, Side, SortMode } from '../../contracts'
import { actions, useIlchon } from '../../engine/browser'
import { useT } from '../../i18n'
import {
  AppBar,
  Avatar,
  Badge,
  Button,
  Card,
  Chip,
  Dialog,
  EmptyState,
  IconButton,
  IconEdit,
  IconLock,
  IconPlus,
  IconQr,
  IconTrash,
  cx,
  useToast,
} from '../../ui'
import { OfferSheet } from './OfferSheet'
import { buildRows, formatFee, formatMoney, formatSats, ratesList, type BoardRow } from './format'
import { NS } from './strings'
import './board.css'

export interface BoardScreenProps {
  onOpenRoom: (contactId: PubkeyHex) => void
  onOpenConnect: () => void
  /** Shown under the app bar, above the board. */
  intro?: ReactNode
}

type SheetMode = 'closed' | 'new' | 'edit'

const SIDES: readonly Side[] = ['buy', 'sell']

/** Long amounts get a smaller font so a 160px column never overflows. */
function amountClass(text: string): string | false {
  return text.length >= 12 && 'is-long'
}

export function BoardScreen({ onOpenRoom, onOpenConnect, intro }: BoardScreenProps) {
  const t = useT(NS)
  const toast = useToast()
  const myOffer = useIlchon((s) => s.myOffer)
  const matches = useIlchon((s) => s.matches)
  const contacts = useIlchon((s) => s.contacts)
  const progress = useIlchon((s) => s.matchProgress)
  const rates = useIlchon((s) => s.rates)
  const sort = useIlchon((s) => s.settings.sort)

  const [sheet, setSheet] = useState<SheetMode>('closed')
  const [confirmWithdraw, setConfirmWithdraw] = useState(false)
  const [withdrawing, setWithdrawing] = useState(false)

  const rows = useMemo(
    () => buildRows(myOffer, matches, contacts, rates, sort),
    [myOffer, matches, contacts, rates, sort],
  )
  const rateText = ratesList(rates)

  const setSort = (mode: SortMode) => {
    if (mode === sort) return
    actions.setSettings({ sort: mode }).catch(() => {
      // The chips simply stay where they were.
    })
  }

  const withdraw = async () => {
    setConfirmWithdraw(false)
    if (withdrawing) return
    setWithdrawing(true)
    try {
      await actions.withdrawOffer()
      toast.show(t('withdrawn'), 'info')
    } catch {
      toast.show(t('withdrawFailed'), 'error')
    } finally {
      setWithdrawing(false)
    }
  }

  const renderColumn = (side: Side) => {
    const title = t(side === 'buy' ? 'colBuy' : 'colSell')
    const own = myOffer !== null && myOffer.side === side ? myOffer : null
    const other = myOffer !== null && myOffer.side !== side ? myOffer : null
    return (
      <section key={side} className={cx('board-col', own && 'is-mine')} aria-label={title}>
        <h2 className="board-col__title">
          <span>{title}</span>
          {other && rows.length > 0 && <span className="board-col__count num">{rows.length}</span>}
        </h2>
        <div className="board-col__body">
          {myOffer === null && (
            <div className="board-slot board-slot--locked" aria-hidden>
              <IconLock size={18} />
            </div>
          )}
          {own && (
            <MyOffer
              offer={own}
              busy={withdrawing}
              contactCount={contacts.length}
              asked={progress.asked}
              answered={progress.answered}
              onEdit={() => setSheet('edit')}
              onWithdraw={() => setConfirmWithdraw(true)}
              onOpenConnect={onOpenConnect}
            />
          )}
          {other &&
            (rows.length > 0 ? (
              rows.map((row) => (
                <MatchRow
                  key={row.contactId}
                  row={row}
                  currency={other.currency}
                  onOpen={() => onOpenRoom(row.contactId)}
                />
              ))
            ) : (
              <div className="board-slot board-slot--wait">
                <p className="board-slot__title">{t('waitTitle')}</p>
                <p className="board-slot__body">{t('waitBody')}</p>
              </div>
            ))}
        </div>
      </section>
    )
  }

  return (
    <div className="board">
      <AppBar title={t('title')} />

      <div className="ui-page ui-has-nav board__body">
        {intro}
        {rateText && <p className="board__rates num">{t('rates', { list: rateText })}</p>}

        <div className="board__sort" role="group" aria-label={t('sortLabel')}>
          <Chip selected={sort === 'amount'} onClick={() => setSort('amount')}>
            {t('sortAmount')}
          </Chip>
          <Chip selected={sort === 'fee'} onClick={() => setSort('fee')}>
            {t('sortFee')}
          </Chip>
        </div>

        <div className={cx('board__cols', myOffer === null && 'is-locked')}>{SIDES.map(renderColumn)}</div>

        {myOffer === null ? (
          <EmptyState
            icon={<IconLock size={28} />}
            title={t('emptyTitle')}
            body={t('emptyBody')}
            action={
              <div className="board__empty-actions">
                <Button size="lg" fullWidth leading={<IconPlus size={20} />} onClick={() => setSheet('new')}>
                  {t('post')}
                </Button>
                {contacts.length === 0 && (
                  <Button variant="ghost" fullWidth leading={<IconQr size={18} />} onClick={onOpenConnect}>
                    {t('connectFirst')}
                  </Button>
                )}
              </div>
            }
          />
        ) : (
          <p className="board__footnote">
            <IconLock size={14} />
            <span>{t('footnote')}</span>
          </p>
        )}
      </div>

      <OfferSheet open={sheet !== 'closed'} onClose={() => setSheet('closed')} editing={sheet === 'edit' ? myOffer : null} />

      <Dialog
        open={confirmWithdraw}
        title={t('withdrawTitle')}
        confirmLabel={t('withdraw')}
        tone="danger"
        onConfirm={withdraw}
        onCancel={() => setConfirmWithdraw(false)}
      >
        {t('withdrawBody')}
      </Dialog>
    </div>
  )
}

interface MyOfferProps {
  offer: Offer
  busy: boolean
  contactCount: number
  asked: number
  answered: number
  onEdit: () => void
  onWithdraw: () => void
  onOpenConnect: () => void
}

function MyOffer({ offer, busy, contactCount, asked, answered, onEdit, onWithdraw, onOpenConnect }: MyOfferProps) {
  const t = useT(NS)
  const amount = formatMoney(offer.amount, offer.currency)
  const noContacts = contactCount === 0

  let status: string
  if (noContacts) status = t('noContacts')
  else if (asked <= 0) status = t('progressStarting')
  else if (answered >= asked) status = t(asked === 1 ? 'progressAllOne' : 'progressAll', { asked })
  else status = t(asked === 1 ? 'progressOne' : 'progress', { asked, answered })

  return (
    <>
      <Card tone="primary" padding="sm">
        <div className="board-mine">
          <Badge tone="primary">{t('mine')}</Badge>
          <div className={cx('board-mine__amount num', amountClass(amount))}>{amount}</div>
          <div className="board-mine__fee">
            {t('market')} <span className="num t-bold">{formatFee(offer.feePct)}</span>
          </div>
          <div className="board-mine__meta">
            {t(offer.side === 'buy' ? 'colBuy' : 'colSell')} · {t(offer.currency === 'KRW' ? 'curKRW' : 'curUSD')}
          </div>
          <div className="board-mine__actions">
            <IconButton
              icon={<IconEdit size={18} />}
              label={t('edit')}
              variant="filled"
              size="sm"
              onClick={onEdit}
              disabled={busy}
            />
            <IconButton
              icon={<IconTrash size={18} />}
              label={t('withdraw')}
              variant="filled"
              size="sm"
              onClick={onWithdraw}
              disabled={busy}
            />
          </div>
        </div>
      </Card>
      <div className="board-status" role="status">
        <p className="board-status__text">{status}</p>
        {noContacts && (
          <Button variant="secondary" size="sm" fullWidth leading={<IconQr size={16} />} onClick={onOpenConnect}>
            {t('connect')}
          </Button>
        )}
      </div>
    </>
  )
}

interface MatchRowProps {
  row: BoardRow
  currency: Currency
  onOpen: () => void
}

function MatchRow({ row, currency, onOpen }: MatchRowProps) {
  const t = useT(NS)
  const amount = formatMoney(row.amount, currency)
  return (
    <Card padding="sm" onClick={onOpen}>
      <span className="board-row">
        <span className="board-row__who">
          <Avatar seed={row.contactId} name={row.named ? row.label : undefined} size={24} />
          <span className={cx('board-row__name t-truncate', !row.named && 'is-key')}>{row.label}</span>
        </span>
        <span className={cx('board-row__amount num', amountClass(amount))}>{amount}</span>
        <span className="board-row__fee">
          {t('market')} <span className="num t-bold">{formatFee(row.feePct)}</span>
        </span>
        <span className="board-row__trade">
          <span className="board-row__trade-label">{t('tradable')}</span>
          <span className="board-row__trade-value num">{formatMoney(row.tradable, currency)}</span>
          {row.sats !== null && (
            <span className="board-row__sats num">{t('sats', { sats: formatSats(row.sats) })}</span>
          )}
        </span>
      </span>
    </Card>
  )
}
