# Changelog

## [0.3.0] - 2026-10-29

### Fixed

- The receiving address comes only from `X402_PAY_TO`. Paid calls fail closed when it is missing.
- A successful paid call no longer crashes while recording usage.
- A Base transaction or x402 nonce can be redeemed once, and only if it is recent.
- API keys cannot skip payment, and a key id without the secret is rejected.
- Free, paid, and enterprise limits follow the published price list. Extra free keys do not raise the per-IP cap.

### Added

- x402 `PAYMENT-REQUIRED` / `PAYMENT-SIGNATURE` / `PAYMENT-RESPONSE` on Base, settled by a facilitator you configure.
- Direct USDC and ETH verification for callers who submit the transfer themselves.
- Dockerfile, Render blueprint, and `.env.example`.
- End-to-end tests for the funding API and both payment methods. CI no longer depends on venue or chain uptime.

## [0.2.0]

### Added

- API keys, usage totals, webhooks, and an MCP wrapper.

## [0.1.0]

### Added

- Initial public release of the funding endpoint and x402 terms.
