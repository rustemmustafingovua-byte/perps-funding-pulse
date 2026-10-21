import { test } from "node:test"
import assert from "node:assert/strict"
import { verifyPayment, paymentTerms, USDC_BASE, PAY_TO } from "../src/x402.js"

test("условия оплаты содержат USDC и ETH на Base", async () => {
  const t = await paymentTerms(0.001)
  assert.equal(t.x402Version, 2)
  const assets = t.accepts.map((a) => a.asset)
  assert.ok(assets.includes(USDC_BASE))
  assert.ok(assets.includes("ETH"))
  for (const a of t.accepts) {
    assert.equal(a.network, "eip155:8453")
    assert.equal(a.payTo, PAY_TO)
    assert.ok(BigInt(a.amount) > 0n)
  }
})

test("битый хеш не проходит проверку", async () => {
  const v = await verifyPayment("0xdeadbeef", { priceUsd: 0.001 })
  assert.equal(v.ok, false)
})

test("несуществующая транзакция не проходит проверку", async () => {
  const v = await verifyPayment("0x" + "11".repeat(32), { priceUsd: 0.001 })
  assert.equal(v.ok, false)
})
