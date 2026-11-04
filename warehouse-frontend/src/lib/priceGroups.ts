// Ценови групи на партньорите и отстъпката на всяка (Microinvest, 04.11.2026).
// Отстъпката на групата влиза сама в новите редове на поръчка; своята
// отстъпка на партньора е с предимство.
import { useQuery } from "@tanstack/react-query";
import { api } from "@/lib/api";

export interface PriceGroupDiscount {
  price_group: string;
  discount_percent: number;
  partner_count: number;
}

export const PRICE_GROUPS_QUERY_KEY = ["price-groups"] as const;

export function usePriceGroups() {
  return useQuery<PriceGroupDiscount[]>({
    queryKey: PRICE_GROUPS_QUERY_KEY,
    queryFn: () =>
      api.get("/partners/price-groups").then((response) => {
        const rows = Array.isArray(response.data?.data)
          ? response.data.data
          : [];
        return rows.map((row: PriceGroupDiscount) => ({
          price_group: String(row.price_group),
          discount_percent: Number(row.discount_percent) || 0,
          partner_count: Number(row.partner_count) || 0,
        }));
      }),
    staleTime: 60_000,
  });
}

/** Отстъпката на ценовата група (0, ако няма такава). */
export function priceGroupDiscount(
  groups: PriceGroupDiscount[] | undefined,
  priceGroup: string | null | undefined,
): number {
  if (!priceGroup) return 0;
  return (
    groups?.find((group) => group.price_group === priceGroup)
      ?.discount_percent ?? 0
  );
}

/** Отстъпка по подразбиране: своята на партньора, иначе на групата. */
export function effectiveDefaultDiscount(
  ownDiscount: number | string | null | undefined,
  groupDiscount: number,
): number {
  const own = Number(String(ownDiscount ?? "").replace(",", "."));
  if (Number.isFinite(own) && own > 0 && own <= 100) return own;
  return groupDiscount > 0 && groupDiscount <= 100 ? groupDiscount : 0;
}

/** „5“, „3,5“ — за показване. */
export function formatPercent(value: number): string {
  return String(Math.round(value * 100) / 100).replace(".", ",");
}

/**
 * Т.О. % на ред при избор на продукт: нов ред (без продукт досега) с
 * празна/нулева отстъпка получава отстъпката по подразбиране на
 * партньора; вече попълнена или сменена от склада отстъпка не се пипа.
 */
export function discountForPickedProduct(
  row: { product_id: string; discount_percent: string },
  product: { default_discount_percent?: number | null },
): string {
  const fallback = Number(product.default_discount_percent) || 0;
  const current = Number(String(row.discount_percent ?? "").replace(",", "."));
  const untouched = !row.product_id && (!row.discount_percent || current === 0);
  return untouched && fallback > 0 && fallback <= 100
    ? String(fallback)
    : row.discount_percent;
}
