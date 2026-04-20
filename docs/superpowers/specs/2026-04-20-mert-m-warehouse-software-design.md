# MERT-M Warehouse Software — Design Spec

**Date:** 2026-04-20
**Status:** Design approved, ready for implementation plan
**Author:** magic + Claude (brainstorming skill)

---

## 1. Context and Goal

MERT-M is a Bulgarian distributor of commercial kitchen equipment (Hendi, Bartscher, KitchenAid, Liebherr and similar brands). They need a production warehouse management system to replace manual/paper processes.

**Goal:** Build the official MERT-M warehouse software by cloning the production-ready Greek Foods platform as the foundation and combining it with the Ekont integration, AI agent, branding, and warehouse workflow from the MERT-M demo project.

**Non-goal:** Touching the Greek Foods platform source, database, or deployment. Greek Foods remains completely isolated and untouched.

**Key simplification vs Greek Foods:** MERT-M sells durable goods (kitchen equipment), not perishable food. Therefore expiration date tracking and batch (lot) tracking are REMOVED from the system.

## 2. Source Projects

| Project               | Path                                           | Role                                                                                                                                |
| --------------------- | ---------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------- |
| Greek Foods Platform  | `/Users/magic/Projects/greek-foods-platform/`  | **Base clone source.** 28+ migrations, production-hardened, full feature set. Remains UNTOUCHED.                                    |
| MERT-M Demo           | `/Users/magic/Projects/mert-m-demo/`           | **Feature source.** Provides branding, Ekont integration, AI chat, warehouse packing workflow, Telegram bot, email-to-order script. |
| MERT-M Client Backend | `/Users/magic/Projects/mert-m-client-backend/` | Reference only (older branch of similar ideas). Not used as source.                                                                 |

The new project will live at: **`/Users/magic/Projects/mert-m/`**.

## 3. Architecture

### 3.1 Services

Three services in a single monorepo:

- **`warehouse-backend`** — Fastify / TypeScript / PostgreSQL 16 (forked from Greek Foods)
- **`warehouse-frontend`** — React / Vite / Tailwind CSS v4 (forked from Greek Foods, branded with MERT-M colors)
- **`ai-service`** — Python / FastAPI (forked from Greek Foods — used for OCR of paper incoming documents)

Plus two long-running helper processes:

- **`telegram-bot`** — Node process, ported from MERT-M demo (`bot.js`, 2219 lines)
- **`email-order-agent`** — Node cron process, ported from MERT-M demo (`scripts/email-order-agent.js`, 203 lines)

### 3.2 Deployment Topology

Fully local, self-hosted on the customer's hardware. No cloud dependency for data, only for external APIs.

```
┌───────────── Mac Mini M4 #1 (MERT-M office) ─────────────┐
│  PostgreSQL 16 (local data files)                        │
│  warehouse-backend (Node, port 3003)                     │
│  warehouse-frontend (served by backend static or nginx)  │
│  ai-service (Python FastAPI, port 8000)                  │
│  telegram-bot (Node process, managed by PM2)             │
│  email-order-agent (Node cron process, managed by PM2)   │
│  External HDD #1 (nightly pg_dump + file backup)         │
└──────────────┬────────────────────────────────────────────┘
               │ Tailscale mesh VPN (private)
               │
┌──────────────┴───────────┐      ┌─────────────────────┐
│ Mac Mini M4 #2 (manager) │      │ User's office       │
│ Browser → frontend URL   │      │ External HDD #2     │
│ Office LAN OR remote via │      │ Nightly rsync over  │
│ Tailscale (works both)   │      │ Tailscale           │
└──────────────────────────┘      └─────────────────────┘
               │
               └── internet ──→ Telegram API / Ekont API / IMAP
```

- **Mac Mini #1** is the primary work machine at MERT-M's office — runs all services and the DB; used by warehouse staff.
- **Mac Mini #2** is the manager's machine — used for reports, deliveries, analytics; can be in the same office (LAN) or at home (Tailscale).
- **External HDD #1** stays at MERT-M — local daily backups.
- **External HDD #2** stays at the user's office — offsite backup, synced nightly over Tailscale.
- **Internet required** for Telegram bot, Ekont API, IMAP (email-to-order), and OpenAI calls. If internet is down, the LAN-local app keeps working for everything except those features.

### 3.3 Roles and Access

Three roles (inherited from Greek Foods, semantics unchanged):

- **`admin`** — full access
- **`accountant`** — read-most + invoicing/payments; no warehouse packing screens
- **`warehouse`** — only packing screens and inventory read; no reports, partners, analytics, settings, or AI chat

Two warehouse users are seeded at install time for the MERT-M warehouse staff.

## 4. What We REMOVE from Greek Foods

