# Funding Arbitrage Scanner

Локальное веб-приложение для сканирования арбитража фандинга между **Gate.io isolated margin** (сторона Short) и **USDT perpetual фьючерсами** на 10 биржах (сторона Long).

## Быстрый старт

```bash
# 1. Установить зависимости
npm install

# 2. Запустить
npm run dev

# 3. Открыть в браузере
# http://localhost:3000
```

---

## Стратегия

| Сторона | Позиция | Описание |
|---------|---------|----------|
| **Long** | Фьючерсы (USDT perp) | Binance / OKX / Bybit / Gate / Bitget / BingX / XT / MEXC / BitMart / KuCoin |
| **Short** | Gate.io isolated margin | Всегда Gate; шорт через заём токена |

**Логика:** Когда funding rate положительный — лонги платят шортам. Открывая лонг на фьючерсах и шорт на Gate margin, вы получаете funding и платите только стоимость заёма.

**Net APR = Funding APR − Borrow APR**

---

## Формулы

### Funding APR (% годовых)
```
Funding APR = rawFundingRate × (8760 / intervalHours) × 100
```
- `rawFundingRate` — ставка с биржи как decimal (напр. 0.0001 = 0.01%)
- `intervalHours` — интервал фандинга у каждой биржи (1, 4 или 8 часов)
- 8760 — количество часов в году

**Примеры:**
- Binance BTC funding = 0.00002 каждые 8ч → APR = 0.00002 × (8760/8) × 100 = **2.19%**
- BingX token funding = 0.0005 каждые 1ч → APR = 0.0005 × 8760 × 100 = **438%**

### Borrow APR
Берётся с Gate.io API (`earn/uni/rate`) как годовой decimal:
```
BorrowAPR% = estRate × 100
```

### Spread (не включается в APR)
```
Spread% = (futuresPrice - spotPrice) / spotPrice × 100
```
Отображается отдельно для анализа базиса фьючерс/спот.

### Net APR
```
Net APR = Funding APR − Borrow APR
```

---

## Архитектура

```
app/
├── api/
│   ├── gate/
│   │   ├── margin-pairs/   → список isolated margin токенов Gate
│   │   └── borrow/         → borrow APR + ликвидность Gate
│   └── scan/               → агрегация: Gate tokens × все биржи
├── page.tsx                 → главный dashboard (client component)
└── layout.tsx

lib/exchanges/               → адаптеры бирж
│   ├── types.ts             → интерфейсы + утилиты
│   ├── binance.ts           → bulk premiumIndex
│   ├── okx.ts               → instruments + per-symbol funding
│   ├── bybit.ts             → bulk tickers (v5)
│   ├── gate.ts              → contracts bulk + margin pairs + borrow
│   ├── bitget.ts            → V2 mix tickers
│   ├── bingx.ts             → bulk premiumIndex
│   ├── xt.ts                → symbol list + per-symbol funding
│   ├── mexc.ts              → bulk contract ticker
│   ├── bitmart.ts           → bulk contract details
│   └── kucoin.ts            → bulk contracts/active

components/
│   ├── ArbitrageTable.tsx   → таблица с сортировкой/фильтром
│   ├── TokenModal.tsx       → карточка токена + графики
│   ├── StatusBar.tsx        → статус обновления
│   └── charts/MiniChart.tsx → Recharts line chart

hooks/
│   ├── useArbitrageData.ts  → React Query (30s refresh)
│   └── useHistory.ts        → кольцевой буфер истории (100 точек)

types/index.ts               → общие типы
```

### Поток данных

1. Браузер → `GET /api/scan` (каждые 30 секунд через React Query)
2. API route: параллельно запрашивает Gate margin pairs, borrow rates, и все 10 бирж
3. Матчинг: для каждого Gate-токена × каждая биржа → строка таблицы
4. Frontend: отображает 4000+ строк, sortable/filterable
5. История: каждый fetch сохраняет точку в память → графики в модальном окне

