import { describe, expect, it } from "vitest";
import {
  evaluateQuantityExpression,
  isQuantityExpression,
  quantityValue,
} from "@/lib/quantityExpression";

describe("смятане в полето за количество (като Microinvest)", () => {
  it("3*2 → 6 и вариантите на „по“", () => {
    expect(evaluateQuantityExpression("3*2")).toBe(6);
    expect(evaluateQuantityExpression("3x2")).toBe(6);
    expect(evaluateQuantityExpression("3х2")).toBe(6); // кирилско х
    expect(evaluateQuantityExpression("3×2")).toBe(6);
    expect(evaluateQuantityExpression(" 3 * 2 ")).toBe(6);
  });

  it("запетая или точка за десетичните, ред на действията, скоби", () => {
    expect(evaluateQuantityExpression("2,5*2")).toBe(5);
    expect(evaluateQuantityExpression("2.5+1")).toBe(3.5);
    expect(evaluateQuantityExpression("12/4")).toBe(3);
    expect(evaluateQuantityExpression("2+3*4")).toBe(14);
    expect(evaluateQuantityExpression("(2+3)*4")).toBe(20);
    expect(evaluateQuantityExpression("10-2,5")).toBe(7.5);
  });

  it("закръгля до 3 знака", () => {
    expect(evaluateQuantityExpression("10/3")).toBe(3.333);
    expect(evaluateQuantityExpression("1.4+1.4")).toBe(2.8);
  });

  it("обикновено число си остава число", () => {
    expect(evaluateQuantityExpression("7")).toBe(7);
    expect(evaluateQuantityExpression("6,317")).toBe(6.317);
  });

  it("невалидно → null", () => {
    for (const bad of [
      "",
      "abc",
      "3*",
      "*3",
      "(2+3",
      "2+3)",
      "1.2.3",
      "5/0",
      "3**2",
      "2a",
    ]) {
      expect(evaluateQuantityExpression(bad)).toBeNull();
    }
  });

  it("разпознава израз и дава NaN за невалидното", () => {
    expect(isQuantityExpression("3*2")).toBe(true);
    expect(isQuantityExpression("6,5")).toBe(false);
    expect(quantityValue("3*2")).toBe(6);
    expect(quantityValue(4)).toBe(4);
    expect(Number.isNaN(quantityValue("3*"))).toBe(true);
  });
});
