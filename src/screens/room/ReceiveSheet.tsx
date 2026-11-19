import { useEffect, useState } from 'react'
import type { PayMethod, PubkeyHex, TradeView } from '../../contracts'
import { actions, useIlchon } from '../../engine/browser'
import { useT } from '../../i18n'
import {
  amountInputMode,
  CURRENCY,
  formatMoney,
  formatSats,
  parseMinor,
  requestSats,
  sanitizeAmount,
  significantBefore,
} from '../../lib/money'
import { addressProblem, parseAddress, parseOnchainRequest } from '../../lib/onchain'
import { BottomSheet, Button, IconWarning, TextField, cx, useKeepCaret, useToast } from '../../ui'
import { ADDRESS_PROBLEM_KEY, ROOM_NS } from './strings'

export interface ReceiveSheetProps {
  open: boolean
  /** One method per sheet. */
  method: PayMethod
  contactId: PubkeyHex
  view: TradeView
  onClose: () => void
  /** The room's own invoice paste: the way on whenever the automatic invoice fails. */
  onPasteInvoice: () => void
}

/** One line under the form: a string key and its values. */
type Line = { key: string; vars?: Record<string, string | number> }

/**
 * Where the buyer receives: the agreed amount (the smaller of
 * both offers) or one typed in, then the engine's sendPaymentRequest. The sats shown
 * come from requestSats with the seller's premium, the same
 * call the engine makes, so the preview, the invoice and the bitcoin: link agree.
 */
export function ReceiveSheet({ open, method, contactId, view, onClose, onPasteInvoice }: ReceiveSheetProps) {
  const t = useT(ROOM_NS)
  const toast = useToast()
  const rates = useIlchon((s) => s.rates)
  const lnAddress = useIlchon((s) => s.settings.lnAddress)
  const keepCaret = useKeepCaret()

  const [choice, setChoice] = useState<'preset' | 'custom'>('preset')
  const [customText, setCustomText] = useState('')
  const [address, setAddress] = useState('')
  const [busy, setBusy] = useState(false)
  const [line, setLine] = useState<Line | null>(null)
  const [tried, setTried] = useState(false)
  // The address problem shows after a paste, when the field is left, or after a try; typing hides it.
  const [checked, setChecked] = useState(false)

  // A fresh form each time the sheet opens.
  useEffect(() => {
    if (!open) return
    setChoice('preset')
    setCustomText('')
    setAddress('')
    setLine(null)
    setTried(false)
    setChecked(false)
  }, [open, method])

  // The match (or this method) is gone: there is nothing to send to any more.
  const offer = view.offer
  const their = view.theirOffer
  const usable = offer !== null && their !== null && view.tradeMinor !== null && view.methods.includes(method)
  useEffect(() => {
    if (open && !usable && !busy) onClose()
  }, [open, usable, busy, onClose])
  if (!offer || !their || view.tradeMinor === null) return null

  const currency = offer.currency
  const rate = rates[currency]
  const sellerFee = their.feePct
  const tradeMinor = view.tradeMinor
  const presetSats = requestSats(tradeMinor, currency, rate, sellerFee)
  const customMinor = parseMinor(customText, currency)
  const customSats = Number.isNaN(customMinor) ? null : requestSats(customMinor, currency, rate, sellerFee)
  const noRate = presetSats === null
  const noAddress = method === 'lightning' && !lnAddress
  const tooMuch = choice === 'custom' && !Number.isNaN(customMinor) && customMinor > tradeMinor
  const amountMinor = choice === 'preset' ? tradeMinor : customMinor
  const sats = choice === 'preset' ? presetSats : customSats
  const addressText = normalizeAddressInput(address)
  const problem = method === 'onchain' && addressText !== '' ? addressProblem(addressText) : null
  const addressBad = problem !== null
  const canSend =
    !busy && !noRate && !noAddress && !tooMuch && !Number.isNaN(amountMinor) && sats !== null && (method === 'lightning' || parseAddress(addressText) !== null)

  function changeCustom(raw: string, inputType?: string, data?: string | null, composing?: boolean) {
    setChoice('custom')
    setLine(null)
    keepCaret(raw, CURRENCY[currency].decimals === 0 ? /\d/ : /[\d.]/, (r, p) => significantBefore(r, p, currency))
    setCustomText(sanitizeAmount(raw, currency, amountInputMode(inputType, data, composing)))
  }

  async function pasteAddress() {
    try {
      const text = (await navigator.clipboard.readText()).trim()
      if (!text) {
        toast.show(t('pasteEmpty'), 'info')
        return
      }
      setAddress(normalizeAddressInput(text))
      setChecked(true)
      setLine(null)
    } catch {
      toast.show(t('pasteDenied'), 'warning')
    }
  }

  function pasteInvoice() {
    onClose()
    onPasteInvoice()
  }

  async function send() {
    setTried(true)
    if (!canSend) return
    setBusy(true)
    setLine(null)
    try {
      await actions.sendPaymentRequest(
        contactId,
        method === 'onchain' ? { method, amountMinor, address: addressText } : { method, amountMinor },
      )
      onClose()
    } catch (e) {
      setLine(lineFor(e, method, formatMoney(tradeMinor, currency)))
    } finally {
      setBusy(false)
    }
  }

  const title = t(method === 'lightning' ? 'sendLightning' : 'sendOnchain')
  // Lightning without an address: nothing to choose, only the paste.
  if (noAddress) {
    return (
      <BottomSheet open={open} onClose={onClose} title={title}>
        <div className="ui-stack">
          <p className="recv__note">{t('reqNoAddress')}</p>
          <Button variant="secondary" fullWidth onClick={pasteInvoice}>
            {t('reqPasteInvoice')}
          </Button>
        </div>
      </BottomSheet>
    )
  }

  const failed = line !== null
  return (
    <BottomSheet
      open={open}
      onClose={onClose}
      title={title}
      // Fetching the invoice takes up to ~12 s: backdrop, Escape, Back and the close button wait,
      // so a failure line is seen in the sheet.
      dismissible={!busy}
      hideClose={busy}
      footer={
        // A typed address that is not a mainnet address leaves the button on: pressing it
        // shows its cause (addressProblem), instead of a silent grey button.
        <Button fullWidth size="lg" loading={busy} disabled={!canSend && !busy && !addressBad} onClick={() => void send()}>
          {t('reqSend')}
        </Button>
      }
    >
      <div className="ui-stack">
        {method === 'onchain' && (
          <TextField
            label={t('reqAddressLabel')}
            value={address}
            onChange={(v, inputType) => {
              setAddress(v)
              setChecked(inputType === 'insertFromPaste')
              setLine(null)
            }}
            onBlur={() => setChecked(true)}
            autoComplete="off"
            autoCapitalize="off"
            spellCheck={false}
            maxLength={200}
            error={(tried || checked) && problem ? t(ADDRESS_PROBLEM_KEY[problem]) : null}
            suffix={
              <button type="button" className="recv__paste" onClick={() => void pasteAddress()} disabled={busy}>
                {t('reqPaste')}
              </button>
            }
          />
        )}

        {noRate ? (
          <>
            <p className="recv__note">{t('reqNoRate')}</p>
            {method === 'onchain' && <p className="recv__note">{t('reqOnchainManual')}</p>}
          </>
        ) : (
          <div className="recv__choices" role="radiogroup" aria-label={title}>
            <button
              type="button"
              role="radio"
              aria-checked={choice === 'preset'}
              className={cx('recv__choice', choice === 'preset' && 'is-selected')}
              disabled={busy}
              onClick={() => {
                setChoice('preset')
                setLine(null)
              }}
            >
              <span className="recv__choice-title num">{t('reqPreset', { amount: formatMoney(tradeMinor, currency) })}</span>
              {presetSats !== null && <span className="recv__choice-sats t-caption num">{t('reqSats', { sats: formatSats(presetSats) })}</span>}
            </button>
            <div className={cx('recv__choice recv__choice--custom', choice === 'custom' && 'is-selected')} role="radio" aria-checked={choice === 'custom'}>
              <TextField
                label={t('reqCustom')}
                value={customText}
                onChange={changeCustom}
                onFocus={() => setChoice('custom')}
                inputMode={CURRENCY[currency].inputMode}
                numeric
                prefix={CURRENCY[currency].symbol}
                autoComplete="off"
                disabled={busy}
                error={tooMuch ? t('reqTooMuch', { max: formatMoney(tradeMinor, currency) }) : null}
                helper={choice === 'custom' && customSats !== null && !tooMuch ? t('reqSats', { sats: formatSats(customSats) }) : undefined}
                onEnter={() => void send()}
              />
            </div>
          </div>
        )}

        {busy && method === 'lightning' && <p className="recv__note" role="status">{t('reqFetching')}</p>}
        {failed && (
          <p className="recv__error" role="alert">
            <IconWarning size={16} />
            <span>{t(line.key, line.vars)}</span>
          </p>
        )}
        {method === 'lightning' && (failed || noRate) && (
          <Button variant="secondary" fullWidth disabled={busy} onClick={pasteInvoice}>
            {t('reqPasteInvoice')}
          </Button>
        )}
      </div>
    </BottomSheet>
  )
}

