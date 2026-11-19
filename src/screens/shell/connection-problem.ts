/**
 * When the connection problem is shown: the timing behind
 * useConnectionProblem, without React or the DOM so scripts/check-boot.ts can drive it
 * with a hand-moved clock over the real engine's relay state.
 *
 *   - offline for 3 s, or my relays (known once the transport exists) all without a
 *     socket for 10 s, while the page is visible;
 *   - once shown it stays while there is any problem: a page that was hidden and comes
 *     back, or a switch between offline and no relay, does not take it down or start the
 *     grace again. Only a relay that is actually connected (with the browser online)
 *     ends it. Before it is shown, coming back to the page starts the grace again
 *     (sockets need a moment after the background).
 */

export type ProblemKind = 'offline' | 'relay' | null

/** The browser says it is offline: shown after this long (a Wi-Fi to LTE switch does not blink). */
export const OFFLINE_GRACE_MS = 3_000
/** None of my relays has a socket: shown after this long, so a relay switch can finish first. */
export const CONNECT_GRACE_MS = 10_000

export function problemKind(online: boolean, relays: readonly { connected: boolean }[]): ProblemKind {
  if (!online) return 'offline'
  return relays.length > 0 && !relays.some((r) => r.connected) ? 'relay' : null
}

export interface GateClock {
  now(): number
  setTimer(fn: () => void, ms: number): unknown
  clearTimer(handle: unknown): void
}

const realClock: GateClock = {
  now: () => Date.now(),
  setTimer: (fn, ms) => setTimeout(fn, ms),
  clearTimer: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>),
}

export class ConnectionProblemGate {
  #kind: ProblemKind = null
  #visible: boolean
  #shown = false
  /** When the grace began: the problem started, or the page came back with it (not yet shown). */
  #since = 0
  #timer: unknown = undefined
  readonly #clock: GateClock
  readonly #onChange: (shown: boolean) => void

  constructor(onChange: (shown: boolean) => void, visible = true, clock: GateClock = realClock) {
    this.#onChange = onChange
    this.#visible = visible
    this.#clock = clock
  }

  get shown(): boolean {
    return this.#shown
  }

  setKind(kind: ProblemKind): void {
    const was = this.#kind
    this.#kind = kind
    if (kind === null) {
      this.#clear()
      this.#set(false)
      return
    }
    if (this.#shown) return
    // A new problem starts the grace; offline <-> no relay keeps when it began.
    if (was === null) this.#since = this.#clock.now()
    this.#arm()
  }

  setVisible(visible: boolean): void {
    if (visible === this.#visible) return
    this.#visible = visible
    if (this.#shown) return
    if (!visible) {
      this.#clear()
      return
    }
    if (this.#kind !== null) {
      this.#since = this.#clock.now()
      this.#arm()
    }
  }

  dispose(): void {
    this.#clear()
  }

  #arm(): void {
    this.#clear()
    if (!this.#visible || this.#kind === null) return
    const grace = this.#kind === 'offline' ? OFFLINE_GRACE_MS : CONNECT_GRACE_MS
    const left = Math.max(0, this.#since + grace - this.#clock.now())
    this.#timer = this.#clock.setTimer(() => {
      this.#timer = undefined
      if (this.#kind !== null && this.#visible) this.#set(true)
    }, left)
  }

  #clear(): void {
    if (this.#timer !== undefined) this.#clock.clearTimer(this.#timer)
    this.#timer = undefined
  }

  #set(shown: boolean): void {
    if (shown === this.#shown) return
    this.#shown = shown
    this.#onChange(shown)
  }
}
