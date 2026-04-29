# Batch G+H — Invoice extra fields & Acceptance protocol Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Add two invoice persistence fields (`vat_exemption_reason`, `invoice_note`) and a brand-new "Приемо-предавателен протокол" PDF document with a manual-override dialog before download.

**Architecture:** Migration 058 adds 2 columns to `invoices`. A shared frontend/backend constant `VAT_EXEMPTION_REASONS` powers a datalist suggestion list. Invoice schema accepts both fields on create + regenerate (regenerate uses `COALESCE` to preserve existing values when omitted). New PDF service `protocol-pdf.ts` is built from scratch with pdfkit (mirroring `document-pdf.ts` pattern, NOT the template-overlay `warranty-pdf.ts`). New endpoint `GET /orders/:id/protocol-pdf` accepts query overrides for place/date/reps. Frontend adds a textarea + datalist input to the invoice dialog and a new button + dialog under "ДОКУМЕНТИ".

**Tech Stack:** PostgreSQL 16, Fastify+TypeScript backend, pdfkit (already used), Vitest tests, React+TanStack Query frontend with existing Dialog + Input + ConfirmDialog primitives.

**Spec:** [docs/superpowers/specs/2026-04-29-batch-gh-invoice-fields-and-acceptance-protocol-design.md](../specs/2026-04-29-batch-gh-invoice-fields-and-acceptance-protocol-design.md)

---

## Pre-flight

- Branch: `git checkout main && git pull && git checkout -b feature/MERTM-batch-gh-invoice-fields-protocol`
- Backend tests: `cd warehouse-backend && npx vitest run`
- Type-check: `npx tsc --noEmit` (in `warehouse-backend/` and `warehouse-frontend/`)
- Migration runner: `docker exec -i mertm-postgres-1 psql -U warehouse -d mertm_warehouse -v ON_ERROR_STOP=1 --single-transaction < <migration_file>`

---

## Task 1: Migration 058 — invoice extra columns

**Files:**

- Create: `warehouse-backend/migrations/058_invoice_extra_fields.sql`

**Step 1: Write the migration**

```sql
-- 058_invoice_extra_fields.sql
-- Persistence for two new printable fields on invoices:
--  - vat_exemption_reason: legal basis for issuing without VAT
--    (printed in "Основание за сделката" section)
--  - invoice_note: free-text note ("по проект X") printed below
--    the items table

BEGIN;

ALTER TABLE invoices
  ADD COLUMN IF NOT EXISTS vat_exemption_reason TEXT,
  ADD COLUMN IF NOT EXISTS invoice_note TEXT;

COMMIT;
```

**Step 2: Apply**

```bash
docker exec -i mertm-postgres-1 psql -U warehouse -d mertm_warehouse \
  -v ON_ERROR_STOP=1 --single-transaction \
  < warehouse-backend/migrations/058_invoice_extra_fields.sql

docker exec mertm-postgres-1 psql -U warehouse -d mertm_warehouse -tAc \
  "INSERT INTO _migrations (name) VALUES ('058_invoice_extra_fields.sql') ON CONFLICT DO NOTHING"
```

**Step 3: Verify**

```bash
docker exec mertm-postgres-1 psql -U warehouse -d mertm_warehouse -tAc \
  "SELECT column_name FROM information_schema.columns
   WHERE table_name='invoices' AND column_name IN ('vat_exemption_reason','invoice_note')
   ORDER BY column_name"
```

Expected:

```
invoice_note
vat_exemption_reason
```

**Step 4: Commit**

```bash
git add warehouse-backend/migrations/058_invoice_extra_fields.sql
git commit -m "feat(db): add invoices.vat_exemption_reason + invoice_note (058)"
```

---

## Task 2: Shared VAT exemption reasons constant (backend + frontend)

**Files:**

- Create: `warehouse-backend/src/lib/vat-exemption-reasons.ts`
- Create: `warehouse-frontend/src/lib/vatExemptionReasons.ts`

**Step 1: Backend constant**

