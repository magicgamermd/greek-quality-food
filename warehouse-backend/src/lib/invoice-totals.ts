// Single source of truth за GQF нето/ДДС/бруто математиката.
//
// Greek Quality Food съхранява order_items.unit_price/total_price като НЕТО
// (без ДДС) — касиерът въвежда нето продажна цена. ДДС се ДОБАВЯ отгоре,
// никога не се вади. (Обратно на MERTM, който пази GROSS и дели на 1.2.)
//
// Държим математиката на едно място, за да не се разминават отделните
// code paths (фактура / отчет / плащане), както стана с double-VAT бъга
// в MERTM (виж 2026-06-04).

export interface InvoiceTotals {
  totalNet: number;
  totalVat: number;
  totalGross: number;
  vatRate: number; // 20 когато има ДДС, иначе 0
}

const round2 = (n: number) => Math.round(n * 100) / 100;

/**
 * Извежда нето / ДДС / бруто от НЕТО сума (без ДДС).
 *
 * @param netSum     сбор на order_items.total_price (вече без ДДС)
 * @param includeVat дали фактурата носи 20% ДДС (false → 0% / освободена)
 */
export function computeInvoiceTotalsFromNet(
  netSum: number,
  includeVat: boolean,
): InvoiceTotals {
  const vatRate = includeVat ? 20 : 0;
  const totalNet = round2(netSum);
  const totalVat = round2(includeVat ? netSum * (vatRate / 100) : 0);
  const totalGross = round2(totalNet + totalVat);
  return { totalNet, totalVat, totalGross, vatRate };
}
