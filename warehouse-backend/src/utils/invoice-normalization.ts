// Normalize invoice numbers for duplicate detection.
//
// Handles two classes of cross-scan inconsistency:
//   1. Greek ↔ Latin lookalikes (Ζ/Z, Α/A, Ρ/P …) — when the same invoice
//      number is OCR'd once as Greek letters and once as Latin.
//   2. OCR character confusion across the SAME alphabet (0↔O, 1↔I↔L↔J …)
//      — common when one copy is a PDF and another is a phone photo; the
//      photo picks up different edge artifacts and turns an "O" into "0"
//      or a "J" into "I". Folding all of these to a single canonical
//      representative gives us a stable key for duplicate matching.
//
// Example:
//   PDF       "A-JNE-ENA00014"   → normalized: "AIIEEIAOOOI4"
//                                               └── J→I  0→O  1→I
//   phone     "A.INE-EN0A000014" → normalized: "AIIEEIOAOOOOI4"
//                                               └── same collapsing rules
//   Levenshtein between the two = 1 (an extra "O"), so the fuzzy tier
//   catches them while exact-string match would miss.
export function normalizeInvoiceNumber(value: string): string {
  return (
    value
      // Greek uppercase -> Latin
      .replace(/Α/g, "A")
      .replace(/Β/g, "B")
      .replace(/Γ/g, "G")
      .replace(/Δ/g, "D")
      .replace(/Ε/g, "E")
      .replace(/Ζ/g, "Z")
      .replace(/Η/g, "H")
      .replace(/Θ/g, "TH")
      .replace(/Ι/g, "I")
      .replace(/Κ/g, "K")
      .replace(/Λ/g, "L")
      .replace(/Μ/g, "M")
      .replace(/Ν/g, "N")
      .replace(/Ξ/g, "X")
      .replace(/Ο/g, "O")
      .replace(/Π/g, "P")
      .replace(/Ρ/g, "R")
      .replace(/Σ/g, "S")
      .replace(/Τ/g, "T")
      .replace(/Υ/g, "Y")
      .replace(/Φ/g, "F")
      .replace(/Χ/g, "X")
      .replace(/Ψ/g, "PS")
      .replace(/Ω/g, "O")
      // Greek lowercase -> Latin
      .replace(/α/g, "a")
      .replace(/β/g, "b")
      .replace(/γ/g, "g")
      .replace(/δ/g, "d")
      .replace(/ε/g, "e")
      .replace(/ζ/g, "z")
      .replace(/η/g, "h")
      .replace(/θ/g, "th")
      .replace(/ι/g, "i")
      .replace(/κ/g, "k")
      .replace(/λ/g, "l")
      .replace(/μ/g, "m")
      .replace(/ν/g, "n")
      .replace(/ξ/g, "x")
      .replace(/ο/g, "o")
      .replace(/π/g, "p")
      .replace(/ρ/g, "r")
      .replace(/σ/g, "s")
      .replace(/τ/g, "t")
      .replace(/υ/g, "u")
      .replace(/φ/g, "f")
      .replace(/χ/g, "x")
      .replace(/ψ/g, "ps")
      .replace(/ω/g, "o")
      .toUpperCase()
      .replace(/[^A-Z0-9\-]/g, "")
  );
}

export function invoiceDigitsOnly(value: string): string {
  return value.replace(/[^0-9]/g, "");
}

// OCR-collapsed invoice key: turn every lookalike into a single canonical
// character so "A-JNE-ENA00014" and "A.INE-EN0A000014" map to strings that
// differ by at most a few characters — enough for a Levenshtein ≤ 2 check
// to catch them as duplicates.
//
// Collapses applied (after the Greek-fold + punctuation-strip in
// normalizeInvoiceNumber):
//   J, L, I, 1 → I   (tall single strokes)
//   Q, O, 0   → O   (round)
//   Z, 2      → Z
//   S, 5      → S
//   B, 8      → B
//   G, 6      → G
//
// Consecutive runs of the resulting char stay intact so we can still
// distinguish "ENA" from "EN0A" (one extra O after collapse). That 1-char
// delta is what the Levenshtein fallback picks up.
export function invoiceOcrKey(value: string): string {
  const pre = normalizeInvoiceNumber(value).replace(/-/g, "");
  const map: Record<string, string> = {
    J: "I",
    L: "I",
    1: "I",
    Q: "O",
    0: "O",
    2: "Z",
    5: "S",
    8: "B",
    6: "G",
  };
  let out = "";
  for (const ch of pre) {
    out += map[ch] ?? ch;
  }
  return out;
}

// SQL expression that produces the same OCR key on the stored column.
// Used by the fuzzy duplicate query. Applied AFTER the existing Greek-fold
// expression (`SQL_NORMALIZE_INVOICE_NUMBER_EXPR`) — call with that result
// as its input.
export const SQL_OCR_COLLAPSE_EXPR = (innerExpr: string): string => `
  TRANSLATE(
    REPLACE(${innerExpr}, '-', ''),
    'JL1Q02586',
    'IIIOOZSBG'
  )
`;
