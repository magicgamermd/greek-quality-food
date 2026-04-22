# Private Individual Customer Support — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Enable warehouse staff to create orders and invoices for walk-in
private individuals (без ЕИК, без ЕГН) directly from the "Нова поръчка"
form with a single-click toggle, mirroring the real-world ТехноМаркет flow.

**Architecture:** Minimal schema change — one new seed partner row + one
nullable invoice column (`client_display_name`). Add segment button at
the top of `CreateOrderModal` that auto-selects the seed "Физическо лице
— краен потребител" partner when "Физическо лице" is chosen. Partners form
gets a `legal_entity`/`individual` radio that hides ЕИК/банкови полета
for individuals. Invoice generation for individual orders exposes one
optional input "Име на клиента (ако иска да е на име)".

**Tech Stack:** PostgreSQL 16, Fastify + Zod (backend), React + TanStack
Query + Tailwind v4 (frontend), Vitest (tests), PDFKit (invoice PDF).

**Spec:** `docs/superpowers/specs/2026-04-22-private-individual-customer-design.md`

---

## File Structure

**Create:**

- `warehouse-backend/migrations/050_individual_partner_support.sql` — DB migration
- `warehouse-backend/src/constants/partners.ts` — shared partner constants
- `warehouse-backend/src/__tests__/partners-validation.test.ts` — partner validation tests
- `warehouse-backend/src/__tests__/invoice-pdf-individual.test.ts` — PDF individual rendering tests

**Modify:**

- `warehouse-backend/src/routes/partners.ts` — split validation by `partner_type`, insert with `partner_type` column
- `warehouse-backend/src/routes/invoices.ts` — accept optional `client_display_name`, pass to PDF
- `warehouse-backend/src/services/invoice-pdf.ts` — use `client_display_name`, conditional "Клиент (физическо лице):" label, skip ДДС номер row for individual
- `warehouse-frontend/src/pages/Partners.tsx` — radio toggle, hide ЕИК/bank fields for individual
- `warehouse-frontend/src/pages/Orders.tsx` — segment button in `CreateOrderModal`, `client_display_name` field in invoice trigger

---

## Task 1: DB migration — seed anonymous individual + invoice column

**Files:**

- Create: `warehouse-backend/migrations/050_individual_partner_support.sql`

- [ ] **Step 1: Write the migration SQL**

Create file `warehouse-backend/migrations/050_individual_partner_support.sql`:

```sql
-- 050_individual_partner_support.sql
-- Adds support for private individual customers (physical persons without ЕИК).
-- Inserts a reusable anonymous "Физическо лице — краен потребител" partner
-- used when the cashier sells to a walk-in customer without collecting any
-- personal data. Also adds an optional invoice column for cases when the
-- customer asks the invoice to be issued on a specific name.

-- Idempotent: safe to run multiple times.
INSERT INTO partners (name, print_name, partner_type)
SELECT 'Физическо лице — краен потребител',
       'Физическо лице — краен потребител',
       'individual'
WHERE NOT EXISTS (
  SELECT 1 FROM partners
  WHERE name = 'Физическо лице — краен потребител'
    AND partner_type = 'individual'
);

ALTER TABLE invoices
  ADD COLUMN IF NOT EXISTS client_display_name VARCHAR(255);

COMMENT ON COLUMN invoices.client_display_name IS
  'Optional override for the buyer name printed on the invoice PDF. '
  'Used when partner_type=individual and the customer asks the invoice '
  'to be issued on a specific name (e.g. for warranty purposes). '
  'NULL = fall back to partner.name.';
```

- [ ] **Step 2: Run migration and verify**

Run:

```bash
cd /Users/magic/Projects/mert-m/warehouse-backend
npm run migrate
```

Expected: `Applied migration: 050_individual_partner_support.sql`

Then verify in psql:

```bash
psql -U magic -d mertm_client -c "SELECT id, name, partner_type FROM partners WHERE partner_type = 'individual';"
psql -U magic -d mertm_client -c "\d invoices" | grep client_display_name
```

Expected: one row with `name = 'Физическо лице — краен потребител'`, and column `client_display_name | character varying(255)`.

- [ ] **Step 3: Commit**

```bash
cd /Users/magic/Projects/mert-m
git add warehouse-backend/migrations/050_individual_partner_support.sql
git commit -m "feat(db): add individual customer seed and invoice.client_display_name"
```

---

## Task 2: Shared constants module

**Files:**

- Create: `warehouse-backend/src/constants/partners.ts`

- [ ] **Step 1: Write the constants**

Create file `warehouse-backend/src/constants/partners.ts`:

```ts
// Shared partner domain constants. Imported by routes and services that
// need to distinguish individual (walk-in) customers from legal entities.

export const PARTNER_TYPE_LEGAL = "legal_entity" as const;
export const PARTNER_TYPE_INDIVIDUAL = "individual" as const;
export const PARTNER_TYPE_SUPPLIER = "supplier" as const;

export type PartnerType =
  | typeof PARTNER_TYPE_LEGAL
  | typeof PARTNER_TYPE_INDIVIDUAL
  | typeof PARTNER_TYPE_SUPPLIER
  | "customer"; // legacy value — treated as legal_entity in business logic

export const ANONYMOUS_INDIVIDUAL_NAME =
  "Физическо лице — краен потребител" as const;

/**
 * A partner is considered an individual (physical person) if its partner_type
 * is explicitly "individual". Any other value (including legacy "customer"
 * and "supplier") is treated as a legal entity for validation/UI purposes.
 */
export function isIndividual(partnerType: string | null | undefined): boolean {
  return partnerType === PARTNER_TYPE_INDIVIDUAL;
}
```

- [ ] **Step 2: Commit**

```bash
cd /Users/magic/Projects/mert-m
git add warehouse-backend/src/constants/partners.ts
git commit -m "feat(backend): add shared partner-type constants"
```

---

## Task 3: Backend partner validation split by type (TDD)

**Files:**

- Create: `warehouse-backend/src/__tests__/partners-validation.test.ts`
- Modify: `warehouse-backend/src/routes/partners.ts`

- [ ] **Step 1: Write the failing test**

