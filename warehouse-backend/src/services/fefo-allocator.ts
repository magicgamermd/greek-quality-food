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
  // По подразбиране false -> при недостиг хвърля InsufficientStockError.
  // Когато е true -> връща частичните allocations + shortfall (back-order
  // за вече платени поръчки). Не отслабва проверката за изтекли срокове
  // (allowShortfall ≠ allowExpired — изтеклите остават пропуснати).
  allowShortfall?: boolean;
}

export interface FefoResult {
  allocations: BatchAllocation[];
  warnings: string[];
  // Непокрито количество от неизтекли партиди. 0 при пълно покритие.
  // Различно от 0 само когато allowShortfall=true (иначе се хвърля грешка).
  shortfall: number;
}

export class InsufficientStockError extends Error {
  constructor(
    public productId: number,
    public requested: number,
    public available: number,
    // Изтекла наличност (ако има) — за да е ясно, че стоката не липсва,
    // а е с изтекъл срок (прод: „налични 0" при 12 изтекли бр. мляко).
    public expiredQuantity = 0,
    public latestExpiredDate: string | null = null,
  ) {
    super(
      `Недостатъчна неизтекла наличност за продукт ${productId}: искани ${requested}, налични ${available}` +
        (expiredQuantity > 0
          ? ` (${expiredQuantity} бр. са с изтекъл срок${
              latestExpiredDate ? `, последен ${latestExpiredDate}` : ""
            })`
          : ""),
    );
    this.name = "InsufficientStockError";
  }
}

const toNum = (v: unknown) =>
  v == null ? 0 : typeof v === "number" ? v : parseFloat(String(v));

// PostgreSQL DATE стига до node-postgres като JS Date (на локална
// полунощ). Нормализираме по ЛОКАЛНИ компоненти до 'YYYY-MM-DD' —
// String(date).slice(0,10) даваше "Tue Mar 31": грешни срокове по
// документите (FEFO preview на търговския документ) И счупено сравнение
// за изтекли партиди (буква > цифра → нищо не се брои за изтекло).
const normalizeExpiry = (v: unknown): string | null => {
  if (v == null) return null;
  if (v instanceof Date) {
    const year = v.getFullYear();
    const month = String(v.getMonth() + 1).padStart(2, "0");
    const day = String(v.getDate()).padStart(2, "0");
    return `${year}-${month}-${day}`;
  }
  const s = String(v).trim();
  return s ? s.slice(0, 10) : null;
};

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
  let expiredQuantity = 0;
  let latestExpiredDate: string | null = null;

  for (const row of rows) {
    const expiry = normalizeExpiry(row.expiry_date);
    const isExpired = expiry != null && expiry < today;
    if (isExpired && !opts.allowExpired) {
      expiredQuantity += toNum(row.available);
      if (latestExpiredDate == null || expiry! > latestExpiredDate) {
        latestExpiredDate = expiry!;
      }
      continue;
    }

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
    // Back-order режим: връщаме частичните allocations + непокрития остатък,
    // вместо да блокираме (за вече платени поръчки).
    if (opts.allowShortfall) {
      return { allocations, warnings, shortfall: remaining };
    }
    throw new InsufficientStockError(
      productId,
      quantity,
      availableNonExpired,
      expiredQuantity,
      latestExpiredDate,
    );
  }
  return { allocations, warnings, shortfall: 0 };
}
