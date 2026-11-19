/**
 * The invariants every scenario keeps: checked when something is uploaded (checkPublish),
 * after every move of virtual time (adv, until) and at the end of a scenario (finish).
 */
import type { WireMessage } from '../../src/contracts'
import { HOLDER_SCAN_TTL_MS } from '../../src/engine/index'
import { commonMethods } from '../../src/lib/match'
import type { Envelope } from '../fake-transport'
import { Fail, expect } from './report'
import { type World, peerOf } from './world'

/** Invariants checked at the moment something is uploaded (INV-M4, INV-W1, INV-W2). */
export function checkPublish(w: World, e: Envelope): void {
  if (e.injected) return
  const x = peerOf(w, e.from)
  if (!x || x.dead) return
  let msg: WireMessage | null = null
  try {
    msg = JSON.parse(e.json) as WireMessage
  } catch {
    return
  }
  if (msg.t === 'm2' && !w.skip.has('INV-M4')) {
    const init = x.kv.peek<Record<string, { contactId: string }>>('init') ?? {}
    if (Object.values(init).some((s) => s.contactId === e.to)) {
      w.violations.push(`INV-M4: ${x.name} sent m2 while its own round with that contact is open`)
    }
  }
  if (msg.t === 'offer' && w.honest) {
    const mine = x.state().myOffer
    const verified = x.kv.peek<Record<string, string>>('verified') ?? {}
    const y = peerOf(w, e.to)
    const last = y ? [...w.labelLog].reverse().find((l) => l.me === y.name && l.peer === x.pk) : undefined
    const ok =
      !!mine && verified[e.to] === mine.id && !!last?.offer && last.offer.currency === mine.currency && last.offer.side !== mine.side && commonMethods(mine.methods, last.offer.methods).length > 0
    if (!ok) w.violations.push(`INV-W1: ${x.name} sent offer to ${y?.name ?? '?'} without a verified opposite match`)
  }
  // Re-added since: a contact again and no tombstone, so the
  // delete no longer limits what X sends Y.
  const readded = (x.kv.peek<{ pubkey: string }[]>('contacts') ?? []).some((c) => c.pubkey === e.to) && !(e.to in (x.kv.peek<Record<string, unknown>>('tombstones') ?? {}))
  if (w.deleted.get(e.from)?.has(e.to) && !readded) {
    // INV-W2: m2, mx, withdraw, and a hello that carries X's own code
    // (an echo, a repeated confirmation). The one exception is a link hello while X's scan
    // of Y's QR lives (re-adding: 5 minutes, and a shaped link's holder life of 11 minutes). A hello with `r` no longer exists.
    let allowed = msg.t === 'm2' || msg.t === 'mx' || msg.t === 'withdraw'
    if (msg.t === 'hello') {
      const raw = JSON.parse(e.json) as Record<string, unknown>
      const codes = x.kv.peek<{ code: string }[]>('codes') ?? []
      const confirm = (x.kv.peek<Record<string, { code: string }>>('confirms') ?? {})[e.to]
      const scan = (x.kv.peek<Record<string, { at: number }>>('scans') ?? {})[e.to]
      const own = codes.some((c) => c.code === msg.code) || confirm?.code === msg.code
      const relink = scan !== undefined && e.atMs - scan.at <= HOLDER_SCAN_TTL_MS
      allowed = !('r' in raw) && (own || relink)
    }
    if (!allowed) w.violations.push(`INV-W2: ${x.name} sent ${msg.t} to a contact it deleted`)
  }
}

/**
 * `end`: the end of a scenario. INV-L4 is checked only then: while a
 * channel moves, the two sides are on different rooms for a while.
 */
