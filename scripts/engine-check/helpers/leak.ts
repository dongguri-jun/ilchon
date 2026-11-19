/**
 * Shared engine check helper: the leak run (S-LEAK and the support log checks).
 */
import { AMOUNT, CHAT, FEE, NAME, dumpOf, holdsNumber } from '../markers'
import { expect } from '../report'
import { BOTH, MIN, type Peer, type World, adv, deleteContact, hasContact, link, makePeer, newWorld, restart, sent, settled, until } from '../world'

// ---------------------------------------------------------------- S-LEAK

interface LeakRun {
  w: World
  A: Peer
  B: Peer
  C: Peer
  /** Every offer id A posted. */
  offerIds: string[]
}

/**
 * S-LEAK. `noisy` (S-LOG-REDACT) adds failures on the way so the logs get lines: the
 * first invite fails once, A's first two round 1 sends are refused, A's network goes
 * down for a minute.
 */
export async function leakRun(noisy: boolean): Promise<LeakRun> {
  const w = newWorld()
  const A = makePeer(w, 'A')
  const B = makePeer(w, 'B')
  const C = makePeer(w, 'C')
  for (const p of [A, B, C]) await p.engine.start()
  if (noisy) {
    let inviteFailures = 1
    w.hub.failInvite = () => inviteFailures-- > 0
    let refusals = 2
    w.hub.failSend = (from, _g, msg) => (from === A.pk && msg.t === 'm1' && refusals-- > 0 ? 'reject' : false)
  }
  await link(w, A, B)
  await link(w, A, C)
  if (noisy) {
    w.hub.setNetwork(A.pk, 'down')
    await adv(w, MIN)
    w.hub.setNetwork(A.pk, 'up')
    await adv(w, 10_000)
  }
  const offerIds: string[] = []

  await B.a.postOffer({ side: 'sell', currency: 'KRW', amountMinor: 90000, feePct: 3, methods: BOTH })
  await C.a.postOffer({ side: 'buy', currency: 'KRW', amountMinor: 50000, feePct: 1, methods: BOTH })
  await until(w, () => settled(B) && settled(C), 5 * MIN, 'rounds of B and C')
  await adv(w, 30_000)
  expect(
    [A, B, C].every((p) => p.state().matches.length === 0),
    'no matches before A has an offer',
  )

  await A.a.postOffer({ side: 'buy', currency: 'KRW', amountMinor: AMOUNT, feePct: FEE, methods: BOTH })
  const aOfferId = A.state().myOffer?.id ?? ''
  offerIds.push(aOfferId)
  await until(w, () => A.state().matches.length > 0 && B.state().matches.length > 0 && settled(A), 5 * MIN, 'A and B match')
  await adv(w, 30_000)
  const am = A.state().matches
  expect(am.length === 1 && am[0].contactId === B.pk && am[0].offer.amountMinor === 90000, 'A matches exactly B, with B amount')
  const bm = B.state().matches
  expect(bm.length === 1 && bm[0].contactId === A.pk && bm[0].offer.amountMinor === AMOUNT, 'B matches exactly A')
  expect(C.state().matches.length === 0, 'C matches nobody')
  // A reopens the app: its reconfirm round goes to B, the contact it matched,
  // and to nobody else.
  const reopenedAt = w.clock.now()
  await restart(A)
  await adv(w, MIN)
  expect(
    sent(w, A, B, 'm1').some((e) => e.atMs >= reopenedAt),
    'A reconfirmed B after it reopened',
  )
  expect(
    sent(w, A, C, 'm1').every((e) => e.atMs < reopenedAt),
    'A sent C no round 1 when it reopened',
  )
  expect(A.state().matches.length === 1 && B.state().matches.length === 1 && C.state().matches.length === 0, 'the matches are the same after the reconfirm')
  // A names its contact B and chats with B below; neither may reach C.
  await A.a.renameContact(B.pk, NAME)
  const cDump = dumpOf(C)
  const bDump = dumpOf(B)
  expect(holdsNumber(bDump, AMOUNT), 'the amount search finds the amount where it belongs (B)')
  expect(holdsNumber(bDump, FEE), 'the fee search finds the fee where it belongs (B)')
  expect(!holdsNumber(cDump, AMOUNT), "C's KV and state hold no trace of A's amount")
  expect(!holdsNumber(cDump, FEE), "C's KV and state hold no trace of A's fee")
  expect(aOfferId !== '' && !cDump.includes(aOfferId), "C's KV and state hold no trace of A's offer id")
  const cResp = C.kv.peek<Record<string, { contactId: string }>>('resp') ?? {}
  expect(!Object.values(cResp).some((s) => s.contactId === A.pk), 'C keeps no round session of A')
  expect(!(A.pk in (C.kv.peek<Record<string, string>>('verified') ?? {})), 'C keeps no verified match of A')

  await A.a.sendChat(B.pk, CHAT)
  // A half-written line and the open room: screen values that
  // stay in A's own store. Neither C nor any support log may hold them (S-LOG-REDACT).
  A.engine.memo.set(`draft:${B.pk}`, 'ZQ-LEAK-DRAFT 110-123-456789')
  A.engine.memo.set('place', { tab: 'board', room: B.pk, at: w.clock.now() })
  await adv(w, 10_000)
  expect(
    (B.state().rooms[A.pk] ?? []).some((x) => x.kind === 'text' && x.text === CHAT),
    'B gets the chat',
  )
  expect(dumpOf(A).includes('ZQ-LEAK-DRAFT'), "the draft search finds A's draft in A's own store")
  expect(!dumpOf(B).includes('ZQ-LEAK-DRAFT'), "B's KV and state hold none of A's draft")
  expect(dumpOf(A).includes(NAME), 'the name search finds the name where it belongs (A)')
  const cDump2 = dumpOf(C)
  expect(!cDump2.includes('ZQ-LEAK'), "C's KV and state hold none of A's chat text or contact name")
  expect(!holdsNumber(cDump2, AMOUNT), "C still holds no trace of A's amount")
  expect(!holdsNumber(cDump2, FEE), "C still holds no trace of A's fee")
  expect(!cDump2.includes(aOfferId), "C still holds no trace of A's offer id")
  // The 12 words and the key: the plain harness store holds A's own (the search works),
  // nothing of C's holds them.
  const aWordsHead = A.words.split(' ').slice(0, 2).join(' ')
  expect(dumpOf(A).includes(A.words) && dumpOf(A).includes(A.sk), "the words search finds A's words and key in A's own store")
  expect(!cDump2.includes(aWordsHead) && !cDump2.includes(A.sk) && !cDump2.includes(A.sk.slice(0, 16)), "C's KV and state hold none of A's 12 words or secret key")
  expect(!dumpOf(B).includes(aWordsHead) && !dumpOf(B).includes(A.sk), "B's KV and state hold none of A's 12 words or secret key")

  await A.a.postOffer({ side: 'buy', currency: 'USD', amountMinor: 10_000, feePct: 1, methods: BOTH })
  offerIds.push(A.state().myOffer?.id ?? '')
  await until(w, () => B.state().matches.length === 0 && settled(A), 5 * MIN, 'B loses A after USD')
  await adv(w, 30_000)
  expect(A.state().matches.length === 0 && B.state().matches.length === 0, 'no match after A switched to USD')

  for (const t of ['offer', 'chat', 'done']) expect(sent(w, A, C, t).length === 0, `nothing of type ${t} went from A to C`)

  const deletedAt = w.clock.now()
  await deleteContact(w, B, A)
  let postErr = ''
  await A.a.postOffer({ side: 'buy', currency: 'KRW', amountMinor: AMOUNT, feePct: FEE, methods: BOTH }).catch((e: Error) => (postErr = e.message))
  offerIds.push(A.state().myOffer?.id ?? '')
  await until(w, () => settled(A), 5 * MIN, 'A round after the delete')
  await adv(w, 30_000)
  expect(postErr === '' && A.state().boot === 'ready', `A posts again without error (${postErr})`)
  expect(A.state().matches.length === 0, 'A gets no match after B deleted A')
  expect(hasContact(A, B), 'A still lists B')
  expect(
    sent(w, B, A, 'm2').some((e) => e.atMs >= deletedAt),
    'B still answers A with m2 after the delete',
  )
  expect(!B.state().matches.some((m) => m.contactId === A.pk) && B.state().rooms[A.pk] === undefined, 'B shows nothing of A')
  for (const t of ['offer', 'chat', 'done']) expect(sent(w, A, C, t).length === 0, `nothing of type ${t} went from A to C`)
  return { w, A, B, C, offerIds: offerIds.filter(Boolean) }
}
