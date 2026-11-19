import { Component, useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import { CHAT_MAX, type CardView, type ChatMessage, type Currency, type PayMethod, type TradeStep, type TradeView } from '../../contracts'
import { actions, memo, useIlchon, useTradeView } from '../../engine/browser'
import { useT, type TFn } from '../../i18n'
import { INACTIVE_CARD, receivePlaceSent } from '../../engine/trade'
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
  useKeepCaret,
  useToast,
} from '../../ui'
import { doneApplyLabel, formatClock, isLightningToken, isInvoiceToken, systemMoney, truncateMiddle } from './format'
import { ROOM_NS } from './strings'
import { InvoiceCard } from './InvoiceCard'
import { OnchainCard } from './OnchainCard'
import { ReceiveSheet } from './ReceiveSheet'
import { useKeyboardGap } from './keyboard-gap'
import { askWhereKey, payCopy } from './pay-copy'
import { FIRST_SHOWN, jumpStep, roomWindow, shownToReach } from './window'
import { decodeInvoice, invoiceCandidates, invoiceIssues } from '../../lib/bolt11'
import { isPayCandidate, splitText } from '../../lib/pay'
import {
  amountInputMode,
  CURRENCY,
  formatFee,
  formatMoney,
  formatSats,
  minorToInput,
  parseMinor,
  sanitizeAmount,
  significantBefore,
} from '../../lib/money'
import './RoomScreen.css'

export interface RoomScreenProps {
  contactId: string
  onBack: () => void
}

const NO_MESSAGES: ChatMessage[] = []

interface GuideStep {
  title: string
  body?: ReactNode
  checked?: boolean
}

const draftKey = (contactId: string) => `draft:${contactId}`
function readDraft(contactId: string): string {
  const v = memo.get<unknown>(draftKey(contactId))
  return typeof v === 'string' ? v : ''
}

