/**
 * The plaintext of my encrypted contact list.
 *
 * The transport (src/lib/marmot/list.ts) encrypts, signs, publishes and finds the
 * list event; this file only shapes and checks the plaintext. Every encoded list
 * is exactly LIST_BYTES long, so neither a relay nor anyone reading the event can
 * tell how many contacts or deleted contacts it holds.
 *
 * Here: ListBody, encodeList and decodeList, then the digest, the projection of the
 * engine's contacts and the merge.
 */
import { sha256 } from '@noble/hashes/sha2.js'
import { bytesToHex, utf8ToBytes } from '@noble/hashes/utils.js'
import type { Contact, PubkeyHex } from '../contracts'
import { NAME_MAX } from './util'

/** What one copy of my contact list holds. Never sent to anyone but my own relays, encrypted. */
export interface ListBody {
  v: 1
  /** Contacts, sorted by pubkey: [pubkey, my name for them, createdAt ms]. */
  c: [PubkeyHex, string, number][]
  /** Deleted contacts, sorted by pubkey: [pubkey, deletedAt ms]. */
  d: [PubkeyHex, number][]
}

/** Exact UTF-8 byte size of every encoded list. */
export const LIST_BYTES = 32_768
/** Most entries in `c`, and separately in `d`, a copy may have. */
export const LIST_ENTRIES_MAX = 2_000
/** An entry time later than now + this makes the whole copy unreadable. */
export const LIST_FUTURE_MS = 10 * 60_000

const HEX64 = /^[0-9a-f]{64}$/
const PADDING = /^ *$/
const utf8 = new TextEncoder()

function byPubkey(a: [PubkeyHex, ...unknown[]], b: [PubkeyHex, ...unknown[]]): number {
  return a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0
}

/**
 * `{"v":1,"c":[...],"d":[...],"p":"   ..."}` padded with spaces to exactly LIST_BYTES.
 * Entries are sorted by pubkey. Throws Error('list-too-big') when the list does not fit
 * even with an empty pad: nothing is ever left out (a list without its deleted contacts
 * would treat the deleted ones differently after a restore).
 */
export function encodeList(body: ListBody): string {
  const c = [...body.c].sort(byPubkey)
  const d = [...body.d].sort(byPubkey)
  const head = JSON.stringify({ v: 1, c, d, p: '' })
  const size = utf8.encode(head).length
  if (size > LIST_BYTES) throw new Error('list-too-big')
  // The pad is the last value: open it by its closing `"}` and fill with one-byte spaces.
  return `${head.slice(0, -2)}${' '.repeat(LIST_BYTES - size)}"}`
}

function isTime(value: unknown, latest: number): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 && value <= latest
}

/**
 * Reads one decrypted copy. Returns null, and the copy is dropped whole, when anything
 * is off: not exactly LIST_BYTES of UTF-8, not JSON, `v` other than 1, `c` or `d` not an
 * array or longer than LIST_ENTRIES_MAX, a pad that is not spaces, an entry of the wrong
 * shape, a pubkey that is not 64 lowercase hex or is my own, a name that is not a string
 * or longer than NAME_MAX (src/engine/util.ts) after trimming, a time that is not a finite number >= 0 or
 * is later than nowMs + 10 minutes (a deletion dated in the future would keep a
 * contact from ever coming back).
 *
 * A pubkey listed twice in one array keeps its first entry. A pubkey both in `c` and in
 * `d` keeps one: the deletion when it is at or after the contact's createdAt, else the
 * contact (the merge's "contact against deletion" row; a tie goes to the deletion).
 * Names come back trimmed; both arrays come back sorted by pubkey.
 */
export function decodeList(payload: string, myPubkey: PubkeyHex, nowMs: number): ListBody | null {
  if (typeof payload !== 'string' || utf8.encode(payload).length !== LIST_BYTES) return null
  let raw: unknown
  try {
    raw = JSON.parse(payload)
  } catch {
    return null
  }
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null
  const { v, c, d, p } = raw as Record<string, unknown>
  if (v !== 1) return null
  if (typeof p !== 'string' || !PADDING.test(p)) return null
  if (!Array.isArray(c) || !Array.isArray(d)) return null
  if (c.length > LIST_ENTRIES_MAX || d.length > LIST_ENTRIES_MAX) return null
  const latest = nowMs + LIST_FUTURE_MS
  const goodKey = (pk: unknown): pk is PubkeyHex => typeof pk === 'string' && HEX64.test(pk) && pk !== myPubkey

  const contacts = new Map<PubkeyHex, [PubkeyHex, string, number]>()
  for (const entry of c as unknown[]) {
    if (!Array.isArray(entry) || entry.length !== 3) return null
    const [pk, name, createdAt] = entry as unknown[]
    if (!goodKey(pk) || typeof name !== 'string' || !isTime(createdAt, latest)) return null
    const clean = name.trim()
    if (clean.length > NAME_MAX) return null
    if (!contacts.has(pk)) contacts.set(pk, [pk, clean, createdAt])
  }
  const deleted = new Map<PubkeyHex, [PubkeyHex, number]>()
  for (const entry of d as unknown[]) {
    if (!Array.isArray(entry) || entry.length !== 2) return null
    const [pk, at] = entry as unknown[]
    if (!goodKey(pk) || !isTime(at, latest)) return null
    if (!deleted.has(pk)) deleted.set(pk, [pk, at])
  }
  for (const [pk, [, at]] of deleted) {
    const contact = contacts.get(pk)
    if (!contact) continue
    if (at >= contact[2]) contacts.delete(pk)
    else deleted.delete(pk)
  }
  return { v: 1, c: [...contacts.values()].sort(byPubkey), d: [...deleted.values()].sort(byPubkey) }
}

