export function asNumber(value: unknown): number {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : 0;
}

const BGN_PER_EUR = 1.95583;
const EUR_FORMATTER = new Intl.NumberFormat("bg-BG", {
  style: "currency",
  currency: "EUR",
  minimumFractionDigits: 2,
  maximumFractionDigits: 2,
});

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

function toEurAmount(amount: number, sourceCurrency?: string | null): number {
  const code = normalizeCurrencyCode(sourceCurrency);
  return code === "BGN" ? amount / BGN_PER_EUR : amount;
}

export function formatCurrency(value: unknown, sourceCurrency = "EUR"): string {
  const amount = asNumber(value);
  return EUR_FORMATTER.format(toEurAmount(amount, sourceCurrency));
}

function toIsoDateLocal(value: Date): string {
  const localDate = new Date(
    value.getTime() - value.getTimezoneOffset() * 60000,
  );
  return localDate.toISOString().slice(0, 10);
}

export function formatDate(value?: string): string {
  if (!value) return "-";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return date.toLocaleDateString("bg-BG");
}

export function formatQuantity(value: unknown): string {
  return asNumber(value).toLocaleString("bg-BG", {
    minimumFractionDigits: 0,
    maximumFractionDigits: 3,
  });
}

export function isoDateDaysAgo(daysAgo: number): string {
  const date = new Date();
  date.setDate(date.getDate() - daysAgo);
  return toIsoDateLocal(date);
}

export function isoDateToday(): string {
  return toIsoDateLocal(new Date());
}
