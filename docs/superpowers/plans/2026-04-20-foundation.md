# MERT-M Foundation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Clone the Greek Foods platform into `/Users/magic/Projects/mert-m/`, remove all batch/expiry tracking, and apply MERT-M branding — producing a working MERT-M warehouse software baseline equivalent to Greek Foods minus perishables features, plus MERT-M visual identity.

**Architecture:** `cp -R` clone Greek Foods preserving already-present `/Users/magic/Projects/mert-m/docs/`. Rename all "greek-foods" identifiers to "mert-m". Strip batch/expiry code from backend routes, DB (via deprecation migration), and frontend UI. Replace theme colors and assets with MERT-M's dark-navy + orange scheme.

**Tech Stack:** Fastify 5, TypeScript 5.7, PostgreSQL 16, React 19, Vite, Tailwind CSS v4, Vitest, Docker Compose.

**Reference spec:** [2026-04-20-mert-m-warehouse-software-design.md](../specs/2026-04-20-mert-m-warehouse-software-design.md)

---

## File Structure

**Files created (new in MERT-M):**

- `/Users/magic/Projects/mert-m/warehouse-backend/migrations/031_mertm_deprecate_batches.sql` — deprecates `batches` table and `expiry_*`, `batch_*`, `production_date` columns (safe, non-destructive)
- `/Users/magic/Projects/mert-m/CLAUDE.md` — MERT-M project guide (replaces Greek Foods one)
- `/Users/magic/Projects/mert-m/.gitignore` — standard Node/env ignores
- `/Users/magic/Projects/mert-m/README.md` — MERT-M overview (replaces Greek Foods one)

**Files deleted:**

- `warehouse-backend/src/routes/batches.ts` (206 lines, fully removed)
- `warehouse-backend/src/routes/writeoffs.ts` (batch-centric — out of MERT-M scope for v1)
- `warehouse-backend/src/routes/writeoff-pdf-handler.ts`
- `warehouse-backend/src/services/writeoff-pdf.ts`
- `warehouse-frontend/src/pages/WriteOffs.tsx`
- `warehouse-frontend/src/components/WriteOffDialog.tsx`

**Files modified (identifier rename: "greek-foods" → "mert-m"):**

- `warehouse-backend/package.json` (name field)
- `warehouse-frontend/package.json`
- `ai-service/pyproject.toml` or `ai-service/setup.py`
- `docker-compose.yml` (service names, image tags, volume names)
- `docker-compose.backup.yml`
- `warehouse-backend/.env.example` (DATABASE_URL → `mertm_warehouse`)

**Files modified (batch removal):**

- `warehouse-backend/src/routes/inventory.ts` — remove `no_expiry`/`no_batch` filters, `GET /expiring`, `PUT /:productId/batch/:batchId`, batch joins in main query
- `warehouse-backend/src/routes/orders.ts` — remove FEFO fulfillment, batch_id in order_items, batch deduction logic
- `warehouse-backend/src/routes/incoming.ts` — remove batch creation on confirmation
- `warehouse-backend/src/index.ts` — unregister deleted routes (batches, writeoffs)
- `warehouse-frontend/src/pages/Inventory.tsx` — remove EditBatchData, batch columns, batch edit dialogs
- `warehouse-frontend/src/pages/Orders.tsx` — remove batch columns from order detail
- `warehouse-frontend/src/pages/IncomingGoods.tsx` — remove batch entry fields

**Files modified (branding):**

- `warehouse-frontend/src/index.css` — swap theme colors
- `warehouse-frontend/src/components/Layout.tsx` — update logo/title to MERT-M
- `warehouse-frontend/src/components/BakaliqLoader.tsx` — rename + re-color (already exists in Greek Foods)
- `warehouse-frontend/src/pages/Login.tsx` — MERT-M branding
- `warehouse-frontend/index.html` — page title, meta tags, theme-color
- `warehouse-frontend/public/apple-touch-icon.svg`, `icon-192.svg`, `icon-512.svg` — replace with MERT-M logos from demo

---

## Task 1: Clone Greek Foods into mert-m preserving docs

**Files:**

- Read: `/Users/magic/Projects/greek-foods-platform/` (source, no writes)
- Create: `/Users/magic/Projects/mert-m/warehouse-backend/`, `warehouse-frontend/`, `ai-service/`, etc.
- Preserve: `/Users/magic/Projects/mert-m/docs/` (already has the spec committed)

- [ ] **Step 1.1: Verify Greek Foods checksum before clone**

Run to snapshot Greek Foods state so we can verify it was untouched later:

```bash
cd /Users/magic/Projects/greek-foods-platform && git rev-parse HEAD > /tmp/gf-head-before.txt && git status --porcelain > /tmp/gf-status-before.txt && ls -la > /tmp/gf-root-before.txt
cat /tmp/gf-head-before.txt
```

Expected: a git SHA prints. Save it — we compare at the end.

- [ ] **Step 1.2: Copy Greek Foods files into mert-m (excluding .git and node_modules)**

The mert-m/ directory already exists with `docs/` and `.git/`. We must NOT overwrite either.

Run:

```bash
cd /Users/magic/Projects/greek-foods-platform
rsync -av --exclude='.git' --exclude='node_modules' --exclude='dist' --exclude='.env' --exclude='.env.local' --exclude='docs/' ./ /Users/magic/Projects/mert-m/
```

Expected: files copied; `/Users/magic/Projects/mert-m/warehouse-backend/`, `warehouse-frontend/`, `ai-service/`, `mobile-app/`, `b2b-website/`, etc. all exist. `/Users/magic/Projects/mert-m/docs/` is untouched (still has our spec).

- [ ] **Step 1.3: Verify the clone**

Run:

```bash
ls /Users/magic/Projects/mert-m/
test -d /Users/magic/Projects/mert-m/warehouse-backend/src/routes && echo OK_BACKEND
test -d /Users/magic/Projects/mert-m/warehouse-frontend/src && echo OK_FRONTEND
test -f /Users/magic/Projects/mert-m/docs/superpowers/specs/2026-04-20-mert-m-warehouse-software-design.md && echo OK_SPEC_PRESERVED
```

