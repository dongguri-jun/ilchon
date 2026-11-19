/**
 * The transport's received-message inbox: every message is stored here
 * before it is handed to the engine and removed once the engine's callback finished,
 * so a message the app was still handling when it closed, crashed or reloaded is
 * delivered again at the next start (at least once). The engine makes a repeat
 * harmless (its `seen` list and the handler guards).
 *
 * No DOM and no Marmot here: the same object runs in the transport, in the engine
 * harness (scripts/fake-transport.ts) and in scripts/check-inbox.ts.
 *
 * Nothing this object returns ever rejects. Every store call is bounded by `timeoutMs`:
 * a store that hangs (IndexedDB after an iOS resume) costs that long, never the session.
 */
import type { GenericKeyValueStore } from '@internet-privacy/marmot-ts'
import type { IncomingMessage } from '../../contracts'

export interface InboxEntry {
  seq: number
  message: IncomingMessage
}

export interface DurableInbox {
  /** Start storing a message that is about to be delivered. Never throws, never waits. */
  put(id: string, entry: InboxEntry): void
  /**
   * The callbacks for `id` returned `result`. Once it fulfils, the entry is
   * removed (after its own put ended). A rejection keeps it for the next start.
   */
  handled(id: string, result: Promise<unknown>): void
  /**
   * Stored entries, lowest `seq` first. An entry that was read but has another shape is
   * removed. If a read times out or fails, `[]` and nothing is removed.
   */
  pending(): Promise<InboxEntry[]>
  /** No writes or removals after this. Resolves when running ones ended, at the latest after `timeoutMs`. */
  close(): Promise<void>
}

/** How long one store call may take before it counts as failed. */
export const INBOX_TIMEOUT_MS = 10_000

/**
 * Entries kept on the device at most. A message beyond it is still delivered, only not
 * stored (as when a write fails: the store is full). It bounds what a flood of room
 * messages can leave on the phone while the engine cannot keep up (the engine's queue
 * per sender holds 1,000); an honest backlog is far below it.
 * Each time it is hit the transport logs 'inbox full', without a count.
 */
export const INBOX_MAX_ENTRIES = 2_000

type Timers = { set(fn: () => void, ms: number): unknown; clear(handle: unknown): void }

function isEntry(id: string, v: unknown): v is InboxEntry {
  if (typeof v !== 'object' || v === null) return false
  const e = v as { seq?: unknown; message?: unknown }
  if (typeof e.seq !== 'number' || !Number.isFinite(e.seq)) return false
  const m = e.message as Partial<IncomingMessage> | null | undefined
  return (
    typeof m === 'object' &&
    m !== null &&
    m.id === id &&
    typeof m.groupId === 'string' &&
    typeof m.senderPubkey === 'string' &&
    typeof m.msg === 'object' &&
    m.msg !== null &&
    typeof (m.msg as { t?: unknown }).t === 'string' &&
    typeof m.at === 'number'
  )
}

export function createDurableInbox(
  store: GenericKeyValueStore<InboxEntry>,
  opts: {
    timeoutMs?: number
    /** Default INBOX_MAX_ENTRIES. */
    maxEntries?: number
    warn?: (...args: unknown[]) => void
    /** Tests pass the virtual clock. Default: setTimeout / clearTimeout. */
    timers?: Timers
  } = {},
): DurableInbox {
  const timeoutMs = opts.timeoutMs ?? INBOX_TIMEOUT_MS
  const maxEntries = opts.maxEntries ?? INBOX_MAX_ENTRIES
  const warn = opts.warn ?? (() => {})
  const timers: Timers = opts.timers ?? {
    set: (fn, ms) => setTimeout(fn, ms),
    clear: (h) => clearTimeout(h as ReturnType<typeof setTimeout>),
  }
  let closed = false
  /** id -> its running put. */
  const storing = new Map<string, Promise<void>>()
  /** Every running store call, for close(). */
  const ops = new Set<Promise<void>>()
  /** Ids stored or being stored by this object, or found by pending(): the size bound. */
  const kept = new Set<string>()
  /** 'inbox full' was warned and the inbox has not gone below the bound since. */
  let fullWarned = false

  /**
   * `p` or the timeout, whichever comes first. Never rejects; a failure (timeout or
   * rejection) is warned and comes back as `{ ok: false }`, so a caller can tell it
   * apart from a value that was read.
   */
  function attempt<T>(p: Promise<T>, what: string): Promise<{ ok: true; v: T } | { ok: false }> {
    let timer: unknown
    const timeout = new Promise<'timeout'>((resolve) => {
      timer = timers.set(() => resolve('timeout'), timeoutMs)
    })
    return Promise.race([p.then((v) => ({ v })), timeout]).then(
      (r) => {
        timers.clear(timer)
        if (r === 'timeout') {
          warn(`inbox ${what} failed`, 'timeout')
          return { ok: false as const }
        }
        return { ok: true as const, v: r.v }
      },
      (e: unknown) => {
        timers.clear(timer)
        warn(`inbox ${what} failed`, e)
        return { ok: false as const }
      },
    )
  }

  /** `attempt` for writes and removals, where only "it ended" matters. */
  function bounded<T>(p: Promise<T>, what: string): Promise<void> {
    return attempt(p, what).then(() => undefined)
  }

  function track(p: Promise<void>): void {
    ops.add(p)
    void p.then(() => ops.delete(p))
  }

  return {
    put(id, entry) {
      if (closed) return
      if (!kept.has(id) && kept.size >= maxEntries) {
        // Delivered from memory only, like a failed write (storage full).
        if (!fullWarned) warn('inbox full')
        fullWarned = true
        return
      }
      kept.add(id)
      let call: Promise<unknown>
      try {
        call = store.setItem(id, entry)
      } catch (e) {
        call = Promise.reject(e)
      }
      const w = bounded(call, 'write').then(() => undefined)
      storing.set(id, w)
      track(w)
      void w.then(() => {
        if (storing.get(id) === w) storing.delete(id)
      })
    },

    handled(id, result) {
      result.then(
        () => {
          if (closed) return
          const remove = (storing.get(id) ?? Promise.resolve()).then(async () => {
            if (closed) return
            let call: Promise<unknown>
            try {
              call = store.removeItem(id)
            } catch (e) {
              call = Promise.reject(e)
            }
            await bounded(call, 'remove')
            kept.delete(id)
            if (kept.size < maxEntries) fullWarned = false
          })
          track(remove)
        },
        () => {},
      )
    },

    async pending() {
      const keys = await attempt((async () => store.keys())(), 'read')
      if (!keys.ok || !Array.isArray(keys.v)) return []
      const out: InboxEntry[] = []
      for (const id of keys.v) {
        const read = await attempt((async () => store.getItem(id))(), 'read')
        // A read that timed out or failed (a stalled store) is not a damaged entry:
        // stop here and keep everything for the next start.
        // Removing it would lose a message that was never handled.
        if (!read.ok) return []
        const value = read.v
        if (isEntry(id, value)) {
          out.push(value)
          kept.add(id)
          continue
        }
        // Not an entry of this shape (damaged, or written by another build): it goes.
        warn('inbox entry could not be read')
        if (!closed) await bounded((async () => store.removeItem(id))(), 'remove')
      }
      return out.sort((a, b) => a.seq - b.seq)
    },

    async close() {
      closed = true
      if (ops.size === 0) return
      let timer: unknown
      const timeout = new Promise<void>((resolve) => {
        timer = timers.set(resolve, timeoutMs)
      })
      await Promise.race([Promise.allSettled([...ops]).then(() => undefined), timeout])
      timers.clear(timer)
    },
  }
}