/** The list content without its version and pad: what the digest and the merge look at. */
export interface ListView {
  c: [PubkeyHex, string, number][]
  d: [PubkeyHex, number][]
}

/** "Same content": the SHA-256 hex of JSON.stringify({ c, d }) with both sorted by pubkey. No pad. */
export function digest(c: ListView['c'], d: ListView['d']): string {
  const view = { c: [...c].sort(byPubkey), d: [...d].sort(byPubkey) }
  return bytesToHex(sha256(utf8ToBytes(JSON.stringify(view))))
}

/** The digest of an empty list: such a list is never published. */
export const EMPTY_DIGEST = digest([], [])

/** What of my contacts and tombstones goes into the list: pubkey, my name, createdAt; pubkey, deletedAt. */
export function projection(contacts: readonly Contact[], tombstones: Readonly<Record<PubkeyHex, { at: number }>>): ListView {
  return {
    c: contacts.map((x): [PubkeyHex, string, number] => [x.pubkey, x.name, x.createdAt]).sort(byPubkey),
    d: Object.entries(tombstones)
      .map(([pk, tb]): [PubkeyHex, number] => [pk, tb.at])
      .sort(byPubkey),
  }
}

export interface MergePlan {
  /** Pubkeys new to this device: contact with groupId null. */
  add: { pk: PubkeyHex; name: string; createdAt: number }[]
  /** Tombstones that become contacts again; channel fields move from the tombstone. */
  revive: { pk: PubkeyHex; name: string; createdAt: number }[]
  /** Contacts the copy deleted later than they were made. */
  remove: { pk: PubkeyHex; at: number }[]
  /** Tombstones to create (groupId null) or whose `at` grows. */
  tombs: { pk: PubkeyHex; at: number }[]
}

/** True when the plan changes nothing. */
export function emptyPlan(plan: MergePlan): boolean {
  return !plan.add.length && !plan.revive.length && !plan.remove.length && !plan.tombs.length
}

/**
 * One copy merged into my list (used only for a restore, the first
 * merge of each relay after it, and a rebuild of the list). Per pubkey the later fact wins; at the same
 * time the deletion wins; a name comes from the copy only for a pubkey new to me or a
 * revived one (a contact on both sides keeps my name). An old copy can neither bring a
 * deleted contact back (its deletion is later) nor delete a contact linked again (its
 * createdAt is later). Pure: the engine applies the plan.
 */
export function mergeInto(local: ListView, copy: ListView): MergePlan {
  const plan: MergePlan = { add: [], revive: [], remove: [], tombs: [] }
  const myC = new Map(local.c.map((e) => [e[0], e]))
  const myD = new Map(local.d.map((e) => [e[0], e]))
  for (const [pk, name, createdAt] of copy.c) {
    const tomb = myD.get(pk)
    if (myC.has(pk)) continue
    if (tomb) {
      if (createdAt > tomb[1]) plan.revive.push({ pk, name, createdAt })
      continue
    }
    plan.add.push({ pk, name, createdAt })
  }
  for (const [pk, at] of copy.d) {
    const contact = myC.get(pk)
    if (contact) {
      if (at >= contact[2]) plan.remove.push({ pk, at })
      continue
    }
    const tomb = myD.get(pk)
    if (tomb) {
      if (at > tomb[1]) plan.tombs.push({ pk, at })
      continue
    }
    plan.tombs.push({ pk, at })
  }
  return plan
}

/** The list after a plan, for merging several copies in turn without the engine (a restore). */
export function applyPlanTo(local: ListView, plan: MergePlan): ListView {
  const c = new Map(local.c.map((e) => [e[0], e]))
  const d = new Map(local.d.map((e) => [e[0], e]))
  for (const x of [...plan.add, ...plan.revive]) {
    d.delete(x.pk)
    c.set(x.pk, [x.pk, x.name, x.createdAt])
  }
  for (const x of plan.remove) {
    c.delete(x.pk)
    d.set(x.pk, [x.pk, x.at])
  }
  for (const x of plan.tombs) d.set(x.pk, [x.pk, Math.max(x.at, d.get(x.pk)?.[1] ?? 0)])
  return { c: [...c.values()].sort(byPubkey), d: [...d.values()].sort(byPubkey) }
}
