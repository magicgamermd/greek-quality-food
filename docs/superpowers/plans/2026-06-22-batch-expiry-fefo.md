# Партиди, срокове на годност и FEFO — план за изпълнение

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Пълно партидно проследяване с FEFO изписване, блокиране на изтекли срокове, партида/срок на входа (ръчно + OCR) и на търговския документ — за дистрибутор на храни.

**Architecture:** Наличността става по партида (`inventory.batch_id` винаги non-NULL). Доставката създава партиди; продажбата изписва по FEFO (най-ранен срок първи, изтеклите блокирани) през нов `services/fefo-allocator.ts`, записвайки разпределението в нова таблица `order_item_batches`. Търговският документ чете това разпределение; фактурата и стоковата разписка остават без партида/срок.

**Tech Stack:** Fastify 5 + TypeScript + PostgreSQL (`pg`), Vitest, React 19 + Vite, Python FastAPI (ai-service вече вади партида/срок — без промяна там).

**Spec:** `docs/superpowers/specs/2026-06-22-batch-expiry-fefo-design.md`

---

## File Structure

**Backend (`warehouse-backend/`)**

- `migrations/098_batch_inventory_fefo.sql` — нова: `order_item_batches`, `incoming_items.batch_number/expiry_date`, откриваща партида backfill.
- `migrations/099_users_role_owner_mobile.sql` — нова: роля `owner_mobile`.
- `src/services/fefo-allocator.ts` — нов: FEFO разпределение (чисто, тестваемо).
- `src/services/__tests__/fefo-allocator.test.ts` — нов: unit тестове.
- `src/routes/incoming.ts` — modify: приема + пази + потвърждава партида/срок.
- `src/routes/orders.ts` — modify: FEFO изписване + `order_item_batches` + COGS.
- `src/services/document-pdf.ts` — modify: търговски документ чете партиди от разпределението (рендерът вече има колоните).
- `src/routes/orders.ts` (data loader за документа) — modify: подава allocations.
- `src/routes/notifications.ts` — modify: поправка на expiry JOIN.
- `src/routes/auth.ts` — modify: register enum + `owner_mobile`.
- `src/__tests__/orders-no-batch.test.ts` → преименуван/пренаписан `orders-batch-fefo.test.ts`.

**Frontend (`warehouse-frontend/`)**

- `src/pages/IncomingGoods.tsx` — modify: ръчна форма + scan review: партида/срок.
- `src/pages/owner/OwnerScan.tsx` — modify: scan review: партида/срок.
- `src/pages/Orders.tsx` — modify: избор на партида + FEFO подсказка + блок на изтекли.

**Runtime config (Railway / CF)** — без код: `CORS_ORIGIN`, `AI_SERVICE_URL`.

---

## Phase 0 — Подготовка

### Task 1: Снимка на наличността преди миграция (baseline)

**Files:** няма (psql проверка)

- [ ] **Step 1: Запиши текущите суми (за златна проба след миграцията)**

Run:

```bash
PG=greekquality-postgres-1
docker exec $PG sh -c 'psql -U "$POSTGRES_USER" -d "$POSTGRES_DB" -tA -c "
SELECT '\''inv_total_qty'\'', COALESCE(SUM(quantity),0)::text FROM inventory
UNION ALL SELECT '\''inv_null_batch_rows'\'', count(*)::text FROM inventory WHERE batch_id IS NULL
UNION ALL SELECT '\''batches'\'', count(*)::text FROM batches;"'
```

Expected: записва числата (напр. inv_total_qty=X). Пази X — след миграцията общата сума трябва да е същата.

---

## Phase 1 — Данни (миграция 098)

### Task 2: Миграция 098 — таблици + откриваща партида

**Files:**

- Create: `warehouse-backend/migrations/098_batch_inventory_fefo.sql`

- [ ] **Step 1: Напиши миграцията**

