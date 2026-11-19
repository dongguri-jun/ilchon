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
 *
 * Contact list round trip:
 *
 *   pnpm exec tsx scripts/smoke-marmot.ts list
 *   LIST_KEY_OUT=/some/dir/outside/the/repo/key pnpm exec tsx scripts/smoke-marmot.ts list
 *
 * A throwaway key seals one fixed-size list event (32768-byte plaintext, kind 30078,
 * own list key) and publishes it to each relay (publishListEvent), then reads it back
 * at once three ways: fetchCopies (what Transport.fetchList runs once started: author +
 * d, decrypted), per relay by author + d, and per relay by event id (`ids`), an
 * independent second read. No transport is started. Prints each relay's verdict
 * (accepted / rejected, read back / missing) and the read-only command for later.
 * Passes when at least two relays took it and give it back. LIST_KEY_OUT
 * writes the throwaway secret key there (mode 600) so a later read can decrypt;
 * never put it in the repository.
 *
 *   pnpm exec tsx scripts/smoke-marmot.ts list-read <listPubkey> <d> <eventId>
 *   LIST_KEY_FILE=<that file> pnpm exec tsx scripts/smoke-marmot.ts list-read <listPubkey> <d> <eventId>
 *
 * Read-only: asks each relay for that list again (24 hours and 7 days later) and
 * prints whether it still gives back the same event. Needs no secret; with
 * LIST_KEY_FILE it also decrypts and checks the 32768-byte plaintext. Publishes
 * nothing. Passes when at least two relays give back the same event.
 *
 *   LIST_RELAYS=wss://a,wss://b pnpm exec tsx scripts/smoke-marmot.ts list | list-read ... | list-age
 *
 * LIST_RELAYS sets the relays of the list modes (list relay candidates); without it they
 * use RELAYS or DEFAULT_RELAYS as before. In `list`, a relay that gives no verdict within
 * the app's 8 s gets the same event once more over a plain websocket, waiting LIST_ACK_MS
 * (default 20000). `list-age` is read-only: per relay it asks for kind 30078 events of any
 * author with until = now - 8 days (limit 20), prints how many came back and the oldest
 * created_at (evidence the relay keeps this kind past 7 days), and a NIP-11 summary.
 * `list-read` asks a relay that did not answer in the shared wait once more by event id
 * the same way.
 */
import { DEFAULT_RELAYS, type IncomingInvite, type IncomingMessage, type Transport } from '../src/contracts'
import { chmodSync, readFileSync, writeFileSync } from 'node:fs'
import type { NostrEvent } from 'applesauce-core/helpers/event'
import type { Filter } from 'applesauce-core/helpers/filter'
import { PrivateKeySigner } from 'applesauce-signers'
import { decodeList, encodeList, LIST_BYTES } from '../src/engine/contact-list'
import { createTransport, generateSecretKeyHex, npubOf } from '../src/lib/marmot/index'
import { isHex64, pubkeyOf, randomHex, secretKeyBytes } from '../src/lib/marmot/keys'
import { LIST_KIND, fetchCopies, listDOf, listPubkeyOf, openList, publishListEvent, sealList } from '../src/lib/marmot/list'
import { RelayNetwork } from '../src/lib/marmot/network'
import { memoryBackend, type MemoryBackend } from '../src/lib/store/backend'
import { nodeStorage } from './node-storage'

if (process.env.DEBUG_MARMOT) (globalThis as { ILCHON_DEBUG?: boolean }).ILCHON_DEBUG = true

const relays = process.env.RELAYS
  ? process.env.RELAYS.split(',')
      .map((url) => url.trim())
      .filter(Boolean)
  : DEFAULT_RELAYS

/** The list modes' relays: LIST_RELAYS when given (list relay candidates), else the same as above. */
const listRelays = process.env.LIST_RELAYS
  ? process.env.LIST_RELAYS.split(',')
      .map((url) => url.trim())
      .filter(Boolean)
  : relays

const WAIT_MS = 45_000

interface Peer {
  name: string
  secretKeyHex: string
  namespace: string
  /** The peer's encrypted store at rest; a restart opens it again (a page reload). */
  backend: MemoryBackend
  transport: Transport
  invites: IncomingInvite[]
  messages: IncomingMessage[]
}

