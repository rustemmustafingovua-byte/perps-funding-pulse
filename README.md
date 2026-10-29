# Perps Funding Pulse

Live funding rates, time to the next funding tick, and open interest for perpetual futures on Binance, Bybit, and OKX. Callers pay per request in USDC or ETH on Base.

`GET /health` is free. `POST /funding` includes a small hourly preview, then returns HTTP 402 until the call is paid.

## Pricing

The default price is **$0.001 per paid call** (`PRICE_USD`). USDC uses 6 decimals, so that is **1000** base units of USDC (`0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913` on Base). ETH is quoted from the current ETH/USD rate.

| Access | Unpaid calls | After that | Hard cap |
|---|---|---|---|
| No API key | 20 / hour / IP | $0.001 per call | 200 paid calls / hour / IP |
| Free key | 20 / hour / key, and still 20 / hour / IP | $0.001 per call | 200 paid calls / hour / key |
| Paid key | none | $0.001 per call | 200 / hour / key |
| Enterprise key | 1000 / hour / key, invoiced off-chain | no per-call crypto charge | 1000 / hour / key |

Free, paid, and enterprise caps are `FREE_LIMIT`, `PAID_LIMIT`, and `ENTERPRISE_LIMIT`. Every IP is also limited to `FUNDING_RPM` requests per minute (default 30) so a burst cannot hammer the venues.

Minting extra free keys does not raise the IP cap. Paid and enterprise keys can only be created with `ADMIN_TOKEN`. A key id is not a credential: the secret after the second underscore has to match.

## Setup

Requires Node.js 20 or newer.

```bash
git clone https://github.com/rustemmustafingovua-byte/perps-funding-pulse.git
cd perps-funding-pulse
npm ci
cp .env.example .env
```

Edit `.env`:

- `X402_PAY_TO` — your Base address. Paid calls fail until this is set. Nothing in the repo is a fallback address.
- `ADMIN_TOKEN` — long random string. Required to issue paid or enterprise keys and to read `GET /keys` and `GET /usage`.
- `PRICE_USD` — price per paid call. Default `0.001`.
- `BASE_RPC` — Base mainnet HTTPS endpoint. The public `https://mainnet.base.org` endpoint is fine to start; use your own for production volume.
- `DATA_FILE` — where spent payment ids, keys, and quotas are stored. Point this at a persistent disk.

```bash
npm start
```

The process listens on `PORT` (default `8780`).

```bash
curl -s http://127.0.0.1:8780/health
```

`payee_configured` is `false` until `X402_PAY_TO` is a valid address. `status` is then `degraded`, and a call that needs payment returns 503 instead of 402.

## Calling the API

```bash
curl -s -X POST http://127.0.0.1:8780/funding \
  -H 'content-type: application/json' \
  -d '{"venue_ids":["binance","bybit","okx"],"markets":["BTC/USDT","ETH/USDT"]}'
```

`BTC/USDT` is normalized per venue (`BTCUSDT` on Binance and Bybit, `BTC-USDT-SWAP` on OKX). The host must be able to reach `fapi.binance.com`, `api.bybit.com`, and `www.okx.com`. One venue failing does not drop the others; that row comes back with `ok: false`.

Each result row has:

- `funding_rate` — current funding rate as a fraction (`0.0001` is 0.01%)
- `time_to_next` — seconds until the next funding timestamp
- `open_interest`
- `mark_price` where the venue publishes one
- `skew` — long share of the long/short ratio, where the venue publishes one

While the hourly preview remains, the response is `200` and `payment.via` is `free`. After that the response is **402** with a `PAYMENT-REQUIRED` header (base64 JSON, x402 version 2) and the same object in the body.

### Pay with a direct transfer

This path needs no facilitator and no server-side key. The server only reads Base.

1. Send at least `PRICE_USD` of USDC, or the ETH amount in `terms.extensions.direct`, to `pay_to` on Base.
2. Wait until the transaction is in a block. It must be less than `PAYMENT_MAX_AGE_SECONDS` old (default 15 minutes).
3. Repeat the request with the transaction hash:

```bash
curl -s -X POST http://127.0.0.1:8780/funding \
  -H 'content-type: application/json' \
  -H 'x-payment-tx: 0xYOUR_TX_HASH' \
  -d '{"markets":["BTC/USDT"]}'
```

A hash can be redeemed once. That ledger is the `payments` list in `DATA_FILE`. Restarting without that file would allow the same hash to be used again, so mount a volume.

### Pay with an x402 client

Standard clients send `PAYMENT-SIGNATURE` (v2) or `X-PAYMENT` (v1): an EIP-3009 `transferWithAuthorization` for USDC on Base (`eip155:8453`). The signature is checked locally. Settlement is done by the facilitator in `X402_FACILITATOR_URL`, which is what actually submits the transfer.

