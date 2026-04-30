# Batch E — Quotation (Оферта) Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Add a `quoted` order status with a dedicated PDF (OF-XXX), filter pill, and the transitions to enter / exit it. Quoted orders never deduct stock; cashier prints the offer and waits for the customer.

**Architecture:** Migration 059 relaxes `orders.status` CHECK to include `'quoted'`. POST /orders accepts an initial `status: 'quoted'`. Two new endpoints handle transitions (`/quote`, `/unquote`). New PDF service `offer-pdf.ts` mirrors the commercial-doc PDF with title "ОФЕРТА". Frontend wires a new "Запази като оферта" button at create time, conditional drawer actions for the quoted state, and a `quoted: "Оферта"` entry in `statusLabels` (which automatically yields a filter pill).

**Tech Stack:** PostgreSQL 16, Fastify+TypeScript+Zod, pdfkit, Vitest, React+TanStack Query.

**Spec:** [docs/superpowers/specs/2026-04-29-batch-e-quotation-design.md](../specs/2026-04-29-batch-e-quotation-design.md)

---

## Pre-flight

- Branch: `git checkout main && git pull && git checkout -b feature/MERTM-batch-e-quotation`
- Backend tests: `cd warehouse-backend && npx vitest run`
- Type-check: `npx tsc --noEmit` (in both `warehouse-backend/` and `warehouse-frontend/`)

---

## Task 1: Migration 059 — relax status CHECK

**Files:**

- Create: `warehouse-backend/migrations/059_orders_quoted_status.sql`

**Step 1: Migration**

```sql
-- 059_orders_quoted_status.sql
-- Adds 'quoted' to the orders.status CHECK constraint so the cashier
-- can print an offer (OF-XXX) without deducting stock and wait for
-- the customer to confirm.

BEGIN;

ALTER TABLE orders DROP CONSTRAINT IF EXISTS orders_status_check;
ALTER TABLE orders
  ADD CONSTRAINT orders_status_check
  CHECK (status IN (
    'pending', 'confirmed', 'processing', 'fulfilled',
    'invoiced', 'cancelled', 'quoted'
  ));

COMMIT;
```

**Step 2: Apply + verify**

```bash
docker exec -i mertm-postgres-1 psql -U warehouse -d mertm_warehouse \
  -v ON_ERROR_STOP=1 --single-transaction \
  < warehouse-backend/migrations/059_orders_quoted_status.sql

docker exec mertm-postgres-1 psql -U warehouse -d mertm_warehouse -tAc \
  "INSERT INTO _migrations (name) VALUES ('059_orders_quoted_status.sql') ON CONFLICT DO NOTHING"

docker exec mertm-postgres-1 psql -U warehouse -d mertm_warehouse -tAc \
  "SELECT pg_get_constraintdef(c.oid) FROM pg_constraint c
   WHERE c.conrelid = 'orders'::regclass AND c.conname='orders_status_check'"
```

Expected: CHECK string includes `quoted`.

**Step 3: Commit**

```bash
git add warehouse-backend/migrations/059_orders_quoted_status.sql
git commit -m "feat(db): add 'quoted' to orders.status CHECK (059)"
```

---

## Task 2: Backend — `createOrderSchema` accepts initial status

**Files:**

- Modify: `warehouse-backend/src/routes/orders.ts:108-140` (createOrderSchema)

**Step 1: Add `status` field to the Zod schema**

```ts
const createOrderSchema = z.object({
  // …existing fields…
  status: z.enum(["pending", "quoted"]).optional().default("pending"),
});
```

**Step 2: Use in INSERT**

In the create-order handler (around `:786-805`), the INSERT defaults to `'pending'`. Replace with `body.status`:

```ts
const { rows: [order] } = await client.query(
  `INSERT INTO orders (..., status, order_number)
   VALUES (..., $N, nextval('order_number_seq'))
   RETURNING *`,
  [..., body.status],
);
```

**Step 3: Type-check + commit**

```bash
cd warehouse-backend && npx tsc --noEmit
git add warehouse-backend/src/routes/orders.ts
git commit -m "feat(orders): accept initial status='quoted' on POST /orders"
```

---

