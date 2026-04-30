# Daily Report (Дневен отчет) — Design Spec

**Date:** 2026-04-30
**Status:** Approved (brainstorming)
**Owner:** magic
**Branch target:** new branch from `main` (e.g. `feature/MERTM-daily-report`)

## 1. Context and problem

MERT-M needs a printable end-of-day summary document that a cashier or owner can generate and archive. Today the data is spread across:

- **Dashboard** — KPI cards (today's orders count, stock value, low-stock count, pending payments).
- **Payments page** — has a print-friendly daily-payments view (`MERT-M — Дневен отчет (Фактурни)`).
- **Fiscal printer** — outputs Z/X reports for cash-register legal compliance, not for management.

There is no single document that combines:

- Per-order list with partner, amount, status, payment method, invoice link
- Invoices issued today, broken down by status and payment method
- Cash actually received today (payments), broken down by method
- Econt shipments created today (with COD vs regular split)
- Outstanding (unpaid) invoices snapshot at end-of-day
- Top-selling products of the day

This spec adds that single document.

## 2. Solution (high-level)

**One new endpoint** generates the daily report PDF on demand:

```
GET /api/reports/daily-pdf?date=YYYY-MM-DD
```

- Auth: `REPORTS_VIEW` permission (new) — default for `admin` + `accountant`.
- Returns `application/pdf` (streamed).
- `date` query param defaults to today if omitted.

**One new frontend trigger:** a "🖨 Дневен отчет" button on the Dashboard (top right, gated by `<Can permission="REPORTS_VIEW">`). Click opens a small dialog with a `<input type="date">` (default today) and a "Свали PDF" action.

The PDF is opened in a new tab via authed blob fetch (same pattern as offer-pdf / protocol-pdf — `window.open` on the raw URL fails because the browser drops the JWT header).

All amounts are in **EUR** using `formatEurAmount` from `utils/currency.ts` (the project's standard since BG joined the eurozone).

## 3. PDF layout

A4 portrait. ~1–3 pages depending on the day's volume.

### Header

```
МЕРТ-М — Дневен отчет
30 април 2026 г.
Генериран от: admin@mertm.bg на 30.04.2026 18:32
```

Generation user comes from the JWT (`request.user.email`).

### Раздел 1 — Поръчки днес (detailed)

One row per order. Sorted by `order_number` ASC.

| №   | Партньор        | Сума       | Статус     | Плащане    | Фактура    |
| --- | --------------- | ---------- | ---------- | ---------- | ---------- |
| 101 | ЖОКЕР ЕНТ. ЕООД | 359,11 €   | Изпълнена  | В брой     | 0000000023 |
| 102 | ВИКИ ВАТ ЕООД   | 2 863,24 € | Изпълнена  | Налож.пл.  | 0000000003 |
| 103 | ДЕКОР ЕООД      | 450,00 €   | Потвърдена | Банков пр. | —          |
| 104 | АТЛАС ЕООД      | 820,00 €   | Чакаща     | —          | —          |
| 105 | МЕНТА ЛИМИТЕД   | 1 200,00 € | Оферта     | —          | —          |

**Columns:**

- **№** — `order_number` (fallback `id`)
- **Партньор** — `partners.name`, truncated to ~25 chars in the cell
- **Сума** — `orders.total_amount` formatted EUR
- **Статус** — Bulgarian label from `statusLabels` map (Чакаща / Оферта / Потвърдена / В обработка / Изпълнена / Анулирана / Фактурирана)
- **Плащане** — `invoices.payment_method` Bulgarian label (В брой / Банков пр. / Налож.пл.) when an invoice is linked, else `—`
- **Фактура** — `invoices.invoice_number` when linked, else `—`. Cancelled invoices appear with strikethrough.

**Cancelled orders** appear in the list with status "Анулирана"; not visually struck-through to keep the table readable, but counted separately in the summary at the bottom.

**Summary directly below the table:**

```
Общо: 15 поръчки     19 750,80 €

Обобщение по статус:
├── Чакаща:      2 бр.      450,00 €
├── Оферта:      3 бр.    8 200,00 €
├── Потвърдена:  5 бр.    6 100,00 €
├── Изпълнена:   4 бр.    4 800,80 €
└── Анулирана:   1 бр.      200,00 €
```

Statuses with zero count for the day are omitted from the summary list (don't print empty rows).

### Раздел 2 — Фактури днес

Aggregation, no per-row table.

```
Активни:    12     9 815,80 €  (нето: 8 179,80 € + ДДС: 1 636,00 €)
Сторнирани:  1        230,00 €
Анулирани:   0          0,00 €
─────────────────────────────────────
По метод на плащане (само активни):
├── В брой:           4 фактури    2 147,40 €
├── Банков превод:    5 фактури    4 244,30 €
├── Наложен платеж:   3 фактури    3 424,10 €
└── Без зададен:      0 фактури        0,00 €
```

Definition of "today's invoice": `DATE(invoices.invoice_date) = $1`. The `Активни` count includes invoices with `status='active'` AND no associated credit note (`credit_note_id IS NULL`). Sum is `total_gross`.

### Раздел 3 — Постъпления днес (real cash inflow)

```
В брой:          3 681,00 €
Банков превод:   6 339,30 €
Наложен платеж:  2 208,80 €
─────────────────
Общо:           12 229,10 €
```

`SELECT payment_method, COUNT(*), SUM(amount) FROM payments WHERE DATE(payment_date) = $1 GROUP BY payment_method`. These payments may correspond to invoices issued on previous days — that's the point of separating Раздел 2 and 3.

### Раздел 4 — Еконт доставки (only if there's at least one)

Skipped entirely from the PDF if the day has zero waybills.

```
Общо товарителници днес: 8
├── Наложен платеж: 5  (сума: 4 320,00 €)
└── Обикновена (Еконт): 3

  №    Партньор             Сума        Тип            Т-ца №
  ────────────────────────────────────────────────────────────────
  102  ВИКИ ВАТ ЕООД      2 863,24 €    Наложен пл.   1055146389563
  103  ЖОКЕР ЕНТ.           229,99 €    Еконт         1055146425704
  ...
```

**Logic:**

- Order is in this section iff `econt_shipment_number IS NOT NULL` AND `DATE(orders.order_date) = $1`.
- Type = "Наложен платеж" if `econt_cod_amount > 0`, else "Еконт".
- Sorted by `order_number` ASC.

### Раздел 5 — Неплатени фактури (snapshot at end of $date)

Top 10 oldest unpaid active invoices, computed AS OF end of `$date` (so historical reports are accurate even after later payments are recorded).

```
Общ остатък: 4 287,50 €  (12 фактури)

Top 10 най-стари:
№         Дата          Партньор             Сума         Платено    Остатък   Дни
──────────────────────────────────────────────────────────────────────────────────
0000000018  15.04.2026  ХОТЕЛ ОМЕГА ЕООД    2 100,00 €     500,00 €  1 600,00 €  15
0000000019  16.04.2026  СПА ЕООД              480,00 €       0,00 €    480,00 €  14
...
```

Query:

```sql
SELECT i.invoice_number, i.invoice_date, p.name AS partner,
       i.total_gross,
       COALESCE(SUM(pmt.amount), 0) AS paid,
       i.total_gross - COALESCE(SUM(pmt.amount), 0) AS remaining
FROM invoices i
LEFT JOIN payments pmt ON pmt.invoice_id = i.id AND DATE(pmt.payment_date) <= $1
LEFT JOIN partners p ON p.id = i.partner_id
WHERE DATE(i.invoice_date) <= $1
  AND i.status = 'active'
  AND i.credit_note_id IS NULL
GROUP BY i.id, p.name
HAVING i.total_gross - COALESCE(SUM(pmt.amount), 0) > 0.01
ORDER BY i.invoice_date ASC
LIMIT 10
```

Plus a separate `SELECT SUM(remaining), COUNT(*)` over the unfiltered set for the "Общ остатък" line.

### Раздел 6 — Top 5 артикула за деня

```
№  Артикул                                          SKU          Кол.    Сума
──────────────────────────────────────────────────────────────────────────────
1  Електрическа машина за пълнене на колбаси        MBG-29013    3        4 049,97 €
2  Wine bottle lantern                              MBG-344      8        2 873,92 €
3  ...
```

By total quantity sold from `order_items` joined to today's non-cancelled orders. SKU and name come from the snapshot columns (`sku_snapshot`, `name_bg_snapshot` from Batch B).

```sql
SELECT
  oi.name_bg_snapshot AS name,
  oi.sku_snapshot AS sku,
  SUM(oi.quantity) AS qty,
  SUM(oi.total_price) AS total
FROM order_items oi
JOIN orders o ON o.id = oi.order_id
WHERE DATE(o.order_date) = $1
  AND o.status NOT IN ('cancelled', 'quoted')
GROUP BY oi.name_bg_snapshot, oi.sku_snapshot
ORDER BY qty DESC
LIMIT 5
```

`quoted` orders excluded — they're offers, not sales.

### Footer

```
Изготвил: ____________________   Подпис: ____________________
```

Auto-page-break if the orders list overflows: header is reprinted on each new page (similar to existing `offer-pdf.ts` pattern, which already handles auto-paging).

## 4. Backend — files and contracts

### New file: `warehouse-backend/src/services/daily-report-pdf.ts`

Mirrors `offer-pdf.ts` structure: pdfkit, Roboto fonts, `formatEurAmount` for amounts.

```typescript
export interface DailyReportData {
  date: string; // ISO yyyy-mm-dd
  generatedBy: string; // email of issuing user
  company: { name: string };
  orders: Array<{
    order_number: number;
    partner_name: string;
    total_amount: number;
    status: string; // raw enum value; PDF maps to Bulgarian
    payment_method: string | null; // null if no invoice
    invoice_number: string | null;
    invoice_status: string | null; // for strikethrough cancelled invoices
  }>;
  ordersSummaryByStatus: Array<{ status: string; count: number; sum: number }>;
  invoices: {
    active: { count: number; net: number; vat: number; gross: number };
    credit_noted: { count: number; sum: number };
    cancelled: { count: number; sum: number };
    byPaymentMethod: Array<{ method: string; count: number; sum: number }>;
  };
  payments: {
    byMethod: Array<{ method: string; count: number; sum: number }>;
    total: number;
  };
  econtShipments: Array<{
    order_number: number;
    partner_name: string;
    total_amount: number;
    type: "cod" | "standard";
    cod_amount: number | null;
    shipment_number: string;
  }>;
  outstanding: {
    totalRemaining: number;
    totalCount: number;
    top10: Array<{
      invoice_number: string;
      invoice_date: string;
      partner_name: string;
      gross: number;
      paid: number;
      remaining: number;
      days_overdue: number;
    }>;
  };
  topProducts: Array<{
    name: string;
    sku: string | null;
    qty: number;
    total: number;
  }>;
  outputPath: string;
}

export async function generateDailyReportPdf(
  data: DailyReportData,
): Promise<void>;
```

### New file: `warehouse-backend/src/routes/reports.ts`

```typescript
const dailyReportQuerySchema = z.object({
  date: z
    .string()
    .regex(/^\d{4}-\d{2}-\d{2}$/, "date must be YYYY-MM-DD")
    .optional()
    .transform((v) => v ?? new Date().toISOString().slice(0, 10)),
});

const reportsViewPreHandler = [
  jwtVerify,
  requirePermission(PERMISSIONS.REPORTS_VIEW),
];

export default async function reportsRoutes(app: FastifyInstance) {
  app.get(
    "/daily-pdf",
    { preHandler: reportsViewPreHandler },
    async (request, reply) => {
      const { date } = dailyReportQuerySchema.parse(request.query);
      // 6 aggregation queries → assemble DailyReportData → generateDailyReportPdf → stream
    },
  );
}
```

Register in `index.ts`: `await app.register(reportsRoutes, { prefix: '/reports' });`

### Permission registry

Add to `warehouse-backend/src/lib/permissions/registry.ts`:

```typescript
REPORTS_VIEW: {
  label: 'Виж отчети',
  description: 'Достъп до Дневен отчет и други management reports',
  category: 'Reports',
},
```

Defaults: `admin` + `accountant` get it; `warehouse` does not.

## 5. Frontend — files and contracts

### Modify: `warehouse-frontend/src/pages/Dashboard.tsx`

Add a button in the top-right action area (next to KPI cards header):

```tsx
<Can permission={PERMISSIONS.REPORTS_VIEW}>
  <Button
    variant="outline"
    onClick={() => setDailyReportOpen(true)}
    title="Дневен отчет (PDF)"
  >
    <Printer className="h-4 w-4" />
    Дневен отчет
  </Button>
</Can>
```

State for the dialog:

```tsx
const [dailyReportOpen, setDailyReportOpen] = useState(false);
const [reportDate, setReportDate] = useState(
  new Date().toISOString().slice(0, 10),
);
```

Dialog body:

```tsx
<Dialog open={dailyReportOpen} onOpenChange={setDailyReportOpen}>
  <DialogContent className="max-w-sm">
    <DialogHeader>
      <DialogTitle>Дневен отчет</DialogTitle>
    </DialogHeader>
    <div className="py-2">
      <Label>За дата</Label>
      <Input
        type="date"
        value={reportDate}
        onChange={(e) => setReportDate(e.target.value)}
        max={new Date().toISOString().slice(0, 10)}
      />
    </div>
    <DialogFooter>
      <Button variant="outline" onClick={() => setDailyReportOpen(false)}>
        Отказ
      </Button>
      <Button onClick={downloadReport}>
        <FileText className="h-4 w-4" />
        Свали PDF
      </Button>
    </DialogFooter>
  </DialogContent>
</Dialog>
```

`downloadReport` uses the authed-blob pattern:

```tsx
const downloadReport = async () => {
  try {
    const res = await api.get(`/reports/daily-pdf?date=${reportDate}`, {
      responseType: "blob",
    });
    const blob = new Blob([res.data], { type: "application/pdf" });
    const url = URL.createObjectURL(blob);
    window.open(url, "_blank");
    setTimeout(() => URL.revokeObjectURL(url), 60000);
    setDailyReportOpen(false);
  } catch (err: any) {
    toast.error(err?.response?.data?.error || "Грешка при сваляне на отчета");
  }
};
```

## 6. Tests

### Backend — `__tests__/reports-daily.test.ts`

1. **happy path** — admin with seed of 2 orders + 1 invoice + 1 payment for the date → 200, `Content-Type: application/pdf`, body length > 1000.
2. **403 without permission** — warehouse role → 403 `Forbidden`.
3. **400 on bad date format** — `?date=2026/04/30` → 400 with `date must be YYYY-MM-DD`.
4. **future date returns 200 with empty sections** — ?date=tomorrow → 200, PDF generated with all sections "0".

Mock `db.js` (`query`) for the 6 aggregation queries.

### Frontend — manual smoke

The dialog open + date input + auth-aware download is the same pattern as offer-pdf and protocol-pdf, both of which already work. No new test infra needed; manual smoke covered in Task 14 of the plan.

## 7. Bug-fix bonus

`warehouse-backend/src/services/offer-pdf.ts` uses `fmtBGN` with " лв." suffix. Bulgaria switched to euro and the rest of the project uses `formatEurAmount`. Fix included in the same PR — replace `fmtBGN` calls with `formatEurAmount`.

## 8. Out of scope

- Weekly/monthly reports — same pattern, separate spec when needed.
- Configurable report sections (user picks what to include) — YAGNI.
- Email-the-report scheduling — YAGNI.
- Multi-currency — the project is single-currency (EUR).
- HTML preview before PDF — accepted brainstorming decision.

## 9. Open questions

None. All decisions taken during brainstorming.