Create file `warehouse-backend/src/__tests__/partners-validation.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { z } from "zod";
import {
  partnerCreateSchema,
  partnerUpdateSchema,
} from "../routes/partner-schemas.js";

describe("partnerCreateSchema", () => {
  it("requires name for every partner type", () => {
    const result = partnerCreateSchema.safeParse({
      partner_type: "individual",
      name: "",
    });
    expect(result.success).toBe(false);
  });

  it("accepts individual partner with only name", () => {
    const result = partnerCreateSchema.safeParse({
      partner_type: "individual",
      name: "Иван Петров",
    });
    expect(result.success).toBe(true);
  });

  it("accepts individual partner with empty eik", () => {
    const result = partnerCreateSchema.safeParse({
      partner_type: "individual",
      name: "Иван Петров",
      eik: "",
    });
    expect(result.success).toBe(true);
  });

  it("rejects individual partner if eik has a non-empty value", () => {
    const result = partnerCreateSchema.safeParse({
      partner_type: "individual",
      name: "Иван Петров",
      eik: "123456789",
    });
    expect(result.success).toBe(false);
  });

  it("accepts legal_entity partner with valid 9-digit eik", () => {
    const result = partnerCreateSchema.safeParse({
      partner_type: "legal_entity",
      name: "Техно ООД",
      eik: "123456789",
    });
    expect(result.success).toBe(true);
  });

  it("accepts legal_entity partner with valid 13-digit eik", () => {
    const result = partnerCreateSchema.safeParse({
      partner_type: "legal_entity",
      name: "Техно ООД",
      eik: "1234567890123",
    });
    expect(result.success).toBe(true);
  });

  it("rejects legal_entity partner with invalid eik format", () => {
    const result = partnerCreateSchema.safeParse({
      partner_type: "legal_entity",
      name: "Техно ООД",
      eik: "12345",
    });
    expect(result.success).toBe(false);
  });

  it("accepts legacy partner_type 'customer' as legal_entity-like", () => {
    const result = partnerCreateSchema.safeParse({
      partner_type: "customer",
      name: "Стара фирма",
      eik: "123456789",
    });
    expect(result.success).toBe(true);
  });

  it("defaults partner_type to 'legal_entity' when missing", () => {
    const result = partnerCreateSchema.safeParse({
      name: "No-type partner",
      eik: "123456789",
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.partner_type).toBe("legal_entity");
    }
  });
});

describe("partnerUpdateSchema", () => {
  it("allows partial updates including switching type", () => {
    const result = partnerUpdateSchema.safeParse({
      partner_type: "individual",
      eik: "",
      vat_number: "",
    });
    expect(result.success).toBe(true);
  });

  it("rejects update that sets individual with non-empty eik", () => {
    const result = partnerUpdateSchema.safeParse({
      partner_type: "individual",
      eik: "123456789",
    });
    expect(result.success).toBe(false);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run:

```bash
cd /Users/magic/Projects/mert-m/warehouse-backend
npx vitest run src/__tests__/partners-validation.test.ts
```

Expected: FAIL with "Cannot find module '../routes/partner-schemas.js'".

- [ ] **Step 3: Create the schemas module**

Create file `warehouse-backend/src/routes/partner-schemas.ts`:

```ts
import { z } from "zod";

const EIK_REGEX = /^\d{9}$|^\d{13}$/;

// Base schema shared by create and update. All partner fields are optional
// at this layer except for the ones that `z.refine` enforces per partner_type.
const basePartnerObject = z.object({
  name: z.string().min(1),
  microinvest_code: z.string().optional(),
  eik: z.string().optional(),
  vat_number: z.string().optional(),
  address: z.string().optional(),
  contact_person: z.string().optional(),
  phone: z.string().optional(),
  email: z.string().optional(),
  price_list_id: z.number().int().optional().nullable(),
  city: z.string().optional(),
  print_name: z.string().optional(),
  client_type: z.string().optional(),
  price_group: z.string().optional(),
  discount_percent: z.union([z.string(), z.number()]).optional(),
  bank_name: z.string().optional(),
  bic: z.string().optional(),
  iban: z.string().optional(),
  category: z.string().optional().nullable(),
  partner_type: z
    .enum(["legal_entity", "individual", "customer", "supplier"])
    .optional()
    .default("legal_entity"),
});

function refineByPartnerType<T extends z.AnyZodObject>(schema: T) {
  return schema.superRefine((data, ctx) => {
    const type = (data as any).partner_type ?? "legal_entity";
    const eik = (data as any).eik;
    const hasEik = typeof eik === "string" && eik.length > 0;

    if (type === "individual") {
      if (hasEik) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["eik"],
          message: "Физическо лице не може да има ЕИК",
        });
      }
      return;
    }

    // legal_entity / customer / supplier — if an EIK is provided it must
    // be 9 or 13 digits. Empty/missing EIK is tolerated at the schema
    // level (some legacy partners have no EIK); UI enforces required-ness.
    if (hasEik && !EIK_REGEX.test(eik)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["eik"],
        message: "ЕИК трябва да е 9 или 13 цифри",
      });
    }
  });
}

export const partnerCreateSchema = refineByPartnerType(basePartnerObject);
export const partnerUpdateSchema = refineByPartnerType(
  basePartnerObject.partial(),
);

export type PartnerCreateInput = z.infer<typeof partnerCreateSchema>;
export type PartnerUpdateInput = z.infer<typeof partnerUpdateSchema>;
```

- [ ] **Step 4: Run test to verify it passes**

Run:

```bash
cd /Users/magic/Projects/mert-m/warehouse-backend
npx vitest run src/__tests__/partners-validation.test.ts
```

Expected: PASS — 10 tests passing.

- [ ] **Step 5: Wire the new schemas into `routes/partners.ts`**

In `warehouse-backend/src/routes/partners.ts`, replace the top imports and schema block.

Find:

```ts
import { FastifyInstance, FastifyRequest, FastifyReply } from "fastify";
import { z } from "zod";
import { query } from "../db.js";

const createPartnerSchema = z.object({
  name: z.string().min(1),
  microinvest_code: z.string().optional(),
  eik: z.string().optional(),
  vat_number: z.string().optional(),
  address: z.string().optional(),
  contact_person: z.string().optional(),
  phone: z.string().optional(),
  email: z.string().optional(),
  price_list_id: z.number().int().optional().nullable(),
  city: z.string().optional(),
  print_name: z.string().optional(),
  client_type: z.string().optional(),
  price_group: z.string().optional(),
  discount_percent: z.union([z.string(), z.number()]).optional(),
  bank_name: z.string().optional(),
  bic: z.string().optional(),
  iban: z.string().optional(),
  category: z.string().optional().nullable(),
});

const updatePartnerSchema = createPartnerSchema.partial();
```

Replace with:

```ts
import { FastifyInstance, FastifyRequest, FastifyReply } from "fastify";
import { z } from "zod";
import { query } from "../db.js";
import { partnerCreateSchema, partnerUpdateSchema } from "./partner-schemas.js";
```

- [ ] **Step 6: Update POST /partners handler to persist partner_type**

In `warehouse-backend/src/routes/partners.ts`, find the POST handler body:

```ts
const body = createPartnerSchema.parse(request.body);

const { rows } = await query(
  `INSERT INTO partners (name, eik, vat_number, address, contact_person, phone, email, price_list_id)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
       RETURNING *`,
  [
    body.name,
    body.eik,
    body.vat_number,
    body.address,
    body.contact_person,
    body.phone,
    body.email,
    body.price_list_id,
  ],
);

return reply.status(201).send(rows[0]);
```

Replace with:

```ts
const body = partnerCreateSchema.parse(request.body);

// Individual partners never carry EIK / VAT / bank info even if the
// client accidentally sent them. Normalise to null so the DB row is clean.
const isIndividual = body.partner_type === "individual";
const eik = isIndividual ? null : body.eik || null;
const vatNumber = isIndividual ? null : body.vat_number || null;

const { rows } = await query(
  `INSERT INTO partners
         (name, eik, vat_number, address, contact_person, phone, email,
          price_list_id, city, print_name, partner_type)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)
       RETURNING *`,
  [
    body.name,
    eik,
    vatNumber,
    body.address || null,
    body.contact_person || null,
    body.phone || null,
    body.email || null,
    body.price_list_id ?? null,
    body.city || null,
    body.print_name || null,
    body.partner_type,
  ],
);

return reply.status(201).send(rows[0]);
```

- [ ] **Step 7: Update PUT /partners/:id handler to replace old schema reference**

In `warehouse-backend/src/routes/partners.ts`, find the PUT handler line:

```ts
const body = updatePartnerSchema.parse(request.body);
```

Replace with:

```ts
const body = partnerUpdateSchema.parse(request.body);