## Task 3: Backend — POST /orders/:id/quote endpoint

**Files:**

- Modify: `warehouse-backend/src/routes/orders.ts` — add new endpoint near other transitions (around the existing `/:id/fulfill` and `/:id/dispatch-to-warehouse`)

**Step 1: Add the endpoint**

```ts
// POST /:id/quote — Move pending order to quoted (offer)
app.post(
  "/:id/quote",
  { preHandler: ordersManagePreHandler },
  async (request: FastifyRequest, reply: FastifyReply) => {
    const { id } = request.params as { id: string };
    return await transaction(async (client) => {
      const {
        rows: [order],
      } = await client.query(
        "SELECT id, status FROM orders WHERE id = $1 FOR UPDATE",
        [id],
      );
      if (!order) {
        throw Object.assign(new Error("Order not found"), { statusCode: 404 });
      }
      if (order.status !== "pending") {
        throw Object.assign(
          new Error(
            "Само поръчки със статус 'Чакаща' могат да се прехвърлят в оферта.",
          ),
          { statusCode: 400 },
        );
      }
      const {
        rows: [updated],
      } = await client.query(
        "UPDATE orders SET status = 'quoted', updated_at = NOW() WHERE id = $1 RETURNING *",
        [id],
      );
      return updated;
    });
  },
);
```

**Step 2: Commit**

```bash
git add warehouse-backend/src/routes/orders.ts
git commit -m "feat(orders): POST /:id/quote — pending → quoted"
```

---

## Task 4: Backend — POST /orders/:id/unquote endpoint

**Files:**

- Modify: `warehouse-backend/src/routes/orders.ts` — same area as Task 3

**Step 1: Add**

```ts
// POST /:id/unquote — Move quoted order back to pending
app.post(
  "/:id/unquote",
  { preHandler: ordersManagePreHandler },
  async (request: FastifyRequest, reply: FastifyReply) => {
    const { id } = request.params as { id: string };
    return await transaction(async (client) => {
      const {
        rows: [order],
      } = await client.query(
        "SELECT id, status FROM orders WHERE id = $1 FOR UPDATE",
        [id],
      );
      if (!order) {
        throw Object.assign(new Error("Order not found"), { statusCode: 404 });
      }
      if (order.status !== "quoted") {
        throw Object.assign(
          new Error("Само оферти могат да преминат към обработка."),
          { statusCode: 400 },
        );
      }
      const {
        rows: [updated],
      } = await client.query(
        "UPDATE orders SET status = 'pending', updated_at = NOW() WHERE id = $1 RETURNING *",
        [id],
      );
      return updated;
    });
  },
);
```

**Step 2: Commit**

```bash
git add warehouse-backend/src/routes/orders.ts
git commit -m "feat(orders): POST /:id/unquote — quoted → pending"
```

---

## Task 5: Backend — verify fulfill / processing transitions reject quoted

**Files:**

- Read: `warehouse-backend/src/routes/orders.ts` (existing `/:id/fulfill` handler, around `:1331`)

**Step 1: Skim the fulfill handler**

It rejects on `status === 'fulfilled'` and `status === 'cancelled'`. **Add** a guard for `'quoted'`:

```ts
if (order.status === "quoted") {
  throw Object.assign(
    new Error("Cannot fulfill a quoted order — convert to pending first."),
    { statusCode: 400 },
  );
}
```

(Do the same in the existing PUT `/:id/status` handler if it accepts arbitrary transitions — verify and patch.)

**Step 2: Commit**

```bash
git add warehouse-backend/src/routes/orders.ts
git commit -m "fix(orders): explicit guard preventing fulfill on quoted orders"
```

---

## Task 6: Backend — Offer PDF service

**Files:**

- Create: `warehouse-backend/src/services/offer-pdf.ts`

**Step 1: Service modeled on `document-pdf.ts`**

Copy `document-pdf.ts` as the starting template. Strip everything except the commercial-doc rendering function. Adjust:

- Title: "ОФЕРТА" (instead of "ТЪРГОВСКИ ДОКУМЕНТ")
- Document number: `OF-{order_number padded to 7}`
- Footer note: "Цените са валидни до уговаряне."
- Remove "съгласно сключения договор" wording.