MERT-M sells kitchen equipment, so expiration and batch tracking are not needed.

**Database (deprecate in v1, drop in v1.1 after 2-4 weeks of stable operation):**

- `batches` table — left empty, no route writes to it
- `expiry_date`, `batch_number`, `production_date` columns on `incoming_items` and `order_items` — made nullable, ignored by code
- `011_batch_tracking.sql` migration — not executed in MERT-M's migration sequence
- FEFO (First Expiry First Out) logic replaced by simple FIFO by `created_at`

**Backend code:**

- `src/routes/batches.ts` — deleted
- Batch-related branches of `src/routes/inventory.ts` (expiring-batches endpoint removed), `src/routes/incoming.ts` (no batch record on confirmation), `src/routes/orders.ts` (no FEFO fulfillment)

**Frontend:**

- `Batches.tsx` page and all batch-related components
- Batch columns from inventory / orders tables
- "Expiring soon" alerts from Dashboard

**Kept from Greek Foods (vast majority):**

- auth, products, partners, orders, invoices, payments, analytics, incoming (without batch layer), categories, suppliers, notifications, users
- invoice PDF generation, fiscal printer, Microinvest import
- audit events, invoice annulment, order metadata, partner objects, reconciliation logic
- All production-hardening from waves 1-5

## 5. What We ADD from MERT-M Demo

### 5.1 Branding (from demo frontend)

From `mert-m-demo/warehouse-frontend/src/index.css`:

```css
@theme {
  --color-sidebar: #0a1628; /* dark navy */
  --color-sidebar-hover: #0f1f3a;
  --color-accent: #f97316; /* orange */
  --color-accent-hover: #ea580c;
  --color-accent-light: #fff7ed;
}
```

Also:

- Logo and icons from `demo/public/` (`apple-touch-icon.svg`, `icon-192.svg`, `icon-512.svg`)
- `BakaliqLoader.tsx` branded loader
- Logo placement in `Layout.tsx`
- Login page branding tweaks (`Login.tsx`)
- Dashboard welcome messages referencing MERT-M

### 5.2 Ekont Integration (from demo)

**API:** `http://ee.econt.com/services` (Ekont production API — test credentials for development, real credentials when going live).

**Credentials storage:** `settings` table (admin can rotate through UI; not in env files, so no redeploy needed).

**Backend:**

- Port `src/routes/econt.ts` (full version from demo)
- Port `020_econt_fields.sql` migration (adds `econt_receiver_name`, `econt_receiver_phone`, `econt_delivery_type`, `econt_city`, `econt_office_code`, `econt_office_name`, `econt_street`, `econt_street_num`, `econt_cod_amount`, `econt_weight`, `econt_shipping_cost`, `econt_shipment_number`, `econt_tracking_url` to orders)
- Add `econt_pdf_url TEXT` column (demo uses this for PDF caching, not in the original 020 migration — bundle into 030)

**Supported operations:**

- `create_shipment` — weight is auto-computed as `SUM(order_items.qty * products.weight_kg)`
- `delete_shipment` — for order cancellation
- `print_labels` — download the waybill PDF
- `validate_address` — called from UI while entering address/office
- `track_shipment` — status lookup by `econt_shipment_number`

**Frontend:** Ekont shipping panel inside Order detail:

1. Order reaches `ready_for_shipping` status
2. User clicks "Създай Ekont товарителница"
3. Modal opens: office or address choice, auto-filled name/phone from partner, auto-summed weight
4. "Създай" → API call → receives `shipment_number` and `pdf_url`
5. PDF auto-downloads or prints; order status → `shipped`
6. Tracking link shown in order detail afterwards

### 5.3 Product Weight

- `products.weight_kg NUMERIC(10,3) NOT NULL DEFAULT 0` (migration from demo `017_product_weight.sql`)
- Seed weights for the 50 demo products from `018_seed_weights.sql`
- Required field in product create/edit UI
- Used by Ekont `create_shipment` to compute waybill weight

### 5.4 "Изпрати в склад за обработка" Workflow

- Migration from demo `021_stock_deducted.sql` adds `orders.stock_deducted BOOLEAN NOT NULL DEFAULT false`
- Order lifecycle:
  1. `new` — order created, stock not reserved
  2. (admin clicks "Изпрати в склад за обработка") — stock is deducted, `stock_deducted = true`
  3. `in_warehouse` — warehouse staff see it on their packing page
  4. (warehouse clicks "Готов") → `ready_for_shipping`
  5. (Ekont waybill created) → `shipped`
- `WarehousePacking.tsx` page (from demo) — warehouse staff's primary workspace; admin also has access for oversight; accountant does not
- Route guards on all backend mutations (only admin and warehouse can transition `in_warehouse → ready_for_shipping`)

