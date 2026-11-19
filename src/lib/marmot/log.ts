/**
 * Transport diagnostics. Off unless `globalThis.ILCHON_DEBUG === true`.
 * Never pass secrets, message content or offer details.
 */
export function debugEnabled(): boolean {
  return (globalThis as { ILCHON_DEBUG?: unknown }).ILCHON_DEBUG === true
}

export function log(...args: unknown[]): void {
  if (debugEnabled()) console.log('[marmot]', ...args)
}

type LogSink = (phrase: string, values: readonly unknown[]) => void
let sink: LogSink | null = null

/**
 * Where warnings also go (the support log, src/engine/browser.ts). The first argument
 * of warn() is a fixed phrase of the code; the rest are values, which the sink decides
 * what to keep of. log() is never passed on.
 */
export function setLogSink(fn: LogSink | null): void {
  sink = fn
}

export function warn(...args: unknown[]): void {
  console.warn('[marmot]', ...args)
  try {
    sink?.(String(args[0]), args.slice(1))
  } catch {
    // the log must never break the transport
  }
}

export function errorText(error: unknown): string {
  return error instanceof Error ? error.message || error.name : String(error)
}
