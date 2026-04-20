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
