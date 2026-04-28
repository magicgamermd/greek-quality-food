# МЕРТ-М Warehouse Backend — Progress

## Status: ✅ Complete — All 4 Steps Built

### Step 1 — Database + Server Foundation ✅

- `src/index.ts` — Fastify server with all plugins (cors, jwt, multipart, cookie)
- `src/db.ts` — PostgreSQL pool with query helper, transaction support
- `migrations/001_initial.sql` — All 18 tables + indexes + invoice number sequence
- `src/migrate.ts` — Migration runner with tracking table
- `docker-compose.yml` — postgres, redis, backend, nginx
- `Dockerfile` — Multi-stage Node.js build
- `nginx.conf` — Reverse proxy config
- `.env.example` — All environment variables documented

### Step 2 — Auth Module ✅

- `src/routes/auth.ts` — POST login, POST register (first user = admin), POST logout, GET me
- JWT-based auth, bcrypt password hashing, Zod validation

### Step 3 — Core Routes ✅

- `src/routes/products.ts` — CRUD + stock query, search, category filter, low-stock filter
- `src/routes/inventory.ts` — Current stock, low-stock alerts, expiring batches (FEFO)
- `src/routes/incoming.ts` — Create incoming docs, AI scan upload, confirm → add to stock
- `src/routes/orders.ts` — Create, list, status update, FEFO fulfillment (stock deduction)
- `src/routes/partners.ts` — CRUD + price list management (auto-create, upsert items)
- `src/routes/invoices.ts` — Generate from order, PDF download, email sending, unpaid list
- `src/routes/payments.ts` — Record payments, overpayment protection, notifications
- `src/routes/analytics.ts` — Sales by period/product/partner, top products, stock forecast, anomaly detection

### Step 4 — Invoice PDF Service ✅

- `src/services/invoice-pdf.ts` — Full A4 PDF via PDFKit
  - Bilingual BG+EN layout
  - ЗДДС (VAT) fields: данъчна основа, ДДС%, ДДС сума
  - Invoice number format: GF-2026-XXXX (auto-sequence)
  - Company header with EIK, VAT, address, bank details
  - Partner details section
  - Items table with alternating row colors
  - Amount in Bulgarian words
  - Bank payment info (IBAN, BIC)
  - Signature areas for seller/buyer

## File Structure

```
warehouse-backend/
├── .env.example
├── docker-compose.yml
├── Dockerfile
├── nginx.conf
├── package.json
├── tsconfig.json
├── migrations/
│   └── 001_initial.sql
└── src/
    ├── index.ts
    ├── db.ts
    ├── migrate.ts
    ├── routes/
    │   ├── auth.ts
    │   ├── products.ts
    │   ├── inventory.ts
    │   ├── incoming.ts
    │   ├── orders.ts
    │   ├── partners.ts
    │   ├── invoices.ts
    │   ├── payments.ts
    │   └── analytics.ts
    └── services/
        └── invoice-pdf.ts
```

## TypeScript Compilation: ✅ Clean (0 errors)

## Notes

- Email sending uses `nodemailer` (optional dependency — graceful fallback if not installed)
- AI scan endpoint forwards to Python FastAPI service at AI_SERVICE_URL
- FEFO (First Expiry First Out) implemented in order fulfillment
- Invoice numbers auto-generated via PostgreSQL sequence
- All routes require JWT auth; role-based access (admin/warehouse/readonly)
