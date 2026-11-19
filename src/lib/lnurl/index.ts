/**
 * Lightning address -> invoice, fetched straight from the browser to the
 * user's own wallet service. No proxy, no library, no secrets.
 *
 * Specs (read 2026-11-13):
 *   LUD-16 https://github.com/lnurl/luds/blob/luds/16.md  user@domain -> https://domain/.well-known/lnurlp/user
 *   LUD-06 https://github.com/lnurl/luds/blob/luds/06.md  payRequest: callback, min/maxSendable (msat), metadata; then ?amount=<msat> -> { pr }
 *   BOLT11 https://github.com/lightning/bolts/blob/master/11-payment-encoding.md  `h` (23) is the SHA-256 of the description
 *
 * Nothing a server returns is trusted: the invoice must be mainnet, for exactly
 * the msat asked, not about to expire, and (when it has `h`) commit to the
 * metadata we were given. Any mismatch drops the invoice. Errors carry only a
 * fixed code (LnurlError), never the address, the invoice or the server's text,
 * and this module logs nothing (the support log has no lines for it).
 *
 * Input bounds for LNURL responses and Lightning
 * addresses: body cut at 64 KiB, metadata at most 8 KiB, 6 s per
 * request, credentials omitted, redirects are errors.
 */
import { sha256 } from '@noble/hashes/sha2.js'
import { bytesToHex, utf8ToBytes } from '@noble/hashes/utils.js'
import type { LnurlError, LnurlModule } from '../../contracts'
import { decodeInvoice, EXPIRING_SOON_SECONDS, secondsLeft } from '../bolt11'

/** Per request; the two steps together take at most about twice this. */
export const LNURL_TIMEOUT_MS = 6_000
export const MAX_BODY_BYTES = 64 * 1024
export const MAX_METADATA_BYTES = 8 * 1024
/** Longer invoices are not read by the trade room either. */
const MAX_INVOICE_CHARS = 4_096
const MAX_DOMAIN = 253

/** A failed lookup. `message` is the code; a 'range' failure also says what the wallet takes. */
export class LnurlFailure extends Error {
  constructor(
    readonly code: LnurlError,
    readonly minSats?: number,
    readonly maxSats?: number,
  ) {
    super(code)
    this.name = 'LnurlFailure'
  }
}

/**
 * Host names that never belong to a public wallet service. The same list as the
 * relay host rule (src/lib/marmot/guard.ts), plus `.localhost`.
 */
const PRIVATE_SUFFIXES = ['.local', '.internal', '.lan', '.home.arpa', '.onion', '.localhost']

const ADDRESS = /^([a-z0-9._+-]{1,64})@((?:[a-z0-9-]{1,63}\.)+(?=[a-z0-9-]*[a-z])[a-z0-9-]{2,63})$/

/**
 * `user@domain` as LUD-16 allows it, lowercased after NFKC, or null. The last
 * domain label must have a letter, there must be a dot (no `localhost`), and
 * private suffixes such as `.local` and `.onion` are refused. The regex alone
 * is not enough: the URL parser reads a host such as `127.0.0.0x1` or
 * `0x7f.0x1` as an IPv4 address, so the first-step URL is built and its
 * normalised host goes through the same rule as the callback (publicHost).
 */
export function parseLnAddress(text: string): string | null {
  if (typeof text !== 'string') return null
  const s = text.normalize('NFKC').trim().toLowerCase()
  if (!/^[\x21-\x7e]+$/.test(s)) return null
  const m = ADDRESS.exec(s)
  if (!m) return null
  const domain = m[2]
  if (domain.length > MAX_DOMAIN) return null
  if (PRIVATE_SUFFIXES.some((suffix) => domain.endsWith(suffix))) return null
  if (!firstStepUrl(m[1], domain)) return null
  return s
}

/**
 * The LUD-16 first-step URL, or null when the URL parser would send it
 * anywhere other than `https://<domain>/.well-known/lnurlp/<user>`: a host that
 * normalises to something else (an IP in hex, octal or integer spelling) or
 * fails the public host rule, and a name such as `.` or `..` that changes the path.
 */
