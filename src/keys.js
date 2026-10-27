/**
 * API key management for perps-funding-pulse.
 *
 *   POST /keys      — создать ключ (owner, tier)
 *   DELETE /keys/:id — отозвать ключ
 *   GET  /keys       — список ключей (без значений)
 *
 * Хранилище в памяти. Для продакшена можно заменить на БД.
 */

import { randomBytes } from "node:crypto"

const KEYS = new Map() // id -> { id, key, owner, tier, createdAt, revoked }

function generateKeyId() {
  return randomBytes(8).toString("hex")
}

function generateSecret() {
  return randomBytes(24).toString("base64url")
}

export function createKey({ owner = "anonymous", tier = "free" } = {}) {
  const id = generateKeyId()
  const secret = generateSecret()
  const record = {
    id,
    key: `pfp_${id}_${secret}`,
    owner,
    tier, // 'free' | 'paid' | 'enterprise'
    createdAt: Date.now(),
    revoked: false,
  }
  KEYS.set(id, record)
  return { ...record }
}

export function revokeKey(id) {
  const rec = KEYS.get(id)
  if (!rec) return false
  rec.revoked = true
  return true
}

export function getKey(id) {
  return KEYS.get(id) || null
}

export function listKeys() {
  return Array.from(KEYS.values()).map(({ key, ...rest }) => rest)
}

export function validateKey(raw) {
  if (!raw || typeof raw !== "string") return null
  const first = raw.indexOf("_")
  const second = raw.indexOf("_", first + 1)
  if (first < 0 || second < 0 || raw.slice(0, first) !== "pfp") return null
  const id = raw.slice(first + 1, second)
  const rec = KEYS.get(id)
  if (!rec || rec.revoked) return null
  return rec
}

export function __clearKeys() {
  KEYS.clear()
}
