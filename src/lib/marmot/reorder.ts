/**
 * The transport's per-room reorder buffer (delivery order).
 *
 * Incoming messages of a room are collected for a moment and handed over sorted by the
 * sender's sequence tag, because a relay backfill yields them in relay order (newest
 * first), not in sending order. While the library is ingesting the room nothing is
 * handed over: a phone thawed after minutes in the background decrypts one message more
 * slowly than REORDER_IDLE_MS, and the batch went out one by one, newest first. The
 * window starts again when the ingest ends.
 *
 * But never longer than INGEST_HOLD_MAX_MS after the first queued message came in:
 * ingests run back to back as long as events arrive (a long catch-up, or anyone
 * flooding the room's public h tag with junk that fails to decrypt), and without a bound
 * a real message would wait for the stream to pause. A catch-up longer than that is
 * handed over in sorted parts; the engine places the contact's texts by their own send
 * time (placeOf) and drops an offer or withdraw older than the one it applied, so a later
 * part of older messages does no harm. Larger than REORDER_MAX_MS so a whole ordinary
 * catch-up stays one batch.
 *
 * No DOM and no Marmot here: the transport runs it on the real clock, scripts/check-inbox.ts
 * on a fake one.
 */
import type { IncomingMessage } from '../../contracts'

export const REORDER_IDLE_MS = 60
export const REORDER_MAX_MS = 400
export const INGEST_HOLD_MAX_MS = 5_000

export interface ReorderClock {
  now(): number
  /** Runs `fn` after `ms`; returns the cancel. */
  after(ms: number, fn: () => void): () => void
}

export const realClock: ReorderClock = {
  now: () => Date.now(),
  after: (ms, fn) => {
    const timer = setTimeout(fn, ms)
    return () => clearTimeout(timer)
  },
}

interface Room {
  queue: { seq: number; message: IncomingMessage }[]
  /** While set, nothing is delivered (invite/accept has not returned yet). */
  held: boolean
  /** Ingests of the room under way (guardIngest's span): nothing is delivered meanwhile, up to the bound. */
  ingesting: number
  /** Start of the burst window (REORDER_*): the first queued message, or the end of the last ingest. */
  firstAt: number
  cancel: (() => void) | undefined
  /** The INGEST_HOLD_MAX_MS bound of the queued messages, set when the first one is queued; ingests do not cancel it. */
  deadline: (() => void) | undefined
}

export class ReorderBuffers {
  readonly #rooms = new Map<string, Room>()
  readonly #clock: ReorderClock
  readonly #deliver: (message: IncomingMessage) => void

  constructor(deliver: (message: IncomingMessage) => void, clock: ReorderClock = realClock) {
    this.#deliver = deliver
    this.#clock = clock
  }

  /** A message of the room came in; it is handed over sorted with the rest of its burst. */
  put(groupId: string, seq: number, message: IncomingMessage): void {
    const room = this.#room(groupId)
    if (!room.queue.length) room.firstAt = this.#clock.now()
    room.queue.push({ seq, message })
    if (!room.deadline) {
      const cancel = this.#clock.after(INGEST_HOLD_MAX_MS, () => {
        if (room.deadline !== cancel) return
        room.deadline = undefined
        this.#flush(groupId, true)
      })
      room.deadline = cancel
    }
    if (!room.held && !room.ingesting) this.#armFlush(groupId, room)
  }

  /** An ingest of the room started (guardIngest). */
  ingestStart(groupId: string): void {
    const room = this.#room(groupId)
    room.ingesting++
    room.cancel?.()
    room.cancel = undefined
  }

  /** An ingest of the room ended (guardIngest). */
  ingestEnd(groupId: string): void {
    const room = this.#rooms.get(groupId)
    if (!room) return
    room.ingesting = Math.max(0, room.ingesting - 1)
    if (!room.ingesting && !room.held && room.queue.length) {
      // The window starts again now: what came in during the ingest is one burst.
      room.firstAt = this.#clock.now()
      this.#armFlush(groupId, room)
    }
  }

  /** Keep the room's messages back until {@link release}. */
  hold(groupId: string): void {
    const room = this.#room(groupId)
    room.held = true
    room.cancel?.()
    room.cancel = undefined
  }

  /** Deliver held messages on the next task, i.e. after the promise that hands the room id to the caller has resolved. */
  release(groupId: string): void {
    this.#clock.after(0, () => {
      const room = this.#rooms.get(groupId)
      if (!room) return
      room.held = false
      this.#flush(groupId)
    })
  }

  /** Drop the room's buffer and its timers (the room went). */
  discard(groupId: string): void {
    const room = this.#rooms.get(groupId)
    room?.cancel?.()
    room?.deadline?.()
    this.#rooms.delete(groupId)
  }

  /** Drop every buffer (the transport stops). */
  clear(): void {
    for (const id of [...this.#rooms.keys()]) this.discard(id)
  }

  #room(groupId: string): Room {
    let room = this.#rooms.get(groupId)
    if (!room) {
      room = { queue: [], held: false, ingesting: 0, firstAt: 0, cancel: undefined, deadline: undefined }
      this.#rooms.set(groupId, room)
    }
    return room
  }

  /** Flush once the burst went quiet, at the latest REORDER_MAX_MS after its start. */
  #armFlush(groupId: string, room: Room): void {
    room.cancel?.()
    const wait = Math.max(0, Math.min(REORDER_IDLE_MS, room.firstAt + REORDER_MAX_MS - this.#clock.now()))
    room.cancel = this.#clock.after(wait, () => this.#flush(groupId))
  }

  /** `bound`: INGEST_HOLD_MAX_MS passed, so ingests under way no longer hold the queue (held still does). */
  #flush(groupId: string, bound = false): void {
    const room = this.#rooms.get(groupId)
    if (!room || room.held || (room.ingesting && !bound)) return
    room.cancel?.()
    room.cancel = undefined
    room.deadline?.()
    room.deadline = undefined
    const batch = room.queue.splice(0).sort((a, b) => a.seq - b.seq)
    for (const { message } of batch) this.#deliver(message)
  }
}