```ts
// Default suggestions for the "Основание (без ДДС)" datalist on the
// invoice-generating dialog. Free text is also accepted — these are
// just hints for the most common BG accounting cases.
export const VAT_EXEMPTION_REASONS: ReadonlyArray<string> = [
  "Освободена доставка по чл. 28 ЗДДС",
  "Вътрешнообщностна доставка по чл. 173 ЗДДС",
  "EU reverse charge / обратно начисляване",
  "Освободена доставка по чл. 38 ЗДДС",
  "Освободена доставка по чл. 39 ЗДДС",
] as const;

export const DEFAULT_VAT_EXEMPTION_REASON = VAT_EXEMPTION_REASONS[0];
```

**Step 2: Frontend mirror (identical content)**

```ts
// Mirror of warehouse-backend/src/lib/vat-exemption-reasons.ts.
// Keep in sync.
export const VAT_EXEMPTION_REASONS: ReadonlyArray<string> = [
  "Освободена доставка по чл. 28 ЗДДС",
  "Вътрешнообщностна доставка по чл. 173 ЗДДС",
  "EU reverse charge / обратно начисляване",
  "Освободена доставка по чл. 38 ЗДДС",
  "Освободена доставка по чл. 39 ЗДДС",
] as const;

export const DEFAULT_VAT_EXEMPTION_REASON = VAT_EXEMPTION_REASONS[0];
```

**Step 3: Commit**

```bash
git add warehouse-backend/src/lib/vat-exemption-reasons.ts warehouse-frontend/src/lib/vatExemptionReasons.ts
git commit -m "feat(invoices): shared VAT_EXEMPTION_REASONS suggestion list"
```

---

## Task 3: Backend — accept new fields in createInvoiceSchema + regenerateInvoiceSchema

**Files:**

- Modify: `warehouse-backend/src/routes/invoices.ts:57-72` (createInvoiceSchema); `:73-78` (regenerateInvoiceSchema)

**Step 1: Extend createInvoiceSchema**

After the existing `payment_method` and `client_display_name` fields:

```ts
vat_exemption_reason: z
  .string()
  .trim()
  .max(500)
  .optional()
  .transform((v) => (v && v.length > 0 ? v : null)),
invoice_note: z
  .string()
  .trim()
  .max(2000)
  .optional()
  .transform((v) => (v && v.length > 0 ? v : null)),
```

**Step 2: Extend regenerateInvoiceSchema**

```ts
const regenerateInvoiceSchema = z.object({
  payment_method: invoicePaymentMethodSchema.optional(),
  vat_exemption_reason: z.string().trim().max(500).optional(),
  invoice_note: z.string().trim().max(2000).optional(),
});
```

(For regenerate, `nullish` is unnecessary — absent means "preserve".)

**Step 3: Type-check**

Run: `cd warehouse-backend && npx tsc --noEmit`
Expected: PASS.

**Step 4: Commit**

```bash
git add warehouse-backend/src/routes/invoices.ts
git commit -m "feat(invoices): schema accepts vat_exemption_reason + invoice_note"
```

---

## Task 4: Backend — write fields on POST /invoices

**Files:**

- Modify: `warehouse-backend/src/routes/invoices.ts:343-460` (POST /invoices handler — INSERT)

**Step 1: Locate the existing INSERT INTO invoices block (around `:400-415` from earlier inspection)**

Add the two new columns:

```ts
const {
  rows: [invoice],
} = await client.query(
  `INSERT INTO invoices
     (invoice_number, invoice_date, partner_id,
      total_net, total_vat, total_gross, include_vat,
      client_display_name, payment_method,
      vat_exemption_reason, invoice_note)
   VALUES ($1, CURRENT_DATE, $2, $3, $4, $5, $6, $7, $8, $9, $10)
   RETURNING *`,
  [
    invoiceNumber,
    order.partner_id,
    totalNet,
    totalVat,
    totalGross,
    body.include_vat,
    clientDisplayName,
    body.payment_method,
    body.vat_exemption_reason ?? null,
    body.invoice_note ?? null,
  ],
);
```

**Step 2: Pass to PDF generator**

`generateInvoicePdf({ invoice: ... })` already reads `invoice.vat_exemption_reason` and any free-text note via the existing interface. The `invoice` row from `RETURNING *` includes the new columns automatically — no template change needed for the basis line.

For `invoice_note`, the PDF renderer needs a small additional line. See Task 6.

**Step 3: Commit**

```bash
git add warehouse-backend/src/routes/invoices.ts
git commit -m "feat(invoices): persist vat_exemption_reason + invoice_note on POST /invoices"
```

---

## Task 5: Backend — preserve fields on regenerate

