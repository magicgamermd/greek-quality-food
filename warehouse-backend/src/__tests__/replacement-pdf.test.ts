import { describe, it, expect } from "vitest";
import { renderReplacementPdf } from "../services/razpiska-replacement-pdf.js";

const baseOrder = {
  id: 241,
  number: "25-000241",
  date: new Date("2026-05-07T10:00:00Z"),
  partner: { name: "Иван Петров", egn_or_eik: null, address: null },
  items: [
    {
      product_name: "Hendi фритюрник 226001",
      product_code: "H226001",
      quantity: 1,
      unit_price: 230,
      is_returning: false,
    },
    {
      product_name: "Hendi фритюрник 226000",
      product_code: "H226000",
      quantity: 1,
      unit_price: 200,
      is_returning: true,
    },
  ],
  total: 30,
  payment_method: "cash" as const,
};

describe("Replacement PDF", () => {
  it("renders a non-empty PDF for positive diff", async () => {
    const buf = await renderReplacementPdf(baseOrder);
    expect(buf.byteLength).toBeGreaterThan(2000);
    expect(buf.subarray(0, 4).toString()).toBe("%PDF");
  });

  it("renders for negative diff", async () => {
    const buf = await renderReplacementPdf({ ...baseOrder, total: -50 });
    expect(buf.byteLength).toBeGreaterThan(2000);
    expect(buf.subarray(0, 4).toString()).toBe("%PDF");
  });

  it("renders for zero diff", async () => {
    const buf = await renderReplacementPdf({
      ...baseOrder,
      total: 0,
      payment_method: undefined,
    });
    expect(buf.byteLength).toBeGreaterThan(2000);
    expect(buf.subarray(0, 4).toString()).toBe("%PDF");
  });
});
