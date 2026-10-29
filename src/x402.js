/**
 * x402 payments on Base mainnet (eip155:8453).
 *
 * Two ways to pay, both to the address in X402_PAY_TO:
 *
 * 1. Direct transfer. The caller sends USDC or native ETH, then repeats the
 *    request with X-PAYMENT-TX set to that transaction hash. This service
 *    only reads the chain. It does not hold a key and does not send a transaction.
 * 2. Standard x402 signature (PAYMENT-SIGNATURE / X-PAYMENT). An EIP-3009
 *    USDC authorization is checked here and settled by the facilitator in
 *    X402_FACILITATOR_URL. The public facilitator at x402.org does not settle
 *    Base mainnet; use a facilitator that supports eip155:8453.
 *
 * There is no built-in receiving address. If X402_PAY_TO is missing, paid
 * calls fail closed.
 */
import { getAddress, isAddress, verifyTypedData } from "viem"
import { claimPayment, hasPayment } from "./store.js"
import { paymentMaxAgeSeconds, priceUsd as configuredPrice } from "./config.js"

export const USDC_BASE = getAddress("0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913")
export const NETWORK = "eip155:8453"
const TRANSFER_TOPIC = "0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef"

const AUTHORIZATION_TYPES = {
  TransferWithAuthorization: [
    { name: "from", type: "address" },
    { name: "to", type: "address" },
    { name: "value", type: "uint256" },
    { name: "validAfter", type: "uint256" },
    { name: "validBefore", type: "uint256" },
    { name: "nonce", type: "bytes32" },
  ],
}

let ethCache = null

export function payToAddress() {
  const raw = process.env.X402_PAY_TO?.trim()
  if (!raw || !isAddress(raw)) return null
  try {
    return getAddress(raw)
  } catch {
    return null
  }
}

export function rpcUrl() {
  return process.env.BASE_RPC?.trim() || "https://mainnet.base.org"
}

/** Facilitator origin, or null when signatures cannot be settled. */
export function facilitatorUrl() {
  const raw = process.env.X402_FACILITATOR_URL?.trim()
  if (!raw) return null
  let url
  try {
    url = new URL(raw)
  } catch {
    return null
  }
  if (url.protocol !== "https:" && url.protocol !== "http:") return null
  if (process.env.NODE_ENV === "production" && url.protocol !== "https:") return null
  url.username = ""
  url.password = ""
  url.search = ""
  url.hash = ""
  url.pathname = url.pathname.replace(/\/+$/, "")
  return url.toString().replace(/\/+$/, "")
}

export function usdcAmount(usd) {
  return BigInt(Math.round(usd * 1e6))
}

export function ethAmountWei(usd, ethUsdPrice) {
  return BigInt(Math.ceil((usd / ethUsdPrice) * 1e18))
}

export async function ethUsd(fetchImpl = globalThis.fetch) {
  const override = Number(process.env.ETH_USD_PRICE)
  if (Number.isFinite(override) && override > 0) return override
  if (ethCache && Date.now() - ethCache.at < 60_000) return ethCache.usd
  const usd = await fetchEthUsd(fetchImpl)
  if (usd) {
    ethCache = { at: Date.now(), usd }
    return usd
  }
  return ethCache?.usd ?? null
}

async function fetchEthUsd(fetchImpl) {
  const sources = [
    ["https://api.binance.com/api/v3/ticker/price?symbol=ETHUSDT", (body) => Number(body?.price)],
    ["https://api.coingecko.com/api/v3/simple/price?ids=ethereum&vs_currencies=usd", (body) => Number(body?.ethereum?.usd)],
  ]
  for (const [url, read] of sources) {
    try {
      const res = await fetchImpl(url, { signal: AbortSignal.timeout(5000) })
      if (!res.ok) continue
      const usd = read(await res.json())
      if (usd > 0) return usd
    } catch {
      // try the next source
    }
  }
  return null
}