**Files:**

- Modify: `warehouse-backend/src/routes/invoices.ts:540-562` (regenerate handler — UPDATE block)

**Step 1: Extend the existing UPDATE — same COALESCE pattern as payment_method**

```ts
const {
  rows: [updated],
} = await client.query(
  `UPDATE invoices
     SET total_net = $1,
         total_vat = $2,
         total_gross = $3,
         payment_method = COALESCE($4, payment_method),
         vat_exemption_reason = COALESCE($5, vat_exemption_reason),
         invoice_note = COALESCE($6, invoice_note)
   WHERE id = $7 RETURNING *`,
  [
    totalNet,
    totalVat,
    totalGross,
    body.payment_method ?? null,
    body.vat_exemption_reason ?? null,
    body.invoice_note ?? null,
    id,
  ],
);
```

**Step 2: Commit**

```bash
git add warehouse-backend/src/routes/invoices.ts
git commit -m "feat(invoices): regenerate preserves vat_exemption_reason + invoice_note"
```

---

## Task 6: PDF — render `invoice_note` below items

**Files:**

- Modify: `warehouse-backend/src/services/invoice-pdf.ts` — add `invoice_note?: string | null` to the `InvoiceData.invoice` interface; render it just below the totals block

**Step 1: Extend the interface (around `:62-83`)**

```ts
/** Свободен текст към фактура (например "по проект X") */
invoice_note?: string | null;
```

**Step 2: Render below the "Сума за получаване" block**

Find the totals/payment-method rendering area (around `:1040-1060` from earlier reconnaissance). After the "Сума за получаване" line, insert:

```ts
if (data.invoice.invoice_note && data.invoice.invoice_note.trim()) {
  doc.fontSize(7.5).font("Main");
  doc.text("Забележка: ", L, y, { width: 80, continued: true });
  doc.font("MainBold").text(data.invoice.invoice_note.trim(), {
    width: pageW - 80,
  });
  y += 14;
}
```

**Step 3: Manual smoke — generate an invoice with a note, open the PDF**

Run dev server, login as admin, generate an invoice with `invoice_note: "Тест забележка"`, open PDF. The note should appear under "Сума за получаване".

**Step 4: Commit**

```bash
git add warehouse-backend/src/services/invoice-pdf.ts
git commit -m "feat(invoice-pdf): render invoice_note as 'Забележка' below totals"
```

---

## Task 7: Backend integration tests for invoice fields

**Files:**

- Create: `warehouse-backend/src/__tests__/invoices-extra-fields.test.ts`

**Step 1: Write tests**

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
vi.mock("../services/invoice-pdf.js", () => ({
  generateInvoicePdf: vi.fn(async () => undefined),
}));

import { transaction } from "../db.js";
import invoicesRoutes from "../routes/invoices.js";

const mockTx = vi.mocked(transaction);

async function buildApp(role = "admin") {
  const app = Fastify();
  app.addHook("onRequest", async (req) => {
    (req as any).user = { id: "u1", role };
    (req as any).jwtVerify = async () => (req as any).user;
  });
  await app.register(invoicesRoutes, { prefix: "/invoices" });
  return app;
}

describe("invoices extra fields", () => {
  beforeEach(() => mockTx.mockReset());

  it("POST /invoices persists vat_exemption_reason + invoice_note", async () => {
    const inserted = vi.fn();
    mockTx.mockImplementationOnce(async (cb: any) =>
      cb({
        query: async (sql: string, params: any[]) => {
          if (/INSERT INTO invoices/.test(sql)) {
            inserted(sql, params);
            return { rows: [{ id: 1, invoice_number: "0000000001" }] };
          }
          // …other mocks for order, items, partner, etc…
          return { rows: [] };
        },
      }),
    );

    const app = await buildApp();
    const res = await app.inject({
      method: "POST",
      url: "/invoices",
      payload: {
        order_id: 1,
        include_vat: false,
        vat_exemption_reason: "EU reverse charge / обратно начисляване",
        invoice_note: "по проект Алфа",
      },
    });

    // …assert inserted was called with the two values…
    await app.close();
  });

  it("PUT /invoices/:id/regenerate without fields preserves existing values", async () => {
    // Verify SQL UPDATE uses COALESCE, not raw $X
    // …
  });
});
```

(Fill in mocks following the pattern in `orders-incoming-permissions.test.ts`.)

**Step 2: Run + iterate**

```bash
cd warehouse-backend && npx vitest run src/__tests__/invoices-extra-fields.test.ts
```

**Step 3: Commit**

```bash
git add warehouse-backend/src/__tests__/invoices-extra-fields.test.ts
git commit -m "test(invoices): integration tests for vat_exemption_reason + invoice_note"
```

---

## Task 8: Backend — Acceptance protocol PDF service

**Files:**

- Create: `warehouse-backend/src/services/protocol-pdf.ts`

**Step 1: Write the service (modeled on `document-pdf.ts`, NOT `warranty-pdf.ts`)**

```ts
import PDFDocument from "pdfkit";
import fs from "node:fs";
import path from "node:path";
import { formatEurAmount } from "../utils/currency.js";