Expected: `OK_BACKEND`, `OK_FRONTEND`, `OK_SPEC_PRESERVED` all print.

- [ ] **Step 1.4: Commit the clone**

```bash
cd /Users/magic/Projects/mert-m
git add -A
git commit -m "chore: clone Greek Foods platform as MERT-M baseline

Initial structured clone from greek-foods-platform (at SHA $(cat /tmp/gf-head-before.txt)).
Excludes .git, node_modules, dist, .env files.
docs/ preserved from initial mert-m design commit."
git log --oneline
```

Expected: two commits: the earlier `docs: add MERT-M warehouse software design spec` and the new `chore: clone Greek Foods platform as MERT-M baseline`.

---

## Task 2: Rename identifiers "greek-foods" → "mert-m"

**Files:**

- Modify: `warehouse-backend/package.json`
- Modify: `warehouse-frontend/package.json`
- Modify: `ai-service/` config file
- Modify: `docker-compose.yml`, `docker-compose.backup.yml`
- Modify: `warehouse-backend/.env.example`
- Create: new `CLAUDE.md` and `README.md` at the root

- [ ] **Step 2.1: Find all occurrences of greek-foods references**

Run to enumerate what we need to change:

```bash
cd /Users/magic/Projects/mert-m
grep -rln -i "greek[-_ ]foods\|gf-\|greek_foods\|greekfoods" --exclude-dir=node_modules --exclude-dir=.git --exclude-dir=dist | head -30
```

Expected: list of files including `package.json`s, `docker-compose.yml`, probably some TS/MD files. Keep this list for reference.

- [ ] **Step 2.2: Update warehouse-backend/package.json name**

Open `/Users/magic/Projects/mert-m/warehouse-backend/package.json` and change the `name` field:

```json
{
  "name": "mertm-warehouse-backend",
  "version": "1.0.0",
  "description": "MERT-M Warehouse Management System — Backend API",
  ...
}
```

- [ ] **Step 2.3: Update warehouse-frontend/package.json name**

Open `/Users/magic/Projects/mert-m/warehouse-frontend/package.json` and change:

```json
{
  "name": "mertm-warehouse-frontend",
  ...
}
```

- [ ] **Step 2.4: Update docker-compose.yml**

In `/Users/magic/Projects/mert-m/docker-compose.yml`, replace the `POSTGRES_DB` (usually `greek_foods_warehouse`) and image tags. Open and change:

- `POSTGRES_DB=mertm_warehouse` (was `greek_foods_warehouse` or similar)
- Any `image: greek-foods-*` or `container_name: greek-foods-*` → `mertm-*`
- Volume names containing `greek_foods` → `mertm`

- [ ] **Step 2.5: Update .env.example DATABASE_URL default**

In `/Users/magic/Projects/mert-m/warehouse-backend/.env.example`, change the `DATABASE_URL` default to `postgresql://warehouse:warehouse@localhost:5432/mertm_warehouse`.

- [ ] **Step 2.6: Replace root CLAUDE.md**

Overwrite `/Users/magic/Projects/mert-m/CLAUDE.md` with:

```markdown
# MERT-M Warehouse Software — Project Guide

## Project Overview

Warehouse management system for MERT-M, a Bulgarian distributor of commercial
kitchen equipment (Hendi, Bartscher, KitchenAid, Liebherr and similar brands).
Cloned from greek-foods-platform. Batch/expiry tracking removed (not needed for
durable goods).

## Services

- warehouse-backend (Fastify / TS / PostgreSQL 16) — port 3003
- warehouse-frontend (React / Vite / Tailwind v4) — port 5173 dev
- ai-service (Python / FastAPI) — port 8000, OCR of incoming documents

## Agent Army

All agent configurations live in `.claude/agents/`. Read the corresponding agent
file before working on a specific service.

## Critical Rules

- Language: Bulgarian for user-facing text, English for code/comments
- Currency: BGN, VAT: 20%, Timezone: Europe/Sofia
- Auth: JWT (8h expiry), roles: admin, accountant, warehouse
- DB: PostgreSQL 16, parameterized queries only
- No hardcoded secrets — use .env files
- Dates: ISO 8601 / TIMESTAMPTZ
- **No batch/expiry tracking — MERT-M sells durable goods, not perishables.**

## Git Workflow

- Branching: `main` → `feature/MERTM-*` / `fix/MERTM-*`
- Commits: conventional (feat, fix, refactor, test, docs, chore)
- Never force push to main

## Reference Docs

- Design spec: `docs/superpowers/specs/2026-04-20-mert-m-warehouse-software-design.md`
- Plans: `docs/superpowers/plans/`

## Deployment

Self-hosted on Mac Mini M4 at MERT-M office (see spec section 3.2).
```

- [ ] **Step 2.7: Replace root README.md**

Overwrite `/Users/magic/Projects/mert-m/README.md` with a short header:

````markdown
# MERT-M Warehouse Software

Warehouse management system for MERT-M (commercial kitchen equipment distributor).

See `docs/superpowers/specs/2026-04-20-mert-m-warehouse-software-design.md`
for the full architecture and rationale.

## Quick Start

```bash
# Backend
cd warehouse-backend && docker-compose up -d && npm install && npm run migrate && npm run dev

# Frontend
cd warehouse-frontend && npm install && npm run dev

# AI Service
cd ai-service && docker-compose -f docker-compose.ai.yml up -d
```
````

## Status

Implementation in progress — see `docs/superpowers/plans/`.

````

- [ ] **Step 2.8: Verify no stale "greek-foods" refs remain in critical config**

```bash
cd /Users/magic/Projects/mert-m
grep -rn -i "greek[-_ ]foods\|greekfoods" package.json warehouse-backend/package.json warehouse-frontend/package.json docker-compose.yml warehouse-backend/.env.example CLAUDE.md README.md 2>/dev/null
````

Expected: no matches.

- [ ] **Step 2.9: Commit rename**

```bash
cd /Users/magic/Projects/mert-m
git add -A
git commit -m "chore: rename greek-foods identifiers to mert-m in root configs

