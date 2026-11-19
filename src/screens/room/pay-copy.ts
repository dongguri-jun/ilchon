import type { CardView, PayMethod } from '../../contracts'

/**
 * Room string keys that name where the bitcoin goes, by the kind of the active card.
 * A Lightning card is an invoice the seller pays with a Lightning wallet; an on-chain card
 * is an address the seller sends to from a bitcoin wallet. Each kind has its own whole sentence: no sentence is built from a
 * conditional piece (check-i18n T12). The warnings appear under the same conditions on
 * both cards (InvoiceCard's table); only their words follow the kind.
 */
export const PAY_COPY = {
  lightning: {
    /** The buyer's grey note on the seller's card. */
    notPayer: 'invNotPayer',
    /** The active card has no amount. */
    noAmount: 'invIssueNoAmount',
    /** The active card asks for more than the trade amount at my premium (a safety key). */
    over: 'invIssueOver',
    /** Under "Open in wallet". */
    openHint: 'invOpenHint',
    /** Under "Open in wallet" on a card without an amount. */
    openHintNoAmount: 'invOpenHint',
    /** Buyer, receive step, once the card is live; also the step's checked mark. */
    shared: 'invoiceShared',
    /** The receive step's checked mark in the step list. */
    stepGoChecked: 'stepGoChecked',
    /** Seller, verify step, while the card is live. */
    waitDeposit: 'invoiceWaitDeposit',
    /** Seller, pay step title. */
    sellPay: 'sellPay',
    /** Seller, pay step, before any card came. */
    wait: 'invoiceWait',
    /** The done sheet's first notice (which wallet the bitcoin goes through). */
    doneNotice: 'doneNotice1',
  },
  onchain: {
    notPayer: 'invNotPayerOnchain',
    noAmount: 'invIssueNoAmountOnchain',
    over: 'invIssueOverOnchain',
    openHint: 'invOpenHintOnchain',
    openHintNoAmount: 'invOpenHintOnchainNoAmount',
    shared: 'addressShared',
    stepGoChecked: 'stepGoCheckedOnchain',
    waitDeposit: 'addressWaitDeposit',
    sellPay: 'sellPayOnchainTitle',
    wait: 'addressWait',
    doneNotice: 'doneNotice1Onchain',
  },
} as const satisfies Record<PayMethod, Record<string, string>>

export type PayCopy = (typeof PAY_COPY)[PayMethod]

/**
 * The keys for the trade view's active card kind (TradeView.activeKind). Without an active
 * card, a trade whose only shared method is on-chain (TradeView.methods) already speaks of
 * an address; any other trade speaks of an invoice, as the room did before on-chain cards.
 */
export function payCopy(kind: PayMethod | null, methods: readonly PayMethod[] = []): PayCopy {
  if (kind) return PAY_COPY[kind]
  return PAY_COPY[methods.length === 1 && methods[0] === 'onchain' ? 'onchain' : 'lightning']
}

/**
 * Every note and warning row an on-chain card shows, as room string keys, in order
 * (OnchainCard draws exactly these). Inactive: the buyer's grey note on the seller's card,
 * or "not where to send" on a card of the contact's that is no longer active. Active: no
 * amount, more than the trade amount. All of them in an address's words.
 */
export function onchainCardNotes(card: CardView, hasAmount: boolean, mine: boolean): string[] {
  const copy = PAY_COPY.onchain
  if (card.state !== 'active') {
    if (card.state === 'notPayer') return [copy.notPayer]
    return mine ? [] : ['invInactive']
  }
  return [...(hasAmount ? [] : [copy.noAmount]), ...(card.over ? [copy.over] : [])]
}

/**
 * The sentence the seller's "ask where to send" chip puts in the composer:
 * a trade whose only shared method is on-chain asks for an on-chain address, a
 * Lightning-only trade asks for a Lightning invoice, and a trade sharing both (or with no
 * match yet, TradeView.methods []) asks for either. Whole sentences (check-i18n T12).
 */
export function askWhereKey(methods: readonly PayMethod[]): 'msgAskInvoice' | 'msgAskInvoiceLightning' | 'msgAskInvoiceOnchain' {
  if (methods.length !== 1) return 'msgAskInvoice'
  return methods[0] === 'onchain' ? 'msgAskInvoiceOnchain' : 'msgAskInvoiceLightning'
}
