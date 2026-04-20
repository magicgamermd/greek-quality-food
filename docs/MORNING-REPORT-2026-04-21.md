# Доклад за нощната работа — 21 април 2026

**За**: magic
**От**: Claude Opus 4.7 (автономен режим)
**Период**: нощта на 20→21 април 2026

---

## Кратко обобщение

Завършена е **Фаза 3 — Telegram AI агент** за МЕРТ-М складовия софтуер.
Проектът вече е tag-нат като **`v0.3.0-telegram`** и е готов за testing /
integration deployment.

Предишни tag-ове:

- `v0.1.0-foundation` — клонинг на Greek Foods, премахнати batches/expiry
- `v0.2.0-ekont` — пълна Еконт интеграция (13 задачи, backend + frontend)
- `v0.3.0-telegram` — тази нощ ✨

**Greek Foods baseline останал недокоснат** — `9f55c3205d60ba41a7d7c706a25553d94d95c71a`.

---

## Какво е построено тази нощ

### Backend: `/chat` endpoint с tool calling

**Файлове:**

- [`warehouse-backend/src/routes/chat-schemas.ts`](../warehouse-backend/src/routes/chat-schemas.ts) — Zod схеми за заявки и tool args
- [`warehouse-backend/src/routes/chat.ts`](../warehouse-backend/src/routes/chat.ts) — FastifyInstance + OpenRouter proxy + 6-tool dispatcher
- [`warehouse-backend/src/__tests__/chat-tool-dispatch.test.ts`](../warehouse-backend/src/__tests__/chat-tool-dispatch.test.ts) — 4 vitest теста (401 auth, simple reply, tool dispatch, missing API key)

**Tool set (OpenRouter / Claude 3.5 Haiku):**

| Tool                    | Какво прави                                      |
| ----------------------- | ------------------------------------------------ |
| `search_products`       | ILIKE търсене по name/SKU (до 10 резултата)      |
| `get_order`             | Поръчка + артикули (JOIN order_items + products) |
| `list_orders`           | Филтри status / date_from / date_to, 20 row cap  |
| `generate_invoice`      | POST /invoices (с VAT по подразбиране)           |
| `create_econt_shipment` | Взема econt\_\* от поръчката, POST /econt/...    |
| `track_shipment`        | GET /econt/track/:shipment_number                |

**Цикъл**: до 3 tool turns. След това връща summary reply.

### Telegram bot (адаптиран от demo)

- Портнат цялостно от `/Users/magic/Projects/mert-m-demo/telegram-bot/` → `/Users/magic/Projects/mert-m/telegram-bot/`
- **Сдържа**: bot.js (2219 реда), KB/, agent/ (SOUL/MEMORY/TOOLS), Dockerfile, package.json, railway.toml
- **Добавено в .gitignore**: `telegram-bot/node_modules/`, `logs/`, `processed-uids.json`
- `/inventory/report/pdf` shortcut (не съществува в MERT-M backend) → заменен с текстов топ-30 списък от `/inventory?has_stock=true`
- Всички други API call-ове работят: `/auth/login`, `/chat`, `/orders`, `/invoices`, `/econt/*`, `/analytics/dashboard`, `/orders/:id/fulfill`, `/orders/:id/status`

### KB + агент prompt-и (MERT-M контекст)

- `KB/system-overview.md` — self-host URLs, Hendi/Bartscher/Liebherr/Unox/Fiamma, BGN + ДДС 20%, **НЯМА** срокове/партиди
- `KB/admin-guide.md` — премахнат demo URL, сочи към `localhost:5173`
- `KB/troubleshooting.md` — self-host checks вместо Railway рестарти
- `agent/TOOLS.md` — нов tool списък (6 LLM tool-а + hardcoded shortcut-и)
- `agent/MEMORY.md` — цени в BGN (не в €)

### Документация

- `telegram-bot/README.md` — пълен MERT-M-specific setup (архитектура, env vars, startup, тестване, self-host deployment)
- `docs/superpowers/specs/2026-04-21-telegram-agent-design.md` (165 реда)
- `docs/superpowers/plans/2026-04-21-telegram-agent.md` (1003 реда, TDD планиране)

