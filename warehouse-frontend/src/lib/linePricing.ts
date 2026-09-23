// ОГЛЕДАЛО на warehouse-backend/src/lib/line-pricing.ts — същото правило,
// за да показва екранът точно сумите, които сървърът записва. Промяна
// тук = промяна там (и обратно); тестът line-pricing-parity в бекенда
// сверява двата файла.
//
// Единственото правило за цена и стойност на ред (поръчка, фактура,
// кредитно известие, стокова разписка, оферта, протокол, замяна).
//
// Защо съществува: до 23.09.2026 документите печатаха единичната цена като
// `total_price / quantity`. Стойността е закръглена до стотинка, затова
// делението назад не връща въведената цена:
//   6.317 × 2.800 = 17.6876 → 17.69 → 17.69 / 2.800 = 6.31786 → „6.318“
// 124 реда в прода печатаха различна цена от въведената. Паралелно
// стойностите се смятаха с float `toFixed(2)`, който закръгля точната
// половин стотинка НАДОЛУ (1.540 × 19.750 = 30.415 → 30.41 вместо 30.42).
//
// Правилата:
//   • Стойността на ред = ROUND(qty × цена × (1 − отстъпка/100), 2),
//     половин встрани от нулата — точно като Postgres ROUND(numeric).
//   • На документ стойността е ЗАПИСАНАТА total_price — документът никога
//     не преизчислява фактурирана сума.
//   • Показаната цена идва от ЦЕНАТА (и отстъпката), никога от стойността.
//
// Смятаме в цели числа (BigInt) при точността на колоните — количество и
// цена NUMERIC(12,3), отстъпка NUMERIC(5,2), пари NUMERIC(12,2) — за да
// няма двоична грешка при закръгляне.

export type Numeric = number | string | null | undefined;

function toNumber(value: Numeric): number {
  const parsed = typeof value === "string" ? parseFloat(value) : (value ?? 0);
  return Number.isFinite(parsed) ? parsed : 0;
}

/** |value| в цели единици от 10^-decimals, закръглено половин нагоре. */
function toUnits(value: Numeric, decimals: number): bigint {
  // toPrecision(15) маха двоичния шум (30.415 × 100 = 3041.4999999999995),
  // преди Math.round да реши накъде.
  const scaled = Number(
    (Math.abs(toNumber(value)) * 10 ** decimals).toPrecision(15),
  );
  return BigInt(Math.round(scaled));
}

function signOf(value: Numeric): 1 | -1 {
  return toNumber(value) < 0 ? -1 : 1;
}

function fromUnits(units: bigint, decimals: number, sign: 1 | -1): number {
  const result = Number(units) / 10 ** decimals;
  return result === 0 ? 0 : sign * result;
}

export const roundQuantity = (value: Numeric): number =>
  fromUnits(toUnits(value, 3), 3, signOf(value));

export const roundUnitPrice = (value: Numeric): number =>
  fromUnits(toUnits(value, 3), 3, signOf(value));

export const roundMoney = (value: Numeric): number =>
  fromUnits(toUnits(value, 2), 2, signOf(value));

export function roundDiscountPercent(value: Numeric): number {
  const rounded = fromUnits(toUnits(value, 2), 2, signOf(value));
  return Math.min(100, Math.max(0, rounded));
}

export interface LineTotalOptions {
  /**
   * Колко знака от цената влизат в сметката. 3 = колоната на продажбите
   * (order_items.unit_price). При ПОКУПКИ цената от фактурата на
   * доставчика може да е с 4+ знака (OCR: 0.8125) и стойността трябва да
   * съвпада с неговата: 48 × 0.8125 = 39.00, а не 48 × 0.813 = 39.02.
   */
  priceDecimals?: number;
}

/**
 * Стойност на ред, както се записва в order_items.total_price:
 * ROUND(qty × цена × (1 − d/100), 2), с входове при точността на колоните.
 * Знакът е като в Postgres — от количеството И от цената (кредитно
 * известие с отрицателно количество → отрицателна стойност).
 */
export function computeLineTotal(
  quantity: Numeric,
  unitPrice: Numeric,
  discountPercent: Numeric = 0,
  options: LineTotalOptions = {},
): number {
  const priceDecimals = options.priceDecimals ?? 3;
  const keptBasisPoints =
    10000n - toUnits(roundDiscountPercent(discountPercent), 2);
  // единици от 10^-(3 + priceDecimals + 4): кол. × цена × дял след отстъпка
  const exact =
    toUnits(quantity, 3) * toUnits(unitPrice, priceDecimals) * keptBasisPoints;
  const toCents = 10n ** BigInt(3 + priceDecimals + 4 - 2);
  const cents = (exact + toCents / 2n) / toCents;
  const sign = signOf(quantity) * signOf(unitPrice) === 1 ? 1 : -1;
  return fromUnits(cents, 2, sign);
}

/** Цена след отстъпка, до 3 знака — изчислена от цената, не от стойността. */
export function effectiveUnitPrice(
  unitPrice: Numeric,
  discountPercent: Numeric = 0,
): number {
  const keptBasisPoints =
    10000n - toUnits(roundDiscountPercent(discountPercent), 2);
  const thousandths =
    (toUnits(unitPrice, 3) * keptBasisPoints + 5000n) / 10000n;
  return fromUnits(thousandths, 3, signOf(unitPrice));
}

export interface PricedLine {
  quantity: Numeric;
  unit_price?: Numeric;
  discount_percent?: Numeric;
  total_price?: Numeric;
}

export interface DisplayLine {
  /** Цената за колоната „Цена“ — 3 знака, след отстъпката. */
  unitPrice: number;
  /** Стойността за колоната „Стойност“ — записаната сума на реда. */
  lineTotal: number;
  discountPercent: number;
  /** Дали показаните цена × количество дават показаната стойност. */
  consistent: boolean;
}

/** ПРАВИЛОТО за всеки печатен документ. Никога не дели стойност на количество. */
export function getDisplayLine(line: PricedLine): DisplayLine {
  const discountPercent = roundDiscountPercent(line.discount_percent);
  const unitPrice = effectiveUnitPrice(line.unit_price, discountPercent);
  // Липсваща или нечислова стойност (null, "", NaN) → изчисляваме я,
  // вместо тихо да отпечатаме 0.
  const hasStoredTotal =
    line.total_price !== null &&
    line.total_price !== undefined &&
    line.total_price !== "" &&
    Number.isFinite(
      typeof line.total_price === "string"
        ? parseFloat(line.total_price)
        : line.total_price,
    );
  const lineTotal = hasStoredTotal
    ? roundMoney(line.total_price)
    : computeLineTotal(line.quantity, line.unit_price, discountPercent);
  const consistent =
    Math.abs(computeLineTotal(line.quantity, unitPrice, 0)) ===
    Math.abs(lineTotal);
  return { unitPrice, lineTotal, discountPercent, consistent };
}