```sql
-- 098_batch_inventory_fefo.sql
-- Партидно проследяване: order_item_batches, batch/expiry на incoming_items,
-- прехвърляне на текущата (NULL-партида) наличност в синтетична откриваща партида.
BEGIN;

-- 1) Разпределение поръчков ред -> партиди (източник за търговския документ + COGS)
CREATE TABLE IF NOT EXISTS order_item_batches (
  id            SERIAL PRIMARY KEY,
  order_item_id INTEGER NOT NULL REFERENCES order_items(id) ON DELETE CASCADE,
  batch_id      INTEGER NOT NULL REFERENCES batches(id) ON DELETE RESTRICT,
  quantity      NUMERIC(12,3) NOT NULL CHECK (quantity > 0),
  unit_cost     DECIMAL(12,4) NOT NULL DEFAULT 0,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_oib_order_item ON order_item_batches(order_item_id);
CREATE INDEX IF NOT EXISTS idx_oib_batch      ON order_item_batches(batch_id);

-- 2) Заснемане на въведени партида/срок на входящия ред (преди confirm)
ALTER TABLE incoming_items ADD COLUMN IF NOT EXISTS batch_number VARCHAR(100);
ALTER TABLE incoming_items ADD COLUMN IF NOT EXISTS expiry_date  DATE;

-- 3) Откриваща партида: прехвърля NULL-партида наличност в партида 'НАЧАЛНО'
DO $$
DECLARE r RECORD; v_batch_id INTEGER;
BEGIN
  FOR r IN SELECT DISTINCT product_id FROM inventory WHERE batch_id IS NULL AND quantity <> 0
  LOOP
    SELECT id INTO v_batch_id FROM batches
      WHERE product_id = r.product_id AND batch_number = 'НАЧАЛНО' LIMIT 1;
    IF v_batch_id IS NULL THEN
      INSERT INTO batches (product_id, batch_number, expiry_date, quantity, purchase_price, received_date, notes)
      SELECT r.product_id, 'НАЧАЛНО', NULL, 0, COALESCE(p.purchase_price, 0), CURRENT_DATE,
             'Откриваща наличност (миграция 098)'
      FROM products p WHERE p.id = r.product_id
      RETURNING id INTO v_batch_id;
    END IF;
    -- прехвърля всички NULL-партида редове на продукта (всички складове) към откриващата
    UPDATE inventory SET batch_id = v_batch_id, updated_at = NOW()
      WHERE product_id = r.product_id AND batch_id IS NULL;
    -- съгласува batches.quantity = сума на наличността по тази партида
    UPDATE batches SET quantity = (
      SELECT COALESCE(SUM(quantity), 0) FROM inventory WHERE batch_id = v_batch_id
    ), updated_at = NOW() WHERE id = v_batch_id;
  END LOOP;
END $$;

-- 4) Изчиства нулеви NULL-партида редове
DELETE FROM inventory WHERE batch_id IS NULL AND quantity = 0;

COMMIT;
```

- [ ] **Step 2: Приложи миграцията локално**

Run:

```bash
cd /Users/magic/Projects/greek-quality-food/warehouse-backend
PG=greekquality-postgres-1
docker exec -i $PG sh -c 'psql -U "$POSTGRES_USER" -d "$POSTGRES_DB"' < migrations/098_batch_inventory_fefo.sql
```

Expected: `BEGIN … COMMIT`, без грешки.

- [ ] **Step 3: Златна проба — сумите са запазени, няма NULL-партида**

Run:

```bash
docker exec $PG sh -c 'psql -U "$POSTGRES_USER" -d "$POSTGRES_DB" -tA -c "
SELECT '\''inv_total_qty'\'', COALESCE(SUM(quantity),0)::text FROM inventory
UNION ALL SELECT '\''inv_null_batch'\'', count(*)::text FROM inventory WHERE batch_id IS NULL
UNION ALL SELECT '\''opening_batches'\'', count(*)::text FROM batches WHERE batch_number='\''НАЧАЛНО'\'';"'
```

Expected: `inv_total_qty` == baseline от Task 1; `inv_null_batch` = 0.

- [ ] **Step 4: Commit**

```bash
git add migrations/098_batch_inventory_fefo.sql
git commit -m "feat(gqf): миграция 098 — order_item_batches + откриваща партида"
```

---

## Phase 2 — FEFO allocator (TDD ядро)

### Task 3: `fefo-allocator.ts` + unit тестове

**Files:**

- Create: `warehouse-backend/src/services/fefo-allocator.ts`
- Test: `warehouse-backend/src/services/__tests__/fefo-allocator.test.ts`

- [ ] **Step 1: Напиши падащите тестове**

