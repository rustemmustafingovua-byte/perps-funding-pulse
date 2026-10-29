/**
 * MCP wrapper. POST /mcp is a free preview. POST /mcp/paid settles x402 on every call.
 * Key and webhook tools act only on the API key the caller presents.
 */
import { fundingPulse, VENUES } from "./venues.js"
import { acceptPayment, paymentTerms } from "./x402.js"
import { createKey, revokeKey, listKeys, validateKey } from "./keys.js"
import { usageFor } from "./usage.js"
import { registerWebhook, unregisterWebhook, listWebhooks } from "./webhooks.js"
import { VERSION, freeLimit, priceUsd } from "./config.js"

const PROTOCOL = "2024-11-05"
const hits = new Map()

export function freeTier(ip) {
  const limit = freeLimit()
  const now = Date.now()
  const rec = hits.get(ip)
  if (!rec || now - rec.at > 3_600_000) {
    hits.set(ip, { count: 1, at: now })
    return { allowed: true, left: Math.max(0, limit - 1) }
  }
  rec.count += 1
  if (hits.size > 10000) {
    for (const [key, value] of hits) {
      if (now - value.at > 3_600_000) hits.delete(key)
    }
  }
  return { allowed: rec.count <= limit, left: Math.max(0, limit - rec.count) }
}

export function __resetMcpFreeTier() {
  hits.clear()
}

const TOOLS = [
  {
    name: "get_funding",
    description:
      "Live funding rate, time to the next funding tick, open interest, long/short skew and mark price for perpetual futures (Binance USD-M, Bybit linear, OKX swaps).",
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
          description: "Markets, e.g. BTC/USDT. The same symbol is normalized per venue. Default: the venue's default set.",
        },
      },
      additionalProperties: false,
    },
  },
  {
    name: "create_api_key",
    description: "Create a free-tier API key. Paid and enterprise keys are issued by the operator.",
    inputSchema: {
      type: "object",
      properties: {
        owner: { type: "string", description: "Label stored with the key." },
      },
      required: ["owner"],
    },
  },
  {
    name: "revoke_api_key",
    description: "Revoke one of your API keys. Requires the key secret and the key id.",
    inputSchema: {
      type: "object",
      properties: {
        api_key: { type: "string" },
        id: { type: "string" },
      },
      required: ["api_key", "id"],
    },
  },
  {
    name: "list_api_keys",
    description: "Show the metadata for the API key you present. The secret is not returned.",
    inputSchema: {
      type: "object",
      properties: { api_key: { type: "string" } },
      required: ["api_key"],
    },
  },
  {
    name: "get_usage",
    description: "Usage and spend for the API key you present.",
    inputSchema: {
      type: "object",
      properties: { api_key: { type: "string" } },
      required: ["api_key"],
    },
  },
  {
    name: "register_webhook",
    description: "Register a public http(s) URL to receive funding alerts for your API key.",
    inputSchema: {
      type: "object",
      properties: {
        api_key: { type: "string" },
        url: { type: "string" },
        threshold_pct: { type: "number", description: "Absolute funding rate. 0.0001 means 0.01%." },
      },
      required: ["api_key", "url"],
    },
  },
  {
    name: "unregister_webhook",
    description: "Remove one of your webhooks.",
    inputSchema: {
      type: "object",
      properties: {
        api_key: { type: "string" },
        id: { type: "string" },
      },
      required: ["api_key", "id"],
    },
  },
  {
    name: "list_webhooks",
    description: "List webhooks owned by your API key.",
    inputSchema: {
      type: "object",
      properties: { api_key: { type: "string" } },
      required: ["api_key"],
    },
  },
]

const rpc = (id, result) => ({ jsonrpc: "2.0", id, result })
const rpcErr = (id, code, message) => ({ jsonrpc: "2.0", id, error: { code, message } })

function requireCaller(params, id) {
  const rec = validateKey(params?.arguments?.api_key)
  if (!rec) return { error: rpcErr(id, -32001, "valid api_key required") }
  return { key: rec }
}