export function RoomScreen({ contactId, onBack }: RoomScreenProps) {
  const t = useT(ROOM_NS)
  const toast = useToast()

  const contacts = useIlchon((s) => s.contacts)
  // For drawing only; every trade rule comes from the view.
  const messages = useIlchon((s) => s.rooms[contactId] ?? NO_MESSAGES)
  // The room is being reopened: one status line instead of failures with no reason.
  const reopen = useIlchon((s) => s.reopening[contactId])
  const view = useTradeView(contactId)
  const myOffer = view.offer
  const theirOffer = view.theirOffer
  const tradable = view.tradeMinor
  const invoiceShared = view.receive === 'live'
  const invoiceExpired = view.receive === 'expired'
  // The buyer's step 2: a live receiving place of a method the trade still shares (trade.ts).
  const placeSent = receivePlaceSent(view)

  const contact = contacts.find((c) => c.id === contactId)
  const name = contact?.name.trim() || t('unnamed')

  const [summaryOpen, setSummaryOpen] = useState(true)
  const composerRef = useRef<HTMLInputElement>(null)
  /** The composer box, lifted above Android Chrome's keyboard bar (keyboard-gap.ts). */
  const composerBoxRef = useRef<HTMLDivElement>(null)
  useKeyboardGap(composerBoxRef)
  const [completedAt, setCompletedAt] = useState(0)
  // The chat line I was writing comes back after a relock or reload:
  // kept in the encrypted memo under draft:<contactId>, which removing the contact removes.
  const [draft, setDraft] = useState(() => readDraft(contactId))
  /** The room the draft in state belongs to: set by the reset below before it writes again. */
  const draftOf = useRef(contactId)
  const [sending, setSending] = useState(false)
  const [doneOpen, setDoneOpen] = useState(false)
  const [donePrefill, setDonePrefill] = useState<number | null>(null)
  const [shown, setShown] = useState(FIRST_SHOWN)
  /** A message to bring into view once it is drawn ('jump to' on the pinned card). */
  const [jumpTo, setJumpTo] = useState('')
  /** The receive sheet open now, by method; null when closed. */
  const [receiveOpen, setReceiveOpen] = useState<PayMethod | null>(null)

  // Before the reset below: on a room change it skips the old room's draft (draftOf).
  // Nothing once the contact is gone (removed while this room is still on screen): its
  // draft was removed with it and must not come back (the memo refuses it too).
  const known = contact !== undefined
  useEffect(() => {
    if (draftOf.current !== contactId || !known) return
    const key = draftKey(contactId)
    if (draft === '') memo.del(key)
    else if (memo.get(key) !== draft) memo.set(key, draft)
  }, [draft, contactId, known])

  useEffect(() => {
    setCompletedAt(0)
    setSummaryOpen(true)
    draftOf.current = contactId
    setDraft(readDraft(contactId))
    setDoneOpen(false)
    setDonePrefill(null)
    setShown(FIRST_SHOWN)
    setReceiveOpen(null)
    // A 'jump to' of the room left behind goes with it.
    setJumpTo('')
  }, [contactId])

  function goToStep(index: number) {
    const step = view.steps[index]
    if (step) void actions.setTradeStep(contactId, step)
  }

  function closeDone() {
    setDoneOpen(false)
    setDonePrefill(null)
  }

  function applyDoneFor(message: ChatMessage) {
    const p = message.kind === 'done' ? view.pendingDone.find((x) => x.messageId === message.id) : undefined
    if (!p || message.kind !== 'done') return undefined
    const currency = message.currency
    return {
      label: doneApplyLabel(t, p.amountMinor, currency),
      onClick: () => {
        setDonePrefill(p.prefillMinor)
        setDoneOpen(true)
      },
    }
  }

  const endRef = useRef<HTMLDivElement>(null)
  const listRef = useRef<HTMLDivElement>(null)
  // The latest messages, and the active card pinned above them while it is older.
  const win = roomWindow(messages, shown, view.activeCard)
  useEffect(() => {
    const step = jumpStep(win, jumpTo)
    if (step === 'none') return
    // Let go of a target the expanded history does not hold (jumpStep).
    setJumpTo('')
    if (step === 'drop') return
    const el = Array.from(listRef.current?.querySelectorAll<HTMLElement>('[data-msg]') ?? []).find((x) => x.dataset.msg === jumpTo)
    if (!el) return
    el.scrollIntoView({ block: 'center' })
    // Focus follows to the card's message, so the next Tab reaches the card's own buttons.
    el.tabIndex = -1
    el.focus({ preventScroll: true })
  }, [jumpTo, win.visible])

  function jumpToPinned() {
    if (!win.pinned) return
    setShown((n) => shownToReach(messages.length, win.pinnedIndex, n))
    setJumpTo(win.pinned.id)
  }
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
      const candidates = invoiceCandidates(text)
      const invoice = candidates.map(decodeInvoice).find((inv) => inv !== null) ?? null
      if (!invoice) {
        toast.show(t(candidates.some(isInvoiceToken) ? 'pasteInvalid' : 'pasteNotInvoice'), 'error')
        return
      }
      const issues = invoiceIssues(invoice, Date.now())
      if (issues.includes('expired')) {
        toast.show(t('pasteExpired'), 'error')
        return
      }
      if (issues.includes('notMainnet')) {
        toast.show(t('pasteNetwork'), 'error')
        return
      }
      setDraft((d) => (d.trim() ? `${d.trimEnd()} ${invoice.invoice}` : invoice.invoice))
      toast.show(t('pasteCheck'), 'info')
    } catch {
      toast.show(t('pasteDenied'), 'warning')
    }
  }

  /** Put a ready-made message in the composer; the user edits it before sending. */
  function insert(text: string) {
    setDraft((d) => (d.trim() ? `${d.trimEnd()} ${text}` : text))
    composerRef.current?.focus()
  }

  async function send() {
    const text = draft.trim()
    if (!text || sending) return
    setSending(true)
    setDraft('')
    try {
      await actions.sendChat(contactId, text)
    } catch (e) {
      setDraft((d) => d || text)
      if (e instanceof Error && e.message === 'too_long') toast.show(t('tooLong', { max: CHAT_MAX }), 'error')
      else toast.show(t('sendFailed'), 'error')
    } finally {
      setSending(false)
    }
  }

  // Where the buyer receives: one button per shared method, only while matched.
  // Pasting into the chat stays possible at any time.
  const sendMethods: PayMethod[] = myOffer?.side === 'buy' && theirOffer ? view.methods : []
  const methodKey = (m: PayMethod) => (m === 'lightning' ? 'sendLightning' : 'sendOnchain')
  const onchainActive = view.activeKind === 'onchain'
  // An address is not an invoice: the words that name where the bitcoin goes follow
  // the active card's kind, each a whole sentence of its own (pay-copy.ts).
  const words = payCopy(view.activeKind, view.methods)

  // Title keys by step: agree agreeStep; buy receive buyInvoice, transfer
  // buyTransfer, done buyDone; sell account sellAccount, verify sellVerify, pay sellPay, done sellDone.
  const bodies: Record<TradeStep, GuideStep> | null = myOffer ? {
    agree: {
      title: t('agreeStep'),
      body: theirOffer && tradable !== null ? <div className="room__terms">
        <div className="room__sats-row"><span>{t('tradable')}</span><strong className="num">{formatMoney(tradable, myOffer.currency)}</strong></div>
        <SatsBlock sats={view.sats} myFee={myOffer.feePct} theirFee={theirOffer.feePct} />
      </div> : <p className="room__guide-note">{t('agreeAgain')}</p>,
    },
    receive: {
      title: t('buyInvoice'),
      checked: placeSent,
      body: <>
        {!placeSent && <p className="room__guide-note">{t('buyInvoiceWallet')}</p>}
        {placeSent && <p className="room__guide-note">{t(words.shared)}</p>}
        {sendMethods.length > 0 && <div className="room__step-actions">
          {sendMethods.map((m) => (
            <Button key={m} size="sm" variant="secondary" onClick={() => setReceiveOpen(m)}>{t(methodKey(m))}</Button>
          ))}
        </div>}
      </>,
    },
    transfer: { title: t('buyTransfer', { currency: t(myOffer.currency) }), body: <p className="room__guide-note">{t('askAccount')}</p> },
    done: {
      title: t(myOffer.side === 'buy' ? 'buyDone' : 'sellDone'),
      // On-chain takes blocks; the app never looks.
      body: myOffer.side === 'buy' && onchainActive ? <p className="room__guide-note">{t('buyDoneOnchain')}</p> : undefined,
    },
    account: {
      title: t('sellAccount'),
      body: <Button size="sm" variant="secondary" onClick={() => composerRef.current?.focus()}>{t('writeAccount')}</Button>,
    },
    verify: {
      title: t('sellVerify'),
      body: <>
        <p className="room__guide-note">{t('verifyName')}</p>
        {invoiceShared && <p className="room__guide-note">{t(words.waitDeposit)}</p>}
      </>,
    },
    pay: {
      title: t(words.sellPay),
      // The name I gave this contact, to hold against the depositor's name.
      body: <>
        <p className="room__guide-note">{t('sellPayTo', { name })}</p>
        {onchainActive ? <>
          <p className="room__guide-note">{t('sellPayOnchain')}</p>
          {/* The sending seller's wallet adds the fee. */}
          <p className="room__guide-note">{t('sellPayOnchainFee')}</p>
        </> : !invoiceExpired && <p className="room__guide-note">{t(invoiceShared ? 'invoiceReceived' : words.wait)}</p>}
      </>,
    },
  } : null
  const guideSteps: GuideStep[] = bodies ? view.steps.map((st) => bodies[st]) : []
  const step = view.step ? Math.max(view.steps.indexOf(view.step), 0) : 0
  const currentStep = guideSteps[step]

  return (
    // A full-screen layer over the tabs (made inert), like the connect screen: a dialog
    // named after the contact, so its content sits inside a landmark-like region. Not
    // aria-modal: VoiceOver would then hide the toast live region, which is
    // portalled to <body>; the inert tabs already keep focus and reading in the room.
    <div className="room" role="dialog" aria-label={name}>
      <AppBar
        title={name}
        onBack={onBack}
        border
        sticky={false}
        right={
          myOffer ? (
            <Button size="sm" variant="secondary" onClick={() => {
              // Answer the peer's completion with its own amount, or the two records never pair up.
              setDonePrefill(view.pendingDone[0]?.prefillMinor ?? null)
              setDoneOpen(true)
            }}>
              <span className="room__done-label">{t('markDone')}<small>{t('doneConsequence')}</small></span>
            </Button>
          ) : undefined
        }
      />

      {myOffer && (
        <div className={cx('room__role', `room__role--${myOffer.side}`)} role="status">
          <span className="room__role-me">{t(myOffer.side === 'buy' ? 'roleBuyer' : 'roleSeller')}</span>
          {theirOffer && tradable !== null && <span className="room__role-peer">
            {t(myOffer.side === 'buy' ? 'peerSeller' : 'peerBuyer', { name })}
            {t('sep')}<span className="num">{t('tradableShort', { amount: formatMoney(tradable, myOffer.currency) })}</span>
          </span>}
        </div>
      )}

      <div className="room__summary">
        <Card padding="sm">
          <button type="button" className="room__summary-head"
            aria-expanded={summaryOpen} aria-controls="room-next-steps"
            onClick={() => setSummaryOpen((o) => !o)}>
            <span className="room__guide-heading"><strong>{t('nextSteps')}</strong>
              {!summaryOpen && myOffer && invoiceExpired
                ? <span className="t-caption t-dim">{t(myOffer.side === 'buy' ? 'invoiceExpiredBuy' : 'invoiceExpiredSell')}</span>
                : !summaryOpen && currentStep
                ? <span className="room__guide-current t-caption t-dim">{t('stepSummary', { n: step + 1, total: guideSteps.length, title: currentStep.title })}</span>
                : <span className="t-caption t-dim">{t(myOffer ? myOffer.side === 'buy' ? 'buyRole' : 'sellRole' : 'neutralRole', { currency: myOffer ? t(myOffer.currency) : '' })}</span>}
            </span>
            <span className={cx('room__caret', summaryOpen && 'room__caret--open')} aria-hidden="true" />
          </button>
          {summaryOpen && <div id="room-next-steps" className="room__guide-body">
            {completedAt > 0 && <p className="room__guide-note" role="status">{t(myOffer ? 'partialDone' : 'allDone')}</p>}
            {!myOffer ? <p className="room__guide-note">{t('neutralHint')}</p> : <>
              {!theirOffer && <p className="room__guide-note">{t('notMatched')}</p>}
              <ol className="room__stepper" aria-label={t('stepsLabel')}>
                {guideSteps.map((s, i) => (
                  <li key={i} className="room__stepper-item">
                    <button type="button" className="room__stepper-btn"
                      aria-current={i === step ? 'step' : undefined}
                      aria-label={t(s.checked ? words.stepGoChecked : 'stepGo', { n: i + 1, title: s.title })}
                      onClick={() => goToStep(i)}>
                      <span className={cx('room__stepper-dot', i === step && 'room__stepper-dot--current',
                        i < step && 'room__stepper-dot--past', s.checked && i !== step && 'room__stepper-dot--checked')}>
                        {s.checked && i !== step ? <IconCheck size={14} /> : i + 1}
                      </span>
                    </button>
                  </li>
                ))}
              </ol>
              {invoiceExpired && <p className="room__guide-note" role="status">{t(myOffer.side === 'buy' ? 'invoiceExpiredBuy' : 'invoiceExpiredSell')}</p>}
              {currentStep && <div className="room__step">
                <StepNumber number={step + 1} checked={currentStep.checked} checkedLabel={t(words.shared)} />
                <div><strong>{currentStep.title}</strong>{currentStep.body}</div>
              </div>}
              {step > 0 && <p className="room__guide-note">{t('manualChecks')}</p>}
              <div className="room__step-nav">
                <Button size="sm" variant="secondary" disabled={step === 0} onClick={() => goToStep(step - 1)}>{t('stepPrev')}</Button>
                <Button size="sm" variant="secondary" disabled={step === guideSteps.length - 1} onClick={() => goToStep(step + 1)}>{t('stepNext')}</Button>
              </div>
            </>}
          </div>}
        </Card>
      </div>

      <div ref={listRef} className="room__messages" role="log" aria-live="polite" aria-relevant="additions">
        {messages.length === 0 ? (
          <EmptyState title={t('emptyTitle')} body={t('emptyBody')} icon={<IconLock />} />
        ) : (
          <>
            {win.pinned && (
              <section className="room__pinned" aria-label={t('activePlacePinned')}>
                <div className="room__pinned-head">
                  <strong className="t-caption">{t('activePlacePinned')}</strong>
                  <Button size="sm" variant="ghost" onClick={jumpToPinned}>{t('activePlaceJump')}</Button>
                </div>
                <MessageGuard message={win.pinned}>
                  <MessageItem message={win.pinned} onCopy={copy} copyLabel={t('copy')} view={view} />
                </MessageGuard>
              </section>
            )}
            {win.hidden > 0 && (
              <Button size="sm" variant="secondary" onClick={() => setShown((n) => n + FIRST_SHOWN)}>{t('showEarlier')}</Button>
            )}
            {win.visible.map((m) => (
              <MessageGuard key={m.id} message={m}>
                <MessageItem message={m} onCopy={copy} copyLabel={t('copy')} view={view} applyDone={applyDoneFor(m)} anchor />
              </MessageGuard>
            ))}
          </>
        )}
        <div ref={endRef} />
      </div>

      <div className="room__composer" ref={composerBoxRef}>
        {reopen && (
          <p className="room__reopen" role="status">
            {reopen.scan ? t('reopenScan') : reopen.at !== undefined ? t('reopenAt', { time: formatClock(reopen.at) }) : t('reopenSoon')}
          </p>
        )}
        {/* Role-specific shortcuts: the matched buyer sends where to receive and asks for
            the account; the seller shares the account and asks where to send. */}
        <div className="room__shortcuts">
          {sendMethods.map((m) => (
            <Chip key={m} onClick={() => setReceiveOpen(m)}>{t(methodKey(m))}</Chip>
          ))}
          {myOffer?.side === 'buy' && <Chip onClick={() => insert(t('msgAskAccount'))}>{t('chipAskAccount')}</Chip>}
          {myOffer?.side === 'sell' && <>
            <Chip onClick={() => insert(t('msgSendAccount'))}>{t('chipSendAccount')}</Chip>
            <Chip onClick={() => insert(t(askWhereKey(view.methods)))}>{t('chipAskInvoice')}</Chip>
          </>}
        </div>
        <div className="room__input-row" onFocusCapture={() => setSummaryOpen(false)}>
          <TextField
            inputRef={composerRef}
            label={t('inputPlaceholder')}
            className="room__input"
            value={draft}
            onChange={setDraft}
            placeholder={t('inputPlaceholder')}
            // Not a login field to the browser (password managers took it for one): no credential token, a plain name.
            name="ilchon-chat"
            autoComplete="off"
            autoCapitalize="off"
            spellCheck={false}
            maxLength={CHAT_MAX}
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

      {receiveOpen && (
        <ReceiveSheet
          open
          method={receiveOpen}
          contactId={contactId}
          view={view}
          onClose={() => setReceiveOpen(null)}
          onPasteInvoice={() => void paste()}
        />
      )}

      {myOffer && (
        <DoneSheet
          open={doneOpen}
          onClose={closeDone}
          contactId={contactId}
          name={name}
          currency={myOffer.currency}
          myOpenMinor={myOffer.amountMinor}
          suggested={donePrefill ?? view.doneSuggestionMinor ?? myOffer.amountMinor}
          sellerFirst={myOffer.side === 'sell' && invoiceShared}
          noticeKey={words.doneNotice}
          onCompleted={() => setCompletedAt(Date.now())}
        />
      )}
    </div>
  )
}

