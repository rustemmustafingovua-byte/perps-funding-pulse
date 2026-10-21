/**
 * x402 — платёжный слой: клиент платит за вызов, сервер только проверяет.
 *
 * Схема «transfer-and-prove»: клиент сам переводит USDC (или нативный ETH) на
 * кошелёк получателя и присылает хеш транзакции в заголовке X-PAYMENT-TX.
 * Сервер проверяет транзакцию в сети (чтение бесплатно) и отдаёт результат.
 * Газ платит клиент — сервер не тратит ничего.
 */
import { createPublicClient, http, decodeAbiParameters } from "viem"
import { base } from "viem/chains"

export const USDC_BASE = "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913"
export const PAY_TO = process.env.X402_PAY_TO || "0x8aC6a229f254980CCd3Dd35CF5E1B7c08880B40E"
export const RPC = process.env.BASE_RPC || "https://mainnet.base.org"

const TRANSFER_TOPIC = "0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef"
const client = createPublicClient({ chain: base, transport: http(RPC) })

/** Текущий курс ETH в долларах (для пересчёта цены в нативный ETH). */
let ethUsdCache = { at: 0, usd: 0 }
export async function ethUsd() {
  if (ethUsdCache.usd && Date.now() - ethUsdCache.at < 60_000) return ethUsdCache.usd
  try {
    const res = await fetch("https://api.coingecko.com/api/v3/simple/price?ids=ethereum&vs_currencies=usd", {
      signal: AbortSignal.timeout(8000),
    })
    const j = await res.json()
    const usd = Number(j?.ethereum?.usd)
    if (usd > 0) {
      ethUsdCache = { at: Date.now(), usd }
      return usd
    }
  } catch {}
  return ethUsdCache.usd || 3000
}

/** Условия оплаты: сколько и чем. */
export async function paymentTerms(priceUsd) {
  const usd = await ethUsd()
  return {
    x402Version: 2,
    accepts: [
      {
        scheme: "exact",
        network: "eip155:8453",
        amount: String(Math.round(priceUsd * 1e6)),
        asset: USDC_BASE,
        payTo: PAY_TO,
        maxTimeoutSeconds: 300,
        extra: { name: "USD Coin", version: "2" },
      },
      {
        scheme: "exact",
        network: "eip155:8453",
        amount: String(BigInt(Math.ceil((priceUsd / usd) * 1e18))),
        asset: "ETH",
        payTo: PAY_TO,
        maxTimeoutSeconds: 300,
        extra: { name: "Ether", version: "" },
      },
    ],
  }
}

/** Проверить оплату: нативный перевод ETH либо перевод USDC на адрес получателя. */
export async function verifyPayment(txHash, { priceUsd }) {
  if (!/^0x[0-9a-f]{64}$/i.test(String(txHash ?? ""))) {
    return { ok: false, reason: "missing or malformed transaction hash" }
  }
  try {
    const res = await fetch(RPC, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "eth_getTransactionByHash", params: [txHash] }),
      signal: AbortSignal.timeout(15000),
    })
    const j = await res.json()
    const tx = j?.result
    if (!tx) return { ok: false, reason: "transaction not found" }

    // 1) нативный ETH
    if (tx.to && tx.to.toLowerCase() === PAY_TO.toLowerCase()) {
      const value = BigInt(tx.value ?? "0x0")
      if (value > 0n) {
        const usd = await ethUsd()
        const paidUsd = (Number(value) / 1e18) * usd
        if (paidUsd + 1e-9 >= priceUsd) {
          return { ok: true, asset: "ETH", amountWei: value, amountUsd: paidUsd, tx: txHash }
        }
        return { ok: false, reason: `paid $${paidUsd.toFixed(6)}, need $${priceUsd}` }
      }
    }

    // 2) перевод USDC (Transfer-событие)
    const receipt = await client.getTransactionReceipt({ hash: txHash })
    if (receipt.status !== "success") return { ok: false, reason: "transaction failed" }
    for (const log of receipt.logs) {
      if (log.address.toLowerCase() !== USDC_BASE.toLowerCase()) continue
      if ((log.topics?.[0] ?? "").toLowerCase() !== TRANSFER_TOPIC) continue
      const topics = log.topics ?? []
      if (topics.length < 3) continue
      const to = `0x${topics[2].slice(-40)}`.toLowerCase()
      if (to !== PAY_TO.toLowerCase()) continue
      const value = BigInt(log.data)
      const paidUsd = Number(value) / 1e6
      if (paidUsd + 1e-9 < priceUsd) {
        return { ok: false, reason: `paid $${paidUsd.toFixed(6)}, need $${priceUsd}` }
      }
      return { ok: true, asset: "USDC", amountUsd: paidUsd, tx: txHash }
    }
    return { ok: false, reason: "no payment to the payee found" }
  } catch (e) {
    return { ok: false, reason: e?.shortMessage ?? e?.message ?? String(e) }
  }
}
