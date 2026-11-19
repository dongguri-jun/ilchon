/**
 * Trade rules derived from a room's messages and my offer. Nothing here is stored: a trade is the stretch of the room after the
 * markers my own clock wrote. Text times and the contact's clock are never used.
 * Pure functions, no DOM. tradeView is everything the trade room shows that is not
 * plain chat: the one active payment card, who may pay it, the amount line
 * and warning, the guide step. The screen only draws its result.
 */
import { TRADE_STEPS, type CardView, type ChatMessage, type Offer, type TradeStep, type TradeView, type TradeViewFn } from '../contracts'
import { commonMethods } from '../lib/match'
import { asksOver, fiatFor, satsFor } from '../lib/money'
import { splitText, type PayRef } from '../lib/pay'

export interface TradeBounds {
  /** Index of my last completion that ended a trade; cards before it belong to finished trades. -1 when none. */
  cut: number
  /** Index of the last 'matched' marker recorded since my offer was created (at >= offer.createdAt); -1 when none or no offer. */
  matchIdx: number
  /** `at` of my last completion, 0 when none. */
  lastDoneAt: number
  /** Indexes of their completions within my offer that I have not mirrored, ascending. */
  theirsOpen: number[]
}

export function tradeBounds(messages: readonly ChatMessage[], offer: Offer | null): TradeBounds {
  let matchIdx = -1
  if (offer) {
    messages.forEach((m, i) => {
      if (m.kind === 'matched' && m.at >= offer.createdAt) matchIdx = i
    })
  }

  let cut = -1
  let lastDoneAt = 0
  /** `${currency}:${amountMinor}` -> their completions in my offer, not mirrored. */
  const theirsOpen = new Map<string, number[]>()
  /** `${currency}:${amountMinor}` -> my completions (any offer) they have not mirrored. */
  const mineOpen = new Map<string, number>()
  messages.forEach((m, i) => {
    if (m.kind !== 'done') return
    const inOffer = offer !== null && m.currency === offer.currency && m.at >= offer.createdAt
    const key = `${m.currency}:${m.amountMinor}`
    if (m.mine) {
      lastDoneAt = m.at
      const open = inOffer ? theirsOpen.get(key) : undefined
      // Answered their earlier completion: that trade ended there.
      if (open && open.length > 0) cut = Math.max(cut, open.shift()!)
      else {
        mineOpen.set(key, (mineOpen.get(key) ?? 0) + 1)
        cut = i
      }
    } else {
      const n = mineOpen.get(key) ?? 0
      // They mirrored one of mine, even one from an earlier offer.
      if (n > 0) mineOpen.set(key, n - 1)
      else if (inOffer) theirsOpen.set(key, [...(theirsOpen.get(key) ?? []), i])
    }
  })
  const open = [...theirsOpen.values()].flat().sort((a, b) => a - b)
  return { cut, matchIdx, lastDoneAt, theirsOpen: open }
}

/** What a card is when tradeView has nothing to say about it. */
export const INACTIVE_CARD: CardView = { state: 'inactive', pay: false, fiatMinor: null, over: false }

/**
 * The trade room of `contactId`. Same input, same result.
 * The payment button and the active card follow only these rules: the latest card the
 * buyer sent in the current trade is the one active card, every other card is grey, and
 * the button is there only while that contact matches my offer now.
 */
