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

export function createRatesSource(): RatesSource {
  let cache: Rates | undefined
  let cachedAt = 0
  let inflight: Promise<Rates> | undefined

  async function load(): Promise<Rates> {
    const [KRW, USD] = await Promise.all([firstOk(KRW_ENDPOINTS), firstOk(USD_ENDPOINTS)])
    const out: Rates = { at: Date.now() }
    if (KRW !== undefined) out.KRW = KRW
    if (USD !== undefined) out.USD = USD
    // keep last good values for a currency that failed this round
    if (cache) {
      if (out.KRW === undefined && cache.KRW !== undefined) out.KRW = cache.KRW
      if (out.USD === undefined && cache.USD !== undefined) out.USD = cache.USD
    }
    if (out.KRW !== undefined || out.USD !== undefined) {
      cache = out
      cachedAt = Date.now()
    }
    return out
  }

  return {
    async fetch(): Promise<Rates> {
      try {
        if (cache && Date.now() - cachedAt < CACHE_MS) return cache
        inflight ??= load().finally(() => {
          inflight = undefined
        })
        return await inflight
      } catch {
        return cache ?? { at: Date.now() }
      }
    },
  }
}
