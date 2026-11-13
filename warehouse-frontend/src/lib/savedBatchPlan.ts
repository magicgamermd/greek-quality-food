// Записаният избор на партиди на ред от НЕИЗПЪЛНЕНА поръчка.
//
// Поръчка №453 (13.11.2026): стоката е излязла със стоковата разписка, а
// поръчката остава „Потвърдена“. Междувременно друга поръчка изписва същата
// партида. При смяна само на цената формата и сървърът проверяваха наново
// непипнатия избор и отказваха записа.
//
// Правилото: непипнат избор на партиди не се проверява наново — нищо ново
// не се иска от склада. Проверката е при изпълнение.

/** Една част от записаното разпределение: колко от коя партида. */
export interface SavedBatchPart {
  batch_id: number;
  quantity: number;
  batch_number: string | null;
  expiry_date: string | null;
}

/** Ред от формата — само полетата за избора на партиди. */
export interface BatchChoiceRow {
  batch_id: string;
  batch_plan?: ReadonlyArray<{ batch_id: number }>;
  saved_plan?: ReadonlyArray<{ batch_id: number }>;
}

/**
 * Записаното разпределение на реда от GET /orders/:id (`planned_batches`):
 * всички части, и когато партидата е само една. Празно, ако редът е на
 * „Автоматично“.
 */
export function savedPlanOf(item: unknown): SavedBatchPart[] {
  const raw = (item as { planned_batches?: unknown } | null)?.planned_batches;
  if (!Array.isArray(raw)) return [];
  return raw
    .map((entry: Record<string, unknown> | null) => ({
      batch_id: Number(entry?.batch_id),
      quantity: Number(entry?.quantity),
      batch_number:
        entry?.batch_number != null ? String(entry.batch_number) : null,
      expiry_date: entry?.expiry_date
        ? String(entry.expiry_date).slice(0, 10)
        : null,
    }))
    .filter(
      (part) =>
        Number.isInteger(part.batch_id) &&
        part.batch_id > 0 &&
        part.quantity > 0,
    );
}

const sortedIds = (parts: ReadonlyArray<{ batch_id: number }>) =>
  [...new Set(parts.map((part) => Number(part.batch_id)))].sort(
    (left, right) => left - right,
  );

/** Партидите, които редът иска сега: разпределението или единичният избор. */
export function selectedBatchIds(row: BatchChoiceRow): number[] {
  if (row.batch_plan?.length) return sortedIds(row.batch_plan);
  const single = Number(row.batch_id);
  return Number.isInteger(single) && single > 0 ? [single] : [];
}

/**
 * Изборът на партиди същият ли е като записания в поръчката. Смененият
 * продукт идва като нов ред без `saved_plan`, „Автоматично“ няма партиди —
 * и двете са „не“.
 */
export function keepsSavedPlan(row: BatchChoiceRow): boolean {
  if (!row.saved_plan?.length) return false;
  const saved = sortedIds(row.saved_plan);
  const current = selectedBatchIds(row);
  return (
    saved.length === current.length &&
    saved.every((batchId, index) => batchId === current[index])
  );
}

/**
 * Записаната партида, която вече я няма сред наличните (изчерпана е) —
 * менюто я показва, за да се вижда какво реално пази редът.
 */
export function savedPartMissingFrom(
  selectedBatchId: string,
  savedPlan: ReadonlyArray<SavedBatchPart> | undefined,
  availableBatchIds: ReadonlyArray<number>,
): SavedBatchPart | null {
  const batchId = Number(selectedBatchId);
  if (!Number.isInteger(batchId) || batchId <= 0) return null;
  if (availableBatchIds.includes(batchId)) return null;
  return savedPlan?.find((part) => part.batch_id === batchId) ?? null;
}
