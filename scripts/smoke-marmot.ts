/**
 * End-to-end smoke test of the Marmot transport against real relays.
 *
 *   pnpm exec tsx scripts/smoke-marmot.ts
 *   RELAYS=wss://a,wss://b pnpm exec tsx scripts/smoke-marmot.ts   (override relays)
 *   DEBUG_MARMOT=1 pnpm exec tsx scripts/smoke-marmot.ts           (transport diagnostics)
 *
 * Three throwaway keys A, B, C with in-memory stores. A invites B and C into
 * separate two-member groups and exchanges ILCHON_KIND messages both ways.
 * Then: C invites B (after B rotated its KeyPackage), an ignored invite, and
 * a stop/restart of B with a message sent while it was offline.
 * Prints PASS/FAIL per step with timings; exits non-zero on any failure.
 */
import {
  DEFAULT_RELAYS,
  type IncomingInvite,
  type IncomingMessage,
  type Transport,
} from '../src/contracts'
import { createTransport, generateSecretKeyHex, npubOf } from '../src/lib/marmot/index'

if (process.env.DEBUG_MARMOT) (globalThis as { ILCHON_DEBUG?: boolean }).ILCHON_DEBUG = true

const relays = process.env.RELAYS
  ? process.env.RELAYS.split(',')
      .map((url) => url.trim())
      .filter(Boolean)
  : DEFAULT_RELAYS

const WAIT_MS = 45_000

interface Peer {
  name: string
  secretKeyHex: string
  namespace: string
  transport: Transport
  invites: IncomingInvite[]
  messages: IncomingMessage[]
}

function open(peer: Omit<Peer, 'transport' | 'invites' | 'messages'>): Peer {
  const transport = createTransport({
    secretKeyHex: peer.secretKeyHex,
    relays,
    namespace: peer.namespace,
    persistence: 'memory',
  })
  const opened: Peer = { ...peer, transport, invites: [], messages: [] }
  transport.onInvite((invite) => opened.invites.push(invite))
  transport.onMessage((message) => opened.messages.push(message))
  return opened
}

function makePeer(name: string): Peer {
  return open({ name, secretKeyHex: generateSecretKeyHex(), namespace: `smoke:${name}:${Date.now()}` })
}

async function waitFor<T>(what: string, probe: () => T | undefined, ms = WAIT_MS): Promise<T> {
  const deadline = Date.now() + ms
  for (;;) {
    const value = probe()
    if (value !== undefined) return value
    if (Date.now() > deadline) throw new Error(`timed out after ${ms} ms waiting for ${what}`)
    await new Promise((resolve) => setTimeout(resolve, 50))
  }
}

let failed = 0

function sortGroups(list: { groupId: string; peerPubkey: string }[]): string {
  return list
    .map((g) => `${g.groupId}:${g.peerPubkey}`)
    .sort()
    .join(',')
}
const startedAt = Date.now()

/** Runs one step. A failed step fails the run and aborts what depends on it. */
async function step<T>(label: string, run: () => Promise<T>): Promise<T> {
  const t0 = Date.now()
  try {
    const value = await run()
    console.log(`PASS  ${label}  (${Date.now() - t0} ms)`)
    return value
  } catch (error) {
    failed++
    console.log(`FAIL  ${label}  (${Date.now() - t0} ms)  ${error instanceof Error ? error.message : String(error)}`)
    throw error
  }
}

/** `from` sends a chat message in `groupId` and `to` must receive exactly it. */
async function exchange(from: Peer, to: Peer, groupId: string, text: string): Promise<void> {
  await from.transport.send(groupId, { t: 'chat', text })
  const received = await waitFor(`${to.name} to receive "${text}"`, () =>
    to.messages.find((m) => m.groupId === groupId && m.msg.t === 'chat' && m.msg.text === text),
  )
  if (received.senderPubkey !== from.transport.pubkey) throw new Error('wrong sender pubkey')
  if (!/^[0-9a-f]{64}$/.test(received.id)) throw new Error('rumor id is not 64 hex')
  if (from.messages.some((m) => m.id === received.id)) throw new Error('sender received its own message')
  if (to.messages.filter((m) => m.id === received.id).length !== 1) throw new Error('message delivered twice')
}

