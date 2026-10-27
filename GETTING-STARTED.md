# Perps Funding Pulse — Быстрый старт

## Что это
Real-time трекер funding rate для perpetual futures на Base.

## Установка (1 минута)
```bash
cd /tmp/perps-funding-pulse
npm install
```

## Запуск (2 минуты)
```bash
npm start
# Сервис запущен на http://localhost:3000
```

## Использование
- Открой http://localhost:3000 — увидишь funding rates
- API: `GET /api/funding` — JSON с текущими rates
- WebSocket:实时 更新

## x402 монетизация
- Бесплатные endpoints: `/api/public/*`
- Платные: `/api/funding` (100 LMN), `/api/alerts` (50 LMN)

## Документация
- README.md — полное описание
- test/ — 27 тестов

## Следующие шаги
1. Добавь токены в `.env`
2. Настрой webhook для алертов
3. Интегрируй с lumen-chain x402

## Troubleshooting
- Port 3000 занят? → `PORT=3001 npm start`
- Tests fail? → `npm install` заново
