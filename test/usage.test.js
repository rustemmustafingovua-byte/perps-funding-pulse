import { test } from "node:test"
import assert from "node:assert/strict"
import { recordUsage, usageFor, ipUsageFor, billingSummary } from "../src/usage.js"

test("recordUsage increments key and ip counts", () => {
  recordUsage({ keyId: "k1", ip: "1.2.3.4", usdSpent: 0.001 })
  recordUsage({ keyId: "k1", ip: "1.2.3.4", usdSpent: 0.002 })
  assert.equal(usageFor("k1").count, 2)
  assert.equal(usageFor("k1").usdSpent, 0.003)
  assert.equal(ipUsageFor("1.2.3.4").count, 2)
})

test("usageFor returns zeros for unknown id", () => {
  const u = usageFor("nope")
  assert.equal(u.count, 0)
  assert.equal(u.usdSpent, 0)
})

test("ipUsageFor returns zeros for unknown ip", () => {
  const u = ipUsageFor("0.0.0.0")
  assert.equal(u.count, 0)
})

test("billingSummary aggregates totals", () => {
  recordUsage({ keyId: "k2", usdSpent: 0.005 })
  const s = billingSummary()
  assert.ok(s.totalRequests > 0)
  assert.ok(s.totalUsd >= 0.005)
  assert.ok(s.keys.some((k) => k.id === "k2"))
})
