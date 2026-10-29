/**
 * perps-funding-pulse
 *
 *   GET    /health          free status
 *   POST   /funding         free hourly preview, then USDC or ETH per call on Base
 *   POST   /mcp             free MCP preview
 *   POST   /mcp/paid        MCP settled with x402 on every call
 *   POST   /keys            create a free key; paid and enterprise need X-Admin-Token
 *   GET    /keys            admin: key metadata, never secrets
 *   DELETE /keys/:id        the key holder or an admin
 *   GET    /usage           admin billing summary
 *   POST   /webhooks        API key required; public URLs only
 *   GET    /webhooks
 *   DELETE /webhooks/:id
 */
import { createServer } from "node:http"
import { pathToFileURL } from "node:url"
import { fundingPulse, VENUES } from "./venues.js"
import { acceptPayment, facilitatorUrl, payToAddress, paymentTerms } from "./x402.js"
import { handleMcp, handlePaidMcp, freeTier } from "./mcp.js"
import { createKey, revokeKey, listKeys, validateKey } from "./keys.js"
import {
  billingSummary,
  enterpriseQuotaId,
  freeQuotaId,
  ipUsageFor,
  paidQuotaId,
  peekQuota,
  recordUsage,
  tryConsume,
  usageFor,
} from "./usage.js"
import { checkWebhooks, listWebhooks, registerWebhook, unregisterWebhook } from "./webhooks.js"
import { initStore } from "./store.js"
import { safeEqual } from "./secret.js"
import {
  VERSION,
  enterpriseLimit,
  freeLimit,
  fundingRpm,
  paidLimit,
  port,
  priceUsd,
} from "./config.js"

const BODY_LIMIT = 65_536
const fundingHits = new Map()

function json(res, status, body, headers = {}) {
  const payload = JSON.stringify(body)
  res.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "cache-control": "no-store",
    "access-control-allow-origin": "*",
    "access-control-expose-headers": "payment-required, payment-response",
    ...headers,
  })
  res.end(payload)
}

function clientIp(req) {
  if (process.env.TRUST_PROXY === "1") {
    const forwarded = req.headers["x-forwarded-for"]
    const first = Array.isArray(forwarded) ? forwarded[0] : forwarded
    if (first) return String(first).split(",")[0].trim()
  }
  return req.socket.remoteAddress || "unknown"
}

function headerOne(req, name) {
  const value = req.headers[name]
  if (Array.isArray(value)) return value[0] || ""
  return value || ""
}

function adminOk(req) {
  const expected = process.env.ADMIN_TOKEN
  const presented = headerOne(req, "x-admin-token")
  if (!expected || !presented) return false
  return safeEqual(presented, expected)
}

function allowBurst(ip) {
  const now = Date.now()
  const limit = Math.max(1, fundingRpm())
  const list = (fundingHits.get(ip) || []).filter((stamp) => stamp > now - 60_000)
  if (list.length >= limit) {
    fundingHits.set(ip, list)
    return false
  }
  list.push(now)
  fundingHits.set(ip, list)
  if (fundingHits.size > 10_000) {
    for (const [key, stamps] of fundingHits) {
      if (!stamps.some((stamp) => stamp > now - 60_000)) fundingHits.delete(key)
    }
  }
  return true
}

function resourceOf(req, url) {
  const host = req.headers["x-forwarded-host"] || req.headers.host || "localhost"
  const proto = process.env.TRUST_PROXY === "1"
    ? (headerOne(req, "x-forwarded-proto") || "https")
    : "http"
  return {
    url: `${proto}://${host}${url.pathname}`,
    description: "Live perpetual futures funding rates, next funding time, and open interest",
    mimeType: "application/json",
  }
}

async function readJson(req) {
  const declared = Number(req.headers["content-length"] || 0)
  if (declared > BODY_LIMIT) {
    const error = new Error("body_too_large")
    error.code = "BODY_TOO_LARGE"
    throw error
  }
  const chunks = []
  let size = 0
  for await (const chunk of req) {
    size += chunk.length
    if (size > BODY_LIMIT) {
      const error = new Error("body_too_large")
      error.code = "BODY_TOO_LARGE"
      throw error
    }
    chunks.push(chunk)
  }
  const text = Buffer.concat(chunks).toString() || "{}"
  return JSON.parse(text)
}