- Update package.json name fields, docker-compose service/db names
- Replace root CLAUDE.md and README.md with MERT-M versions
- Update .env.example DATABASE_URL default to mertm_warehouse"
```

---

## Task 3: Smoke test — clone boots without changes

**Files:**

- Read: `warehouse-backend/package.json`, `warehouse-frontend/package.json`, `docker-compose.yml`

- [ ] **Step 3.1: Install backend dependencies**

```bash
cd /Users/magic/Projects/mert-m/warehouse-backend
npm install
```

Expected: no errors; `node_modules/` created.

- [ ] **Step 3.2: Install frontend dependencies**

```bash
cd /Users/magic/Projects/mert-m/warehouse-frontend
npm install
```

Expected: no errors.

- [ ] **Step 3.3: Verify TypeScript compiles in backend**

```bash
cd /Users/magic/Projects/mert-m/warehouse-backend
npx tsc --noEmit
```

Expected: exit 0, no TypeScript errors (baseline sanity before we start modifying code).

- [ ] **Step 3.4: Verify frontend builds**

```bash
cd /Users/magic/Projects/mert-m/warehouse-frontend
npm run build
```

Expected: exit 0, `dist/` generated.

- [ ] **Step 3.5: Verify Greek Foods is still untouched**

```bash
cd /Users/magic/Projects/greek-foods-platform
git rev-parse HEAD > /tmp/gf-head-after.txt
git status --porcelain > /tmp/gf-status-after.txt
diff /tmp/gf-head-before.txt /tmp/gf-head-after.txt && echo HEAD_UNCHANGED
diff /tmp/gf-status-before.txt /tmp/gf-status-after.txt && echo STATUS_UNCHANGED
```

Expected: both `HEAD_UNCHANGED` and `STATUS_UNCHANGED` print — confirms we've not modified Greek Foods.

---

## Task 4: Deprecation migration for batches

**Files:**

- Create: `warehouse-backend/migrations/031_mertm_deprecate_batches.sql`

This migration is safe and idempotent — it adds a comment marking deprecation, but does not drop anything. The `batches` table and expiry columns still exist physically, just unused by code.

- [ ] **Step 4.1: List the latest existing migration**

```bash
ls /Users/magic/Projects/mert-m/warehouse-backend/migrations/ | sort | tail -5
```

Expected: highest-numbered migration is 028 or 029 or 030 (depending on Greek Foods' current state). Note that number — the new one is `031_` (higher than any existing).

If the highest is something different, adjust the new migration number to be `max + 1`.

- [ ] **Step 4.2: Create the deprecation migration**

Create `/Users/magic/Projects/mert-m/warehouse-backend/migrations/031_mertm_deprecate_batches.sql` with:

```sql
-- 031_mertm_deprecate_batches.sql
-- MERT-M does not sell perishable goods, so batches and expiry tracking
-- are no longer used by application code. This migration marks the schema
-- as deprecated but does NOT drop anything (for rollback safety).
-- A future migration (v1.1, after ~2-4 weeks stable operation) will drop
-- the table and columns.

COMMENT ON TABLE batches IS
  'DEPRECATED 2026-04-20 — MERT-M does not use batch/expiry tracking. No code writes to this table. Scheduled for DROP in v1.1.';

COMMENT ON COLUMN incoming_items.batch_number IS
  'DEPRECATED 2026-04-20 — unused by MERT-M. Scheduled for DROP in v1.1.';

COMMENT ON COLUMN incoming_items.expiry_date IS
  'DEPRECATED 2026-04-20 — unused by MERT-M. Scheduled for DROP in v1.1.';

COMMENT ON COLUMN incoming_items.production_date IS
  'DEPRECATED 2026-04-20 — unused by MERT-M. Scheduled for DROP in v1.1.';

COMMENT ON COLUMN order_items.batch_id IS
  'DEPRECATED 2026-04-20 — unused by MERT-M. Scheduled for DROP in v1.1.';

COMMENT ON COLUMN inventory.batch_id IS
  'DEPRECATED 2026-04-20 — unused by MERT-M. Scheduled for DROP in v1.1.';
```

Note: the exact column names may differ slightly in your schema. Before running, verify with:

```bash
grep -n "batch_id\|expiry_date\|production_date\|batch_number" /Users/magic/Projects/mert-m/warehouse-backend/migrations/001_initial.sql
```

Adjust the migration file if columns live in other tables.

- [ ] **Step 4.3: Start Postgres and run migrations to verify the new one applies cleanly**

```bash
cd /Users/magic/Projects/mert-m/warehouse-backend
docker compose up -d postgres
# Wait ~3 seconds for postgres to be ready
npm run migrate
```

Expected: migration runner reports `031_mertm_deprecate_batches.sql` executed with no error.

- [ ] **Step 4.4: Verify the comment is set**

```bash
docker exec -i $(docker ps -qf "ancestor=postgres:16") psql -U warehouse -d mertm_warehouse -c "SELECT obj_description('batches'::regclass);"
```

Expected: output contains "DEPRECATED 2026-04-20 — MERT-M does not use batch/expiry tracking".

- [ ] **Step 4.5: Commit**

```bash
cd /Users/magic/Projects/mert-m
git add warehouse-backend/migrations/031_mertm_deprecate_batches.sql
git commit -m "feat(db): deprecate batches table and expiry columns for MERT-M

MERT-M sells durable goods, not perishables. Batches and expiry columns
stay in the schema for rollback safety but are marked DEPRECATED and
will be dropped in v1.1 after stable operation."
```

---

## Task 5: Remove batches route and write-offs (backend)

**Files:**

- Delete: `warehouse-backend/src/routes/batches.ts`
- Delete: `warehouse-backend/src/routes/writeoffs.ts`
- Delete: `warehouse-backend/src/routes/writeoff-pdf-handler.ts`
- Delete: `warehouse-backend/src/services/writeoff-pdf.ts`
- Modify: `warehouse-backend/src/index.ts` (unregister routes)

Rationale: `writeoffs.ts` in Greek Foods is centered on writing off expired batches. MERT-M doesn't have expiry, so the feature as-is doesn't fit. If MERT-M needs a generic damage/loss write-off later, we'll design it fresh in a future plan.

- [ ] **Step 5.1: Find route registration in index.ts**

```bash
grep -n "batches\|writeoff" /Users/magic/Projects/mert-m/warehouse-backend/src/index.ts
```

Expected: 1-3 lines showing `app.register(batchesRoutes, ...)` and writeoff registrations.

- [ ] **Step 5.2: Write a failing test that asserts batches endpoint returns 404**

Create or append to `/Users/magic/Projects/mert-m/warehouse-backend/src/__tests__/batches-removed.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import { build } from "../index";

