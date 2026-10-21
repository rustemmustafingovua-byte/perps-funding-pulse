# perps-funding-pulse

**Live funding rates, next funding tick and open interest for perpetual futures — served over x402. Pay per call in USDC or ETH on Base.**

Bounty submission for [daydreamsai/agent-bounties#8 — Perps Funding Pulse](https://github.com/daydreamsai/agent-bounties/issues/8).

---

## Live deployment

| Endpoint | Method | Payment |
|---|---|---|
| `https://ef1c306574eed3.lhr.life/health` | GET | free |
| `https://ef1c306574eed3.lhr.life/funding` | POST | x402 — 0.001 USDC **or** native ETH on Base |

```bash
# 1) health — бесплатно
curl https://ef1c306574eed3.lhr.life/health

# 2) без оплаты сервис отвечает 402 + условиями оплаты
curl -i -X POST https://ef1c306574eed3.lhr.life/funding \
  -H 'content-type: application/json' \
  -d '{"venue_ids":["binance","bybit","okx"],"markets":["BTC/USDT","ETH/USDT"]}'

# 3) оплата transfer-and-prove: отправьте 0.001 USDC (или ETH) на payTo
#    и повторите запрос с заголовком X-PAYMENT-TX: <hash транзакции>
curl -X POST https://ef1c306574eed3.lhr.life/funding \
  -H 'content-type: application/json' \
  -H "x-payment-tx: 0x<tx hash>" \
  -d '{"venue_ids":["binance"],"markets":["BTC/USDT"]}'
```

The service verifies the payment on Base by reading the transaction
(native ETH transfer → `to == payTo`, or a USDC `Transfer` event → `to == payTo`).
**The client pays the gas; the server spends nothing.**

### MCP

Also listed in the official MCP Registry as
`io.github.rustemmustafingovua-byte/perps-funding-pulse`.

```bash
curl -X POST https://ef1c306574eed3.lhr.life/mcp \
  -H 'content-type: application/json' \
  -d '{"jsonrpc":"2.0","id":1,"method":"tools/call","params":{"name":"get_funding","arguments":{"venue_ids":["binance","bybit","okx"],"markets":["BTC/USDT","ETH/USDT"]}}}'
```

Tool: `get_funding` — same payload as `POST /funding`. The free tier allows 20 calls per
hour per IP; past that the endpoint answers `402` with the x402 terms, and
`/mcp/paid` always requires payment (send the transaction hash in `X-PAYMENT-TX`).

## What it returns

```json
{
  "venue": "binance",
  "market": "BTC/USDT",
  "funding_rate": 0.000052,
  "time_to_next": 20271,
  "open_interest": 95115.538,
  "skew": null,
  "mark_price": 104321.5,
  "ok": true
}
```

* `funding_rate` — current funding rate (fraction, per interval)
* `time_to_next` — seconds until the next funding payment
* `open_interest` — total open interest
* `skew` — long share of the long/short ratio (Bybit), `null` where the venue does not publish it
* `mark_price` — mark price when the venue exposes it

Venues: **Binance** (USDⓈ-M), **Bybit** (linear), **OKX** (swaps) — all through public
market-data endpoints, no API key, no account, no rate-limit cost.

## Acceptance criteria

- [x] **Matches venue UI data within acceptable tolerance** — every field is taken from the
      venue's own public market-data API (`fapi/v1/premiumIndex`, `/v5/market/tickers`,
      `/api/v5/public/funding-rate`), i.e. the same source the venue UI reads.
- [x] **Real-time or near real-time data updates** — no caching: every paid call queries the
      venues live. Verified: Binance/Bybit/OKX return `time_to_next` ≈ 20271 s / 20270 s / 49069 s
      (8 h / 4 h / 8 h intervals) on every request.
- [x] **Deployed on a domain and reachable via x402** — live at the URL above;
      `POST /funding` without payment returns **HTTP 402** with a `payment-required` header
      containing the x402 terms, and with a valid `X-PAYMENT-TX` it returns 200 + the data.
- [x] `GET /health` is free and returns status, venue list, price and payment address.
- [x] One venue failing does not break the response — its rows come back with `ok: false` and a reason.

## Run it yourself

```bash
npm install
PORT=8780 PRICE_USD=0.001 X402_PAY_TO=0xYourAddress npm start
```

| Variable | Default | Meaning |
|---|---|---|
| `PORT` | `8780` | HTTP port |
| `PRICE_USD` | `0.001` | price per paid call |
| `X402_PAY_TO` | `0x8aC6a229f254980CCd3Dd35CF5E1B7c08880B40E` | where payments go (Base) |
| `BASE_RPC` | `https://mainnet.base.org` | read-only RPC for payment verification |

## Tests

```bash
npm test
```

6 tests: venue normalisation, resilience to a dead venue, x402 terms shape, and two
negative payment-verification cases.

## Payment address (Solana)

```
6yqoKnxnSdZmAMhSAZMV6u9w8g9UDU322qjUnznRVCMA
```

## License

MIT
