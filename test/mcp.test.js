import { test } from "node:test"
import assert from "node:assert/strict"
import { handleMcp } from "../src/mcp.js"
import { createKey, validateKey, __clearKeys } from "../src/keys.js"
import { registerWebhook, __clearWebhooks } from "../src/webhooks.js"
import { recordUsage } from "../src/usage.js"
import { resetStore } from "../src/store.js"

delete process.env.DATA_FILE
resetStore()

function call(name, args) {
  return handleMcp({
    body: { jsonrpc: "2.0", id: 1, method: "tools/call", params: { name, arguments: args } },
  })
}

test("mcp create_api_key issues a free key and refuses paid tiers", async () => {
  __clearKeys()
  const denied = await call("create_api_key", { owner: "alice", tier: "paid" })
  assert.match(denied.error.message, /admin token/)
  const out = await call("create_api_key", { owner: "alice" })
  const parsed = JSON.parse(out.result.content[0].text)
  assert.ok(parsed.key.startsWith("pfp_"))
  assert.equal(parsed.tier, "free")
})

test("mcp list_api_keys returns only the presented key", async () => {
  __clearKeys()
  const mine = createKey({ owner: "bob" })
  createKey({ owner: "other" })
  const out = await call("list_api_keys", { api_key: mine.key })
  const parsed = JSON.parse(out.result.content[0].text)
  assert.equal(parsed.keys.length, 1)
  assert.equal(parsed.keys[0].id, mine.id)
  assert.equal(parsed.keys[0].key, undefined)
})

test("mcp revoke_api_key requires the matching secret", async () => {
  __clearKeys()
  const mine = createKey({ owner: "carol" })
  const other = createKey({ owner: "dave" })
  const stolen = await call("revoke_api_key", { api_key: mine.key, id: other.id })
  assert.ok(stolen.error)
  assert.ok(validateKey(other.key))
  const out = await call("revoke_api_key", { api_key: mine.key, id: mine.id })
  assert.equal(JSON.parse(out.result.content[0].text).ok, true)
  assert.equal(validateKey(mine.key), null)
})

test("mcp get_usage is scoped to the presented key", async () => {
  __clearKeys()
  const mine = createKey({ owner: "erin" })
  recordUsage({ keyId: mine.id, usdSpent: 0.005 })
  const out = await call("get_usage", { api_key: mine.key })
  const parsed = JSON.parse(out.result.content[0].text)
  assert.equal(parsed.id, mine.id)
  assert.ok(parsed.count >= 1)
  assert.ok(parsed.usdSpent >= 0.005)
})

test("mcp webhook tools stay on the caller's key", async () => {
  __clearKeys()
  __clearWebhooks()
  const mine = createKey({ owner: "frank" })
  const created = await call("register_webhook", {
    api_key: mine.key,
    url: "https://example.com/hook",
    threshold_pct: 0.001,
  })
  const webhook = JSON.parse(created.result.content[0].text)
  assert.equal(webhook.url, "https://example.com/hook")
  const listed = await call("list_webhooks", { api_key: mine.key })
  assert.equal(JSON.parse(listed.result.content[0].text).webhooks.length, 1)
  const removed = await call("unregister_webhook", { api_key: mine.key, id: webhook.id })
  assert.equal(JSON.parse(removed.result.content[0].text).ok, true)
})

test("mcp rejects a private webhook URL", async () => {
  __clearKeys()
  const mine = createKey({ owner: "grace" })
  const out = await call("register_webhook", { api_key: mine.key, url: "http://127.0.0.1/hook" })
  assert.equal(out.error.message, "invalid_url")
})

test("mcp register_webhook cannot delete someone else's hook", async () => {
  __clearKeys()
  __clearWebhooks()
  const mine = createKey({ owner: "heidi" })
  const foreign = registerWebhook({ url: "https://example.com/foreign", ownerKeyId: "someone-else" })
  const out = await call("unregister_webhook", { api_key: mine.key, id: foreign.id })
  assert.equal(JSON.parse(out.result.content[0].text).ok, false)
})

test("mcp tools list includes the funding and account tools", async () => {
  const out = await handleMcp({ body: { jsonrpc: "2.0", id: 1, method: "tools/list" } })
  const names = out.result.tools.map((tool) => tool.name)
  for (const name of ["get_funding", "create_api_key", "revoke_api_key", "list_api_keys", "get_usage", "register_webhook", "unregister_webhook", "list_webhooks"]) {
    assert.ok(names.includes(name))
  }
})