```ts
// src/services/__tests__/fefo-allocator.test.ts
import { describe, it, expect } from "vitest";
import { allocateFefo, InsufficientStockError } from "../fefo-allocator";

// Фалшив pg client: връща подадените редове на първата заявка.
const mkClient = (rows: any[]) => ({ query: async () => ({ rows }) }) as any;
const TODAY = "2026-06-22";

describe("allocateFefo", () => {
  it("разпределя най-ранния срок първи", async () => {
    const client = mkClient([
      {
        batch_id: 2,
        batch_number: "B2",
        expiry_date: "2026-08-01",
        purchase_price: "1.00",
        available: "10",
      },
      {
        batch_id: 1,
        batch_number: "B1",
        expiry_date: "2026-07-01",
        purchase_price: "1.00",
        available: "10",
      },
    ]);
    // редовете идват сортирани от SQL; тук подаваме вече сортирани (B1 преди B2)
    const sorted = mkClient([
      {
        batch_id: 1,
        batch_number: "B1",
        expiry_date: "2026-07-01",
        purchase_price: "1.00",
        available: "10",
      },
      {
        batch_id: 2,
        batch_number: "B2",
        expiry_date: "2026-08-01",
        purchase_price: "1.00",
        available: "10",
      },
    ]);
    const res = await allocateFefo(sorted, 1, 1, 5, { today: TODAY });
    expect(res.allocations).toEqual([
      {
        batch_id: 1,
        batch_number: "B1",
        expiry_date: "2026-07-01",
        quantity: 5,
        unit_cost: 1,
      },
    ]);
  });

  it("разделя линия по няколко партиди", async () => {
    const client = mkClient([
      {
        batch_id: 1,
        batch_number: "B1",
        expiry_date: "2026-07-01",
        purchase_price: "1.00",
        available: "3",
      },
      {
        batch_id: 2,
        batch_number: "B2",
        expiry_date: "2026-08-01",
        purchase_price: "2.00",
        available: "10",
      },
    ]);
    const res = await allocateFefo(client, 1, 1, 5, { today: TODAY });
    expect(res.allocations).toEqual([
      {
        batch_id: 1,
        batch_number: "B1",
        expiry_date: "2026-07-01",
        quantity: 3,
        unit_cost: 1,
      },
      {
        batch_id: 2,
        batch_number: "B2",
        expiry_date: "2026-08-01",
        quantity: 2,
        unit_cost: 2,
      },
    ]);
  });

  it("пропуска изтекли партиди и хвърля при недостиг", async () => {
    const client = mkClient([
      {
        batch_id: 1,
        batch_number: "OLD",
        expiry_date: "2026-01-01",
        purchase_price: "1.00",
        available: "100",
      },
    ]);
    await expect(
      allocateFefo(client, 1, 1, 5, { today: TODAY }),
    ).rejects.toBeInstanceOf(InsufficientStockError);
  });

  it("откриваща партида (без срок) се ползва последна", async () => {
    const client = mkClient([
      {
        batch_id: 9,
        batch_number: "НАЧАЛНО",
        expiry_date: null,
        purchase_price: "1.00",
        available: "100",
      },
      {
        batch_id: 1,
        batch_number: "B1",
        expiry_date: "2026-07-01",
        purchase_price: "1.50",
        available: "2",
      },
    ]);
    // SQL ги връща с NULLS LAST -> подаваме B1 преди НАЧАЛНО
    const sorted = mkClient([
      {
        batch_id: 1,
        batch_number: "B1",
        expiry_date: "2026-07-01",
        purchase_price: "1.50",
        available: "2",
      },
      {
        batch_id: 9,
        batch_number: "НАЧАЛНО",
        expiry_date: null,
        purchase_price: "1.00",
        available: "100",
      },
    ]);
    const res = await allocateFefo(sorted, 1, 1, 5, { today: TODAY });
    expect(res.allocations.map((a) => a.batch_id)).toEqual([1, 9]);
    expect(res.allocations[1].quantity).toBe(3);
  });

  it("предупреждава за изтичащи под прага", async () => {
    const client = mkClient([
      {
        batch_id: 1,
        batch_number: "SOON",
        expiry_date: "2026-07-05",
        purchase_price: "1.00",
        available: "10",
      },
    ]);
    const res = await allocateFefo(client, 1, 1, 1, {
      today: TODAY,
      warnDays: 30,
    });
    expect(res.warnings.length).toBe(1);
  });
});
```

- [ ] **Step 2: Пусни тестовете — трябва да паднат**

Run: `cd warehouse-backend && npx vitest run src/services/__tests__/fefo-allocator.test.ts`
Expected: FAIL — `Cannot find module '../fefo-allocator'`.

- [ ] **Step 3: Имплементирай allocator-а**