describe("batches route removal (MERT-M)", () => {
  it("GET /batches returns 404 — endpoint no longer registered", async () => {
    const app = await build();
    const res = await app.inject({ method: "GET", url: "/batches" });
    expect(res.statusCode).toBe(404);
    await app.close();
  });

  it("GET /writeoffs returns 404 — endpoint no longer registered", async () => {
    const app = await build();
    const res = await app.inject({ method: "GET", url: "/writeoffs" });
    expect(res.statusCode).toBe(404);
    await app.close();
  });
});
```

If `build()` is not exported from `index.ts`, check how existing tests bootstrap the app (look in `src/__tests__/`), and follow that pattern.

- [ ] **Step 5.3: Run the test — it should FAIL because routes still exist**

```bash
cd /Users/magic/Projects/mert-m/warehouse-backend
npx vitest run src/__tests__/batches-removed.test.ts
```

Expected: FAIL (routes still return 200 or other non-404). This confirms we haven't already broken them.

- [ ] **Step 5.4: Delete route files**

```bash
cd /Users/magic/Projects/mert-m/warehouse-backend
rm src/routes/batches.ts
rm src/routes/writeoffs.ts
rm src/routes/writeoff-pdf-handler.ts
rm src/services/writeoff-pdf.ts
```

- [ ] **Step 5.5: Remove route registrations in index.ts**

Open `/Users/magic/Projects/mert-m/warehouse-backend/src/index.ts` and remove the import statements and `app.register(...)` calls for `batchesRoutes`, `writeoffsRoutes`, `writeoffPdfHandler`.

- [ ] **Step 5.6: Run the failing test — it should now PASS**

```bash
cd /Users/magic/Projects/mert-m/warehouse-backend
npx vitest run src/__tests__/batches-removed.test.ts
```

Expected: PASS (both endpoints return 404).

- [ ] **Step 5.7: Run full type-check**

```bash
cd /Users/magic/Projects/mert-m/warehouse-backend
npx tsc --noEmit
```

Expected: errors about missing imports or unused types from the deleted files. Fix each one (remove the import/reference).

- [ ] **Step 5.8: Run the full test suite**

```bash
cd /Users/magic/Projects/mert-m/warehouse-backend
npm test -- --run
```

Expected: batches-related tests may fail (if Greek Foods had them) — delete or adjust those tests. Writeoff-related tests should be deleted. Document any unexpected failures and fix them.

- [ ] **Step 5.9: Commit**

```bash
cd /Users/magic/Projects/mert-m
git add -A
git commit -m "refactor(backend): remove batches and writeoffs routes

MERT-M does not track batches or expiry. Writeoffs in Greek Foods is
centered on expired-batch disposal, which doesn't apply. A generic
damage/loss writeoff can be designed fresh if needed later.

- Delete src/routes/batches.ts, writeoffs.ts, writeoff-pdf-handler.ts
- Delete src/services/writeoff-pdf.ts
- Unregister from index.ts
- Add regression test ensuring endpoints return 404"
```

---

## Task 6: Strip batch logic from inventory route

**Files:**

- Modify: `warehouse-backend/src/routes/inventory.ts`

The current route has batch joins, batch-based filters (`no_expiry`, `no_batch`), a `GET /expiring` endpoint, and a `PUT /:productId/batch/:batchId` endpoint — all need to go.

- [ ] **Step 6.1: Write failing tests for the simplified inventory API**

Create `/Users/magic/Projects/mert-m/warehouse-backend/src/__tests__/inventory-no-batch.test.ts`:

```ts
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { build } from "../index";
import type { FastifyInstance } from "fastify";

describe("inventory route (MERT-M, batch-free)", () => {
  let app: FastifyInstance;
  let token: string;

  beforeAll(async () => {
    app = await build();
    const login = await app.inject({
      method: "POST",
      url: "/auth/login",
      payload: { email: "admin@mertm.bg", password: "mertm2024!" },
    });
    token = JSON.parse(login.body).token;
  });

  afterAll(async () => {
    await app.close();
  });

  it("GET /inventory returns rows without a 'batches' key in each item", async () => {
    const res = await app.inject({
      method: "GET",
      url: "/inventory",
      headers: { authorization: `Bearer ${token}` },
    });
    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);
    const firstItem = body.items?.[0] ?? body[0];
    if (firstItem) {
      expect(firstItem).not.toHaveProperty("batches");
      expect(firstItem).not.toHaveProperty("batch_id");
    }
  });

  it("GET /inventory/expiring returns 404", async () => {
    const res = await app.inject({
      method: "GET",
      url: "/inventory/expiring",
      headers: { authorization: `Bearer ${token}` },
    });
    expect(res.statusCode).toBe(404);
  });

  it("GET /inventory?no_expiry=true ignores the filter silently (returns results)", async () => {
    const res = await app.inject({
      method: "GET",
      url: "/inventory?no_expiry=true",
      headers: { authorization: `Bearer ${token}` },
    });
    expect(res.statusCode).toBe(200);
  });
});
```

- [ ] **Step 6.2: Run the test — it should FAIL**

```bash
cd /Users/magic/Projects/mert-m/warehouse-backend
npx vitest run src/__tests__/inventory-no-batch.test.ts
```

Expected: FAIL (current code still returns batches and has /expiring endpoint).

- [ ] **Step 6.3: Rewrite inventory.ts without batch logic**

Open `/Users/magic/Projects/mert-m/warehouse-backend/src/routes/inventory.ts`. Replace the full file contents with a simplified version that:

1. `GET /` — list inventory aggregated per product (SUM qty across inventory rows for that product, ignoring batch_id grouping)
2. `GET /low-stock` — products where total qty < min_stock threshold
3. `GET /adjust/:productId` (or POST) — manual stock adjustment by admin
4. Deletes: `GET /expiring`, `PUT /:productId/batch/:batchId`, `no_expiry`/`no_batch` filters

The new SQL for the main list:

```sql
SELECT
  p.id AS product_id,
  p.name_bg, p.name_en, p.sku, p.category, p.unit,
  COALESCE(SUM(inv.quantity), 0) AS total_quantity,
  p.min_stock,
  p.selling_price
