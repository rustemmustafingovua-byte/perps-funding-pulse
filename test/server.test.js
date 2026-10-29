import { test } from "node:test"
import assert from "node:assert/strict"
import { mkdtempSync } from "node:fs"
import { request as httpRequest } from "node:http"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts"
import { createApp } from "../src/server.js"
import { USDC_BASE, ethAmountWei, payToAddress } from "../src/x402.js"
import { hasPayment, resetStore } from "../src/store.js"
import { __shiftQuotaWindow, paidQuotaId } from "../src/usage.js"

const TRANSFER_TOPIC = "0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef"

function word(value) {
  return `0x${BigInt(value).toString(16).padStart(64, "0")}`
}

function topicAddress(address) {
  return `0x${address.toLowerCase().slice(2).padStart(64, "0")}`
}

function call(port, { method = "GET", path = "/", headers = {}, body }) {
  return new Promise((resolve, reject) => {
    const req = httpRequest({
      hostname: "127.0.0.1",
      port,
      method,
      path,
      headers,
    }, (res) => {
      const chunks = []
      res.on("data", (chunk) => chunks.push(chunk))
      res.on("end", () => {
        const text = Buffer.concat(chunks).toString()
        let json = null
        try {
          json = text ? JSON.parse(text) : null
        } catch {
          json = null
        }
        resolve({ status: res.statusCode, headers: res.headers, json, text })
      })
    })
    req.on("error", reject)
    if (body) req.end(body)
    else req.end()
  })
}

function listen(server) {
  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => resolve(server.address().port))
  })
}

function close(server) {
  return new Promise((resolve) => server.close(resolve))
}

