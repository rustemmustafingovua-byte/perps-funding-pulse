/**
 * Runtime configuration. Every value is read when a request is handled so
 * tests and process managers can change the environment without a restart.
 */
import { readFileSync } from "node:fs"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"

export const VERSION = JSON.parse(
  readFileSync(join(dirname(fileURLToPath(import.meta.url)), "../package.json"), "utf8"),
).version

export function intEnv(name, fallback) {
  const raw = process.env[name]
  if (raw == null || raw.trim() === "") return fallback
  const value = Number(raw)
  if (!Number.isFinite(value) || value < 0) return fallback
  return Math.floor(value)
}

/** Per-call price in US dollars. USDC uses 6 decimals, so $0.001 is 1000 units. */
export function priceUsd() {
  const raw = process.env.PRICE_USD
  if (raw == null || raw.trim() === "") return 0.001
  const value = Number(raw)
  if (!Number.isFinite(value) || value <= 0) return 0.001
  return value
}

export function freeLimit() {
  return intEnv("FREE_LIMIT", 20)
}

export function paidLimit() {
  return intEnv("PAID_LIMIT", 200)
}

export function enterpriseLimit() {
  return intEnv("ENTERPRISE_LIMIT", 1000)
}

export function fundingRpm() {
  return intEnv("FUNDING_RPM", 30)
}

/** Direct transfers older than this are rejected so a wallet's history cannot be replayed. */
export function paymentMaxAgeSeconds() {
  return intEnv("PAYMENT_MAX_AGE_SECONDS", 900)
}

export function port() {
  return intEnv("PORT", 8780) || 8780
}
