// Mirror of warehouse-backend/src/utils/below-cost.ts. Keep the two in
// sync; the backend re-validates everything on submit so this helper is
// purely for UI gating (showing the confirm dialog).
//
// Inputs accept string | number to match the controlled-input shapes
// used in the order modals (numeric fields persist as strings until
// blur). Outputs are normalised to numbers.

export interface OrderLineInput {
  product_id: number;
  quantity: number | string;
  unit_price: number | string;
  discount_percent?: number | string;
}

export interface ProductCost {
  product_id: number;
  name: string;
  purchase_price: number | null;
}

export interface BelowCostLine {
  product_id: number;
  product_name: string;
  quantity: number;
  unit_price: number;
  discount_percent: number;
  effective_price: number;
  purchase_price: number;
  loss_per_unit: number;
}

const EPSILON = 0.005;

function toNumber(value: number | string | undefined, fallback = 0): number {
  if (value === undefined || value === null || value === "") return fallback;
  const n = typeof value === "number" ? value : parseFloat(value);
  return Number.isFinite(n) ? n : fallback;
}

export function computeBelowCostItems(
  lines: OrderLineInput[],
  costs: Record<number, ProductCost>,
): BelowCostLine[] {
  const out: BelowCostLine[] = [];
  for (const line of lines) {
    const cost = costs[line.product_id];
    if (!cost || cost.purchase_price == null) continue;
    const unitPrice = toNumber(line.unit_price);
    const discount = toNumber(line.discount_percent, 0);
    const quantity = toNumber(line.quantity);
    const effective = unitPrice * (1 - discount / 100);
    if (effective + EPSILON < cost.purchase_price) {
      out.push({
        product_id: line.product_id,
        product_name: cost.name,
        quantity,
        unit_price: unitPrice,
        discount_percent: discount,
        effective_price: Math.round(effective * 100) / 100,
        purchase_price: cost.purchase_price,
        loss_per_unit:
          Math.round((cost.purchase_price - effective) * 100) / 100,
      });
    }
  }
  return out;
}