```ts
// src/services/fefo-allocator.ts
// FEFO (First-Expired-First-Out) разпределение на наличност по партиди.
// Чисто: получава pg client, не знае за HTTP. Изтеклите партиди се пропускат.
import type { PoolClient } from "pg";

export interface BatchAllocation {
  batch_id: number;
  batch_number: string | null;
  expiry_date: string | null;
  quantity: number;
  unit_cost: number;
}
export interface FefoOptions {
  today?: string; // ISO дата; по подразбиране днес (за тестваемост)
  warnDays?: number; // праг за предупреждение за изтичащи (дни)
  allowExpired?: boolean; // по подразбиране false -> блокира изтекли
}
export interface FefoResult {
  allocations: BatchAllocation[];
  warnings: string[];
}

export class InsufficientStockError extends Error {
  constructor(
    public productId: number,
    public requested: number,
    public available: number,
  ) {
    super(
      `Недостатъчна неизтекла наличност за продукт ${productId}: искани ${requested}, налични ${available}`,
    );
    this.name = "InsufficientStockError";
  }
}

const toNum = (v: unknown) =>
  v == null ? 0 : typeof v === "number" ? v : parseFloat(String(v));
const todayISO = (opts: FefoOptions) =>
  opts.today ?? new Date().toISOString().slice(0, 10);

export async function allocateFefo(
  client: Pick<PoolClient, "query">,
  productId: number,
  warehouseId: number,
  quantity: number,
  opts: FefoOptions = {},
): Promise<FefoResult> {
  const today = todayISO(opts);
  const warnDays = opts.warnDays ?? 30;
  // Заключва наличните редове за продукта (FOR UPDATE) подредени по срок (NULLS LAST).
  const { rows } = await client.query(
    `SELECT i.batch_id, b.batch_number, b.expiry_date, b.purchase_price, i.quantity AS available
       FROM inventory i
       JOIN batches b ON b.id = i.batch_id
      WHERE i.product_id = $1 AND i.warehouse_id = $2 AND i.quantity > 0
      ORDER BY b.expiry_date ASC NULLS LAST, b.id ASC
      FOR UPDATE`,
    [productId, warehouseId],
  );

  const allocations: BatchAllocation[] = [];
  const warnings: string[] = [];
  let remaining = quantity;
  let availableNonExpired = 0;

  for (const row of rows) {
    const expiry = row.expiry_date
      ? String(row.expiry_date).slice(0, 10)
      : null;
    const isExpired = expiry != null && expiry < today;
    if (isExpired && !opts.allowExpired) continue;
    const available = toNum(row.available);
    availableNonExpired += available;
    if (remaining <= 0) continue;
    const take = Math.min(remaining, available);
    if (take <= 0) continue;
    const unitCost = toNum(row.purchase_price);
    allocations.push({
      batch_id: row.batch_id,
      batch_number: row.batch_number ?? null,
      expiry_date: expiry,
      quantity: take,
      unit_cost: unitCost,
    });
    if (expiry != null) {
      const warnBefore = new Date(today);
      warnBefore.setDate(warnBefore.getDate() + warnDays);
      if (expiry <= warnBefore.toISOString().slice(0, 10)) {
        warnings.push(
          `Партида ${row.batch_number ?? row.batch_id} изтича на ${expiry}`,
        );
      }
    }
    remaining -= take;
  }

  if (remaining > 0) {
    throw new InsufficientStockError(productId, quantity, availableNonExpired);
  }
  return { allocations, warnings };
}
```

- [ ] **Step 4: Пусни тестовете — трябва да минат**

Run: `npx vitest run src/services/__tests__/fefo-allocator.test.ts`
Expected: PASS (5 теста).

- [ ] **Step 5: Commit**

```bash
git add src/services/fefo-allocator.ts src/services/__tests__/fefo-allocator.test.ts
git commit -m "feat(gqf): FEFO allocator с unit тестове"
```

---

## Phase 3 — Backend входяща доставка

### Task 4: `/incoming` приема и пази партида/срок

**Files:**

- Modify: `warehouse-backend/src/routes/incoming.ts` (схема ~54-72; line INSERT ~1480-1494)

- [ ] **Step 1: Разшири per-line Zod схемата**

В `createIncomingSchema` per-line обекта (около ред 54-72) махни коментара „silently ignored" и добави:

```ts
batch_number: z.string().trim().max(100).optional().nullable(),
expiry_date: z.string().trim().optional().nullable(), // ISO YYYY-MM-DD
```

- [ ] **Step 2: Запиши ги в `incoming_items`**

В `INSERT INTO incoming_items (...)` (около 1480-1494) добави колоните `batch_number, expiry_date` и съответните стойности от реда (`item.batch_number ?? null`, `item.expiry_date ?? null`). Махни коментара „no batch/expiry tracking".

- [ ] **Step 3: tsc**

Run: `cd warehouse-backend && npx tsc --noEmit`
Expected: без грешки.

- [ ] **Step 4: Commit**