function StepNumber({ number, checked = false, checkedLabel }: { number: number; checked?: boolean; checkedLabel: string }) {
  return <span className={cx('room__step-number', checked && 'room__step-number--checked')}>
    {checked ? <><IconCheck size={14} /><span className="sr-only">{checkedLabel}</span></> : number}
  </span>
}

function SatsBlock(props: { sats: TradeView['sats']; myFee: number; theirFee: number }) {
  const t = useT(ROOM_NS)
  const { sats, myFee, theirFee } = props
  if (sats === null) {
    return <p className="room__sats-note t-caption t-dim">{t('noRate')}</p>
  }
  if (myFee === theirFee) {
    return (
      <div className="room__sats">
        <SatsRow label={t('satsAtBoth', { fee: formatFee(myFee) })} sats={sats.mine} />
      </div>
    )
  }
  return (
    <div className="room__sats">
      <SatsRow label={t('satsAtMine', { fee: formatFee(myFee) })} sats={sats.mine} />
      <SatsRow label={t('satsAtTheirs', { fee: formatFee(theirFee) })} sats={sats.theirs} />
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

/**
 * One message behind its own error boundary: a message that fails to draw
 * shows as plain text (or not at all) and never takes the room down.
 */
class MessageGuard extends Component<{ message: ChatMessage; children: ReactNode }, { failed: boolean }> {
  state = { failed: false }
  static getDerivedStateFromError(): { failed: boolean } {
    return { failed: true }
  }
  render(): ReactNode {
    if (!this.state.failed) return this.props.children
    const m = this.props.message
    if (m.kind !== 'text') return null
    return (
      <div className={cx('room__msg', m.mine ? 'room__msg--mine' : 'room__msg--theirs')}>
        <div className="room__bubble"><span>{m.text}</span></div>
      </div>
    )
  }
}

function MessageItem(props: {
  message: ChatMessage
  onCopy: (text: string) => void
  copyLabel: string
  view: TradeView
  /** A peer's completion I can apply to my own offer too. */
  applyDone?: { label: string; onClick: () => void }
  /** Drawn in the message list (not the pinned copy): marked so 'jump to' can find it. */
  anchor?: boolean
}) {
  const { message, onCopy, copyLabel, view, applyDone, anchor = false } = props
  const mark = anchor ? { 'data-msg': message.id } : {}
  const t = useT(ROOM_NS)
  const body = message.kind === 'text' ? message.text : ''
  // Only payment request candidates are parsed; plain text is one span.
  const parts = useMemo(
    () => (body.split(/\s+/).some((x) => isPayCandidate(x) || isLightningToken(x)) ? splitText(body) : null),
    [body],
  )

  if (message.kind !== 'text') {
    // Markers are stored as codes; the sentence follows the current language.
    if (!applyDone) return <p className="room__system t-caption t-dim" {...mark}>{systemLine(t, message)}</p>
    const note = <p className="room__system t-caption t-dim">{systemLine(t, message)}</p>
    return (
      <div className="room__system-action" {...mark}>
        {note}
        <Button size="sm" variant="secondary" onClick={applyDone.onClick}>{applyDone.label}</Button>
      </div>
    )
  }

  return (
    <div
      {...mark}
      className={cx(
        'room__msg',
        message.mine ? 'room__msg--mine' : 'room__msg--theirs',
        message.mine && message.status === 'sending' && 'room__msg--sending',
      )}
    >
      <div className="room__bubble">
        {parts === null ? <span>{body}</span> : parts.map(({ text: part, ref }, i) =>
          ref?.kind === 'lightning' ? (
            <InvoiceCard key={i} invoice={ref.invoice} card={cardOf(view, `${message.id}:${i}`)} mine={message.mine}
              currency={view.offer?.currency ?? null} onCopy={onCopy} />
          ) : ref?.kind === 'onchain' ? (
            <OnchainCard key={i} req={ref.req} card={cardOf(view, `${message.id}:${i}`)} mine={message.mine}
              currency={view.offer?.currency ?? null} onCopy={onCopy} />
          ) : isLightningToken(part) ? (
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

function cardOf(view: TradeView, key: string): CardView {
  return view.cards[key] ?? INACTIVE_CARD
}

/** The sentence of a stored marker, in the language now on screen. */
function systemLine(t: TFn, m: Exclude<ChatMessage, { kind: 'text' }>): string {
  if (m.kind === 'matched') return t('sysMatched')
  // The contact's side reopened our channel without a scan of mine.
  if (m.kind === 'reopened') return t('sysReopened')
  if (m.kind === 'done') return t(m.mine ? 'sysDoneMine' : 'sysDoneTheirs', { amount: systemMoney(t, m.amountMinor, m.currency) })
  const amount = m.before.amountMinor !== m.after.amountMinor
  const fee = m.before.feePct !== m.after.feePct
  const from = systemMoney(t, m.before.amountMinor, m.currency)
  const to = systemMoney(t, m.after.amountMinor, m.currency)
  if (amount && fee) {
    return t('sysChangedBoth', { amountFrom: from, amountTo: to, feeFrom: formatFee(m.before.feePct), feeTo: formatFee(m.after.feePct) })
  }
  if (amount) return t('sysChangedAmount', { from, to })
  return t('sysChangedFee', { from: formatFee(m.before.feePct), to: formatFee(m.after.feePct) })
}

function MessageStatus({ message }: { message: Extract<ChatMessage, { kind: 'text' }> }) {
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
  /** My open amount, minor units. */
  myOpenMinor: number
  /** Minor units. */
  suggested: number
  /** I sell and the current invoice is live: marking done greys it (doneSellerFirst). */
  sellerFirst: boolean
  /** The first notice, in the words of the trade's kind (pay-copy.ts doneNotice). */
  noticeKey: string
  onCompleted: () => void
}) {
  const { open, onClose, contactId, name, currency, myOpenMinor, suggested, sellerFirst, noticeKey } = props
  const t = useT(ROOM_NS)
  const toast = useToast()
  const [text, setText] = useState('')
  const [touched, setTouched] = useState(false)
  const [busy, setBusy] = useState(false)
  const keepCaret = useKeepCaret()

  // Prefill each time the sheet opens; later offer updates must not overwrite typing.
  useEffect(() => {
    if (open) {
      setText(minorToInput(suggested, currency))
      setTouched(false)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open])

  const minor = parseMinor(text, currency)
  const error = Number.isNaN(minor)
    ? t('doneErrPositive')
    : minor > myOpenMinor
      ? t('doneErrTooMuch', { amount: formatMoney(myOpenMinor, currency) })
      : null

  async function confirm() {
    setTouched(true)
    if (error || busy) return
    setBusy(true)
    try {
      await actions.markDone(contactId, minor)
      props.onCompleted()
      toast.show(t('doneOk'), 'success')
      onClose()
    } catch (e) {
      if (e instanceof Error && e.message === 'too_much') toast.show(t('doneErrTooMuch', { amount: formatMoney(myOpenMinor, currency) }), 'error')
      else toast.show(t('doneFailed'), 'error')
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
          <p>{t(noticeKey)}</p>
          <p className="t-bold">{t('doneNotice2', { name })}</p>
          {sellerFirst && <p>{t('doneSellerFirst')}</p>}
        </div>
        <TextField
          label={t('doneAmountLabel')}
          value={text}
          onChange={(v, inputType, data, composing) => {
            setTouched(true)
            keepCaret(v, CURRENCY[currency].decimals === 0 ? /\d/ : /[\d.]/, (r, p) => significantBefore(r, p, currency))
            setText(sanitizeAmount(v, currency, amountInputMode(inputType, data, composing)))
          }}
          inputMode={CURRENCY[currency].inputMode}
          numeric
          prefix={CURRENCY[currency].symbol}
          autoComplete="off"
          error={touched ? error : null}
          helper={t('doneHelper', { amount: formatMoney(myOpenMinor, currency) })}
          onEnter={() => void confirm()}
        />
      </div>
    </BottomSheet>
  )
}