FROM products p
LEFT JOIN inventory inv ON inv.product_id = p.id
WHERE ($1::text IS NULL OR p.name_bg ILIKE '%' || $1 || '%' OR p.sku ILIKE '%' || $1 || '%')
  AND ($2::text IS NULL OR p.category = $2)
GROUP BY p.id
ORDER BY p.name_bg ASC
LIMIT $3 OFFSET $4
```

For the skeleton of the rewritten file, follow the existing structure of `products.ts` in the same folder — it uses similar query patterns without batches.

Keep auth guards and role checks identical to the original.

- [ ] **Step 6.4: Run the failing tests — they should now PASS**

```bash
cd /Users/magic/Projects/mert-m/warehouse-backend
npx vitest run src/__tests__/inventory-no-batch.test.ts
```

Expected: all three tests pass.

- [ ] **Step 6.5: Run full backend test suite**

```bash
cd /Users/magic/Projects/mert-m/warehouse-backend
npm test -- --run
```

Expected: any remaining tests that referenced batches fail — inspect each, delete the test or adjust to MERT-M shape. Fix until green.

- [ ] **Step 6.6: Commit**

```bash
cd /Users/magic/Projects/mert-m
git add -A
git commit -m "refactor(backend): remove batch logic from inventory route

- List endpoint now aggregates per-product instead of per-batch
- Delete GET /inventory/expiring (no expiry tracking)
- Delete PUT /inventory/:pid/batch/:bid (no batch edits)
- Drop no_expiry, no_batch query filters
- Add regression tests"
```

---

## Task 7: Strip batch logic from orders and incoming routes

**Files:**

- Modify: `warehouse-backend/src/routes/orders.ts`
- Modify: `warehouse-backend/src/routes/incoming.ts`

- [ ] **Step 7.1: Write failing test for orders without batch_id**

Create `/Users/magic/Projects/mert-m/warehouse-backend/src/__tests__/orders-no-batch.test.ts`:

```ts
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { build } from "../index";
import type { FastifyInstance } from "fastify";

describe("orders route (MERT-M, batch-free)", () => {
  let app: FastifyInstance;
  let token: string;

  beforeAll(async () => {
    app = await build();
    const login = await app.inject({
      method: "POST",
      url: "/auth/login",
      payload: { email: "admin@mertm.bg", password: "mertm2024!" },
    });
    token = JSON.parse(login.body).token;
  });

  afterAll(async () => {
    await app.close();
  });

  it("POST /orders creates an order; order_items have no batch_id in response", async () => {
    const create = await app.inject({
      method: "POST",
      url: "/orders",
      headers: { authorization: `Bearer ${token}` },
      payload: {
        partner_name: "Test Partner",
        items: [{ product_id: 1, quantity: 1, unit_price: 10 }],
      },
    });
    expect(create.statusCode).toBe(201);
    const order = JSON.parse(create.body);
    expect(order.items?.[0]).not.toHaveProperty("batch_id");
    expect(order.items?.[0]).not.toHaveProperty("batch_number");
  });
});
```

- [ ] **Step 7.2: Run — it should FAIL**

```bash
cd /Users/magic/Projects/mert-m/warehouse-backend
npx vitest run src/__tests__/orders-no-batch.test.ts
```

Expected: FAIL (current code populates batch_id).

- [ ] **Step 7.3: Edit orders.ts — remove FEFO and batch logic**

Open `/Users/magic/Projects/mert-m/warehouse-backend/src/routes/orders.ts`. Apply these changes:

1. In the order creation handler: remove the FEFO block that SELECTs from `batches` ORDER BY `expiry_date` and inserts `batch_id` into `order_items`.
2. Replace stock deduction with a simple per-product update:

```sql
UPDATE inventory
   SET quantity = quantity - $1
 WHERE product_id = $2
   AND quantity >= $1
RETURNING quantity
```

If no row is returned, raise `insufficient_stock` error.

3. Drop `batch_id` / `batch_number` from INSERT columns on `order_items`.
4. Drop any JOIN to `batches` in the GET /orders/:id query.
5. Keep all other behavior (invoicing, Ekont fields, partner resolution, totals) intact.

- [ ] **Step 7.4: Run orders test — should now PASS**

```bash
cd /Users/magic/Projects/mert-m/warehouse-backend
npx vitest run src/__tests__/orders-no-batch.test.ts
```

Expected: PASS.

- [ ] **Step 7.5: Write failing test for incoming without batch**

Create `/Users/magic/Projects/mert-m/warehouse-backend/src/__tests__/incoming-no-batch.test.ts`:

```ts
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { build } from "../index";
import type { FastifyInstance } from "fastify";

describe("incoming route (MERT-M, batch-free)", () => {
  let app: FastifyInstance;
  let token: string;

  beforeAll(async () => {
    app = await build();
    const login = await app.inject({
      method: "POST",
      url: "/auth/login",
      payload: { email: "admin@mertm.bg", password: "mertm2024!" },
    });
    token = JSON.parse(login.body).token;
  });

  afterAll(async () => {
    await app.close();
  });

  it("POST /incoming creates doc; items do not carry batch_number or expiry_date", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/incoming",
      headers: { authorization: `Bearer ${token}` },
      payload: {
        supplier_name: "Test Supplier",
        items: [{ product_id: 1, quantity: 5, unit_cost: 20 }],
      },
    });
    expect(res.statusCode).toBe(201);
    const body = JSON.parse(res.body);
    expect(body.items?.[0]).not.toHaveProperty("batch_number");
    expect(body.items?.[0]).not.toHaveProperty("expiry_date");
  });
});
```

- [ ] **Step 7.6: Run — should FAIL**

```bash
cd /Users/magic/Projects/mert-m/warehouse-backend
npx vitest run src/__tests__/incoming-no-batch.test.ts
```

Expected: FAIL.

- [ ] **Step 7.7: Edit incoming.ts — remove batch creation**

Open `/Users/magic/Projects/mert-m/warehouse-backend/src/routes/incoming.ts`. On document confirmation:

1. Remove the `INSERT INTO batches` query.
2. Replace with a direct inventory upsert:

```sql
INSERT INTO inventory (product_id, warehouse_id, quantity)
VALUES ($1, $2, $3)
ON CONFLICT (product_id, warehouse_id) DO UPDATE
  SET quantity = inventory.quantity + EXCLUDED.quantity
