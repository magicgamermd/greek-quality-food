/**
 * Transliteration & fuzzy-search normalization for BG/GR/EN mixed data.
 *
 * Problem: partner/supplier/product names are often stored in Cyrillic OR
 * Latin, but users type with whichever keyboard is active. So a user typing
 * "bakalia" should find "БАКАЛИЯ", and typing "софия" should find "SOFIA".
 *
 * Solution: normalize BOTH the haystack and needle to a common lowercase
 * ASCII-ish representation, then do substring match.
 */

// Official Bulgarian transliteration (Law on Transliteration 2009) — Cyrillic → Latin
const CYR_TO_LAT: Record<string, string> = {
  а: "a",
  б: "b",
  в: "v",
  г: "g",
  д: "d",
  е: "e",
  ж: "zh",
  з: "z",
  и: "i",
  й: "y",
  к: "k",
  л: "l",
  м: "m",
  н: "n",
  о: "o",
  п: "p",
  р: "r",
  с: "s",
  т: "t",
  у: "u",
  ф: "f",
  х: "h",
  ц: "ts",
  ч: "ch",
  ш: "sh",
  щ: "sht",
  ъ: "a",
  ь: "y",
  ю: "yu",
  я: "ya",
  // Russian/Serbian extras (harmless fallback)
  ы: "y",
  э: "e",
  ё: "e",
  ї: "i",
  і: "i",
  ј: "j",
};

// Greek → Latin (simple / ELOT 743-ish, lowercase only — we lowercase first)
const GRK_TO_LAT: Record<string, string> = {
  α: "a",
  β: "v",
  γ: "g",
  δ: "d",
  ε: "e",
  ζ: "z",
  η: "i",
  θ: "th",
  ι: "i",
  κ: "k",
  λ: "l",
  μ: "m",
  ν: "n",
  ξ: "x",
  ο: "o",
  π: "p",
  ρ: "r",
  σ: "s",
  ς: "s",
  τ: "t",
  υ: "y",
  φ: "f",
  χ: "ch",
  ψ: "ps",
  ω: "o",
  // accented vowels
  ά: "a",
  έ: "e",
  ή: "i",
  ί: "i",
  ό: "o",
  ύ: "y",
  ώ: "o",
  ϊ: "i",
  ϋ: "y",
  ΐ: "i",
  ΰ: "y",
};

// Multi-char Latin digraphs that the user might type for single Cyrillic letters.
// After we lowercase & transliterate Cyrillic→Latin on haystack, we can also
// collapse these on the needle for tolerance.
const LAT_DIGRAPH_COLLAPSE: Array<[RegExp, string]> = [
  [/sht/g, "sht"],
  [/sh/g, "sh"],
  [/ch/g, "ch"],
  [/zh/g, "zh"],
  [/ts/g, "ts"],
  [/yu/g, "yu"],
  [/ya/g, "ya"],
  [/yo/g, "yo"],
  // "ou" is often "у" in Greek transliteration → keep as "u"
  [/ou/g, "u"],
];

/**
 * Normalize a string for fuzzy search:
 *  - lowercase
 *  - strip diacritics (combining marks)
 *  - transliterate Cyrillic & Greek → Latin
 *  - collapse whitespace
 *  - strip punctuation except digits/letters/spaces
 */
export function normalizeForSearch(input: string | null | undefined): string {
  if (!input) return "";
  let s = String(input).toLowerCase();

  // Decompose accents (é → e + combining acute) then strip combining marks
  s = s.normalize("NFD").replace(/[\u0300-\u036f]/g, "");

  // Transliterate per-character
  let out = "";
  for (const ch of s) {
    if (CYR_TO_LAT[ch]) out += CYR_TO_LAT[ch];
    else if (GRK_TO_LAT[ch]) out += GRK_TO_LAT[ch];
    else out += ch;
  }

  // Drop glide-y between any letter and a vowel (bakaliya → bakalia, sofiya → sofia).
  // Matches the backend normalize_search() SQL function so client & server agree.
  out = out.replace(/([a-z])y([aeiou])/g, "$1$2");

  // Strip everything except a-z, 0-9, and spaces
  out = out.replace(/[^a-z0-9 ]+/g, " ");
  // Collapse whitespace
  out = out.replace(/\s+/g, " ").trim();
  return out;
}

/**
 * Returns true if `needle` appears in `haystack` after both are normalized.
 * Safe for empty/nullish inputs: empty needle always matches.
 */
export function matchesSearch(
  haystack: string | null | undefined,
  needle: string | null | undefined,
): boolean {
  const n = normalizeForSearch(needle);
  if (!n) return true;
  const h = normalizeForSearch(haystack);
  if (h.includes(n)) return true;

  // Also try after collapsing common Latin digraphs on both sides
  let nRelaxed = n;
  let hRelaxed = h;
  for (const [re, rep] of LAT_DIGRAPH_COLLAPSE) {
    nRelaxed = nRelaxed.replace(re, rep);
    hRelaxed = hRelaxed.replace(re, rep);
  }
  return hRelaxed.includes(nRelaxed);
}

/**
 * Match needle against multiple fields (joined haystack).
 * Convenience wrapper used by table filters.
 */
export function matchesAnyField(
  needle: string | null | undefined,
  fields: Array<string | null | undefined>,
): boolean {
  if (!normalizeForSearch(needle)) return true;
  return matchesSearch(fields.filter(Boolean).join(" "), needle);
}
