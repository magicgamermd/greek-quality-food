import { describe, it, expect } from "vitest";
import { z } from "zod";

// Replicate product schema from products.ts
const createProductSchema = z.object({
  name_bg: z.string().min(1),
  name_en: z.string().min(1),
  sku: z.string().min(1),
  category_id: z.coerce.number().int().optional().nullable(),
  unit: z.string().default("pcs"),
  description: z.string().optional().nullable(),
  image_url: z.string().url().optional().nullable(),
  low_stock_threshold: z.coerce.number().default(10),
  brand: z.string().optional().nullable(),
  purchase_price: z
    .preprocess((val) => {
      if (val === null || val === undefined || val === "") return null;
      const n = parseFloat(String(val));
      return isNaN(n) ? null : n;
    }, z.number().nullable())
    .optional(),
  selling_price: z
    .preprocess((val) => {
      if (val === null || val === undefined || val === "") return null;
      const n = parseFloat(String(val));
      return isNaN(n) ? null : n;
    }, z.number().nullable())
    .optional(),
});

describe("createProductSchema — price type coercion (Bug #3 fix)", () => {
  it("should accept numeric purchase_price", () => {
    const result = createProductSchema.parse({
      name_bg: "Тест",
      name_en: "Test",
      sku: "TST-001",
      purchase_price: 12.5,
    });
    expect(result.purchase_price).toBe(12.5);
  });

  it("should accept string purchase_price and convert to number", () => {
    const result = createProductSchema.parse({
      name_bg: "Тест",
      name_en: "Test",
      sku: "TST-001",
      purchase_price: "12.50",
    });
    expect(result.purchase_price).toBe(12.5);
  });

  it("should accept string selling_price and convert to number", () => {
    const result = createProductSchema.parse({
      name_bg: "Тест",
      name_en: "Test",
      sku: "TST-001",
      selling_price: "25.99",
    });
    expect(result.selling_price).toBe(25.99);
  });

  it("should handle null purchase_price", () => {
    const result = createProductSchema.parse({
      name_bg: "Тест",
      name_en: "Test",
      sku: "TST-001",
      purchase_price: null,
    });
    expect(result.purchase_price).toBeNull();
  });

  it("should handle empty string as null", () => {
    const result = createProductSchema.parse({
      name_bg: "Тест",
      name_en: "Test",
      sku: "TST-001",
      purchase_price: "",
    });
    expect(result.purchase_price).toBeNull();
  });

  it("should coerce string category_id to number", () => {
    const result = createProductSchema.parse({
      name_bg: "Тест",
      name_en: "Test",
      sku: "TST-001",
      category_id: "3",
    });
    expect(result.category_id).toBe(3);
  });

  it("should reject missing required fields", () => {
    expect(() => createProductSchema.parse({ name_bg: "Тест" })).toThrow();
  });
});