test("funding API charges per call and survives a restart", async () => {
  const saved = {
    X402_PAY_TO: process.env.X402_PAY_TO,
    DATA_FILE: process.env.DATA_FILE,
    NODE_ENV: process.env.NODE_ENV,
  }
  const originalFetch = globalThis.fetch
  let server
  const scene = { tx: null, receipt: null, block: null }
  const calls = { settle: 0, dashboard: 0 }
  let hashSeq = 0
  const nextHash = () => {
    hashSeq += 1
    return `0x${hashSeq.toString(16).padStart(64, "0")}`
  }

  const armUsdc = (amount, hash = nextHash()) => {
    const payTo = payToAddress()
    scene.tx = { hash, from: "0x2222222222222222222222222222222222222222", to: USDC_BASE, value: "0x0", blockNumber: "0x10" }
    scene.receipt = {
      status: "0x1",
      blockNumber: "0x10",
      logs: [{
        address: USDC_BASE,
        topics: [TRANSFER_TOPIC, topicAddress(scene.tx.from), topicAddress(payTo)],
        data: word(amount),
      }],
    }
    scene.block = { timestamp: `0x${Math.floor(Date.now() / 1000).toString(16)}` }
    return hash
  }

  try {
    resetStore()
    delete process.env.DATA_FILE
    process.env.X402_PAY_TO = "0x1111111111111111111111111111111111111111"
    process.env.ETH_USD_PRICE = "3000"
    process.env.PRICE_USD = "0.001"
    process.env.FREE_LIMIT = "1"
    process.env.PAID_LIMIT = "1"
    process.env.ENTERPRISE_LIMIT = "2"
    process.env.FUNDING_RPM = "1000"
    process.env.TRUST_PROXY = "1"
    process.env.ADMIN_TOKEN = "test-admin-token"
    process.env.PAYMENT_MAX_AGE_SECONDS = "900"
    process.env.DASHBOARD_WEBHOOK_URL = "http://dashboard.test"
    process.env.NODE_ENV = "test"
    delete process.env.X402_FACILITATOR_URL

    globalThis.fetch = async (url, opts = {}) => {
      const target = String(url)
      if (opts.body) {
        try {
          const payload = JSON.parse(opts.body)
          if (payload.method === "eth_getTransactionByHash") return Response.json({ result: scene.tx })
          if (payload.method === "eth_getTransactionReceipt") return Response.json({ result: scene.receipt })
          if (payload.method === "eth_getBlockByNumber") return Response.json({ result: scene.block })
        } catch {
          // not an RPC body
        }
      }
      if (target.includes("premiumIndex")) {
        return Response.json({ lastFundingRate: "0.0001", nextFundingTime: Date.now() + 60_000, markPrice: "60000" })
      }
      if (target.includes("fapi.binance.com") && target.includes("openInterest")) {
        return Response.json({ openInterest: "15" })
      }
      if (target.includes("/webhook/perps-funding-pulse")) {
        calls.dashboard += 1
        return new Response(null, { status: 204 })
      }
      if (target.endsWith("/verify")) return Response.json({ isValid: true, payer: "0x2222222222222222222222222222222222222222" })
      if (target.endsWith("/settle")) {
        calls.settle += 1
        return Response.json({
          success: true,
          transaction: `0x${"ab".repeat(32)}`,
          network: "eip155:8453",
          payer: "0x2222222222222222222222222222222222222222",
        })
      }
      if (target.includes("example.com")) return new Response(null, { status: 204 })
      throw new Error(`unexpected fetch ${target}`)
    }

    server = createApp()
    const port = await listen(server)
    const funding = (ip, extra = {}) => call(port, {
      method: "POST",
      path: "/funding",
      headers: {
        "content-type": "application/json",
        "x-forwarded-for": ip,
        ...(extra.headers || {}),
      },
      body: JSON.stringify(extra.body ?? { venue_ids: ["binance"], markets: ["BTC/USDT"] }),
    })

    const health = await call(port, { path: "/health" })
    assert.equal(health.status, 200)
    assert.equal(health.json.status, "ok")
    assert.equal(health.json.pay_to, payToAddress())
    assert.equal(health.json.payee_configured, true)
    assert.equal(health.json.facilitator_configured, false)
    assert.equal(health.json.price_usd, 0.001)
    assert.equal(health.json.network, "eip155:8453")
    assert.notEqual(health.json.pay_to, "0x8aC6a229f254980CCd3Dd35CF5E1B7c08880B40E")

    const options = await call(port, { method: "OPTIONS", path: "/funding" })
    assert.equal(options.status, 204)
    assert.match(options.headers["access-control-allow-headers"], /payment-signature/)

    const missing = await call(port, { path: "/nope" })
    assert.equal(missing.status, 404)

    const free = await funding("203.0.113.10")
    assert.equal(free.status, 200)
    assert.equal(free.json.payment.via, "free")
    assert.equal(free.json.results[0].ok, true)
    assert.equal(free.json.results[0].funding_rate, 0.0001)
    assert.equal(free.json.results[0].open_interest, 15)
    assert.equal(calls.dashboard, 1)

    const gated = await funding("203.0.113.10")
    assert.equal(gated.status, 402)
    const terms = JSON.parse(Buffer.from(gated.headers["payment-required"], "base64").toString())
    assert.equal(terms.x402Version, 2)
    assert.equal(terms.accepts[0].payTo, payToAddress())
    assert.equal(terms.accepts[0].asset, USDC_BASE)
    assert.equal(terms.accepts[0].amount, "1000")
    assert.equal(terms.accepts[0].network, "eip155:8453")

    const tx = armUsdc(1000n)
    const paid = await funding("203.0.113.10", { headers: { "x-payment-tx": tx } })
    assert.equal(paid.status, 200)
    assert.equal(paid.json.payment.via, "direct")
    assert.equal(paid.json.payment.asset, "USDC")
    assert.equal(paid.json.payment.amount_usd, 0.001)
    assert.equal(paid.json.results[0].market, "BTC/USDT")
    const settlement = JSON.parse(Buffer.from(paid.headers["payment-response"], "base64").toString())
    assert.equal(settlement.success, true)
    assert.equal(settlement.transaction, tx)

    const replay = await funding("203.0.113.11", { headers: { "x-payment-tx": tx } })
    assert.equal(replay.status, 402)
    assert.equal(replay.json.reason, "payment already used")

    const secondTx = armUsdc(1000n)
    const capped = await funding("203.0.113.10", { headers: { "x-payment-tx": secondTx } })
    assert.equal(capped.status, 429)
    assert.equal(hasPayment(secondTx), false)
    __shiftQuotaWindow(paidQuotaId(null, "203.0.113.10"), -3_600_001)
    const afterWindow = await funding("203.0.113.10", { headers: { "x-payment-tx": secondTx } })
    assert.equal(afterWindow.status, 200)

    const forged = await funding("203.0.113.12", { headers: { "x-api-key": "pfp_0123456789abcdef_not-the-secret" } })
    assert.equal(forged.status, 401)

    const keyRes = await call(port, {
      method: "POST",
      path: "/keys",
      headers: { "content-type": "application/json", "x-forwarded-for": "203.0.113.20" },
      body: JSON.stringify({ owner: "alice", tier: "free" }),
    })
    assert.equal(keyRes.status, 201)
    const secret = keyRes.json.key.key
    const withKey = await funding("203.0.113.21", { headers: { "x-api-key": secret } })
    assert.equal(withKey.status, 200)
    assert.equal(withKey.json.payment.via, "free")
    const keyExhausted = await funding("203.0.113.22", { headers: { "x-api-key": secret } })
    assert.equal(keyExhausted.status, 402)

    const upgrade = await call(port, {
      method: "POST",
      path: "/keys",
      headers: { "content-type": "application/json", "x-forwarded-for": "203.0.113.23" },
      body: JSON.stringify({ owner: "alice", tier: "enterprise" }),
    })
    assert.equal(upgrade.status, 401)
    const issued = await call(port, {
      method: "POST",
      path: "/keys",
      headers: {
        "content-type": "application/json",
        "x-forwarded-for": "203.0.113.24",
        "x-admin-token": "test-admin-token",
      },
      body: JSON.stringify({ owner: "desk", tier: "enterprise" }),
    })
    assert.equal(issued.status, 201)
    assert.equal(issued.json.key.tier, "enterprise")
    const invoiced = await funding("203.0.113.25", { headers: { "x-api-key": issued.json.key.key } })
    assert.equal(invoiced.status, 200)
    assert.equal(invoiced.json.payment.via, "enterprise")

    const paidKey = await call(port, {
      method: "POST",
      path: "/keys",
      headers: {
        "content-type": "application/json",
        "x-forwarded-for": "203.0.113.26",
        "x-admin-token": "test-admin-token",
      },
      body: JSON.stringify({ owner: "desk", tier: "paid" }),
    })
    const paidTier = await funding("203.0.113.27", { headers: { "x-api-key": paidKey.json.key.key } })
    assert.equal(paidTier.status, 402)

    const hidden = await call(port, { path: "/keys" })
    assert.equal(hidden.status, 401)
    const listed = await call(port, { path: "/keys", headers: { "x-admin-token": "test-admin-token" } })
    assert.equal(listed.status, 200)
    assert.ok(listed.json.keys.every((row) => row.key === undefined))
    const usage = await call(port, { path: "/usage", headers: { "x-admin-token": "test-admin-token" } })
    assert.equal(usage.status, 200)
    assert.ok(usage.json.usage.totalUsd >= 0.001)

    const hookDenied = await call(port, {
      method: "POST",
      path: "/webhooks",
      headers: { "content-type": "application/json", "x-api-key": secret },
      body: JSON.stringify({ url: "http://169.254.169.254/latest" }),
    })
    assert.equal(hookDenied.status, 400)
    const hook = await call(port, {
      method: "POST",
      path: "/webhooks",
      headers: { "content-type": "application/json", "x-api-key": secret },
      body: JSON.stringify({ url: "https://example.com/alert", threshold_pct: 0.0001 }),
    })
    assert.equal(hook.status, 201)

    const mcpFree = await call(port, {
      method: "POST",
      path: "/mcp",
      headers: { "content-type": "application/json", "x-forwarded-for": "203.0.113.40" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "ping" }),
    })
    assert.equal(mcpFree.status, 200)
    assert.deepEqual(mcpFree.json.result, {})
    const mcpGated = await call(port, {
      method: "POST",
      path: "/mcp",
      headers: { "content-type": "application/json", "x-forwarded-for": "203.0.113.40" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 2, method: "ping" }),
    })
    assert.equal(mcpGated.status, 402)

    const mcpTx = armUsdc(1000n)
    const mcpPaid = await call(port, {
      method: "POST",
      path: "/mcp/paid",
      headers: { "content-type": "application/json", "x-forwarded-for": "203.0.113.41", "x-payment-tx": mcpTx },
      body: JSON.stringify({ jsonrpc: "2.0", id: 3, method: "ping" }),
    })
    assert.equal(mcpPaid.status, 200)
    assert.deepEqual(mcpPaid.json.result, {})
    const mcpReplay = await call(port, {
      method: "POST",
      path: "/mcp/paid",
      headers: { "content-type": "application/json", "x-forwarded-for": "203.0.113.42", "x-payment-tx": mcpTx },
      body: JSON.stringify({ jsonrpc: "2.0", id: 4, method: "ping" }),
    })
    assert.equal(mcpReplay.status, 402)

    process.env.X402_FACILITATOR_URL = "http://facilitator.test/x402"
    const account = privateKeyToAccount(generatePrivateKey())
    const nonce = `0x${Buffer.from(crypto.getRandomValues(new Uint8Array(32))).toString("hex")}`
    const validBefore = BigInt(Math.floor(Date.now() / 1000) + 300)
    const payTo = payToAddress()
    const signature = await account.signTypedData({
      domain: { name: "USD Coin", version: "2", chainId: 8453, verifyingContract: USDC_BASE },
      types: {
        TransferWithAuthorization: [
          { name: "from", type: "address" },
          { name: "to", type: "address" },
          { name: "value", type: "uint256" },
          { name: "validAfter", type: "uint256" },
          { name: "validBefore", type: "uint256" },
          { name: "nonce", type: "bytes32" },
        ],
      },
      primaryType: "TransferWithAuthorization",
      message: { from: account.address, to: payTo, value: 1000n, validAfter: 0n, validBefore, nonce },
    })
    const header = Buffer.from(JSON.stringify({
      x402Version: 2,
      accepted: {
        scheme: "exact",
        network: "eip155:8453",
        amount: "1000",
        asset: USDC_BASE,
        payTo,
        maxTimeoutSeconds: 300,
        extra: { name: "USD Coin", version: "2" },
      },
      payload: {
        signature,
        authorization: {
          from: account.address,
          to: payTo,
          value: "1000",
          validAfter: "0",
          validBefore: validBefore.toString(),
          nonce,
        },
      },
    })).toString("base64")
    const signed = await funding("203.0.113.50", { headers: { "payment-signature": header } })
    assert.equal(signed.status, 200)
    assert.equal(signed.json.payment.via, "x402")
    assert.equal(calls.settle, 1)
    const signedReplay = await funding("203.0.113.51", { headers: { "payment-signature": header } })
    assert.equal(signedReplay.status, 402)
    assert.equal(calls.settle, 1)

    delete process.env.X402_PAY_TO
    const degraded = await call(port, { path: "/health" })
    assert.equal(degraded.json.status, "degraded")
    assert.equal(degraded.json.pay_to, null)
    const stillFree = await funding("203.0.113.60")
    assert.equal(stillFree.status, 200)
    const unpaid = await funding("203.0.113.60")
    assert.equal(unpaid.status, 503)
    assert.equal(unpaid.json.error, "payee_not_configured")
    process.env.X402_PAY_TO = "0x1111111111111111111111111111111111111111"

    await close(server)
    server = null
    const dir = mkdtempSync(join(tmpdir(), "pfp-"))
    const file = join(dir, "state.json")
    resetStore()
    process.env.DATA_FILE = file
    process.env.PAID_LIMIT = "5"
    server = createApp()
    const port2 = await listen(server)
    const kept = armUsdc(1000n, nextHash())
    const firstBoot = await call(port2, {
      method: "POST",
      path: "/funding",
      headers: {
        "content-type": "application/json",
        "x-forwarded-for": "203.0.113.70",
        "x-payment-tx": kept,
      },
      body: JSON.stringify({ venue_ids: ["binance"], markets: ["BTC/USDT"] }),
    })
    // The IP still has a free call on the fresh store, so pay explicitly by exhausting it first.
    assert.equal(firstBoot.status, 200)
    const spentFree = firstBoot.json.payment.via === "free"
    const purchased = spentFree
      ? await call(port2, {
        method: "POST",
        path: "/funding",
        headers: {
          "content-type": "application/json",
          "x-forwarded-for": "203.0.113.70",
          "x-payment-tx": kept,
        },
        body: JSON.stringify({ venue_ids: ["binance"], markets: ["BTC/USDT"] }),
      })
      : firstBoot
    assert.equal(purchased.status, 200)
    assert.equal(purchased.json.payment.via, "direct")
    assert.equal(hasPayment(kept), true)

    await close(server)
    server = null
    resetStore()
    server = createApp()
    const port3 = await listen(server)
    const afterRestart = await call(port3, {
      method: "POST",
      path: "/funding",
      headers: {
        "content-type": "application/json",
        "x-forwarded-for": "203.0.113.71",
        "x-payment-tx": kept,
      },
      body: JSON.stringify({ venue_ids: ["binance"], markets: ["BTC/USDT"] }),
    })
    assert.equal(afterRestart.status, 402)
    assert.equal(afterRestart.json.reason, "payment already used")
    assert.ok(ethAmountWei(0.001, 3000) > 0n)
  } finally {
    if (server) await close(server)
    globalThis.fetch = originalFetch
    resetStore()
    for (const [key, value] of Object.entries(saved)) {
      if (value == null) delete process.env[key]
      else process.env[key] = value
    }
  }
})
