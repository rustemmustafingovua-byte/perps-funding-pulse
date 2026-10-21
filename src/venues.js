/**
 * Источники данных по перпетуалам — только публичные API, без ключей.
 *
 * Каждая площадка отдаёт: ставку фандинга, время следующего тика и открытый
 * интерес. Мы нормализуем всё в единый формат и считаем перекос лонг/шорт.
 */

const TIMEOUT = 12000

async function getJson(url, headers = {}) {
  const res = await fetch(url, { headers, signal: AbortSignal.timeout(TIMEOUT) })
  if (!res.ok) throw new Error(`${url} → HTTP ${res.status}`)
  return res.json()
}

/** Binance USDⓈ-M: funding rate + next tick + open interest. */
async function binance(market) {
  const symbol = market.replace("/", "").replace("-", "").toUpperCase()
  const [premium, oi] = await Promise.all([
    getJson(`https://fapi.binance.com/fapi/v1/premiumIndex?symbol=${symbol}`),
    getJson(`https://fapi.binance.com/fapi/v1/openInterest?symbol=${symbol}`).catch(() => null),
  ])
  return {
    funding_rate: Number(premium.lastFundingRate),
    time_to_next: Math.max(0, Math.floor((Number(premium.nextFundingTime) - Date.now()) / 1000)),
    open_interest: oi ? Number(oi.openInterest) : null,
    mark_price: Number(premium.markPrice),
    skew: null,
  }
}

/** Bybit linear: funding + OI + long/short ratio. */
async function bybit(market) {
  const symbol = market.replace("/", "").replace("-", "").toUpperCase()
  const t = await getJson(
    `https://api.bybit.com/v5/market/tickers?category=linear&symbol=${symbol}`,
  )
  const row = t?.result?.list?.[0]
  if (!row) throw new Error(`bybit: нет ${symbol}`)
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

/** OKX swap: funding + next tick + OI. */
async function okx(market) {
  const instId = market.replace("/", "-").replace("-SWAP", "-SWAP").toUpperCase()
  const [fr, oi] = await Promise.all([
    getJson(`https://www.okx.com/api/v5/public/funding-rate?instId=${instId}`),
    getJson(`https://www.okx.com/api/v5/public/open-interest?instType=SWAP&instId=${instId}`).catch(() => null),
  ])
  const row = fr?.data?.[0]
  if (!row) throw new Error(`okx: нет ${instId}`)
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

/** Данные по всем площадкам и рынкам. Ошибка одной площадки не роняет остальные. */
export async function fundingPulse({ venue_ids = Object.keys(VENUES), markets } = {}) {
  const requested = venue_ids ?? Object.keys(VENUES)
  const out = []
  for (const venue of requested) {
    const spec = VENUES[venue]
    if (!spec) {
      out.push({ venue, market: null, ok: false, error: `unknown venue "${venue}"` })
      continue
    }
    const list = markets?.length ? markets : spec.markets
    const rows = await Promise.all(
      list.map(async (market) => {
        try {
          const data = await spec.fn(market)
          return { venue, market, ...data, ok: true }
        } catch (e) {
          return { venue, market, ok: false, error: e?.message ?? String(e) }
        }
      }),
    )
    out.push(...rows)
  }
  return out
}
