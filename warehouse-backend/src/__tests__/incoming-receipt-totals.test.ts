import { describe, expect, it } from "vitest";
import { computeIncomingReceiptTotals } from "../services/document-pdf.js";

describe("computeIncomingReceiptTotals — един източник на истина за разписката", () => {
  it("stale total_price > кол×цена се игнорира: Общо = Междинна − Отстъпка (прод: доставка 110)", () => {
    // Редове 34/35 от доставка 4 (Документ 110): total_price е останал от
    // ПРЕДИ редакция на цената (старият PATCH не преизчисляваше сбора).
    // Старият код показваше Междинна 27.00+58.80, но Общо 30.24+59.04 —
    // документ, който не се събира.
    const { lines, subtotal, discountTotal, total } =
      computeIncomingReceiptTotals([
        { quantity: 12, unit_price: 2.25, total_price: 30.24 }, // stale (било 2.52)
        { quantity: 12, unit_price: 4.9, total_price: 59.04 }, // stale (било 4.92)
      ]);

    // Стойността на реда е кол×цена, не старият сбор.
    expect(lines[0].lineTotal).toBeCloseTo(27.0, 2);
    expect(lines[1].lineTotal).toBeCloseTo(58.8, 2);
    expect(lines[0].discountAmount).toBe(0);
    expect(lines[1].discountAmount).toBe(0);

    expect(subtotal).toBe(85.8);
    expect(discountTotal).toBe(0);
    // Аритметична гаранция: Общо = Междинна − Отстъпка.
    expect(total).toBe(85.8);
    expect(total).toBe(subtotal - discountTotal);
  });

  it("легитимна отстъпка (total_price < кол×цена) се запазва и показва", () => {
    const { lines, subtotal, discountTotal, total } =
      computeIncomingReceiptTotals([
        // Доставчикът дава реда за 90.00 вместо 100.00 → 10% отстъпка.
        { quantity: 10, unit_price: 10, total_price: 90 },
      ]);

    expect(lines[0].lineTotal).toBe(90);
    expect(lines[0].discountPercent).toBeCloseTo(10, 5);
    expect(lines[0].discountAmount).toBeCloseTo(10, 5);
    expect(subtotal).toBe(100);
    expect(discountTotal).toBe(10);
    expect(total).toBe(90);
  });

  it('float прах не обръща нулевата отстъпка в „-0.00"', () => {
    // 16.635 × 9.25 = 153.87375, запазено 153.87 → микро „отстъпка"
    // 0.00375, която старият код сумираше и после показваше "-0.00".
    const { discountTotal, subtotal, total } = computeIncomingReceiptTotals([
      { quantity: 16.635, unit_price: 9.25, total_price: 153.87 },
      { quantity: 2.045, unit_price: 8.6, total_price: 17.59 },
    ]);

    // След закръгляне отстъпката е точно 0 → блокът я показва "0.00" без минус.
    expect(discountTotal).toBe(0);
    expect(total).toBe(subtotal);
  });

  it("ред без total_price пада към кол×цена (3 знака в цената оцеляват)", () => {
    const { lines, subtotal, total } = computeIncomingReceiptTotals([
      { quantity: 3, unit_price: 9.253, total_price: null },
    ]);
    // 3 × 9.253 = 27.759 → редът се закръгля ПО РЕД до цента (27.76),
    // за да е клетката „Стойност" равна на това, което влиза в сбора.
    expect(lines[0].lineTotal).toBe(27.76);
    expect(subtotal).toBe(27.76);
    expect(total).toBe(27.76);
  });
});
