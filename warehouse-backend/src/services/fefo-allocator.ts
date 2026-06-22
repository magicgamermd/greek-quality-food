// FEFO (First-Expired-First-Out) разпределение на наличност по партиди.
// Чисто: получава pg client, не знае за HTTP. Изтеклите партиди се пропускат
// (освен ако allowExpired). Откриващата партида (без срок) се ползва последна.
import type { PoolClient } from "pg";

export interface BatchAllocation {
  batch_id: number;
  batch_number: string | null;
  expiry_date: string | null;
  quantity: number;
  unit_cost: number;
}

export interface FefoOptions {
  today?: string; // ISO YYYY-MM-DD; по подразбиране днес (за тестваемост)
  warnDays?: number; // праг за предупреждение за изтичащи (дни); по подр. 30
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

// Прибавя дни към ISO дата чрез UTC аритметика (без часовиково изместване).
const addDaysISO = (iso: string, days: number): string => {
  const d = new Date(`${iso}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
};

export async function allocateFefo(
  client: Pick<PoolClient, "query">,
  productId: number,
  warehouseId: number,
  quantity: number,
  opts: FefoOptions = {},
): Promise<FefoResult> {
  const today = todayISO(opts);
  const warnDays = opts.warnDays ?? 30;
  const warnBefore = addDaysISO(today, warnDays);

  // Заключва наличните редове за продукта (FOR UPDATE), подредени по срок (NULLS LAST).
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

    allocations.push({
      batch_id: row.batch_id,
      batch_number: row.batch_number ?? null,
      expiry_date: expiry,
      quantity: take,
      unit_cost: toNum(row.purchase_price),
    });

    if (expiry != null && expiry <= warnBefore) {
      warnings.push(
        `Партида ${row.batch_number ?? row.batch_id} изтича на ${expiry}`,
      );
    }
    remaining -= take;
  }

  if (remaining > 0) {
    throw new InsufficientStockError(productId, quantity, availableNonExpired);
  }
  return { allocations, warnings };
}
