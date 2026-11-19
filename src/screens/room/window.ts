/**
 * Which messages the room draws (pure, checked in check-trade R-*).
 *
 * The room draws the latest FIRST_SHOWN messages and more on request. The active
 * receiving place of the trade (tradeView's activeCard) is always drawn too: at its own place when it is inside the drawn messages, otherwise
 * pinned above them, with a way to open the history down to it. Inactive cards stay where
 * they are and are not pinned.
 */
import type { ChatMessage } from '../../contracts'

/** Messages drawn at first; older ones on request. */
export const FIRST_SHOWN = 50

export interface RoomWindow {
  /** Messages drawn in order, the latest `shown` of them. */
  visible: ChatMessage[]
  /** Messages above the drawn ones (the "show earlier" button is there while > 0). */
  hidden: number
  /** The message holding the active card while it is among the hidden ones; null otherwise. */
  pinned: ChatMessage | null
  /** Index of `pinned` in the room, -1 without one. */
  pinnedIndex: number
}

/** The message id of a card key `${messageId}:${partIndex}` (TradeView.cards); '' for ''. */
export function cardMessageId(cardKey: string): string {
  const cut = cardKey.lastIndexOf(':')
  return cut < 0 ? '' : cardKey.slice(0, cut)
}

export function roomWindow(messages: readonly ChatMessage[], shown: number, activeCard: string): RoomWindow {
  const hidden = Math.max(messages.length - Math.max(shown, 0), 0)
  const visible = messages.slice(hidden)
  const id = cardMessageId(activeCard)
  let pinnedIndex = -1
  if (id !== '') {
    for (let i = hidden - 1; i >= 0; i--) {
      if (messages[i].id === id) {
        pinnedIndex = i
        break
      }
    }
  }
  return { visible, hidden, pinned: pinnedIndex >= 0 ? messages[pinnedIndex] : null, pinnedIndex }
}

/** How many to show so that message `index` is drawn: whole pages of FIRST_SHOWN, never fewer than now. */
export function shownToReach(total: number, index: number, shown: number): number {
  const need = total - index
  if (need <= shown) return shown
  return Math.ceil(need / FIRST_SHOWN) * FIRST_SHOWN
}

/**
 * What the room does with a pending 'jump to' once it has drawn again: 'scroll'
 * when the message is among the drawn ones, else 'drop'. 'Jump to' sets the history and
 * the target together, so the first draw after it already holds the target; a target not
 * there then (the room's limit dropped it, or the history changed meanwhile) is let go,
 * so it never jumps later by surprise when the person opens the history by hand.
 */
export function jumpStep(win: RoomWindow, id: string): 'none' | 'scroll' | 'drop' {
  if (!id) return 'none'
  return win.visible.some((m) => m.id === id) ? 'scroll' : 'drop'
}