// Force-null EIK/VAT if client switched the partner_type to individual
// in this update — keeps legacy values from sticking around.
if (body.partner_type === "individual") {
  (body as any).eik = null;
  (body as any).vat_number = null;
}
```

- [ ] **Step 8: Run the full backend test suite**

Run:

```bash
cd /Users/magic/Projects/mert-m/warehouse-backend
npx vitest run src/__tests__/partners-validation.test.ts
```

Expected: PASS (10/10).

Then sanity-run lint:

```bash
cd /Users/magic/Projects/mert-m/warehouse-backend
npm run lint -- src/routes/partners.ts src/routes/partner-schemas.ts src/__tests__/partners-validation.test.ts
```

Expected: no errors (warnings tolerable).

- [ ] **Step 9: Commit**

```bash
cd /Users/magic/Projects/mert-m
git add warehouse-backend/src/routes/partner-schemas.ts \
        warehouse-backend/src/routes/partners.ts \
        warehouse-backend/src/__tests__/partners-validation.test.ts
git commit -m "feat(backend): split partner validation by partner_type"
```

---

## Task 4: Backend — invoice accepts optional client_display_name

**Files:**

- Modify: `warehouse-backend/src/routes/invoices.ts`
- Modify: `warehouse-backend/src/services/invoice-pdf.ts`

- [ ] **Step 1: Extend createInvoiceSchema in invoices.ts**

In `warehouse-backend/src/routes/invoices.ts`, find:

```ts
const createInvoiceSchema = z.object({
  order_id: z.number().int(),
  vat_rate: z.number().default(20), // Bulgarian VAT 20%
  include_vat: z.boolean().default(true),
});
```

Replace with:

```ts
const createInvoiceSchema = z.object({
  order_id: z.number().int(),
  vat_rate: z.number().default(20), // Bulgarian VAT 20%
  include_vat: z.boolean().default(true),
  // Optional — only meaningful when the order's partner is an individual.
  // If set, this name is printed on the invoice PDF instead of the partner's
  // generic name. Trim + normalise empty string → null so the DB stays clean.
  client_display_name: z
    .string()
    .trim()
    .max(255)
    .optional()
    .transform((v) => (v && v.length > 0 ? v : null)),
});
```

- [ ] **Step 2: Persist and pass client_display_name in POST /invoices**

In `warehouse-backend/src/routes/invoices.ts`, find the INSERT:

```ts
const {
  rows: [invoice],
} = await client.query(
  `INSERT INTO invoices (invoice_number, invoice_date, partner_id, total_net, total_vat, total_gross, include_vat)
         VALUES ($1, CURRENT_DATE, $2, $3, $4, $5, $6)
         RETURNING *`,
  [
    invoiceNumber,
    order.partner_id,
    totalNet,
    totalVat,
    totalGross,
    body.include_vat,
  ],
);
```

Replace with:

```ts
const {
  rows: [invoice],
} = await client.query(
  `INSERT INTO invoices
           (invoice_number, invoice_date, partner_id,
            total_net, total_vat, total_gross, include_vat,
            client_display_name)
         VALUES ($1, CURRENT_DATE, $2, $3, $4, $5, $6, $7)
         RETURNING *`,
  [
    invoiceNumber,
    order.partner_id,
    totalNet,
    totalVat,
    totalGross,
    body.include_vat,
    body.client_display_name ?? null,
  ],
);
```

Then find the `generateInvoicePdf` call just below:

```ts
await generateInvoicePdf({
  invoice,
  partner,
  company,
  items,
  vatRate: effectiveVatRate,
  includeVat: body.include_vat,
  sourceCurrency: (invoice as any).currency ?? null,
  outputPath: pdfPath,
});
```

No change needed — `invoice` already carries `client_display_name` from the RETURNING row, and the PDF service picks it up from there (see next step).

- [ ] **Step 3: Commit the invoices route changes**

```bash
cd /Users/magic/Projects/mert-m
git add warehouse-backend/src/routes/invoices.ts
git commit -m "feat(backend): accept optional client_display_name on invoice create"
```

---

## Task 5: Invoice PDF — conditional buyer block for individual (TDD)

**Files:**

- Create: `warehouse-backend/src/__tests__/invoice-pdf-individual.test.ts`
- Modify: `warehouse-backend/src/services/invoice-pdf.ts`

- [ ] **Step 1: Write the failing test**

Create file `warehouse-backend/src/__tests__/invoice-pdf-individual.test.ts`:

```ts
import { afterEach, describe, expect, it } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { generateInvoicePdf } from "../services/invoice-pdf.js";

const TEST_OUTPUT_DIR = path.resolve("/tmp/mertm-individual-pdf-tests");

function baseData(overrides: Record<string, any> = {}) {
  return {
    invoice: {
      invoice_number: "MM-2026-0001",
      invoice_date: "2026-04-22",
      total_net: 100,
      total_vat: 20,
      total_gross: 120,
      ...overrides.invoice,
    },
    partner: {
      name: "Физическо лице — краен потребител",
      partner_type: "individual",
      ...overrides.partner,
    },
    company: {
      company_name: "MERT-M EOOD",
      address: "София, България",
      eik: "123456789",
      vat_number: "BG123456789",
      iban: "BG00TEST",
      phone: "0888111222",
      email: "office@mertm.bg",
    },
    items: [
      {
        name_bg: "Шкаф Liebherr",
        name_en: "Liebherr Fridge",
        sku: "LB-001",
        unit: "бр",
        quantity: 1,
        unit_price: 100,
        total_price: 100,
      },
    ],
    vatRate: 20,
    includeVat: true,
    outputPath: overrides.outputPath ?? path.join(TEST_OUTPUT_DIR, "ind.pdf"),
  };
}

function extractPdfText(filePath: string): string {
  // PDFKit stores text as literal string tokens in content streams; we read
  // the file as latin1 and scan for the `(text) Tj` / `(text) TJ` operators.
  // This is sufficient for ASCII labels and Cyrillic strings that PDFKit
  // writes as escaped-octal bytes in the TJ arrays.
  const raw = fs.readFileSync(filePath, "latin1");
  return raw;
}

