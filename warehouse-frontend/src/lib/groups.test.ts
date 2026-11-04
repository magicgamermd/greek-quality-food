import { describe, expect, it } from "vitest";
import { countLabel, groupFilterParam } from "@/lib/groups";
import {
  discountForPickedProduct,
  effectiveDefaultDiscount,
  formatPercent,
  priceGroupDiscount,
} from "@/lib/priceGroups";

describe("групи (Microinvest)", () => {
  it("брой с правилната дума", () => {
    expect(countLabel("product", 1)).toBe("1 продукт");
    expect(countLabel("product", 12)).toBe("12 продукта");
    expect(countLabel("partner", 1)).toBe("1 партньор");
    expect(countLabel("partner", 3)).toBe("3 партньора");
  });

  it("филтърът към API-то: всички / без група / номер", () => {
    expect(groupFilterParam("")).toBeNull();
    expect(groupFilterParam("none")).toBe("none");
    expect(groupFilterParam("12")).toBe("12");
    expect(groupFilterParam("12; DROP")).toBeNull();
  });
});

describe("отстъпка по подразбиране (ценова група / партньор)", () => {
  const groups = [
    { price_group: "Цена на едро", discount_percent: 2.5, partner_count: 414 },
    { price_group: "Ценова група 1", discount_percent: 0, partner_count: 0 },
  ];

  it("отстъпката на ценовата група", () => {
    expect(priceGroupDiscount(groups, "Цена на едро")).toBe(2.5);
    expect(priceGroupDiscount(groups, "Ценова група 1")).toBe(0);
    expect(priceGroupDiscount(groups, "")).toBe(0);
    expect(priceGroupDiscount(undefined, "Цена на едро")).toBe(0);
  });

  it("своята на партньора е с предимство, иначе тази на групата", () => {
    expect(effectiveDefaultDiscount("5", 2.5)).toBe(5);
    expect(effectiveDefaultDiscount("0,00", 2.5)).toBe(2.5);
    expect(effectiveDefaultDiscount("", 2.5)).toBe(2.5);
    expect(effectiveDefaultDiscount("abc", 0)).toBe(0);
    expect(effectiveDefaultDiscount("150", 0)).toBe(0);
  });

  it("за показване: 2,5 и 5", () => {
    expect(formatPercent(2.5)).toBe("2,5");
    expect(formatPercent(5)).toBe("5");
    expect(formatPercent(3.333)).toBe("3,33");
  });

  it("нов ред получава отстъпката; попълнен или сменен ред — не", () => {
    const product = { default_discount_percent: 2.5 };
    expect(
      discountForPickedProduct(
        { product_id: "", discount_percent: "0" },
        product,
      ),
    ).toBe("2.5");
    expect(
      discountForPickedProduct(
        { product_id: "", discount_percent: "" },
        product,
      ),
    ).toBe("2.5");
    // складът е написал своя отстъпка преди продукта
    expect(
      discountForPickedProduct(
        { product_id: "", discount_percent: "10" },
        product,
      ),
    ).toBe("10");
    // смяна на продукта на вече попълнен ред не пипа отстъпката
    expect(
      discountForPickedProduct(
        { product_id: "15", discount_percent: "0" },
        product,
      ),
    ).toBe("0");
    // без отстъпка по подразбиране
    expect(
      discountForPickedProduct(
        { product_id: "", discount_percent: "0" },
        { default_discount_percent: 0 },
      ),
    ).toBe("0");
  });
});
