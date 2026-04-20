import { describe, expect, it } from "vitest";
import { escapeLike, normalizeAliasName } from "../utils/product-matching.js";

describe("product matching utils", () => {
  it("normalizes casing, punctuation and whitespace", () => {
    expect(normalizeAliasName('  ΜΠΑΚΛΑΒΑΔΑΚΙ  "THESS."  ')).toBe(
      "μπακλαβαδακι thess",
    );
  });

  it("strips accents and keeps alphanumeric words", () => {
    expect(normalizeAliasName("Crème brûlée 200g")).toBe("creme brulee 200g");
  });

  it("escapes LIKE metacharacters", () => {
    expect(escapeLike("A_100%\\x")).toBe("A\\_100\\%\\\\x");
  });
});

