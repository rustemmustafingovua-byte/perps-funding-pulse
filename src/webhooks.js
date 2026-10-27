/**
 * Webhook support for funding alerts.
 *
 *   POST /webhooks      — { url, threshold_pct? }
 *   DELETE /webhooks/:id
 *   GET  /webhooks
 *
 * При переходе funding_rate через threshold_pct (по модулю) шлём POST на url.
 */

const WEBHOOKS = new Map() // id -> { id, url, thresholdPct, createdAt, lastFired, disabled }
const WEBHOOK_LOG = [] // id -> { at, ok, status }

function generateId() {
  return String(Date.now()).slice(-6) + Math.random().toString(36).slice(2, 6)
}

export function registerWebhook({ url, thresholdPct = 0.01 } = {}) {
  const id = generateId()
  const rec = { id, url, thresholdPct, createdAt: Date.now(), lastFired: null, disabled: false }
  WEBHOOKS.set(id, rec)
  return { ...rec }
}

export function unregisterWebhook(id) {
  return WEBHOOKS.delete(id)
}

export function listWebhooks() {
  return Array.from(WEBHOOKS.values()).map(({ ...rest }) => rest)
}

export function getWebhook(id) {
  return WEBHOOKS.get(id) || null
}

export function updateWebhook(id, patch) {
  const rec = WEBHOOKS.get(id)
  if (!rec) return null
  Object.assign(rec, patch)
  return rec
}

export async function checkWebhooks(rows) {
  const checks = []
  for (const rec of WEBHOOKS.values()) {
    if (rec.disabled) continue
    for (const r of rows) {
      if (!r.ok || r.funding_rate == null) continue
      const absRate = Math.abs(r.funding_rate)
      if (absRate >= rec.thresholdPct) {
        checks.push({ webhook: rec, row: r })
      }
    }
  }
  const results = []
  for (const { webhook, row } of checks) {
    const payload = {
      event: "funding_alert",
      ts: new Date().toISOString(),
      venue: row.venue,
      market: row.market,
      funding_rate: row.funding_rate,
      threshold_pct: webhook.thresholdPct,
    }
    const fired = await fireWebhook(webhook.url, payload)
    results.push({ id: webhook.id, url: webhook.url, ok: fired.ok, status: fired.status })
    webhook.lastFired = Date.now()
  }
  return results
}

async function fireWebhook(url, payload) {
  try {
    const res = await fetch(url, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(payload),
      signal: AbortSignal.timeout(8000),
    })
    return { ok: res.ok, status: res.status }
  } catch (e) {
    return { ok: false, status: 0, error: e?.shortMessage ?? e?.message ?? String(e) }
  }
}

export function __clearWebhooks() {
  WEBHOOKS.clear()
}