/**
 * The transport over the peer's encrypted tables: an empty backend is
 * created with lock 'none', a used one is unlocked again by a new store instance, so a
 * restart reads its groups back through sealed names and values.
 */
async function open(peer: Omit<Peer, 'transport' | 'invites' | 'messages'>): Promise<Peer> {
  const { storage } = nodeStorage(peer.namespace, peer.backend)
  const tables = (await storage.status()) ? await storage.unlock({ method: 'none' }) : await storage.create({ method: 'none' }, async () => {})
  const transport = createTransport({
    secretKeyHex: peer.secretKeyHex,
    relays,
    namespace: peer.namespace,
    persistence: 'memory',
    tables,
  })
  const opened: Peer = { ...peer, transport, invites: [], messages: [] }
  transport.onInvite((invite) => opened.invites.push(invite))
  transport.onMessage((message) => {
    opened.messages.push(message)
    // A callback that could not finish: the message stays in the inbox.
    if (message.msg.t === 'chat' && refuseOnce.has(message.msg.text)) {
      refuseOnce.delete(message.msg.text)
      return Promise.reject(new Error('not handled'))
    }
    // A callback that sends while the start that delivered it again still runs.
    if (message.msg.t === 'chat' && message.msg.text.startsWith('reply-on-replay:')) {
      return transport.send(message.groupId, { t: 'chat', id: randomHex(16), text: `replied ${message.msg.text.slice(16)}` })
    }
  })
  return opened
}

function makePeer(name: string): Promise<Peer> {
  return open({ name, secretKeyHex: generateSecretKeyHex(), namespace: `smoke:${name}:${Date.now()}`, backend: memoryBackend() })
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

function sortGroups(list: { groupId: string; peerPubkey: string | null }[]): string {
  return list
    .map((g) => `${g.groupId}:${g.peerPubkey}`)
    .sort()
    .join(',')
}
const startedAt = Date.now()

/** start() waits as long as no relay takes it; the smoke gives it this long. */
const START_LIMIT_MS = 90_000

/** `p`, or a rejection after `ms`. */
function limited<T>(p: Promise<T>, ms: number, what: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`${what} did not finish within ${ms} ms`)), ms)
    p.then(
      (v) => {
        clearTimeout(timer)
        resolve(v)
      },
      (e: unknown) => {
        clearTimeout(timer)
        reject(e)
      },
    )
  })
}

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
  await from.transport.send(groupId, { t: 'chat', id: randomHex(16), text })
  const received = await waitFor(`${to.name} to receive "${text}"`, () => to.messages.find((m) => m.groupId === groupId && m.msg.t === 'chat' && m.msg.text === text))
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
  const { groupId } = await step(`${inviter.name} invites ${invitee.name}`, () => inviter.transport.invitePeer(invitee.transport.pubkey))
  await step(`${inviter.name} sends 2 messages before ${invitee.name} joined`, async () => {
    await inviter.transport.send(groupId, { t: 'hello', v: 1, code: `early-${tag}` })
    await inviter.transport.send(groupId, { t: 'chat', id: randomHex(16), text: `early-2-${tag}` })
  })
  const invite = await step(`${invitee.name} receives the invite from ${inviter.name}`, () =>
    waitFor('the invite', () => invitee.invites.find((i) => i.inviterPubkey === inviter.transport.pubkey && !usedInvites.has(i.id))),
  )
  usedInvites.add(invite.id)
  await step(`the invite carries its sentAt and ${invitee.name} has not joined yet (stored rooms)`, async () => {
    const nowS = Math.floor(Date.now() / 1000)
    if (typeof invite.sentAt !== 'number' || Math.abs(invite.sentAt - nowS) > 600) throw new Error(`sentAt ${invite.sentAt}`)
    if (inviter.transport.peerJoined(groupId)) throw new Error('peerJoined before the invitee joined')
  })
  if (invitee.messages.some((m) => m.groupId === groupId)) {
    failed++
    console.log(`FAIL  ${invitee.name} got group messages before joining`)
  }
  // While the invitee joins and rotates its leaf key, the inviter keeps talking.
  const during = (async () => {
    for (let i = 1; i <= 3; i++) {
      await new Promise((resolve) => setTimeout(resolve, 350))
      await inviter.transport.send(groupId, { t: 'chat', id: randomHex(16), text: `during-${i}-${tag}` })
    }
  })()
  await step(`${invitee.name} accepts the invite`, async () => {
    const joined = await invitee.transport.acceptInvite(invite.id)
    if (joined.groupId !== groupId) throw new Error('joined a different group id than the inviter created')
  })
  await step(`${inviter.name} sent 3 more messages while ${invitee.name} was joining`, () => during)
  await step(`${invitee.name} receives all 5 messages, in sending order`, async () => {
    const expected = [`early-${tag}`, `early-2-${tag}`, `during-1-${tag}`, `during-2-${tag}`, `during-3-${tag}`]
    const label = (m: IncomingMessage) => (m.msg.t === 'hello' ? m.msg.code : m.msg.t === 'chat' ? m.msg.text : m.msg.t)
    const inGroup = () => invitee.messages.filter((m) => m.groupId === groupId)
    const got = await waitFor('5 messages', () => (inGroup().length >= expected.length ? inGroup() : undefined), 20_000).catch(() => {
      throw new Error(`only got ${inGroup().map(label).join('|') || 'nothing'}`)
    })
    const texts = got.map(label)
    if (texts.join('|') !== expected.join('|')) throw new Error(`got ${texts.join('|')}`)
  })
  // The joiner's self-update after joining is the commit that moves the epoch past 1.
  await step(`${inviter.name} sees that ${invitee.name} joined (peerJoined, stored rooms)`, () => waitFor('peerJoined', () => (inviter.transport.peerJoined(groupId) ? true : undefined), 20_000))
  return groupId
}

