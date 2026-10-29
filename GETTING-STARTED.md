# Getting started

Perps Funding Pulse is an HTTP API. It does not serve a web page or a websocket.

```bash
npm ci
cp .env.example .env
```

Set `X402_PAY_TO` in `.env` to the Base address that should receive USDC and ETH, then:

```bash
npm start
```

- `GET http://127.0.0.1:8780/health` — free status
- `POST http://127.0.0.1:8780/funding` — funding rates. The first calls in an hour are free; after that the response is 402 until the caller pays

Pay by sending USDC or ETH on Base to `X402_PAY_TO` and retrying with header `X-PAYMENT-TX: 0x<transaction hash>`.

Pricing, API keys, webhooks, and Docker/Render deploy steps are in [README.md](./README.md).

```bash
npm test
```

Tests do not need a wallet, an API key, or network access.
