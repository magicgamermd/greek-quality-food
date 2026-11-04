import { describe, expect, it } from "vitest";
import { dottedFromIso, isoFromDottedDate, toIsoDate } from "@/lib/dateInput";

describe("срок на годност като ДД.ММ.ГГГГ", () => {
  it("ДД.ММ.ГГГГ и ДД.ММ.ГГ → ISO", () => {
    expect(isoFromDottedDate("04.06.2027")).toBe("2027-06-04");
    expect(isoFromDottedDate("04.06.27")).toBe("2027-06-04");
    expect(isoFromDottedDate("4.6.2027")).toBe("2027-06-04");
  });

  it("невъзможна или непълна дата → null", () => {
    expect(isoFromDottedDate("31.02.2027")).toBeNull();
    expect(isoFromDottedDate("12.13.2027")).toBeNull();
    expect(isoFromDottedDate("04.06.202")).toBeNull();
    expect(isoFromDottedDate("")).toBeNull();
    // 29.02 само във високосна година
    expect(isoFromDottedDate("29.02.2028")).toBe("2028-02-29");
    expect(isoFromDottedDate("29.02.2027")).toBeNull();
  });

  it("стойност отвън: ISO от базата и „18-07-27“ от сканиране", () => {
    expect(toIsoDate("2027-06-04")).toBe("2027-06-04");
    expect(toIsoDate("2027-06-04T00:00:00.000Z")).toBe("2027-06-04");
    expect(toIsoDate("18-07-27")).toBe("2027-07-18");
    expect(toIsoDate("18.07.2027")).toBe("2027-07-18");
    expect(toIsoDate("боклук")).toBe("");
    expect(toIsoDate(null)).toBe("");
  });

  it("ISO → ДД.ММ.ГГГГ за показване", () => {
    expect(dottedFromIso("2027-06-04")).toBe("04.06.2027");
    expect(dottedFromIso("18-07-27")).toBe("18.07.2027");
    expect(dottedFromIso("")).toBe("");
  });
});
