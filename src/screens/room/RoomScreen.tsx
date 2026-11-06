import { useEffect, useMemo, useRef, useState } from 'react'
import type { ChatMessage, Currency } from '../../contracts'
import { actions, useIlchon } from '../../engine/browser'
import { useT } from '../../i18n'
import {
  AppBar,
  BottomSheet,
  Button,
  Card,
  Chip,
  EmptyState,
  IconButton,
  IconCopy,
  IconCheck,
  IconLock,
  IconSend,
  TextField,
  cx,
  useToast,
} from '../../ui'
import {
  amountToInput,
  formatClock,
  formatFee,
  formatMoney,
  formatSats,
  isLightningToken,
  isInvoiceToken,
  parseAmountInput,
  sanitizeAmountInput,
  satsFor,
  truncateMiddle,
} from './format'
import { ROOM_NS } from './strings'
import './RoomScreen.css'

export interface RoomScreenProps {
  contactId: string
  onBack: () => void
}

const NO_MESSAGES: ChatMessage[] = []

export function RoomScreen({ contactId, onBack }: RoomScreenProps) {
  const t = useT(ROOM_NS)
  const toast = useToast()

  const contacts = useIlchon((s) => s.contacts)
  const myOffer = useIlchon((s) => s.myOffer)
  const matches = useIlchon((s) => s.matches)
  const rates = useIlchon((s) => s.rates)
  const messages = useIlchon((s) => s.rooms[contactId] ?? NO_MESSAGES)

  const contact = contacts.find((c) => c.id === contactId)
  const name = contact?.name.trim() || t('unnamed')

  const match = matches.find((m) => m.contactId === contactId)
  const theirOffer =
    match && myOffer && match.offer.currency === myOffer.currency && match.offer.side !== myOffer.side
      ? match.offer
      : null
  const tradable = myOffer && theirOffer ? Math.min(myOffer.amount, theirOffer.amount) : null

  const [summaryOpen, setSummaryOpen] = useState(true)
  const composerRef = useRef<HTMLInputElement>(null)
  const [completedAt, setCompletedAt] = useState(0)
  const invoiceShared = messages.some((m) =>
    m.kind === 'text' && m.at > Math.max(completedAt, match?.matchedAt ?? Infinity) &&
    m.mine === (myOffer?.side === 'buy') &&
    m.status !== 'failed' && m.status !== 'sending' &&
    m.text.split(/\s+/).some(isInvoiceToken),
  )
  const [draft, setDraft] = useState('')
  const [sending, setSending] = useState(false)
  const [doneOpen, setDoneOpen] = useState(false)

  useEffect(() => {
    setCompletedAt(0)
    setSummaryOpen(true)
    setDraft('')
    setDoneOpen(false)
  }, [contactId])

  const endRef = useRef<HTMLDivElement>(null)
  const lastId = messages.length > 0 ? messages[messages.length - 1].id : ''
  useEffect(() => {
    endRef.current?.scrollIntoView({ block: 'end' })
  }, [lastId, messages.length])

  async function copy(text: string) {
    try {
      await navigator.clipboard.writeText(text)
      toast.show(t('copied'), 'success')
    } catch {
      toast.show(t('copyFailed'), 'error')
    }
  }

  async function paste() {
    composerRef.current?.focus()
    try {
      const text = (await navigator.clipboard.readText()).trim()
      if (!text) {
        toast.show(t('pasteEmpty'), 'info')
        return
      }
      setDraft((d) => (d.trim() ? `${d.trimEnd()} ${text}` : text))
    } catch {
      toast.show(t('pasteDenied'), 'warning')
    }
  }

  async function send() {
    const text = draft.trim()
    if (!text || sending) return
    setSending(true)
    setDraft('')
    try {
      await actions.sendChat(contactId, text)
    } catch {
      setDraft((d) => d || text)
      toast.show(t('sendFailed'), 'error')
    } finally {
      setSending(false)
    }
  }

  return (
    <div className="room">
      <AppBar
        title={name}
        onBack={onBack}
        border
        sticky={false}
        right={
          myOffer ? (
            <Button size="sm" variant="secondary" onClick={() => setDoneOpen(true)}>
              <span className="room__done-label">{t('markDone')}<small>{t('doneConsequence')}</small></span>
            </Button>
          ) : undefined
        }
      />

      <div className="room__summary">
        <Card padding="sm">
          <button type="button" className="room__summary-head"
            aria-expanded={summaryOpen} aria-controls="room-next-steps"
            onClick={() => setSummaryOpen((o) => !o)}>
            <span className="room__guide-heading"><strong>{t('nextSteps')}</strong>
              <span className="t-caption t-dim">{t(myOffer ? myOffer.side === 'buy' ? 'buyRole' : 'sellRole' : 'neutralRole', { currency: myOffer ? t(myOffer.currency) : '' })}</span>
            </span>
            <span className={cx('room__caret', summaryOpen && 'room__caret--open')} aria-hidden="true" />
          </button>
          {summaryOpen && <div id="room-next-steps" className="room__guide-body">
            {completedAt > 0 && <p className="room__guide-note" role="status">{t(myOffer ? 'partialDone' : 'allDone')}</p>}
            {!myOffer ? <p className="room__guide-note">{t('neutralHint')}</p> : <>
              {!theirOffer && <p className="room__guide-note">{t('notMatched')}</p>}
              <ol className="room__steps">
                <li><span className="room__step-number" aria-hidden="true">1</span><div>
                  <strong>{t('agreeStep')}</strong>
                  {theirOffer && tradable !== null ? <div className="room__terms">
                    <div className="room__sats-row"><span>{t('tradable')}</span><strong className="num">{formatMoney(tradable, myOffer.currency)}</strong></div>
                    <p className="room__guide-note">{t('smallerAmount')}</p>
                    <SatsBlock tradable={tradable} rate={rates[myOffer.currency]} myFee={myOffer.feePct} theirFee={theirOffer.feePct} />
                  </div> : <p className="room__guide-note">{t('agreeAgain')}</p>}
                </div></li>
                {myOffer.side === 'buy' ? <>
                  <li><StepNumber number={2} checked={invoiceShared} /><div><strong>{t('buyInvoice')}</strong>
                    {invoiceShared && <p className="room__guide-note">{t('invoiceShared')}</p>}
                    <Button size="sm" variant="secondary" onClick={() => void paste()}>{t('pasteInvoice')}</Button>
                  </div></li>
                  <li><StepNumber number={3} /><div><strong>{t('buyTransfer', { currency: t(myOffer.currency) })}</strong><p className="room__guide-note">{t('askAccount')}</p></div></li>
                  <li><StepNumber number={4} /><div><strong>{t('buyDone')}</strong></div></li>
                </> : <>
                  <li><StepNumber number={2} /><div><strong>{t('sellAccount')}</strong><Button size="sm" variant="secondary" onClick={() => composerRef.current?.focus()}>{t('writeAccount')}</Button></div></li>
                  <li><StepNumber number={3} /><div><strong>{t('sellVerify')}</strong><p className="room__guide-note">{t('verifyName')}</p></div></li>
                  <li><StepNumber number={4} /><div><strong>{t('sellPay')}</strong><p className="room__guide-note">{t(invoiceShared ? 'invoiceReceived' : 'invoiceWait')}</p></div></li>
                  <li><StepNumber number={5} /><div><strong>{t('sellDone')}</strong></div></li>
                </>}
              </ol>
              <p className="room__guide-note">{t('manualChecks')}</p>
            </>}
          </div>}
        </Card>
      </div>

      <div className="room__messages" role="log" aria-live="polite">
        {messages.length === 0 ? (
          <EmptyState title={t('emptyTitle')} body={t('emptyBody')} icon={<IconLock />} />
        ) : (
          messages.map((m) => <MessageItem key={m.id} message={m} onCopy={copy} copyLabel={t('copy')} />)
        )}
        <div ref={endRef} />
      </div>

      <div className="room__composer">
        {/* The buyer sends the invoice; the seller only receives one. */}
        {myOffer?.side !== 'sell' && <div className="room__shortcuts">
          <Chip icon={<IconCopy size={16} />} onClick={() => void paste()}>
            {t('pasteInvoice')}
          </Chip>
        </div>}
        <div className="room__input-row">
          <TextField
            inputRef={composerRef}
            label={t('inputPlaceholder')}
            className="room__input"
            value={draft}
            onChange={setDraft}
            placeholder={t('inputPlaceholder')}
            autoComplete="off"
            autoCapitalize="off"
            spellCheck={false}
            maxLength={4000}
            onEnter={() => void send()}
          />
          <IconButton
            icon={<IconSend />}
            label={t('send')}
            variant="primary"
            size="lg"
            disabled={sending || draft.trim() === ''}
            onClick={() => void send()}
          />
        </div>
      </div>

      {myOffer && (
        <DoneSheet
          open={doneOpen}
          onClose={() => setDoneOpen(false)}
          contactId={contactId}
          name={name}
          currency={myOffer.currency}
          myOpenAmount={myOffer.amount}
          suggested={tradable ?? myOffer.amount}
          onCompleted={() => setCompletedAt(Date.now())}
        />
      )}
    </div>
  )
}

