# МЕРТ-М Telegram Agent — Design Spec (v0.3.0)

**Date:** 2026-04-21
**Predecessor milestone:** v0.2.0-ekont (Ekont shipping integration)
**Goal:** Port the production-ready Telegram agent from `/Users/magic/Projects/mert-m-demo/telegram-bot/` into `mert-m/` and connect it to the MERT-M warehouse backend, so staff can create orders, manage invoices, trigger Econt shipments, and send emails through a single Telegram chat.

---

## 1. Problem

The existing warehouse web UI (React) is efficient but requires a browser + mouse. For field staff and the warehouse manager (Valeri), a Telegram-first workflow is critical:

- Hands-free order entry via voice (Whisper transcription)
- One-tap daily report at 08:00 (pending orders, low stock, unpaid invoices)
- Automatic parsing of email orders (IMAP watcher)
- Natural-language queries: "колко поръчки днес?", "генерирай фактура за поръчка 23"

The demo bot (bot.js, 2219 lines) already implements all of this against a forked warehouse API. We need to integrate it with the MERT-M backend (Fastify, not the demo's older stack).

---

## 2. Architecture

```
┌────────────────────┐     Telegram API      ┌─────────────────────┐
│  Warehouse Staff   │◀──────────────────────▶│  telegram-bot/bot.js │
│  (Valeri, etc.)    │                         │  (Node.js / polling) │
└────────────────────┘                         └──────────┬──────────┘
                                                          │
                                                          │ HTTP (Bearer JWT)
                                                          │
                                                          ▼
                                          ┌───────────────────────────┐
                                          │  warehouse-backend        │
                                          │  ‣ /chat (NEW, proxies    │
                                          │     OpenRouter / tools)   │
                                          │  ‣ /orders, /invoices,    │
                                          │     /econt/*, /inventory  │
                                          └──────────┬────────────────┘
                                                     │
                                                     ▼
                                          PostgreSQL 16 + Econt API
```

### New backend surface: `POST /chat`

Single endpoint handles:

- Accept `{ message, history, system_context }`
- Forward to OpenRouter with a strict system prompt + tool-calling schema
- Tools exposed to the LLM:
  - `search_products(query)`
  - `get_order(id)`
  - `create_order(partner_name, items, delivery_date, ...)`
  - `list_orders(status, date_from, date_to)`
  - `cancel_order(id, reason)`
  - `generate_invoice(order_id, include_vat)`
  - `send_invoice_email(invoice_id, to_email)`
  - `get_inventory_report()` → link to PDF
  - `create_econt_shipment(order_id)` → reuses `/econt/create-shipment`
  - `track_shipment(shipment_number)`
- Each tool implemented server-side as a switch inside the route; no direct LLM-to-DB.
- Response: `{ reply: string, tool_calls?: Array<{name, args, result}> }`

Bot calls this endpoint and renders reply. Bot keeps per-user history client-side (unchanged from demo).

### Auth

- Bot logs in once with `API_EMAIL`/`API_PASSWORD` → receives JWT → auto-refresh every 6h (existing demo behavior)
- `/chat` inherits existing JWT auth (role: admin or warehouse)
- Telegram access control via `ALLOWED_USERS` env var (chat IDs, comma-separated)

### Port strategy

- **Copy wholesale** `/Users/magic/Projects/mert-m-demo/telegram-bot/` → `/Users/magic/Projects/mert-m/telegram-bot/`
- Prune demo-specific endpoints from bot.js that don't exist in MERT-M backend (e.g. if the demo hits `/batches`, remove — MERT-M has no batch tracking per v0.1.0 migration 045)
- Keep KB/ and agent/ prompt files — they're product-agnostic
- Update KB with commercial kitchen context (Hendi, Bartscher, Liebherr brands; no perishables)
- Bot talks to the same backend via `API_URL=http://localhost:3000` in dev; prod deploy TBD

---

## 3. Functional requirements (from demo bot.js, in scope for v0.3.0)

1. Telegram `/start`, `/help`, `/clear`, `/health`, `/bug <text>` commands — KEEP
2. Greeting menu (4-button inline keyboard) — KEEP
3. Natural-language chat with AI (`/chat` endpoint) — NEW BACKEND ROUTE
4. Voice transcription via OpenAI Whisper — KEEP (demo uses OPENAI_API_KEY)
5. Order creation from natural text via AI tools — requires backend tools
6. Invoice generation + PDF download + email sending (SMTP via nodemailer) — KEEP
7. **Econt waybill creation/tracking — NEW** (uses the v0.2.0 routes)
8. Inventory PDF report — route exists in MERT-M backend (`/inventory/report/pdf`)
9. Cron jobs: 08:00 morning, 12:00 stuck orders, 17:00 evening — KEEP
10. Email watcher (IMAP) auto-parses incoming email orders — KEEP (can be disabled via missing env)

## 4. Out of scope for v0.3.0

- Multi-user conversation memory persistence (demo uses in-memory Map — fine)
- Telegram web-app buttons beyond the current inline keyboards
- Advanced RAG over knowledge base (current flat-concat approach is enough)
- Business intelligence dashboards within Telegram

## 5. Data contracts

### POST /chat (backend)

```
Request:
{
  "message": "генерирай фактура за поръчка 23",
  "history": [{role:"user"|"assistant", content:"…"}, …],
  "system_context": "…"   // AGENT_SOUL + MEMORY + KB + active state
}

Response (success):
{
  "reply": "Генерирах фактура №10000012 за поръчка #23. ПДФ: …",
  "tool_calls": [
    {
      "name": "generate_invoice",
      "args": {"order_id": 23, "include_vat": true},
      "result": {"invoice_id": 42, "invoice_number": "10000012"}
    }
  ]
}

Response (error):
{ "error": "rate_limit" | "no_llm_key" | … , "message": "…" }
```

## 6. Env vars (telegram-bot/.env)

```
TELEGRAM_BOT_TOKEN=<from @BotFather>
ALLOWED_USERS=123456,789012
TELEGRAM_NOTIFY_USER=123456      # for cron reports
API_URL=http://localhost:3000
API_EMAIL=bot@mertm.local
API_PASSWORD=<bot service account>
OPENROUTER_API_KEY=<sk-or-…>     # used by backend /chat
OPENAI_API_KEY=<sk-…>            # for Whisper only
SMTP_HOST=…  SMTP_PORT=465 SMTP_USER=… SMTP_PASS=… SMTP_FROM=…
IMAP_HOST=…  IMAP_PORT=993 IMAP_USER=… IMAP_PASS=…
```

## 7. Testing strategy

- **Backend `/chat` route:** Vitest + vi.mock fetch to stub OpenRouter; test the tool-dispatch switch; at least one test per tool.
- **Bot:** integration smoke only — `node bot.js` starts, registers `/start` handler, exits on SIGINT. Full Telegram E2E requires a live token; covered by acceptance test with user.
- No unit tests on bot.js internals (too much Telegram-library coupling).

## 8. Success criteria

- `/chat` endpoint reachable at `POST /chat` with Bearer JWT.
- `cd telegram-bot && npm start` prints "Bot started, waiting for messages...".
- Sending "/start" in Telegram replies with the greeting menu.
- Sending "колко поръчки имаме днес" invokes the `list_orders` tool and returns a number.
- Generating an invoice + Econt waybill end-to-end from one conversation works.
- README.md in telegram-bot/ documents deployment.

## 9. Risks

- **OpenRouter cost:** each chat turn = ~1 LLM call. Mitigate via short history window (last 10 exchanges).
- **Tool-call brittleness:** if the LLM invents args, `/chat` must reject with a clear error. Each tool must validate via Zod.
- **Demo bot drift:** demo bot is 2219 lines and may contain endpoints that don't exist in MERT-M (e.g. `/batches`). Port must remove/adapt dead code.
