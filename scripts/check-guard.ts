/**
 * pnpm check:guard — the inbox entrance against a flood.
 * No network: a real Welcome is made by two real transports over the fake relays of
 * scripts/fake-ws.ts, the junk locally.
 *
 *   G-INBOX-FLOOD  guardInviteStore + the inbox pump + marmot-ts's InviteManager under a
 *                  flood of junk gift wraps: merged `__seen` writes, `__seen` capped,
 *                  no wrap decrypted twice, the real Welcome still lands, memory pruned
 *   G-PRE          inboxPre refuses the shapes it should and keeps a normal wrap
 *   G-RELAYS       filterPeerRelays keeps public wss:// hosts only, the first 4
 *   G-ROOM         roomShapeOk: the pre-join check of a Welcome's room,
 *                  and the real transport refusing a room whose relay
 *                  fails the host rule (not joined, marked read) while an honest one joins
 */
import { internalGiftWrapEvents } from 'applesauce-common/helpers/gift-wrap'
import { finalizeEvent, type NostrEvent } from 'applesauce-core/helpers/event'
import { PrivateKeySigner } from 'applesauce-signers'
import { InviteManager, createGiftWrap, type GenericKeyValueStore, type NostrNetworkInterface, type StoredInviteEntry } from '@internet-privacy/marmot-ts'
import { InMemoryKeyValueStore } from '@internet-privacy/marmot-ts/extra'
import { APP_NAME, type IncomingInvite } from '../src/contracts'
import { filterPeerRelays, inboxPre, INBOX_SINCE_S, roomShapeOk } from '../src/lib/marmot/guard'
import { createInboxPump } from '../src/lib/marmot/inbox'
import { createTransport, generateSecretKeyHex } from '../src/lib/marmot/index'
import { secretKeyBytes } from '../src/lib/marmot/keys'
import { SEEN_KEEP, guardInviteStore } from '../src/lib/marmot/stores'
import { installFakeWebSocket } from './fake-ws'
import { nodeStorage } from './node-storage'

const fake = installFakeWebSocket()
let failures = 0
function ok(cond: boolean, what: string): void {
  if (cond) console.log(`PASS  ${what}`)
  else {
    failures++
    console.log(`FAIL  ${what}`)
  }
}
const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms))
const nowS = () => Math.floor(Date.now() / 1000)

/** Junk wraps for the flood. Half carry a properly encrypted rumor that is not a Welcome. */
const FLOOD = 5_000

// ---------------------------------------------------------------- a real Welcome

/** B's secret key and the gift-wrapped Welcome A sent to B, made by the real transports. */
async function realWelcome(): Promise<{ skB: string; wrap: NostrEvent }> {
  const relays = ['wss://guard-a.test', 'wss://guard-b.test']
  const open = async (sk: string, name: string) => {
    const { storage } = nodeStorage(`check-guard:${name}`)
    const tables = await storage.create({ method: 'none' }, async () => {})
    return createTransport({ secretKeyHex: sk, relays, lookupRelays: [], namespace: `check-guard:${name}`, persistence: 'memory', tables })
  }
  const skA = generateSecretKeyHex()
  const skB = generateSecretKeyHex()
  const A = await open(skA, 'a')
  const B = await open(skB, 'b')
  await Promise.all([A.start(), B.start()])
  await A.invitePeer(B.pubkey)
  await Promise.all([A.stop(), B.stop()])
  const wrap = fake.relay(relays[0]).stored.find((e) => e.kind === 1059 && e.tags.some((t) => t[0] === 'p' && t[1] === B.pubkey))
  if (!wrap) throw new Error('no Welcome wrap on the fake relay')
  return { skB, wrap }
}

// ---------------------------------------------------------------- G-INBOX-FLOOD

