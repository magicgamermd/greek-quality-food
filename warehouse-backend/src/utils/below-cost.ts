export interface OrderLineInput {
  product_id: number;
  quantity: number;
  unit_price: number;
  discount_percent?: number;
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

export function computeBelowCostItems(
  lines: OrderLineInput[],
  costs: Record<number, ProductCost>,
): BelowCostLine[] {
  const out: BelowCostLine[] = [];
  for (const line of lines) {
    const cost = costs[line.product_id];
    if (!cost || cost.purchase_price == null) continue;
    const discount = line.discount_percent ?? 0;
    const effective = line.unit_price * (1 - discount / 100);
    if (effective + EPSILON < cost.purchase_price) {
      out.push({
        product_id: line.product_id,
        product_name: cost.name,
        quantity: line.quantity,
        unit_price: line.unit_price,
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
