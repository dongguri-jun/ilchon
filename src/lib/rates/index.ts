import type { Rates, RatesSource } from '../../contracts'

const TIMEOUT_MS = 6000
const CACHE_MS = 30_000

type Parser = (json: unknown) => number | undefined
interface Endpoint {
  url: string
  parse: Parser
}

const num = (v: unknown): number | undefined => {
  const n = typeof v === 'string' ? Number(v) : typeof v === 'number' ? v : NaN
  return Number.isFinite(n) && n > 0 ? n : undefined
}
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Loose = any

const KRW_ENDPOINTS: Endpoint[] = [
  {
    url: 'https://api.upbit.com/v1/ticker?markets=KRW-BTC',
    parse: (j: Loose) => num(j?.[0]?.trade_price),
  },
  {
    url: 'https://api.bithumb.com/public/ticker/BTC_KRW',
    parse: (j: Loose) => num(j?.data?.closing_price),
  },
]

const USD_ENDPOINTS: Endpoint[] = [
  {
    url: 'https://api.coinbase.com/v2/prices/BTC-USD/spot',
    parse: (j: Loose) => num(j?.data?.amount),
  },
  {
    url: 'https://api.kraken.com/0/public/Ticker?pair=XBTUSD',
    parse: (j: Loose) => {
      const r = j?.result
      const first = r ? r[Object.keys(r)[0]] : undefined
      return num(first?.c?.[0])
    },
  },
]

async function fetchJson(url: string): Promise<unknown> {
  const ctrl = new AbortController()
  const timer = setTimeout(() => ctrl.abort(), TIMEOUT_MS)
  try {
    const res = await fetch(url, { signal: ctrl.signal, headers: { accept: 'application/json' } })
    if (!res.ok) throw new Error(`http ${res.status}`)
    return await res.json()
  } finally {
    clearTimeout(timer)
  }
}

async function firstOk(list: Endpoint[]): Promise<number | undefined> {
  for (const ep of list) {
    try {
      const v = ep.parse(await fetchJson(ep.url))
      if (v !== undefined) return v
    } catch {
      /* try next */
    }
  }
  return undefined
}

/** A price older than this is no longer shown: screens stop converting with it. */
const STALE_MS = 10 * 60_000

type Currency = 'KRW' | 'USD'

export function createRatesSource(): RatesSource {
  // Per currency: last successfully fetched price and when it was fetched.
  // A failed fetch never refreshes these timestamps.
  const last: Partial<Record<Currency, { price: number; at: number }>> = {}
  let checkedAt = 0
  let inflight: Promise<void> | undefined

  async function load(): Promise<void> {
    const [KRW, USD] = await Promise.all([firstOk(KRW_ENDPOINTS), firstOk(USD_ENDPOINTS)])
    const now = Date.now()
    if (KRW !== undefined) last.KRW = { price: KRW, at: now }
    if (USD !== undefined) last.USD = { price: USD, at: now }
    checkedAt = now
  }

  /** Only currencies whose last success is fresh. `at` is the oldest included success. */
  function snapshot(): Rates {
    const now = Date.now()
    const out: Rates = {}
    let oldest: number | undefined
    for (const c of ['KRW', 'USD'] as const) {
      const v = last[c]
      if (!v || now - v.at > STALE_MS) continue
      out[c] = v.price
      oldest = oldest === undefined ? v.at : Math.min(oldest, v.at)
    }
    out.at = oldest ?? now
    return out
  }

  return {
    async fetch(): Promise<Rates> {
      try {
        if (Date.now() - checkedAt >= CACHE_MS) {
          inflight ??= load().finally(() => {
            inflight = undefined
          })
          await inflight
        }
      } catch {
        /* keep last successes; snapshot() drops stale ones */
      }
      return snapshot()
    },
  }
}