### 5.5 AI Agent (internal, from demo)

- Port `src/routes/chat.ts` (1933 lines from demo)
- Model: `gpt-5.4-mini` via OpenAI SDK with tool calling (up to 5 rounds)
- Tools (inherited + new):
  - `search_products(query, category?)`
  - `get_inventory(product_id?)`
  - `get_last_order(partner_name)`
  - `list_recent_orders(limit, status?)`
  - `create_order(partner, items)`
  - `send_email(to, subject, body)`
  - `send_to_warehouse(order_id)` — new, triggers warehouse workflow
  - `create_econt_waybill(order_id, ...)` — new, creates shipping label
  - `get_analytics(metric, period)`
- Access restricted to `admin` and `accountant` only — warehouse role does not see chat widget or have Telegram access.
- All mutating tool calls audited to the existing `audit_events` table (already in Greek Foods).
- Stateless / in-memory conversation context (same as demo) — no persistent chat history in v1. If needed, add `agent_conversations` table in v1.1.

### 5.6 Telegram Bot

- Port `mert-m-demo/telegram-bot/bot.js` (2219 lines) into `mert-m/telegram-bot/`
- Managed by PM2 (auto-restart, start-on-boot)
- `.env`: `TELEGRAM_BOT_TOKEN` and `ALLOWED_USERS` (comma-separated Telegram user IDs)
- Only admin and accountant user IDs allowed
- User mapping: new table `telegram_user_map (telegram_user_id BIGINT, app_user_id INTEGER)` so backend knows which DB user is calling tools
- All messages call `POST /chat` on backend, which runs the same agent as the web widget

### 5.7 Web Chat Widget

- Port `ChatWidget.tsx` (275 lines from demo) into frontend
- Floating bubble in `Layout.tsx`, bottom-right
- Visible only for admin and accountant roles
- Talks to the same `POST /chat` endpoint
- Message history cached in localStorage (client-side only, per tab — nothing persisted server-side in v1)

### 5.8 Email-to-Order (placeholder for v1)

- Port `mert-m-demo/scripts/email-order-agent.js` (203 lines) into `mert-m/email-order-agent/`
- PM2 process, polls IMAP every 60 seconds
- **v1 parser:** uses OpenAI (same as demo) — works for any format
- Creates order with new status `pending_review`
- Telegram notification to admin: "Нова поръчка от имейл: [клиент], [сума], [брой артикули]"
- Admin opens, reviews, clicks "Потвърди" → status → `new` → continues normal flow
- IMAP credentials stored in `settings` table

**v1.1 (after MERT-M provides the real email template from their website):**

- Switch to deterministic regex/structured parser (cheaper, more reliable)
- Keep AI parser as fallback on structured-parse failure

## 6. Data Model Changes

### 6.1 Migration Sequence (MERT-M)

```
migrations/
├── 001-028_*.sql                 # From Greek Foods, all kept unchanged
├── 029_mertm_product_weight.sql          # Adds products.weight_kg
├── 030_mertm_stock_deducted.sql          # Adds orders.stock_deducted + econt_pdf_url
├── 031_mertm_deprecate_batches.sql       # Marks batches and expiry_* columns as deprecated
├── 032_mertm_telegram_user_map.sql       # New telegram_user_map table
└── 033_mertm_initial_seed.sql            # Admin user, 2 warehouse users, MERT-M settings, Ekont creds placeholder, OpenAI key placeholder
```

### 6.2 Deprecation Details

The `031_mertm_deprecate_batches.sql` migration:

- Does NOT drop `batches` table or `expiry_*` columns (for rollback safety)
- Adds a DB comment noting the deprecation date
- Future `v1.1_drop_batches.sql` migration will drop them after 2-4 weeks of stable operation

### 6.3 Ekont Column Alignment

Greek Foods already has `019_order_econt_fields.sql`. The MERT-M demo has equivalent columns plus `econt_pdf_url`. During port:

- Diff the two migrations
- Use Greek Foods version as base
- Add any missing columns from the demo version (esp. `econt_pdf_url`) via migration 030

### 6.4 Seed Data

- One admin user (password changed on first login)
- Two warehouse users for MERT-M packing staff
- MERT-M company settings: EIK, VAT, address, bank details, IBAN
- Ekont test credentials (swapped to production on go-live)
- 50 demo products from the MERT-M demo as starter catalog (full catalog imported later when MERT-M provides it)
- Empty partners table (filled as real customers are entered)

## 7. Error Handling and Operations

### 7.1 Internet Outage