---

## Тестване / верификация

| Проверка                    | Резултат                               |
| --------------------------- | -------------------------------------- |
| `npx tsc --noEmit` backend  | PASS (0 грешки)                        |
| `npx tsc --noEmit` frontend | PASS (0 грешки)                        |
| `npx vitest run` (backend)  | **40 файла / 192 теста — всички PASS** |
| `node --check` bot.js       | PASS (syntax OK)                       |
| Greek Foods SHA check       | Непроменен — `9f55c3205d6…`            |
| Git tag `v0.3.0-telegram`   | Създаден с detailed release notes      |

---

## Какво трябва да свършиш ти (ръчни стъпки)

### 1. Създай Telegram бот

- Отвори @BotFather → `/newbot` → вземи token
- Отвори @userinfobot → `/start` → вземи твоя user ID

### 2. Попълни `.env` файловете

**`warehouse-backend/.env`**:

```
OPENROUTER_API_KEY=<взет от openrouter.ai>
CHAT_MODEL=anthropic/claude-3.5-haiku
```

**`telegram-bot/.env`** (копирай от `.env.example` и попълни):

```
TELEGRAM_BOT_TOKEN=<от BotFather>
ALLOWED_USERS=<твоя Telegram user ID>
API_URL=http://localhost:3003
API_EMAIL=admin@mertm.bg
API_PASSWORD=<админ парола на backend-а>
OPENROUTER_API_KEY=<същия ключ>
CHAT_MODEL=anthropic/claude-3.5-haiku
```

### 3. Пусни системата

Три процеса в отделни терминали:

```bash
# Терминал 1 — backend
cd warehouse-backend
npm run dev

# Терминал 2 — frontend (за web UI)
cd warehouse-frontend
npm run dev

# Терминал 3 — Telegram bot
cd telegram-bot
npm install      # първият път
npm start
```

### 4. Smoke test в Telegram

Напиши на бота:

- **"Здравей"** → AI pozdrav на български
- **"Намери фритюрник"** → бот извиква `search_products(фритюрник)`
- **"Покажи поръчка #1"** → ако имаш поръчка, бот извиква `get_order(1)`
- **"Справка"** → hardcoded shortcut, показва топ 30 стокирани

### 5. Верификация на /chat от CLI (опционално)

```bash
# Логин
TOKEN=$(curl -s -X POST http://localhost:3003/auth/login \
  -H "Content-Type: application/json" \
  -d '{"email":"admin@mertm.bg","password":"<парола>"}' \
  | jq -r .token)

# Chat
curl -X POST http://localhost:3003/chat \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"message":"Покажи продукти за фритюрене"}' | jq
```

---

## Статус на проекта

- ✅ **v0.1.0-foundation** — готов
- ✅ **v0.2.0-ekont** — готов
- ✅ **v0.3.0-telegram** — готов тази нощ
- ⏳ **Следващи фази** (не започнати):
  - Self-host deployment config (systemd/launchd на Mac Mini M4)
  - Production environment variables (истински Еконт account, OpenRouter billing)
  - Acceptance test с реален клиент на МЕРТ-М
  - Observability (логване, error tracking)

---

## Git log

Последни 9 commit-а:

```
78497a7 docs(telegram-bot): rewrite README for MERT-M self-host deployment
a8c62f6 docs(telegram-bot): rewrite KB + agent prompts for MERT-M context
33744a7 feat(telegram-bot): adapt inventory-report shortcut to MERT-M backend
e45fc38 feat(chat): register /chat route + add OPENROUTER_API_KEY env vars
4d2af7f feat(chat): add /chat endpoint with OpenRouter + tool dispatcher
202b8c0 feat(chat): add Zod schemas for /chat endpoint + tool args
16d21bf feat(bot): import demo Telegram bot as starting point
a602b35 docs: add Telegram agent implementation plan (v0.3.0)
dd56b7c docs: add Telegram agent design spec (v0.3.0)
```

Всичко е на `main` branch, с чисти commit съобщения по conventional format.

---

**Добро утро! ☕ Системата е готова за тестване.**
