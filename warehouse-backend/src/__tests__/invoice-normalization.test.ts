import { describe, expect, it } from "vitest";
import {
  invoiceDigitsOnly,
  invoiceOcrKey,
  normalizeInvoiceNumber,
  SQL_OCR_COLLAPSE_EXPR,
} from "../utils/invoice-normalization.js";

describe("invoice normalization", () => {
  it("normalizes greek lookalikes to latin ascii", () => {
    expect(normalizeInvoiceNumber("ΑΒ-12/γδ")).toBe("AB-12GD");
  });

  it("keeps only digits for fallback matching", () => {
    expect(invoiceDigitsOnly("INV Α-0012/2026")).toBe("00122026");
  });
});

describe("invoiceOcrKey — OCR-collapsed form for duplicate detection", () => {
  it("collapses lookalike digit↔letter pairs to canonical form", () => {
    // 0↔O, 1↔I, L↔I, J↔I, Q↔O, 2↔Z, 5↔S, 8↔B, 6↔G
    expect(invoiceOcrKey("0O1IL")).toBe("OOIII");
    expect(invoiceOcrKey("J1L")).toBe("III");
    expect(invoiceOcrKey("258")).toBe("ZSB");
  });

  it("drops dashes so '-' and '.' variants converge", () => {
    expect(invoiceOcrKey("A-JNE-ENA00014")).toBe("AINEENAOOOI4");
    expect(invoiceOcrKey("A.JNE.ENA00014")).toBe("AINEENAOOOI4");
    expect(invoiceOcrKey("AJNE ENA 00014")).toBe("AINEENAOOOI4");
  });

  // Regression case for the real DAGKOS bug that motivated tier-2 fuzzy
  // matching: PDF extraction read "JNE-ENA" while phone photo read
  // "INE-EN0A000014". Exact string compare missed the match; after OCR
  // collapse the keys are within Levenshtein ≤ 2.
  it("DAGKOS OCR variants converge within Levenshtein ≤ 2", () => {
    const fromPdf = invoiceOcrKey("A-JNE-ENA00014");
    const fromPhone = invoiceOcrKey("A.INE-EN0A000014");
    expect(fromPdf).toBe("AINEENAOOOI4");
    expect(fromPhone).toBe("AINEENOAOOOOI4");
    // 2-char delta: two extra O's in phone read. levenshtein(…) in
    // fuzzystrmatch accepts ≤ 2 → match.
    expect(levenshtein(fromPdf, fromPhone)).toBeLessThanOrEqual(2);
  });

  it("rejects empty / too-short inputs safely", () => {
    expect(invoiceOcrKey("")).toBe("");
    // Strings under 4 chars should still be mapped, but the caller
    // (findDuplicateInvoice) bails out at length < 4 to avoid false
    // positives on single-digit/letter invoice numbers.
    expect(invoiceOcrKey("A-1")).toBe("AI");
  });

  it("idempotent — running the key twice yields the same result", () => {
    const once = invoiceOcrKey("A-JNE-ENA00014");
    const twice = invoiceOcrKey(once);
    expect(twice).toBe(once);
  });
});

describe("SQL_OCR_COLLAPSE_EXPR — SQL expression generator", () => {
  it("wraps inner expression with the same 9-char translate table", () => {
    const sql = SQL_OCR_COLLAPSE_EXPR("invoice_number");
    expect(sql).toContain("TRANSLATE");
    expect(sql).toContain("REPLACE(invoice_number, '-', '')");
    expect(sql).toContain("'JL1Q02586'");
    expect(sql).toContain("'IIIOOZSBG'");
    // from and to strings MUST be equal length for PostgreSQL translate()
    expect("JL1Q02586".length).toBe("IIIOOZSBG".length);
  });
});

// ── helpers ─────────────────────────────────────────────────────────────

/**
 * Minimal Levenshtein implementation for test assertions — matches the
 * semantics of PostgreSQL `fuzzystrmatch.levenshtein()` which the
 * production code uses in tier-2 duplicate detection.
 */
function levenshtein(a: string, b: string): number {
  if (a === b) return 0;
  if (!a.length) return b.length;
  if (!b.length) return a.length;
  const dp: number[] = Array(b.length + 1)
    .fill(0)
    .map((_, i) => i);
  for (let i = 1; i <= a.length; i += 1) {
    let prev = i - 1;
    dp[0] = i;
    for (let j = 1; j <= b.length; j += 1) {
      const tmp = dp[j];
      dp[j] =
        a[i - 1] === b[j - 1] ? prev : Math.min(prev, dp[j], dp[j - 1]) + 1;
      prev = tmp;
    }
  }
  return dp[b.length];
}