export function assertInvariants(w: World, end = false): void {
  if (w.violations.length > 0) throw new Fail(w.violations[0])
  const live = w.peers.filter((p) => !p.dead)
  for (const p of live) {
    const contacts = p.kv.peek<{ pubkey: string; groupId: string | null }[]>('contacts') ?? []
    const tombs = p.kv.peek<Record<string, { groupId: string | null }>>('tombstones') ?? {}
    expect(!contacts.some((c) => c.pubkey in tombs), `INV-L1: ${p.name} has a pubkey both as contact and deleted`)
    // INV-CH1, INV-CH2 (channel): every channel room was made by the lower key of the two,
    // and no room serves two peers' channels or links.
    const scans = p.kv.peek<Record<string, { groupId?: string }>>('scans') ?? {}
    const roomsOf: [string, string | null | undefined][] = [
      ...contacts.map((c): [string, string | null] => [c.pubkey, c.groupId]),
      ...Object.entries(tombs).map(([pk, tb]): [string, string | null] => [pk, tb.groupId]),
    ]
    for (const [peer, g] of roomsOf) {
      const maker = g ? w.hub.creatorOf(g) : undefined
      // biome-ignore lint/complexity/useMathMinMax: pk and peer are hex strings, Math.min would turn them into NaN
      if (g && maker) expect(maker === (p.pk < peer ? p.pk : peer), `INV-CH1: ${p.name}'s room with ${peerOf(w, peer)?.name ?? '?'} was made by the higher key`)
    }
    const owner = new Map<string, string>()
    const linkRooms = Object.entries(scans).map(([pk, s]): [string, string | undefined] => [pk, s.groupId])
    for (const [peer, g] of [...roomsOf, ...linkRooms]) {
      if (!g) continue
      const was = owner.get(g)
      expect(was === undefined || was === peer, `INV-CH2: ${p.name} uses one room for two peers`)
      owner.set(g, peer)
    }
    const init = p.kv.peek<Record<string, { contactId: string }>>('init') ?? {}
    const perContact = new Map<string, number>()
    for (const s of Object.values(init)) perContact.set(s.contactId, (perContact.get(s.contactId) ?? 0) + 1)
    expect(
      [...perContact.values()].every((n) => n <= 1),
      `INV-M1: ${p.name} has two open rounds with one contact`,
    )
    const s = p.state()
    const verified = p.kv.peek<Record<string, string>>('verified') ?? {}
    for (const m of s.matches) {
      const ok =
        s.contacts.some((c) => c.id === m.contactId) &&
        verified[m.contactId] !== undefined &&
        !!s.myOffer &&
        m.offer.currency === s.myOffer.currency &&
        m.offer.side !== s.myOffer.side &&
        commonMethods(s.myOffer.methods, m.offer.methods).length > 0
      expect(ok, `INV-M3: ${p.name} holds a match that is not a verified opposite same-currency contact with a shared method`)
    }
    for (const q of live) {
      if (q === p || !end || w.skip.has('INV-L4')) continue
      const cp = s.contacts.find((c) => c.pubkey === q.pk)
      const cq = q.state().contacts.find((c) => c.pubkey === p.pk)
      if (cp && cq) expect(cp.groupId === cq.groupId, `INV-L4: ${p.name} and ${q.name} are contacts over different groups`)
    }
  }
}

// ---------------------------------------------------------------- INV-CH3

/** INV-CH3: every group a peer's device stores is a room of a contact, a tombstone or a link of that peer. */
export function expectOnlyChannelRooms(w: World): void {
  for (const p of w.peers.filter((x) => !x.dead)) {
    const used = new Set<string>()
    for (const c of p.kv.peek<{ groupId: string | null }[]>('contacts') ?? []) if (c.groupId) used.add(c.groupId)
    for (const tb of Object.values(p.kv.peek<Record<string, { groupId: string | null }>>('tombstones') ?? {})) if (tb.groupId) used.add(tb.groupId)
    for (const s of Object.values(p.kv.peek<Record<string, { groupId?: string }>>('scans') ?? {})) {
      if (s.groupId) used.add(s.groupId)
    }
    const stray = w.hub.groupsOf(p.pk, p.device).filter((g) => !used.has(g))
    expect(stray.length === 0, `INV-CH3: ${p.name} still stores ${stray.length} room(s) nothing uses`)
  }
}
