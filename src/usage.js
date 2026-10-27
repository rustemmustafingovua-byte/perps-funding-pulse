/**
 * Usage tracking and billing.
 *
 * Считаем запросы по ключу и по IP, запоминаем последнюю активность.
 */

const USAGE = new Map() // id -> { count, lastAt, usdSpent }
const IP_USAGE = new Map() // ip -> { count, lastAt }

export function recordUsage({ keyId, ip, usdSpent = 0 } = {}) {
  if (keyId) {
    const rec = USAGE.get(keyId) || { count: 0, lastAt: Date.now(), usdSpent: 0 }
    rec.count += 1
    rec.lastAt = Date.now()
    rec.usdSpent += usdSpent
    USAGE.set(keyId, rec)
  }
  if (ip) {
    const rec = IP_USAGE.get(ip) || { count: 0, lastAt: Date.now() }
    rec.count += 1
    rec.lastAt = Date.now()
    IP_USAGE.set(ip, rec)
  }
}

export function usageFor(keyId) {
  return USAGE.get(keyId) || { count: 0, lastAt: null, usdSpent: 0 }
}

export function ipUsageFor(ip) {
  return IP_USAGE.get(ip) || { count: 0, lastAt: null }
}

export function billingSummary() {
  const totalUsd = Array.from(USAGE.values()).reduce((s, r) => s + r.usdSpent, 0)
  return {
    totalRequests: Array.from(USAGE.values()).reduce((s, r) => s + r.count, 0),
    totalUsd: Number(totalUsd.toFixed(6)),
    keys: Array.from(USAGE.entries()).map(([id, u]) => ({ id, ...u })),
  }
}