```bash
git add src/routes/incoming.ts
git commit -m "feat(gqf): incoming приема и пази партида/срок на реда"
```

### Task 5: `PUT /incoming/:id/confirm` създава партиди + наличност по партида

**Files:**

- Modify: `warehouse-backend/src/routes/incoming.ts` (confirm ~2047; inventory upsert ~2099-2105)

- [ ] **Step 1: Find-or-create партида на ред + наличност по партида**

В confirm цикъла, преди наличностния upsert, за всеки ред резолвни партида:

```ts
// Резолюция/създаване на партида за реда (по продукт + номер).
let batchId: number;
const bNum = (item.batch_number ?? "").trim() || null;
const exp = (item.expiry_date ?? "").trim() || null;
const found = bNum
  ? await client.query(
      `SELECT id FROM batches WHERE product_id=$1 AND batch_number=$2 LIMIT 1`,
      [productId, bNum],
    )
  : { rows: [] as any[] };
if (found.rows.length) {
  batchId = found.rows[0].id;
  await client.query(
    `UPDATE batches SET expiry_date=COALESCE($2, expiry_date), purchase_price=$3,
            delivery_id=$4, quantity=quantity+$5, updated_at=NOW() WHERE id=$1`,
    [batchId, exp, unitPrice, incomingId, qty],
  );
} else {
  const ins = await client.query(
    `INSERT INTO batches (product_id, batch_number, expiry_date, quantity, purchase_price, delivery_id, received_date)
     VALUES ($1,$2,$3,$4,$5,$6,CURRENT_DATE) RETURNING id`,
    [
      productId,
      bNum ?? `АВТО-${incomingId}-${productId}`,
      exp,
      qty,
      unitPrice,
      incomingId,
    ],
  );
  batchId = ins.rows[0].id;
}
```

- [ ] **Step 2: Смени наличностния upsert на по-партида (поправя счупения ON CONFLICT)**

Замени upsert-а (около 2099-2105) с:

```ts
await client.query(
  `INSERT INTO inventory (product_id, warehouse_id, batch_id, quantity, updated_at)
   VALUES ($1,$2,$3,$4,NOW())
   ON CONFLICT (product_id, batch_id, warehouse_id)
   DO UPDATE SET quantity = inventory.quantity + EXCLUDED.quantity, updated_at = NOW()`,
  [productId, warehouseId, batchId, qty],
);
```

(Също сетни `incoming_items.batch_id = batchId` за реда.)

- [ ] **Step 3: tsc + ръчна проверка**

Run: `npx tsc --noEmit`
Expected: без грешки. После (ръчно по-късно в Phase 8) доставка с партида → партида създадена + наличност по партида.

- [ ] **Step 4: Commit**

```bash
git add src/routes/incoming.ts
git commit -m "feat(gqf): confirm създава партиди + наличност по партида (поправя ON CONFLICT)"
```

---

## Phase 4 — Backend поръчки (FEFO изписване)

### Task 6: FEFO изписване + `order_item_batches` + COGS

**Files:**

- Modify: `warehouse-backend/src/routes/orders.ts` (orderItemSchema ~105-120; `deductProductStock` ~3079-3139; INSERT-и ~1297-1314, 1656-1671, 1995-1999)

- [ ] **Step 1: Разреши ръчен `batch_id` в схемата**

В `orderItemSchema` (105-120) добави `batch_id: z.number().int().positive().optional()`.

- [ ] **Step 2: Партидно изписване вместо `deductProductStock`**

Добави помощник, който при изписване ползва `allocateFefo` (или ръчната партида), пише по партида и записва разпределението:

