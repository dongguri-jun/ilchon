/** Random lowercase hex id. Uses Web Crypto, which exists in browsers and Node. */
export function randomId(bytes = 16): string {
  const a = new Uint8Array(bytes)
  crypto.getRandomValues(a)
  let s = ''
  for (const b of a) s += b.toString(16).padStart(2, '0')
  return s
}

/**
 * Longest contact name the engine keeps, after trimming. One constant for the engine
 * (setName) and the contact-list event (contact-list.ts) so they cannot drift.
 */
export const NAME_MAX = 40

/** Pubkey prefix that is safe to put in diagnostics. */
export function short(pk: string): string {
  return pk.slice(0, 8)
}

export interface Enqueue {
  (key: string, task: () => Promise<void>): Promise<void>
  /** Tasks of `key` queued or running now. */
  size(key: string): number
}

/**
 * Runs tasks that share a key strictly one after another. The returned promise
 * never rejects; a failing task is reported and the queue moves on.
 */
export function createSerial(onError: (key: string, e: unknown) => void): Enqueue {
  const tails = new Map<string, Promise<void>>()
  const counts = new Map<string, number>()
  const enqueue = (key: string, task: () => Promise<void>): Promise<void> => {
    const prev = tails.get(key) ?? Promise.resolve()
    counts.set(key, (counts.get(key) ?? 0) + 1)
    const next = prev.then(task).catch((e: unknown) => onError(key, e))
    tails.set(key, next)
    void next.then(() => {
      const n = (counts.get(key) ?? 1) - 1
      if (n > 0) counts.set(key, n)
      else counts.delete(key)
      if (tails.get(key) === next) tails.delete(key)
    })
    return next
  }
  return Object.assign(enqueue, { size: (key: string) => counts.get(key) ?? 0 })
}
