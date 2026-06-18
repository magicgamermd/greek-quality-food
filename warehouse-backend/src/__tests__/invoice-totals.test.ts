import { describe, it, expect } from "vitest";
import { computeInvoiceTotalsFromNet } from "../lib/invoice-totals";

describe("computeInvoiceTotalsFromNet (GQF нето конвенция)", () => {
  it("добавя 20% ДДС върху нето сумата", () => {
    const t = computeInvoiceTotalsFromNet(100, true);
    expect(t.totalNet).toBeCloseTo(100, 2);
    expect(t.totalVat).toBeCloseTo(20, 2);
    expect(t.totalGross).toBeCloseTo(120, 2);
    expect(t.vatRate).toBe(20);
  });

  it("при освобождаване от ДДС бруто = нето", () => {
    const t = computeInvoiceTotalsFromNet(100, false);
    expect(t.totalVat).toBe(0);
    expect(t.totalGross).toBeCloseTo(100, 2);
    expect(t.vatRate).toBe(0);
  });

  it("закръгля до 2 знака", () => {
    const t = computeInvoiceTotalsFromNet(182.46, true);
    expect(t.totalVat).toBeCloseTo(36.49, 2);
    expect(t.totalGross).toBeCloseTo(218.95, 2);
  });

  it("възпроизвежда GQF златната проба (net=1.52 → gross=1.82)", () => {
    const t = computeInvoiceTotalsFromNet(1.52, true);
    expect(t.totalVat).toBeCloseTo(0.3, 2);
    expect(t.totalGross).toBeCloseTo(1.82, 2);
  });
});
