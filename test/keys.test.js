import { test } from "node:test"
import assert from "node:assert/strict"
import { createKey, revokeKey, getKey, listKeys, validateKey, __clearKeys } from "../src/keys.js"

delete process.env.DATA_FILE

test("createKey creates a key with prefixed secret", () => {
  __clearKeys()
  const rec = createKey({ owner: "alice", tier: "paid" })
  assert.ok(rec.id)
  assert.ok(rec.key.startsWith("pfp_"))
  assert.equal(rec.owner, "alice")
  assert.equal(rec.tier, "paid")
  assert.equal(rec.revoked, false)
})

test("validateKey accepts valid key and rejects bad ones", () => {
  __clearKeys()
  const rec = createKey({ owner: "bob" })
  const validated = validateKey(rec.key)
  assert.ok(validated)
  assert.equal(validated.id, rec.id)
  assert.equal(validated.owner, rec.owner)
  assert.equal(validateKey("bad"), null)
  assert.equal(validateKey(""), null)
  assert.equal(validateKey("pfp_" + "x".repeat(20)), null)
})

test("revokeKey marks key revoked and validateKey rejects it", () => {
  __clearKeys()
  const rec = createKey({ owner: "carol" })
  assert.equal(revokeKey(rec.id), true)
  assert.equal(revokeKey("does-not-exist"), false)
  assert.equal(getKey(rec.id).revoked, true)
  assert.equal(validateKey(rec.key), null)
})

test("validateKey rejects a secret that does not match", () => {
  __clearKeys()
  const rec = createKey({ owner: "mallory" })
  const forged = `${rec.key.slice(0, -1)}${rec.key.endsWith("a") ? "b" : "a"}`
  assert.notEqual(forged, rec.key)
  assert.equal(validateKey(forged), null)
  assert.equal(validateKey(rec.key).id, rec.id)
})

test("listKeys returns ids only", () => {
  __clearKeys()
  const a = createKey({ owner: "dave" })
  const b = createKey({ owner: "eve" })
  const list = listKeys()
  assert.ok(list.some((k) => k.id === a.id))
  assert.ok(list.some((k) => k.id === b.id))
  assert.equal(list[0].key, undefined)
})
