// Какво кредитира един ред от кредитно известие по продажба — същите
// правила като сървъра (POST /invoices/credit-note), за прегледа във
// формите преди издаване. Сървърът проверява наново.
//
//   • цена = фактурираната (след отстъпката на реда) → цял ред се
//     кредитира по записаната си стойност, част от ред — кол. × цена с
//     отстъпката;
//   • своя цена (търговска отстъпка след продажбата, напр. 2,8 кг ×
//     0,665 €) → ROUND(кол. × цена, 2); не може да е над фактурираната,
//     нито редът над фактурираното за това количество.
import {
  computeLineTotal,
  effectiveUnitPrice,
  roundMoney,
  roundUnitPrice,
  type Numeric,
} from "@/lib/linePricing";
import { formatCurrency, formatUnitPrice } from "@/lib/utils";

export interface CreditLineSource {
  /** Фактурираното количество. */
  quantity: Numeric;
  unit_price: Numeric;
  discount_percent?: Numeric;
  /** Фактурираната стойност на реда (нето). */
  total_price: Numeric;
  unit?: string | null;
}

export interface CreditLineCalc {
  /** Нето стойност на реда в КИ. */
  lineNet: number;
  /** Своя цена за кредитиране; null = фактурираната. */
  ownPrice: number | null;
  error: string | null;
}

/** Фактурираната цена на реда — след отстъпката, до 3 знака. */
export function invoicedCreditPrice(line: CreditLineSource): number {
  return effectiveUnitPrice(line.unit_price, line.discount_percent ?? 0);
}

export function creditNoteLine(
  line: CreditLineSource,
  quantity: Numeric,
  priceInput: string,
): CreditLineCalc {
  const invoicedQty = Number(line.quantity);
  const invoicedPrice = invoicedCreditPrice(line);
  const qty = Number(quantity);
  if (!(qty > 0)) {
    return { lineNet: 0, ownPrice: null, error: "Въведи количество." };
  }
  if (qty > invoicedQty + 0.0001) {
    return {
      lineNet: 0,
      ownPrice: null,
      error: `Най-много ${invoicedQty} ${line.unit ?? ""}.`.replace(" .", "."),
    };
  }
  const wholeLine = Math.abs(qty - invoicedQty) < 0.0005;
  const invoicedNet = wholeLine
    ? roundMoney(line.total_price)
    : computeLineTotal(qty, line.unit_price, line.discount_percent ?? 0);
  const typed = parseFloat(String(priceInput).replace(",", "."));
  const price = Number.isFinite(typed) ? roundUnitPrice(typed) : 0;
  if (!(price > 0)) {
    return { lineNet: 0, ownPrice: null, error: "Въведи цена." };
  }
  if (Math.abs(price - invoicedPrice) < 0.0005) {
    return { lineNet: invoicedNet, ownPrice: null, error: null };
  }
  if (price > invoicedPrice) {
    return {
      lineNet: 0,
      ownPrice: price,
      error: `Над фактурираната ${formatUnitPrice(invoicedPrice)}.`,
    };
  }
  const lineNet = computeLineTotal(qty, price, 0);
  if (lineNet > invoicedNet + 0.005) {
    return {
      lineNet,
      ownPrice: price,
      error: `Над фактурираното ${formatCurrency(invoicedNet)}.`,
    };
  }
  return { lineNet, ownPrice: price, error: null };
}
