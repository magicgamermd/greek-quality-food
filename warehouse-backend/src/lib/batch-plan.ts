// Разпределение на поръчков ред по партиди, избрано от склада.
//
// Поръчка №363 (17.10.2026): програмата изписа Портокалопита от 00081026
// (08.12), а физически беше дадена 00151226 (15.12) — партидата беше
// дописана на ръка върху търговския документ. Причината: формата
// показваше избор на партида, но при създаване сървърът го изхвърляше и
// при изпълнение пак вземаше най-старата (FEFO).
//
// Сега изборът се пази в order_items.batch_plan (мигр. 107) и се изпълнява
// буквално. Един ред може да е от няколко партиди: 5 кг с 15.12 + 5 кг с
// 08.12. Тук са чистите правила — без база.

import { roundQuantity } from "./line-pricing.js";

export interface BatchPlanEntry {
  batch_id: number;
  quantity: number;
}

/** Обединява повтарящи се партиди, закръгля до 3 знака, маха нулите. */
export function normalizePlan(
  entries: ReadonlyArray<{ batch_id: number; quantity: number }>,
): BatchPlanEntry[] {
  const merged = new Map<number, number>();
  for (const entry of entries) {
    const batchId = Number(entry.batch_id);
    if (!Number.isInteger(batchId) || batchId <= 0) continue;
    merged.set(
      batchId,
      roundQuantity((merged.get(batchId) ?? 0) + Number(entry.quantity)),
    );
  }
  return [...merged.entries()]
    .filter(([, quantity]) => quantity > 0)
    .map(([batch_id, quantity]) => ({ batch_id, quantity }));
}

export function planTotal(plan: ReadonlyArray<BatchPlanEntry>): number {
  return roundQuantity(plan.reduce((sum, entry) => sum + entry.quantity, 0));
}

/** Сумата по партиди равна ли е на количеството на реда (точност 0.001). */
export function planMatchesQuantity(
  plan: ReadonlyArray<BatchPlanEntry>,
  quantity: number,
): boolean {
  return Math.abs(planTotal(plan) - roundQuantity(quantity)) < 0.0005;
}

/**
 * Изтекла ли е партидата към дадена дата (YYYY-MM-DD). Същото правило като
 * FEFO разпределителя: в деня на срока още се продава.
 */
export function isExpiredOn(
  expiryDate: string | null | undefined,
  todayIso: string,
): boolean {
  if (!expiryDate) return false;
  return String(expiryDate).slice(0, 10) < todayIso;
}

/** Днешната дата в София (не UTC) — между 00:00 и 03:00 UTC е вчера. */
export function todayInSofia(now: Date = new Date()): string {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: "Europe/Sofia",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(now);
}

/**
 * Колко от всяка партида вече е изписано по тази поръчка (ключ продукт +
 * партида). При редакция на изпълнена поръчка тази част е „вече продадена“
 * и срокът ѝ не се проверява; всичко над нея е нова продажба.
 */
export type KeptBudget = Map<string, number>;

export const budgetKey = (productId: number, batchId: number) =>
  `${productId}:${batchId}`;

/**
 * Взима от бюджета до `quantity` за партидата и връща колко от реда е
 * НОВО (над вече изписаното) — за тази част срокът се проверява.
 */
export function takeFromBudget(
  budget: KeptBudget | undefined,
  productId: number,
  batchId: number,
  quantity: number,
): number {
  if (!budget) return quantity;
  const key = budgetKey(productId, batchId);
  const available = budget.get(key) ?? 0;
  const kept = Math.min(available, quantity);
  budget.set(key, roundQuantity(available - kept));
  return roundQuantity(quantity - kept);
}
