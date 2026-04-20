import { describe, it, expect } from "vitest";
import {
  parseMicroinvestYesNo,
  parseProductActiveStatus,
} from "../utils/microinvest.js";

describe("parseMicroinvestYesNo", () => {
  it("parses Bulgarian yes/no values", () => {
    expect(parseMicroinvestYesNo("Да")).toBe(true);
    expect(parseMicroinvestYesNo("Не")).toBe(false);
  });

  it("returns null for unknown values", () => {
    expect(parseMicroinvestYesNo("понякога")).toBeNull();
    expect(parseMicroinvestYesNo(undefined)).toBeNull();
  });
});

describe("parseProductActiveStatus", () => {
  it("parses STOKI status strings", () => {
    expect(parseProductActiveStatus("Стоката се използва")).toBe(true);
    expect(parseProductActiveStatus("Стоката не се използва")).toBe(false);
  });

  it("falls back to yes/no parsing for generic values", () => {
    expect(parseProductActiveStatus("Да")).toBe(true);
    expect(parseProductActiveStatus("Не")).toBe(false);
  });
});
