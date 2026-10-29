import { test } from "node:test"
import assert from "node:assert/strict"
import { VENUES, fundingPulse, venueSymbol } from "../src/venues.js"

test("three venues are available", () => {
  assert.ok(VENUES.binance && VENUES.bybit && VENUES.okx)
})

test("the same market string is normalized per venue", () => {
  assert.equal(venueSymbol("binance", "BTC/USDT"), "BTCUSDT")
  assert.equal(venueSymbol("bybit", "btc-usdt-swap"), "BTCUSDT")
  assert.equal(venueSymbol("okx", "BTC/USDT"), "BTC-USDT-SWAP")
  assert.equal(venueSymbol("okx", "ETH-USDT-SWAP"), "ETH-USDT-SWAP")
})

test("venue payloads normalize to one schema", async () => {
  const next = Date.now() + 60_000
  const urls = []
  const fetchImpl = async (url) => {
    const target = String(url)
    urls.push(target)
    if (target.includes("premiumIndex")) {
      return Response.json({ lastFundingRate: "0.0001", nextFundingTime: next, markPrice: "60000" })
    }
    if (target.includes("fapi.binance.com") && target.includes("openInterest")) {
      return Response.json({ openInterest: "15" })
    }
    if (target.includes("bybit.com")) {
      return Response.json({
        result: {
          list: [{
            fundingRate: "0.0002",
            nextFundingTime: next,
            openInterest: "8",
            markPrice: "60010",
            longShortRatio: "1.5",
          }],
        },
      })
    }
    if (target.includes("funding-rate")) {
      return Response.json({ data: [{ fundingRate: "0.0003", nextFundingTime: String(next) }] })
    }
    if (target.includes("open-interest")) return Response.json({ data: [{ oiCcy: "3.5" }] })
    throw new Error(target)
  }

  const rows = await fundingPulse({
    venue_ids: ["binance", "bybit", "okx"],
    markets: ["BTC/USDT"],
    fetchImpl,
  })
  assert.equal(rows.length, 3)
  assert.equal(rows[0].ok, true)
  assert.equal(rows[0].funding_rate, 0.0001)
  assert.equal(rows[0].open_interest, 15)
  assert.equal(rows[0].mark_price, 60000)
  assert.ok(rows[0].time_to_next >= 0)
  assert.equal(rows[1].funding_rate, 0.0002)
  assert.equal(rows[1].skew, Number((1.5 / 2.5).toFixed(4)))
  assert.equal(rows[2].funding_rate, 0.0003)
  assert.equal(rows[2].open_interest, 3.5)
  assert.ok(urls.some((url) => url.includes("symbol=BTCUSDT")))
  assert.ok(urls.some((url) => url.includes("instId=BTC-USDT-SWAP")))
})

test("one venue failing does not drop the rest", async () => {
  const fetchImpl = async (url) => {
    if (String(url).includes("binance")) return new Response("no", { status: 503 })
    throw new Error(`unexpected ${url}`)
  }
  const rows = await fundingPulse({ venue_ids: ["binance", "missing"], markets: ["BTC/USDT"], fetchImpl })
  assert.equal(rows.length, 2)
  assert.equal(rows[0].ok, false)
  assert.match(rows[0].error, /HTTP 503/)
  assert.equal(rows[1].ok, false)
  assert.match(rows[1].error, /unknown venue/)
})

test("live Binance BTC/USDT funding", { skip: !process.env.LIVE_SMOKE }, async () => {
  const rows = await fundingPulse({ venue_ids: ["binance"], markets: ["BTC/USDT"] })
  assert.equal(rows[0].ok, true)
  assert.equal(typeof rows[0].funding_rate, "number")
  assert.ok(rows[0].time_to_next >= 0)
})