function getFontPath(filename: string): string {
  const candidates = [
    path.resolve(__dirname, "..", "fonts", filename),
    path.resolve(__dirname, "..", "..", "src", "fonts", filename),
    path.resolve(process.cwd(), "src", "fonts", filename),
    path.resolve(process.cwd(), "dist", "fonts", filename),
  ];
  for (const c of candidates) {
    if (fs.existsSync(c)) return c;
  }
  throw new Error(`Font not found: ${filename}`);
}

const FONT_REGULAR = getFontPath("Roboto-Regular.ttf");
const FONT_BOLD = getFontPath("Roboto-Bold.ttf");

export interface ProtocolItem {
  name_bg: string;
  quantity: number | string;
  unit: string;
  unit_price: number | string;
  total_price: number | string;
}

export interface ProtocolData {
  protocolNumber: string; // e.g. "PR-0000037"
  orderNumber: string | number;
  invoiceNumber?: string | null;
  stockDispatchNumber?: string | null;
  date: string; // ISO yyyy-mm-dd
  place: string;
  seller: { name: string; eik: string; rep: string };
  buyer: { name: string; eik?: string; rep: string };
  items: ProtocolItem[];
  totalAmount: number;
  outputPath: string;
}

function formatDate(iso: string): string {
  const [y, m, d] = iso.split("-");
  return `${d}.${m}.${y}`;
}