```ts
import { allocateFefo } from "../services/fefo-allocator";

// Изписва qty за поръчков ред: FEFO (или ръчна партида), пише order_item_batches, връща COGS.
async function deductBatched(
  client: PoolClient,
  orderItemId: number,
  productId: number,
  warehouseId: number,
  qty: number,
  manualBatchId?: number,
): Promise<{ cost: number; warnings: string[] }> {
  let allocations;
  let warnings: string[] = [];
  if (manualBatchId) {
    const r = await client.query(
      `SELECT i.batch_id, b.batch_number, b.expiry_date, b.purchase_price, i.quantity AS available
         FROM inventory i JOIN batches b ON b.id=i.batch_id
        WHERE i.product_id=$1 AND i.warehouse_id=$2 AND i.batch_id=$3 FOR UPDATE`,
      [productId, warehouseId, manualBatchId],
    );
    const row = r.rows[0];
    const today = new Date().toISOString().slice(0, 10);
    if (!row) throw new Error(`Няма наличност за партида ${manualBatchId}`);
    if (row.expiry_date && String(row.expiry_date).slice(0, 10) < today)
      throw new Error(
        `Партида ${row.batch_number ?? manualBatchId} е с изтекъл срок`,
      );
    if (parseFloat(row.available) < qty)
      throw new Error(`Недостатъчна наличност за партида ${manualBatchId}`);
    allocations = [
      {
        batch_id: manualBatchId,
        batch_number: row.batch_number,
        expiry_date: row.expiry_date,
        quantity: qty,
        unit_cost: parseFloat(row.purchase_price ?? "0"),
      },
    ];
  } else {
    const res = await allocateFefo(client, productId, warehouseId, qty, {
      warnDays: 30,
    });
    allocations = res.allocations;
    warnings = res.warnings;
  }
  let cost = 0;
  for (const a of allocations) {
    await client.query(
      `UPDATE inventory SET quantity = quantity - $1, updated_at=NOW()
        WHERE product_id=$2 AND warehouse_id=$3 AND batch_id=$4`,
      [a.quantity, productId, warehouseId, a.batch_id],
    );
    await client.query(
      `UPDATE batches SET quantity = quantity - $1, updated_at=NOW() WHERE id=$2`,
      [a.quantity, a.batch_id],
    );
    await client.query(
      `INSERT INTO order_item_batches (order_item_id, batch_id, quantity, unit_cost) VALUES ($1,$2,$3,$4)`,
      [orderItemId, a.batch_id, a.quantity, a.unit_cost],
    );
    cost += a.quantity * a.unit_cost;
  }
  return { cost, warnings };
}
```

- [ ] **Step 3: Извикай `deductBatched` от fulfill + сетни order_items.batch_id/COGS**

В fulfill цикъла (около 2266-2311) замени `deductProductStock(...)` с `deductBatched(...)` (подавай `order_item_id`, `item.batch_id`). След разпределението: `UPDATE order_items SET batch_id=(първата партида), cost_unit_price=(cost/qty), cost_source_batch_id=(първата) WHERE id=$orderItemId`. Натрупвай `warnings` за отговора.

- [ ] **Step 4: tsc**

Run: `npx tsc --noEmit`
Expected: без грешки.

- [ ] **Step 5: Commit**

```bash
git add src/routes/orders.ts
git commit -m "feat(gqf): FEFO изписване по партида + order_item_batches + COGS"
```

### Task 7: Пренапиши контрактния тест

**Files:**

- Delete/Rename: `warehouse-backend/src/__tests__/orders-no-batch.test.ts`
- Create: `warehouse-backend/src/__tests__/orders-batch-fefo.test.ts`

- [ ] **Step 1: Замени теста с партиден контракт**

Махни стария „batch-free" тест. Новият проверява: order item получава `batch_id` след fulfill; в `order_item_batches` има ред със сума = количеството; COGS = сума(qty×unit_cost). (Следвай съществуващия стил на теста — същия test harness/mock.)

- [ ] **Step 2: Пусни — трябва да мине**

Run: `npx vitest run src/__tests__/orders-batch-fefo.test.ts`
Expected: PASS.

- [ ] **Step 3: Commit**

```bash
git add src/__tests__/orders-batch-fefo.test.ts && git rm src/__tests__/orders-no-batch.test.ts
git commit -m "test(gqf): партиден/FEFO контракт вместо batch-free"
```

---

## Phase 5 — Документи

### Task 8: Търговският документ чете партиди от разпределението

**Files:**

- Modify: `warehouse-backend/src/routes/orders.ts` (data loader за документа; detail JOIN ~3423-3436)
- Verify: `warehouse-backend/src/services/document-pdf.ts` (търговски документ ~1558+; рендерът вече печата batch_number/expiry — ред 1633-1634)

- [ ] **Step 1: Подай партидни под-редове към търговския документ**

Където се зареждат редовете за търговския документ, вместо празния JOIN по `order_items.batch_id`, чети от `order_item_batches`:

```sql
SELECT oi.id AS order_item_id, oi.product_id, oi.quantity, oi.unit_price,
       oib.quantity AS batch_qty, b.batch_number, b.expiry_date
  FROM order_items oi
  JOIN order_item_batches oib ON oib.order_item_id = oi.id
  JOIN batches b ON b.id = oib.batch_id
 WHERE oi.order_id = $1
 ORDER BY oi.id, b.expiry_date ASC NULLS LAST
```

Мапни всеки ред към елемент с `batch_number` + `expiry_date` (рендерът ги печата). Линия, разделена по 2 партиди → 2 реда.

