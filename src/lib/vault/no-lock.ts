/**
 * Lock method 'none': the data key sits in the lock record as it is. Development
 * builds and Node scripts only. Nothing imports this
 * file statically: src/lib/store receives it as `noLock`, and the browser passes it
 * only under import.meta.env.DEV, so a shipped build holds no copy of it.
 * `pnpm build` looks for NO_LOCK_MARKER in dist/ (scripts/check-dist.ts).
 */
import { base64urlnopad } from '@scure/base'
import type { LockRecord } from '../store/index'

export const NO_LOCK_MARKER = 'ilchon-no-lock-dev-only'

/** The record fields of a 'none' lock: the raw data key and the marker. */
export function sealNone(dek: Uint8Array): Pick<LockRecord, 'dek' | 'marker'> {
  return { dek: base64urlnopad.encode(dek), marker: NO_LOCK_MARKER }
}

/** The raw data key of a 'none' record. Error('storage-damaged') when it is not one. */
export function openNone(rec: LockRecord): Uint8Array {
  if (rec.method !== 'none' || rec.marker !== NO_LOCK_MARKER) throw new Error('storage-damaged')
  let dek: Uint8Array
  try {
    dek = base64urlnopad.decode(rec.dek)
  } catch {
    throw new Error('storage-damaged')
  }
  if (dek.length !== 32) throw new Error('storage-damaged')
  return dek
}