export async function generateProtocolPdf(data: ProtocolData): Promise<void> {
  return new Promise((resolve, reject) => {
    const doc = new PDFDocument({ size: "A4", margin: 50 });
    doc.registerFont("Main", FONT_REGULAR);
    doc.registerFont("MainBold", FONT_BOLD);

    const out = fs.createWriteStream(data.outputPath);
    doc.pipe(out);
    out.on("finish", () => resolve());
    out.on("error", reject);

    const L = 50;
    const pageW = doc.page.width - 100;
    let y = 60;

    // Title
    doc.font("MainBold").fontSize(16);
    doc.text("ПРИЕМО-ПРЕДАВАТЕЛЕН ПРОТОКОЛ", L, y, {
      width: pageW,
      align: "center",
    });
    y += 22;
    doc.font("MainBold").fontSize(11);
    doc.text(`№ ${data.protocolNumber}`, L, y, {
      width: pageW,
      align: "center",
    });
    y += 26;

    // Place + date
    doc.font("Main").fontSize(10);
    doc.text(`Място: ${data.place}`, L, y, { width: pageW / 2 });
    doc.text(`Дата: ${formatDate(data.date)}`, L + pageW / 2, y, {
      width: pageW / 2,
      align: "right",
    });
    y += 22;

    // Reference
    const refs: string[] = [`поръчка № ${data.orderNumber}`];
    if (data.invoiceNumber) refs.push(`фактура № ${data.invoiceNumber}`);
    if (data.stockDispatchNumber)
      refs.push(`стокова разписка № ${data.stockDispatchNumber}`);
    doc.text(
      `С настоящия протокол страните установяват, че Предалият предаде, а Приелият прие следните стоки/услуги съгласно ${refs.join(", ")}:`,
      L,
      y,
      { width: pageW, align: "justify" },
    );
    y += 40;

    // Items table
    const colsX = [L, L + 250, L + 310, L + 380, L + 460];
    doc.font("MainBold").fontSize(9);
    doc.text("Артикул", colsX[0], y);
    doc.text("К-во", colsX[1], y, { width: 50, align: "right" });
    doc.text("Ед.", colsX[2], y, { width: 50, align: "left" });
    doc.text("Ед.цена", colsX[3], y, { width: 70, align: "right" });
    doc.text("Сума", colsX[4], y, { width: 70, align: "right" });
    y += 14;
    doc
      .moveTo(L, y)
      .lineTo(L + pageW, y)
      .stroke();
    y += 4;
    doc.font("Main").fontSize(9);
    for (const item of data.items) {
      doc.text(item.name_bg, colsX[0], y, { width: 240 });
      doc.text(String(item.quantity), colsX[1], y, {
        width: 50,
        align: "right",
      });
      doc.text(item.unit, colsX[2], y, { width: 50, align: "left" });
      doc.text(formatEurAmount(item.unit_price), colsX[3], y, {
        width: 70,
        align: "right",
      });
      doc.text(formatEurAmount(item.total_price), colsX[4], y, {
        width: 70,
        align: "right",
      });
      y += 14;
    }
    doc
      .moveTo(L, y)
      .lineTo(L + pageW, y)
      .stroke();
    y += 8;

    // Total
    doc.font("MainBold").fontSize(10);
    doc.text(`Общо: ${formatEurAmount(data.totalAmount)}`, L, y, {
      width: pageW,
      align: "right",
    });
    y += 26;

    // Statement
    doc.font("Main").fontSize(10);
    doc.text("Стоките/услугите са приети без забележки.", L, y, {
      width: pageW,
    });
    y += 36;

    // Parties
    doc.font("MainBold").fontSize(10);
    doc.text("ПРЕДАЛ:", L, y);
    doc.text("ПРИЕЛ:", L + pageW / 2, y);
    y += 14;

    doc.font("Main").fontSize(9);
    doc.text(`${data.seller.name}`, L, y, { width: pageW / 2 - 10 });
    doc.text(`${data.buyer.name}`, L + pageW / 2, y, { width: pageW / 2 });
    y += 12;

    doc.text(`ЕИК: ${data.seller.eik}`, L, y);
    if (data.buyer.eik) doc.text(`ЕИК: ${data.buyer.eik}`, L + pageW / 2, y);
    y += 12;

    doc.text(`Представител: ${data.seller.rep}`, L, y, {
      width: pageW / 2 - 10,
    });
    doc.text(`Представител: ${data.buyer.rep}`, L + pageW / 2, y, {
      width: pageW / 2,
    });
    y += 50;

    // Signature lines
    doc.font("Main").fontSize(9);
    doc.text("_______________________", L, y);
    doc.text("_______________________", L + pageW / 2, y);
    y += 12;
    doc.text("(подпис)", L, y);
    doc.text("(подпис)", L + pageW / 2, y);

    doc.end();
  });
}
```

**Step 2: Commit**

```bash
git add warehouse-backend/src/services/protocol-pdf.ts
git commit -m "feat(protocol): add generateProtocolPdf service (handover document)"
```

---

## Task 9: Backend — `GET /orders/:id/protocol-pdf` endpoint

**Files:**

- Modify: `warehouse-backend/src/routes/orders.ts:2429-2470` (after warranty endpoint, add protocol endpoint)

**Step 1: Add the import**

```ts
import { generateProtocolPdf } from "../services/protocol-pdf.js";
```

**Step 2: Add the endpoint after warranty-pdf**

```ts
// GET /:id/protocol-pdf — Приемо-предавателен протокол
app.get<{
  Params: { id: string };
  Querystring: {
    place?: string;
    date?: string;
    seller_rep?: string;
    buyer_rep?: string;
  };
}>(
  "/:id/protocol-pdf",
  { preHandler: ordersManagePreHandler },
  async (request, reply) => {
    const id = Number(request.params.id);
    const data = await loadOrderWithBatches(id);
    if (!data) return reply.status(404).send({ error: "Order not found" });

    const { order, items } = data;

    const company = await getCompanySettings();
    const partner = await query(
      "SELECT name, eik, contact_person FROM partners WHERE id = $1",
      [order.partner_id],
    ).then((r) => r.rows[0] ?? {});

    const today = new Date().toISOString().split("T")[0];
    const protocolNumber = `PR-${String(order.order_number || order.id).padStart(7, "0")}`;
    const stockDispatchNumber = `SR-${String(order.order_number || order.id).padStart(7, "0")}`;
    const invoiceNumber = order.invoice_id
      ? (
          await query("SELECT invoice_number FROM invoices WHERE id = $1", [
            order.invoice_id,
          ])
        ).rows[0]?.invoice_number
      : null;

    const totalAmount = items.reduce(
      (sum, it: any) => sum + parseFloat(it.total_price),
      0,
    );

    const pdfDir = path.resolve(process.cwd(), "data", "documents");
    if (!fs.existsSync(pdfDir)) fs.mkdirSync(pdfDir, { recursive: true });
    const outputPath = path.join(pdfDir, `protocol-${id}.pdf`);

    await generateProtocolPdf({
      protocolNumber,
      orderNumber: order.order_number ?? order.id,
      invoiceNumber,
      stockDispatchNumber,
      date: request.query.date || today,
      place: request.query.place || company.city || "София",
      seller: {
        name: company.company_name,
        eik: company.eik,
        rep: request.query.seller_rep || company.mol || "",
      },
      buyer: {
        name: partner.name || "",
        eik: partner.eik,
        rep: request.query.buyer_rep || partner.contact_person || "",
      },
      items: items.map((it: any) => ({
        name_bg: it.name_bg,
        quantity: it.quantity,
        unit: it.unit || "бр.",
        unit_price: it.unit_price,
        total_price: it.total_price,
      })),
      totalAmount,
      outputPath,
    });

    return reply.type("application/pdf").send(fs.createReadStream(outputPath));
  },
);
```

**Step 3: Type-check**

Run: `npx tsc --noEmit`. Expected: PASS.

**Step 4: Smoke test via curl**

```bash
TOKEN=$(curl -s http://localhost:3004/auth/login -d '{"email":"admin@mertm.bg","password":"…"}' -H "content-type: application/json" | jq -r .token)
curl -s -H "Authorization: Bearer $TOKEN" http://localhost:3004/orders/1/protocol-pdf -o /tmp/protocol.pdf
file /tmp/protocol.pdf
```

Expected: `PDF document, version 1.x`. Open it; verify content.

**Step 5: Commit**

```bash
git add warehouse-backend/src/routes/orders.ts
git commit -m "feat(orders): GET /:id/protocol-pdf — Приемо-предавателен протокол"
```

---

## Task 10: Backend integration test for protocol endpoint

**Files:**

- Create: `warehouse-backend/src/__tests__/orders-protocol-pdf.test.ts`

**Step 1: Smoke test (route exists, returns PDF stream)**

```ts
import Fastify from "fastify";
import { describe, expect, it, vi } from "vitest";

vi.mock("../db.js", () => ({ query: vi.fn(async () => ({ rows: [] })) }));
vi.mock("../lib/redis.js", () => ({
  getRedis: vi.fn(async () => ({
    get: vi.fn(async () => null),
    setex: vi.fn(async () => "OK"),
    del: vi.fn(async () => 0),
  })),
}));
vi.mock("../services/protocol-pdf.js", () => ({
  generateProtocolPdf: vi.fn(async () => undefined),
}));

import ordersRoutes from "../routes/orders.js";

async function buildApp() {
  const app = Fastify();
  app.addHook("onRequest", async (req) => {
    (req as any).user = { id: "u1", role: "admin" };
    (req as any).jwtVerify = async () => (req as any).user;
  });
  await app.register(ordersRoutes, { prefix: "/orders" });
  return app;
}

describe("GET /orders/:id/protocol-pdf", () => {
  it("returns 404 when order does not exist", async () => {
    const app = await buildApp();
    const res = await app.inject({
      method: "GET",
      url: "/orders/9999/protocol-pdf",
    });
    expect(res.statusCode).toBe(404);
    await app.close();
  });

  // …add a positive test once you wire the loadOrderWithBatches mock…
});
```

**Step 2: Commit**

```bash
git add warehouse-backend/src/__tests__/orders-protocol-pdf.test.ts
git commit -m "test(orders): smoke test for protocol-pdf endpoint"
```

---

## Task 11: Frontend — invoice dialog tweaks (textarea + datalist)

**Files:**

- Modify: `warehouse-frontend/src/pages/Orders.tsx` — invoice dialog (the section around the ДДС / Плащане toggles)

**Step 1: Import the constant**

```ts
import { VAT_EXEMPTION_REASONS } from "@/lib/vatExemptionReasons";
```

**Step 2: Add two new state variables next to includeVat / paymentMethod**

```ts
const [invoiceNote, setInvoiceNote] = useState("");
const [vatExemptionReason, setVatExemptionReason] = useState("");
```

**Step 3: Add UI just above the "Генерирай фактура" button**

```tsx
{
  /* Free-text note printed below totals on PDF */
}
<div className="flex items-center gap-2 px-3 py-1.5 bg-gray-50 rounded-lg border w-full">
  <span className="text-xs text-gray-500 shrink-0">Забележка:</span>
  <input
    type="text"
    value={invoiceNote}
    onChange={(e) => setInvoiceNote(e.target.value)}
    placeholder="напр. по проект X (по желание)"
    maxLength={2000}
    className="flex-1 px-2 py-1 text-xs border rounded"
  />
</div>;

{
  /* VAT exemption legal basis — only visible when invoice is non-VAT */
}
{
  !includeVat && (
    <div className="flex items-center gap-2 px-3 py-1.5 bg-amber-50 rounded-lg border border-amber-200 w-full">
      <span className="text-xs text-amber-700 shrink-0">
        Основание (без ДДС):
      </span>
      <input
        type="text"
        list="vat-exemption-suggestions"
        value={vatExemptionReason}
        onChange={(e) => setVatExemptionReason(e.target.value)}
        placeholder="избери или въведи свободно"
        maxLength={500}
        className="flex-1 px-2 py-1 text-xs border rounded"
      />
      <datalist id="vat-exemption-suggestions">
        {VAT_EXEMPTION_REASONS.map((r) => (
          <option key={r} value={r} />
        ))}
      </datalist>
    </div>
  );
}
```

**Step 4: Wire into invoiceMutation**

```ts
api.post("/invoices", {
  order_id: id,
  include_vat: includeVat,
  payment_method: paymentMethod,
  client_display_name: clientDisplayName.trim() || undefined,
  invoice_note: invoiceNote.trim() || undefined,
  vat_exemption_reason: !includeVat
    ? vatExemptionReason.trim() || undefined
    : undefined,
});
```

**Step 5: Reset on order change** — add to the existing useEffect that resets per-order state:

```ts
setInvoiceNote("");
setVatExemptionReason("");
```

**Step 6: Manual smoke test**

Generate an invoice without VAT → confirm both fields appear → enter values → generate → open PDF → verify both render.

**Step 7: Commit**

```bash
git add warehouse-frontend/src/pages/Orders.tsx
git commit -m "feat(orders-fe): invoice dialog accepts vat_exemption_reason + invoice_note"
```

---

## Task 12: Frontend — Acceptance protocol button + dialog

**Files:**

- Modify: `warehouse-frontend/src/pages/Orders.tsx` — Документи row (around `:1583-1620`) + new dialog component

**Step 1: Add a new state**

```ts
const [protocolDialogOpen, setProtocolDialogOpen] = useState(false);
const [protocolPlace, setProtocolPlace] = useState("");
const [protocolDate, setProtocolDate] = useState(
  new Date().toISOString().split("T")[0],
);
const [protocolSellerRep, setProtocolSellerRep] = useState("");
const [protocolBuyerRep, setProtocolBuyerRep] = useState("");
```

**Step 2: New button in Документи row** (between "Гаранция" and end)

```tsx
<Button
  variant="outline"
  onClick={() => {
    // Pre-fill from detail
    setProtocolBuyerRep(detail.partner?.contact_person ?? "");
    setProtocolDialogOpen(true);
  }}
  className="text-purple-600 border-purple-300 hover:bg-purple-50"
>
  <FileSignature className="h-4 w-4" />
  Приемо-предавателен
</Button>
```

(Import `FileSignature` from `lucide-react` at the top.)

**Step 3: New Dialog — placed near the existing dialogs at the end of the component**

```tsx
<Dialog open={protocolDialogOpen} onOpenChange={setProtocolDialogOpen}>
  <DialogContent className="max-w-md">
    <DialogHeader>
      <DialogTitle>Приемо-предавателен протокол</DialogTitle>
    </DialogHeader>
    <div className="space-y-3 py-2">
      <div>
        <Label>Място</Label>
        <Input
          value={protocolPlace}
          onChange={(e) => setProtocolPlace(e.target.value)}
          placeholder="напр. София"
        />
      </div>
      <div>
        <Label>Дата</Label>
        <Input
          type="date"
          value={protocolDate}
          onChange={(e) => setProtocolDate(e.target.value)}
        />
      </div>
      <div>
        <Label>Продавач — представител</Label>
        <Input
          value={protocolSellerRep}
          onChange={(e) => setProtocolSellerRep(e.target.value)}
        />
      </div>
      <div>
        <Label>Купувач — представител</Label>
        <Input
          value={protocolBuyerRep}
          onChange={(e) => setProtocolBuyerRep(e.target.value)}
        />
      </div>
    </div>
    <DialogFooter>
      <Button variant="outline" onClick={() => setProtocolDialogOpen(false)}>
        Отказ
      </Button>
      <Button
        onClick={() => {
          const params = new URLSearchParams();
          if (protocolPlace) params.set("place", protocolPlace);
          if (protocolDate) params.set("date", protocolDate);
          if (protocolSellerRep) params.set("seller_rep", protocolSellerRep);
          if (protocolBuyerRep) params.set("buyer_rep", protocolBuyerRep);
          window.open(
            `/api/orders/${detail.id}/protocol-pdf?${params.toString()}`,
            "_blank",
          );
          setProtocolDialogOpen(false);
        }}
      >
        Свали PDF
      </Button>
    </DialogFooter>
  </DialogContent>
</Dialog>
```

**Step 4: Manual smoke**

Open any order → drawer → Документи row → "Приемо-предавателен" → dialog opens with pre-fills → adjust if needed → "Свали PDF" → opens new tab with the PDF.

**Step 5: Commit**

```bash
git add warehouse-frontend/src/pages/Orders.tsx
git commit -m "feat(orders-fe): Приемо-предавателен dialog + button in Документи row"
```

---

## Task 13: Manual end-to-end verification

Run `./scripts/start-mertm.sh`, then:

1. **VAT exemption flow:**
   - Login → Поръчки → потвърдена поръчка → click "Без ДДС" → invoice dialog → "Основание (без ДДС)" input shows with datalist
   - Click input → see 5 suggestions; pick "EU reverse charge"
   - Add "Забележка" = "по проект Алфа"
   - Generate invoice → open PDF → verify:
     - "Основание за сделката: EU reverse charge / обратно начисляване" line
     - "Забележка: по проект Алфа" appears below totals

2. **Regenerate preserves:**
   - Click Регенерирай → PDF re-renders → both texts still there

3. **Override on regenerate:**
   - Re-open the regenerate flow (если има UI) → change vat_exemption_reason → regenerate → new value appears

4. **Acceptance protocol:**
   - Open the same order → drawer → Документи → "Приемо-предавателен"
   - Dialog opens with pre-fills (place = "София", date = today, buyer_rep = partner.contact_person)
   - Override seller_rep = "Иван Иванов"
   - Click "Свали PDF" → new tab opens with the PDF
   - Verify content: title, protocol number, place + date, items table, totals, signature lines

---

## Task 14: Update STATUS.md

```markdown
**Batch G+H — Invoice extra fields + Acceptance protocol** (2026-04-29):

- Migration 058 — `invoices.vat_exemption_reason` + `invoice_note`
- Shared `VAT_EXEMPTION_REASONS` suggestion list (5 BG legal bases)
- Invoice schema accepts both fields on POST + regenerate (regenerate preserves with COALESCE)
- PDF renderer prints "Забележка" line below totals
- New service `protocol-pdf.ts` + endpoint `GET /orders/:id/protocol-pdf`
- Frontend invoice dialog: textarea (note) + datalist (exemption reason, conditional on no-VAT)
- Frontend Документи row: new "Приемо-предавателен" button + override dialog
```

```bash
git add STATUS.md
git commit -m "docs(status): Batch G+H complete — invoice fields + acceptance protocol"
```

---

## Verification checklist (`superpowers:verification-before-completion`)

- [ ] Migration 058 applied; both columns visible
- [ ] Backend tests pass: `npx vitest run`
- [ ] Backend type-check clean
- [ ] Frontend type-check clean
- [ ] Manual E2E (Task 13) — all 4 sections green
- [ ] STATUS.md updated
- [ ] All commits use conventional format
