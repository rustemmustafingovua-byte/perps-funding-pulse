/**
 * Request counters and revenue totals.
 * Quotas are hourly windows. Billing totals accumulate for the life of the state file.
 */
import { initStore, save, snapshot } from "./store.js"

const HOUR_MS = 3_600_000

function touchWindow(rec, now) {
  if (!rec.windowStart || now - rec.windowStart >= HOUR_MS) {
    rec.count = 0
    rec.windowStart = now
  }
  return rec
}

export function recordUsage({ keyId, ip, usdSpent = 0 } = {}) {
  initStore()
  const id = keyId || (ip ? `ip:${ip}` : null)
  if (id) {
    let rec = snapshot().usage.find((row) => row.id === id)
    if (!rec) {
      rec = { id, count: 0, lastAt: Date.now(), usdSpent: 0 }
      snapshot().usage.push(rec)
    }
    rec.count += 1
    rec.lastAt = Date.now()
    rec.usdSpent += usdSpent
  }
  if (ip) {
    let rec = snapshot().ipUsage.find((row) => row.ip === ip)
    if (!rec) {
      rec = { ip, count: 0, lastAt: Date.now() }
      snapshot().ipUsage.push(rec)
    }
    rec.count += 1
    rec.lastAt = Date.now()
  }
  save()
}

export function usageFor(keyId) {
  const rec = snapshot().usage.find((row) => row.id === keyId)
  return rec ? { count: rec.count, lastAt: rec.lastAt, usdSpent: rec.usdSpent } : { count: 0, lastAt: null, usdSpent: 0 }
}

export function ipUsageFor(ip) {
  const rec = snapshot().ipUsage.find((row) => row.ip === ip)
  return rec ? { count: rec.count, lastAt: rec.lastAt } : { count: 0, lastAt: null }
}

export function billingSummary() {
  const rows = snapshot().usage
  const totalUsd = rows.reduce((sum, row) => sum + row.usdSpent, 0)
  return {
    totalRequests: rows.reduce((sum, row) => sum + row.count, 0),
    totalUsd: Number(totalUsd.toFixed(6)),
    keys: rows.map((row) => ({ ...row })),
  }
}

export function peekQuota(id, limit) {
  const now = Date.now()
  const rec = snapshot().quotas.find((row) => row.id === id)
  const used = !rec || now - rec.windowStart >= HOUR_MS ? 0 : rec.count
  return { allowed: used < limit, limit, used, remaining: Math.max(0, limit - used) }
}

export function tryConsume(id, limit) {
  const now = Date.now()
  let rec = snapshot().quotas.find((row) => row.id === id)
  if (!rec) {
    rec = { id, count: 0, windowStart: now }
    snapshot().quotas.push(rec)
  }
  touchWindow(rec, now)
  if (rec.count >= limit) {
    save()
    return { allowed: false, limit, used: rec.count, remaining: 0 }
  }
  rec.count += 1
  save()
  return { allowed: true, limit, used: rec.count, remaining: Math.max(0, limit - rec.count) }
}

export function __shiftQuotaWindow(id, deltaMs) {
  const rec = snapshot().quotas.find((row) => row.id === id)
  if (rec) rec.windowStart += deltaMs
}

export function freeQuotaId(keyId, ip) {
  return `free:${keyId || ip}`
}

export function paidQuotaId(keyId, ip) {
  return `paid:${keyId || ip}`
}

export function enterpriseQuotaId(keyId) {
  return `enterprise:${keyId}`
}
