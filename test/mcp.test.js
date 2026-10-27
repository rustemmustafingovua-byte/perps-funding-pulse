import { test } from "node:test"
import assert from "node:assert/strict"
import { handleMcp, handlePaidMcp, freeTier, FREE_LIMIT } from "../src/mcp.js"
import { createKey, revokeKey, listKeys, validateKey, __clearKeys } from "../src/keys.js"
import { registerWebhook, unregisterWebhook, listWebhooks, __clearWebhooks } from "../src/webhooks.js"
import { recordUsage, billingSummary } from "../src/usage.js"

test("mcp create_api_key tool works", async () => {
  __clearKeys()
  const out = await handleMcp({
    body: { jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "create_api_key", arguments: { owner: "alice", tier: "paid" } } },
    ip: "127.0.0.1",
    paid: true,
  })
  assert.equal(out.error, undefined)
  const text = out.result.content[0].text
  const parsed = JSON.parse(text)
  assert.ok(parsed.key)
  assert.equal(parsed.tier, "paid")
})

test("mcp list_api_keys tool works", async () => {
  __clearKeys()
  createKey({ owner: "bob" })
  const out = await handleMcp({
    body: { jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "list_api_keys" } },
    ip: "127.0.0.1",
    paid: true,
  })
  const parsed = JSON.parse(out.result.content[0].text)
  assert.ok(Array.isArray(parsed.keys))
  assert.ok(parsed.keys[0].key === undefined)
})

test("mcp revoke_api_key tool works", async () => {
  __clearKeys()
  const k = createKey({ owner: "carol" })
  const out = await handleMcp({
    body: { jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "revoke_api_key", arguments: { id: k.id } } },
    ip: "127.0.0.1",
    paid: true,
  })
  const parsed = JSON.parse(out.result.content[0].text)
  assert.equal(parsed.ok, true)
  assert.equal(validateKey(k.key), null)
})

test("mcp get_usage tool works", async () => {
  __clearKeys()
  const k = createKey({ owner: "dave" })
  recordUsage({ keyId: k.id, usdSpent: 0.005 })
  const out = await handleMcp({
    body: { jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "get_usage" } },
    ip: "127.0.0.1",
    paid: true,
  })
  const parsed = JSON.parse(out.result.content[0].text)
  assert.ok(parsed.totalRequests >= 1)
  assert.ok(parsed.totalUsd >= 0.005)
})

test("mcp register_webhook tool works", async () => {
  __clearKeys()
  __clearWebhooks()
  const k = createKey({ owner: "eve" })
  const out = await handleMcp({
    body: { jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "register_webhook", arguments: { url: "https://example.com/hook", threshold_pct: 0.001 } } },
    ip: "127.0.0.1",
    paid: true,
  })
  assert.equal(out.error, undefined)
  const parsed = JSON.parse(out.result.content[0].text)
  assert.equal(parsed.url, "https://example.com/hook")
})

test("mcp unregister_webhook tool works", async () => {
  __clearKeys()
  __clearWebhooks()
  const w = registerWebhook({ url: "https://example.com/x" })
  const out = await handleMcp({
    body: { jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "unregister_webhook", arguments: { id: w.id } } },
    ip: "127.0.0.1",
    paid: true,
  })
  const parsed = JSON.parse(out.result.content[0].text)
  assert.equal(parsed.ok, true)
})

test("mcp list_webhooks tool works", async () => {
  __clearKeys()
  __clearWebhooks()
  registerWebhook({ url: "https://example.com/list" })
  const out = await handleMcp({
    body: { jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "list_webhooks" } },
    ip: "127.0.0.1",
    paid: true,
  })
  const parsed = JSON.parse(out.result.content[0].text)
  assert.ok(Array.isArray(parsed.webhooks))
})

test("mcp tools list includes monetization tools", async () => {
  const out = await handleMcp({
    body: { jsonrpc: "2.0", id: 1, method: "tools/list" },
    ip: "127.0.0.1",
    paid: true,
  })
  const names = out.result.tools.map((t) => t.name)
  assert.ok(names.includes("create_api_key"))
  assert.ok(names.includes("revoke_api_key"))
  assert.ok(names.includes("list_api_keys"))
  assert.ok(names.includes("get_usage"))
  assert.ok(names.includes("register_webhook"))
  assert.ok(names.includes("unregister_webhook"))
  assert.ok(names.includes("list_webhooks"))
})