export async function handleMcp({ body }) {
  const { id = null, method, params = {} } = body ?? {}

  if (method === "initialize") {
    return rpc(id, {
      protocolVersion: PROTOCOL,
      capabilities: { tools: {} },
      serverInfo: { name: "perps-funding-pulse", version: VERSION },
    })
  }
  if (method === "tools/list") return rpc(id, { tools: TOOLS })
  if (method === "ping") return rpc(id, {})
  if (method !== "tools/call") return rpcErr(id, -32601, `method not found: ${method}`)

  const name = params?.name

  if (name === "get_funding") {
    const rows = await fundingPulse({
      venue_ids: params?.arguments?.venue_ids,
      markets: params?.arguments?.markets,
    })
    const text = JSON.stringify({ service: "perps-funding-pulse", results: rows, ts: new Date().toISOString() }, null, 1)
    return rpc(id, { content: [{ type: "text", text }], isError: false })
  }

  if (name === "create_api_key") {
    if (params?.arguments?.tier && params.arguments.tier !== "free") {
      return rpcErr(id, -32602, "paid and enterprise keys are issued with an admin token via POST /keys")
    }
    const owner = String(params?.arguments?.owner || "anonymous")
    const rec = createKey({ owner, tier: "free" })
    return rpc(id, { content: [{ type: "text", text: JSON.stringify(rec) }], isError: false })
  }

  if (name === "revoke_api_key") {
    const caller = requireCaller(params, id)
    if (caller.error) return caller.error
    const keyId = String(params?.arguments?.id || "")
    if (caller.key.id !== keyId) return rpcErr(id, -32001, "api_key does not match id")
    const ok = revokeKey(keyId)
    return rpc(id, { content: [{ type: "text", text: JSON.stringify({ ok }) }], isError: !ok })
  }

  if (name === "list_api_keys") {
    const caller = requireCaller(params, id)
    if (caller.error) return caller.error
    const keys = listKeys().filter((row) => row.id === caller.key.id)
    return rpc(id, { content: [{ type: "text", text: JSON.stringify({ keys }) }], isError: false })
  }

  if (name === "get_usage") {
    const caller = requireCaller(params, id)
    if (caller.error) return caller.error
    return rpc(id, { content: [{ type: "text", text: JSON.stringify({ id: caller.key.id, ...usageFor(caller.key.id) }) }], isError: false })
  }

  if (name === "register_webhook") {
    const caller = requireCaller(params, id)
    if (caller.error) return caller.error
    const url = String(params?.arguments?.url || "")
    const thresholdPct = Number(params?.arguments?.threshold_pct ?? 0.0001)
    const rec = registerWebhook({ url, thresholdPct, ownerKeyId: caller.key.id })
    if (rec.error) return rpcErr(id, -32602, rec.error)
    return rpc(id, { content: [{ type: "text", text: JSON.stringify(rec) }], isError: false })
  }

  if (name === "unregister_webhook") {
    const caller = requireCaller(params, id)
    if (caller.error) return caller.error
    const webhookId = String(params?.arguments?.id || "")
    const ok = unregisterWebhook(webhookId, caller.key.id)
    return rpc(id, { content: [{ type: "text", text: JSON.stringify({ ok }) }], isError: !ok })
  }

  if (name === "list_webhooks") {
    const caller = requireCaller(params, id)
    if (caller.error) return caller.error
    return rpc(id, { content: [{ type: "text", text: JSON.stringify({ webhooks: listWebhooks(caller.key.id) }) }], isError: false })
  }

  return rpcErr(id, -32602, `unknown tool: ${name}`)
}

export async function handlePaidMcp({ body, txHash, signature, resource, beforeSettle, fetchImpl }) {
  const outcome = await acceptPayment({
    txHash,
    signature,
    priceUsd: priceUsd(),
    resource,
    fetchImpl,
    beforeSettle,
  })
  if (!outcome.ok) {
    let terms = null
    try {
      terms = await paymentTerms(priceUsd(), { resource, fetchImpl })
    } catch {
      terms = null
    }
    const headers = {}
    if (terms) headers["payment-required"] = Buffer.from(JSON.stringify(terms)).toString("base64")
    const error = outcome.status === 400 ? "invalid_payment" : outcome.status === 429 ? "rate_limit_exceeded" : "payment_required"
    return {
      status: outcome.status || 402,
      body: { error, reason: outcome.reason, ...(terms ? { terms } : {}) },
      headers,
    }
  }
  const result = await handleMcp({ body, ip: "paid", paid: true })
  return {
    status: 200,
    body: result,
    headers: {
      "payment-response": Buffer.from(JSON.stringify({
        success: true,
        transaction: outcome.tx || "",
        network: "eip155:8453",
        payer: outcome.payer || null,
      })).toString("base64"),
    },
  }
}

export { priceUsd as PRICE_USD, freeLimit as FREE_LIMIT }
