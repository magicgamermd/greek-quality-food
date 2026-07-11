import { type ClassValue, clsx } from "clsx";
import { twMerge } from "tailwind-merge";

const BGN_PER_EUR = 1.95583;
const EUR_FORMATTER = new Intl.NumberFormat("bg-BG", {
  style: "currency",
  currency: "EUR",
  minimumFractionDigits: 2,
  maximumFractionDigits: 2,
});

export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs));
}

function normalizeCurrencyCode(currency?: string | null): "BGN" | "EUR" | null {
  if (!currency) return null;
  const normalized = currency.trim().toUpperCase().replace(/\./g, "");
  if (
    normalized === "BGN" ||
    normalized === "LEV" ||
    normalized === "LEVA" ||
    normalized === "ЛВ"
  ) {
    return "BGN";
  }
  if (
    normalized === "EUR" ||
    normalized === "EURO" ||
    normalized === "EUROS" ||
    normalized === "€"
  ) {
    return "EUR";
  }
  return null;
}

export function toEurAmount(
  amount: number,
  sourceCurrency?: string | null,
): number {
  const code = normalizeCurrencyCode(sourceCurrency);
  return code === "BGN" ? amount / BGN_PER_EUR : amount;
}

export function formatCurrency(
  amount: number | string | null | undefined,
  sourceCurrency?: string | null,
): string {
  const n = typeof amount === "string" ? parseFloat(amount) : Number(amount);
  if (!Number.isFinite(n)) return EUR_FORMATTER.format(0);
  return EUR_FORMATTER.format(toEurAmount(n, sourceCurrency));
}

// ЕДИНИЧНИ цени (доставни/продажни) са с до 3 знака след запетаята
// (мигр. 101). Минимум 2 ("9,25 €"), третият се показва само когато го
// има ("9,253 €") — така qty × ед. цена съвпада със сумата на реда.
// СУМИТЕ остават на formatCurrency (точно 2 знака).
const EUR_UNIT_PRICE_FORMATTER = new Intl.NumberFormat("bg-BG", {
  style: "currency",
  currency: "EUR",
  minimumFractionDigits: 2,
  maximumFractionDigits: 3,
});

export function formatUnitPrice(
  amount: number | string | null | undefined,
  sourceCurrency?: string | null,
): string {
  const n = typeof amount === "string" ? parseFloat(amount) : Number(amount);
  if (!Number.isFinite(n)) return EUR_UNIT_PRICE_FORMATTER.format(0);
  return EUR_UNIT_PRICE_FORMATTER.format(toEurAmount(n, sourceCurrency));
}

/**
 * GQF: orders.total_amount е NET (без ДДС). За UI display на "Общо" —
 * сумата която клиентът трябва да плати — добавяме ДДС (× 1.2).
 *
 * Ползва се навсякъде където показваме order-level total в листа,
 * детайл drawer-а, dashboard, history и т.н. Helper-ът централизира
 * правилото — ако VAT rate се сменя, го променяме само тук.
 */
export function formatOrderTotal(
  netAmount: number | string | null | undefined,
  sourceCurrency?: string | null,
): string {
  const n =
    typeof netAmount === "string" ? parseFloat(netAmount) : Number(netAmount);
  if (!Number.isFinite(n)) return EUR_FORMATTER.format(0);
  return EUR_FORMATTER.format(toEurAmount(n * 1.2, sourceCurrency));
}

export const unitLabels: Record<string, string> = {
  kg: "кг",
  g: "г",
  l: "л",
  ml: "мл",
  pcs: "бр",
  box: "кутия",
  pack: "пакет",
  бр: "бр",
  кг: "кг",
  л: "л",
  мл: "мл",
};

export function formatUnit(unit: string | null | undefined): string {
  if (!unit) return "бр";
  return unitLabels[unit.toLowerCase()] ?? unit;
}

export function formatDate(date: string | Date | null | undefined): string {
  if (!date) return "—";
  const d = new Date(date);
  if (isNaN(d.getTime())) return "—";
  return new Intl.DateTimeFormat("bg-BG", {
    day: "2-digit",
    month: "2-digit",
    year: "numeric",
  }).format(d);
}

export function formatDateTime(date: string | Date): string {
  return new Intl.DateTimeFormat("bg-BG", {
    day: "2-digit",
    month: "2-digit",
    year: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  }).format(new Date(date));
}

export function getApiErrorMessage(error: unknown, fallback: string): string {
  const apiMessage =
    (error as any)?.response?.data?.message ??
    (error as any)?.response?.data?.error ??
    (error as any)?.message;

  return typeof apiMessage === "string" && apiMessage.trim()
    ? apiMessage
    : fallback;
}

export function isoDateToday(): string {
  const now = new Date();
  const localDate = new Date(now.getTime() - now.getTimezoneOffset() * 60000);
  return localDate.toISOString().slice(0, 10);
}

/**
 * Returns the Tailwind classes for displaying an inventory quantity.
 * Red+bold for negative (back-order), gray for zero, amber for
 * low-stock, default dark gray otherwise. Callers that know the
 * product's `low_stock_threshold` should pass it; missing threshold
 * is treated as "not low".
 */
export function stockColorClass(
  qty: number,
  lowStockThreshold?: number | null,
): string {
  if (!Number.isFinite(qty)) return "text-gray-900";
  if (qty < 0) return "text-red-600 font-semibold";
  if (qty === 0) return "text-gray-500";
  if (
    lowStockThreshold != null &&
    lowStockThreshold > 0 &&
    qty <= lowStockThreshold
  ) {
    return "text-amber-600";
  }
  return "text-gray-900";
}
