import { describe, expect, it } from "vitest";
import {
  computeLineTotal,
  effectiveUnitPrice,
  getDisplayLine,
  roundDiscountPercent,
  roundMoney,
  roundQuantity,
  roundUnitPrice,
} from "../lib/line-pricing.js";

// Единственото правило за цена и стойност на ред. Примерите са от реални
// поръчки в прода (23.09.2026), където документите печатаха 6.318 вместо
// въведеното 6.317, а две стойности бяха с една стотинка по-малко.

describe("computeLineTotal — стойност на ред, закръглена като Postgres ROUND", () => {
  it.each([
    // [количество, цена, отстъпка %, очаквана стойност]
    [2.8, 6.317, 0, 17.69], // поръчка 259
    [2.8, 6.317, 10, 15.92], // поръчка 202
    [3, 6.317, 10, 17.06], // поръчка 202
    [10, 6.317, 10, 56.85],
    // Точно половин стотинка — float toFixed(2) закръгляше НАДОЛУ.
    [1.54, 19.75, 0, 30.42], // поръчка 83 (в базата е 30.41)
    [2.275, 7.8, 0, 17.75], // поръчка 126 (в базата е 17.74)
    [1, 2.675, 0, 2.68],
    [1, 6.305, 0, 6.31],
    [3, 2.005, 0, 6.02],
    [25, 0.043, 0, 1.08],
    [0.5, 4.27, 0, 2.14],
    [1, 1.15, 10, 1.04],
    [20, 45, 5.56, 849.96],
  ])("%s × %s при %s%% → %s", (qty, price, discount, expected) => {
    expect(computeLineTotal(qty, price, discount)).toBe(expected);
  });

  it("приема и низове, както идват от Postgres NUMERIC", () => {
    expect(computeLineTotal("2.800", "6.317", "0.00")).toBe(17.69);
  });

  it("количество с повече от 3 знака се закръгля като колоната NUMERIC(12,3)", () => {
    expect(computeLineTotal(1.0004, 100, 0)).toBe(100);
  });

  it("отрицателно количество (кредитно известие) дава отрицателна стойност", () => {
    expect(computeLineTotal(-2.8, 6.317, 0)).toBe(-17.69);
    expect(computeLineTotal(-1.54, 19.75, 0)).toBe(-30.42);
  });

  it("100% отстъпка дава нула", () => {
    expect(computeLineTotal(3, 4.317, 100)).toBe(0);
  });

  it("знакът е като в Postgres — и от цената", () => {
    // Преди отрицателна цена даваше ПОЛОЖИТЕЛНА стойност и прегледът на
    // КИ от доставчик показваше кредит при ПОВИШЕНА цена.
    expect(computeLineTotal(2.8, -0.683)).toBe(-1.91);
    expect(computeLineTotal(-2.8, -1)).toBe(2.8);
  });

  it("покупки: цената от фактурата на доставчика с пълната си точност", () => {
    const supplier = { priceDecimals: 6 };
    expect(computeLineTotal(48, 0.8125, 0, supplier)).toBe(39);
    expect(computeLineTotal(1000, 0.4567, 0, supplier)).toBe(456.7);
    expect(computeLineTotal(24, 2.1666, 0, supplier)).toBe(52);
    // по подразбиране (продажби) цената е до 3 знака, като колоната
    expect(computeLineTotal(48, 0.8125)).toBe(39.02);
  });
});

describe("закръгляне до точността на колоните", () => {
  it("цена до 3 знака, половин нагоре", () => {
    expect(roundUnitPrice(6.3175)).toBe(6.318);
    expect(roundUnitPrice("6.317")).toBe(6.317);
  });
  it("количество до 3 знака", () => {
    expect(roundQuantity(1.0004)).toBe(1);
    expect(roundQuantity(2.8005)).toBe(2.801);
  });
  it("пари до 2 знака, половин встрани от нулата", () => {
    expect(roundMoney(12.024)).toBe(12.02);
    expect(roundMoney(30.415)).toBe(30.42);
    expect(roundMoney(-1.845)).toBe(-1.85);
  });
  it("отстъпка до 2 знака и в рамките 0–100", () => {
    expect(roundDiscountPercent(4.0502)).toBe(4.05);
    expect(roundDiscountPercent(150)).toBe(100);
    expect(roundDiscountPercent(-5)).toBe(0);
  });
});

describe("effectiveUnitPrice — цена след отстъпка, от цената, НЕ от стойността", () => {
  it("6.317 при 10% → 5.685 (документите печатаха 5.686 и 5.687)", () => {
    expect(effectiveUnitPrice(6.317, 10)).toBe(5.685);
  });
  it("без отстъпка връща самата цена", () => {
    expect(effectiveUnitPrice("6.317", 0)).toBe(6.317);
  });
});

describe("getDisplayLine — какво печата всеки документ", () => {
  it("РЕГРЕСИЯ: поръчка 259 печата 6.317, не 6.318", () => {
    const line = getDisplayLine({
      quantity: "2.800",
      unit_price: "6.317",
      total_price: "17.69",
      discount_percent: "0.00",
    });
    expect(line.unitPrice).toBe(6.317);
    expect(line.lineTotal).toBe(17.69);
    expect(line.consistent).toBe(true);
  });

  it("ред с отстъпка печата цената след отстъпката", () => {
    const line = getDisplayLine({
      quantity: 2.8,
      unit_price: 6.317,
      total_price: 15.92,
      discount_percent: 10,
    });
    expect(line.unitPrice).toBe(5.685);
    expect(line.lineTotal).toBe(15.92);
    expect(line.consistent).toBe(true);
  });

  it("стойността е ЗАПИСАНАТА, не преизчислена — документът не мени сумите", () => {
    // Поръчка 83: в базата 30.41 (старото грешно закръгляне). Документът
    // трябва да покаже фактурираното, а не тихо да го поправи.
    const line = getDisplayLine({
      quantity: 1.54,
      unit_price: 19.75,
      total_price: 30.41,
      discount_percent: 0,
    });
    expect(line.unitPrice).toBe(19.75);
    expect(line.lineTotal).toBe(30.41);
    expect(line.consistent).toBe(false);
  });

  it("кредитно известие (отрицателни количество и стойност)", () => {
    const line = getDisplayLine({
      quantity: -2.8,
      unit_price: 6.317,
      total_price: -17.69,
      discount_percent: 0,
    });
    expect(line.unitPrice).toBe(6.317);
    expect(line.lineTotal).toBe(-17.69);
    expect(line.consistent).toBe(true);
  });

  it("стойност 0 се печата като 0, не се подменя с количество × цена", () => {
    const line = getDisplayLine({
      quantity: 3,
      unit_price: 4.317,
      total_price: 0,
      discount_percent: 100,
    });
    expect(line.unitPrice).toBe(0);
    expect(line.lineTotal).toBe(0);
  });

  it("без записана стойност я изчислява по същото правило", () => {
    const line = getDisplayLine({ quantity: 2.8, unit_price: 6.317 });
    expect(line.lineTotal).toBe(17.69);
  });

  it("невалидна записана стойност (NaN) се изчислява, не става 0", () => {
    const line = getDisplayLine({
      quantity: 2.8,
      unit_price: 6.317,
      total_price: Number.NaN,
    });
    expect(line.lineTotal).toBe(17.69);
  });

  it("нулево количество не дели на нула", () => {
    const line = getDisplayLine({
      quantity: 0,
      unit_price: 6.317,
      total_price: 0,
    });
    expect(line.unitPrice).toBe(6.317);
    expect(line.lineTotal).toBe(0);
  });
});