function StepNumber({ number, checked = false }: { number: number; checked?: boolean }) {
  const t = useT(ROOM_NS)
  return <span className={cx('room__step-number', checked && 'room__step-number--checked')}>
    {checked ? <><IconCheck size={14} /><span className="sr-only">{t('invoiceShared')}</span></> : number}
  </span>
}

function SatsBlock(props: { tradable: number; rate: number | undefined; myFee: number; theirFee: number }) {
  const t = useT(ROOM_NS)
  const { tradable, rate, myFee, theirFee } = props
  const mine = rate ? satsFor(tradable, rate, myFee) : null
  const theirs = rate ? satsFor(tradable, rate, theirFee) : null
  if (mine === null || theirs === null) {
    return <p className="room__sats-note t-caption t-dim">{t('noRate')}</p>
  }
  if (myFee === theirFee) {
    return (
      <div className="room__sats">
        <SatsRow label={t('satsAtBoth', { fee: formatFee(myFee) })} sats={mine} />
      </div>
    )
  }
  return (
    <div className="room__sats">
      <SatsRow label={`${t('satsAtMine')} ${formatFee(myFee)}`} sats={mine} />
      <SatsRow label={`${t('satsAtTheirs')} ${formatFee(theirFee)}`} sats={theirs} />
      <p className="room__sats-note t-caption t-dim">{t('satsHint')}</p>
    </div>
  )
}

