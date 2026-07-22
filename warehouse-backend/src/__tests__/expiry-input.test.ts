import { describe, expect, it } from "vitest";
import { normalizeExpiryInput } from "../utils/expiry-input.js";

const TODAY = "2026-07-22";

describe("normalizeExpiryInput — OCR срокове от етикети", () => {
  it("европейски ДД-ММ-ГГ (гръцки етикет) → бъдеща дата, не година 20ДД", () => {
    // „18-07-27" = 18 юли 2027. Postgres суров INSERT го четеше като
    // ГГ-ММ-ДД → 2018-07-27 → прясна стока се водеше изтекла.
    expect(normalizeExpiryInput("18-07-27", TODAY)).toBe("2027-07-18");
    expect(normalizeExpiryInput("18.07.27", TODAY)).toBe("2027-07-18");
    expect(normalizeExpiryInput("18/07/27", TODAY)).toBe("2027-07-18");
  });

  it("двусмислено 27-03-31: избира най-близкото бъдеще (2027-03-31, не 2031-03-27)", () => {
    // И двете тълкувания са валидни; срокът на годност е обикновено
    // до 1-2 години напред → най-близката бъдеща печели.
    expect(normalizeExpiryInput("27-03-31", TODAY)).toBe("2027-03-31");
  });

  it("пълни формати минават директно", () => {
    expect(normalizeExpiryInput("2027-05-05", TODAY)).toBe("2027-05-05");
    expect(normalizeExpiryInput("31.03.2027", TODAY)).toBe("2027-03-31");
    expect(normalizeExpiryInput("31-03-2027", TODAY)).toBe("2027-03-31");
    expect(normalizeExpiryInput("2027.03.31", TODAY)).toBe("2027-03-31");
  });

  it("леко минал срок (доставена почти изтекла стока) се запазва", () => {
    expect(normalizeExpiryInput("14.07.26", TODAY)).toBe("2026-07-14");
    expect(normalizeExpiryInput("2026-07-14", TODAY)).toBe("2026-07-14");
  });

  it("Date обект с 2-цифрена година → коригиран век", () => {
    const d = new Date(2000, 2, 31);
    d.setFullYear(27);
    expect(normalizeExpiryInput(d, TODAY)).toBe("2027-03-31");
  });

  it("боклук/извън прозореца → null (review gate пита човека)", () => {
    expect(normalizeExpiryInput("ΛΗΞΗ", TODAY)).toBeNull();
    expect(normalizeExpiryInput("", TODAY)).toBeNull();
    expect(normalizeExpiryInput(null, TODAY)).toBeNull();
    // 1999 — извън прозореца и в двете тълкувания.
    expect(normalizeExpiryInput("05.05.1999", TODAY)).toBeNull();
  });

  it("невалиден календарен ден в едното тълкуване не убива другото", () => {
    // „31-06-27": европейски = 31 юни (невалиден) → ISO 2031-06-27? не —
    // ГГ-ММ-ДД = 2031-06-27 валидна и в прозореца → нея.
    expect(normalizeExpiryInput("31-06-27", TODAY)).toBe("2031-06-27");
  });
});
