/**
 * Relay-level evidence: what a Nostr relay can see of ilchon traffic on Marmot.
 *
 *   pnpm exec tsx scripts/evidence-relay.ts
 *   PROBE_RELAY=wss://relay.eu.whitenoise.chat pnpm exec tsx scripts/evidence-relay.ts
 *
 * 1. Two throwaway identities A and B run the real transport (src/lib/marmot,
 *    memory persistence, DEFAULT_RELAYS).
 * 2. A invites B, B accepts, then they exchange a hello, two chats and a fake
 *    m1/m2/m3 match round through transport.send.
 * 3. Every frame the transports write to a relay socket is sniffed (EVENT ids
 *    and REQ filters), so we learn the group's `h` routing tag without
 *    touching transport internals.
 * 4. A fresh raw WebSocket asks the probe relay for what it stored: kind 445
 *    for that `h`, kind 1059 addressed to B, and A/B's 30443/10002/10050. For
 *    each event it prints kind, pubkey (A? B?), tag keys (A/B inside?), content
 *    length and created_at, then a "relay can / cannot see" summary.
 *
 * Content bodies are never printed (they are ciphertext). No secret keys are
 * printed.
 */
import { DEFAULT_RELAYS, type IncomingInvite, type IncomingMessage, type WireMessage } from '../src/contracts'

type NostrEvent = {
  id: string
  pubkey: string
  kind: number
  created_at: number
  tags: string[][]
  content: string
  sig: string
}

const PROBE_RELAY = process.env.PROBE_RELAY ?? 'wss://relay.us.whitenoise.chat'
const WAIT_MS = 45_000

// ------------------------------------------------------------ socket sniffer

let phase = 'init'
const published: { phase: string; relay: string; event: NostrEvent }[] = []
const hValues = new Set<string>()

const NativeWebSocket = globalThis.WebSocket
class SniffingWebSocket extends NativeWebSocket {
  send(data: string | ArrayBufferLike | Blob | ArrayBufferView): void {
    if (typeof data === 'string') {
      try {
        const frame = JSON.parse(data) as unknown[]
        if (frame[0] === 'EVENT' && typeof frame[1] === 'object') {
          const event = frame[1] as NostrEvent
          if (!published.some((p) => p.event.id === event.id && p.relay === this.url)) {
            published.push({ phase, relay: this.url, event })
          }
        } else if (frame[0] === 'REQ') {
          for (const filter of frame.slice(2) as Record<string, unknown>[]) {
            const h = filter['#h']
            if (Array.isArray(h)) for (const value of h) hValues.add(String(value))
          }
        }
      } catch {
        // not JSON, ignore
      }
    }
    super.send(data)
  }
}
globalThis.WebSocket = SniffingWebSocket as typeof WebSocket

// ------------------------------------------------------------ helpers

async function waitFor<T>(what: string, probe: () => T | undefined, ms = WAIT_MS): Promise<T> {
  const deadline = Date.now() + ms
  for (;;) {
    const value = probe()
    if (value !== undefined) return value
    if (Date.now() > deadline) throw new Error(`timed out after ${ms} ms waiting for ${what}`)
    await new Promise((resolve) => setTimeout(resolve, 50))
  }
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))

/** One REQ on a fresh socket; resolves on EOSE / CLOSED / timeout. */
function query(url: string, filter: Record<string, unknown>, ms = 10_000): Promise<{ events: NostrEvent[]; note: string }> {
  return new Promise((resolve) => {
    const ws = new NativeWebSocket(url)
    const sub = `ev${Math.random().toString(36).slice(2, 8)}`
    const events: NostrEvent[] = []
    let done = false
    const finish = (note: string) => {
      if (done) return
      done = true
      clearTimeout(timer)
      try {
        ws.close()
      } catch {
        // ignore
      }
      resolve({ events, note })
    }
    const timer = setTimeout(() => finish('timeout'), ms)
    ws.onopen = () => ws.send(JSON.stringify(['REQ', sub, filter]))
    ws.onerror = () => finish('socket error')
    ws.onmessage = (msg) => {
      try {
        const frame = JSON.parse(String(msg.data)) as unknown[]
        if (frame[0] === 'EVENT' && frame[1] === sub) events.push(frame[2] as NostrEvent)
        else if (frame[0] === 'EOSE' && frame[1] === sub) finish('EOSE')
        else if (frame[0] === 'CLOSED' && frame[1] === sub) finish(`CLOSED: ${String(frame[2])}`)
        else if (frame[0] === 'AUTH') {
          // We do not authenticate; whatever comes back is what an anonymous reader sees.
        }
      } catch {
        // ignore
      }
    }
  })
}