The public facilitator at `https://x402.org/facilitator` does **not** settle Base mainnet. It lists Base Sepolia only. For mainnet signatures, set:

```bash
X402_FACILITATOR_URL=https://api.cdp.coinbase.com/platform/v2/x402
X402_FACILITATOR_AUTH='Bearer YOUR_CDP_TOKEN'
```

`X402_FACILITATOR_AUTH` is sent as the `Authorization` header (a raw token is prefixed with `Bearer `). Use `X402_FACILITATOR_AUTH_HEADER` if the facilitator expects a different header name. In production the facilitator URL must be `https`.

If the facilitator is unset, a signature is rejected with `facilitator_not_configured` and the nonce is not burned. Direct `X-PAYMENT-TX` payments still work.

A successful paid call includes a `PAYMENT-RESPONSE` header.

## Other routes

| Method and path | Auth | What it does |
|---|---|---|
| `GET /health` | none | Status, venues, price, payee |
| `POST /funding` | optional key, payment after the free cap | Funding data |
| `POST /mcp` | none, `FREE_LIMIT` / hour / IP | Free MCP preview (JSON-RPC) |
| `POST /mcp/paid` | payment on every call | Paid MCP |
| `POST /keys` | admin token for `paid` and `enterprise` | Create a key. The secret is returned once |
| `GET /keys` | `X-Admin-Token` | Metadata only |
| `DELETE /keys/:id` | that key, or admin | Revoke |
| `GET /usage` | admin | Request counts and USD collected |
| `POST /webhooks` | API key | Funding alert URL |
| `GET /webhooks`, `DELETE /webhooks/:id` | that key, or admin | List or remove |

Webhook `threshold_pct` is an absolute funding rate. `0.0001` means 0.01%. Alerts are evaluated when `/funding` is called; there is no background poll. The URL has to be public `http` or `https`. Localhost, link-local, and private addresses are rejected. Register only URLs you control.

Set `TRUST_PROXY=1` when a reverse proxy overwrites `X-Forwarded-For` (Render does). Leave it unset if clients connect straight to the process, or they can rotate the header and get a fresh free quota.

`GET /usage` with the admin token is how you see what has been collected.

## Deploy

### Docker

```bash
docker build -t perps-funding-pulse .
docker run --rm -p 8780:8780 \
  -e X402_PAY_TO=0xYourBaseAddress \
  -e ADMIN_TOKEN="$(openssl rand -hex 32)" \
  -e PRICE_USD=0.001 \
  -e BASE_RPC=https://mainnet.base.org \
  -e DATA_FILE=/data/state.json \
  -v perps-data:/data \
  perps-funding-pulse
```

The image listens on 8780, drops to the `node` user after fixing ownership of the data directory, and healthchecks `GET /health`. Put TLS in front of it (Caddy, nginx, or the host's load balancer). Do not commit `.env`.

### Render

`render.yaml` defines a Docker web service, a 1 GB disk mounted at `/data`, and `TRUST_PROXY=1`.

1. Push this repo and create a Render Blueprint from `render.yaml`, or create a Web Service with runtime Docker.
2. Set `X402_PAY_TO` and `ADMIN_TOKEN` in the dashboard. They are not in the file.
3. Confirm the disk is mounted at `/data` so `DATA_FILE=/data/state.json` survives deploys.
4. Open `https://<your-service>.onrender.com/health` and check `payee_configured` is true.
5. Attach your domain in Render and use that origin in client requests.

This service is a long-running Node process with a local state file. A serverless host that freezes the process between calls will forget in-memory state if `DATA_FILE` is not on a persistent disk, and it will not hold the HTTP server open. Docker or Render is the path this repo ships.

## Tests

`npm test` does not call the venues, Base, or a facilitator, and it does not need a wallet or an API key. `npm run lint` and `npm run build` syntax-check the source. CI runs all three on Node 20, 22, and 24. One Node version failing does not cancel the others.

To hit Binance for real:

```bash
LIVE_SMOKE=1 node --test test/venues.test.js
```

## What the operator still has to provide

The repo cannot know your wallet, your RPC budget, or your domain.

1. Put your Base receiving address in `X402_PAY_TO`.
2. Set `ADMIN_TOKEN` and keep it out of git.
3. Point `DATA_FILE` at a persistent disk.
4. Set `TRUST_PROXY=1` if you deploy behind Render or another proxy.
5. Optionally set `BASE_RPC` to your own Base endpoint.
6. To take standard x402 signatures (agent wallets that send `PAYMENT-SIGNATURE`), add a Base-mainnet facilitator URL and its auth token. Direct transfers work without that.
7. Deploy with Docker or Render and put HTTPS on your domain.
8. Send $0.001 of USDC (or the quoted ETH) to your address, retry with `X-PAYMENT-TX`, and confirm `GET /usage` shows the dollar amount.

No private key belongs in this service for the direct-payment path. Do not put a seed phrase or settler key in the environment.
