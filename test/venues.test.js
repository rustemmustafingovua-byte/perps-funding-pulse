import { test } from "node:test"
import assert from "node:assert/strict"
import { VENUES, fundingPulse } from "../src/venues.js"

test("три площадки доступны", () => {
  assert.ok(VENUES.binance && VENUES.bybit && VENUES.okx)
})

test("нормализация ответа: все поля присутствуют", async () => {
  const rows = await fundingPulse({ venue_ids: ["binance"], markets: ["BTC/USDT"] })
  assert.equal(rows.length, 1)
  const r = rows[0]
  assert.equal(r.venue, "binance")
  assert.equal(r.market, "BTC/USDT")
  if (r.ok) {
    assert.equal(typeof r.funding_rate, "number")
    assert.equal(typeof r.time_to_next, "number")
    assert.ok(r.time_to_next >= 0)
    assert.ok(r.open_interest === null || r.open_interest > 0)
  } else {
    assert.ok(r.error)
  }
})

test("ошибка одной площадки не роняет остальные", async () => {
  const rows = await fundingPulse({ venue_ids: ["binance", "нет-такой"], markets: ["BTC/USDT"] })
  assert.equal(rows.length, 2)
  const bad = rows.find((r) => r.venue === "нет-такой")
  assert.equal(bad.ok, false)
})