/**
 * inviter invites invitee and, like the app, sends two messages right away,
 * before the invitee has even seen the Welcome. The invitee accepts and must
 * then receive both, in order. Returns the group id.
 */
async function connect(inviter: Peer, invitee: Peer): Promise<string> {
  const tag = `${inviter.name}${invitee.name}`
  const { groupId } = await step(`${inviter.name} invites ${invitee.name}`, () =>
    inviter.transport.invitePeer(invitee.transport.pubkey),
  )
  await step(`${inviter.name} sends 2 messages before ${invitee.name} joined`, async () => {
    await inviter.transport.send(groupId, { t: 'hello', v: 1, code: `early-${tag}` })
    await inviter.transport.send(groupId, { t: 'chat', text: `early-2-${tag}` })
  })
  const invite = await step(`${invitee.name} receives the invite from ${inviter.name}`, () =>
    waitFor('the invite', () =>
      invitee.invites.find(
        (i) => i.inviterPubkey === inviter.transport.pubkey && !usedInvites.has(i.id),
      ),
    ),
  )
  usedInvites.add(invite.id)
  if (invitee.messages.some((m) => m.groupId === groupId)) {
    failed++
    console.log(`FAIL  ${invitee.name} got group messages before joining`)
  }
  // While the invitee joins and rotates its leaf key, the inviter keeps talking.
  const during = (async () => {
    for (let i = 1; i <= 3; i++) {
      await new Promise((resolve) => setTimeout(resolve, 350))
      await inviter.transport.send(groupId, { t: 'chat', text: `during-${i}-${tag}` })
    }
  })()
  await step(`${invitee.name} accepts the invite`, async () => {
    const joined = await invitee.transport.acceptInvite(invite.id)
    if (joined.groupId !== groupId) throw new Error('joined a different group id than the inviter created')
  })
  await step(`${inviter.name} sent 3 more messages while ${invitee.name} was joining`, () => during)
  await step(`${invitee.name} receives all 5 messages, in sending order`, async () => {
    const expected = [`early-${tag}`, `early-2-${tag}`, `during-1-${tag}`, `during-2-${tag}`, `during-3-${tag}`]
    const label = (m: IncomingMessage) =>
      m.msg.t === 'hello' ? m.msg.code : m.msg.t === 'chat' ? m.msg.text : m.msg.t
    const inGroup = () => invitee.messages.filter((m) => m.groupId === groupId)
    const got = await waitFor('5 messages', () => (inGroup().length >= expected.length ? inGroup() : undefined), 20_000).catch(
      () => {
        throw new Error(`only got ${inGroup().map(label).join('|') || 'nothing'}`)
      },
    )
    const texts = got.map(label)
    if (texts.join('|') !== expected.join('|')) throw new Error(`got ${texts.join('|')}`)
  })
  return groupId
}

const usedInvites = new Set<string>()