- [ ] **Step 2: Потвърди, че фактурата и разписката НЕ показват партида/срок**

Прегледай `invoice-pdf.ts` и razpiska рендера — да няма batch/expiry колони. (Не променяй фактурата.)

- [ ] **Step 3: tsc + Commit**

```bash
npx tsc --noEmit
git add src/routes/orders.ts
git commit -m "feat(gqf): търговски документ показва реални партиди/срокове от разпределението"
```

---

## Phase 6 — Срокове / брак (изнасяне)

### Task 9: Поправи expiry нотификацията + табло изтичащи/изтекли

**Files:**

- Modify: `warehouse-backend/src/routes/notifications.ts` (JOIN ~45)

- [ ] **Step 1: Поправи JOIN-а да работи с наличност по партида**

`notifications.ts:45` JOIN-ва `inventory i ON i.batch_id=b.id` — вече коректно, защото наличността е по партида. Увери се, че филтрира `b.quantity>0` и `b.expiry_date` в прозорец (напр. `<= today + 30`). Тествай заявката ръчно с psql.

- [ ] **Step 2: Commit**

```bash
git add src/routes/notifications.ts
git commit -m "fix(gqf): expiry нотификация работи с наличност по партида"
```

---

## Phase 7 — Спешни поправки в продукция

### Task 10: Роля `owner_mobile`

**Files:**

- Create: `warehouse-backend/migrations/099_users_role_owner_mobile.sql`
- Modify: `warehouse-backend/src/routes/auth.ts` (register enum ~27)

- [ ] **Step 1: Миграция за CHECK-а**

```sql
-- 099_users_role_owner_mobile.sql
ALTER TABLE users DROP CONSTRAINT IF EXISTS users_role_check;
ALTER TABLE users ADD CONSTRAINT users_role_check
  CHECK (role IN ('admin','warehouse','accountant','sales','econt','owner_mobile'));
```

- [ ] **Step 2: Добави към register enum в `auth.ts`**

`z.enum([...,"owner_mobile"])` (ред ~27).

- [ ] **Step 3: Приложи локално + tsc + Commit**

```bash
docker exec -i greekquality-postgres-1 sh -c 'psql -U "$POSTGRES_USER" -d "$POSTGRES_DB"' < migrations/099_users_role_owner_mobile.sql
npx tsc --noEmit
git add migrations/099_users_role_owner_mobile.sql src/routes/auth.ts
git commit -m "feat(gqf): роля owner_mobile (owner PWA вход)"
```

> CORS (`CORS_ORIGIN` ⊇ `https://gqf-warehouse.pages.dev`) и `AI_SERVICE_URL` са Railway env промени — в Phase 8 (deploy), не код.

---

## Phase 8 — Frontend

### Task 11: Ръчна доставка — полета партида/срок

**Files:**

- Modify: `warehouse-frontend/src/pages/IncomingGoods.tsx` (manualItems state ~243-261; редове ~2170-2387; payload ~1319-1360)

- [ ] **Step 1: Добави към реда state-а**

В default реда (`manualItems`) добави `batch_number: ""`, `expiry_date: ""`.

- [ ] **Step 2: Добави два input-а на реда**

В item-row грида (2170-2387) добави колони **„Партида"** (text → `batch_number`) и **„Срок на годност"** (date → `expiry_date`), по образеца на съседните полета (Кол-во/Ед. цена).

- [ ] **Step 3: Включи ги в payload-а**

В `manualCreateMutation` (1319-1360) добави `batch_number` и `expiry_date` към всеки item.

- [ ] **Step 4: vite build + Commit**

```bash
cd warehouse-frontend && npx vite build
git add src/pages/IncomingGoods.tsx
git commit -m "feat(gqf): ръчна доставка с партида и срок на годност"
```

### Task 12: Scan review (desktop + owner) — партида/срок

**Files:**

- Modify: `warehouse-frontend/src/pages/IncomingGoods.tsx` (scan review ~2598-2855; confirmMutation ~1070-1128)
- Modify: `warehouse-frontend/src/pages/owner/OwnerScan.tsx` (ScannedItem ~21-45; map ~151-158; save ~236-303; review ~519-733)

- [ ] **Step 1: Разшири типа на сканирания ред**

В `ScannedItem` (OwnerScan.tsx 21-45) добави `batch_number?: string; expiry_date?: string;`. В мапинга от scan резултата (151-158) попълни ги от `batch_number_raw`/`expiry_date_raw`.

- [ ] **Step 2: Покажи редактируеми полета + маркер за липсващи**

