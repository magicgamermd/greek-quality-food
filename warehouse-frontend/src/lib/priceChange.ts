// Промяна на доставната цена при приемане на стока (искане по Microinvest).
// Собственикът: „Само предупреждение“ — продажните цени се сменят на ръка,
// тук само смятаме и показваме разликата.

/** Разлика под половин цент не е промяна (цените са с до 3 знака). */
export const PRICE_CHANGE_THRESHOLD = 0.005;

export type PriceChangeDirection = "up" | "down";

export interface PriceChange {
  oldPrice: number;
  newPrice: number;
  /** newPrice − oldPrice, закръглено до 3 знака. */
  diff: number;
  /** Промяната в % спрямо старата цена. */
  percent: number;
  direction: PriceChangeDirection;
}

function toPrice(value: unknown): number | null {
  if (value == null || value === "") return null;
  const num =
    typeof value === "number" ? value : Number.parseFloat(String(value));
  return Number.isFinite(num) ? num : null;
}

function round3(value: number): number {
  return Math.round(value * 1000) / 1000;
}

/**
 * Сравнява последната доставна цена на продукта с въведената в доставката.
 * Връща null, когато няма с какво да се сравни (няма стара цена, нова цена
 * още не е въведена, нулеви цени) или разликата е под прага.
 */
export function computePriceChange(
  oldPrice: unknown,
  newPrice: unknown,
): PriceChange | null {
  const prev = toPrice(oldPrice);
  const next = toPrice(newPrice);
  if (prev == null || next == null) return null;
  if (prev <= 0 || next <= 0) return null;
  const diff = round3(next - prev);
  // Сравняваме в цели десети от цента, за да не ни подведе плаващата запетая.
  if (
    Math.round(Math.abs(diff) * 1000) <
    Math.round(PRICE_CHANGE_THRESHOLD * 1000)
  ) {
    return null;
  }
  return {
    oldPrice: prev,
    newPrice: next,
    diff,
    percent: (diff / prev) * 100,
    direction: diff > 0 ? "up" : "down",
  };
}

const PRICE_FORMATTER = new Intl.NumberFormat("bg-BG", {
  minimumFractionDigits: 2,
  maximumFractionDigits: 3,
});

const PERCENT_FORMATTER = new Intl.NumberFormat("bg-BG", {
  minimumFractionDigits: 0,
  maximumFractionDigits: 1,
});

/** „1,60“ — цена без знак за валута, като в Microinvest. */
export function formatPlainPrice(value: number): string {
  return PRICE_FORMATTER.format(value);
}

/** „+9,4 %“ / „−5 %“ (истински знак минус). */
export function formatSignedPercent(percent: number): string {
  const rounded = Math.round(percent * 10) / 10;
  const body = PERCENT_FORMATTER.format(Math.abs(rounded));
  if (rounded === 0) return `${body} %`;
  return `${rounded > 0 ? "+" : "−"}${body} %`;
}

/** „▲ 1,60 → 1,75 (+9,4 %)“ / „▼ 2,00 → 1,90 (−5 %)“. */
export function formatPriceChange(change: PriceChange): string {
  const arrow = change.direction === "up" ? "▲" : "▼";
  return `${arrow} ${formatPlainPrice(change.oldPrice)} → ${formatPlainPrice(
    change.newPrice,
  )} (${formatSignedPercent(change.percent)})`;
}

/**
 * Марж като в таблицата „Продукти“: (продажна − доставна) / доставна × 100.
 * null, когато някоя от цените липсва или е нула.
 */
export function computeMarginPercent(
  sellingPrice: unknown,
  purchasePrice: unknown,
): number | null {
  const selling = toPrice(sellingPrice);
  const purchase = toPrice(purchasePrice);
  if (selling == null || purchase == null) return null;
  if (selling <= 0 || purchase <= 0) return null;
  return ((selling - purchase) / purchase) * 100;
}

/** Ред от доставката с нова доставна цена — за съобщението след запис. */
export interface PriceChangeAlert extends PriceChange {
  productId: number;
  productName: string;
}

export interface PriceChangeCandidate {
  productId: number | null | undefined;
  productName: string;
  oldPrice: unknown;
  newPrice: unknown;
}

/**
 * От редовете на доставката → списък с продукти с нова доставна цена.
 * Един продукт на няколко реда се показва веднъж (с цената от последния
 * ред — тя остава в продукта).
 */
export function collectPriceChangeAlerts(
  rows: PriceChangeCandidate[],
): PriceChangeAlert[] {
  const byProduct = new Map<number, PriceChangeAlert>();
  for (const row of rows) {
    const productId = Number(row.productId);
    if (!row.productId || !Number.isFinite(productId)) continue;
    const change = computePriceChange(row.oldPrice, row.newPrice);
    if (!change) {
      byProduct.delete(productId);
      continue;
    }
    byProduct.delete(productId);
    byProduct.set(productId, {
      ...change,
      productId,
      productName: row.productName,
    });
  }
  return [...byProduct.values()];
}
