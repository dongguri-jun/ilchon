import { useState } from 'react'
import { CURRENCIES, PAY_METHODS, type Currency, type Offer, type PayMethod, type Side } from '../../contracts'
import { actions, useIlchon } from '../../engine/browser'
import { amountInputMode, CURRENCY, defaultCurrency, isMinor, MINOR_PER_UNIT, parseMinor, significantBefore } from '../../lib/money'
import { useT } from '../../i18n'
import { BottomSheet, Button, Chip, IconLock, IconWarning, Segmented, TextField, useKeepCaret, useToast } from '../../ui'
import { FEE_MAX, FEE_MIN, feeToInput, formatFee, formatMoney, formatSats, minorToInput, newOfferMethods, offerFormUnchanged, parseFee, sanitizeAmount, sanitizeFee, satsFor } from './format'
import { NS } from './strings'

export interface OfferSheetProps {
  open: boolean
  onClose: () => void
  /** The offer being edited, or null to post a new one. */
  editing: Offer | null
}

const QUICK_FEE: readonly number[] = [-1, 0, 1, 2, 3]

export function OfferSheet({ open, onClose, editing }: OfferSheetProps) {
  const t = useT(NS)
  const toast = useToast()
  const rates = useIlchon((s) => s.rates)
  const lang = useIlchon((s) => s.settings.lang)
  const live = useIlchon((s) => s.myOffer)

  // Snapshot of the offer taken when the sheet opened, so a change arriving
  // from the engine mid-edit does not move the form under the user's thumb.
  const [base, setBase] = useState<Offer | null>(null)
  const [side, setSide] = useState<Side>('buy')
  const [currency, setCurrency] = useState<Currency>(() => defaultCurrency(lang, typeof navigator === 'undefined' ? [] : navigator.languages))
  const [amountText, setAmountText] = useState('')
  const [feeText, setFeeText] = useState('0')
  const [methods, setMethods] = useState<PayMethod[]>(newOfferMethods)
  const [tried, setTried] = useState(false)
  const [busy, setBusy] = useState(false)

  // Thousands separators are re-inserted on every keystroke; keep the caret
  // where it was instead of letting it jump to the end.
  const keepCaret = useKeepCaret()
  const changeAmount = (raw: string, inputType?: string, data?: string | null, composing?: boolean) => {
    // Whole-unit currencies keep no point, so a point is not a character to count.
    // Counted after the fullwidth-digit conversion, so fullwidth digits keep the caret in place too.
    keepCaret(raw, CURRENCY[currency].decimals === 0 ? /\d/ : /[\d.]/, (r, p) => significantBefore(r, p, currency))
    // A point typed into a whole-unit amount is dropped; a pasted '12.75' loses its fraction.
    setAmountText(sanitizeAmount(raw, currency, amountInputMode(inputType, data, composing)))
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
        setAmountText(minorToInput(editing.amountMinor, editing.currency))
        setFeeText(feeToInput(editing.feePct))
        setMethods([...editing.methods])
      } else {
        // A new post keeps the side and currency used last time; methods start over.
        setAmountText('')
        setFeeText('0')
        setMethods(newOfferMethods())
      }
    }
  }

  // Exact minor units (won, yen, cents): NaN unless the text is a valid amount.
  const amountMinor = parseMinor(amountText, currency)
  const feePct = parseFee(feeText)
  const amountOk = !Number.isNaN(amountMinor)
  const feeOk = Number.isFinite(feePct) && feePct >= FEE_MIN && feePct <= FEE_MAX
  // Both method lists are kept in PAY_METHODS order (toggleMethod, canonicalMethods), so join() equality is set equality.
  const resetsMatches = base !== null && (side !== base.side || currency !== base.currency || methods.join() !== base.methods.join())
  /**
   * Nothing changed from the live offer: posting it again would send a new rev to every
   * matched contact and show them when I used the app, for nothing.
   */
  const unchanged = base !== null && offerFormUnchanged(live, { side, currency, amountMinor, feePct, methods })

  /** At least one method stays on: the last one does not turn off. */
  const toggleMethod = (m: PayMethod) => {
    if (methods.includes(m)) {
      if (methods.length > 1) setMethods(methods.filter((x) => x !== m))
    } else {
      setMethods(PAY_METHODS.filter((x) => x === m || methods.includes(x)))
    }
  }

  const changeCurrency = (next: Currency) => {
    if (next === currency) return
    // Whole-unit currencies have no decimals: drop them instead of gluing them onto the integer.
    const text = CURRENCY[next].decimals === 0 ? amountText.split('.')[0] : amountText
    setCurrency(next)
    setAmountText(sanitizeAmount(text, next))
  }

  /** `major` is a quick-add value of the currency table, in major units. */
  const addAmount = (major: number) => {
    const next = (amountOk ? amountMinor : 0) + major * MINOR_PER_UNIT[currency]
    // Past twelve digits nothing is added; the field stays as it is.
    if (!isMinor(next)) return
    setAmountText(minorToInput(next, currency))
  }

  const flipSign = () => {
    setFeeText((v) => (v.startsWith('-') ? v.slice(1) : `-${v === '0' ? '' : v}`))
  }

  const submit = async () => {
    if (busy || unchanged) return
    setTried(true)
    if (!amountOk || !feeOk) return
    setBusy(true)
    try {
      await actions.postOffer({ side, currency, amountMinor, feePct, methods })
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
    preview = t(key, { amount: formatMoney(amountMinor, currency), fee: formatFee(feePct) })
    const sats = satsFor(amountMinor, currency, rates[currency], feePct)
    if (sats !== null) previewSats = t('previewSats', { sats: formatSats(sats) })
  }

  return (
    <BottomSheet
      open={open}
      onClose={onClose}
      title={t(base ? 'sheetEdit' : 'sheetNew')}
      dismissible={!busy}
      footer={
        <Button fullWidth size="lg" loading={busy} disabled={unchanged} onClick={submit}>
          {t(base ? 'submitEdit' : 'submitNew')}
        </Button>
      }
    >
      <div className="offer-form">
        <div className="offer-form__pair">
          <div className="offer-form__sides" role="group" aria-label={t('sideLabel')}>
            {(['buy', 'sell'] as const).map((choice) => (
              <Button key={choice} variant={side === choice ? 'primary' : 'secondary'} fullWidth aria-pressed={side === choice} onClick={() => setSide(choice)} disabled={busy}>
                {t(choice === 'buy' ? 'sideBuy' : 'sideSell', { currency: t(`cur${currency}`) })}
              </Button>
            ))}
          </div>
          <Segmented<Currency> ariaLabel={t('currencyLabel')} value={currency} onChange={changeCurrency} disabled={busy} options={CURRENCIES.map((c) => ({ value: c, label: t(`opt${c}`) }))} />
        </div>

        <div className="offer-form__group">
          <div className="offer-form__methods" role="group" aria-label={t('methodLabel')}>
            <span className="offer-form__methods-label">{t('methodLabel')}</span>
            <div className="offer-form__chips">
              {PAY_METHODS.map((m) => (
                <Chip key={m} selected={methods.includes(m)} onClick={() => toggleMethod(m)} disabled={busy}>
                  {t(m === 'lightning' ? 'optLightning' : 'optOnchain')}
                </Chip>
              ))}
            </div>
          </div>
          {methods.length === 1 && <p className="offer-form__edit-hint">{t('methodHint')}</p>}
        </div>

        {base && !resetsMatches && <p className="offer-form__edit-hint">{t('matchesKept')}</p>}

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
            inputMode={CURRENCY[currency].inputMode}
            autoComplete="off"
            placeholder="0"
            prefix={<span className="num">{CURRENCY[currency].symbol}</span>}
            numeric
            disabled={busy}
            error={tried && !amountOk ? t('errAmount') : null}
            helper={t('amountHelper')}
          />
          <div className="offer-form__chips">
            {CURRENCY[currency].quickAdd.map((delta, i) => (
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
              <button type="button" className="offer-form__sign num" onClick={flipSign} disabled={busy} aria-label={t('flipSign')}>
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
              <Chip key={fee} selected={feeOk && feePct === fee} onClick={() => setFeeText(feeToInput(fee))} disabled={busy}>
                <span className="num">{formatFee(fee)}</span>
              </Chip>
            ))}
          </div>
        </div>

        <div className={preview ? 'offer-form__preview' : 'offer-form__preview is-empty'} aria-live="polite">
          {preview ? (
            <>
              <p className="offer-form__preview-main">{preview}</p>
              <p className="offer-form__preview-sub num">{previewSats ?? t('ratesUnavailable')}</p>
            </>
          ) : (
            <p className="offer-form__preview-main">{t('previewEmpty')}</p>
          )}
        </div>

        <p className="offer-form__privacy">
          <IconLock size={14} />
          <span>{t('sheetPrivacy')}</span>
        </p>
        {!base && <p className="offer-form__privacy">{t('sheetWallet')}</p>}
      </div>
    </BottomSheet>
  )
}
