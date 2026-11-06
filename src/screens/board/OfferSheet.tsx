import { useLayoutEffect, useRef, useState } from 'react'
import type { Currency, Offer, Side } from '../../contracts'
import { actions, useIlchon } from '../../engine/browser'
import { useT } from '../../i18n'
import { BottomSheet, Button, Chip, IconLock, IconWarning, Segmented, TextField, useToast } from '../../ui'
import {
  FEE_MAX,
  FEE_MIN,
  amountToInput,
  feeToInput,
  formatFee,
  formatMoney,
  formatSats,
  parseAmount,
  parseFee,
  sanitizeAmount,
  sanitizeFee,
  satsFor,
} from './format'
import { NS } from './strings'

export interface OfferSheetProps {
  open: boolean
  onClose: () => void
  /** The offer being edited, or null to post a new one. */
  editing: Offer | null
}

const QUICK_ADD: Record<Currency, readonly number[]> = {
  KRW: [10_000, 50_000, 100_000, 1_000_000],
  USD: [10, 50, 100, 500],
}
const QUICK_FEE: readonly number[] = [-1, 0, 1, 2, 3]

export function OfferSheet({ open, onClose, editing }: OfferSheetProps) {
  const t = useT(NS)
  const toast = useToast()
  const rates = useIlchon((s) => s.rates)
  const lang = useIlchon((s) => s.settings.lang)

  // Snapshot of the offer taken when the sheet opened, so a change arriving
  // from the engine mid-edit does not move the form under the user's thumb.
  const [base, setBase] = useState<Offer | null>(null)
  const [side, setSide] = useState<Side>('buy')
  const [currency, setCurrency] = useState<Currency>(lang === 'ko' ? 'KRW' : 'USD')
  const [amountText, setAmountText] = useState('')
  const [feeText, setFeeText] = useState('0')
  const [tried, setTried] = useState(false)
  const [busy, setBusy] = useState(false)

  // Thousands separators are re-inserted on every keystroke; without this the
  // caret would jump to the end when editing in the middle of the number.
  const caret = useRef<{ el: HTMLInputElement; sig: number } | null>(null)
  const applyCaret = () => {
    const c = caret.current
    if (!c) return
    caret.current = null
    if (document.activeElement !== c.el) return
    const v = c.el.value
    let pos = 0
    let seen = 0
    while (pos < v.length && seen < c.sig) {
      if (/[\d.]/.test(v.charAt(pos))) seen++
      pos++
    }
    try {
      c.el.setSelectionRange(pos, pos)
    } catch {
      // Some input types do not support selection; nothing to restore.
    }
  }
  useLayoutEffect(applyCaret)
  const changeAmount = (raw: string) => {
    const el = document.activeElement
    if (el instanceof HTMLInputElement && el.selectionStart !== null) {
      const sig = raw.slice(0, el.selectionStart).replace(/[^\d.]/g, '').length
      caret.current = { el, sig }
      // Runs even when the sanitized text is unchanged and React skips the render.
      requestAnimationFrame(applyCaret)
    }
    setAmountText(sanitizeAmount(raw, currency))
  }

  // Fill the form at the moment the sheet opens. Done during render (not in an
  // effect) so the first painted frame already shows the right values.
  const [wasOpen, setWasOpen] = useState(false)
  if (open !== wasOpen) {
    setWasOpen(open)
    if (open) {
      setBase(editing)
      setTried(false)
      if (editing) {
        setSide(editing.side)
        setCurrency(editing.currency)
        setAmountText(amountToInput(editing.amount, editing.currency))
        setFeeText(feeToInput(editing.feePct))
      } else {
        // A new post keeps the side and currency used last time.
        setAmountText('')
        setFeeText('0')
      }
    }
  }

  const amount = parseAmount(amountText)
  const feePct = parseFee(feeText)
  const amountOk = Number.isFinite(amount) && amount > 0
  const feeOk = Number.isFinite(feePct) && feePct >= FEE_MIN && feePct <= FEE_MAX
  const resetsMatches = base !== null && (side !== base.side || currency !== base.currency)

  const changeCurrency = (next: Currency) => {
    if (next === currency) return
    // Won has no decimals: drop them instead of gluing them onto the integer.
    const text = next === 'KRW' ? amountText.split('.')[0] : amountText
    setCurrency(next)
    setAmountText(sanitizeAmount(text, next))
  }

  const addAmount = (delta: number) => {
    const current = Number.isFinite(amount) ? amount : 0
    setAmountText(amountToInput(current + delta, currency))
  }

  const flipSign = () => {
    setFeeText((v) => (v.startsWith('-') ? v.slice(1) : `-${v === '0' ? '' : v}`))
  }

  const submit = async () => {
    if (busy) return
    setTried(true)
    if (!amountOk || !feeOk) return
    setBusy(true)
    try {
      await actions.postOffer({ side, currency, amount, feePct })
      toast.show(t(base ? 'updated' : 'posted'), 'success')
      onClose()
    } catch {
      toast.show(t('postFailed'), 'error')
    } finally {
      setBusy(false)
    }
  }

  let preview: string | null = null
  let previewSats: string | null = null
  if (amountOk && feeOk) {
    const flat = feePct === 0
    const key = side === 'buy' ? (flat ? 'previewBuyFlat' : 'previewBuy') : flat ? 'previewSellFlat' : 'previewSell'
    preview = t(key, { amount: formatMoney(amount, currency), fee: formatFee(feePct) })
    const sats = satsFor(amount, rates[currency], feePct)
    if (sats !== null) previewSats = t('previewSats', { sats: formatSats(sats) })
  }

  return (
    <BottomSheet
      open={open}
      onClose={onClose}
      title={t(base ? 'sheetEdit' : 'sheetNew')}
      dismissible={!busy}
      footer={
        <Button fullWidth size="lg" loading={busy} onClick={submit}>
          {t(base ? 'submitEdit' : 'submitNew')}
        </Button>
      }
    >
      <div className="offer-form">
        <div className="offer-form__pair">
          <Segmented<Side>
            ariaLabel={t('sideLabel')}
            value={side}
            onChange={setSide}
            disabled={busy}
            options={[
              { value: 'buy', label: t('sideBuy') },
              { value: 'sell', label: t('sideSell') },
            ]}
          />
          <Segmented<Currency>
            ariaLabel={t('currencyLabel')}
            value={currency}
            onChange={changeCurrency}
            disabled={busy}
            options={[
              { value: 'KRW', label: t('optKRW') },
              { value: 'USD', label: t('optUSD') },
            ]}
          />
        </div>

        {resetsMatches && (
          <p className="offer-form__warn" role="status">
            <IconWarning size={18} />
            <span>{t('changeWarn')}</span>
          </p>
        )}

        <div className="offer-form__group">
          <TextField
            label={t('amountLabel')}
            value={amountText}
            onChange={changeAmount}
            inputMode={currency === 'KRW' ? 'numeric' : 'decimal'}
            autoComplete="off"
            placeholder="0"
            prefix={<span className="num">{currency === 'KRW' ? '₩' : '$'}</span>}
            numeric
            disabled={busy}
            error={tried && !amountOk ? t('errAmount') : null}
            helper={t('amountHelper')}
          />
          <div className="offer-form__chips">
            {QUICK_ADD[currency].map((delta, i) => (
              <Chip key={delta} onClick={() => addAmount(delta)} disabled={busy}>
                <span className="num">{t(`add${currency}${i}`)}</span>
              </Chip>
            ))}
          </div>
        </div>

        <div className="offer-form__group">
          <TextField
            label={t('feeLabel')}
            value={feeText}
            onChange={(v) => setFeeText(sanitizeFee(v))}
            inputMode="decimal"
            autoComplete="off"
            placeholder="0"
            prefix={
              // Phone decimal keypads have no minus key.
              <button
                type="button"
                className="offer-form__sign num"
                onClick={flipSign}
                disabled={busy}
                aria-label={t('flipSign')}
              >
                ±
              </button>
            }
            suffix={<span className="num">%</span>}
            numeric
            disabled={busy}
            error={!feeOk ? t('errFee') : null}
            helper={t('feeHelper')}
            onEnter={submit}
          />
          <div className="offer-form__chips">
            {QUICK_FEE.map((fee) => (
              <Chip
                key={fee}
                selected={feeOk && feePct === fee}
                onClick={() => setFeeText(feeToInput(fee))}
                disabled={busy}
              >
                <span className="num">{formatFee(fee)}</span>
              </Chip>
            ))}
          </div>
        </div>

        <div className={preview ? 'offer-form__preview' : 'offer-form__preview is-empty'} aria-live="polite">
          {preview ? (
            <>
              <p className="offer-form__preview-main">{preview}</p>
              {previewSats && <p className="offer-form__preview-sub num">{previewSats}</p>}
            </>
          ) : (
            <p className="offer-form__preview-main">{t('previewEmpty')}</p>
          )}
        </div>

        <p className="offer-form__privacy">
          <IconLock size={14} />
          <span>{t('sheetPrivacy')}</span>
        </p>
      </div>
    </BottomSheet>
  )
}