async function gInboxFlood(): Promise<void> {
  const { skB, wrap: real } = await realWelcome()
  const me = new PrivateKeySigner(secretKeyBytes(skB))
  const mePub = await me.getPublicKey()

  // Decryptions per ciphertext: a wrap decrypted twice shows as a count of 2.
  const decrypts = new Map<string, number>()
  const signer = Object.assign(Object.create(Object.getPrototypeOf(me)) as PrivateKeySigner, me)
  signer.nip44 = {
    encrypt: (pk: string, text: string) => me.nip44!.encrypt(pk, text),
    decrypt: (pk: string, ct: string) => {
      decrypts.set(ct, (decrypts.get(ct) ?? 0) + 1)
      return me.nip44!.decrypt(pk, ct)
    },
  }

  // The inner store counts real `__seen` writes.
  const mem = new InMemoryKeyValueStore<StoredInviteEntry>()
  let seenWrites = 0
  const inner: GenericKeyValueStore<StoredInviteEntry> = {
    getItem: (k) => mem.getItem(k),
    setItem: (k, v) => {
      if (k === '__seen') seenWrites++
      return mem.setItem(k, v)
    },
    removeItem: (k) => mem.removeItem(k),
    clear: () => mem.clear(),
    keys: () => mem.keys(),
  }
  const store = guardInviteStore(inner)
  const network = {} as NostrNetworkInterface
  const invites = new InviteManager({ signer, store, network })
  const welcomes: string[] = []
  invites.on('decrypted', (rumor) => welcomes.push(rumor.id))

  // The junk, made before the clock starts.
  const junk: NostrEvent[] = []
  const sender = new PrivateKeySigner()
  for (let i = 0; i < FLOOD; i++) {
    if (i % 2 === 0) {
      const sk = new Uint8Array(32)
      crypto.getRandomValues(sk)
      junk.push(finalizeEvent({ kind: 1059, created_at: nowS(), tags: [['p', mePub]], content: Buffer.from(sk).toString('base64') + 'x'.repeat(40) }, sk))
    } else {
      const rumor = { kind: 1, pubkey: await sender.getPublicKey(), created_at: nowS(), tags: [], content: `not a welcome ${i}`, id: '' }
      junk.push(await createGiftWrap({ rumor: rumor as never, recipient: mePub, signer: sender }))
    }
  }

  const t0 = Date.now()
  const pump = createInboxPump(invites)
  for (const e of junk) pump.push(e)
  pump.push(real)
  const settled = async () => {
    const keys = await mem.keys()
    return !keys.some((k) => k.startsWith('received:')) && welcomes.length > 0
  }
  for (let i = 0; i < 600 && !(await settled()); i++) await sleep(50)
  await sleep(300)
  await store.flush()
  const elapsedS = (Date.now() - t0) / 1000
  pump.stop()

  const seen = (await mem.getItem('__seen')) as { type: 'seen'; ids: string[] } | null
  const unread = (await mem.keys()).filter((k) => k.startsWith('unread:'))
  const twice = [...decrypts.values()].filter((n) => n > 1).length
  ok(seenWrites <= elapsedS / 2 + 2, `G-INBOX-FLOOD __seen written ${seenWrites} times in ${elapsedS.toFixed(1)} s (at most ${Math.floor(elapsedS / 2 + 2)})`)
  ok(!!seen && seen.ids.length <= SEEN_KEEP, `G-INBOX-FLOOD __seen keeps at most ${SEEN_KEEP} ids (${seen?.ids.length})`)
  ok(twice === 0, `G-INBOX-FLOOD no wrap decrypted twice (${twice} ciphertexts more than once, ${decrypts.size} decrypted)`)
  ok(unread.length === 1 && welcomes.length === 1, `G-INBOX-FLOOD the real Welcome sent last is in unread: (${unread.length} unread)`)
  internalGiftWrapEvents.prune()
  ok(internalGiftWrapEvents.size === 0, `G-INBOX-FLOOD the in-memory gift wrap store is empty after prune (${internalGiftWrapEvents.size})`)
  ok(elapsedS < 10, `G-INBOX-FLOOD done in under 10 s (${elapsedS.toFixed(1)} s, ${FLOOD} junk wraps)`)
}

// ---------------------------------------------------------------- G-PRE, G-RELAYS

function gPre(): void {
  const me = 'a'.repeat(64)
  const t = nowS()
  const base: NostrEvent = { id: 'b'.repeat(64), pubkey: 'c'.repeat(64), sig: 'd'.repeat(128), kind: 1059, created_at: t, tags: [['p', me]], content: 'x' }
  const cases: [string, NostrEvent, boolean][] = [
    ['a normal wrap', base, true],
    ['88,001 characters', { ...base, content: 'x'.repeat(88_001) }, false],
    ['11 minutes ahead', { ...base, created_at: t + 660 }, false],
    ['since minus 2 hours', { ...base, created_at: t - INBOX_SINCE_S - 7_200 }, false],
    [
      'two p tags',
      {
        ...base,
        tags: [
          ['p', me],
          ['p', me],
        ],
      },
      false,
    ],
    ["someone else's p", { ...base, tags: [['p', 'e'.repeat(64)]] }, false],
    ['a bad id', { ...base, id: 'XYZ' }, false],
    ['another kind', { ...base, kind: 1 }, false],
  ]
  const wrong = cases.filter(([, e, want]) => inboxPre(e, me, t) !== want).map(([n]) => n)
  ok(wrong.length === 0, `G-PRE inboxPre${wrong.length ? ` (wrong: ${wrong.join(', ')})` : ''}`)
}