```

Note: the UNIQUE constraint on inventory currently is `(product_id, batch_id, warehouse_id)` per Greek Foods migration `001_initial.sql`. We need to handle this:

- **Option A (simpler for v1):** Leave constraint as-is; always pass `batch_id = NULL`. Requires `UNIQUE(product_id, batch_id, warehouse_id)` to treat NULL rows as distinct — PostgreSQL does this by default, which is a bug for our use case (it'll create many NULL-batch rows for the same product).
- **Option B (correct):** Add a partial unique index without batch_id. Add to migration 031:

```sql
-- Append to 031_mertm_deprecate_batches.sql:
CREATE UNIQUE INDEX IF NOT EXISTS inventory_product_warehouse_nobatch_uidx
  ON inventory (product_id, warehouse_id)
  WHERE batch_id IS NULL;
```

Use **Option B** and update the INSERT to specify the partial index as conflict target:

```sql
INSERT INTO inventory (product_id, warehouse_id, quantity, batch_id)
VALUES ($1, $2, $3, NULL)
ON CONFLICT (product_id, warehouse_id) WHERE batch_id IS NULL
DO UPDATE SET quantity = inventory.quantity + EXCLUDED.quantity
```

3. Remove `batch_number`, `expiry_date`, `production_date` from INSERT on `incoming_items`.

- [ ] **Step 7.8: Re-run migrations to pick up the new partial index**

```bash
cd /Users/magic/Projects/mert-m/warehouse-backend
npm run migrate
```

Expected: migration 031 reapplies cleanly (idempotent), partial index now exists.

- [ ] **Step 7.9: Run incoming test — should PASS**

```bash
cd /Users/magic/Projects/mert-m/warehouse-backend
npx vitest run src/__tests__/incoming-no-batch.test.ts
```

Expected: PASS.

- [ ] **Step 7.10: Full suite**

```bash
cd /Users/magic/Projects/mert-m/warehouse-backend
npm test -- --run
```

Expected: all pass; any remaining batch-related failures get addressed now (delete or fix).

- [ ] **Step 7.11: Commit**

```bash
cd /Users/magic/Projects/mert-m
git add -A
git commit -m "refactor(backend): remove batch logic from orders and incoming routes

- Orders: simple per-product stock deduction instead of FEFO
- Incoming: direct inventory upsert instead of batch creation
- Add partial unique index on inventory(product_id, warehouse_id) where batch_id IS NULL
- Add regression tests for both routes"
```

---

## Task 8: Remove batch UI from frontend pages

**Files:**

- Modify: `warehouse-frontend/src/pages/Inventory.tsx`
- Modify: `warehouse-frontend/src/pages/Orders.tsx`
- Modify: `warehouse-frontend/src/pages/IncomingGoods.tsx`
- Delete: `warehouse-frontend/src/pages/WriteOffs.tsx`
- Delete: `warehouse-frontend/src/components/WriteOffDialog.tsx`
- Modify: `warehouse-frontend/src/App.tsx` or router config — unregister WriteOffs page

- [ ] **Step 8.1: List batch references across the frontend**

```bash
cd /Users/magic/Projects/mert-m/warehouse-frontend
grep -rln "batch\|Batch\|expiry\|Expiry" src/ | grep -v "dist\|node_modules"
```

Note the file list for scope. Expected: Inventory.tsx, Orders.tsx, IncomingGoods.tsx, WriteOffs.tsx, WriteOffDialog.tsx, plus some type files.

- [ ] **Step 8.2: Delete WriteOffs page and dialog**

```bash
cd /Users/magic/Projects/mert-m/warehouse-frontend
rm src/pages/WriteOffs.tsx
rm src/components/WriteOffDialog.tsx
```

- [ ] **Step 8.3: Unregister WriteOffs route**

Find where routes are registered (usually `App.tsx` or `router.tsx`):

```bash
grep -rn "WriteOffs\|writeoffs" /Users/magic/Projects/mert-m/warehouse-frontend/src/ --include="*.tsx" --include="*.ts"
```

Remove the `<Route path="/writeoffs" ... />` entry and the import.

- [ ] **Step 8.4: Remove WriteOffs link from Layout sidebar**

```bash
grep -n "writeoffs\|WriteOffs\|Списвания\|Брак" /Users/magic/Projects/mert-m/warehouse-frontend/src/components/Layout.tsx
```

Remove the nav item.

- [ ] **Step 8.5: Simplify Inventory.tsx — remove batch columns and edit dialog**

Open `/Users/magic/Projects/mert-m/warehouse-frontend/src/pages/Inventory.tsx`. Apply:

1. Remove `EditBatchData` interface, `EditBatchDialog` component, `normalizedBatches` logic.
2. Remove the "batches" column/accordion expansion in the table.
3. Remove `no_expiry`/`no_batch` from `QualityFilter` type and any filter chip UI.
4. Update the TanStack Query key to reflect simplified shape.
5. The row model becomes: `{ product_id, name_bg, sku, category, total_quantity, min_stock }` — update types accordingly.
6. Remove the "Edit batch qty" button; replace with "Adjust stock" that calls a simple POST (if the route exists; otherwise skip the button for now — can be added later).

- [ ] **Step 8.6: Simplify Orders.tsx — remove batch columns from order detail**

Open `/Users/magic/Projects/mert-m/warehouse-frontend/src/pages/Orders.tsx`. Remove any `batch_id` or `batch_number` columns from the order-items display. Line items show: product name, qty, unit price, subtotal.

- [ ] **Step 8.7: Simplify IncomingGoods.tsx — remove expiry/batch inputs**

Open `/Users/magic/Projects/mert-m/warehouse-frontend/src/pages/IncomingGoods.tsx`. Remove batch_number and expiry_date input fields on the item entry form. Item entry becomes: product, qty, unit cost.

- [ ] **Step 8.8: Verify the frontend builds**

```bash
cd /Users/magic/Projects/mert-m/warehouse-frontend
npm run build
```

Expected: no TypeScript errors, build succeeds.

- [ ] **Step 8.9: Dev-server smoke test via preview tools**

```bash
cd /Users/magic/Projects/mert-m/warehouse-frontend
npm run dev
```

(Use `preview_start` to open the dev URL, not raw Bash for the browser.)

Checks:

- Login page loads
- After login, sidebar has no "Брак/WriteOffs" entry
- Inventory page loads without errors; no "batches" column
- Orders page loads; creating a new order works; items don't show batch info
- IncomingGoods page loads; new incoming doc form has no batch/expiry fields

- [ ] **Step 8.10: Commit**

```bash
cd /Users/magic/Projects/mert-m
git add -A
git commit -m "refactor(frontend): remove batch/expiry UI from pages

