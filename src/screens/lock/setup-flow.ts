/**
 * Where the first-run screen is and which path the user is on. Pure, no DOM,
 * so scripts/check-storage.ts can walk it. The path (`mode`) always follows the step the
 * user moves to: the words of a new key mean "new", the restore field means "restore".
 * The lock step keeps the path of the step it came from, and the lock's submit reads it
 * (otherwise Restore -> back -> Start fresh would submit as a restore).
 */
export type SetupStep = 'start' | 'words' | 'restore' | 'lock'
export type SetupMode = 'new' | 'restore'
export interface SetupFlow {
  step: SetupStep
  mode: SetupMode
}

/**
 * - `new`: Start fresh, to the new key's words.
 * - `restore`: Restore with 12 words, or back to the words field after a failed restore.
 * - `lock`: on to the lock (from the words or from the restore field).
 * - `back`: the app bar's back.
 * - `home`: the system back left the words entry: to the start, the
 *   same words kept by the engine until the page reloads.
 */
export type SetupEvent = 'new' | 'restore' | 'lock' | 'back' | 'home'

/** After the stop screen's reset (the same words were restored on another device) the restore step comes first. */
export function initialSetup(afterReset: boolean): SetupFlow {
  return afterReset ? { step: 'restore', mode: 'restore' } : { step: 'start', mode: 'new' }
}

/** The path a step belongs to; the start and the lock belong to none of their own. */
function modeOf(step: SetupStep, prev: SetupMode): SetupMode {
  if (step === 'words') return 'new'
  if (step === 'restore') return 'restore'
  return prev
}

export function nextSetup(f: SetupFlow, ev: SetupEvent): SetupFlow {
  switch (ev) {
    case 'new':
      return { step: 'words', mode: 'new' }
    case 'restore':
      return { step: 'restore', mode: 'restore' }
    case 'lock':
      // Only the words and the restore field lead to the lock; the lock keeps their path.
      if (f.step !== 'words' && f.step !== 'restore') return f
      return { step: 'lock', mode: modeOf(f.step, f.mode) }
    case 'home':
      return { step: 'start', mode: f.mode }
    case 'back': {
      const step: SetupStep = f.step === 'lock' ? (f.mode === 'restore' ? 'restore' : 'words') : 'start'
      return { step, mode: modeOf(step, f.mode) }
    }
  }
}

/** What the lock's submit does on this path (SetupScreen): make a new key or restore one. */
export function lockSubmitKind(f: SetupFlow): 'create' | 'restore' {
  return f.mode === 'new' ? 'create' : 'restore'
}

/**
 * A popstate during the first run. The words step
 * has one history entry (overlay-history.ts createSetupHistory): leaving it (the system
 * back on the words or on the lock after them) goes to the start; coming forward onto it
 * again on the start shows the same words, if they were made. Anything else: no change.
 */
export function setupPop(f: SetupFlow, onSetupEntry: boolean, hasWords: boolean): SetupEvent | null {
  if (!onSetupEntry) return f.step === 'words' || (f.step === 'lock' && f.mode === 'new') ? 'home' : null
  return f.step === 'start' && hasWords ? 'new' : null
}
