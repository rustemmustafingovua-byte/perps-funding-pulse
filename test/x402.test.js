import { test } from "node:test"
import assert from "node:assert/strict"
import { readFileSync } from "node:fs"
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts"
import {
  USDC_BASE,
  acceptPayment,
  ethAmountWei,
  facilitatorUrl,
  inspectDirectPayment,
  payToAddress,
  paymentTerms,
  usdcAmount,
} from "../src/x402.js"
import { hasPayment, resetStore } from "../src/store.js"

const PAYEE = "0x1111111111111111111111111111111111111111"
const OTHER = "0x2222222222222222222222222222222222222222"
const TRANSFER_TOPIC = "0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef"

delete process.env.DATA_FILE
resetStore()
process.env.X402_PAY_TO = PAYEE
process.env.ETH_USD_PRICE = "3000"
delete process.env.X402_FACILITATOR_URL
delete process.env.X402_FACILITATOR_AUTH
process.env.NODE_ENV = "test"

function word(value) {
  return `0x${BigInt(value).toString(16).padStart(64, "0")}`
}

function topicAddress(address) {
  return `0x${address.toLowerCase().slice(2).padStart(64, "0")}`
}

function nowBlock(offsetSeconds = 0) {
  return { timestamp: `0x${(Math.floor(Date.now() / 1000) + offsetSeconds).toString(16)}` }
}

let hashSeq = 0
function nextHash() {
  hashSeq += 1
  return `0x${hashSeq.toString(16).padStart(64, "ab")}`
}

function rpcFetch(scene) {
  return async (_url, opts) => {
    const body = JSON.parse(opts.body)
    const table = {
      eth_getTransactionByHash: scene.tx,
      eth_getTransactionReceipt: scene.receipt,
      eth_getBlockByNumber: scene.block,
    }
    if (!(body.method in table)) throw new Error(body.method)
    return Response.json({ jsonrpc: "2.0", id: 1, result: table[body.method] })
  }
}

function usdcScene({ to = payToAddress(), amount = 1000n, hash = nextHash(), block = nowBlock() }) {
  return {
    hash,
    tx: { hash, from: OTHER, to: USDC_BASE, value: "0x0", blockNumber: "0x10" },
    receipt: {
      status: "0x1",
      blockNumber: "0x10",
      logs: [{
        address: USDC_BASE,
        topics: [TRANSFER_TOPIC, topicAddress(OTHER), topicAddress(to)],
        data: word(amount),
      }],
    },
    block,
  }
}

function ethScene({ to = payToAddress(), value, hash = nextHash(), block = nowBlock(), status = "0x1" }) {
  return {
    hash,
    tx: { hash, from: OTHER, to, value: word(value), blockNumber: "0x10" },
    receipt: { status, blockNumber: "0x10", logs: [] },
    block,
  }
}

test("payment terms quote USDC on Base and a direct ETH amount", async () => {
  const terms = await paymentTerms(0.001)
  assert.equal(terms.x402Version, 2)
  assert.equal(terms.accepts.length, 1)
  const usdc = terms.accepts[0]
  assert.equal(usdc.scheme, "exact")
  assert.equal(usdc.network, "eip155:8453")
  assert.equal(usdc.asset, USDC_BASE)
  assert.equal(usdc.payTo, payToAddress())
  assert.equal(usdc.amount, "1000")
  assert.equal(usdcAmount(0.001), 1000n)
  const eth = terms.extensions.direct.options.find((option) => option.asset === "ETH")
  assert.equal(eth.amount, ethAmountWei(0.001, 3000).toString())
  assert.equal(terms.extensions.direct.header, "X-PAYMENT-TX")
})

test("a missing or invalid payee fails closed", async () => {
  const saved = process.env.X402_PAY_TO
  process.env.X402_PAY_TO = ""
  assert.equal(payToAddress(), null)
  await assert.rejects(paymentTerms(0.001), /payee_not_configured/)
  process.env.X402_PAY_TO = "not-an-address"
  assert.equal(payToAddress(), null)
  process.env.X402_PAY_TO = saved
})