function firstStepUrl(user: string, domain: string): URL | null {
  if (user === '.' || user === '..') return null
  let url: URL
  try {
    url = new URL(`https://${domain}/.well-known/lnurlp/${user}`)
  } catch {
    return null
  }
  if (!publicHost(url)) return null
  if (url.hostname !== domain) return null
  if (url.pathname !== `/.well-known/lnurlp/${user}` || url.search || url.hash) return null
  return url
}

/**
 * The one host rule for every URL this module fetches, applied to the parsed
 * (normalised) URL: https only, no user info, a dotted host name that is not an
 * IP literal in any spelling, not `localhost`, and not a private suffix. A
 * fully qualified name keeps its trailing dot in URL.hostname (`localhost.`,
 * `printer.local.`), so trailing dots are stripped first.
 */
function publicHost(url: URL): boolean {
  if (url.protocol !== 'https:') return false
  if (url.username || url.password) return false
  const host = url.hostname.toLowerCase().replace(/\.+$/, '')
  if (!host || !host.includes('.') || host === 'localhost') return false
  if (host.startsWith('[') || host.includes(':')) return false
  // After normalisation every IPv4 spelling is dotted decimal; a last label that
  // is still a number (decimal or 0x hex) is one the parser treats as an IP.
  if (/^\d+(\.\d+){3}$/.test(host)) return false
  if (/^(\d+|0x[0-9a-f]*)$/.test(host.slice(host.lastIndexOf('.') + 1))) return false
  if (PRIVATE_SUFFIXES.some((suffix) => host.endsWith(suffix))) return false
  return true
}

/**
 * Whether the callback a wallet service gave may be asked for an invoice: the
 * public host rule above. Its domain may differ from the address's (custodial
 * services do this). IP literals, `localhost` and private suffixes are refused,
 * so a hostile first response cannot point the browser at the user's router or
 * other local services.
 */
function callbackUrl(raw: unknown): URL | null {
  if (typeof raw !== 'string') return null
  let url: URL
  try {
    url = new URL(raw)
  } catch {
    return null
  }
  return publicHost(url) ? url : null
}

type Loose = Record<string, unknown>

interface PayRequest {
  callback: URL
  minMsat: bigint
  maxMsat: bigint
  metadata: string
}

function isErrorStatus(j: Loose): boolean {
  return typeof j.status === 'string' && j.status.toUpperCase() === 'ERROR'
}

/** The first-step response as LUD-06 step 3 describes it, or null. */
function payRequestOf(j: Loose): PayRequest | null {
  if (isErrorStatus(j) || j.tag !== 'payRequest') return null
  const callback = callbackUrl(j.callback)
  if (!callback) return null
  const min = j.minSendable
  const max = j.maxSendable
  if (typeof min !== 'number' || typeof max !== 'number') return null
  if (!Number.isSafeInteger(min) || !Number.isSafeInteger(max) || min < 1 || min > max) return null
  if (typeof j.metadata !== 'string' || utf8ToBytes(j.metadata).length > MAX_METADATA_BYTES) return null
  return { callback, minMsat: BigInt(min), maxMsat: BigInt(max), metadata: j.metadata }
}

/** Reads at most MAX_BODY_BYTES; null when the body is larger. */
async function readCapped(res: Response): Promise<Uint8Array | null> {
  const declared = Number(res.headers?.get?.('content-length'))
  if (Number.isFinite(declared) && declared > MAX_BODY_BYTES) return null
  const body = res.body
  if (!body) {
    const buf = new Uint8Array(await res.arrayBuffer())
    return buf.length > MAX_BODY_BYTES ? null : buf
  }
  const reader = body.getReader()
  const chunks: Uint8Array[] = []
  let total = 0
  for (;;) {
    const { done, value } = await reader.read()
    if (done) break
    total += value.length
    if (total > MAX_BODY_BYTES) {
      void reader.cancel().catch(() => {})
      return null
    }
    chunks.push(value)
  }
  const out = new Uint8Array(total)
  let at = 0
  for (const c of chunks) {
    out.set(c, at)
    at += c.length
  }
  return out
}

export interface LnurlOptions {
  fetch?: typeof fetch
  /** Per request. Default LNURL_TIMEOUT_MS. */
  timeoutMs?: number
  /** Milliseconds, for the expiry check. Default Date.now. */
  now?: () => number
}

