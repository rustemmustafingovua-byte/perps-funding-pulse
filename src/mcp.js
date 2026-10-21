/**
 * MCP-обёртка над perps-funding-pulse.
 *
 *   POST /mcp       — бесплатный тариф (лимит запросов в час на IP)
 *   POST /mcp/paid  — всегда платно: 0.001 USDC или нативный ETH на Base
 *
 * Оба эндпоинта — обычный JSON-RPC 2.0 (streamable HTTP без SSE-стрима,
 * ответ приходит целиком, как в free-web-mcp).
 */
import { fundingPulse, VENUES } from "./venues.js"
import { verifyPayment, paymentTerms, PAY_TO } from "./x402.js"

const PROTOCOL = "2024-11-05"
const FREE_LIMIT = Number(process.env.FREE_LIMIT || 20) // запросов в час на IP
const PRICE_USD = Number(process.env.PRICE_USD || "0.001")

const hits = new Map() // ip -> { count, at }

export function freeTier(ip) {
  const now = Date.now()
  const rec = hits.get(ip)
  if (!rec || now - rec.at > 3_600_000) {
    hits.set(ip, { count: 1, at: now })
    return { allowed: true, left: FREE_LIMIT - 1 }
  }
  rec.count += 1
  return { allowed: rec.count <= FREE_LIMIT, left: Math.max(0, FREE_LIMIT - rec.count) }
}

const TOOLS = [
  {
    name: "get_funding",
    description:
      "Live funding rate, time to the next funding tick, open interest, long/short skew and mark price for perpetual futures markets (Binance USDⓈ-M, Bybit linear, OKX swaps).",
    inputSchema: {
      type: "object",
      properties: {
        venue_ids: {
          type: "array",
          items: { type: "string", enum: Object.keys(VENUES) },
          description: "Venues to query. Default: all.",
        },
        markets: {
          type: "array",
          items: { type: "string" },
          description: "Markets to track, e.g. BTC/USDT, ETH/USDT, SOL/USDT (OKX: BTC-USDT-SWAP). Default: venue default set.",
        },
      },
      additionalProperties: false,
    },
  },
]

const rpc = (id, result) => ({ jsonrpc: "2.0", id, result })
const rpcErr = (id, code, message) => ({ jsonrpc: "2.0", id, error: { code, message } })

export async function handleMcp({ body, ip, paid }) {
  const { id = null, method, params = {} } = body ?? {}

  if (method === "initialize") {
    return rpc(id, {
      protocolVersion: PROTOCOL,
      capabilities: { tools: {} },
      serverInfo: { name: "perps-funding-pulse", version: "0.1.0" },
    })
  }
  if (method === "tools/list") return rpc(id, { tools: TOOLS })
  if (method === "ping") return rpc(id, {})
  if (method !== "tools/call") return rpcErr(id, -32601, `method not found: ${method}`)

  const name = params?.name
  if (name !== "get_funding") return rpcErr(id, -32602, `unknown tool: ${name}`)

  const rows = await fundingPulse({
    venue_ids: params?.arguments?.venue_ids,
    markets: params?.arguments?.markets,
  })

  const text = JSON.stringify({ service: "perps-funding-pulse", results: rows, ts: new Date().toISOString() }, null, 1)
  return rpc(id, { content: [{ type: "text", text }], isError: false })
}

/** Обработка платного MCP-запроса: без оплаты — 402 с условиями. */
export async function handlePaidMcp({ body, txHash }) {
  if (!txHash) {
    const terms = await paymentTerms(PRICE_USD)
    return {
      status: 402,
      body: {
        error: "payment_required",
        message: `payment required: ${PRICE_USD} USDC on Base`,
        terms,
      },
      headers: { "payment-required": Buffer.from(JSON.stringify(terms)).toString("base64") },
    }
  }
  const verdict = await verifyPayment(txHash, { priceUsd: PRICE_USD })
  if (!verdict.ok) {
    const terms = await paymentTerms(PRICE_USD)
    return {
      status: 402,
      body: { error: "payment_required", reason: verdict.reason, terms },
      headers: { "payment-required": Buffer.from(JSON.stringify(terms)).toString("base64") },
    }
  }
  const res = await handleMcp({ body, ip: "paid", paid: true })
  return { status: 200, body: res, headers: {} }
}

export { PAY_TO, PRICE_USD, FREE_LIMIT }