function stringList(value, max) {
  if (value == null) return undefined
  if (!Array.isArray(value)) {
    const error = new Error("invalid_list")
    error.code = "INVALID_LIST"
    throw error
  }
  return value.slice(0, max).map((item) => {
    if (typeof item !== "string" || item.trim() === "") {
      const error = new Error("invalid_list")
      error.code = "INVALID_LIST"
      throw error
    }
    return item.trim().slice(0, 40)
  })
}

function paymentResponseHeader(outcome) {
  return Buffer.from(JSON.stringify({
    success: true,
    transaction: outcome.tx || "",
    network: "eip155:8453",
    payer: outcome.payer || null,
  })).toString("base64")
}

async function sendPaymentRequired(res, { reason, resource }) {
  try {
    const terms = await paymentTerms(priceUsd(), { resource })
    return json(res, 402, {
      error: "payment_required",
      reason: reason || "payment_required",
      message: `Send ${priceUsd()} USD of USDC or ETH on Base to ${terms.accepts[0].payTo}, then retry with X-PAYMENT-TX. x402 clients retry with PAYMENT-SIGNATURE.`,
      terms,
    }, {
      "payment-required": Buffer.from(JSON.stringify(terms)).toString("base64"),
    })
  } catch (error) {
    if (error?.code === "PAYEE_NOT_CONFIGURED") {
      return json(res, 503, {
        error: "payee_not_configured",
        message: "Set X402_PAY_TO to the Base address that should receive USDC and ETH.",
      })
    }
    throw error
  }
}

function pushDashboardStats(data) {
  const webhook = process.env.DASHBOARD_WEBHOOK_URL
  if (!webhook) return
  const target = `${webhook.replace(/\/$/, "")}/webhook/perps-funding-pulse`
  fetch(target, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(data),
    redirect: "error",
    signal: AbortSignal.timeout(5000),
  }).catch(() => {})
}

async function serveFunding(res, { venueIds, markets, ip, apiKey, payment, usdSpent, extraHeaders = {} }) {
  const rows = await fundingPulse({ venue_ids: venueIds, markets })
  recordUsage({ keyId: apiKey?.id, ip, usdSpent })
  const billed = usageFor(apiKey?.id || `ip:${ip}`)
  const ipUsage = ipUsageFor(ip)
  pushDashboardStats({
    service: "perps-funding-pulse",
    requests: billed.count + (apiKey ? ipUsage.count : 0),
    revenue_usd: billed.usdSpent,
    markets: rows.length,
    ts: new Date().toISOString(),
  })
  const webhooks = await checkWebhooks(rows)
  return json(res, 200, {
    service: "perps-funding-pulse",
    version: VERSION,
    payment,
    results: rows,
    webhooks,
    ts: new Date().toISOString(),
  }, extraHeaders)
}

function callerKey(req) {
  const raw = headerOne(req, "x-api-key")
  if (!raw) return { key: null }
  const key = validateKey(raw)
  if (!key) return { error: true }
  return { key }
}

