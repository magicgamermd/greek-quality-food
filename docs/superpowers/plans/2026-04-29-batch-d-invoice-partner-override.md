# Batch D — Invoice partner override Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** When an order's partner is `individual`, allow the cashier to issue the invoice in the name of a different (company) partner — picked from the catalog or created on the fly via inline form. Order partner stays unchanged.

**Architecture:** No DB migration. Backend `createInvoiceSchema` accepts a Zod union `partner_override`: either `{partner_id}` (existing) or full new-partner data. Server upserts by EIK (reuse if exists, INSERT otherwise). Invoice's `partner_id` becomes the resolved override; order's `partner_id` is left alone; `client_display_name` forced NULL. `regenerateInvoiceSchema` rejects `partner_override` outright. Frontend adds a sub-dialog from the invoice flow, gated on `partner_partner_type==='individual'`.

**Tech Stack:** Fastify+TypeScript+Zod backend, Vitest tests, React+TanStack Query frontend with existing `Combobox` and `Dialog` primitives.

**Spec:** [docs/superpowers/specs/2026-04-29-batch-d-invoice-partner-override-design.md](../specs/2026-04-29-batch-d-invoice-partner-override-design.md)

---

## Pre-flight

- Branch: `git checkout main && git pull && git checkout -b feature/MERTM-batch-d-invoice-partner-override`
- Backend tests: `cd warehouse-backend && npx vitest run`
- Type-check: `npx tsc --noEmit` (in both `warehouse-backend/` and `warehouse-frontend/`)

---

## Task 1: Backend — extend createInvoiceSchema with `partner_override`

**Files:**

- Modify: `warehouse-backend/src/routes/invoices.ts:57-72` (createInvoiceSchema)

**Step 1: Add Zod union after the existing fields**

Inside `createInvoiceSchema = z.object({...})`, after `client_display_name`:

```ts
partner_override: z
  .union([
    z.object({ partner_id: z.number().int().positive() }),
    z.object({
      name: z.string().trim().min(1).max(255),
      eik: z.string().trim().min(1).max(50),
      vat_number: z.string().trim().max(50).optional(),
      address: z.string().trim().max(500).optional(),
      city: z.string().trim().max(100).optional(),
      contact_person: z.string().trim().max(255).optional(),
      phone: z.string().trim().max(50).optional(),
    }),
  ])
  .optional(),
```

**Step 2: Type-check**

Run: `cd warehouse-backend && npx tsc --noEmit`
Expected: PASS.

**Step 3: Commit**

```bash
git add warehouse-backend/src/routes/invoices.ts
git commit -m "feat(invoices): add optional partner_override field to createInvoiceSchema"
```

---

## Task 2: Backend — extend regenerate schema to reject `partner_override`

**Files:**

- Modify: `warehouse-backend/src/routes/invoices.ts:73-78` (regenerateInvoiceSchema)

**Step 1: Add a guard via `z.never()`**

```ts
const regenerateInvoiceSchema = z.object({
  payment_method: invoicePaymentMethodSchema.optional(),
  vat_exemption_reason: z.string().trim().max(500).optional(),
  invoice_note: z.string().trim().max(2000).optional(),
  partner_override: z
    .never({
      invalid_type_error: "Partner cannot be changed on regenerate.",
    })
    .optional(),
});
```