- Backend, frontend, DB, warehouse workflow: fully functional on LAN (no internet needed)
- Ekont features: show "Ekont недостъпен — опитай пак" — order can still be marked shipped manually
- AI chat: shows "AI асистентът е временно недостъпен"
- Telegram bot: queues messages locally, retries on reconnect
- Email-to-order: skips the poll cycle, retries next interval

### 7.2 Mac Mini #1 Failure

Recovery is manual from External HDD #1:

- Restore PostgreSQL from latest `pg_dump`
- Restore file uploads (invoice PDFs, OCR scans) from rsync
- Expected RTO: ~2 hours for a full restore on replacement hardware
- No hot standby in v1 (per user decision). If uptime becomes a bigger concern, add Postgres streaming replication to Mac Mini #2 in v1.1.

### 7.3 Audit Trail

- All mutating AI tool calls logged to `audit_events` with (user_id, tool_name, arguments, timestamp)
- Order lifecycle transitions logged (status change, who, when)
- Invoice annulments already audited (inherited from Greek Foods)

### 7.4 Backups

- **Nightly, 02:00 Europe/Sofia:**
  - `pg_dump` of MERT-M database → External HDD #1 (rotated 30 days)
  - `rsync` file uploads directory → External HDD #1
- **Nightly, 03:00 Europe/Sofia:**
  - `rsync` over Tailscale from Mac Mini #1 → External HDD #2 at user's office
- **Alerting:** backup script sends Telegram message to admin on success or failure

## 8. Testing Strategy

- **Unit tests:** Vitest for backend (already configured in Greek Foods). Target: new/changed routes (orders lifecycle, Ekont, chat tools).
- **Integration tests:** Greek Foods already has `testsprite_tests/`. Reuse + add MERT-M-specific cases.
- **Manual UAT:** Required for Ekont end-to-end (test credentials), Telegram bot, email-to-order, warehouse packing workflow.
- **Smoke tests on Mac Mini deployment:** Login, create product, create partner, create order, send to warehouse, pack, create Ekont waybill. Run after each phase.

## 9. Rollout Phases

| Phase | Days  | Deliverable                                                                                             |
| ----- | ----- | ------------------------------------------------------------------------------------------------------- |
| 0     | 1     | Clean clone of Greek Foods into `/Users/magic/Projects/mert-m/`, new git history, renamed refs          |
| 1     | 1-2   | Remove batch tracking and expiry logic (routes, frontend, migration guard)                              |
| 2     | 2-3   | Apply MERT-M branding (colors, logo, icons, loader)                                                     |
| 3     | 3-5   | Product weight + full Ekont integration (migration, route, UI panel)                                    |
| 4     | 5-7   | Stock-deducted flag + warehouse packing workflow + WarehousePacking page + warehouse user seed          |
| 5     | 7-10  | AI agent (chat route) + web ChatWidget + Telegram bot                                                   |
| 6     | 10    | Email-to-order (AI parser placeholder — deterministic parser deferred until template is available)      |
| 7     | 11-12 | Mac Mini #1 deployment, Tailscale setup, PM2 ecosystem, backup cron                                     |
| 8     | 13+   | UAT with MERT-M team, go-live (production Ekont / OpenAI / Telegram creds, real product catalog import) |

**Total estimate:** ~2 weeks from clone to production.

## 10. Open Items / TBD

- **Email-to-order template (v1.1):** real email format from MERT-M's website is not yet available. Will be clarified within a few days. Deterministic parser is written after template is received.
- **Full product catalog:** MERT-M will export their existing database later. For now the 50 demo products are sufficient for development and UAT.
- **Production Ekont credentials:** to be provided by MERT-M on go-live; development uses demo/test credentials.
- **Production OpenAI API key and Telegram bot token:** to be provisioned before go-live.

## 11. Out of Scope (v1)

- Mobile app (future phase, optional)
- B2B public website (future phase, optional)
- Customer-facing Telegram bot or chat (internal only for v1)
- AI agent persistent conversation history (stateless in v1)
- Hot standby / streaming replication (manual restore from backup is the v1 DR plan)
- Batch and expiry tracking (permanently removed for MERT-M use case)

## 12. Success Criteria

- Greek Foods platform remains untouched (no commits, no file changes, DB untouched).
- MERT-M backend, frontend, ai-service running stably on Mac Mini #1.
- Manager can access dashboard and reports from Mac Mini #2 both on LAN and remotely via Tailscale.
- Warehouse staff can pack orders using only the `WarehousePacking` page.
- Ekont waybills are created and tracked end-to-end with test credentials.
- Admin can chat with the AI agent over both Telegram and the web widget and receive correct answers and execute mutations (with audit trail).
- Email-to-order picks up a test email and creates a `pending_review` order within 2 minutes.
- Nightly backups land on both External HDDs and are restorable.
