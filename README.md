<div align="center">

# Perps Funding Pulse

[![CI](https://github.com/rustemmustafingovua-byte/perps-funding-pulse/actions/workflows/ci.yml/badge.svg)](https://github.com/rustemmustafingovua-byte/perps-funding-pulse/actions/workflows/ci.yml) [![npm](https://img.shields.io/npm/v/perps-funding-pulse?color=cb3837&logo=npm)](https://www.npmjs.com/package/perps-funding-pulse) [![license](https://img.shields.io/badge/license-MIT-8b949e?logo=opensourceinitiative)](./LICENSE)

</div>

---

**Live funding rates, next funding tick and open interest for perpetual futures — served over x402. Pay per call in USDC or ETH on Base.**

---

⭐ **Star us on GitHub** if this project helps you build better agents!

---

## 🚀 Быстрый старт

```bash
git clone https://github.com/rustemmustafingovua-byte/perps-funding-pulse
cd perps-funding-pulse && npm install
PORT=8780 PRICE_USD=0.001 X402_PAY_TO=0x8aC6a229f254980CCd3Dd35CF5E1B7c08880B40E npm start
```

---

## 🎯 Демо

```bash
curl https://perps-funding-pulse.lhr.life/health
curl -X POST https://perps-funding-pulse.lhr.life/funding \
  -H 'content-type: application/json' \
  -d '{"venue_ids":["binance","bybit","okx"],"markets":["BTC/USDT","ETH/USDT"]}'
```

---

## 💰 Монетизация

| Тариф | Лимит | Цена |
|---|---|---|
| Free | 20 вызовов/час на IP | $0 |
| Paid | 200 вызовов/час на ключ | $0.001/вызов (x402, USDC) |
| Enterprise | 1,000 вызовов/час на ключ | Договорная |

Сервис также поддерживает вебхуки на funding alerts и MCP-инструменты для управления ключами.

---

## Contributing

1. Fork the repo
2. Create a feature branch (`git checkout -b feat/amazing-thing`)
3. Commit your changes (`git commit -m 'feat: add amazing thing'`)
4. Push to the branch (`git push origin feat/amazing-thing`)
5. Open a Pull Request

Bug reports and feature requests are welcome on the [Issues](https://github.com/rustemmustafingovua-byte/perps-funding-pulse/issues) page.

MIT © rustemmustafingovua-byte