```ts
import PDFDocument from "pdfkit";
import fs from "node:fs";
import path from "node:path";
import { formatEurAmount } from "../utils/currency.js";

export interface OfferPdfData {
  offerNumber: string; // e.g. "OF-0000037"
  date: string; // ISO yyyy-mm-dd
  partner: { name: string; eik?: string; address?: string; city?: string };
  company: {
    name: string;
    eik: string;
    vat_number?: string;
    address: string;
    city?: string;
  };
  items: Array<{
    name_bg: string;
    quantity: number | string;
    unit: string;
    unit_price: number | string;
    discount_percent?: number | string;
    total_price: number | string;
  }>;
  totalNet: number;
  totalVat: number;
  totalGross: number;
  outputPath: string;
}

export async function generateOfferPdf(data: OfferPdfData): Promise<void> {
  // (full implementation, mirroring commercial-doc)
}
```

(Implementation copies the layout/loops from `document-pdf.ts`'s commercial-doc function, with the textual substitutions above.)

**Step 2: Commit**

```bash
git add warehouse-backend/src/services/offer-pdf.ts
git commit -m "feat(offer): add generateOfferPdf service (Оферта PDF)"
```

---

## Task 7: Backend — `GET /orders/:id/offer-pdf` endpoint

**Files:**

- Modify: `warehouse-backend/src/routes/orders.ts` — near other PDF endpoints (around `:2050-2130`)

**Step 1: Add**

```ts
import { generateOfferPdf } from "../services/offer-pdf.js";

app.get<{ Params: { id: string } }>(
  "/:id/offer-pdf",
  { preHandler: ordersManagePreHandler },
  async (request, reply) => {
    const id = Number(request.params.id);
    const data = await loadOrderWithBatches(id);
    if (!data) return reply.status(404).send({ error: "Order not found" });
    const { order, items } = data;
    if (order.status !== "quoted") {
      return reply.status(400).send({
        error: "Offer PDF is only available for quoted orders.",
      });
    }
    const offerNumber = `OF-${String(order.order_number || order.id).padStart(7, "0")}`;
    const company = await getCompanySettings();
    const {
      rows: [partner],
    } = await query(
      "SELECT name, eik, address, city FROM partners WHERE id = $1",
      [order.partner_id],
    );

    const totalNet = items.reduce(
      (sum, it: any) => sum + parseFloat(it.total_price),
      0,
    );
    const totalVat = totalNet * 0.2;
    const totalGross = totalNet + totalVat;

    const pdfDir = path.resolve(process.cwd(), "data", "documents");
    if (!fs.existsSync(pdfDir)) fs.mkdirSync(pdfDir, { recursive: true });
    const outputPath = path.join(pdfDir, `offer-${id}.pdf`);

    await generateOfferPdf({
      offerNumber,
      date: new Date().toISOString().split("T")[0],
      partner: partner ?? { name: "—" },
      company: {
        name: company.company_name,
        eik: company.eik,
        vat_number: company.vat_number,
        address: company.address,
        city: company.city,
      },
      items: items.map((it: any) => ({
        name_bg: it.name_bg,
        quantity: it.quantity,
        unit: it.unit || "бр.",
        unit_price: it.unit_price,
        discount_percent: it.discount_percent,
        total_price: it.total_price,
      })),
      totalNet,
      totalVat,
      totalGross,
      outputPath,
    });

    return reply.type("application/pdf").send(fs.createReadStream(outputPath));
  },
);
```

**Step 2: Commit**

```bash
git add warehouse-backend/src/routes/orders.ts
git commit -m "feat(orders): GET /:id/offer-pdf — Оферта PDF"
```

---

## Task 8: Backend integration tests

**Files:**

- Create: `warehouse-backend/src/__tests__/orders-quotation.test.ts`

**Step 1: Tests**

```ts
import Fastify from "fastify";
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../db.js", () => ({ query: vi.fn(), transaction: vi.fn() }));
vi.mock("../lib/redis.js", () => ({
  getRedis: vi.fn(async () => ({
    get: vi.fn(async () => null),
    setex: vi.fn(async () => "OK"),
    del: vi.fn(async () => 0),
  })),
}));
vi.mock("../services/offer-pdf.js", () => ({
  generateOfferPdf: vi.fn(async () => undefined),
}));

import { query, transaction } from "../db.js";
import ordersRoutes from "../routes/orders.js";

const mockTx = vi.mocked(transaction);
const mockQ = vi.mocked(query);

async function buildApp(role = "admin") {
  const app = Fastify();
  app.addHook("onRequest", async (req) => {
    (req as any).user = { id: "u1", role };
    (req as any).jwtVerify = async () => (req as any).user;
  });
  await app.register(ordersRoutes, { prefix: "/orders" });
  return app;
}

describe("Quotation flow", () => {
  beforeEach(() => {
    mockTx.mockReset();
    mockQ.mockReset();
  });

  it("POST /orders with status='quoted' creates a quoted order", async () => {
    // …mock partner, products, INSERT …
    // verify INSERT INTO orders received status='quoted'
  });

  it("POST /orders/:id/quote moves pending → quoted", async () => {
    mockTx.mockImplementationOnce(async (cb: any) =>
      cb({
        query: vi
          .fn()
          .mockResolvedValueOnce({ rows: [{ id: 1, status: "pending" }] })
          .mockResolvedValueOnce({ rows: [{ id: 1, status: "quoted" }] }),
      }),
    );
    const app = await buildApp();
    const res = await app.inject({ method: "POST", url: "/orders/1/quote" });
    expect(res.statusCode).toBe(200);
    await app.close();
  });

  it("POST /orders/:id/quote rejects 400 when status != pending", async () => {
    mockTx.mockImplementationOnce(async (cb: any) =>
      cb({
        query: vi
          .fn()
          .mockResolvedValueOnce({ rows: [{ id: 1, status: "confirmed" }] }),
      }),
    );
    const app = await buildApp();
    const res = await app.inject({ method: "POST", url: "/orders/1/quote" });
    expect(res.statusCode).toBe(400);
    await app.close();
  });

  it("POST /orders/:id/unquote moves quoted → pending", async () => {
    mockTx.mockImplementationOnce(async (cb: any) =>
      cb({
        query: vi
          .fn()
          .mockResolvedValueOnce({ rows: [{ id: 1, status: "quoted" }] })
          .mockResolvedValueOnce({ rows: [{ id: 1, status: "pending" }] }),
      }),
    );
    const app = await buildApp();
    const res = await app.inject({ method: "POST", url: "/orders/1/unquote" });
    expect(res.statusCode).toBe(200);
    await app.close();
  });

  it("POST /orders/:id/fulfill rejects 400 for quoted", async () => {
    mockTx.mockImplementationOnce(async (cb: any) =>
      cb({
        query: vi
          .fn()
          .mockResolvedValueOnce({ rows: [{ id: 1, status: "quoted" }] }),
      }),
    );
    const app = await buildApp();
    const res = await app.inject({ method: "POST", url: "/orders/1/fulfill" });
    expect(res.statusCode).toBe(400);
    await app.close();
  });

  it("GET /orders/:id/offer-pdf rejects 400 when status != quoted", async () => {
    // mock loadOrderWithBatches to return non-quoted → 400
  });
});
```

**Step 2: Run + iterate**

```bash
cd warehouse-backend && npx vitest run src/__tests__/orders-quotation.test.ts
```

**Step 3: Commit**

```bash
git add warehouse-backend/src/__tests__/orders-quotation.test.ts
git commit -m "test(orders): integration tests for quotation flow"
```

---

## Task 9: Frontend types — add `'quoted'` to status union

**Files:**

- Modify: `warehouse-frontend/src/types/index.ts:173-179` (Order.status union)

**Step 1: Add**

```ts
status:
  | "pending"
  | "confirmed"
  | "processing"
  | "fulfilled"
  | "cancelled"
  | "invoiced"
  | "quoted";    // ← NEW
```

**Step 2: Type-check**

```bash
cd warehouse-frontend && npx tsc --noEmit
```

If any switch / map fails — patch. (Likely needs entries in `statusLabels`, `statusVariants` — see Task 10.)

**Step 3: Commit**

```bash
git add warehouse-frontend/src/types/index.ts
git commit -m "feat(types): Order.status union adds 'quoted'"
```

---

## Task 10: Frontend — `statusLabels` + `statusVariants` + filter pill auto

**Files:**

- Modify: `warehouse-frontend/src/pages/Orders.tsx:103-115` (statusLabels + statusVariants)

**Step 1: Extend the maps**

```ts
const statusLabels: Record<string, string> = {
  pending: "Чакаща",
  confirmed: "Потвърдена",
  processing: "В обработка",
  fulfilled: "Изпълнена",
  cancelled: "Анулирана",
  invoiced: "Фактурирана",
  quoted: "Оферта", // ← NEW
};

const statusVariants: Record<
  string,
  "default" | "secondary" | "destructive" | "info" | "success" | "warning"
> = {
  // …existing…
  quoted: "warning", // ← NEW (amber)
};
```

(Filter pill auto-appears because the pills are generated from `statusLabels`.)

**Step 2: Smoke test**

Reload the orders page → confirm a new "Оферта" filter pill appears.

**Step 3: Commit**

```bash
git add warehouse-frontend/src/pages/Orders.tsx
git commit -m "feat(orders-fe): statusLabels.quoted='Оферта' (auto-generates filter pill)"
```

---

## Task 11: Frontend — quote / unquote mutations

**Files:**

- Modify: `warehouse-frontend/src/pages/Orders.tsx` — near other mutations (around `:580-700`)

**Step 1: Add**

```ts
const quoteMutation = useMutation({
  mutationFn: (id: number) => api.post(`/orders/${id}/quote`),
  onSuccess: () => invalidateAllOrderRelated(),
});

const unquoteMutation = useMutation({
  mutationFn: (id: number) => api.post(`/orders/${id}/unquote`),
  onSuccess: () => invalidateAllOrderRelated(),
});
```

**Step 2: Commit**

```bash
git add warehouse-frontend/src/pages/Orders.tsx
git commit -m "feat(orders-fe): quoteMutation + unquoteMutation"
```

---

## Task 12: Frontend — drawer actions for quoted state

**Files:**

- Modify: `warehouse-frontend/src/pages/Orders.tsx` — workflow actions row (around `:1183-1280`); Документи row (around `:1466-1530`)

**Step 1: Add quoted-specific actions**

Replace the existing workflow row with:

```tsx
{
  detail.status === "pending" && (
    <Button
      variant="outline"
      onClick={() => quoteMutation.mutate(detail.id)}
      disabled={quoteMutation.isPending}
      className="border-amber-500 text-amber-700 hover:bg-amber-50"
    >
      <FileText className="h-4 w-4" />
      Генерирай оферта
    </Button>
  );
}

{
  detail.status === "quoted" && (
    <>
      <Button
        variant="outline"
        onClick={() =>
          window.open(`/api/orders/${detail.id}/offer-pdf`, "_blank")
        }
      >
        <FileText className="h-4 w-4" />
        Регенерирай оферта
      </Button>
      <Button
        onClick={() => unquoteMutation.mutate(detail.id)}
        disabled={unquoteMutation.isPending}
        className="bg-emerald-600 hover:bg-emerald-700"
      >
        <CheckCircle className="h-4 w-4" />
        Премини към обработка
      </Button>
      <Button
        variant="outline"
        onClick={() => deleteOrderMutation.mutate(detail.id)}
        className="border-red-500 text-red-700 hover:bg-red-50"
      >
        <X className="h-4 w-4" />
        Откажи оферта
      </Button>
      <span className="text-xs text-gray-500 ml-2">
        Издадена преди{" "}
        {Math.floor(
          (Date.now() -
            new Date(detail.updated_at ?? detail.order_date).getTime()) /
            (1000 * 60 * 60 * 24),
        )}{" "}
        дни
      </span>
    </>
  );
}

{
  /* Existing pending/confirmed/processing/fulfilled actions wrapped in their own conditions */
}
```

**Step 2: Hide Документи row when status === 'quoted'**

```tsx
{detail.status !== "quoted" && (detail.status === "confirmed" || …) && (
  <div>{/* Документи row */}</div>
)}
```

**Step 3: Commit**

```bash
git add warehouse-frontend/src/pages/Orders.tsx
git commit -m "feat(orders-fe): drawer actions + Документи hide for quoted state"
```

---

## Task 13: Frontend — "Запази като оферта" button at create time

**Files:**

- Modify: `warehouse-frontend/src/pages/Orders.tsx` — new-order modal save area (around `:2900-3000`)

**Step 1: Two save buttons**

```tsx
<div className="flex gap-2">
  <Button onClick={() => save({ asQuoted: false })}>Запази</Button>
  <Button
    variant="outline"
    onClick={() => save({ asQuoted: true })}
    className="border-amber-500 text-amber-700 hover:bg-amber-50"
  >
    Запази като оферта
  </Button>
</div>
```

**Step 2: `save` handler**

```ts
const save = async ({ asQuoted }: { asQuoted: boolean }) => {
  const payload = {
    // …existing payload…
    status: asQuoted ? "quoted" : "pending",
  };
  const res = await api.post("/orders", payload);
  if (asQuoted && res.data?.id) {
    window.open(`/api/orders/${res.data.id}/offer-pdf`, "_blank");
  }
  invalidateAllOrderRelated();
  onClose();
};
```

**Step 3: Commit**

```bash
git add warehouse-frontend/src/pages/Orders.tsx
git commit -m "feat(orders-fe): 'Запази като оферта' on new-order create"
```

---

## Task 14: Manual end-to-end verification

Run `./scripts/start-mertm.sh`, then:

1. **New offer at create:**
   - Login admin → Поръчки → Нова поръчка → add 2 items → click "Запази като оферта"
   - Verify: new tab opens with offer PDF; orders list shows the new order in the "Оферта" filter pill
   - Open the order drawer → status badge "Оферта" (amber); buttons: Регенерирай оферта / Премини към обработка / Откажи оферта; Документи row hidden
   - Verify in DB: `SELECT status FROM orders WHERE id = X` → `quoted`; inventory unchanged.

2. **Pending → quoted:**
   - Create a normal pending order → drawer → "Генерирай оферта" → status flips to quoted; PDF opens (or button "Регенерирай оферта" appears)

3. **Quoted → pending:**
   - On a quoted order, click "Премини към обработка" → status flips to pending; full workflow buttons return ("Потвърди поръчка" etc.)

4. **Cancel quoted:**
   - On a quoted order, click "Откажи оферта" → status → cancelled

5. **Stock isolation:**
   - Create a quoted order with low-stock items → check inventory; quantities unchanged → only after `quoted → pending → confirmed → fulfill` should stock deduct.

6. **Fulfill rejection:**
   - Try `POST /orders/:id/fulfill` directly via curl on a quoted order → 400.

7. **Filter pill:**
   - Click "Оферта" pill → only quoted orders visible. Click "Всички" → all back.

If any step fails, fix and re-commit.

---

## Task 15: Update STATUS.md

```markdown
**Batch E — Quotation (Оферта)** (2026-04-29):

- Migration 059 — `'quoted'` added to orders.status CHECK
- POST /orders accepts initial `status: 'quoted'` (no stock deduction)
- POST /orders/:id/quote (pending → quoted) + /unquote (quoted → pending)
- New PDF service `offer-pdf.ts` + endpoint `GET /orders/:id/offer-pdf`
- Frontend `statusLabels.quoted = "Оферта"` (auto filter pill, amber badge)
- Drawer: pending → "Генерирай оферта"; quoted → Регенерирай / Премини / Откажи + days-since hint
- New-order modal: "Запази като оферта" alongside "Запази"
- Documents row hidden for quoted state
```

```bash
git add STATUS.md
git commit -m "docs(status): Batch E complete — quotation workflow"
```

---

## Verification checklist (`superpowers:verification-before-completion`)

- [ ] Migration 059 applied; CHECK includes `quoted`
- [ ] Backend tests pass: `npx vitest run`
- [ ] Backend type-check clean
- [ ] Frontend type-check clean
- [ ] Manual E2E (Task 14) — all 7 steps green
- [ ] STATUS.md updated
- [ ] All commits use conventional format