(The `vat_exemption_reason` and `invoice_note` fields come from Batch G+H; if Batch G+H hasn't merged yet, omit those two lines.)

**Step 2: Commit**

```bash
git add warehouse-backend/src/routes/invoices.ts
git commit -m "feat(invoices): regenerate explicitly rejects partner_override"
```

---

## Task 3: Backend — upsert helper for partner-by-EIK

**Files:**

- Modify: `warehouse-backend/src/routes/invoices.ts` — add a helper near the top (after imports) for resolving the override into a `partner_id`.

**Step 1: Helper**

```ts
/**
 * Resolve a partner override into a numeric partner_id.
 * - {partner_id} → returned as-is (existing partner picked from catalog).
 * - new-partner data → SELECT by EIK; reuse existing or INSERT new.
 */
async function resolveOverridePartner(
  client: { query: (sql: string, params: any[]) => Promise<{ rows: any[] }> },
  override: any,
): Promise<number> {
  if ("partner_id" in override) return override.partner_id;

  const eik = override.eik.trim();
  const {
    rows: [existing],
  } = await client.query(`SELECT id FROM partners WHERE eik = $1 LIMIT 1`, [
    eik,
  ]);
  if (existing) return existing.id;

  const {
    rows: [created],
  } = await client.query(
    `INSERT INTO partners
       (name, eik, vat_number, address, city, contact_person, phone, partner_type)
     VALUES ($1, $2, $3, $4, $5, $6, $7, 'company')
     RETURNING id`,
    [
      override.name.trim(),
      eik,
      override.vat_number ?? null,
      override.address ?? null,
      override.city ?? null,
      override.contact_person ?? null,
      override.phone ?? null,
    ],
  );
  return created.id;
}
```

**Step 2: Commit**

```bash
git add warehouse-backend/src/routes/invoices.ts
git commit -m "feat(invoices): resolveOverridePartner helper (upsert by EIK)"
```

---

## Task 4: Backend — wire override into POST /invoices

**Files:**

- Modify: `warehouse-backend/src/routes/invoices.ts:343-460` (POST /invoices handler)

**Step 1: Use the helper before the INSERT**

In the transaction, after fetching the order and partner (around `:395-405`), replace the existing logic with:

```ts
let invoicePartnerId = order.partner_id;
let clientDisplayName =
  partner?.partner_type === "individual"
    ? (body.client_display_name ?? null)
    : null;

if (body.partner_override) {
  if (partner?.partner_type !== "individual") {
    throw Object.assign(
      new Error("partner_override is allowed only for individual orders"),
      { statusCode: 400 },
    );
  }
  invoicePartnerId = await resolveOverridePartner(
    client,
    body.partner_override,
  );
  // Override is mutually exclusive with client_display_name
  clientDisplayName = null;
}
```

**Step 2: Use `invoicePartnerId` in the INSERT**

In the existing INSERT INTO invoices, replace `order.partner_id` with `invoicePartnerId`:

```ts
const {
  rows: [invoice],
} = await client.query(
  `INSERT INTO invoices
     (invoice_number, invoice_date, partner_id,
      total_net, total_vat, total_gross, include_vat,
      client_display_name, payment_method)
   VALUES ($1, CURRENT_DATE, $2, $3, $4, $5, $6, $7, $8)
   RETURNING *`,
  [
    invoiceNumber,
    invoicePartnerId, // ← changed
    totalNet,
    totalVat,
    totalGross,
    body.include_vat,
    clientDisplayName,
    body.payment_method,
  ],
);
```

**Step 3: Re-fetch the partner row for PDF generation**

The PDF data needs the partner used on the invoice (which may differ from order's partner). After the INSERT:

```ts
const { rows: [invoicePartner] } = await client.query(
  `SELECT * FROM partners WHERE id = $1`,
  [invoicePartnerId],
);

// Pass invoicePartner instead of partner to generateInvoicePdf
await generateInvoicePdf({
  invoice,
  partner: invoicePartner ?? partner,
  ...
});
```

**Step 4: Type-check + commit**

```bash
cd warehouse-backend && npx tsc --noEmit
git add warehouse-backend/src/routes/invoices.ts
git commit -m "feat(invoices): POST /invoices honours partner_override (individual only)"
```

---

## Task 5: Backend integration tests

**Files:**

- Create: `warehouse-backend/src/__tests__/invoices-partner-override.test.ts`

**Step 1: Write tests (skeleton)**

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

describe("POST /invoices partner_override", () => {
  beforeEach(() => mockTx.mockReset());

  it("uses override partner_id directly when provided", async () => {
    // Mock transaction to capture the partner_id used in INSERT INTO invoices
    // …
  });

  it("reuses partner with matching EIK (no new INSERT)", async () => {
    // Mock SELECT FROM partners WHERE eik = X → returns existing row.
    // Verify INSERT INTO partners is NOT called.
  });

  it("inserts new partner when EIK does not exist", async () => {
    // Mock SELECT FROM partners → empty.
    // Verify INSERT INTO partners with partner_type='company' IS called.
  });

  it("rejects 400 when order partner is not individual", async () => {
    // Mock partner row with partner_type='company'.
    // Submit POST with partner_override.
    // Expect 400.
  });

  it("forces client_display_name to NULL when override is active", async () => {
    // Submit body { partner_override: {partner_id: 99}, client_display_name: "Иван" }.
    // Verify INSERT INTO invoices receives client_display_name = null.
  });
});

describe("PUT /invoices/:id/regenerate", () => {
  it("rejects 400 when partner_override is supplied", async () => {
    const app = await buildApp();
    const res = await app.inject({
      method: "PUT",
      url: "/invoices/1/regenerate",
      payload: { partner_override: { partner_id: 99 } },
    });
    expect(res.statusCode).toBe(400);
    await app.close();
  });
});
```

**Step 2: Run + iterate until all pass**

```bash
cd warehouse-backend && npx vitest run src/__tests__/invoices-partner-override.test.ts
```

**Step 3: Commit**

```bash
git add warehouse-backend/src/__tests__/invoices-partner-override.test.ts
git commit -m "test(invoices): integration tests for partner_override flow"
```

---

## Task 6: Frontend — partner_override state + sub-dialog state

**Files:**

- Modify: `warehouse-frontend/src/pages/Orders.tsx` — order detail drawer (where ДДС / Плащане / Генерирай фактура live)

**Step 1: Add new state alongside existing invoice-dialog state**

Near where `includeVat`, `paymentMethod`, `clientDisplayName` are declared:

```ts
type PartnerOverride =
  | { partner_id: number; name: string; eik: string }
  | {
      name: string;
      eik: string;
      vat_number?: string;
      address?: string;
      city?: string;
      contact_person?: string;
      phone?: string;
    };

const [partnerOverride, setPartnerOverride] = useState<PartnerOverride | null>(
  null,
);
const [partnerOverrideOpen, setPartnerOverrideOpen] = useState(false);
```

**Step 2: Reset on order change** — add to the per-order reset useEffect:

```ts
setPartnerOverride(null);
setPartnerOverrideOpen(false);
```

**Step 3: Reset after successful invoice mutation**

In `invoiceMutation.onSuccess`:

```ts
setPartnerOverride(null);
```

**Step 4: Commit**

```bash
git add warehouse-frontend/src/pages/Orders.tsx
git commit -m "feat(orders-fe): partner_override state + sub-dialog open state"
```

---

## Task 7: Frontend — "Издай на фирма" button + chip

**Files:**

- Modify: `warehouse-frontend/src/pages/Orders.tsx:1395-1420` (invoice-generating section, near where the existing `partner_partner_type==='individual'` check lives)

**Step 1: After the existing client_display_name input (around `:1407`), add the override button**

```tsx
{
  (detail as any)?.partner_partner_type === "individual" && (
    <Button
      variant="outline"
      onClick={() => setPartnerOverrideOpen(true)}
      className="border-blue-600 text-blue-700 hover:bg-blue-50"
    >
      <Building2 className="h-4 w-4" />
      {partnerOverride ? "Промени фирма" : "Издай на фирма"}
    </Button>
  );
}
```

(Import `Building2` from `lucide-react` at the top.)

**Step 2: Below it, when override is set, render a chip**

```tsx
{
  partnerOverride && (
    <div className="text-xs flex items-center gap-1 px-2 py-1 rounded bg-amber-50 text-amber-800 border border-amber-200">
      <span>
        Фактура на: <b>{partnerOverride.name}</b> (ЕИК {partnerOverride.eik})
      </span>
      <button
        type="button"
        onClick={() => setPartnerOverride(null)}
        className="ml-1 text-amber-600 hover:text-amber-900"
        title="Премахни"
      >
        ×
      </button>
    </div>
  );
}
```

**Step 3: Manual smoke**

Open an individual order → invoice section → button should appear. Click → sub-dialog (next task) opens.

**Step 4: Commit**

```bash
git add warehouse-frontend/src/pages/Orders.tsx
git commit -m "feat(orders-fe): add 'Издай на фирма' button + chip in invoice section"
```

---

## Task 8: Frontend — sub-dialog (combobox + new-partner form)

**Files:**

- Modify: `warehouse-frontend/src/pages/Orders.tsx` — add a new Dialog near the existing dialogs at the bottom of the order-detail drawer.

**Step 1: Local state for the form**

Inside the drawer component, near the override state from Task 6:

```ts
const [overrideMode, setOverrideMode] = useState<"existing" | "new">(
  "existing",
);
const [overrideExistingId, setOverrideExistingId] = useState<number | null>(
  null,
);
const [newPartner, setNewPartner] = useState({
  name: "",
  eik: "",
  vat_number: "",
  address: "",
  city: "",
  contact_person: "",
  phone: "",
});
```

**Step 2: Reset the form when the dialog opens**

```ts
useEffect(() => {
  if (!partnerOverrideOpen) return;
  setOverrideMode("existing");
  setOverrideExistingId(null);
  setNewPartner({
    name: "",
    eik: "",
    vat_number: "",
    address: "",
    city: "",
    contact_person: "",
    phone: "",
  });
}, [partnerOverrideOpen]);
```

**Step 3: Render the sub-dialog**

```tsx
<Dialog open={partnerOverrideOpen} onOpenChange={setPartnerOverrideOpen}>
  <DialogContent className="max-w-lg">
    <DialogHeader>
      <DialogTitle>Издай фактура на фирма</DialogTitle>
    </DialogHeader>

    {/* Mode toggle */}
    <div className="flex gap-2">
      <Button
        size="sm"
        variant={overrideMode === "existing" ? "default" : "outline"}
        onClick={() => setOverrideMode("existing")}
      >
        Съществуваща
      </Button>
      <Button
        size="sm"
        variant={overrideMode === "new" ? "default" : "outline"}
        onClick={() => setOverrideMode("new")}
      >
        + Нов партньор
      </Button>
    </div>

    {overrideMode === "existing" ? (
      <div>
        <Label>Партньор</Label>
        <Combobox
          options={(partners ?? [])
            .filter((p) => p.partner_type !== "individual")
            .map((p) => ({
              value: String(p.id),
              label: `${p.name} (ЕИК ${p.eik})`,
              data: p,
            }))}
          value={overrideExistingId != null ? String(overrideExistingId) : ""}
          onChange={(v) => setOverrideExistingId(v ? Number(v) : null)}
          placeholder="Търси по име или ЕИК"
        />
      </div>
    ) : (
      <div className="space-y-2">
        <div>
          <Label>Име *</Label>
          <Input
            value={newPartner.name}
            onChange={(e) =>
              setNewPartner((p) => ({ ...p, name: e.target.value }))
            }
            placeholder="напр. Фирма Х ЕООД"
          />
        </div>
        <div>
          <Label>ЕИК *</Label>
          <Input
            value={newPartner.eik}
            onChange={(e) =>
              setNewPartner((p) => ({ ...p, eik: e.target.value }))
            }
            placeholder="9-13 цифри"
          />
        </div>
        <div>
          <Label>ДДС №</Label>
          <Input
            value={newPartner.vat_number}
            onChange={(e) =>
              setNewPartner((p) => ({ ...p, vat_number: e.target.value }))
            }
          />
        </div>
        <div>
          <Label>Адрес</Label>
          <Input
            value={newPartner.address}
            onChange={(e) =>
              setNewPartner((p) => ({ ...p, address: e.target.value }))
            }
          />
        </div>
        <div>
          <Label>Град</Label>
          <Input
            value={newPartner.city}
            onChange={(e) =>
              setNewPartner((p) => ({ ...p, city: e.target.value }))
            }
          />
        </div>
        <div>
          <Label>Контактно лице</Label>
          <Input
            value={newPartner.contact_person}
            onChange={(e) =>
              setNewPartner((p) => ({ ...p, contact_person: e.target.value }))
            }
          />
        </div>
        <div>
          <Label>Телефон</Label>
          <Input
            value={newPartner.phone}
            onChange={(e) =>
              setNewPartner((p) => ({ ...p, phone: e.target.value }))
            }
          />
        </div>
      </div>
    )}

    <DialogFooter>
      <Button variant="outline" onClick={() => setPartnerOverrideOpen(false)}>
        Отказ
      </Button>
      <Button
        onClick={() => {
          if (overrideMode === "existing") {
            const picked = (partners ?? []).find(
              (p) => p.id === overrideExistingId,
            );
            if (!picked) return;
            setPartnerOverride({
              partner_id: picked.id,
              name: picked.name,
              eik: picked.eik,
            });
          } else {
            if (!newPartner.name.trim() || !newPartner.eik.trim()) return;
            setPartnerOverride({ ...newPartner });
          }
          setPartnerOverrideOpen(false);
        }}
      >
        Запази
      </Button>
    </DialogFooter>
  </DialogContent>
</Dialog>
```

**Step 4: Commit**

```bash
git add warehouse-frontend/src/pages/Orders.tsx
git commit -m "feat(orders-fe): partner-override sub-dialog (combobox + new-partner form)"
```

---

## Task 9: Frontend — wire override into invoiceMutation

**Files:**

- Modify: `warehouse-frontend/src/pages/Orders.tsx` — `invoiceMutation`

**Step 1: Adapt the mutation body**

```ts
const invoiceMutation = useMutation({
  mutationFn: () => {
    const payload: any = {
      order_id: detail.id,
      include_vat: includeVat,
      payment_method: paymentMethod,
      client_display_name: partnerOverride
        ? undefined
        : clientDisplayName.trim() || undefined,
    };

    if (partnerOverride) {
      payload.partner_override =
        "partner_id" in partnerOverride
          ? { partner_id: partnerOverride.partner_id }
          : {
              name: partnerOverride.name.trim(),
              eik: partnerOverride.eik.trim(),
              vat_number: partnerOverride.vat_number?.trim() || undefined,
              address: partnerOverride.address?.trim() || undefined,
              city: partnerOverride.city?.trim() || undefined,
              contact_person:
                partnerOverride.contact_person?.trim() || undefined,
              phone: partnerOverride.phone?.trim() || undefined,
            };
    }

    return api.post("/invoices", payload);
  },
  onSuccess: () => {
    invalidateAllOrderRelated();
    setPartnerOverride(null);
    // …existing onSuccess logic…
  },
});
```

**Step 2: Type-check**

```bash
cd warehouse-frontend && npx tsc --noEmit
```

**Step 3: Commit**

```bash
git add warehouse-frontend/src/pages/Orders.tsx
git commit -m "feat(orders-fe): invoiceMutation sends partner_override payload"
```

---

## Task 10: Manual end-to-end verification

Run `./scripts/start-mertm.sh`, then:

1. **Login admin** → Поръчки → find any order with partner = "Физическо лице" (one of the existing individual orders).
2. Click "Издай на фирма" → sub-dialog opens; "Съществуваща" tab is default.
3. Pick an existing company from the combobox → click "Запази" → dialog closes; chip appears: "Фактура на: <name> (ЕИК ...)".
4. Click "Генерирай фактура" → invoice opens; verify the partner section on the PDF shows the company (not "Физическо лице").
5. Open the order again → partner field still says "Физическо лице — краен потребител" (order unchanged).
6. **Repeat with a NEW partner:**
   - Click "Издай на фирма" → switch to "+ Нов партньор" tab → fill name + EIK (mandatory) → leave others blank → "Запази".
   - Click "Генерирай фактура" → invoice generated, PDF shows the new company.
   - Check Партньори page → new partner is in the catalog.
7. **EIK reuse test:**
   - Repeat step 6 with the SAME EIK as step 6 → invoice generated; verify Партньори has only 1 row with that EIK (no duplicate).
8. **Reject test:**
   - Try to send `partner_override` to `PUT /invoices/:id/regenerate` directly via DevTools / curl → 400.
9. **Non-individual rejection:**
   - Pick a company-partner order → "Издай на фирма" button is hidden. (Frontend gate.)

If any step fails, fix and re-commit.

---

## Task 11: Update STATUS.md

```markdown
**Batch D — Invoice partner override** (2026-04-29):

- createInvoiceSchema accepts optional `partner_override` (existing partner_id OR new-partner data)
- Backend upserts by EIK (avoids duplicates)
- Order's partner_id stays unchanged; invoice points to the resolved override
- regenerate explicitly rejects partner_override
- Frontend sub-dialog with combobox + inline new-partner form, gated on individual orders
- Customer paying for goods bought as individual can later receive a company invoice
```

```bash
git add STATUS.md
git commit -m "docs(status): Batch D complete — invoice partner override"
```

---

## Verification checklist (`superpowers:verification-before-completion`)

- [ ] No new migration (verified)
- [ ] Backend tests pass: `npx vitest run`
- [ ] Backend type-check clean
- [ ] Frontend type-check clean
- [ ] Manual E2E (Task 10) — all 9 steps green
- [ ] STATUS.md updated
- [ ] All commits use conventional format
