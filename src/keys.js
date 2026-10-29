/**
 * API keys. The full secret is returned once from createKey and is never listed.
 * A key id by itself is not enough: validateKey checks the secret.
 */
import { randomBytes } from "node:crypto"
import { initStore, save, snapshot } from "./store.js"
import { safeEqual } from "./secret.js"

const TIERS = new Set(["free", "paid", "enterprise"])

function generateKeyId() {
  return randomBytes(8).toString("hex")
}

function generateSecret() {
  return randomBytes(24).toString("base64url")
}

export function createKey({ owner = "anonymous", tier = "free" } = {}) {
  initStore()
  const id = generateKeyId()
  const secret = generateSecret()
  const record = {
    id,
    key: `pfp_${id}_${secret}`,
    owner: String(owner).slice(0, 128),
    tier: TIERS.has(tier) ? tier : "free",
    createdAt: Date.now(),
    revoked: false,
  }
  snapshot().keys.push(record)
  save()
  return { ...record }
}

export function revokeKey(id) {
  const rec = snapshot().keys.find((row) => row.id === id)
  if (!rec) return false
  rec.revoked = true
  save()
  return true
}

export function getKey(id) {
  return snapshot().keys.find((row) => row.id === id) || null
}

export function listKeys() {
  return snapshot().keys.map(({ key: _secret, ...rest }) => ({ ...rest }))
}

export function validateKey(raw) {
  if (!raw || typeof raw !== "string") return null
  const match = /^pfp_([0-9a-f]{16})_(.+)$/.exec(raw)
  if (!match) return null
  const rec = snapshot().keys.find((row) => row.id === match[1])
  if (!rec || rec.revoked) return null
  const prefix = `pfp_${rec.id}_`
  if (!rec.key.startsWith(prefix)) return null
  if (!safeEqual(match[2], rec.key.slice(prefix.length))) return null
  return rec
}

export function __clearKeys() {
  initStore()
  snapshot().keys.splice(0, snapshot().keys.length)
  save()
}
