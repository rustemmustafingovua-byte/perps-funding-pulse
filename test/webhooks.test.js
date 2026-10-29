import { test } from "node:test"
import assert from "node:assert/strict"
import { registerWebhook, unregisterWebhook, getWebhook, checkWebhooks, updateWebhook, __clearWebhooks } from "../src/webhooks.js"

delete process.env.DATA_FILE

test("registerWebhook creates webhook with defaults", () => {
  __clearWebhooks()
  const rec = registerWebhook({ url: "https://example.com/hook", thresholdPct: 0.02 })
  assert.ok(rec.id)
  assert.equal(rec.url, "https://example.com/hook")
  assert.equal(rec.thresholdPct, 0.02)
  assert.equal(rec.disabled, false)
})

test("unregisterWebhook removes by id", () => {
  __clearWebhooks()
  const rec = registerWebhook({ url: "https://example.com/x" })
  assert.equal(unregisterWebhook(rec.id), true)
  assert.equal(unregisterWebhook(rec.id), false)
  assert.equal(getWebhook(rec.id), null)
})

test("private and local webhook URLs are rejected", () => {
  __clearWebhooks()
  for (const url of [
    "http://127.0.0.1/hook",
    "http://10.1.2.3/hook",
    "http://169.254.169.254/latest",
    "http://localhost/hook",
    "http://metadata.google.internal/",
    "file:///etc/passwd",
  ]) {
    assert.equal(registerWebhook({ url }).error, "invalid_url", url)
  }
  assert.equal(registerWebhook({ url: "https://example.com/ok" }).url, "https://example.com/ok")
})

test("checkWebhooks fires when threshold exceeded", async () => {
  __clearWebhooks()
  const original = globalThis.fetch
  globalThis.fetch = async () => new Response(null, { status: 204 })
  try {
    registerWebhook({ url: "https://example.com/alert", thresholdPct: 0.001 })
    const rows = [{ venue: "binance", market: "BTC/USDT", ok: true, funding_rate: 0.05 }]
    const results = await checkWebhooks(rows)
    assert.equal(results.length, 1)
    assert.equal(results[0].url, "https://example.com/alert")
    assert.equal(results[0].ok, true)
  } finally {
    globalThis.fetch = original
  }
})

test("checkWebhooks skips when threshold not exceeded", async () => {
  __clearWebhooks()
  registerWebhook({ url: "https://example.com/skip", thresholdPct: 0.1 })
  const rows = [{ venue: "binance", market: "BTC/USDT", ok: true, funding_rate: 0.001 }]
  const results = await checkWebhooks(rows)
  assert.equal(results.length, 0)
})

test("checkWebhooks ignores disabled webhooks", async () => {
  __clearWebhooks()
  const rec = registerWebhook({ url: "https://example.com/off", thresholdPct: 0.001 })
  updateWebhook(rec.id, { disabled: true })
  const rows = [{ venue: "binance", market: "BTC/USDT", ok: true, funding_rate: 0.05 }]
  const results = await checkWebhooks(rows)
  assert.equal(results.length, 0)
})