// ------------------------------------------------------------ main

async function main(): Promise<void> {
  const { createTransport, generateSecretKeyHex } = await import('../src/lib/marmot/index')

  const mk = (name: string) => {
    const transport = createTransport({
      secretKeyHex: generateSecretKeyHex(),
      relays: DEFAULT_RELAYS,
      namespace: `evidence:${name}:${Date.now()}`,
      persistence: 'memory',
    })
    const invites: IncomingInvite[] = []
    const messages: IncomingMessage[] = []
    transport.onInvite((i) => invites.push(i))
    transport.onMessage((m) => messages.push(m))
    return { name, transport, invites, messages }
  }

  const A = mk('A')
  const B = mk('B')
  const label = (pk: string) => (pk === A.transport.pubkey ? 'A' : pk === B.transport.pubkey ? 'B' : 'other')

  console.log(`probe relay : ${PROBE_RELAY}`)
  console.log(`app relays  : ${DEFAULT_RELAYS.join(', ')}`)
  console.log(`A pubkey    : ${A.transport.pubkey}`)
  console.log(`B pubkey    : ${B.transport.pubkey}`)
  const t0 = Math.floor(Date.now() / 1000)

  try {
    phase = 'start'
    await Promise.all([A.transport.start(), B.transport.start()])
    console.log('[ok] A and B started (relay lists + KeyPackage published)')

    phase = 'invite'
    const { groupId } = await A.transport.invitePeer(B.transport.pubkey)
    console.log(`[ok] A invited B, MLS group id ${groupId.slice(0, 16)}... (never sent in clear)`)

    const invite = await waitFor('invite', () => B.invites.find((i) => i.inviterPubkey === A.transport.pubkey))
    phase = 'accept'
    await B.transport.acceptInvite(invite.id)
    console.log('[ok] B accepted')

    const script: { from: typeof A; to: typeof A; msg: WireMessage }[] = [
      { from: A, to: B, msg: { t: 'hello', v: 1, code: 'evidence-code' } },
      { from: B, to: A, msg: { t: 'chat', text: 'hi A' } },
      { from: A, to: B, msg: { t: 'chat', text: 'hi B' } },
      { from: A, to: B, msg: { t: 'm1', sid: 'evsid1', p: 'fake-p-base64url' } },
      { from: B, to: A, msg: { t: 'm2', sid: 'evsid1', q: 'fake-q', pq: 'fake-commit' } },
      { from: A, to: B, msg: { t: 'm3', sid: 'evsid1', qp: 'fake-qp' } },
    ]
    for (const [i, step] of script.entries()) {
      phase = `send#${i + 1} ${step.from.name}->${step.to.name} ${step.msg.t}`
      const before = step.to.messages.length
      await step.from.transport.send(groupId, step.msg)
      await waitFor(`${step.to.name} receives ${step.msg.t}`, () =>
        step.to.messages.slice(before).find((m) => m.msg.t === step.msg.t && m.groupId === groupId),
      )
      console.log(`[ok] ${phase} delivered`)
    }
  } finally {
    phase = 'stop'
    await Promise.all([A.transport.stop().catch(() => {}), B.transport.stop().catch(() => {})])
  }
  await sleep(1500)
  const t1 = Math.floor(Date.now() / 1000) + 5

  // ---------------------------------------------------------- what we published
  const pubIds = new Set(published.map((p) => p.event.id))
  console.log(`\n=== frames our two clients wrote: ${pubIds.size} distinct events ===`)
  const seen = new Set<string>()
  for (const p of published) {
    if (seen.has(p.event.id)) continue
    seen.add(p.event.id)
    console.log(`  [${p.phase}] kind ${p.event.kind} id ${p.event.id.slice(0, 12)} pubkey=${label(p.event.pubkey)}`)
  }
  console.log(`  #h values used in our REQ filters: ${[...hValues].join(', ') || '(none seen)'}`)

  // ---------------------------------------------------------- what the relay stored
  const A_pk = A.transport.pubkey
  const B_pk = B.transport.pubkey
  const queries: { name: string; filter: Record<string, unknown> }[] = [
    { name: 'kind 445 group events (#h = our group)', filter: { kinds: [445], '#h': [...hValues] } },
    { name: 'kind 445 in run window (any group)', filter: { kinds: [445], since: t0 - 5, until: t1 } },
    { name: 'kind 1059 addressed to B (#p = B)', filter: { kinds: [1059], '#p': [B_pk] } },
    { name: 'kind 1059 addressed to A (#p = A)', filter: { kinds: [1059], '#p': [A_pk] } },
    { name: 'A and B profile events (30443/10002/10050)', filter: { kinds: [30443, 10002, 10050], authors: [A_pk, B_pk] } },
    { name: 'anything authored by A or B', filter: { authors: [A_pk, B_pk] } },
    { name: 'anything tagging A or B (#p)', filter: { '#p': [A_pk, B_pk] } },
  ]

  const stored = new Map<string, NostrEvent>()
  console.log(`\n=== what ${PROBE_RELAY} returns to an anonymous reader ===`)
  for (const q of queries) {
    if (q.filter['#h'] && (q.filter['#h'] as string[]).length === 0) {
      console.log(`\n-- ${q.name}: skipped, no h value captured`)
      continue
    }
    const { events, note } = await query(PROBE_RELAY, q.filter)
    const ours = q.name.includes('any group') ? events.filter((e) => pubIds.has(e.id)) : events
    console.log(`\n-- ${q.name}: ${events.length} event(s) [${note}]${q.name.includes('any group') ? `, ${ours.length} of them ours` : ''}`)
    for (const e of ours.sort((x, y) => x.created_at - y.created_at)) {
      stored.set(e.id, e)
      const tagKeys = e.tags.map((t) => t[0]).join(',')
      const hasA = e.tags.some((t) => t.includes(A_pk))
      const hasB = e.tags.some((t) => t.includes(B_pk))
      const hTag = e.tags.find((t) => t[0] === 'h')?.[1]
      const pTag = e.tags.find((t) => t[0] === 'p')?.[1]
      console.log(
        `   kind ${e.kind} id ${e.id.slice(0, 12)} created_at ${e.created_at} (t+${e.created_at - t0}s)` +
          ` pubkey ${e.pubkey.slice(0, 12)}=${label(e.pubkey)}` +
          ` tags[${tagKeys}] tagHasA=${hasA} tagHasB=${hasB}` +
          (hTag ? ` h=${hTag.slice(0, 12)}` : '') +
          (pTag ? ` p=${label(pTag)}` : '') +
          ` content ${e.content.length} chars` +
          ` ${pubIds.has(e.id) ? 'published-by-this-run' : ''}`,
      )
      // Plain-text tag values that are not pubkeys / ids (what the tag itself discloses).
      const plain = e.tags
        .filter((t) => !['h', 'p', 'e', 'd', 'i'].includes(t[0]))
        .map((t) => `${t[0]}=${t.slice(1).join('|').slice(0, 60)}`)
      if (plain.length && !q.name.includes('any group')) console.log(`      plain tags: ${plain.join('  ')}`)
    }
  }

  // ---------------------------------------------------------- summary
  const all = [...stored.values()]
  const g445 = all.filter((e) => e.kind === 445)
  const w1059 = all.filter((e) => e.kind === 1059)
  const prof = all.filter((e) => [30443, 10002, 10050].includes(e.kind))
  const g445PubkeysAorB = g445.filter((e) => label(e.pubkey) !== 'other').length
  const g445TagsAorB = g445.filter((e) => e.tags.some((t) => t.includes(A_pk) || t.includes(B_pk))).length
  const g445Pubkeys = new Set(g445.map((e) => e.pubkey)).size
  const g445H = new Set(g445.map((e) => e.tags.find((t) => t[0] === 'h')?.[1])).size

  console.log('\n=== summary ===')
  console.log(`kind 445 group events stored         : ${g445.length}`)
  console.log(`  distinct signing pubkeys           : ${g445Pubkeys} (A or B: ${g445PubkeysAorB})`)
  console.log(`  events with A or B in any tag      : ${g445TagsAorB}`)
  console.log(`  distinct h (group routing) values  : ${g445H}`)
  console.log(`kind 1059 welcome to B stored        : ${w1059.filter((e) => e.tags.some((t) => t[0] === 'p' && t[1] === B_pk)).length}`)
  console.log(`  welcome signed by A                : ${w1059.filter((e) => e.pubkey === A_pk).length}`)
  console.log(`  welcome tags mention A             : ${w1059.filter((e) => e.tags.some((t) => t.includes(A_pk))).length}`)
  console.log(`profile events (A/B signed)          : ${prof.map((e) => `${e.kind}:${label(e.pubkey)}`).join(' ')}`)
  console.log(`messages sent through the group      : 6 application + commits`)
  process.exit(0)
}

main().catch((error) => {
  console.error('FAILED:', error instanceof Error ? error.message : String(error))
  process.exit(1)
})
