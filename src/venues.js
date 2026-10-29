/**
 * Public perpetual-futures market data. No venue API key is required.
 * One venue failing does not drop the others.
 */

const TIMEOUT_MS = 12_000

export function venueSymbol(venue, market) {
  const stripped = String(market ?? "").trim().toUpperCase().replace(/-SWAP$/, "")
  const parts = stripped.split(/[/\s_-]+/).filter(Boolean)
  const symbol = venue === "okx"
    ? (parts.length >= 2 ? `${parts[0]}-${parts[1]}-SWAP` : `${stripped}-SWAP`)
    : (parts.length >= 2 ? `${parts[0]}${parts[1]}` : stripped.replace(/[^A-Z0-9]/g, ""))
  if (!/^[A-Z0-9-]{2,40}$/.test(symbol)) {
    throw new Error(`invalid market "${market}"`)
  }
  return symbol
}

async function getJson(url, fetchImpl) {
  const res = await fetchImpl(url, {
    headers: { accept: "application/json", "user-agent": "perps-funding-pulse" },
    signal: AbortSignal.timeout(TIMEOUT_MS),
  })
  if (!res.ok) throw new Error(`${url} → HTTP ${res.status}`)
  return res.json()
}

async function binance(market, fetchImpl) {
  const symbol = venueSymbol("binance", market)
  const [premium, oi] = await Promise.all([
    getJson(`https://fapi.binance.com/fapi/v1/premiumIndex?symbol=${symbol}`, fetchImpl),
    getJson(`https://fapi.binance.com/fapi/v1/openInterest?symbol=${symbol}`, fetchImpl).catch(() => null),
  ])
  return {
    funding_rate: Number(premium.lastFundingRate),
    time_to_next: Math.max(0, Math.floor((Number(premium.nextFundingTime) - Date.now()) / 1000)),
    open_interest: oi ? Number(oi.openInterest) : null,
    mark_price: Number(premium.markPrice),
    skew: null,
  }
}

async function bybit(market, fetchImpl) {
  const symbol = venueSymbol("bybit", market)
  const body = await getJson(
    `https://api.bybit.com/v5/market/tickers?category=linear&symbol=${symbol}`,
    fetchImpl,
  )
  const row = body?.result?.list?.[0]
  if (!row) throw new Error(`bybit: no ${symbol}`)
  const ratio = Number(row.longShortRatio ?? 0)
  return {
    funding_rate: Number(row.fundingRate),
    time_to_next: Math.max(0, Math.floor((Number(row.nextFundingTime) - Date.now()) / 1000)),
    open_interest: Number(row.openInterest ?? 0),
    mark_price: Number(row.markPrice ?? 0),
    skew: ratio ? Number((ratio / (1 + ratio)).toFixed(4)) : null,
    long_short_ratio: ratio || null,
  }
}

async function okx(market, fetchImpl) {
  const instId = venueSymbol("okx", market)
  const [funding, oi] = await Promise.all([
    getJson(`https://www.okx.com/api/v5/public/funding-rate?instId=${instId}`, fetchImpl),
    getJson(`https://www.okx.com/api/v5/public/open-interest?instType=SWAP&instId=${instId}`, fetchImpl).catch(() => null),
  ])
  const row = funding?.data?.[0]
  if (!row) throw new Error(`okx: no ${instId}`)
  return {
    funding_rate: Number(row.fundingRate),
    time_to_next: Math.max(0, Math.floor((Number(row.nextFundingTime) - Date.now()) / 1000)),
    open_interest: oi?.data?.[0] ? Number(oi.data[0].oiCcy ?? oi.data[0].oi) : null,
    mark_price: null,
    skew: null,
  }
}

export const VENUES = {
  binance: { name: "Binance", fn: binance, markets: ["BTC/USDT", "ETH/USDT", "SOL/USDT"] },
  bybit: { name: "Bybit", fn: bybit, markets: ["BTC/USDT", "ETH/USDT", "SOL/USDT"] },
  okx: { name: "OKX", fn: okx, markets: ["BTC-USDT-SWAP", "ETH-USDT-SWAP"] },
}

/** Live funding, time to the next tick, open interest, and skew. */
export async function fundingPulse({ venue_ids = Object.keys(VENUES), markets, fetchImpl = globalThis.fetch } = {}) {
  const requested = venue_ids ?? Object.keys(VENUES)
  const out = []
  for (const venue of requested) {
    const spec = VENUES[venue]
    if (!spec) {
      out.push({ venue, market: null, ok: false, error: `unknown venue "${venue}"` })
      continue
    }
    const list = markets?.length ? markets : spec.markets
    const rows = await Promise.all(list.map(async (market) => {
      try {
        const data = await spec.fn(market, fetchImpl)
        return { venue, market, ...data, ok: true }
      } catch (error) {
        return { venue, market, ok: false, error: error?.message ?? String(error) }
      }
    }))
    out.push(...rows)
  }
  return out
}