test("source does not embed a receiving address", () => {
  const source = readFileSync(new URL("../src/x402.js", import.meta.url), "utf8")
  assert.equal(source.includes("0x8aC6a229f254980CCd3Dd35CF5E1B7c08880B40E"), false)
  assert.equal(source.includes("X402_PAY_TO"), true)
})

test("direct USDC payment is accepted once", async () => {
  const scene = usdcScene({})
  const first = await acceptPayment({
    txHash: scene.hash,
    priceUsd: 0.001,
    fetchImpl: rpcFetch(scene),
  })
  assert.equal(first.ok, true)
  assert.equal(first.asset, "USDC")
  assert.equal(first.amountUsd, 0.001)
  assert.equal(hasPayment(scene.hash), true)
  const second = await acceptPayment({
    txHash: scene.hash,
    priceUsd: 0.001,
    fetchImpl: rpcFetch(scene),
  })
  assert.equal(second.ok, false)
  assert.equal(second.reason, "payment already used")
})

test("underpaid, misdirected, failed, stale, and malformed transfers are rejected", async () => {
  const short = usdcScene({ amount: 999n })
  const under = await inspectDirectPayment(short.hash, { priceUsd: 0.001, fetchImpl: rpcFetch(short) })
  assert.equal(under.ok, false)
  assert.match(under.reason, /need \$0\.001/)
  assert.equal(hasPayment(short.hash), false)

  const wrong = usdcScene({ to: OTHER })
  const missed = await inspectDirectPayment(wrong.hash, { priceUsd: 0.001, fetchImpl: rpcFetch(wrong) })
  assert.equal(missed.reason, "no payment to the payee found")

  const wei = ethAmountWei(0.001, 3000)
  const exact = ethScene({ value: wei })
  const paid = await inspectDirectPayment(exact.hash, { priceUsd: 0.001, fetchImpl: rpcFetch(exact) })
  assert.equal(paid.ok, true)
  assert.equal(paid.asset, "ETH")

  const tiny = ethScene({ value: 1n })
  const cheap = await inspectDirectPayment(tiny.hash, { priceUsd: 0.001, fetchImpl: rpcFetch(tiny) })
  assert.equal(cheap.ok, false)

  const failed = ethScene({ value: wei, status: "0x0" })
  const reverted = await inspectDirectPayment(failed.hash, { priceUsd: 0.001, fetchImpl: rpcFetch(failed) })
  assert.equal(reverted.reason, "transaction failed")

  const stale = ethScene({ value: wei, block: nowBlock(-10_000) })
  const old = await inspectDirectPayment(stale.hash, { priceUsd: 0.001, fetchImpl: rpcFetch(stale) })
  assert.equal(old.reason, "payment too old")
  assert.equal(hasPayment(stale.hash), false)

  const broken = await inspectDirectPayment("0xdeadbeef", { priceUsd: 0.001, fetchImpl: rpcFetch(exact) })
  assert.equal(broken.reason, "missing or malformed transaction hash")
})

test("rate limit gate does not spend a valid transfer", async () => {
  const scene = usdcScene({})
  const blocked = await acceptPayment({
    txHash: scene.hash,
    priceUsd: 0.001,
    fetchImpl: rpcFetch(scene),
    beforeSettle: async () => ({ ok: false, status: 429, reason: "rate_limit_exceeded" }),
  })
  assert.equal(blocked.status, 429)
  assert.equal(hasPayment(scene.hash), false)
  const later = await acceptPayment({
    txHash: scene.hash,
    priceUsd: 0.001,
    fetchImpl: rpcFetch(scene),
  })
  assert.equal(later.ok, true)
})