/**
 * What the address field holds, as the engine gets it: trimmed, and a pasted `bitcoin:`
 * link reduced to its address (its amount is not ours: the sats come from requestSats).
 * A link the parser refuses (a `req-` parameter, a bad address) stays as typed and fails
 * the address check.
 */
function normalizeAddressInput(text: string): string {
  const s = text.trim()
  if (!/^bitcoin:/i.test(s)) return s
  return parseOnchainRequest(s)?.address ?? s
}

/** The one line a failed request shows; never server text. */
function lineFor(e: unknown, method: PayMethod, max: string): Line {
  const err = e as { message?: unknown; minSats?: unknown; maxSats?: unknown }
  const code = typeof err?.message === 'string' ? err.message : ''
  switch (code) {
    case 'unreachable':
      return { key: 'reqErrUnreachable' }
    case 'refused':
      return { key: 'reqErrRefused' }
    case 'range':
      return typeof err.minSats === 'number' && typeof err.maxSats === 'number'
        ? { key: 'reqErrRange', vars: { min: formatSats(err.minSats), max: formatSats(err.maxSats) } }
        : { key: 'reqErrRefused' }
    case 'mismatch':
      return { key: 'reqErrMismatch' }
    case 'bad-address':
      return { key: method === 'lightning' ? 'reqErrBadLnAddress' : 'reqErrBadAddress' }
    case 'reused':
      return { key: 'reqErrReused' }
    case 'no_address':
      return { key: 'reqNoAddress' }
    case 'room-unreadable':
      return { key: 'reqErrRoom' }
    case 'too_much':
      return { key: 'reqTooMuch', vars: { max } }
    case 'no_rate':
      return { key: 'reqNoRate' }
    default:
      // changed, not_matched, method, and what the screen already prevents
      // (not_ready, no_contact, busy, not_buyer, invalid_amount).
      return { key: 'reqChanged' }
  }
}