---

## API endpoints (публичные, без авторизации)

| Биржа | Endpoint | Тип | Интервал |
|-------|----------|-----|---------|
| Binance | `fapi.binance.com/fapi/v1/premiumIndex` | Bulk | 8h (default) |
| OKX | `okx.com/api/v5/public/funding-rate` | Per-symbol | 8h (varies) |
| Bybit | `api.bybit.com/v5/market/tickers?category=linear` | Bulk | Per-symbol field |
| Gate | `fx-api.gateio.ws/api/v4/futures/usdt/contracts` | Bulk | Per-contract field |
| Bitget | `api.bitget.com/api/v2/mix/market/tickers?productType=USDT-FUTURES` | Bulk | 8h |
| BingX | `open-api.bingx.com/openApi/swap/v2/quote/premiumIndex` | Bulk | Per-symbol field |
| XT | `fapi.xt.com/future/market/v1/public/q/funding-rate` | Per-symbol | Per-symbol field |
| MEXC | `contract.mexc.com/api/v1/contract/ticker` | Bulk | 8h (default) |
| BitMart | `api-cloud-v2.bitmart.com/contract/public/details` | Bulk | Per-symbol field |
| KuCoin | `api-futures.kucoin.com/api/v1/contracts/active` | Bulk | Per-contract field |

### Gate.io специфика

| Endpoint | Данные |
|---------|--------|
| `api.gateio.ws/api/v4/margin/currency_pairs` | Список токенов isolated margin + max liquidity |
| `api.gateio.ws/api/v4/earn/uni/rate` | Borrow APR (est_rate, annualized decimal) |
| `api.gateio.ws/api/v4/spot/tickers` | Spot цены |

---

## Поля таблицы

| Поле | Описание |
|------|---------|
| Token | Базовый токен (BTC, ETH, SOL...) |
| Exchange | Биржа для Long стороны |
| Raw Funding | Ставка как есть с биржи + интервал |
| Funding APR | Приведённая к году % |
| Borrow APR | Gate isolated margin borrow % год |
| Spread | (Futures - Spot) / Spot × 100% |
| Net APR | Funding APR - Borrow APR |
| Liquidity | Макс. объём заёма на Gate (USDT) |
| Next Funding | Время до следующего расчёта |

---

## Замечания

- **Ликвидность** — `max_quote_amount` из Gate `margin/currency_pairs` (платформенный лимит, не реальный пул)
- **Borrow APR** — `est_rate` из Gate UniLoan (оценочная ставка, меняется)
- **Интервал фандинга** — у Bybit и BingX берётся из самого ответа; у Binance/Bitget предполагается 8h
- **Спред** — не включается в Net APR расчёт, показывается отдельно для анализа базиса
- **Без фильтрации** — показываются все связки, включая отрицательный Net APR

---

## Деплой на Railway

1. Залить код в GitHub-репозиторий
2. На [railway.app](https://railway.app) → **New Project → Deploy from GitHub repo**
3. Railway автоматически найдёт `railway.toml` и соберёт Docker-образ
4. В Railway Dashboard → **Variables** добавить:

| Переменная | Значение | Обязательна |
|---|---|---|
| `PLAYWRIGHT_PROXY_SERVER` | `http://IP:PORT` | Да (без неё ликвидность недоступна) |
| `PLAYWRIGHT_PROXY_USER` | логин прокси | Если прокси с авторизацией |
| `PLAYWRIGHT_PROXY_PASS` | пароль прокси | Если прокси с авторизацией |
| `GATE_API_KEY` | ключ Gate API | Нет (альтернатива прокси) |
| `GATE_API_SECRET` | секрет Gate API | Нет (альтернатива прокси) |

> `.env.local` работает только локально и **не попадает** в деплой (он в `.gitignore`).
> На Railway все переменные задаются через dashboard.

---

## Требования

- Node.js 18+
- Windows / macOS / Linux
- Интернет-соединение (запросы к внешним API)
