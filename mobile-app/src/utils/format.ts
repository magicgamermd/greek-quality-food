const CURRENCY_SYMBOLS: Record<string, string> = {
  EUR: "€",
  BGN: "лв.",
  USD: "$",
};

export function formatCurrency(
  value: number | string | null | undefined,
  currency?: string | null,
): string {
  const num =
    typeof value === "string"
      ? parseFloat(value)
      : typeof value === "number"
        ? value
        : 0;
  const cur = currency || "EUR";
  const symbol = CURRENCY_SYMBOLS[cur] || cur;
  return `${(isNaN(num) ? 0 : num).toFixed(2)} ${symbol}`;
}

const UNIT_MAP: Record<string, string> = {
  kg: "кг",
  g: "г",
  l: "л",
  ml: "мл",
  pcs: "бр.",
  pc: "бр.",
};

export function formatUnit(unit: string | undefined | null): string {
  if (!unit) return "бр.";
  return UNIT_MAP[unit.toLowerCase()] || unit;
}

export function formatQuantity(
  value: number | string | null | undefined,
): string {
  const num =
    typeof value === "string"
      ? parseFloat(value)
      : typeof value === "number"
        ? value
        : 0;
  if (isNaN(num)) return "0";
  return Number.isInteger(num)
    ? String(num)
    : String(parseFloat(num.toFixed(3)));
}

export function formatDate(dateStr: string): string {
  if (!dateStr) return "—";
  const d = new Date(dateStr);
  return d.toLocaleDateString("bg-BG", {
    day: "2-digit",
    month: "2-digit",
    year: "numeric",
  });
}

export function formatDateTime(dateStr: string): string {
  if (!dateStr) return "—";
  const d = new Date(dateStr);
  return d.toLocaleString("bg-BG", {
    day: "2-digit",
    month: "2-digit",
    year: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
}

export function daysUntilExpiry(expiryDate: string): number {
  const now = new Date();
  const exp = new Date(expiryDate);
  const diff = exp.getTime() - now.getTime();
  return Math.ceil(diff / (1000 * 60 * 60 * 24));
}

export function expiryColor(days: number): string {
  if (days <= 0) return "#ef4444";
  if (days <= 7) return "#ef4444";
  if (days <= 30) return "#f59e0b";
  return "#22c55e";
}