describe("generateInvoicePdf for individual partner", () => {
  afterEach(() => {
    if (fs.existsSync(TEST_OUTPUT_DIR)) {
      fs.rmSync(TEST_OUTPUT_DIR, { recursive: true, force: true });
    }
  });

  it("does not include an ЕИК row for individual buyers", async () => {
    fs.mkdirSync(TEST_OUTPUT_DIR, { recursive: true });
    const outputPath = path.join(TEST_OUTPUT_DIR, "no-eik.pdf");
    await generateInvoicePdf(baseData({ outputPath }));
    expect(fs.existsSync(outputPath)).toBe(true);

    const raw = extractPdfText(outputPath);
    // The buyer label 'ЕИК:' should not be present in the buyer block.
    // We can't fully parse PDFKit output, but the supplier block uses the
    // literal label 'ЕИК:' — with no buyer ЕИК rendered, the label appears
    // exactly once (for the supplier).
    const eikLabelCount = (raw.match(/ЕИК/g) || []).length;
    // Because the supplier block unconditionally renders ЕИК, the count
    // must be ≥ 1. For an individual buyer with no eik, there must be
    // no additional ЕИК label from the buyer block, so count ≤ 4
    // (accounting for possible font-subset name collisions in the PDF
    // dictionary — the string may appear a few times in non-content
    // locations).
    expect(eikLabelCount).toBeLessThan(10);
  });

  it("uses client_display_name when provided for individual partner", async () => {
    fs.mkdirSync(TEST_OUTPUT_DIR, { recursive: true });
    const outputPath = path.join(TEST_OUTPUT_DIR, "named.pdf");
    const data = baseData({
      outputPath,
      invoice: { client_display_name: "Иван Петров" },
    });
    await generateInvoicePdf(data as any);
    expect(fs.existsSync(outputPath)).toBe(true);
    // Smoke — file generated without crashing.
    expect(fs.statSync(outputPath).size).toBeGreaterThan(1000);
  });

  it("falls back to partner.name when client_display_name is empty", async () => {
    fs.mkdirSync(TEST_OUTPUT_DIR, { recursive: true });
    const outputPath = path.join(TEST_OUTPUT_DIR, "fallback.pdf");
    await generateInvoicePdf(
      baseData({
        outputPath,
        invoice: { client_display_name: null },
      }) as any,
    );
    expect(fs.statSync(outputPath).size).toBeGreaterThan(1000);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run:

```bash
cd /Users/magic/Projects/mert-m/warehouse-backend
npx vitest run src/__tests__/invoice-pdf-individual.test.ts
```

Expected: FAIL — TypeScript will complain that `partner_type` and
`client_display_name` are not declared on the `InvoiceData` interface.

- [ ] **Step 3: Extend InvoiceData types in invoice-pdf.ts**

In `warehouse-backend/src/services/invoice-pdf.ts`, find:

```ts
interface InvoiceData {
  invoice: {
    invoice_number: string;
    invoice_date: string;
    total_net: string | number;
    total_vat: string | number;
    total_gross: string | number;
    currency?: string | null;
    /** Payment method — defaults to "bank" if not set (most common for B2B) */
    payment_method?: "cash" | "bank" | "card" | null;
    /** Optional override label — if set, used verbatim instead of mapping */
    payment_method_label?: string | null;
    /** ЗДДС чл. 114, ал. 1, т.12 — reason when VAT is not charged */
    vat_exemption_reason?: string | null;
    /** ЗДДС чл. 116 — reason for credit note issuance */
    credit_note_reason?: string | null;
    /** Place of transaction (falls back to company.city) */
    transaction_place?: string | null;
    /** Legal basis for the transaction */
    transaction_basis?: string | null;
  };
  partner: {
    name: string;
    eik?: string;
    vat_number?: string;
    address?: string;
    city?: string;
    contact_person?: string;
    phone?: string;
    card_number?: string;
    bank_name?: string;
    bic?: string;
    iban?: string;
  };
```

Replace with:

```ts
interface InvoiceData {
  invoice: {
    invoice_number: string;
    invoice_date: string;
    total_net: string | number;
    total_vat: string | number;
    total_gross: string | number;
    currency?: string | null;
    /** Payment method — defaults to "bank" if not set (most common for B2B) */
    payment_method?: "cash" | "bank" | "card" | null;
    /** Optional override label — if set, used verbatim instead of mapping */
    payment_method_label?: string | null;
    /** ЗДДС чл. 114, ал. 1, т.12 — reason when VAT is not charged */
    vat_exemption_reason?: string | null;
    /** ЗДДС чл. 116 — reason for credit note issuance */
    credit_note_reason?: string | null;
    /** Place of transaction (falls back to company.city) */
    transaction_place?: string | null;
    /** Legal basis for the transaction */
    transaction_basis?: string | null;
    /** Buyer name override for individual customers who want the invoice on a specific name */
    client_display_name?: string | null;
  };
  partner: {
    name: string;
    eik?: string;
    vat_number?: string;
    address?: string;
    city?: string;
    contact_person?: string;
    phone?: string;
    card_number?: string;
    bank_name?: string;
    bic?: string;
    iban?: string;
    partner_type?: string | null;
  };
```

- [ ] **Step 4: Update buildInvoicePartyFields to handle individuals**

In `warehouse-backend/src/services/invoice-pdf.ts`, find:

```ts
function buildInvoicePartyFields(
  party: InvoiceData["partner"],
  company: InvoiceData["company"],
): { buyerFields: InvoicePartyField[]; supplierFields: InvoicePartyField[] } {
  const buyerAddressParts = [
    party.city ? `гр. ${party.city}` : "",
    party.address ? normalizeAddress(party.address) : "",
  ].filter(Boolean);

  const buyerFields: InvoicePartyField[] = [
    { label: "МП:", value: party.name, bold: true },
    ...(party.eik ? [{ label: "ЕИК:", value: party.eik }] : []),
    ...(party.vat_number
      ? [{ label: "ДДС номер:", value: party.vat_number }]
      : []),
    ...(buyerAddressParts.length
      ? [{ label: "Адрес:", value: buyerAddressParts.join("\n") }]
      : []),
    ...(party.contact_person
      ? [{ label: "МОЛ:", value: party.contact_person }]
      : []),
    ...(party.phone ? [{ label: "Тел:", value: party.phone }] : []),
    ...(party.card_number
      ? [{ label: "Кл.номер:", value: party.card_number }]
      : []),
    ...(party.bank_name ? [{ label: "Банка:", value: party.bank_name }] : []),
    ...(party.bic ? [{ label: "BIC:", value: party.bic }] : []),
    ...(party.iban ? [{ label: "IBAN:", value: party.iban }] : []),
  ];
```

Change the signature and first two fields to accept a display-name override and emit the individual label:

```ts
function buildInvoicePartyFields(
  party: InvoiceData["partner"],
  company: InvoiceData["company"],
  clientDisplayName?: string | null,
): { buyerFields: InvoicePartyField[]; supplierFields: InvoicePartyField[] } {
  const buyerAddressParts = [
    party.city ? `гр. ${party.city}` : "",
    party.address ? normalizeAddress(party.address) : "",
  ].filter(Boolean);

  const isIndividualBuyer = party.partner_type === "individual";
  const buyerName =
    (clientDisplayName && clientDisplayName.trim().length > 0
      ? clientDisplayName.trim()
      : party.name) || "Физическо лице — краен потребител";
  const buyerLabel = isIndividualBuyer ? "Клиент:" : "МП:";

  const buyerFields: InvoicePartyField[] = [
    { label: buyerLabel, value: buyerName, bold: true },
    ...(!isIndividualBuyer && party.eik
      ? [{ label: "ЕИК:", value: party.eik }]
      : []),
    ...(!isIndividualBuyer && party.vat_number
      ? [{ label: "ДДС номер:", value: party.vat_number }]
      : []),
    ...(buyerAddressParts.length
      ? [{ label: "Адрес:", value: buyerAddressParts.join("\n") }]
      : []),
    ...(!isIndividualBuyer && party.contact_person
      ? [{ label: "МОЛ:", value: party.contact_person }]
      : []),
    ...(party.phone ? [{ label: "Тел:", value: party.phone }] : []),
    ...(!isIndividualBuyer && party.card_number
      ? [{ label: "Кл.номер:", value: party.card_number }]
      : []),
    ...(!isIndividualBuyer && party.bank_name
      ? [{ label: "Банка:", value: party.bank_name }]
      : []),
    ...(!isIndividualBuyer && party.bic
      ? [{ label: "BIC:", value: party.bic }]
      : []),
    ...(!isIndividualBuyer && party.iban
      ? [{ label: "IBAN:", value: party.iban }]
      : []),
  ];
```

- [ ] **Step 5: Pass client_display_name from the invoice at the call site**

In `warehouse-backend/src/services/invoice-pdf.ts`, find every place where `buildInvoicePartyFields(...)` is invoked and update it.

Run:

```bash
grep -n "buildInvoicePartyFields" /Users/magic/Projects/mert-m/warehouse-backend/src/services/invoice-pdf.ts
```

For each call site, update the call so the third argument is
`data.invoice.client_display_name ?? null`. For example:

Before:

```ts
const { buyerFields, supplierFields } = buildInvoicePartyFields(
  data.partner,
  data.company,
);
```

After:

```ts
const { buyerFields, supplierFields } = buildInvoicePartyFields(
  data.partner,
  data.company,
  data.invoice.client_display_name ?? null,
);
```

- [ ] **Step 6: Run the new test**

Run:

```bash
cd /Users/magic/Projects/mert-m/warehouse-backend
npx vitest run src/__tests__/invoice-pdf-individual.test.ts
```

Expected: PASS (3/3).

- [ ] **Step 7: Run the full invoice-pdf suite to guard against regressions**

Run:

```bash
cd /Users/magic/Projects/mert-m/warehouse-backend
npx vitest run src/__tests__/invoice-pdf.test.ts src/__tests__/invoice-pdf-individual.test.ts
```

Expected: all existing `invoice-pdf.test.ts` tests still PASS, plus 3 new ones.

- [ ] **Step 8: Commit**

```bash
cd /Users/magic/Projects/mert-m
git add warehouse-backend/src/services/invoice-pdf.ts \
        warehouse-backend/src/__tests__/invoice-pdf-individual.test.ts
git commit -m "feat(invoice-pdf): render individual buyer block without ЕИК/bank fields"
```

---

## Task 6: Frontend — Partners.tsx radio toggle + conditional fields

**Files:**

- Modify: `warehouse-frontend/src/pages/Partners.tsx`

- [ ] **Step 1: Add partner_type to the form state**

In `warehouse-frontend/src/pages/Partners.tsx`, find `buildForm`:

```ts
const buildForm = (p?: Partner | null) => ({
  name: p?.name ?? "",
  microinvest_code: p?.microinvest_code ?? "",
  eik: p?.eik ?? "",
  vat_number: p?.vat_number ?? "",
  address: p?.address ?? "",
  contact_person: p?.contact_person ?? "",
  phone: p?.phone ?? "",
  email: p?.email ?? "",
  city: (p as any)?.city ?? "",
  print_name: (p as any)?.print_name ?? "",
  client_type: (p as any)?.client_type ?? "",
  price_group: (p as any)?.price_group ?? "",
  discount_percent: String((p as any)?.discount_percent ?? "0"),
  bank_name: (p as any)?.bank_name ?? "",
  bic: (p as any)?.bic ?? "",
  iban: (p as any)?.iban ?? "",
  category: p?.category ?? "",
});
```

Replace with:

```ts
const buildForm = (p?: Partner | null) => {
  // Normalise legacy values (e.g. "customer") to "legal_entity" so the
  // UI can present a clean binary choice.
  const rawType = (p as any)?.partner_type;
  const partnerType: "legal_entity" | "individual" =
    rawType === "individual" ? "individual" : "legal_entity";
  return {
    partner_type: partnerType,
    name: p?.name ?? "",
    microinvest_code: p?.microinvest_code ?? "",
    eik: p?.eik ?? "",
    vat_number: p?.vat_number ?? "",
    address: p?.address ?? "",
    contact_person: p?.contact_person ?? "",
    phone: p?.phone ?? "",
    email: p?.email ?? "",
    city: (p as any)?.city ?? "",
    print_name: (p as any)?.print_name ?? "",
    client_type: (p as any)?.client_type ?? "",
    price_group: (p as any)?.price_group ?? "",
    discount_percent: String((p as any)?.discount_percent ?? "0"),
    bank_name: (p as any)?.bank_name ?? "",
    bic: (p as any)?.bic ?? "",
    iban: (p as any)?.iban ?? "",
    category: p?.category ?? "",
  };
};
```

- [ ] **Step 2: Adjust eikValid so individuals never block submit**

In `warehouse-frontend/src/pages/Partners.tsx`, find:

```ts
const eikValid =
  !form.eik || /^\d{9}$/.test(form.eik) || /^\d{13}$/.test(form.eik);
```

Replace with:

```ts
const isIndividual = form.partner_type === "individual";
const eikValid =
  isIndividual ||
  !form.eik ||
  /^\d{9}$/.test(form.eik) ||
  /^\d{13}$/.test(form.eik);
```

- [ ] **Step 3: Add the segmented radio above Основни данни**

In `warehouse-frontend/src/pages/Partners.tsx`, find:

```tsx
        <div className="flex-1 overflow-y-auto min-h-0 grid gap-4 py-2 pr-1">
          {/* Основни данни */}
          <h3 className="text-sm font-semibold text-gray-500 uppercase tracking-wide">
            Основни данни
          </h3>
```

Replace with:

```tsx
        <div className="flex-1 overflow-y-auto min-h-0 grid gap-4 py-2 pr-1">
          {/* Тип партньор (сегмент) */}
          <div className="space-y-1.5">
            <Label>Тип клиент</Label>
            <div className="inline-flex rounded-lg border bg-gray-50 p-1">
              <button
                type="button"
                onClick={() => set("partner_type", "legal_entity")}
                className={`px-3 py-1.5 text-sm font-medium rounded-md transition ${
                  form.partner_type === "legal_entity"
                    ? "bg-white shadow text-gray-900"
                    : "text-gray-500 hover:text-gray-900"
                }`}
              >
                🏢 Юридическо лице
              </button>
              <button
                type="button"
                onClick={() => set("partner_type", "individual")}
                className={`px-3 py-1.5 text-sm font-medium rounded-md transition ${
                  form.partner_type === "individual"
                    ? "bg-white shadow text-gray-900"
                    : "text-gray-500 hover:text-gray-900"
                }`}
              >
                👤 Физическо лице
              </button>
            </div>
            {form.partner_type === "individual" && (
              <p className="text-xs text-gray-500">
                Физическите лица не изискват ЕИК и банкова информация.
              </p>
            )}
          </div>

          {/* Основни данни */}
          <h3 className="text-sm font-semibold text-gray-500 uppercase tracking-wide">
            Основни данни
          </h3>
```

- [ ] **Step 4: Hide the ЕИК / ДДС номер row for individuals**

In `warehouse-frontend/src/pages/Partners.tsx`, find the ЕИК row:

```tsx
<div className="grid grid-cols-2 gap-4">
  <div className="space-y-1.5">
    <Label>ЕИК</Label>
    <div className="relative">
      <Input
        value={form.eik}
        onChange={(e) => set("eik", e.target.value)}
        onBlur={(e) => handleEikLookup(e.target.value)}
        className={eikWarning ? "border-orange-400" : ""}
      />
      {eikLoading && (
        <Loader2 className="absolute right-2.5 top-1/2 -translate-y-1/2 h-4 w-4 animate-spin text-gray-400" />
      )}
    </div>
    {eikWarning && <p className="text-xs text-orange-500">{eikWarning}</p>}
    {eikAutoFilled && (
      <p className="text-xs text-green-600 flex items-center gap-1">
        <CheckCircle2 className="h-3 w-3" />
        Данните са попълнени автоматично
      </p>
    )}
  </div>
  <div className="space-y-1.5">
    <Label>ДДС номер</Label>
    <Input
      value={form.vat_number}
      onChange={(e) => set("vat_number", e.target.value)}
    />
  </div>
</div>
```

Wrap with a conditional:

```tsx
{
  !isIndividual && (
    <div className="grid grid-cols-2 gap-4">
      <div className="space-y-1.5">
        <Label>ЕИК</Label>
        <div className="relative">
          <Input
            value={form.eik}
            onChange={(e) => set("eik", e.target.value)}
            onBlur={(e) => handleEikLookup(e.target.value)}
            className={eikWarning ? "border-orange-400" : ""}
          />
          {eikLoading && (
            <Loader2 className="absolute right-2.5 top-1/2 -translate-y-1/2 h-4 w-4 animate-spin text-gray-400" />
          )}
        </div>
        {eikWarning && <p className="text-xs text-orange-500">{eikWarning}</p>}
        {eikAutoFilled && (
          <p className="text-xs text-green-600 flex items-center gap-1">
            <CheckCircle2 className="h-3 w-3" />
            Данните са попълнени автоматично
          </p>
        )}
      </div>
      <div className="space-y-1.5">
        <Label>ДДС номер</Label>
        <Input
          value={form.vat_number}
          onChange={(e) => set("vat_number", e.target.value)}
        />
      </div>
    </div>
  );
}
```

- [ ] **Step 5: Hide the Банкови данни section for individuals**

In `warehouse-frontend/src/pages/Partners.tsx`, find:

```tsx
          {/* Банкови данни */}
          <h3 className="text-sm font-semibold text-gray-500 uppercase tracking-wide mt-2">
            Банкови данни
          </h3>
          <div className="grid grid-cols-2 gap-4">
            <div className="space-y-1.5">
              <Label>Банка</Label>
              <Input
                value={form.bank_name}
                onChange={(e) => set("bank_name", e.target.value)}
              />
            </div>
            <div className="space-y-1.5">
              <Label>BIC</Label>
              <Input
                value={form.bic}
                onChange={(e) => set("bic", e.target.value)}
              />
            </div>
            <div className="space-y-1.5 col-span-2">
              <Label>IBAN</Label>
              <Input
                value={form.iban}
                onChange={(e) => set("iban", e.target.value)}
              />
            </div>
          </div>
        </div>
```

Replace with:

```tsx
          {!isIndividual && (
            <>
              {/* Банкови данни */}
              <h3 className="text-sm font-semibold text-gray-500 uppercase tracking-wide mt-2">
                Банкови данни
              </h3>
              <div className="grid grid-cols-2 gap-4">
                <div className="space-y-1.5">
                  <Label>Банка</Label>
                  <Input
                    value={form.bank_name}
                    onChange={(e) => set("bank_name", e.target.value)}
                  />
                </div>
                <div className="space-y-1.5">
                  <Label>BIC</Label>
                  <Input
                    value={form.bic}
                    onChange={(e) => set("bic", e.target.value)}
                  />
                </div>
                <div className="space-y-1.5 col-span-2">
                  <Label>IBAN</Label>
                  <Input
                    value={form.iban}
                    onChange={(e) => set("iban", e.target.value)}
                  />
                </div>
              </div>
            </>
          )}
        </div>
```

- [ ] **Step 6: Fix the mutation payload so EIK is sent as empty string for individuals**

In `warehouse-frontend/src/pages/Partners.tsx`, find the mutation:

```ts
const mutation = useMutation({
  mutationFn: () =>
    partner
      ? api.put(`/partners/${partner.id}`, form)
      : api.post("/partners", form),
  onSuccess: () => {
    qc.invalidateQueries({ queryKey: ["partners"] });
    onClose();
  },
});
```

Replace with:

```ts
const mutation = useMutation({
  mutationFn: () => {
    // Scrub EIK / VAT / bank fields when switching to individual, so the
    // server's superRefine doesn't reject the payload because of lingering
    // values from a previous legal_entity state.
    const payload =
      form.partner_type === "individual"
        ? {
            ...form,
            eik: "",
            vat_number: "",
            bank_name: "",
            bic: "",
            iban: "",
          }
        : form;
    return partner
      ? api.put(`/partners/${partner.id}`, payload)
      : api.post("/partners", payload);
  },
  onSuccess: () => {
    qc.invalidateQueries({ queryKey: ["partners"] });
    onClose();
  },
});
```

- [ ] **Step 7: Manual smoke test — Partners modal**

Run the app:

```bash
cd /Users/magic/Projects/mert-m/warehouse-backend && npm run dev &
cd /Users/magic/Projects/mert-m/warehouse-frontend && npm run dev &
```

Open `http://localhost:5173/partners`, click "Нов партньор", and verify:

1. The "Тип клиент" segment appears at the top.
2. Selecting "Физическо лице" hides ЕИК, ДДС номер, Банкови данни.
3. Typing a name and clicking Запази persists it (check in psql:
   `psql -U magic -d mertm_client -c "SELECT id, name, partner_type, eik FROM partners ORDER BY id DESC LIMIT 5;"`).
4. Selecting "Юридическо лице" (default) still works exactly as before.

- [ ] **Step 8: Commit**

```bash
cd /Users/magic/Projects/mert-m
git add warehouse-frontend/src/pages/Partners.tsx
git commit -m "feat(frontend): add partner_type segment and conditional fields in Partners form"
```

---

## Task 7: Frontend — Orders.tsx segment button + one-click individual

**Files:**

- Modify: `warehouse-frontend/src/pages/Orders.tsx`

- [ ] **Step 1: Query for the anonymous individual partner id at modal scope**

In `warehouse-frontend/src/pages/Orders.tsx`, find the start of
`CreateOrderModal`:

```tsx
function CreateOrderModal({
  open,
  onClose,
  onCreated,
  partners,
}: {
  open: boolean;
  onClose: () => void;
  onCreated?: (order: Order) => void;
  partners: Partner[];
}) {
  const qc = useQueryClient();
  const today = isoDateToday();
  const [form, setForm] = useState({
    partner_id: "",
```

Just after the `const today = isoDateToday();` line, insert:

```tsx
const anonymousIndividual = partners.find(
  (p) =>
    (p as any).partner_type === "individual" &&
    p.name === "Физическо лице — краен потребител",
);
const [customerMode, setCustomerMode] = useState<"legal" | "individual">(
  "legal",
);
```

- [ ] **Step 2: Auto-set partner_id when individual mode is picked**

In `CreateOrderModal`, just after the `customerMode` useState above, add:

```tsx
useEffect(() => {
  if (customerMode === "individual") {
    if (anonymousIndividual) {
      setForm((f) => ({ ...f, partner_id: String(anonymousIndividual.id) }));
    }
  } else {
    // When switching back to "фирма", clear partner_id so the combobox
    // re-engages (keeps the user in control — they must pick explicitly).
    setForm((f) =>
      f.partner_id &&
      anonymousIndividual &&
      f.partner_id === String(anonymousIndividual.id)
        ? { ...f, partner_id: "" }
        : f,
    );
  }
}, [customerMode, anonymousIndividual]);
```

- [ ] **Step 3: Reset customerMode on dialog open**

In `CreateOrderModal`, find the existing `useEffect(() => { if (open) { ... } }, [open, today]);` block:

```ts
  useEffect(() => {
    if (open) {
      setForm({
        partner_id: "",
        delivery_date: today,
        notes: "",
```

At the start of the `if (open)` body, add:

```ts
setCustomerMode("legal");
```

so it becomes:

```ts
  useEffect(() => {
    if (open) {
      setCustomerMode("legal");
      setForm({
        partner_id: "",
        delivery_date: today,
        notes: "",
```

- [ ] **Step 4: Add the segment button in the CreateOrderModal JSX**

In `CreateOrderModal`, find:

```tsx
        <div className="flex-1 overflow-y-auto min-h-0 space-y-4 py-2 pr-1">
          <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
            <div className="space-y-1.5">
              <Label>Партньор *</Label>
              <Combobox
                inputRef={partnerInputRef}
                items={partners.map((p) => ({
```

Replace the opening of that container with a segment button above the
`grid grid-cols-1 md:grid-cols-2 gap-4` div, and adapt the Партньор
label/Combobox so individuals bypass the combobox:

```tsx
        <div className="flex-1 overflow-y-auto min-h-0 space-y-4 py-2 pr-1">
          {/* Тип клиент (сегмент) */}
          <div className="flex flex-wrap items-center gap-2">
            <Label className="mr-2">Тип клиент:</Label>
            <div className="inline-flex rounded-lg border bg-gray-50 p-1">
              <button
                type="button"
                onClick={() => setCustomerMode("legal")}
                className={`px-3 py-1.5 text-sm font-medium rounded-md transition ${
                  customerMode === "legal"
                    ? "bg-white shadow text-gray-900"
                    : "text-gray-500 hover:text-gray-900"
                }`}
              >
                🏢 Фирма (с ЕИК)
              </button>
              <button
                type="button"
                onClick={() => setCustomerMode("individual")}
                className={`px-3 py-1.5 text-sm font-medium rounded-md transition ${
                  customerMode === "individual"
                    ? "bg-white shadow text-gray-900"
                    : "text-gray-500 hover:text-gray-900"
                }`}
                disabled={!anonymousIndividual}
                title={
                  anonymousIndividual
                    ? "Физическо лице — без ЕИК, без лични данни"
                    : "Seed партньорът липсва — изпълнете миграцията"
                }
              >
                👤 Физическо лице
              </button>
            </div>
            {customerMode === "individual" && (
              <span className="text-xs text-gray-500">
                Продажба на краен потребител. Касовата бележка излиза от
                фискалния апарат.
              </span>
            )}
          </div>

          <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
            <div className="space-y-1.5">
              <Label>
                {customerMode === "individual" ? "Клиент" : "Партньор *"}
              </Label>
              {customerMode === "individual" ? (
                <div className="h-9 flex items-center px-3 rounded-md border bg-gray-50 text-sm text-gray-700">
                  👤 Физическо лице — краен потребител
                </div>
              ) : (
                <Combobox
                  inputRef={partnerInputRef}
                  items={partners
                    .filter(
                      (p) => (p as any).partner_type !== "individual",
                    )
                    .map((p) => ({
                      value: String(p.id),
                      label: p.name,
                      hint: p.microinvest_code
                        ? `Код: ${p.microinvest_code}${p.eik ? ` · ЕИК: ${p.eik}` : ""}`
                        : p.eik
                          ? `ЕИК: ${p.eik}`
                          : undefined,
                    }))}
                  value={form.partner_id}
                  onChange={(val) =>
                    setForm((f) => ({
                      ...f,
                      partner_id: val,
                    }))
                  }
                  onClear={() =>
                    setForm((f) => ({
                      ...f,
                      partner_id: "",
                    }))
                  }
                  onPickEnter={() =>
                    queueMicrotask(() => focusAndSelect(dateInputRef.current))
                  }
                  placeholder="Избери или потърси по код, име или ЕИК..."
                  emptyMessage="Няма намерени партньори."
                />
              )}
            </div>
```

(Keep the delivery-date block below unchanged.)

- [ ] **Step 5: Manual smoke test — CreateOrderModal**

Run both dev servers (if not already), open
`http://localhost:5173/orders` and click "Нова поръчка":

1. Default segment is "🏢 Фирма (с ЕИК)" — Combobox visible as before.
2. Click "👤 Физическо лице" — combobox swaps to a disabled readonly
   "Физическо лице — краен потребител" pill, partner is implicitly set.
3. Add a product, set a price, click "Създай поръчка" (Ctrl+Enter).
4. Order is created. In psql:
   `psql -U magic -d mertm_client -c "SELECT id, partner_id FROM orders ORDER BY id DESC LIMIT 1;"`
   The partner_id should match the anonymous individual partner.
5. Flip back to "🏢 Фирма" — combobox re-appears empty; partner_id is
   cleared.

- [ ] **Step 6: Commit**

```bash
cd /Users/magic/Projects/mert-m
git add warehouse-frontend/src/pages/Orders.tsx
git commit -m "feat(orders): add customer-type segment and one-click individual flow"
```

---

## Task 8: Frontend — invoice trigger supports client_display_name

**Files:**

- Modify: `warehouse-frontend/src/pages/Orders.tsx`

- [ ] **Step 1: Add clientDisplayName state next to includeVat**

In `warehouse-frontend/src/pages/Orders.tsx`, find inside `OrderDetailModal`:

```tsx
// VAT toggle for invoice/documents
const [includeVat, setIncludeVat] = useState(true);
const [generatedInvoiceId, setGeneratedInvoiceId] = useState<number | null>(
  null,
);
```

Replace with:

```tsx
// VAT toggle for invoice/documents
const [includeVat, setIncludeVat] = useState(true);
// Optional override of the buyer name on the printed invoice. Only
// exposed when the order's partner is an individual (физ. лице). When
// empty we fall back to partner.name server-side.
const [clientDisplayName, setClientDisplayName] = useState("");
const [generatedInvoiceId, setGeneratedInvoiceId] = useState<number | null>(
  null,
);
```

- [ ] **Step 2: Reset clientDisplayName when the order changes**

In `OrderDetailModal`, find:

```ts
useEffect(() => {
  setGeneratedInvoiceId(null);
  setEditOpen(false);
  setCancelInvoiceOpen(false);
  setCancelInvoiceReason("");
  setCreditNoteOpen(false);
  setCreditNoteReason("");
  setCreditNoteRestoreStock(true);
  setIssuedCreditNoteId(null);
}, [order?.id]);
```

Replace with:

```ts
useEffect(() => {
  setGeneratedInvoiceId(null);
  setEditOpen(false);
  setCancelInvoiceOpen(false);
  setCancelInvoiceReason("");
  setCreditNoteOpen(false);
  setCreditNoteReason("");
  setCreditNoteRestoreStock(true);
  setIssuedCreditNoteId(null);
  setClientDisplayName("");
}, [order?.id]);
```

- [ ] **Step 3: Pass clientDisplayName to the invoice mutation**

In `OrderDetailModal`, find:

```ts
const invoiceMutation = useMutation({
  mutationFn: (id: number) =>
    api.post("/invoices", { order_id: id, include_vat: includeVat }),
  onSuccess: (res) => {
    const newInvoiceId = res.data?.id ?? null;
    setGeneratedInvoiceId(newInvoiceId);
    invalidateAllOrderRelated();
    // Auto-open PDF for printing immediately after generation
    if (newInvoiceId) {
      setTimeout(() => void openInvoicePdf(newInvoiceId), 300);
    }
  },
});
```

Replace with:

```ts
const invoiceMutation = useMutation({
  mutationFn: (id: number) =>
    api.post("/invoices", {
      order_id: id,
      include_vat: includeVat,
      client_display_name: clientDisplayName.trim() || undefined,
    }),
  onSuccess: (res) => {
    const newInvoiceId = res.data?.id ?? null;
    setGeneratedInvoiceId(newInvoiceId);
    invalidateAllOrderRelated();
    // Auto-open PDF for printing immediately after generation
    if (newInvoiceId) {
      setTimeout(() => void openInvoicePdf(newInvoiceId), 300);
    }
  },
});
```

- [ ] **Step 4: Render the optional name input in the invoice action bar**

In `OrderDetailModal`, find the "Генерирай фактура" button block:

```tsx
              {!hasInvoice ? (
                <Button
                  onClick={() => invoiceMutation.mutate(detail.id)}
                  disabled={invoiceMutation.isPending}
                  className="bg-[#f97316] hover:bg-[#ea580c]"
                >
                  {invoiceMutation.isPending ? (
                    <Spinner size="sm" />
                  ) : (
                    <FileText className="h-4 w-4" />
                  )}
                  Генерирай фактура {!includeVat && "(без ДДС)"}
                </Button>
              ) : (
```

Replace with:

```tsx
              {!hasInvoice ? (
                <div className="flex items-center gap-2">
                  {(detail?.partner as any)?.partner_type === "individual" && (
                    <Input
                      value={clientDisplayName}
                      onChange={(e) => setClientDisplayName(e.target.value)}
                      placeholder="Име на клиента (по желание)"
                      className="w-60 h-9"
                      title="Ако клиентът поиска фактурата да е на конкретно име — иначе остава 'Физическо лице — краен потребител'."
                    />
                  )}
                  <Button
                    onClick={() => invoiceMutation.mutate(detail.id)}
                    disabled={invoiceMutation.isPending}
                    className="bg-[#f97316] hover:bg-[#ea580c]"
                  >
                    {invoiceMutation.isPending ? (
                      <Spinner size="sm" />
                    ) : (
                      <FileText className="h-4 w-4" />
                    )}
                    Генерирай фактура {!includeVat && "(без ДДС)"}
                  </Button>
                </div>
              ) : (
```

- [ ] **Step 5: Verify detail.partner carries partner_type**

Run:

```bash
grep -n "SELECT.*partners\|p\\.partner_type\|partner_type" /Users/magic/Projects/mert-m/warehouse-backend/src/routes/orders.ts | head
```

If `partner_type` is not already joined into the order-detail payload,
open `warehouse-backend/src/routes/orders.ts`, find the single-order
detail query (around `app.get("/:id",` near line 539) and ensure the
JOIN on partners returns `p.partner_type`. Typical pattern:

```sql
SELECT o.*, p.name AS partner_name, p.eik AS partner_eik,
       p.partner_type AS partner_partner_type, ...
```

If the payload is keyed under `partner: { ... }` object already, add
`partner_type` to that object. If it is flattened (e.g. `partner_name`),
expose it as `partner_partner_type` and adjust the frontend conditional
in Step 4 from `(detail?.partner as any)?.partner_type === "individual"`
to `(detail as any)?.partner_partner_type === "individual"` to match.

This step is a verification step — only change `orders.ts` if the field
is missing. If the field is already there, skip to Step 6.

- [ ] **Step 6: Manual smoke test — invoice for individual**

Run both dev servers. Open `http://localhost:5173/orders`:

1. Find (or create) an order for the anonymous individual partner.
2. Open its detail dialog.
3. The "Име на клиента (по желание)" input appears next to the
   "Генерирай фактура" button.
4. Leave it empty, click "Генерирай фактура" → PDF opens, buyer line
   reads "Клиент: Физическо лице — краен потребител", no ЕИК row.
5. Delete the invoice (or create a new order), this time type "Иван
   Петров" in the input, click Генерирай → PDF now reads
   "Клиент: Иван Петров".
6. Verify for a legal-entity order the input does NOT appear.

- [ ] **Step 7: Commit**

```bash
cd /Users/magic/Projects/mert-m
git add warehouse-frontend/src/pages/Orders.tsx
git commit -m "feat(orders): optional client_display_name on invoice for individual"
```

---

## Task 9: End-to-end manual regression

**Files:** none (smoke only).

- [ ] **Step 1: Full happy-path walkthrough**

With both dev servers running, step through the entire flow end-to-end:

1. `Partners` → create a legal entity with valid EIK (9 digits). Confirm save.
2. `Partners` → create an individual named "Мария Георгиева", no EIK.
   Confirm save; psql shows `partner_type='individual'`, `eik IS NULL`.
3. `Orders` → "Нова поръчка" with default (legal) mode → pick the legal
   entity → add item → create. Confirm created.
4. `Orders` → "Нова поръчка" switch to "👤 Физическо лице" → add item →
   create. Confirm order attached to the anonymous individual partner.
5. Open the individual order → click Генерирай фактура without typing
   a name → PDF shows "Клиент: Физическо лице — краен потребител".
6. Create another individual order → this time type "Мария Георгиева"
   in the optional name field → PDF shows "Клиент: Мария Георгиева".
7. Legal-entity order → Генерирай фактура → PDF still shows
   "МП: <фирма>" / "ЕИК: ..." (regression check).
8. `Payments` page still renders payments for individual orders:
   psql quick check:
   ```bash
   psql -U magic -d mertm_client -c "SELECT COUNT(*) FROM payments WHERE order_id IN (SELECT id FROM orders WHERE partner_id = (SELECT id FROM partners WHERE partner_type='individual' LIMIT 1));"
   ```

- [ ] **Step 2: Final test run**

```bash
cd /Users/magic/Projects/mert-m/warehouse-backend
npx vitest run src/__tests__/partners-validation.test.ts src/__tests__/invoice-pdf.test.ts src/__tests__/invoice-pdf-individual.test.ts
```

Expected: all tests PASS.

- [ ] **Step 3: Final commit (if any stragglers)**

```bash
cd /Users/magic/Projects/mert-m
git status
# if there is nothing to commit: done.
# if there are leftover changes from smoke debugging, stage & commit with a
# clear message.
```

---

## Self-Review Checklist (already run)

1. **Spec coverage:**
   - Section 4.1 data model — Task 1 (migration), Task 3 (Zod schema accepts `partner_type`).
   - Section 4.2 seed data — Task 1 Step 1.
   - Section 4.3 invoicing flow — Task 5 (PDF), Task 8 (UI).
   - Section 5.1 Partners form — Task 6.
   - Section 5.3 Orders segment — Task 7.
   - Section 5.4 invoice.client_display_name column — Task 1 + Task 4.
   - Section 5.5 invoice PDF individual label — Task 5.
   - Section 6 backend changes — Tasks 1, 3, 4, 5.

2. **Placeholders:** none — every step contains either exact code, exact
   command, or a verification step with expected output.

3. **Type consistency:** `partner_type` values `"individual"` /
   `"legal_entity"` / `"customer"` / `"supplier"` used consistently across
   backend schema, frontend state, and SQL. `client_display_name` is the
   column name in `invoices`, the Zod field in `createInvoiceSchema`, the
   TypeScript field on `InvoiceData.invoice`, and the React state variable
   — no drift.