export const tradeView: TradeViewFn = (s, contactId, nowMs) => {
  // 1, 2, 3: my offer, theirs while it is opposite in the same currency with a method in
  // common (the engine keeps no match without one; a defence), the
  // trade amount.
  const messages = s.rooms[contactId] ?? []
  const offer = s.myOffer
  const match = s.matches.find((m) => m.contactId === contactId)
  const theirOffer = offer && match && match.offer.currency === offer.currency && match.offer.side !== offer.side && commonMethods(offer.methods, match.offer.methods).length > 0 ? match.offer : null
  const methods = offer && theirOffer ? commonMethods(offer.methods, theirOffer.methods) : []
  const tradeMinor = offer && theirOffer ? Math.min(offer.amountMinor, theirOffer.amountMinor) : null
  const rate = offer ? s.rates[offer.currency] : undefined
  let sats: { mine: number; theirs: number } | null = null
  if (offer && theirOffer && tradeMinor !== null) {
    const mine = satsFor(tradeMinor, offer.currency, rate, offer.feePct)
    const theirs = satsFor(tradeMinor, offer.currency, rate, theirOffer.feePct)
    if (mine !== null && theirs !== null) sats = { mine, theirs }
  }

  // 4: where the current trade starts.
  const { cut, matchIdx, lastDoneAt, theirsOpen } = tradeBounds(messages, offer)
  const hasTrade = offer !== null && (matchIdx >= 0 || theirOffer !== null)
  const start = Math.max(cut, matchIdx)

  // 5: every payment request in the texts, in order.
  const found: { key: string; idx: number; m: Extract<ChatMessage, { kind: 'text' }>; ref: PayRef }[] = []
  messages.forEach((m, idx) => {
    if (m.kind !== 'text') return
    splitText(m.text).forEach((part, i) => {
      if (part.ref) found.push({ key: `${m.id}:${i}`, idx, m, ref: part.ref })
    })
  })

  // 6: requests of finished trades never come back; the last eligible card is active.
  const settledIds = new Set(found.filter((c) => c.idx < cut).map((c) => c.ref.id))
  let active: (typeof found)[number] | null = null
  if (offer && hasTrade) {
    const fromBuyer = offer.side === 'buy'
    for (const c of found) {
      if (c.idx <= start || c.m.mine !== fromBuyer) continue
      if (c.m.mine && c.m.status === 'failed') continue
      if (settledIds.has(c.ref.id)) continue
      active = c
    }
  }
  const activeCard = active?.key ?? ''

  const cards: Record<string, CardView> = {}
  for (const c of found) {
    if (!offer) cards[c.key] = INACTIVE_CARD
    else if (offer.side === 'buy' && !c.m.mine) cards[c.key] = { ...INACTIVE_CARD, state: 'notPayer' }
    else if (c !== active) cards[c.key] = INACTIVE_CARD
    else {
      const amountSats = c.ref.amountSats
      const sell = offer.side === 'sell'
      cards[c.key] = {
        state: 'active',
        pay: sell && match !== undefined,
        fiatMinor: amountSats !== null ? fiatFor(amountSats, rate, offer.feePct, offer.currency) : null,
        // The limit is the seller's own premium only: the contact's premium cannot widen it.
        over: sell && amountSats !== null && asksOver(amountSats, tradeMinor ?? offer.amountMinor, offer.currency, rate, offer.feePct),
      }
    }
  }

  // 7: the active card for the guide.
  let receive: 'none' | 'live' | 'expired' = 'none'
  let receiveExpiresAt = 0
  if (active && active.ref.mainnet) {
    const exp = active.ref.expiresAt
    if (exp !== null && exp - Math.floor(nowMs / 1000) <= 0) receive = 'expired'
    else {
      receive = 'live'
      receiveExpiresAt = exp ?? 0
    }
  }

  // 8, 9: completions of theirs I have not answered, and what the done sheet suggests.
  const pendingDone = offer
    ? theirsOpen.flatMap((i) => {
        const m = messages[i]
        return m.kind === 'done' ? [{ messageId: m.id, amountMinor: m.amountMinor, prefillMinor: Math.min(m.amountMinor, offer.amountMinor) }] : []
      })
    : []
  const doneSuggestionMinor = offer ? Math.min(pendingDone[0]?.amountMinor ?? tradeMinor ?? offer.amountMinor, offer.amountMinor) : null

  // 10: the guide. A new active card moves it on once; a stored step of the same trade wins otherwise.
  const steps: readonly TradeStep[] = offer ? TRADE_STEPS[offer.side] : []
  const stepKey = offer ? `${offer.createdAt}:${lastDoneAt}` : ''
  let step: TradeStep | null = null
  if (offer) {
    const rec = s.tradeSteps[contactId]
    const saved = rec && rec.key === stepKey && steps.includes(rec.step) ? rec : { step: 'agree' as TradeStep, card: '' }
    const auto: TradeStep = offer.side === 'buy' ? 'transfer' : 'account'
    const moved = activeCard !== '' && activeCard !== saved.card && steps.indexOf(auto) > steps.indexOf(saved.step)
    step = moved ? auto : saved.step
    // The buyer's step 2 opened again (receivePlaceSent): the seller changed its methods after
    // my live card, which is no longer of a shared method. Only a step 3 the card moved me to
    // by itself goes back to step 2; a step I stored by hand wins (Next and Prev always work)
    // and 'done' is never pulled back, so a buyer who already paid is not asked for a second
    // receiving place. A new card of a shared method moves it on.
    const stale = offer.side === 'buy' && receive === 'live' && !receivePlaceSent({ receive, activeKind: active?.ref.kind ?? null, methods })
    if (stale && moved && step === 'transfer') step = 'receive'
  }

  return {
    offer,
    theirOffer,
    tradeMinor,
    sats,
    methods,
    cards,
    activeCard,
    activeKind: active?.ref.kind ?? null,
    receive,
    receiveExpiresAt,
    steps,
    step,
    stepKey,
    pendingDone,
    doneSuggestionMinor,
  }
}

/**
 * The buyer's guide step 2 ("send where I receive") is done only while the active card is
 * live and of a method the trade still shares. When the seller changes its
 * methods the match is kept with no new marker in my room, so an invoice I sent before
 * stays the active card; once Lightning is no longer shared it is not a place the seller
 * can pay, and the step opens again until I send one for a shared method. Without a match
 * now (`methods` empty) the active card counts as before.
 */
export function receivePlaceSent(view: Pick<TradeView, 'receive' | 'activeKind' | 'methods'>): boolean {
  if (view.receive !== 'live' || view.activeKind === null) return false
  return view.methods.length === 0 || view.methods.includes(view.activeKind)
}
