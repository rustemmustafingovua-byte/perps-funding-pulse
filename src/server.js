/**
 * perps-funding-pulse — агент с публичными данными по перпетуалам, доступный по x402.
 *
 *   GET  /health         — бесплатно: статус, площадки, время ответа
 *   POST /funding        — платно (x402): фандинг, время до тика, открытый интерес, перекос
 *   POST /mcp            — бесплатный MCP (лимит 20/час на IP)
 *   POST /mcp/paid       — платный MCP (x402)
 *   POST /keys           — создать API-ключ
 *   DELETE /keys/:id     — отозвать API-ключ
 *   GET  /keys           — список ключей
 *   GET  /usage          — сводка по использованию и биллингу
 *   POST /webhooks       — регистрация webhook на алерты фандинга
 *   DELETE /webhooks/:id — удалить webhook
 *   GET  /webhooks       — список webhook-ов
 *
 * Оплата: клиент переводит USDC или нативный ETH на адрес получателя и присылает
 * хеш транзакции в X-PAYMENT-TX. Газ платит клиент, сервер ничего не тратит.
 */
import { createServer } from "node:http"
import { fundingPulse, VENUES } from "./venues.js"
import { verifyPayment, paymentTerms, PAY_TO } from "./x402.js"
import { handleMcp, handlePaidMcp, freeTier, FREE_LIMIT } from "./mcp.js"
import { createKey, revokeKey, listKeys, validateKey } from "./keys.js"
import { recordUsage, usageFor, ipUsageFor, billingSummary } from "./usage.js"
import { registerWebhook, unregisterWebhook, listWebhooks, checkWebhooks } from "./webhooks.js"

const PORT = Number(process.env.PORT || 8780)
const PRICE_USD = Number(process.env.PRICE_USD || "0.001")
const VERSION = "0.2.0"
const FUNDING_RPM = Number(process.env.FUNDING_RPM || "30")
const fundingHits = new Map()

// Лимиты по тарифам
const TIER_LIMITS = {
  free: Number(process.env.FREE_LIMIT || 20), // в час на IP
  paid: Number(process.env.PAID_LIMIT || 200), // в час на ключ
  enterprise: Number(process.env.ENTERPRISE_LIMIT || 1000), // в час на ключ
}

function pushDashboardStats(data) {
  const webhook = process.env.DASHBOARD_WEBHOOK_URL
  if (!webhook) return
  try {
    fetch(webhook + "/webhook/perps-funding-pulse", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(data),
    }).catch(() => {})
  } catch {}
}

function checkFundingRate(ip) {
  const now = Date.now()
  const list = (fundingHits.get(ip) || []).filter((t) => t > now - 60000)
  if (list.length >= FUNDING_RPM) {
    fundingHits.set(ip, list)
    return false
  }
  list.push(now)
  fundingHits.set(ip, list)
  if (fundingHits.size > 10000) {
    for (const [k, v] of fundingHits) {
      if (!v.some((t) => t > now - 60000)) fundingHits.delete(k)
    }
  }
  return true
}

const json = (res, status, body, headers = {}) => {
  res.writeHead(status, { "content-type": "application/json", "access-control-allow-origin": "*", ...headers })
  res.end(JSON.stringify(body))
}

function getClientIp(req) {
  return (req.headers["x-forwarded-for"]?.split(",")[0]?.trim()) || req.socket.remoteAddress || "unknown"
}

async function requireApiKey(req) {
  const raw = req.headers["x-api-key"]
  const rec = validateKey(raw)
  if (!rec) return null
  return rec
}

async function checkKeyRateLimit(key) {
  const now = Date.now()
  const limit = TIER_LIMITS[key.tier] ?? TIER_LIMITS.free
  const usage = usageFor(key.id)
  if (!usage.lastAt || now - usage.lastAt > 3_600_000) {
    return { allowed: true, limit, remaining: limit - 1, used: 1 }
  }
  const used = usage.count + 1
  return { allowed: used <= limit, limit, remaining: Math.max(0, limit - used), used }
}