async function handleFunding(req, res, body, url) {
  const ip = clientIp(req)
  const caller = callerKey(req)
  if (caller.error) return json(res, 401, { error: "invalid_api_key" })
  const apiKey = caller.key
  if (!allowBurst(ip)) return json(res, 429, { error: "rate_limit_exceeded", retry_after_seconds: 60 })

  let venueIds
  let markets
  try {
    venueIds = stringList(body.venue_ids, 10)
    markets = stringList(body.markets, 20)
  } catch {
    return json(res, 400, { error: "invalid_request", message: "venue_ids and markets must be arrays of strings" })
  }

  const resource = resourceOf(req, url)
  const txHash = headerOne(req, "x-payment-tx")
  const signature = headerOne(req, "payment-signature") || headerOne(req, "x-payment")
  const presented = Boolean(txHash || signature)
  const tier = apiKey?.tier || "anonymous"

  if (tier === "enterprise" && !presented) {
    const quota = tryConsume(enterpriseQuotaId(apiKey.id), enterpriseLimit())
    if (!quota.allowed) {
      return json(res, 429, { error: "rate_limit_exceeded", tier, limit: quota.limit, remaining: 0 })
    }
    return serveFunding(res, {
      venueIds,
      markets,
      ip,
      apiKey,
      usdSpent: 0,
      payment: { via: "enterprise", key_id: apiKey.id, tier, remaining: quota.remaining, limit: quota.limit },
    })
  }

  if (!presented && tier !== "paid") {
    const limit = freeLimit()
    const ipId = freeQuotaId(null, ip)
    const keyId = apiKey ? freeQuotaId(apiKey.id, null) : null
    const ipPeek = peekQuota(ipId, limit)
    const keyPeek = keyId ? peekQuota(keyId, limit) : { allowed: true }
    if (ipPeek.allowed && keyPeek.allowed) {
      const ipQuota = tryConsume(ipId, limit)
      const keyQuota = keyId ? tryConsume(keyId, limit) : ipQuota
      if (ipQuota.allowed && keyQuota.allowed) {
        return serveFunding(res, {
          venueIds,
          markets,
          ip,
          apiKey,
          usdSpent: 0,
          payment: {
            via: "free",
            tier: tier === "anonymous" ? "free" : tier,
            ...(apiKey ? { key_id: apiKey.id } : {}),
            remaining: Math.min(ipQuota.remaining, keyQuota.remaining),
            limit,
          },
        })
      }
    }
  }

  if (!presented) return sendPaymentRequired(res, { reason: "payment_required", resource })

  const quotaId = paidQuotaId(apiKey?.id, ip)
  const outcome = await acceptPayment({
    txHash,
    signature,
    priceUsd: priceUsd(),
    resource,
    beforeSettle: async () => {
      const quota = peekQuota(quotaId, paidLimit())
      if (!quota.allowed) {
        return { ok: false, status: 429, reason: "rate_limit_exceeded", limit: quota.limit, remaining: 0 }
      }
      return null
    },
  })
  if (!outcome.ok) {
    if (outcome.status === 429) {
      return json(res, 429, { error: "rate_limit_exceeded", tier: "paid", limit: outcome.limit, remaining: 0 })
    }
    if (outcome.status === 503) return json(res, 503, { error: outcome.reason })
    if (outcome.status === 400) return json(res, 400, { error: "invalid_payment", reason: outcome.reason })
    return sendPaymentRequired(res, { reason: outcome.reason, resource })
  }

  tryConsume(quotaId, paidLimit())
  return serveFunding(res, {
    venueIds,
    markets,
    ip,
    apiKey,
    usdSpent: outcome.amountUsd,
    extraHeaders: { "payment-response": paymentResponseHeader(outcome) },
    payment: {
      via: outcome.via,
      asset: outcome.asset,
      amount_usd: outcome.amountUsd,
      tx: outcome.tx,
      payer: outcome.payer,
      tier: tier === "anonymous" ? "paid" : tier,
      ...(apiKey ? { key_id: apiKey.id } : {}),
    },
  })
}

