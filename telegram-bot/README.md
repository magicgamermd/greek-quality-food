# МЕРТ-М Склад — Telegram Bot

AI асистент за склада на МЕРТ-М ЕООД. Разговорен интерфейс през Telegram
за управление на поръчки, фактури, товарителници Еконт и справки за
наличности. Работи като тънък клиент на `warehouse-backend` — цялата
бизнес логика е на сървъра, ботът само препраща разговора към
`/chat` endpoint-а, а backend-ът от своя страна извиква tool calls към
PostgreSQL и Еконт API.

## Архитектура

```
Telegram ──► bot.js ──► warehouse-backend /chat ──► OpenRouter (Claude 3.5 Haiku)
                             │                             │
                             │                             └──► tool calls обратно
                             │
                             ├──► runTool(search_products)  → PostgreSQL
                             ├──► runTool(get_order)        → PostgreSQL
                             ├──► runTool(list_orders)      → PostgreSQL
                             ├──► runTool(generate_invoice) → POST /invoices
                             ├──► runTool(create_econt_shipment) → POST /econt/create-shipment
                             └──► runTool(track_shipment)   → GET /econt/track/:sn
```

Ботът кеширва JWT (8h), auto-refresh-ва при 401, и праща system context
(SOUL + MEMORY + KB) в `system_context` поле на всяка заявка.

## Предусловия

- **warehouse-backend** пуснат и достъпен (dev: http://localhost:3003)
- **PostgreSQL 16** с мигрирана схема (виж `warehouse-backend/README.md`)
- **OpenRouter API key** — https://openrouter.ai
- **Telegram bot token** — от @BotFather
- Node.js 20+

## Настройка

### 1. Създай бот в Telegram

1. Отвори [@BotFather](https://t.me/BotFather)
2. Изпрати `/newbot`
3. Име: `МЕРТ-М Склад`
4. Username: напр. `mertm_sklad_bot`
5. Копирай токена

### 2. Намери твоя Telegram User ID

Пусни [@userinfobot](https://t.me/userinfobot) → `/start` → копирай ID-то.

### 3. Конфигурация

Копирай `.env.example` в `.env` и попълни:

```bash
# Telegram
TELEGRAM_BOT_TOKEN=<token от BotFather>
ALLOWED_USERS=<твоят Telegram user ID>   # comma-separated за повече

# Backend API
API_URL=http://localhost:3003
API_EMAIL=admin@mertm.bg
API_PASSWORD=<backend admin парола>

# OpenRouter (за /chat в backend-а)
OPENROUTER_API_KEY=<ключ от openrouter.ai>
CHAT_MODEL=anthropic/claude-3.5-haiku

# SMTP (опционално, за "изпрати фактура по имейл")
SMTP_HOST=smtp.gmail.com
SMTP_PORT=465
SMTP_USER=invoices@mertm.bg
SMTP_PASS=<app password>
SMTP_FROM=invoices@mertm.bg

# IMAP (опционално, за автоматична обработка на входящи фактури)
IMAP_HOST=imap.gmail.com
IMAP_PORT=993
IMAP_USER=invoices@mertm.bg
IMAP_PASS=<app password>

# Notify администратора при системни събития
TELEGRAM_NOTIFY_USER=<Telegram user ID на admin>
```

**Важно**: `OPENROUTER_API_KEY` трябва да е зададен и в `warehouse-backend/.env`,
защото `/chat` endpoint-ът го чете от там.

### 4. Стартиране

```bash
cd telegram-bot
npm install
npm start
```

За development:

```bash
npm run dev     # nodemon auto-restart
```

### 5. Deployment (self-host на Mac Mini M4)

Ботът се стартира като systemd/launchd сервис заедно с backend-а. Пример
launchd plist в `deploy/` (TODO).

## Команди в Telegram

| Команда  | Действие                       |
| -------- | ------------------------------ |
| `/start` | Приветствие + кратко меню      |
| `/help`  | Примерни въпроси               |
| `/clear` | Изчисти историята на разговора |

## Hardcoded shortcut-и (без LLM)

- **"справка" / "наличности"** → списък топ-30 стокирани продукта
- **"поръчки"** → pending поръчки
- **"статистика"** → /analytics/dashboard
- Създаване на товарителница — при потвърдена поръчка
- Изпращане на фактура по имейл — от последната генерирана

Всичко извън тези shortcut-и минава през AI агента с tool calls.

## Тестване

```bash
node --check bot.js        # syntax check
node test-dedup.js         # IMAP дедупликация smoke test
```

За backend /chat endpoint тестовете:

```bash
cd ../warehouse-backend
npx vitest run src/__tests__/chat-tool-dispatch.test.ts
```

## Логове

- `logs/` — локални логове (игнорирани в git)
- `processed-uids.json` — IMAP deduplication state

## Препратки

- Backend: `../warehouse-backend/`
- План: `../docs/superpowers/plans/2026-04-21-telegram-agent.md`
- Спецификация: `../docs/superpowers/specs/2026-04-21-telegram-agent-design.md`
- KB: `KB/`
- Agent prompts: `agent/SOUL.md`, `agent/MEMORY.md`, `agent/TOOLS.md`
