import React from "react";
import { normalizeForSearch } from "@/lib/translit";

/**
 * Highlight the matched substring of `text` against `query`, with the
 * same transliteration rules used by `matchesSearch()` — so when the user
 * types "bakalia" the match "БАКАЛИЯ" gets wrapped in <mark>.
 *
 * Approach: normalize each character of `text` individually (preserving
 * indices), concatenate the normalized tokens to form a haystack with an
 * index-map back to original positions, then substring-match the
 * normalized query and translate the hit range back to original indices.
 */
export function HighlightMatch({
  text,
  query,
  className = "bg-yellow-200 text-gray-900 rounded-sm px-0.5",
}: {
  text: string | null | undefined;
  query: string | null | undefined;
  className?: string;
}): React.ReactElement {
  const safe = text ?? "";
  const range = computeMatchRange(safe, query ?? "");
  if (!range) {
    return <>{safe}</>;
  }
  const [start, end] = range;
  return (
    <>
      {safe.slice(0, start)}
      <mark className={className}>{safe.slice(start, end)}</mark>
      {safe.slice(end)}
    </>
  );
}

/**
 * Like HighlightMatch, but accepts a multi-token query. Splits the query
 * on whitespace and wraps every matching range. Useful when the backend
 * tokenized the search (e.g. 'колбасо реза' → matches 'Колбасорезачка'
 * via tokens 'колбасо' + 'реза').
 */
export function HighlightMultiToken({
  text,
  query,
  className = "bg-yellow-200 text-gray-900 rounded-sm px-0.5",
}: {
  text: string | null | undefined;
  query: string | null | undefined;
  className?: string;
}): React.ReactElement {
  const safe = text ?? "";
  const tokens = (query ?? "")
    .split(/\s+/)
    .map((t) => t.trim())
    .filter((t) => t.length > 0);
  if (tokens.length === 0) return <>{safe}</>;

  // Collect non-overlapping match ranges for every token.
  const ranges: Array<[number, number]> = [];
  for (const t of tokens) {
    const r = computeMatchRange(safe, t);
    if (r) ranges.push(r);
  }
  if (ranges.length === 0) return <>{safe}</>;

  // Sort + merge overlapping ranges so we don't emit nested <mark>s.
  ranges.sort((a, b) => a[0] - b[0]);
  const merged: Array<[number, number]> = [];
  for (const [s, e] of ranges) {
    const last = merged[merged.length - 1];
    if (last && s <= last[1]) {
      last[1] = Math.max(last[1], e);
    } else {
      merged.push([s, e]);
    }
  }

  const out: React.ReactNode[] = [];
  let cursor = 0;
  merged.forEach(([s, e], i) => {
    if (s > cursor) out.push(safe.slice(cursor, s));
    out.push(
      <mark key={i} className={className}>
        {safe.slice(s, e)}
      </mark>,
    );
    cursor = e;
  });
  if (cursor < safe.length) out.push(safe.slice(cursor));
  return <>{out}</>;
}

/**
 * Compute [start, end) indices in `original` that correspond to the first
 * occurrence of `query` under the translit-aware normalization.
 * Returns null if no match.
 */
export function computeMatchRange(
  original: string,
  query: string,
): [number, number] | null {
  const qNorm = normalizeForSearch(query);
  if (!qNorm) return null;

  // Build haystack = concat(normalize(char_i) for each i) with index map.
  // Each normalized character gets back-mapped to its original position range.
  let haystack = "";
  const origStartFor: number[] = []; // haystack index → original start index
  const origEndFor: number[] = []; // haystack index → original end index (exclusive)

  for (let i = 0; i < original.length; i++) {
    const ch = original[i];
    const nrm = normalizeForSearch(ch);
    if (!nrm) continue;
    for (let k = 0; k < nrm.length; k++) {
      origStartFor.push(i);
      origEndFor.push(i + 1);
    }
    haystack += nrm;
  }

  const idx = haystack.indexOf(qNorm);
  if (idx < 0) return null;

  const start = origStartFor[idx];
  const end = origEndFor[idx + qNorm.length - 1];
  if (start === undefined || end === undefined) return null;
  return [start, end];
}