export async function paymentTerms(usd = configuredPrice(), { resource, fetchImpl } = {}) {
  const payTo = payToAddress()
  if (!payTo) {
    const error = new Error("payee_not_configured")
    error.code = "PAYEE_NOT_CONFIGURED"
    throw error
  }
  const price = usdcAmount(usd)
  const ethPrice = await ethUsd(fetchImpl)
  const direct = [
    { asset: USDC_BASE, amount: price.toString(), decimals: 6 },
  ]
  if (ethPrice) {
    direct.push({ asset: "ETH", amount: ethAmountWei(usd, ethPrice).toString(), decimals: 18, eth_usd: ethPrice })
  }
  return {
    x402Version: 2,
    error: "PAYMENT-SIGNATURE header is required",
    resource: {
      url: resource?.url || "/",
      description: resource?.description || "Live perpetual futures funding rates",
      mimeType: "application/json",
    },
    accepts: [
      {
        scheme: "exact",
        network: NETWORK,
        amount: price.toString(),
        asset: USDC_BASE,
        payTo,
        maxTimeoutSeconds: 300,
        extra: { name: "USD Coin", version: "2", assetTransferMethod: "eip3009" },
      },
    ],
    extensions: {
      direct: {
        header: "X-PAYMENT-TX",
        network: NETWORK,
        payTo,
        maxAgeSeconds: paymentMaxAgeSeconds(),
        options: direct,
      },
    },
  }
}

function payeeMissing() {
  return { ok: false, status: 503, reason: "payee_not_configured" }
}

function bad(status, reason) {
  return { ok: false, status, reason }
}

async function rpcCall(fetchImpl, method, params) {
  const res = await fetchImpl(rpcUrl(), {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
    signal: AbortSignal.timeout(15_000),
  })
  if (!res.ok) throw new Error(`Base RPC HTTP ${res.status}`)
  const body = await res.json()
  if (body?.error) throw new Error(body.error.message || "Base RPC error")
  return body?.result ?? null
}

function hexBigint(value) {
  if (typeof value === "bigint") return value
  if (typeof value !== "string" || !/^0x[0-9a-fA-F]*$/.test(value)) return null
  if (value === "0x" || value === "0x0") return 0n
  return BigInt(value)
}

/**
 * Read a confirmed Base transaction and decide whether it paid the payee.
 * Does not mark the transaction spent; the caller claims it after quotas pass.
 */
export async function inspectDirectPayment(txHash, { priceUsd, fetchImpl = globalThis.fetch } = {}) {
  const payTo = payToAddress()
  if (!payTo) return payeeMissing()
  if (!/^0x[0-9a-fA-F]{64}$/.test(String(txHash ?? ""))) {
    return bad(402, "missing or malformed transaction hash")
  }
  const id = txHash.toLowerCase()
  if (hasPayment(id)) return bad(402, "payment already used")

  let tx
  let receipt
  let block
  try {
    tx = await rpcCall(fetchImpl, "eth_getTransactionByHash", [txHash])
    if (!tx) return bad(402, "transaction not found")
    receipt = await rpcCall(fetchImpl, "eth_getTransactionReceipt", [txHash])
    if (!receipt) return bad(402, "transaction not confirmed")
    if (!tx.blockNumber) return bad(402, "transaction not confirmed")
    block = await rpcCall(fetchImpl, "eth_getBlockByNumber", [tx.blockNumber, false])
  } catch (error) {
    return bad(503, "base_rpc_unavailable")
  }

  const status = hexBigint(receipt.status)
  if (status !== 1n) return bad(402, "transaction failed")
  const timestamp = hexBigint(block?.timestamp)
  if (timestamp == null) return bad(402, "transaction not confirmed")
  const age = Math.floor(Date.now() / 1000) - Number(timestamp)
  const maxAge = paymentMaxAgeSeconds()
  if (age > maxAge) return bad(402, "payment too old")
  if (age < -120) return bad(402, "payment timestamp is in the future")

  const needUsdc = usdcAmount(priceUsd)
  let ethFailure = null
  const to = typeof tx.to === "string" ? tx.to : ""
  const value = hexBigint(tx.value) ?? 0n
  if (to && to.toLowerCase() === payTo.toLowerCase() && value > 0n) {
    const usd = await ethUsd(fetchImpl)
    if (!usd) return bad(503, "eth_price_unavailable")
    const needWei = ethAmountWei(priceUsd, usd)
    if (value >= needWei) {
      const paidUsd = (Number(value) / 1e18) * usd
      return {
        ok: true,
        via: "direct",
        asset: "ETH",
        amountUsd: paidUsd,
        tx: txHash,
        payer: tx.from || null,
        id,
      }
    }
    const paidUsd = (Number(value) / 1e18) * usd
    ethFailure = `paid $${paidUsd.toFixed(6)}, need $${priceUsd}`
  }

  let shortPay = null
  for (const log of receipt.logs || []) {
    if (String(log.address || "").toLowerCase() !== USDC_BASE.toLowerCase()) continue
    if (String(log.topics?.[0] || "").toLowerCase() !== TRANSFER_TOPIC) continue
    const topics = log.topics || []
    if (topics.length < 3 || String(topics[2]).length < 42) continue
    const recipient = `0x${String(topics[2]).slice(-40)}`.toLowerCase()
    if (recipient !== payTo.toLowerCase()) continue
    const paid = hexBigint(log.data)
    if (paid == null) continue
    if (paid < needUsdc) {
      shortPay = `paid $${(Number(paid) / 1e6).toFixed(6)}, need $${priceUsd}`
      continue
    }
    return {
      ok: true,
      via: "direct",
      asset: "USDC",
      amountUsd: Number(paid) / 1e6,
      tx: txHash,
      payer: tx.from || null,
      id,
    }
  }
  return bad(402, shortPay || ethFailure || "no payment to the payee found")
}

