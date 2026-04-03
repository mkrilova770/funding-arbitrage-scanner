# Funding Arbitrage Scanner (Bitget)

Веб-приложение для сканирования арбитража фандинга: **сторона Short / заём** — **Bitget USDT isolated margin**, **сторона Long** — **USDT perpetual** на нескольких биржах (Binance, OKX, Bybit, Gate, Bitget, BingX, XT, MEXC, BitMart, KuCoin).

## Быстрый старт

```bash
npm install
npm run dev
# http://localhost:3000
```

---

## Стратегия

| Сторона | Позиция | Описание |
|---------|---------|----------|
| **Long** | USDT perp | Binance / OKX / Bybit / Gate / Bitget / BingX / XT / MEXC / BitMart / KuCoin |
| **Short** | Bitget isolated margin | Заём базового актива под шорт |

**Net APR = Funding APR − Borrow APR** (borrow с Bitget: подписанные V2 isolated + публичный UTA `margin-loans`).

---

## Формулы

### Funding APR (% годовых)

```
Funding APR = rawFundingRate × (8760 / intervalHours) × 100
```

### Borrow APR (Bitget)

Годовая ставка из signed **`/api/v2/margin/isolated/interest-rate-and-limit`** или из **`/api/v3/market/margin-loans`** (UTA), в процентах.

### Spread (не в Net APR)

```
Spread% = (futuresPrice - spotPrice) / spotPrice × 100
```

---

## Архитектура (кратко)

1. `GET /api/scan` — токены с Bitget `margin/currencies` (isolated USDT base borrowable), borrow+spot, фандинг со всех адаптеров.
2. Frontend: React Query, автообновление, таблица и модалка с графиками.
3. Дополнительные маршруты `app/api/gate/*` (Gate + Playwright) оставлены для отладки; **основной сканер их не вызывает**.

---

## Деплой на Railway

Отдельный сервис или проект **не мешает** уже развёрнутому сайту с Gate: у каждого сервиса свой URL, переменные и билд.

### Шаги

1. Залейте этот репозиторий на GitHub (без `.env.local` и секретов).
2. [railway.app](https://railway.app) → **New Project** → **Deploy from GitHub repo** → выберите репозиторий с этим кодом.
3. Railway подхватит **`railway.toml`** и соберёт образ по **`Dockerfile`**.
4. В сервисе → **Settings** → **Networking** → включите **Generate Domain** (публичный HTTPS URL).
5. **Variables** → добавьте переменные из таблицы ниже (минимум три `BITGET_*` для полных лимитов займа).

### Переменные окружения (Railway)

| Переменная | Описание | Обязательная |
|------------|----------|----------------|
| `BITGET_API_KEY` | API Key Bitget | Для signed isolated borrow |
| `BITGET_API_SECRET` | Секрет ключа | То же |
| `BITGET_PASSPHRASE` | Passphrase ключа | То же |
| `BITGET_ACCOUNT_MAX_BORROW` | `1` или `true` — тяжёлый POST max-borrowable по токенам | Нет (по умолчанию выкл.) |
| `NEXT_PUBLIC_SCAN_TIMEOUT_MS` | Таймаут клиента на `/api/scan` (мс), напр. `120000` | Нет |
| `SCAN_UPSTREAM_URL` | Если задать origin другого инстанса — этот сервер только **проксирует** `GET /api/scan` (read-only) | Нет |
| `SCAN_UPSTREAM_TIMEOUT_MS` | Таймаут прокси к upstream (мс) | Нет |

Переменная **`PORT`** задаётся Railway автоматически; `next start` её подхватывает.

> **Важно:** `.env.local` в git не попадает. Секреты только в Dashboard Railway (или **Shared Variables** на уровне проекта, если нужно).

### Docker-образ

База **Playwright** (`chromium`) — для совместимости с кодом `gate-rate-cap`; главная страница и `/api/scan` от неё не зависят.

### Доступ Cursor / агента к Railway CLI (токен локально)

Я не могу «войти» в браузер за вас, но могу запускать деплой из терминала, если токен лежит **только на диске**, не в чате:

1. Создайте токен: [railway.app/account/tokens](https://railway.app/account/tokens) (**New token**) или **Project → Settings → Tokens** (project token).
2. Скопируйте **`railway.local.env.example`** → **`railway.local.env`** в корне репозитория.
3. Вставьте значение в строку `RAILWAY_TOKEN=...` и сохраните файл.  
   **Не отправляйте** токен в сообщения ИИ и не коммитьте `railway.local.env` (он в `.gitignore`).
4. Один раз свяжите каталог с проектом (ID из URL дашборда Railway; имя сервиса как в UI):

   ```powershell
   npm run railway:whoami
   powershell -NoProfile -ExecutionPolicy Bypass -File scripts/railway-with-env.ps1 link -p <PROJECT_ID> -e production -s <SERVICE_NAME_OR_ID>
   ```

   Конфиг сохранится в **`.railway/`** (тоже в `.gitignore`).

5. Деплой текущего кода с этой машины:

   ```powershell
   npm run railway:up
   ```

   Логи: `npm run railway:logs`; повторный деплой того же билда: `npm run railway:redeploy`.

Скрипт **`scripts/railway-with-env.ps1`** подхватывает `railway.local.env` и вызывает CLI. На Railway в веб-интерфейсе по-прежнему нужно задать **`BITGET_*`** для самого приложения.

---

## Поля таблицы

| Поле | Описание |
|------|----------|
| Token | Базовый токен |
| Best Exchange | Лучший long по Net APR |
| Raw Funding / Funding APR | Ставка фандинга long-биржи |
| Borrow APR | Bitget (годовые %) |
| Spread | Базис фьючерс/спот Bitget |
| Available Borrow | Лимит займа (токены + ~USDT), источник: Bitget API |
| Next Funding | До следующего фандинга (long) |

---

## Замечания

- Лимиты в таблице — из **конфигурации/API Bitget** (isolated interest/tier/UTA), не «реальный пул» и не персональный макс.; персональный макс. ближе к **`BITGET_ACCOUNT_MAX_BORROW`**.
- На Bitget должен быть **открыт маржинальный счёт**, иначе signed isolated даст 50021 и лимиты частично «без лимита».

---

## Требования

- Node.js 18+ (локально), Docker на Railway
- Сеть до бирж (REST)

См. также **`.env.example`** для локальной настройки.