async function main(): Promise<void> {
  console.log(`relays: ${relays.join(', ')}`)
  const a = makePeer('A')
  const b = makePeer('B')
  const c = makePeer('C')
  const peers = [a, b, c]
  for (const peer of peers) console.log(`${peer.name}: ${npubOf(peer.transport.pubkey)}`)

  try {
    await Promise.all(
      peers.map((peer) => step(`${peer.name} start (relay lists + KeyPackage published)`, () => peer.transport.start())),
    )
    for (const peer of peers) {
      const status = peer.transport.relayStatus()
      console.log(`      ${peer.name} relays: ${status.map((s) => `${s.url}=${s.connected ? 'up' : 'down'}`).join(' ')}`)
    }

    const groupAB = await connect(a, b)
    await step('A -> B chat message in group AB', () => exchange(a, b, groupAB, 'hello B, this is A'))
    await step('B -> A reply in group AB', () => exchange(b, a, groupAB, 'hello A, this is B'))

    const groupAC = await connect(a, c)
    if (groupAC === groupAB) throw new Error('second group reused the first group id')
    await step('A -> C chat message in group AC', () => exchange(a, c, groupAC, 'hello C, this is A'))
    await step('C -> A reply in group AC', () => exchange(c, a, groupAC, 'hello A, this is C'))

    await step('A -> B again in group AB (first group still works)', () =>
      exchange(a, b, groupAB, 'still there, B?'),
    )
    await step('B -> A again in group AB', () => exchange(b, a, groupAB, 'still here, A'))

    await step('groups are isolated (C saw nothing from AB, B nothing from AC)', async () => {
      if (c.messages.some((m) => m.groupId === groupAB)) throw new Error('C received a message of group AB')
      if (b.messages.some((m) => m.groupId === groupAC)) throw new Error('B received a message of group AC')
    })

    await step('listGroups reports each group with its single peer', async () => {
      const expectA = sortGroups([
        { groupId: groupAB, peerPubkey: b.transport.pubkey },
        { groupId: groupAC, peerPubkey: c.transport.pubkey },
      ])
      if (sortGroups(await a.transport.listGroups()) !== expectA) throw new Error('A groups mismatch')
      if (
        sortGroups(await b.transport.listGroups()) !==
        sortGroups([{ groupId: groupAB, peerPubkey: a.transport.pubkey }])
      ) {
        throw new Error('B groups mismatch')
      }
      if (
        sortGroups(await c.transport.listGroups()) !==
        sortGroups([{ groupId: groupAC, peerPubkey: a.transport.pubkey }])
      ) {
        throw new Error('C groups mismatch')
      }
    })

    // B consumed its KeyPackage when it joined AB and rotated it. It must
    // still be invitable, by someone who fetches the KeyPackage now.
    const groupCB = await connect(c, b)
    await step('B -> C in group CB (B was invitable after its KeyPackage rotated)', () =>
      exchange(b, c, groupCB, 'hello C, this is B'),
    )

    await step('ignoreInvite drops a Welcome without joining', async () => {
      const before = sortGroups(await c.transport.listGroups())
      await b.transport.invitePeer(c.transport.pubkey)
      const invite = await waitFor('the invite', () =>
        c.invites.find((i) => i.inviterPubkey === b.transport.pubkey && !usedInvites.has(i.id)),
      )
      await c.transport.ignoreInvite(invite.id)
      if (sortGroups(await c.transport.listGroups()) !== before) throw new Error('C joined an ignored invite')
    })

    // Reload: B goes away, A writes meanwhile, B comes back with the same key
    // and stored state.
    const seenByB = new Set(b.messages.map((m) => m.id))
    await step('B stops', () => b.transport.stop())
    await step('A -> B while B is offline', () =>
      a.transport.send(groupAB, { t: 'chat', text: 'sent while B was away' }),
    )
    const b2 = open({ name: 'B', secretKeyHex: b.secretKeyHex, namespace: b.namespace })
    peers[1] = b2
    await step('B restarts from its stored state', () => b2.transport.start())
    await step('B still has its groups after the restart', async () => {
      const expectB = sortGroups([
        { groupId: groupAB, peerPubkey: a.transport.pubkey },
        { groupId: groupCB, peerPubkey: c.transport.pubkey },
      ])
      const got = (await b2.transport.listGroups()).filter((g) => g.groupId === groupAB || g.groupId === groupCB)
      if (sortGroups(got) !== expectB) throw new Error('B groups mismatch after restart')
    })
    await step('B receives the message sent while it was offline', async () => {
      await waitFor('the offline message', () =>
        b2.messages.find((m) => m.groupId === groupAB && m.msg.t === 'chat' && m.msg.text === 'sent while B was away'),
      )
    })
    await step('B -> A after the restart', () => exchange(b2, a, groupAB, 'B is back'))
    await step('A -> B after the restart', () => exchange(a, b2, groupAB, 'welcome back, B'))
    await step('restart re-delivered no old message and no old invite', async () => {
      await new Promise((resolve) => setTimeout(resolve, 1500))
      const replayed = b2.messages.filter((m) => seenByB.has(m.id))
      if (replayed.length) throw new Error(`${replayed.length} old message(s) delivered again`)
      if (b2.invites.length) throw new Error(`${b2.invites.length} old invite(s) surfaced again`)
    })
  } catch {
    // The failing step was already printed.
  } finally {
    await Promise.all(peers.map((peer) => peer.transport.stop().catch(() => {})))
  }

  console.log(`${failed ? 'FAILED' : 'ALL PASSED'} in ${Date.now() - startedAt} ms`)
  process.exit(failed ? 1 : 0)
}

void main()