function gRelays(): void {
  const many = Array.from({ length: 300 }, (_, i) => `wss://relay${i}.example.com`)
  ok(filterPeerRelays(many).length === 4, 'G-RELAYS 300 relays -> the first 4')
  const bad = [
    'ws://relay.example.com',
    'wss://1.2.3.4',
    'wss://[::1]',
    'wss://localhost',
    'wss://box.local',
    'wss://x.onion',
    'wss://y.internal',
    'wss://z.lan',
    'wss://h.home.arpa',
    'wss://user@relay.example.com',
    'wss://relay.example.com/?q=1',
    `wss://${'a'.repeat(200)}.com`,
    'not a url',
  ]
  const kept = filterPeerRelays([...bad, 'wss://Relay.Example.com/', 'wss://relay.example.com'])
  ok(kept.length === 1 && kept[0] === 'wss://relay.example.com', `G-RELAYS refuses ws:, IP, localhost, private names, user info, query, over 200 chars; dedupes (${kept.join(' ')})`)
}

function gRoomPure(): void {
  const me = 'b'.repeat(64)
  const room = { name: APP_NAME, adminPubkeys: [me], relays: ['wss://relay.example.com', 'wss://nos.example.org'] }
  const eight = Array.from({ length: 8 }, (_, i) => `wss://r${i}.example.com`)
  const cases: [string, Parameters<typeof roomShapeOk>[0], boolean][] = [
    ['honest', room, true],
    ['eight relays', { ...room, relays: eight }, true],
    ['no group info', null, false],
    ['another name', { ...room, name: 'other' }, false],
    ['two admins', { ...room, adminPubkeys: [me, 'c'.repeat(64)] }, false],
    ['admin not the sender', { ...room, adminPubkeys: ['c'.repeat(64)] }, false],
    ['no admin', { ...room, adminPubkeys: [] }, false],
    ['no relay', { ...room, relays: [] }, false],
    ['nine relays', { ...room, relays: [...eight, 'wss://r8.example.com'] }, false],
    ['a ws:// relay', { ...room, relays: ['wss://relay.example.com', 'ws://relay.example.com'] }, false],
    ['an IP relay', { ...room, relays: ['wss://203.0.113.7'] }, false],
    ['a private host', { ...room, relays: ['wss://relay.home.arpa'] }, false],
  ]
  const wrong = cases.filter(([, r, want]) => roomShapeOk(r, me, APP_NAME) !== want).map(([n]) => n)
  ok(wrong.length === 0, `G-ROOM roomShapeOk${wrong.length ? ` (wrong: ${wrong.join(', ')})` : ''}`)
}

/** A real Welcome whose room lists a ws:// relay is refused before joining; an honest one joins. */
async function gRoomTransport(): Promise<void> {
  const open = async (sk: string, name: string, relays: string[]) => {
    const { storage } = nodeStorage(`check-guard:${name}`)
    const tables = await storage.create({ method: 'none' }, async () => {})
    return createTransport({ secretKeyHex: sk, relays, lookupRelays: [], namespace: `check-guard:${name}`, persistence: 'memory', tables })
  }
  // The fake relays are keyed by host: ws:// and wss:// of one host are the same relay.
  const B = await open(generateSecretKeyHex(), 'room-b', ['wss://guard-room.test'])
  const odd = await open(generateSecretKeyHex(), 'room-odd', ['ws://guard-room.test'])
  const honest = await open(generateSecretKeyHex(), 'room-honest', ['wss://guard-room.test'])
  const got: IncomingInvite[] = []
  B.onInvite((i) => got.push(i))
  await Promise.all([B.start(), odd.start(), honest.start()])
  const wait = async (from: string) => {
    for (let i = 0; i < 200 && !got.some((x) => x.inviterPubkey === from); i++) await sleep(25)
    return got.find((x) => x.inviterPubkey === from)
  }
  await odd.invitePeer(B.pubkey)
  const oddInvite = await wait(odd.pubkey)
  let refused = ''
  if (oddInvite)
    await B.acceptInvite(oddInvite.id).then(
      () => (refused = 'joined'),
      (e: unknown) => (refused = e instanceof Error ? e.message : String(e)),
    )
  ok(!!oddInvite && refused === 'invite refused (shape)' && (await B.listGroups()).length === 0, `G-ROOM a room with a ws:// relay is not joined (${oddInvite ? refused : 'no Welcome'})`)
  await honest.invitePeer(B.pubkey)
  const honestInvite = await wait(honest.pubkey)
  const joined = honestInvite
    ? await B.acceptInvite(honestInvite.id).then(
        (r) => r.groupId,
        () => '',
      )
    : ''
  const groups = await B.listGroups()
  ok(joined !== '' && groups.length === 1 && groups[0].peerPubkey === honest.pubkey, 'G-ROOM an honest room is joined')
  await Promise.all([B.stop(), odd.stop(), honest.stop()])
}

gPre()
gRelays()
gRoomPure()
await gRoomTransport()
await gInboxFlood()
fake.restore()
console.log(failures ? `\n${failures} FAILED` : '\nALL PASS')
process.exit(failures ? 1 : 0)
