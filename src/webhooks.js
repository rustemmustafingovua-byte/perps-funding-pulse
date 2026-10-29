/**
 * Funding alerts. A webhook fires when a successful /funding row has
 * |funding_rate| greater than or equal to its threshold.
 * threshold is an absolute rate: 0.0001 means 0.01%.
 * URLs must be public http(s). Private and link-local targets are rejected.
 */
import { randomBytes } from "node:crypto"
import { initStore, save, snapshot } from "./store.js"

const TOTAL_CAP = 200
const PER_KEY_CAP = 20

function ipv4(host) {
  const match = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(host)
  if (!match) return null
  const parts = match.slice(1).map(Number)
  if (parts.some((part) => part > 255)) return null
  return (((parts[0] << 24) >>> 0) + (parts[1] << 16) + (parts[2] << 8) + parts[3]) >>> 0
}

function inCidr(ip, base, bits) {
  const mask = bits === 0 ? 0 : (0xffffffff << (32 - bits)) >>> 0
  return (ip & mask) === (base & mask)
}

function isPrivateIpv4(host) {
  const ip = ipv4(host)
  if (ip == null) return false
  return (
    inCidr(ip, ipv4("0.0.0.0"), 8) ||
    inCidr(ip, ipv4("10.0.0.0"), 8) ||
    inCidr(ip, ipv4("127.0.0.0"), 8) ||
    inCidr(ip, ipv4("100.64.0.0"), 10) ||
    inCidr(ip, ipv4("169.254.0.0"), 16) ||
    inCidr(ip, ipv4("172.16.0.0"), 12) ||
    inCidr(ip, ipv4("192.168.0.0"), 16) ||
    inCidr(ip, ipv4("192.0.0.0"), 24) ||
    inCidr(ip, ipv4("192.0.2.0"), 24) ||
    inCidr(ip, ipv4("198.51.100.0"), 24) ||
    inCidr(ip, ipv4("203.0.113.0"), 24) ||
    ip === ipv4("255.255.255.255")
  )
}

function isPrivateIpv6(host) {
  if (!host.includes(":")) return false
  const value = host.toLowerCase()
  if (value === "::1" || value === "::") return true
  if (value.startsWith("fe80:") || value.startsWith("fc") || value.startsWith("fd")) return true
  const mapped = /^::ffff:(\d{1,3}(?:\.\d{1,3}){3})$/.exec(value)
  if (mapped) return isPrivateIpv4(mapped[1])
  return false
}

export function isPublicWebhookUrl(raw) {
  let url
  try {
    url = new URL(raw)
  } catch {
    return false
  }
  if (url.username || url.password) return false
  if (url.protocol !== "https:" && url.protocol !== "http:") return false
  const host = url.hostname.replace(/^\[|\]$/g, "").toLowerCase().replace(/\.$/, "")
  if (!host || host === "localhost" || host.endsWith(".localhost") || host.endsWith(".local")) return false
  if (host === "metadata.google.internal" || host === "metadata.internal") return false
  if (isPrivateIpv4(host) || isPrivateIpv6(host)) return false
  return true
}

export function registerWebhook({ url, thresholdPct = 0.0001, ownerKeyId = null } = {}) {
  initStore()
  if (!isPublicWebhookUrl(url)) return { error: "invalid_url" }
  const threshold = Number(thresholdPct)
  if (!Number.isFinite(threshold) || threshold < 0) return { error: "invalid_threshold" }
  if (snapshot().webhooks.length >= TOTAL_CAP) return { error: "webhook_limit" }
  if (ownerKeyId && snapshot().webhooks.filter((row) => row.ownerKeyId === ownerKeyId).length >= PER_KEY_CAP) {
    return { error: "webhook_limit" }
  }
  const rec = {
    id: randomBytes(8).toString("hex"),
    url,
    thresholdPct: threshold,
    ownerKeyId,
    createdAt: Date.now(),
    lastFired: null,
    disabled: false,
  }
  snapshot().webhooks.push(rec)
  save()
  return { ...rec }
}

export function unregisterWebhook(id, ownerKeyId) {
  initStore()
  const index = snapshot().webhooks.findIndex((row) => row.id === id && (ownerKeyId == null || row.ownerKeyId === ownerKeyId))
  if (index < 0) return false
  snapshot().webhooks.splice(index, 1)
  save()
  return true
}

export function listWebhooks(ownerKeyId) {
  const rows = snapshot().webhooks
  const visible = ownerKeyId == null ? rows : rows.filter((row) => row.ownerKeyId === ownerKeyId)
  return visible.map((row) => ({ ...row }))
}

export function getWebhook(id) {
  return snapshot().webhooks.find((row) => row.id === id) || null
}

export function updateWebhook(id, patch) {
  const rec = snapshot().webhooks.find((row) => row.id === id)
  if (!rec) return null
  Object.assign(rec, patch)
  save()
  return rec
}

async function fireWebhook(url, payload) {
  try {
    const res = await fetch(url, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(payload),
      redirect: "error",
      signal: AbortSignal.timeout(8000),
    })
    return { ok: res.ok, status: res.status }
  } catch (error) {
    return { ok: false, status: 0, error: error?.message ?? String(error) }
  }
}

export async function checkWebhooks(rows) {
  const checks = []
  for (const rec of snapshot().webhooks) {
    if (rec.disabled || !isPublicWebhookUrl(rec.url)) continue
    for (const row of rows) {
      if (!row.ok || row.funding_rate == null) continue
      if (Math.abs(row.funding_rate) >= rec.thresholdPct) checks.push({ webhook: rec, row })
    }
  }
  const results = []
  for (const { webhook, row } of checks) {
    const fired = await fireWebhook(webhook.url, {
      event: "funding_alert",
      ts: new Date().toISOString(),
      venue: row.venue,
      market: row.market,
      funding_rate: row.funding_rate,
      threshold: webhook.thresholdPct,
    })
    webhook.lastFired = Date.now()
    results.push({ id: webhook.id, url: webhook.url, ok: fired.ok, status: fired.status })
  }
  if (results.length) save()
  return results
}

export function __clearWebhooks() {
  initStore()
  snapshot().webhooks.splice(0, snapshot().webhooks.length)
  save()
}
