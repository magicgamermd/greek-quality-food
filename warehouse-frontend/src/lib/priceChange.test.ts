import { describe, expect, it } from "vitest";
import {
  collectPriceChangeAlerts,
  computeMarginPercent,
  computePriceChange,
  formatPriceChange,
  formatSignedPercent,
} from "@/lib/priceChange";

describe("нова доставна цена", () => {
  it("поскъпване: посока, разлика и процент", () => {
    const change = computePriceChange(1.6, 1.75);
    expect(change).not.toBeNull();
    expect(change?.direction).toBe("up");
    expect(change?.diff).toBe(0.15);
    expect(change?.percent).toBeCloseTo(9.375, 6);
  });

  it("поевтиняване", () => {
    const change = computePriceChange(2, 1.9);
    expect(change?.direction).toBe("down");
    expect(change?.diff).toBe(-0.1);
    expect(change?.percent).toBeCloseTo(-5, 6);
  });

  it("под 0,005 € не е промяна, от 0,005 € нагоре е", () => {
    expect(computePriceChange(1.6, 1.604)).toBeNull();
    expect(computePriceChange(1.6, 1.596)).toBeNull();
    expect(computePriceChange(1.6, 1.6)).toBeNull();
    expect(computePriceChange(1.6, 1.605)?.direction).toBe("up");
    expect(computePriceChange(1.6, 1.595)?.direction).toBe("down");
    // Плаваща запетая: 0.1 + 0.2 срещу 0.3 не е промяна.
    expect(computePriceChange(0.1 + 0.2, 0.3)).toBeNull();
  });

  it("няма с какво да се сравни → няма знак", () => {
    expect(computePriceChange(null, 1.5)).toBeNull();
    expect(computePriceChange(undefined, 1.5)).toBeNull();
    expect(computePriceChange(0, 1.5)).toBeNull();
    expect(computePriceChange(1.5, "")).toBeNull();
    expect(computePriceChange(1.5, 0)).toBeNull();
    expect(computePriceChange(1.5, "abc")).toBeNull();
  });

  it("приема и низове от полетата", () => {
    expect(computePriceChange("1.60", "1.75")?.direction).toBe("up");
  });

  it("текстът на знака", () => {
    expect(formatPriceChange(computePriceChange(1.6, 1.75)!)).toBe(
      "▲ 1,60 → 1,75 (+9,4 %)",
    );
    expect(formatPriceChange(computePriceChange(2, 1.9)!)).toBe(
      "▼ 2,00 → 1,90 (−5 %)",
    );
    expect(formatPriceChange(computePriceChange(9.25, 9.255)!)).toBe(
      "▲ 9,25 → 9,255 (+0,1 %)",
    );
  });

  it("процентът е с до един знак и със знак", () => {
    expect(formatSignedPercent(9.375)).toBe("+9,4 %");
    expect(formatSignedPercent(-5)).toBe("−5 %");
    expect(formatSignedPercent(0.01)).toBe("0 %");
  });

  it("марж като в „Продукти“", () => {
    expect(computeMarginPercent(2.1, 1.75)).toBeCloseTo(20, 6);
    expect(computeMarginPercent(1.5, 1.75)).toBeCloseTo(-14.2857, 3);
    expect(computeMarginPercent(null, 1.75)).toBeNull();
    expect(computeMarginPercent(2, 0)).toBeNull();
  });

  it("списъкът след запис: само променените, по веднъж на продукт", () => {
    const alerts = collectPriceChangeAlerts([
      { productId: 1, productName: "Фета", oldPrice: 1.6, newPrice: 1.75 },
      { productId: 2, productName: "Маслини", oldPrice: 3, newPrice: 3 },
      { productId: null, productName: "Нов", oldPrice: 1, newPrice: 2 },
      { productId: 3, productName: "Халва", oldPrice: 2, newPrice: 1.9 },
      { productId: 3, productName: "Халва", oldPrice: 2, newPrice: 1.8 },
    ]);
    expect(alerts.map((a) => [a.productId, a.newPrice])).toEqual([
      [1, 1.75],
      [3, 1.8],
    ]);
  });

  it("последният ред за продукта решава", () => {
    const alerts = collectPriceChangeAlerts([
      { productId: 1, productName: "Фета", oldPrice: 1.6, newPrice: 1.75 },
      { productId: 1, productName: "Фета", oldPrice: 1.6, newPrice: 1.6 },
    ]);
    expect(alerts).toEqual([]);
  });
});