function SatsRow({ label, sats }: { label: string; sats: number }) {
  const t = useT(ROOM_NS)
  return (
    <div className="room__sats-row">
      <span className="t-caption t-dim">{label}</span>
      <span className="num">
        {formatSats(sats)} <span className="t-caption t-dim">{t('satsUnit')}</span>
      </span>
    </div>
  )
}

function MessageItem(props: { message: ChatMessage; onCopy: (text: string) => void; copyLabel: string }) {
  const { message, onCopy, copyLabel } = props
  const parts = useMemo(() => message.text.split(/(\s+)/), [message.text])

  if (message.kind === 'system') {
    return <p className="room__system t-caption t-dim">{message.text}</p>
  }

  return (
    <div
      className={cx(
        'room__msg',
        message.mine ? 'room__msg--mine' : 'room__msg--theirs',
        message.mine && message.status === 'sending' && 'room__msg--sending',
      )}
    >
      <div className="room__bubble">
        {parts.map((part, i) =>
          isLightningToken(part) ? (
            <span key={i} className="room__ln">
              <span className="room__ln-text">{truncateMiddle(part)}</span>
              <button type="button" className="room__ln-copy" aria-label={copyLabel} onClick={() => onCopy(part)}>
                <IconCopy size={16} />
                <span>{copyLabel}</span>
              </button>
            </span>
          ) : (
            <span key={i}>{part}</span>
          ),
        )}
      </div>
      <span className="room__time num">{formatClock(message.at)}</span>
      {message.mine && <MessageStatus message={message} />}
    </div>
  )
}

function MessageStatus({ message }: { message: ChatMessage }) {
  const t = useT(ROOM_NS)
  const toast = useToast()
  const [retrying, setRetrying] = useState(false)
  if (message.status === 'sending') {
    return <span className="room__status room__status--sending t-caption">{t('statusSending')}</span>
  }
  if (message.status !== 'failed') return null
  async function retry() {
    if (retrying) return
    setRetrying(true)
    try {
      await actions.retryChat(message.contactId, message.id)
    } catch {
      toast.show(t('sendFailed'), 'error')
    } finally {
      setRetrying(false)
    }
  }
  return (
    <button
      type="button"
      className="room__status room__status--failed t-caption"
      disabled={retrying}
      onClick={() => void retry()}
    >
      {t('statusFailed')}
    </button>
  )
}

function DoneSheet(props: {
  open: boolean
  onClose: () => void
  contactId: string
  name: string
  currency: Currency
  myOpenAmount: number
  suggested: number
  onCompleted: () => void
}) {
  const { open, onClose, contactId, name, currency, myOpenAmount, suggested } = props
  const t = useT(ROOM_NS)
  const toast = useToast()
  const [text, setText] = useState('')
  const [touched, setTouched] = useState(false)
  const [busy, setBusy] = useState(false)

  // Prefill each time the sheet opens; later offer updates must not overwrite typing.
  useEffect(() => {
    if (open) {
      setText(amountToInput(suggested, currency))
      setTouched(false)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open])

  const amount = parseAmountInput(text)
  const error = !(amount > 0)
    ? t('doneErrPositive')
    : amount > myOpenAmount
      ? t('doneErrTooMuch', { amount: formatMoney(myOpenAmount, currency) })
      : null

  async function confirm() {
    setTouched(true)
    if (error || busy) return
    setBusy(true)
    try {
      await actions.markDone(contactId, amount)
      props.onCompleted()
      toast.show(t('doneOk'), 'success')
      onClose()
    } catch {
      toast.show(t('doneFailed'), 'error')
    } finally {
      setBusy(false)
    }
  }

  return (
    <BottomSheet
      open={open}
      onClose={onClose}
      title={t('doneTitle')}
      footer={
        <Button fullWidth size="lg" loading={busy} onClick={() => void confirm()}>
          {t('doneConfirm')}
        </Button>
      }
    >
      <div className="ui-stack">
        <div className="room__notice">
          <p>{t('doneNotice1')}</p>
          <p className="t-bold">{t('doneNotice2', { name })}</p>
        </div>
        <TextField
          label={t('doneAmountLabel')}
          value={text}
          onChange={(v) => {
            setTouched(true)
            setText(sanitizeAmountInput(v, currency))
          }}
          inputMode={currency === 'KRW' ? 'numeric' : 'decimal'}
          numeric
          prefix={currency === 'KRW' ? '₩' : '$'}
          autoComplete="off"
          error={touched ? error : null}
          helper={t('doneHelper', { amount: formatMoney(myOpenAmount, currency) })}
          onEnter={() => void confirm()}
        />
      </div>
    </BottomSheet>
  )
}