/** The Lightning address module. No module-level default instance: the engine's deps build one. */
export function createLnurl(opts: LnurlOptions = {}): LnurlModule {
  const doFetch: typeof fetch = opts.fetch ?? ((input, init) => globalThis.fetch(input, init))
  const timeoutMs = opts.timeoutMs ?? LNURL_TIMEOUT_MS
  const now = opts.now ?? (() => Date.now())

  /** One GET, whole body included, within the time limit. Throws LnurlFailure. */
  async function getJson(url: string): Promise<Loose> {
    const ctrl = new AbortController()
    let timer: ReturnType<typeof setTimeout> | undefined
    const timedOut = new Promise<never>((_, reject) => {
      timer = setTimeout(() => {
        ctrl.abort()
        reject(new LnurlFailure('unreachable'))
      }, timeoutMs)
    })
    const run = async (): Promise<Loose> => {
      let res: Response
      try {
        res = await doFetch(url, {
          method: 'GET',
          credentials: 'omit',
          cache: 'no-store',
          redirect: 'error',
          headers: { accept: 'application/json' },
          signal: ctrl.signal,
        })
      } catch {
        // Network, CORS, offline, abort, and (with redirect: 'error') any redirect.
        throw new LnurlFailure('unreachable')
      }
      // A runtime that ignored redirect: 'error' must still not use a redirected answer.
      if (res.redirected || res.type === 'opaqueredirect' || (res.status >= 300 && res.status < 400)) {
        throw new LnurlFailure('unreachable')
      }
      if (!res.ok) throw new LnurlFailure('refused')
      let bytes: Uint8Array | null
      try {
        bytes = await readCapped(res)
      } catch {
        throw new LnurlFailure(ctrl.signal.aborted ? 'unreachable' : 'refused')
      }
      if (!bytes) throw new LnurlFailure('refused')
      let j: unknown
      try {
        j = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes))
      } catch {
        throw new LnurlFailure('refused')
      }
      if (!j || typeof j !== 'object' || Array.isArray(j)) throw new LnurlFailure('refused')
      return j as Loose
    }
    try {
      return await Promise.race([run(), timedOut])
    } finally {
      clearTimeout(timer)
    }
  }

  async function firstStep(address: string): Promise<PayRequest> {
    const norm = parseLnAddress(address)
    if (!norm) throw new LnurlFailure('bad-address')
    const at = norm.lastIndexOf('@')
    const url = firstStepUrl(norm.slice(0, at), norm.slice(at + 1))
    if (!url) throw new LnurlFailure('bad-address')
    const j = await getJson(url.href)
    const pay = payRequestOf(j)
    if (!pay) throw new LnurlFailure('refused')
    return pay
  }

  return {
    parseAddress: parseLnAddress,

    async check(address) {
      await firstStep(address)
    },

    async invoice(address, sats) {
      const pay = await firstStep(address)
      const minSats = Number((pay.minMsat + 999n) / 1000n)
      const maxSats = Number(pay.maxMsat / 1000n)
      if (!Number.isSafeInteger(sats) || sats < 1) throw new LnurlFailure('range', minSats, maxSats)
      const msat = BigInt(sats) * 1000n
      if (msat < pay.minMsat || msat > pay.maxMsat) throw new LnurlFailure('range', minSats, maxSats)

      const url = new URL(pay.callback.href)
      url.searchParams.set('amount', String(msat))
      const j = await getJson(url.href)
      if (isErrorStatus(j) || typeof j.pr !== 'string') throw new LnurlFailure('refused')
      if (j.pr.length > MAX_INVOICE_CHARS) throw new LnurlFailure('mismatch')

      const inv = decodeInvoice(j.pr)
      if (!inv) throw new LnurlFailure('mismatch')
      if (inv.network !== 'mainnet') throw new LnurlFailure('mismatch')
      if (inv.amountMsat === null || inv.amountMsat !== msat) throw new LnurlFailure('mismatch')
      if (inv.descriptionHash !== null && inv.descriptionHash !== bytesToHex(sha256(utf8ToBytes(pay.metadata)))) {
        throw new LnurlFailure('mismatch')
      }
      if (secondsLeft(inv, now()) <= EXPIRING_SOON_SECONDS) throw new LnurlFailure('mismatch')
      return inv.invoice
    },
  }
}
