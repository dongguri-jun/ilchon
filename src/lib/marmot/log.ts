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

export function warn(...args: unknown[]): void {
  console.warn('[marmot]', ...args)
}

export function errorText(error: unknown): string {
  return error instanceof Error ? error.message || error.name : String(error)
}
