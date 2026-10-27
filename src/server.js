/**
 * perps-funding-pulse — агент с публичными данными по перпетуалам, доступный по x402.
 *
 *   GET  /health   — бесплатно: статус, площадки, время ответа
 *   POST /funding  — платно (x402): фандинг, время до тика, открытый интерес, перекос
 *
 * Оплата: клиент переводит USDC или нативный ETH на адрес получателя и присылает
 * хеш транзакции в X-PAYMENT-TX. Газ платит клиент, сервер ничего не тратит.
 */
import { createServer } from "node:http"
import { fundingPulse, VENUES } from "./venues.js"
import { verifyPayment, paymentTerms, PAY_TO } from "./x402.js"
import { handleMcp, handlePaidMcp, freeTier, FREE_LIMIT } from "./mcp.js"

const PORT = Number(process.env.PORT || 8780)
const PRICE_USD = Number(process.env.PRICE_USD || "0.001")
const VERSION = "0.1.0"
const FUNDING_RPM = Number(process.env.FUNDING_RPM || "30")
const fundingHits = new Map()

function checkFundingRate(ip) {
  const now = Date.now()
  const list = (fundingHits.get(ip) || []).filter(t => t > now - 60000)
  if (list.length >= FUNDING_RPM) {
    fundingHits.set(ip, list)
    return false
  }
  list.push(now)
  fundingHits.set(ip, list)
  if (fundingHits.size > 10000) {
    for (const [k, v] of fundingHits) {
      if (!v.some(t => t > now - 60000)) fundingHits.delete(k)
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

const server = createServer(async (req, res) => {
  res.setHeader("access-control-allow-origin", "*")
  res.setHeader("access-control-allow-headers", "content-type, x-payment-tx")
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
    if (!checkFundingRate(clientIp)) {
      return json(res, 429, { error: "rate_limit_exceeded", retryAfter: 60 })
    }
    const txHash = req.headers["x-payment-tx"]
    if (!txHash) {
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

    const verdict = await verifyPayment(txHash, { priceUsd: PRICE_USD })
    if (!verdict.ok) {
      const terms = await paymentTerms(PRICE_USD)
      return json(
        res,
        402,
        { error: "payment_required", reason: verdict.reason, terms },
        { "payment-required": Buffer.from(JSON.stringify(terms)).toString("base64") },
      )
    }

    // читаем тело запроса
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

    return json(res, 200, {
      service: "perps-funding-pulse",
      version: VERSION,
      request: body,
      payment: { asset: verdict.asset, amount_usd: verdict.amountUsd, tx: verdict.tx },
      results: rows,
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

  return json(res, 404, { error: "not_found", hint: "GET /health, POST /funding, POST /mcp, POST /mcp/paid" })
})

const USDC_LIKE = "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913"

server.listen(PORT, "0.0.0.0", () => {
  process.stderr.write(
    `[perps-funding-pulse] listening on :${PORT} · price ${PRICE_USD} USDC · payTo ${PAY_TO}\n`,
  )
})