const usedInvites = new Set<string>()
/** Chat texts whose first delivery the receiving callback rejects. */
const refuseOnce = new Set<string>()

async function main(): Promise<void> {
  console.log(`relays: ${relays.join(', ')}`)
  const a = await makePeer('A')
  const b = await makePeer('B')
  const c = await makePeer('C')
  const peers = [a, b, c]
  for (const peer of peers) console.log(`${peer.name}: ${npubOf(peer.transport.pubkey)}`)

  try {
    await Promise.all(peers.map((peer) => step(`${peer.name} start (relay lists + KeyPackage published)`, () => limited(peer.transport.start(), START_LIMIT_MS, 'start'))))
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

    await step('A -> B again in group AB (first group still works)', () => exchange(a, b, groupAB, 'still there, B?'))
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
      if (sortGroups(await b.transport.listGroups()) !== sortGroups([{ groupId: groupAB, peerPubkey: a.transport.pubkey }])) {
        throw new Error('B groups mismatch')
      }
      if (sortGroups(await c.transport.listGroups()) !== sortGroups([{ groupId: groupAC, peerPubkey: a.transport.pubkey }])) {
        throw new Error('C groups mismatch')
      }
    })

    // B consumed its KeyPackage when it joined AB and rotated it. It must
    // still be invitable, by someone who fetches the KeyPackage now.
    const groupCB = await connect(c, b)
    await step('B -> C in group CB (B was invitable after its KeyPackage rotated)', () => exchange(b, c, groupCB, 'hello C, this is B'))

    await step('ignoreInvite drops a Welcome without joining', async () => {
      const before = sortGroups(await c.transport.listGroups())
      await b.transport.invitePeer(c.transport.pubkey)
      const invite = await waitFor('the invite', () => c.invites.find((i) => i.inviterPubkey === b.transport.pubkey && !usedInvites.has(i.id)))
      await c.transport.ignoreInvite(invite.id)
      if (sortGroups(await c.transport.listGroups()) !== before) throw new Error('C joined an ignored invite')
    })

    // Reload: B goes away, A writes meanwhile, B comes back with the same key
    // and stored state.
    // B's callback rejects one message; it must come again after the restart.
    const keptText = 'reply-on-replay:kept'
    refuseOnce.add(keptText)
    await step('A -> B a message whose callback B rejects', () => exchange(a, b, groupAB, keptText))
    const seenByB = new Set(b.messages.filter((m) => !(m.msg.t === 'chat' && m.msg.text === keptText)).map((m) => m.id))
    await step('B stops', () => b.transport.stop())
    await step('A -> B while B is offline', () => a.transport.send(groupAB, { t: 'chat', id: randomHex(16), text: 'sent while B was away' }))
    const b2 = await open({ name: 'B', secretKeyHex: b.secretKeyHex, namespace: b.namespace, backend: b.backend })
    peers[1] = b2
    await step('B restarts from its stored state', () => limited(b2.transport.start(), START_LIMIT_MS, 'start'))
    await step('B still has its groups after the restart', async () => {
      const expectB = sortGroups([
        { groupId: groupAB, peerPubkey: a.transport.pubkey },
        { groupId: groupCB, peerPubkey: c.transport.pubkey },
      ])
      const got = (await b2.transport.listGroups()).filter((g) => g.groupId === groupAB || g.groupId === groupCB)
      if (sortGroups(got) !== expectB) throw new Error('B groups mismatch after restart')
    })
    await step('B receives the message sent while it was offline', async () => {
      await waitFor('the offline message', () => b2.messages.find((m) => m.groupId === groupAB && m.msg.t === 'chat' && m.msg.text === 'sent while B was away'))
    })
    await step('B gets the rejected message again, once, and its reply from the callback reaches A', async () => {
      await waitFor('the kept message', () => b2.messages.find((m) => m.msg.t === 'chat' && m.msg.text === keptText))
      await waitFor('the reply', () => a.messages.find((m) => m.msg.t === 'chat' && m.msg.text === 'replied kept'))
      if (b2.messages.filter((m) => m.msg.t === 'chat' && m.msg.text === keptText).length !== 1) throw new Error('delivered more than once')
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

// ---------------------------------------------------------------- contact list

/** A network for one-shot list calls; its signer never answers auth (list calls pass no auth). */
function listNetwork(): RelayNetwork {
  return new RelayNetwork(listRelays, new PrivateKeySigner(secretKeyBytes(generateSecretKeyHex())), [])
}

/** The query for one list, newest copy: by its author (list key) and `d`. */
function byAuthorD(listPubkey: string, d: string): Filter {
  return { kinds: [LIST_KIND], authors: [listPubkey], '#d': [d], limit: 1 }
}

/** Each relay's answer to `filter`: did it answer, which event id, created_at. */
async function readEach(
  network: RelayNetwork,
  filter: Filter,
): Promise<{ answered: Set<string>; byRelay: Record<string, { id: string; createdAt: number; event: NostrEvent }[]>; failed: Record<string, string> }> {
  try {
    const each = await network.requestEach(listRelays, filter, { waitFor: listRelays })
    const byRelay: Record<string, { id: string; createdAt: number; event: NostrEvent }[]> = {}
    for (const [relay, events] of Object.entries(each.byRelay)) {
      byRelay[relay] = events.map((event) => ({ id: event.id, createdAt: event.created_at, event }))
    }
    return { answered: new Set(each.answered), byRelay, failed: each.failed }
  } catch (error) {
    return { answered: new Set(), byRelay: {}, failed: { '*': error instanceof Error ? error.message : String(error) } }
  }
}

async function listMain(): Promise<void> {
  console.log(`relays: ${listRelays.join(', ')}`)
  const sk = generateSecretKeyHex()
  const listPubkey = listPubkeyOf(sk)
  const d = listDOf(sk)
  const keyOut = process.env.LIST_KEY_OUT
  if (keyOut) {
    writeFileSync(keyOut, `${sk}\n`, { mode: 0o600 })
    chmodSync(keyOut, 0o600)
    console.log('throwaway secret key written to LIST_KEY_OUT (keep it out of the repository)')
  }
  // Made-up contacts: random pubkeys, a name, one deletion. Nothing real.
  const now = Date.now()
  const payload = encodeList({
    v: 1,
    c: [
      [randomHex(32), 'smoke one', now - 3_000],
      [randomHex(32), '스모크 둘', now - 2_000],
    ],
    d: [[randomHex(32), now - 1_000]],
  })
  const createdAt = Math.floor(now / 1000)
  const event = await sealList(sk, payload, createdAt)
  const wire = JSON.stringify(event)
  console.log(`published at: ${new Date(createdAt * 1000).toISOString()} (created_at ${createdAt})`)
  console.log(`list pubkey:  ${listPubkey}`)
  console.log(`d:            ${d}`)
  console.log(`event id:     ${event.id}`)
  console.log(`plaintext ${new TextEncoder().encode(payload).length} bytes, content ${event.content.length} chars, event ${wire.length} bytes`)

  const network = listNetwork()
  const accepted = new Set<string>()
  const readBack = new Set<string>()
  try {
    const t0 = Date.now()
    const results = await publishListEvent(network, listRelays, event)
    console.log(`\npublish (${Date.now() - t0} ms):`)
    for (const relay of listRelays) {
      const r = results[relay]
      if (r?.ok) accepted.add(relay)
      console.log(`  ${relay}: ${!r ? 'no answer' : r.ok ? 'accepted' : `rejected${r.message ? ` (${r.message})` : ''}`}`)
    }
    // A relay that gave no verdict within the app's 8 s: the same event once more, waiting longer.
    const silent = listRelays.filter((relay) => !results[relay] || results[relay].uncertain)
    if (silent.length) {
      console.log(`
no verdict within 8 s; sending the same event again, waiting up to ${ACK_MS} ms:`)
      await Promise.all(
        silent.map(async (relay) => {
          const t = Date.now()
          const r = await rawPublish(relay, event, ACK_MS)
          if (r.ok) accepted.add(relay)
          console.log(`  ${relay}: ${r.ok ? 'accepted' : r.answered ? `rejected (${r.message})` : `no answer (${r.message})`} after ${Date.now() - t} ms`)
        }),
      )
    }

    const t1 = Date.now()
    const fetched = await fetchCopies(network, listRelays, sk).then(
      (value) => ({ ok: true as const, value }),
      (error: unknown) => ({ ok: false as const, error: error instanceof Error ? error.message : String(error) }),
    )
    console.log(`\nread back through fetchCopies (author + d, decrypted; ${Date.now() - t1} ms):`)
    if (!fetched.ok) console.log(`  rejected: ${fetched.error}`)
    else {
      for (const relay of fetched.value.asked) {
        const copy = fetched.value.copies.find((c) => c.relay === relay)
        const same = !!copy && copy.payload === payload && copy.createdAt === createdAt
        if (same) readBack.add(relay)
        const body = copy ? decodeList(copy.payload, pubkeyOf(sk), Date.now()) : null
        console.log(
          `  ${relay}: ${!fetched.value.answered.includes(relay) ? 'no answer' : !copy ? 'answered, no copy' : same ? `same plaintext (${body ? `${body.c.length} contacts, ${body.d.length} deleted` : 'did not decode'})` : 'a different copy'}`,
        )
      }
    }

    const reads: [string, Filter][] = [
      ['by author + d (newest one)', byAuthorD(listPubkey, d)],
      ['by event id', { ids: [event.id] }],
    ]
    for (const [label, filter] of reads) {
      const got = await readEach(network, filter)
      console.log(`\nread back ${label}:`)
      for (const relay of listRelays) {
        const first = got.byRelay[relay]?.[0]
        console.log(
          `  ${relay}: ${!got.answered.has(relay) ? `no answer${got.failed[relay] ? ` (${got.failed[relay]})` : ''}` : !first ? 'answered, no event' : first.id === event.id ? 'same event id' : `other event ${first.id}`}`,
        )
      }
    }
  } finally {
    network.close()
  }
  const both = listRelays.filter((r) => accepted.has(r) && readBack.has(r))
  console.log(`\naccepted by ${accepted.size} of ${listRelays.length}, read back from ${readBack.size}; both: ${both.length}`)
  const env = process.env.LIST_RELAYS ? `LIST_RELAYS=${listRelays.join(',')} ` : ''
  console.log(`read again later:\n  ${env}pnpm exec tsx scripts/smoke-marmot.ts list-read ${listPubkey} ${d} ${event.id}`)
  const ok = both.length >= 2
  console.log(ok ? 'PASS  at least two relays took the list and gave it back' : 'FAIL  fewer than two relays took the list and gave it back')
  process.exit(ok ? 0 : 1)
}

async function listReadMain(listPubkey: string, d: string, eventId: string): Promise<void> {
  if (!isHex64(listPubkey) || !/^[0-9a-f]{32}$/.test(d) || !isHex64(eventId)) {
    console.log('usage: smoke-marmot.ts list-read <listPubkey 64 hex> <d 32 hex> <eventId 64 hex>')
    process.exit(2)
  }
  let sk: string | undefined
  if (process.env.LIST_KEY_FILE) {
    sk = readFileSync(process.env.LIST_KEY_FILE, 'utf8').trim()
    if (!isHex64(sk) || listPubkeyOf(sk) !== listPubkey) {
      console.log('LIST_KEY_FILE does not hold the key of this list')
      process.exit(2)
    }
  }
  console.log(`relays: ${listRelays.join(', ')}`)
  console.log(`read at: ${new Date().toISOString()}`)
  const network = listNetwork()
  let same = 0
  try {
    const got = await readEach(network, byAuthorD(listPubkey, d))
    for (const relay of listRelays) {
      const first = got.byRelay[relay]?.[0]
      let line: string
      if (!got.answered.has(relay)) line = `no answer${got.failed[relay] ? ` (${got.failed[relay]})` : ''}`
      else if (!first) line = 'answered, no event'
      else if (first.id !== eventId) line = `other event ${first.id}`
      else {
        same++
        line = `same event (created_at ${first.createdAt})`
        if (sk) {
          const payload = await openList(sk, first.event)
          line += payload !== null && new TextEncoder().encode(payload).length === LIST_BYTES ? ', decrypts to 32768 bytes' : ', DOES NOT DECRYPT'
        }
      }
      console.log(`  ${relay}: ${line}`)
    }
    // A relay that did not answer within the shared wait: once more by event id, alone, waiting longer.
    const silent = listRelays.filter((relay) => !got.answered.has(relay))
    if (silent.length) console.log(`\nno answer above; asking again by event id over a plain websocket, waiting up to ${ACK_MS} ms:`)
    await Promise.all(
      silent.map(async (relay) => {
        const again = await rawRequest(relay, { ids: [eventId] }, ACK_MS)
        const hit = again.events.find((e) => e.id === eventId)
        if (hit) same++
        console.log(
          `  ${relay}: ${again.error ? `no answer (${again.error})` : again.closed !== undefined ? `CLOSED (${again.closed})` : hit ? `same event (created_at ${hit.created_at})` : 'answered, no event'}`,
        )
      }),
    )
  } finally {
    network.close()
  }
  const ok = same >= 2
  console.log(`${same} of ${listRelays.length} relays still give it back`)
  console.log(ok ? 'PASS  at least two relays still hold the list' : 'FAIL  fewer than two relays still hold the list')
  process.exit(ok ? 0 : 1)
}

// ---------------------------------------------------------------- list relay candidates (raw)

/** How long the slow-ack retry and list-age wait for a relay (LIST_ACK_MS, default 20 s). */
const ACK_MS = Number(process.env.LIST_ACK_MS) || 20_000

/**
 * One plain websocket to `url`: sends `frame`, hands each incoming message to `onMessage`
 * until it returns true, the socket closes, or `ms` pass. Outside RelayNetwork on purpose,
 * so a slow relay gets its own wait and nothing is retried behind the script's back.
 */
function rawSession(url: string, frame: unknown[], ms: number, onMessage: (message: unknown[]) => boolean): Promise<{ done: boolean; error?: string }> {
  return new Promise((resolve) => {
    let settled = false
    let ws: WebSocket | undefined
    const end = (done: boolean, error?: string) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      try {
        ws?.close()
      } catch {
        // Already closed.
      }
      resolve({ done, error })
    }
    const timer = setTimeout(() => end(false, `no answer within ${ms} ms`), ms)
    try {
      ws = new WebSocket(url)
    } catch (error) {
      end(false, error instanceof Error ? error.message : String(error))
      return
    }
    ws.onopen = () => ws?.send(JSON.stringify(frame))
    ws.onerror = () => end(false, 'connection error')
    ws.onclose = (e) => end(false, `closed (${e.code}${e.reason ? ` ${e.reason}` : ''})`)
    ws.onmessage = (e) => {
      let message: unknown
      try {
        message = JSON.parse(String(e.data))
      } catch {
        return
      }
      if (Array.isArray(message) && onMessage(message)) end(true)
    }
  })
}

/** Publishes `event` to one relay and waits up to `ms` for its OK frame. */
async function rawPublish(url: string, event: NostrEvent, ms: number): Promise<{ ok: boolean; answered: boolean; message: string }> {
  let verdict: { ok: boolean; message: string } | undefined
  const r = await rawSession(url, ['EVENT', event], ms, (m) => {
    if (m[0] === 'OK' && m[1] === event.id) {
      verdict = { ok: m[2] === true, message: String(m[3] ?? '') }
      return true
    }
    if (m[0] === 'NOTICE') console.log(`    ${url} NOTICE: ${String(m[1])}`)
    return false
  })
  return verdict ? { ...verdict, answered: true } : { ok: false, answered: false, message: r.error ?? 'no verdict' }
}

/** One REQ to one relay: the events up to EOSE (or CLOSED), within `ms`. */
async function rawRequest(url: string, filter: Filter, ms: number): Promise<{ events: NostrEvent[]; eose: boolean; closed?: string; error?: string }> {
  const sub = `age-${randomHex(4)}`
  const events: NostrEvent[] = []
  let closed: string | undefined
  const r = await rawSession(url, ['REQ', sub, filter], ms, (m) => {
    if (m[0] === 'EVENT' && m[1] === sub && m[2] && typeof m[2] === 'object') events.push(m[2] as NostrEvent)
    if (m[0] === 'CLOSED' && m[1] === sub) closed = String(m[2] ?? '')
    return (m[0] === 'EOSE' && m[1] === sub) || closed !== undefined
  })
  return { events, eose: r.done && closed === undefined, closed, error: r.done ? undefined : r.error }
}

/** The relay's NIP-11 document, summarised: software, the limits that matter here, retention. */
async function nip11Summary(url: string): Promise<string> {
  const http = url.replace(/^ws/, 'http')
  try {
    const res = await fetch(http, { headers: { Accept: 'application/nostr+json' }, signal: AbortSignal.timeout(10_000) })
    if (!res.ok) return `HTTP ${res.status}`
    const info = (await res.json()) as Record<string, unknown>
    const lim = (info.limitation ?? {}) as Record<string, unknown>
    const parts = [`${String(info.software ?? '?').replace(/^.*\//, '')} ${String(info.version ?? '')}`.trim()]
    for (const key of ['max_message_length', 'max_content_length', 'auth_required', 'payment_required', 'restricted_writes', 'created_at_lower_limit']) {
      if (lim[key] !== undefined) parts.push(`${key}=${String(lim[key])}`)
    }
    parts.push(info.retention !== undefined ? `retention=${JSON.stringify(info.retention)}` : 'no retention field')
    return parts.join(', ')
  } catch (error) {
    return `not retrieved (${error instanceof Error ? error.message : String(error)})`
  }
}

/**
 * Read-only: per relay, kind 30078 events of any author older than 8 days (until = now - 8 d,
 * limit 20). Any such event is evidence the relay keeps this kind past 7 days. Plus NIP-11.
 */
async function listAgeMain(): Promise<void> {
  const until = Math.floor(Date.now() / 1000) - 8 * 24 * 3600
  console.log(`relays: ${listRelays.join(', ')}`)
  console.log(`read at: ${new Date().toISOString()}; asking for kind ${LIST_KIND}, until ${until} (${new Date(until * 1000).toISOString()}), limit 20`)
  let kept = 0
  await Promise.all(
    listRelays.map(async (relay) => {
      const [got, info] = await Promise.all([rawRequest(relay, { kinds: [LIST_KIND], until, limit: 20 }, ACK_MS), nip11Summary(relay)])
      const old = got.events.filter((e) => e.kind === LIST_KIND && e.created_at <= until)
      const oldest = old.reduce<number | undefined>((min, e) => (min === undefined || e.created_at < min ? e.created_at : min), undefined)
      if (old.length) kept++
      const answer = got.error
        ? `no answer (${got.error})`
        : got.closed !== undefined
          ? `CLOSED (${got.closed})`
          : `${old.length} older than 8 days${oldest !== undefined ? `, oldest ${new Date(oldest * 1000).toISOString()} (${oldest})` : ''}${got.eose ? '' : ', no EOSE'}`
      console.log(`  ${relay}: ${answer}\n      NIP-11: ${info}`)
    }),
  )
  console.log(`${kept} of ${listRelays.length} relays returned kind ${LIST_KIND} events older than 8 days`)
  process.exit(0)
}

const mode = process.argv[2]
if (mode === 'list') void listMain()
else if (mode === 'list-age') void listAgeMain()
else if (mode === 'list-read') void listReadMain(process.argv[3] ?? '', process.argv[4] ?? '', process.argv[5] ?? '')
else void main()
