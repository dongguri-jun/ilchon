import { CURRENCIES, type Currency, type Rates, type RatesSource } from '../../contracts'

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

/** Kraken Ticker: last trade price of the first (only) pair in the result. */
const krakenLast = (j: Loose): number | undefined => {
  const r = j?.result
  const first = r ? r[Object.keys(r)[0]] : undefined
  return num(first?.c?.[0])
}

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
    parse: (j: Loose) => krakenLast(j),
  },
]

/**
 * JPY comes from two sources asked together, and a value is used only when it
 * is confirmed (see pickConfirmed). Not used: Coinbase /v2/prices/BTC-JPY/spot,
 * the same shape as the USD source above, returned about 3.1 times the real
 * price on 2026-11-13 (35,600,000 against about 11,500,000 elsewhere).
 * bitFlyer and Coincheck do not allow browser calls (no CORS headers).
 */
const JPY_ENDPOINTS: Endpoint[] = [
  {
    url: 'https://public.bitbank.cc/btc_jpy/ticker',
    parse: (j: Loose) => num(j?.data?.last),
  },
  {
    url: 'https://api.coinbase.com/v2/exchange-rates?currency=BTC',
    parse: (j: Loose) => num(j?.data?.rates?.JPY),
  },
]

/** Asked only when the two JPY sources cannot settle it. Thin market: can be 1-2% off. */
const JPY_TIEBREAK: Endpoint = {
  url: 'https://api.kraken.com/0/public/Ticker?pair=XBTJPY',
  parse: (j: Loose) => krakenLast(j),
}

/** Two JPY prices within this fraction of each other count as the same price. */
export const JPY_AGREE = 0.05
/** A JPY price whose ratio to the USD price falls in this band is plausible. */
export const USDJPY_MIN = 100
export const USDJPY_MAX = 220

/**
 * First candidate confirmed by another candidate (within JPY_AGREE) or by the
 * USD price (ratio within USDJPY_MIN..USDJPY_MAX). Undefined when none is.
 * Pure, exported for scripts/check-currency.ts.
 */
export function pickConfirmed(cands: readonly number[], usd: number | undefined): number | undefined {
  for (let i = 0; i < cands.length; i++) {
    const c = cands[i]
    if (!(c > 0) || !Number.isFinite(c)) continue
    const agrees = cands.some((o, j) => j !== i && o > 0 && Number.isFinite(o) && Math.abs(c - o) / Math.min(c, o) <= JPY_AGREE)
    const ratio = usd !== undefined && usd > 0 ? c / usd : NaN
    if (agrees || (ratio >= USDJPY_MIN && ratio <= USDJPY_MAX)) return c
  }
  return undefined
}

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

async function oneOk(ep: Endpoint): Promise<number | undefined> {
  try {
    return ep.parse(await fetchJson(ep.url))
  } catch {
    return undefined
  }
}

/** All endpoints at once; the prices that came back, in list order. */
async function allOk(list: Endpoint[]): Promise<number[]> {
  const got = await Promise.all(list.map(oneOk))
  return got.filter((v): v is number => v !== undefined)
}

/** A price older than this is no longer shown: screens stop converting with it. */
const STALE_MS = 10 * 60_000

export function createRatesSource(): RatesSource {
  // Per currency: last successfully fetched price and when it was fetched.
  // A failed fetch never refreshes these timestamps.
  const last: Partial<Record<Currency, { price: number; at: number }>> = {}
  let checkedAt = 0
  let inflight: Promise<void> | undefined

  /** This round's USD price, else the last one if still fresh. Only for checking JPY. */
  function usdForCheck(usd: number | undefined, now: number): number | undefined {
    if (usd !== undefined) return usd
    const prev = last.USD
    return prev && now - prev.at <= STALE_MS ? prev.price : undefined
  }

  async function load(): Promise<void> {
    // Every currency every time, whichever one the user trades: the exchanges
    // asked must not reveal the trade currency.
    const [KRW, USD, jpyCands] = await Promise.all([firstOk(KRW_ENDPOINTS), firstOk(USD_ENDPOINTS), allOk(JPY_ENDPOINTS)])
    const usd = usdForCheck(USD, Date.now())
    let JPY = pickConfirmed(jpyCands, usd)
    if (JPY === undefined) {
      const tiebreak = await oneOk(JPY_TIEBREAK)
      if (tiebreak !== undefined) JPY = pickConfirmed([...jpyCands, tiebreak], usd)
    }
    const now = Date.now()
    if (KRW !== undefined) last.KRW = { price: KRW, at: now }
    if (USD !== undefined) last.USD = { price: USD, at: now }
    // Unconfirmed JPY leaves the last confirmed price; snapshot() drops it when stale.
    if (JPY !== undefined) last.JPY = { price: JPY, at: now }
    checkedAt = now
  }

  /** Only currencies whose last success is fresh. `at` is the oldest included success. */
  function snapshot(): Rates {
    const now = Date.now()
    const out: Rates = {}
    let oldest: number | undefined
    for (const c of CURRENCIES) {
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