- Delete WriteOffs page and dialog, unregister route
- Simplify Inventory.tsx to per-product rows
- Remove batch columns from Orders and IncomingGoods forms"
```

---

## Task 9: Apply MERT-M branding — colors and theme

**Files:**

- Modify: `warehouse-frontend/src/index.css`
- Modify: `warehouse-frontend/index.html`

- [ ] **Step 9.1: Update theme CSS variables**

Open `/Users/magic/Projects/mert-m/warehouse-frontend/src/index.css`. Replace the `@theme` block (currently Greek Foods purple) with MERT-M colors:

Before (Greek Foods):

```css
@theme {
  --color-sidebar: #1a1a2e;
  --color-sidebar-hover: #16213e;
  --color-accent: #6c3dff;
  --color-accent-hover: #5a30d9;
  --color-accent-light: #ede9ff;
}
```

After (MERT-M):

```css
@theme {
  --color-sidebar: #0a1628;
  --color-sidebar-hover: #0f1f3a;
  --color-accent: #f97316;
  --color-accent-hover: #ea580c;
  --color-accent-light: #fff7ed;
}
```

Keep all other rules (iOS PWA fixes, etc.) identical — only the `@theme` block changes.

- [ ] **Step 9.2: Update body background color**

Still in `index.css`, the `html, body` rule has `background-color: #0b1222` (matches Greek Foods). Change to match MERT-M sidebar:

```css
html,
body {
  background-color: #0a1628; /* matches MERT-M theme-color meta */
  ...
}
```

- [ ] **Step 9.3: Update index.html theme-color and title**

Open `/Users/magic/Projects/mert-m/warehouse-frontend/index.html`. Change:

- `<title>Greek Foods ...</title>` → `<title>МЕРТ-М Склад</title>`
- `<meta name="theme-color" content="#...">` → `<meta name="theme-color" content="#0a1628">`
- Any `description` or `og:title` meta tags → MERT-M equivalents

- [ ] **Step 9.4: Start dev server and visually verify**

```bash
cd /Users/magic/Projects/mert-m/warehouse-frontend
npm run dev
```

Use `preview_start` to open, then `preview_screenshot` and `preview_inspect` to confirm:

- Sidebar is dark navy (`#0a1628`)
- Accent (buttons, links) is orange (`#f97316`)
- Browser tab title shows "МЕРТ-М Склад"
- No console errors

- [ ] **Step 9.5: Commit**

```bash
cd /Users/magic/Projects/mert-m
git add -A
git commit -m "feat(frontend): apply MERT-M theme colors

- Sidebar: dark navy #0a1628
- Accent: orange #f97316
- Update page title and theme-color meta"
```

---

## Task 10: Replace logos and icons with MERT-M versions

**Files:**

- Replace: `warehouse-frontend/public/apple-touch-icon.svg`
- Replace: `warehouse-frontend/public/icon-192.svg`
- Replace: `warehouse-frontend/public/icon-512.svg`

- [ ] **Step 10.1: Copy MERT-M icons from demo**

```bash
cp /Users/magic/Projects/mert-m-demo/warehouse-frontend/public/apple-touch-icon.svg /Users/magic/Projects/mert-m/warehouse-frontend/public/apple-touch-icon.svg
cp /Users/magic/Projects/mert-m-demo/warehouse-frontend/public/icon-192.svg /Users/magic/Projects/mert-m/warehouse-frontend/public/icon-192.svg
cp /Users/magic/Projects/mert-m-demo/warehouse-frontend/public/icon-512.svg /Users/magic/Projects/mert-m/warehouse-frontend/public/icon-512.svg
```

- [ ] **Step 10.2: Verify via preview**

```bash
cd /Users/magic/Projects/mert-m/warehouse-frontend
npm run dev
```

Open with preview tools, check:

- Browser tab favicon shows MERT-M icon
- On mobile viewport (resize with `preview_resize`), the PWA icon is correct
- No 404 errors in preview_network for icon paths

- [ ] **Step 10.3: Commit**

```bash
cd /Users/magic/Projects/mert-m
git add warehouse-frontend/public/apple-touch-icon.svg warehouse-frontend/public/icon-192.svg warehouse-frontend/public/icon-512.svg
git commit -m "feat(frontend): add MERT-M logo icons for PWA and browser"
```

---

## Task 11: Update Layout.tsx and Login.tsx branding text

**Files:**

- Modify: `warehouse-frontend/src/components/Layout.tsx`
- Modify: `warehouse-frontend/src/pages/Login.tsx`

- [ ] **Step 11.1: Update Layout.tsx sidebar header**

Open `/Users/magic/Projects/mert-m/warehouse-frontend/src/components/Layout.tsx`. Find the sidebar logo/title area (usually near the top of the component). Replace:

- "Greek Foods" / "Гръцки Храни" / similar → "МЕРТ-М"
- Any subtitle like "Warehouse Management" → "Склад"

Keep component structure and all class names intact — text-only changes.

- [ ] **Step 11.2: Update Login.tsx branding**

Open `/Users/magic/Projects/mert-m/warehouse-frontend/src/pages/Login.tsx`. Replace:

- Page heading "Greek Foods" → "МЕРТ-М Склад"
- Welcome subtitle → "Влезте в системата за управление на склад"
- Footer attribution (if any) → "МЕРТ-М © 2026"

- [ ] **Step 11.3: Visually verify via preview**

```bash
cd /Users/magic/Projects/mert-m/warehouse-frontend
npm run dev
```

Use `preview_start`, `preview_snapshot` (Login page), `preview_click` on login with seeded admin creds, then `preview_snapshot` (main app). Confirm:

- Login page shows "МЕРТ-М Склад"
- Sidebar shows "МЕРТ-М" at the top

- [ ] **Step 11.4: Commit**

```bash
cd /Users/magic/Projects/mert-m
git add -A
git commit -m "feat(frontend): apply MERT-M branding text in Layout and Login"
```

---

## Task 12: Update BakaliqLoader for MERT-M

**Files:**

- Modify: `warehouse-frontend/src/components/BakaliqLoader.tsx`

The component exists in Greek Foods already. Demo has a re-colored version (87 lines, same structure). We update colors to match MERT-M theme.

- [ ] **Step 12.1: Diff the two versions**

```bash
diff /Users/magic/Projects/mert-m/warehouse-frontend/src/components/BakaliqLoader.tsx /Users/magic/Projects/mert-m-demo/warehouse-frontend/src/components/BakaliqLoader.tsx
```

Expected: mostly color/fill values differ.

- [ ] **Step 12.2: Copy demo version wholesale**

```bash
cp /Users/magic/Projects/mert-m-demo/warehouse-frontend/src/components/BakaliqLoader.tsx /Users/magic/Projects/mert-m/warehouse-frontend/src/components/BakaliqLoader.tsx
```

- [ ] **Step 12.3: Verify build still passes**

```bash
cd /Users/magic/Projects/mert-m/warehouse-frontend
npm run build
```

Expected: exit 0.

- [ ] **Step 12.4: Visually verify the loader**

```bash
cd /Users/magic/Projects/mert-m/warehouse-frontend
npm run dev
```

Trigger a loading state (e.g., throttle network in preview and refresh the Dashboard). `preview_screenshot` the loader — should show MERT-M-colored animation.

- [ ] **Step 12.5: Commit**

```bash
cd /Users/magic/Projects/mert-m
git add warehouse-frontend/src/components/BakaliqLoader.tsx
git commit -m "feat(frontend): update BakaliqLoader to MERT-M colors"
```

---

## Task 13: End-to-end foundation smoke test

**Files:**

- No new files; integration verification only.

- [ ] **Step 13.1: Fresh full boot**

```bash
cd /Users/magic/Projects/mert-m/warehouse-backend
docker compose down -v
docker compose up -d postgres
sleep 3
npm run migrate
npm run dev &
BACKEND_PID=$!

cd /Users/magic/Projects/mert-m/warehouse-frontend
npm run dev &
FRONTEND_PID=$!

sleep 5
echo "Backend PID $BACKEND_PID, Frontend PID $FRONTEND_PID"
```

- [ ] **Step 13.2: Use preview tools to execute a manual happy-path**

Open frontend via `preview_start`. Then:

1. Login (create admin via seed or register endpoint if first-user flow is present)
2. Go to Products — add a product with name "Hendi Fritiornik 6L", SKU "HENDI-FRY-6L", price 420 BGN
3. Go to IncomingGoods — create an incoming doc with supplier "Hendi Demo" and 2x that product at cost 300 BGN
4. Confirm the incoming doc — verify stock becomes 2 on Inventory page
5. Go to Partners — add partner "Test Customer"
6. Go to Orders — create order for Test Customer with 1x the product at 420 BGN
7. Verify Inventory now shows 1 remaining
8. Verify Orders detail shows the line item with NO batch or expiry columns
9. Use `preview_screenshot` at each key step for proof

- [ ] **Step 13.3: Stop dev servers**

```bash
kill $BACKEND_PID $FRONTEND_PID 2>/dev/null
cd /Users/magic/Projects/mert-m/warehouse-backend && docker compose down
```

- [ ] **Step 13.4: Verify Greek Foods STILL untouched (final check)**

```bash
cd /Users/magic/Projects/greek-foods-platform
git status --porcelain
git rev-parse HEAD
```

Expected: output identical to Step 3.5 snapshots. If not, investigate immediately and revert any changes.

- [ ] **Step 13.5: Final commit (optional, only if any last fixes)**

If the smoke test revealed nothing to fix, skip. Otherwise fix the issue and commit:

```bash
cd /Users/magic/Projects/mert-m
git add -A
git commit -m "fix: smoke test fixes"
```

- [ ] **Step 13.6: Tag the foundation milestone**

```bash
cd /Users/magic/Projects/mert-m
git tag -a v0.1.0-foundation -m "MERT-M foundation: Greek Foods clone minus batches, plus MERT-M branding"
git log --oneline -n 15
```

Expected: tag appears; commit history shows: docs spec → clone → rename → deprecate batches migration → remove batches route → inventory/orders/incoming cleanup → WriteOffs removal → frontend cleanup → MERT-M theme → icons → Layout/Login text → BakaliqLoader.

---

## Exit Criteria

After Task 13, the following must all be true:

1. `/Users/magic/Projects/mert-m/` exists as an independent git repo, tagged `v0.1.0-foundation`.
2. `/Users/magic/Projects/greek-foods-platform/` is byte-for-byte identical to the pre-plan state (same HEAD SHA, clean git status).
3. The MERT-M frontend shows dark-navy sidebar with orange accents, MERT-M icons, title "МЕРТ-М Склад".
4. The MERT-M app boots and the manual happy-path in Task 13.2 completes without errors.
5. `npm test` in warehouse-backend passes green.
6. `GET /batches`, `GET /writeoffs`, `GET /inventory/expiring` return 404.
7. `batches` table still exists in the DB (deprecated, not dropped) with a DEPRECATED table comment set.
8. No file in the codebase references a non-existent `batch_id`, `batch_number`, `expiry_date`, or `production_date` in application code paths.

Once all exit criteria pass, Plan 1 is complete and we can start brainstorming / writing Plan 2 (Ekont + Weight).