В review редовете (OwnerScan 519-733; IncomingGoods 2598-2855) добави инпути „Партида"/„Срок"; ако липсват (от OCR `missing_*`) — оцвети.

- [ ] **Step 3: Включи в save payload-а**

OwnerScan save (236-303) и IncomingGoods confirmMutation (1070-1128): добави `batch_number`/`expiry_date` към items.

- [ ] **Step 4: vite build + Commit**

```bash
npx vite build
git add src/pages/IncomingGoods.tsx src/pages/owner/OwnerScan.tsx
git commit -m "feat(gqf): сканиране показва/записва партида и срок"
```

### Task 13: Поръчки — избор на партида + FEFO + блок на изтекли

**Files:**

- Modify: `warehouse-frontend/src/pages/Orders.tsx` (OrderItemRow ~228-255; handleProductSelect ~3983-4018; колони ~4473-4496; submit ~5587-5596)

- [ ] **Step 1: При избор на продукт зареди наличните партиди**

В `handleProductSelect` (3983-4018) извикай `GET /batches?product_id=X` (използвай React Query), пази ги; по подразбиране сетни `batch_id` на най-ранния неизтекъл (FEFO подсказка), `expiry_date` от нея.

- [ ] **Step 2: Замени фалшивата „Партида" клетка с падащо меню**

В клетката (4473-4496 и edit drawer 6368-6386) сложи `<select>` с наличните партиди (номер · срок · кол-во); изтекли = disabled (червено); изтичащи <30 дни = жълто. „Годност" клетката показва срока на избраната партида.

- [ ] **Step 3: Блокирай submit при изтекла/без избор**

Преди submit (около 5587-5596) валидирай: ако продукт има партиди, но избраната е изтекла или липсва → грешка. Подавай `batch_id` (вече истински).

- [ ] **Step 4: vite build + Commit**

```bash
npx vite build
git add src/pages/Orders.tsx
git commit -m "feat(gqf): поръчки с избор на партида, FEFO подсказка и блок на изтекли"
```

---

## Phase 9 — Регресия и изкарване

### Task 14: Пълна регресия

- [ ] **Step 1: Backend — типове, тестове, билд**

Run:

```bash
cd warehouse-backend && npx tsc --noEmit && npx vitest run && npm run build
```

Expected: всичко зелено.

- [ ] **Step 2: Frontend — билд**

Run: `cd warehouse-frontend && npx vite build`
Expected: успех.

- [ ] **Step 3: Жива проверка локално (backend :3005, frontend :5175)**

Ръчно: вход; ръчна доставка с партида/срок → партида създадена; поръчка → FEFO избира най-ранен срок; търговски документ показва партида/срок; фактура чиста; изтекла партида блокирана.

### Task 15: Изкарване в продукция

- [ ] **Step 1: Бекъп на прод БД** (преди миграции)

```bash
# pg_dump на gqf Railway Postgres (docker postgres:18 за версия 18.3)
```

- [ ] **Step 2: Merge към main + push (backend + ai-service auto-deploy)**

```bash
git checkout main && git merge --no-ff feat/GQF-batch-expiry-fefo && git push origin main
```

Миграции 098/099 текат при старт на backend — следи лога.

- [ ] **Step 3: Railway env**

Сетни на backend сервиза: `AI_SERVICE_URL` = вътрешния URL на ai-service; `CORS_ORIGIN` ⊇ `https://gqf-warehouse.pages.dev`. Redeploy.

- [ ] **Step 4: Frontend → CF Pages**

```bash
cd warehouse-frontend && npx vite build && npx wrangler pages deploy dist --project-name=gqf-warehouse --commit-dirty=true
```

- [ ] **Step 5: Smoke в прод**

Вход (admin + owner), сканиране връща редове, доставка с партида, поръчка с FEFO, търговски документ с партида/срок, фактура чиста.

---

## Self-Review (попълва се от автора на плана)

- **Spec coverage:** §3 модел → Task 2; §4 доставка → Task 4-5, 11-12; §5 поръчки/FEFO → Task 3, 6-7; §6 документи → Task 8; §7 прод → Task 10 + Task 15; §8 тестове → Task 3,7,14; §9 изкарване → Task 15. ✓
- **Placeholder scan:** ядрото (миграция, allocator, confirm, deduct) има пълен код; UI задачите сочат точни редове + конкретни полета. ✓
- **Type consistency:** `allocateFefo(client, productId, warehouseId, quantity, opts)` + `BatchAllocation{batch_id,batch_number,expiry_date,quantity,unit_cost}` ползвани еднакво в Task 3 и Task 6. ✓
