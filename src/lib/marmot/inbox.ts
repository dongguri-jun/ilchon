/**
 * The inbox entrance: what the transport
 * does with each kind 1059 gift wrap its inbox subscription delivers, instead
 * of the library's `invites.listen`. No DOM; scripts/check-guard.ts runs it.
 *
 * - Ingest one wrap at a time (the library's lazily loaded seen set is not safe
 *   against two first calls at once).
 * - Decrypt in one flight: 250 ms after the last new wrap, at the latest 2 s
 *   after the first; a wrap that comes while it runs schedules one more run.
 *   Two runs at once would decrypt the same stored wrap twice.
 * - After each run, the library's in-memory gift wrap store is pruned.
 */
import { internalGiftWrapEvents } from 'applesauce-common/helpers/gift-wrap'
import type { NostrEvent } from 'applesauce-core/helpers/event'

/** The part of marmot-ts's InviteManager the pump uses. */
export interface InviteIntake {
  ingestEvent(event: NostrEvent): Promise<boolean>
  decryptGiftWraps(): Promise<unknown[]>
  getReceived(): Promise<unknown[]>
}

export const INBOX_IDLE_MS = 250
export const INBOX_MAX_WAIT_MS = 2_000

export interface InboxPump {
  /** One gift wrap from the subscription (already shape- and signature-checked). */
  push(event: NostrEvent): void
  /** Decrypt what an earlier session stored but did not decrypt. */
  resume(): void
  stop(): void
}

export function createInboxPump(
  invites: InviteIntake,
  opts: {
    onError?: (error: unknown) => void
    timers?: { set(fn: () => void, ms: number): unknown; clear(handle: unknown): void }
  } = {},
): InboxPump {
  const timers = opts.timers ?? {
    set: (fn: () => void, ms: number) => setTimeout(fn, ms),
    clear: (h: unknown) => clearTimeout(h as ReturnType<typeof setTimeout>),
  }
  const onError = opts.onError ?? (() => {})
  let stopped = false
  let ingestTail: Promise<void> = Promise.resolve()
  let idleTimer: unknown = null
  let maxTimer: unknown = null
  let running = false
  let again = false

  function clearTimers(): void {
    if (idleTimer !== null) timers.clear(idleTimer)
    if (maxTimer !== null) timers.clear(maxTimer)
    idleTimer = maxTimer = null
  }

  function schedule(): void {
    if (stopped) return
    if (running) {
      again = true
      return
    }
    if (idleTimer !== null) timers.clear(idleTimer)
    idleTimer = timers.set(() => void run(), INBOX_IDLE_MS)
    maxTimer ??= timers.set(() => void run(), INBOX_MAX_WAIT_MS)
  }

  async function run(): Promise<void> {
    clearTimers()
    if (stopped || running) return
    running = true
    try {
      await invites.decryptGiftWraps()
    } catch (error) {
      onError(error)
    } finally {
      try {
        internalGiftWrapEvents.prune()
      } catch {
        // nothing to free
      }
      running = false
    }
    if (again) {
      again = false
      schedule()
    }
  }

  return {
    push(event) {
      if (stopped) return
      ingestTail = ingestTail.then(async () => {
        if (stopped) return
        try {
          if (await invites.ingestEvent(event)) schedule()
        } catch (error) {
          onError(error)
        }
      })
    },
    resume() {
      void invites.getReceived().then(
        (received) => {
          if (received.length) schedule()
        },
        (error: unknown) => onError(error),
      )
    },
    stop() {
      stopped = true
      clearTimers()
    },
  }
}