export function createApp() {
  initStore()
  return createServer(async (req, res) => {
    try {
      res.setHeader("access-control-allow-origin", "*")
      res.setHeader(
        "access-control-allow-headers",
        "content-type, payment-signature, x-payment, x-payment-tx, x-api-key, x-admin-token",
      )
      res.setHeader("access-control-expose-headers", "payment-required, payment-response")
      res.setHeader("access-control-max-age", "600")
      if (req.method === "OPTIONS") {
        res.writeHead(204)
        res.end()
        return
      }

      const url = new URL(req.url || "/", `http://${req.headers.host || "localhost"}`)

      if (req.method === "GET" && url.pathname === "/health") {
        const payTo = payToAddress()
        return json(res, 200, {
          status: payTo ? "ok" : "degraded",
          service: "perps-funding-pulse",
          version: VERSION,
          venues: Object.entries(VENUES).map(([id, venue]) => ({ id, name: venue.name, markets: venue.markets })),
          price_usd: priceUsd(),
          pay_to: payTo,
          payee_configured: Boolean(payTo),
          facilitator_configured: Boolean(facilitatorUrl()),
          network: "eip155:8453",
          chain: "base",
          assets: ["USDC", "ETH"],
          ts: new Date().toISOString(),
        })
      }

      if (req.method === "POST" && url.pathname === "/funding") {
        let body
        try {
          body = await readJson(req)
        } catch (error) {
          if (error?.code === "BODY_TOO_LARGE") return json(res, 413, { error: "body_too_large" })
          return json(res, 400, { error: "invalid_json" })
        }
        if (!body || typeof body !== "object" || Array.isArray(body)) {
          return json(res, 400, { error: "invalid_json" })
        }
        return handleFunding(req, res, body, url)
      }

      if (req.method === "POST" && (url.pathname === "/mcp" || url.pathname === "/mcp/paid")) {
        const ip = clientIp(req)
        if (!allowBurst(ip)) return json(res, 429, { error: "rate_limit_exceeded", retry_after_seconds: 60 })
        let body
        try {
          body = await readJson(req)
        } catch (error) {
          if (error?.code === "BODY_TOO_LARGE") return json(res, 413, { error: "body_too_large" })
          return json(res, 400, { error: "invalid_json" })
        }
        const resource = resourceOf(req, url)
        if (url.pathname === "/mcp/paid") {
          const quotaId = paidQuotaId(null, ip)
          const out = await handlePaidMcp({
            body,
            txHash: headerOne(req, "x-payment-tx"),
            signature: headerOne(req, "payment-signature") || headerOne(req, "x-payment"),
            resource,
            beforeSettle: async () => {
              const quota = peekQuota(quotaId, paidLimit())
              if (!quota.allowed) return { ok: false, status: 429, reason: "rate_limit_exceeded", limit: quota.limit, remaining: 0 }
              return null
            },
          })
          if (out.status === 200) tryConsume(quotaId, paidLimit())
          return json(res, out.status, out.body, out.headers)
        }
        const tier = freeTier(ip)
        if (!tier.allowed) {
          return sendPaymentRequired(res, {
            reason: `free tier exhausted (${freeLimit()}/hour)`,
            resource,
          })
        }
        return json(res, 200, await handleMcp({ body, ip, paid: false }), { "x-free-tier-left": String(tier.left) })
      }

      if (req.method === "POST" && url.pathname === "/keys") {
        let body
        try {
          body = await readJson(req)
        } catch (error) {
          if (error?.code === "BODY_TOO_LARGE") return json(res, 413, { error: "body_too_large" })
          return json(res, 400, { error: "invalid_json" })
        }
        const tier = body?.tier || "free"
        if (!["free", "paid", "enterprise"].includes(tier)) return json(res, 400, { error: "invalid_tier" })
        if (tier !== "free") {
          if (!process.env.ADMIN_TOKEN) return json(res, 503, { error: "admin_not_configured" })
          if (!adminOk(req)) return json(res, 401, { error: "unauthorized" })
        }
        const ip = clientIp(req)
        const quota = tryConsume(`keys:${ip}`, 30)
        if (!quota.allowed) return json(res, 429, { error: "rate_limit_exceeded" })
        if (snapshotLength() >= 10_000) return json(res, 503, { error: "key_capacity" })
        const rec = createKey({ owner: body?.owner || "anonymous", tier })
        return json(res, 201, { key: rec })
      }

      if (req.method === "DELETE" && url.pathname.startsWith("/keys/")) {
        const id = decodeURIComponent(url.pathname.split("/")[2] || "")
        const caller = callerKey(req)
        if (caller.error) return json(res, 401, { error: "invalid_api_key" })
        const owns = caller.key?.id === id
        if (!owns && !adminOk(req)) {
          if (!process.env.ADMIN_TOKEN && !owns) return json(res, 401, { error: "unauthorized" })
          return json(res, 401, { error: "unauthorized" })
        }
        if (!revokeKey(id)) return json(res, 404, { error: "key_not_found" })
        return json(res, 200, { ok: true })
      }

      if (req.method === "GET" && url.pathname === "/keys") {
        if (!process.env.ADMIN_TOKEN) return json(res, 503, { error: "admin_not_configured" })
        if (!adminOk(req)) return json(res, 401, { error: "unauthorized" })
        return json(res, 200, { keys: listKeys() })
      }

      if (req.method === "GET" && url.pathname === "/usage") {
        if (!process.env.ADMIN_TOKEN) return json(res, 503, { error: "admin_not_configured" })
        if (!adminOk(req)) return json(res, 401, { error: "unauthorized" })
        return json(res, 200, { usage: billingSummary() })
      }

      if (req.method === "POST" && url.pathname === "/webhooks") {
        const caller = callerKey(req)
        if (caller.error) return json(res, 401, { error: "invalid_api_key" })
        if (!caller.key) return json(res, 401, { error: "unauthorized", message: "X-API-Key required" })
        let body
        try {
          body = await readJson(req)
        } catch (error) {
          if (error?.code === "BODY_TOO_LARGE") return json(res, 413, { error: "body_too_large" })
          return json(res, 400, { error: "invalid_json" })
        }
        const rec = registerWebhook({
          url: String(body?.url || ""),
          thresholdPct: body?.threshold_pct ?? body?.threshold ?? 0.0001,
          ownerKeyId: caller.key.id,
        })
        if (rec.error) return json(res, 400, { error: rec.error })
        return json(res, 201, { webhook: rec })
      }

      if (req.method === "DELETE" && url.pathname.startsWith("/webhooks/")) {
        const caller = callerKey(req)
        if (caller.error) return json(res, 401, { error: "invalid_api_key" })
        const admin = adminOk(req)
        if (!caller.key && !admin) return json(res, 401, { error: "unauthorized" })
        const id = decodeURIComponent(url.pathname.split("/")[2] || "")
        const ok = unregisterWebhook(id, admin ? undefined : caller.key.id)
        if (!ok) return json(res, 404, { error: "webhook_not_found" })
        return json(res, 200, { ok: true })
      }

      if (req.method === "GET" && url.pathname === "/webhooks") {
        const caller = callerKey(req)
        if (caller.error) return json(res, 401, { error: "invalid_api_key" })
        const admin = adminOk(req)
        if (!caller.key && !admin) return json(res, 401, { error: "unauthorized" })
        return json(res, 200, { webhooks: listWebhooks(admin ? undefined : caller.key.id) })
      }

      return json(res, 404, {
        error: "not_found",
        hint: "GET /health, POST /funding, POST /mcp, POST /mcp/paid, POST /keys, GET /usage, POST /webhooks",
      })
    } catch (error) {
      process.stderr.write(`[perps-funding-pulse] ${error?.stack || error}\n`)
      if (!res.headersSent) json(res, 500, { error: "internal_error" })
      else res.end()
    }
  })
}

function snapshotLength() {
  return listKeys().length
}

function isDirectRun() {
  const entry = process.argv[1]
  if (!entry) return false
  return import.meta.url === pathToFileURL(entry).href
}

if (isDirectRun()) {
  try {
    initStore()
  } catch (error) {
    process.stderr.write(`[perps-funding-pulse] ${error.message}\n`)
    process.exit(1)
  }
  const server = createApp()
  server.listen(port(), "0.0.0.0", () => {
    const payTo = payToAddress() || "unset"
    process.stderr.write(
      `[perps-funding-pulse] listening on :${port()} · price ${priceUsd()} USD · payTo ${payTo} · version ${VERSION}\n`,
    )
  })
  const shutdown = () => {
    server.close(() => process.exit(0))
    setTimeout(() => process.exit(1), 10_000).unref()
  }
  process.on("SIGTERM", shutdown)
  process.on("SIGINT", shutdown)
}
