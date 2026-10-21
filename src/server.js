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

const PORT = Number(process.env.PORT || 8780)
const PRICE_USD = Number(process.env.PRICE_USD || "0.001")
const VERSION = "0.1.0"

const json = (res, status, body, headers = {}) => {
  res.writeHead(status, { "content-type": "application/json", "access-control-allow-origin": "*", ...headers })
  res.end(JSON.stringify(body))
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

  return json(res, 404, { error: "not_found", hint: "GET /health or POST /funding" })
})

const USDC_LIKE = "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913"

server.listen(PORT, "0.0.0.0", () => {
  process.stderr.write(
    `[perps-funding-pulse] listening on :${PORT} · price ${PRICE_USD} USDC · payTo ${PAY_TO}\n`,
  )
})