async function signedHeader({ to, value = 1000n }) {
  const account = privateKeyToAccount(generatePrivateKey())
  const nonce = `0x${Buffer.from(crypto.getRandomValues(new Uint8Array(32))).toString("hex")}`
  const validBefore = BigInt(Math.floor(Date.now() / 1000) + 300)
  const authorization = {
    from: account.address,
    to,
    value: value.toString(),
    validAfter: "0",
    validBefore: validBefore.toString(),
    nonce,
  }
  const signature = await account.signTypedData({
    domain: {
      name: "USD Coin",
      version: "2",
      chainId: 8453,
      verifyingContract: USDC_BASE,
    },
    types: {
      TransferWithAuthorization: [
        { name: "from", type: "address" },
        { name: "to", type: "address" },
        { name: "value", type: "uint256" },
        { name: "validAfter", type: "uint256" },
        { name: "validBefore", type: "uint256" },
        { name: "nonce", type: "bytes32" },
      ],
    },
    primaryType: "TransferWithAuthorization",
    message: { from: account.address, to, value, validAfter: 0n, validBefore, nonce },
  })
  const payload = {
    x402Version: 2,
    accepted: {
      scheme: "exact",
      network: "eip155:8453",
      amount: value.toString(),
      asset: USDC_BASE,
      payTo: to,
      maxTimeoutSeconds: 300,
      extra: { name: "USD Coin", version: "2" },
    },
    payload: { signature, authorization },
  }
  return { header: Buffer.from(JSON.stringify(payload)).toString("base64"), nonce }
}

function facilitatorFetch() {
  const calls = []
  const fetchImpl = async (url, opts = {}) => {
    calls.push({ url: String(url), headers: opts.headers })
    if (String(url).endsWith("/verify")) return Response.json({ isValid: true, payer: OTHER })
    if (String(url).endsWith("/settle")) {
      return Response.json({
        success: true,
        transaction: `0x${"cd".repeat(32)}`,
        network: "eip155:8453",
        payer: OTHER,
      })
    }
    throw new Error(`unexpected ${url}`)
  }
  return { fetchImpl, calls }
}

test("x402 signatures settle through the facilitator and cannot be replayed", async () => {
  process.env.X402_FACILITATOR_URL = "http://facilitator.test/base/"
  process.env.X402_FACILITATOR_AUTH = "test-facilitator-token"
  const { fetchImpl, calls } = facilitatorFetch()
  const { header, nonce } = await signedHeader({ to: payToAddress() })
  const first = await acceptPayment({ signature: header, priceUsd: 0.001, fetchImpl })
  assert.equal(first.ok, true)
  assert.equal(first.via, "x402")
  assert.equal(first.asset, "USDC")
  assert.equal(calls.length, 2)
  assert.equal(calls[0].headers.authorization, "Bearer test-facilitator-token")
  assert.equal(hasPayment(nonce), true)
  const second = await acceptPayment({ signature: header, priceUsd: 0.001, fetchImpl })
  assert.equal(second.reason, "payment already used")
  assert.equal(calls.length, 2)
  delete process.env.X402_FACILITATOR_AUTH
})

test("a signature for the wrong payee never reaches the facilitator", async () => {
  process.env.X402_FACILITATOR_URL = "http://facilitator.test/base"
  const { fetchImpl, calls } = facilitatorFetch()
  const { header } = await signedHeader({ to: OTHER })
  const result = await acceptPayment({ signature: header, priceUsd: 0.001, fetchImpl })
  assert.equal(result.ok, false)
  assert.equal(result.reason, "payee mismatch")
  assert.equal(calls.length, 0)
})

test("signatures wait for a facilitator instead of being treated as paid", async () => {
  delete process.env.X402_FACILITATOR_URL
  const { header, nonce } = await signedHeader({ to: payToAddress() })
  const waiting = await acceptPayment({
    signature: header,
    priceUsd: 0.001,
    fetchImpl: async () => {
      throw new Error("facilitator should not be called")
    },
  })
  assert.equal(waiting.reason, "facilitator_not_configured")
  assert.equal(hasPayment(nonce), false)
  process.env.NODE_ENV = "production"
  process.env.X402_FACILITATOR_URL = "http://facilitator.test/base"
  assert.equal(facilitatorUrl(), null)
  process.env.NODE_ENV = "test"
  delete process.env.X402_FACILITATOR_URL
})
