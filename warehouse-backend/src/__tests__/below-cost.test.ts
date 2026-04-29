import { describe, expect, it } from "vitest";
import {
  computeBelowCostItems,
  type OrderLineInput,
  type ProductCost,
} from "../utils/below-cost.js";

describe("computeBelowCostItems", () => {
  const costs: Record<number, ProductCost> = {
    100: { product_id: 100, name: "Скара", purchase_price: 50 },
    200: { product_id: 200, name: "Лопата", purchase_price: 5 },
    300: { product_id: 300, name: "Без cost", purchase_price: null },
  };

  it("returns empty when all lines are at or above cost", () => {
    const lines: OrderLineInput[] = [
      { product_id: 100, quantity: 1, unit_price: 60, discount_percent: 0 },
      { product_id: 200, quantity: 1, unit_price: 5, discount_percent: 0 },
    ];
    expect(computeBelowCostItems(lines, costs)).toEqual([]);
  });

  it("flags a line whose post-discount effective price is below cost", () => {
    const lines: OrderLineInput[] = [
      { product_id: 200, quantity: 2, unit_price: 5, discount_percent: 50 },
    ];
    const result = computeBelowCostItems(lines, costs);
    expect(result).toHaveLength(1);
    expect(result[0]).toMatchObject({
      product_id: 200,
      product_name: "Лопата",
      quantity: 2,
      unit_price: 5,
      discount_percent: 50,
      effective_price: 2.5,
      purchase_price: 5,
      loss_per_unit: 2.5,
    });
  });

  it("ignores products with null purchase_price (no known cost)", () => {
    const lines: OrderLineInput[] = [
      { product_id: 300, quantity: 1, unit_price: 0.01, discount_percent: 0 },
    ];
    expect(computeBelowCostItems(lines, costs)).toEqual([]);
  });

  it("treats missing discount_percent as 0", () => {
    const lines: OrderLineInput[] = [
      { product_id: 100, quantity: 1, unit_price: 49.99 } as OrderLineInput,
    ];
    expect(computeBelowCostItems(lines, costs)).toHaveLength(1);
  });

  it("uses small epsilon to avoid floating-point false positives", () => {
    const lines: OrderLineInput[] = [
      {
        product_id: 100,
        quantity: 1,
        unit_price: 50.0001,
        discount_percent: 0,
      },
    ];
    expect(computeBelowCostItems(lines, costs)).toEqual([]);
  });

  it("ignores products absent from cost map", () => {
    const lines: OrderLineInput[] = [
      { product_id: 999, quantity: 1, unit_price: 1, discount_percent: 0 },
    ];
    expect(computeBelowCostItems(lines, costs)).toEqual([]);
  });
});
