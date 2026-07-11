export const BGN_PER_EUR = 1.95583;

function toNumber(value: number | string): number {
  const parsed = typeof value === "string" ? parseFloat(value) : value;
  return Number.isFinite(parsed) ? parsed : 0;
}

export function normalizeCurrencyCode(
  currency?: string | null,
): "BGN" | "EUR" | null {
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
  value: number | string,
  sourceCurrency?: string | null,
): number {
  const amount = toNumber(value);
  return normalizeCurrencyCode(sourceCurrency) === "BGN"
    ? amount / BGN_PER_EUR
    : amount;
}

// BG-locale formatter: "12 345,67" — space thousands, comma decimal.
// Used ONLY for display (PDFs, email subjects). Do NOT parseFloat this output.
const BG_NUMBER_FORMATTER = new Intl.NumberFormat("bg-BG", {
  minimumFractionDigits: 2,
  maximumFractionDigits: 2,
  useGrouping: true,
});

export function formatEurAmount(
  value: number | string,
  sourceCurrency?: string | null,
): string {
  return BG_NUMBER_FORMATTER.format(toEurAmount(value, sourceCurrency));
}

/** Plain 2-decimal format without grouping — use this if the value will be parsed downstream. */
export function formatEurAmountPlain(
  value: number | string,
  sourceCurrency?: string | null,
): string {
  return toEurAmount(value, sourceCurrency).toFixed(2);
}

// ЕДИНИЧНИ цени (доставни/продажни) са с до 3 знака след запетаята
// (мигр. 101). Показваме минимум 2 ("9,25"), а третият се появява само
// когато го има ("9,253") — така qty × ед.цена съвпада със сумата на
// реда. СУМИТЕ остават на 2-знаковите форматери по-горе.
const BG_UNIT_PRICE_FORMATTER = new Intl.NumberFormat("bg-BG", {
  minimumFractionDigits: 2,
  maximumFractionDigits: 3,
  useGrouping: true,
});

/** BG-locale единична цена: "12 345,25" / "12 345,253". Display only. */
export function formatEurUnitPrice(
  value: number | string,
  sourceCurrency?: string | null,
): string {
  return BG_UNIT_PRICE_FORMATTER.format(toEurAmount(value, sourceCurrency));
}

/** Plain единична цена с точка: "9.25" / "9.253" (за PDF-и с dot стил). */
export function formatUnitPricePlain(
  value: number | string,
  sourceCurrency?: string | null,
): string {
  const eur = toEurAmount(value, sourceCurrency);
  const three = eur.toFixed(3);
  return three.endsWith("0") ? eur.toFixed(2) : three;
}