function asBigint(value) {
  if (typeof value === "bigint") return value
  if (typeof value === "number" && Number.isFinite(value)) return BigInt(Math.trunc(value))
  if (typeof value === "string" && /^(0x[0-9a-fA-F]+|\d+)$/.test(value)) return BigInt(value)
  return null
}

function decodePaymentHeader(value) {
  const raw = String(value ?? "").trim()
  if (!raw) return null
  if (raw.startsWith("{")) {
    try {
      return JSON.parse(raw)
    } catch {
      return null
    }
  }
  try {
    const text = Buffer.from(raw, "base64").toString("utf8")
    if (!text.trim().startsWith("{")) return null
    return JSON.parse(text)
  } catch {
    return null
  }
}

function usdcDomain() {
  return {
    name: "USD Coin",
    version: "2",
    chainId: 8453,
    verifyingContract: USDC_BASE,
  }
}

function signatureLocallyValid(authorization, signature) {
  try {
    return verifyTypedData({
      address: getAddress(authorization.from),
      domain: usdcDomain(),
      types: AUTHORIZATION_TYPES,
      primaryType: "TransferWithAuthorization",
      message: {
        from: getAddress(authorization.from),
        to: getAddress(authorization.to),
        value: asBigint(authorization.value),
        validAfter: asBigint(authorization.validAfter),
        validBefore: asBigint(authorization.validBefore),
        nonce: authorization.nonce,
      },
      signature,
    })
  } catch {
    return false
  }
}

/** Local checks for an x402 exact/EIP-3009 payload. Does not settle and does not spend the nonce. */
export async function inspectSignedPayment(headerValue, { priceUsd } = {}) {
  const payTo = payToAddress()
  if (!payTo) return payeeMissing()
  const payload = decodePaymentHeader(headerValue)
  if (!payload || typeof payload !== "object") return bad(400, "malformed payment payload")

  const accepted = payload.accepted && typeof payload.accepted === "object" ? payload.accepted : payload
  const authorization = payload.payload?.authorization
  const signature = payload.payload?.signature
  if (!authorization || typeof signature !== "string") return bad(400, "malformed payment payload")

  const scheme = accepted.scheme || payload.scheme
  const network = accepted.network || payload.network
  const asset = accepted.asset || payload.asset || USDC_BASE
  if (scheme && scheme !== "exact") return bad(402, "unsupported scheme")
  if (network && network !== NETWORK && network !== "base") return bad(402, "unsupported network")
  if (!isAddress(asset) || getAddress(asset) !== USDC_BASE) return bad(402, "unsupported asset")

  const declaredPayee = accepted.payTo || payload.payTo
  if (declaredPayee && (!isAddress(declaredPayee) || getAddress(declaredPayee) !== payTo)) {
    return bad(402, "payee mismatch")
  }
  if (!isAddress(authorization.from) || !isAddress(authorization.to)) return bad(400, "malformed payment payload")
  if (getAddress(authorization.to) !== payTo) return bad(402, "authorization payee mismatch")

  const value = asBigint(authorization.value)
  const validAfter = asBigint(authorization.validAfter)
  const validBefore = asBigint(authorization.validBefore)
  if (value == null || validAfter == null || validBefore == null) return bad(400, "malformed payment payload")
  if (!/^0x[0-9a-fA-F]{64}$/.test(String(authorization.nonce || ""))) return bad(400, "malformed payment payload")
  if (!/^0x[0-9a-fA-F]+$/.test(signature) || signature.length < 10) return bad(400, "malformed payment payload")

  const declared = asBigint(accepted.amount ?? accepted.maxAmountRequired ?? payload.maxAmountRequired)
  const need = usdcAmount(priceUsd)
  if (value < need || (declared != null && declared < need)) return bad(402, "amount too low")

  const now = BigInt(Math.floor(Date.now() / 1000))
  if (validBefore <= now) return bad(402, "authorization expired")
  if (validAfter > now) return bad(402, "authorization not yet valid")

  const id = String(authorization.nonce).toLowerCase()
  if (hasPayment(id)) return bad(402, "payment already used")

  const ecdsaBytes = (signature.length - 2) / 2
  if (!signatureLocallyValid(authorization, signature) && ecdsaBytes === 65) {
    return bad(402, "invalid signature")
  }

  return {
    ok: true,
    payload,
    authorization,
    id,
    amountUsd: Number(value) / 1e6,
    payer: getAddress(authorization.from),
  }
}

