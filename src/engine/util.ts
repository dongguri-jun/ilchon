/** Random lowercase hex id. Uses Web Crypto, which exists in browsers and Node. */
export function randomId(bytes = 16): string {
  const a = new Uint8Array(bytes)
  crypto.getRandomValues(a)
  let s = ''
  for (const b of a) s += b.toString(16).padStart(2, '0')
  return s
}

/** Pubkey prefix that is safe to put in diagnostics. */
export function short(pk: string): string {
  return pk.slice(0, 8)
}

export type Enqueue = (key: string, task: () => Promise<void>) => Promise<void>

/**
 * Runs tasks that share a key strictly one after another. The returned promise
 * never rejects; a failing task is reported and the queue moves on.
 */
export function createSerial(onError: (key: string, e: unknown) => void): Enqueue {
  const tails = new Map<string, Promise<void>>()
  return (key, task) => {
    const prev = tails.get(key) ?? Promise.resolve()
    const next = prev.then(task).catch((e: unknown) => onError(key, e))
    tails.set(key, next)
    void next.then(() => {
      if (tails.get(key) === next) tails.delete(key)
    })
    return next
  }
}

export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}