const server = createServer(async (req, res) => {
  res.setHeader("access-control-allow-origin", "*")
  res.setHeader("access-control-allow-headers", "content-type, x-payment-tx, x-api-key")
  if (req.method === "OPTIONS") return res.writeHead(204).end()

  const url = new URL(req.url, `http://${req.headers.host || "localhost"}`)

  if (req.method === "GET" && url.pathname === "/health") {
    return json(res, 200, {
      status: "ok",
      service: "perps-funding-pulse",
      version: VERSION,
      venues: Object.entries(VENUES).map(([id, v]) => ({ id, name: v.name, markets: v.markets })),
      price_usd: PRICE_USD,
      pay_to: PAY_TO,
      network: "base",
      ts: new Date().toISOString(),
    })
  }

  if (req.method === "POST" && url.pathname === "/funding") {
    const clientIp = getClientIp(req)
    const apiKey = await requireApiKey(req)
    if (apiKey) {
      const rl = await checkKeyRateLimit(apiKey)
      if (!rl.allowed) {
        return json(res, 429, { error: "rate_limit_exceeded", tier: apiKey.tier, limit: rl.limit, remaining: 0 })
      }
    } else {
      if (!checkFundingRate(clientIp)) {
        return json(res, 429, { error: "rate_limit_exceeded", retryAfter: 60 })
      }
    }

    const txHash = req.headers["x-payment-tx"]
    if (!apiKey && !txHash) {
      const terms = await paymentTerms(PRICE_USD)
      return json(
        res,
        402,
        {
          error: "payment_required",
          message: `payment required: ${PRICE_USD} USDC on Base`,
          ways: [
            {
              kind: "transfer-and-prove",
              note: "send USDC or ETH to payTo on Base, then repeat the request with header X-PAYMENT-TX: <tx hash>",
              asset: USDC_LIKE,
              payTo: PAY_TO,
              amount: terms.accepts[0].amount,
              network: "base",
            },
          ],
          terms,
        },
        { "payment-required": Buffer.from(JSON.stringify(terms)).toString("base64") },
      )
    }

    let verdict = { ok: true }
    if (txHash) {
      verdict = await verifyPayment(txHash, { priceUsd: PRICE_USD })
      if (!verdict.ok) {
        const terms = await paymentTerms(PRICE_USD)
        return json(
          res,
          402,
          { error: "payment_required", reason: verdict.reason, terms },
          { "payment-required": Buffer.from(JSON.stringify(terms)).toString("base64") },
        )
      }
    }

    const chunks = []
    for await (const c of req) chunks.push(c)
    let body = {}
    try {
      body = JSON.parse(Buffer.concat(chunks).toString() || "{}")
    } catch {}

    const rows = await fundingPulse({
      venue_ids: body.venue_ids,
      markets: body.markets,
    })

    const keyId = apiKey?.id
    recordUsage({ keyId, ip: clientIp, usdSpent: verdict.amountUsd || 0 })

    pushDashboardStats({
      fundingRates: rows,
      requests: (USAGE.get(keyId || "")?.count || 0) + (IP_USAGE.get(clientIp)?.count || 0),
      revenue: Number((USAGE.get(keyId || "")?.usdSpent || 0n) / 1_000_000n),
      volume: rows.reduce((s, r) => s + (Number(r.open_interest || 0)), 0),
    })

    // Проверяем webhook-и
    const webhookResults = await checkWebhooks(rows)

    return json(res, 200, {
      service: "perps-funding-pulse",
      version: VERSION,
      request: body,
      payment: apiKey ? { via: "api_key", key_id: apiKey.id, tier: apiKey.tier } : { asset: verdict.asset, amount_usd: verdict.amountUsd, tx: verdict.tx },
      results: rows,
      webhooks: webhookResults,
      ts: new Date().toISOString(),
    })
  }

  if (req.method === "POST" && (url.pathname === "/mcp" || url.pathname === "/mcp/paid")) {
    const chunks = []
    for await (const c of req) chunks.push(c)
    let body = {}
    try {
      body = JSON.parse(Buffer.concat(chunks).toString() || "{}")
    } catch {
      return json(res, 400, { error: "invalid_json" })
    }
    if (url.pathname === "/mcp/paid") {
      const out = await handlePaidMcp({ body, txHash: req.headers["x-payment-tx"] })
      return json(res, out.status, out.body, out.headers)
    }
    const ip = getClientIp(req)
    const tier = freeTier(ip)
    if (!tier.allowed) {
      const terms = await paymentTerms(PRICE_USD)
      return json(
        res,
        402,
        {
          error: "payment_required",
          message: `free tier exhausted (${FREE_LIMIT}/hour) — use /mcp/paid or pay $${PRICE_USD} USDC on Base`,
          terms,
        },
        { "payment-required": Buffer.from(JSON.stringify(terms)).toString("base64") },
      )
    }
    const out = await handleMcp({ body, ip, paid: false })
    return json(res, 200, out, { "x-free-tier-left": String(tier.left) })
  }

  // POST /keys — создать ключ
  if (req.method === "POST" && url.pathname === "/keys") {
    const chunks = []
    for await (const c of req) chunks.push(c)
    let body = {}
    try {
      body = JSON.parse(Buffer.concat(chunks).toString() || "{}")
    } catch {
      return json(res, 400, { error: "invalid_json" })
    }
    const owner = String(body.owner || "anonymous")
    const tier = ["free", "paid", "enterprise"].includes(body.tier) ? body.tier : "free"
    const rec = createKey({ owner, tier })
    return json(res, 201, { key: rec })
  }

  // DELETE /keys/:id — отозвать ключ
  if (req.method === "DELETE" && url.pathname.startsWith("/keys/")) {
    const id = url.pathname.split("/")[2]
    const ok = revokeKey(id)
    if (!ok) return json(res, 404, { error: "key_not_found" })
    return json(res, 200, { ok: true, message: `key ${id} revoked` })
  }

  // GET /keys — список ключей
  if (req.method === "GET" && url.pathname === "/keys") {
    return json(res, 200, { keys: listKeys() })
  }

  // GET /usage — сводка по биллингу
  if (req.method === "GET" && url.pathname === "/usage") {
    const summary = billingSummary()
    return json(res, 200, { usage: summary })
  }

  // POST /webhooks — зарегистрировать webhook
  if (req.method === "POST" && url.pathname === "/webhooks") {
    const apiKey = await requireApiKey(req)
    if (!apiKey) return json(res, 401, { error: "unauthorized", message: "X-API-Key required" })
    const chunks = []
    for await (const c of req) chunks.push(c)
    let body = {}
    try {
      body = JSON.parse(Buffer.concat(chunks).toString() || "{}")
    } catch {
      return json(res, 400, { error: "invalid_json" })
    }
    const urlStr = String(body.url || "")
    if (!/^https?:\/\//i.test(urlStr)) return json(res, 400, { error: "invalid_url" })
    const thresholdPct = Math.max(0, Number(body.threshold_pct ?? 0.01))
    const rec = registerWebhook({ url: urlStr, thresholdPct })
    return json(res, 201, { webhook: rec })
  }

  // DELETE /webhooks/:id
  if (req.method === "DELETE" && url.pathname.startsWith("/webhooks/")) {
    const id = url.pathname.split("/")[2]
    const ok = unregisterWebhook(id)
    if (!ok) return json(res, 404, { error: "webhook_not_found" })
    return json(res, 200, { ok: true })
  }

  // GET /webhooks
  if (req.method === "GET" && url.pathname === "/webhooks") {
    return json(res, 200, { webhooks: listWebhooks() })
  }

  return json(res, 404, { error: "not_found", hint: "GET /health, POST /funding, POST /mcp, POST /mcp/paid, POST /keys, GET /keys, GET /usage, POST /webhooks" })
})

const USDC_LIKE = "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913"

server.listen(PORT, "0.0.0.0", () => {
  process.stderr.write(
    `[perps-funding-pulse] listening on :${PORT} · price ${PRICE_USD} USDC · payTo ${PAY_TO} · version ${VERSION}\n`,
  )
})