function facilitatorHeaders() {
  const headers = { "content-type": "application/json" }
  const auth = process.env.X402_FACILITATOR_AUTH?.trim()
  if (!auth) return headers
  const headerName = process.env.X402_FACILITATOR_AUTH_HEADER?.trim() || "authorization"
  headers[headerName] = auth.includes(" ") ? auth : `Bearer ${auth}`
  return headers
}

async function postFacilitator(path, body, fetchImpl) {
  const base = facilitatorUrl()
  if (!base) return { ok: false, status: 402, reason: "facilitator_not_configured" }
  let res
  try {
    res = await fetchImpl(`${base}${path}`, {
      method: "POST",
      headers: facilitatorHeaders(),
      body: JSON.stringify(body),
      redirect: "error",
      signal: AbortSignal.timeout(20_000),
    })
  } catch {
    return bad(503, "facilitator_unavailable")
  }
  let parsed = null
  try {
    parsed = await res.json()
  } catch {
    parsed = null
  }
  if (!res.ok) {
    const reason = parsed?.errorReason || parsed?.invalidReason || parsed?.error || `facilitator HTTP ${res.status}`
    return bad(res.status >= 500 ? 503 : 402, String(reason))
  }
  return { ok: true, body: parsed || {} }
}

function settled(body) {
  return body?.success === true || body?.isValid === true
}

async function settleSignature(inspected, { fetchImpl, resource }) {
  const version = Number(inspected.payload.x402Version) || (inspected.payload.accepted ? 2 : 1)
  const requirements = inspected.payload.accepted
    ? inspected.payload.accepted
    : {
        scheme: "exact",
        network: "base",
        maxAmountRequired: String(asBigint(inspected.authorization.value)),
        resource: resource?.url,
        description: resource?.description,
        mimeType: "application/json",
        payTo: payToAddress(),
        asset: USDC_BASE,
        maxTimeoutSeconds: 300,
        extra: { name: "USD Coin", version: "2" },
      }
  const request = {
    x402Version: version,
    paymentPayload: inspected.payload,
    paymentRequirements: requirements,
  }
  const verified = await postFacilitator("/verify", request, fetchImpl)
  if (!verified.ok) return verified
  if (!settled(verified.body)) {
    return bad(402, verified.body.invalidReason || verified.body.errorReason || verified.body.error || "verification failed")
  }
  const result = await postFacilitator("/settle", request, fetchImpl)
  if (!result.ok) return result
  if (!settled(result.body)) {
    return bad(402, result.body.errorReason || result.body.invalidReason || result.body.error || "settlement failed")
  }
  const tx = result.body.transaction || result.body.transactionHash || null
  return {
    ok: true,
    via: "x402",
    asset: "USDC",
    amountUsd: inspected.amountUsd,
    tx,
    payer: result.body.payer || inspected.payer,
    id: inspected.id,
  }
}

/**
 * Verify a direct transfer or settle an x402 signature.
 * `beforeSettle` may return an error object to stop before money moves or a tx is consumed.
 */
export async function acceptPayment({ txHash, signature, priceUsd, resource, fetchImpl = globalThis.fetch, beforeSettle } = {}) {
  if (!signature && !txHash) return bad(402, "payment_required")
  if (signature) {
    const inspected = await inspectSignedPayment(signature, { priceUsd })
    if (!inspected.ok) return inspected
    if (beforeSettle) {
      const gate = await beforeSettle(inspected)
      if (gate) return gate
    }
    if (!facilitatorUrl()) return bad(402, "facilitator_not_configured")
    const settledPayment = await settleSignature(inspected, { fetchImpl, resource })
    if (!settledPayment.ok) return settledPayment
    if (!claimPayment(inspected.id)) return bad(402, "payment already used")
    if (settledPayment.tx && !claimPayment(settledPayment.tx)) return bad(402, "payment already used")
    return settledPayment
  }

  const direct = await inspectDirectPayment(txHash, { priceUsd, fetchImpl })
  if (!direct.ok) return direct
  if (beforeSettle) {
    const gate = await beforeSettle(direct)
    if (gate) return gate
  }
  if (!claimPayment(direct.id)) return bad(402, "payment already used")
  return direct
}
