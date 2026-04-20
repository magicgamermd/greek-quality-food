import { useCallback, useMemo } from "react";
import { useSearchParams } from "react-router-dom";

/**
 * URL-synchronized state for filter/search values.
 *
 * - Reads initial values from `?key=value` query params.
 * - Writes back to the URL via `replaceState` (no history spam).
 * - Unknown keys in the URL are preserved (no destructive clears).
 *
 * @example
 * const [filters, setFilters] = useUrlState({ search: "", category: "" });
 * setFilters({ search: "bakalia" });  // URL: ?search=bakalia&category=
 *
 * Note: empty string or undefined values are dropped from the URL to keep it clean.
 */
export function useUrlState<T extends Record<string, string>>(
  defaults: T,
): [T, (patch: Partial<T>) => void] {
  const [searchParams, setSearchParams] = useSearchParams();

  // Read current values — fallback to defaults for missing keys
  const current = useMemo(() => {
    const out = { ...defaults };
    for (const key of Object.keys(defaults) as Array<keyof T>) {
      const urlVal = searchParams.get(String(key));
      if (urlVal !== null) {
        (out as Record<string, string>)[String(key)] = urlVal;
      }
    }
    return out;
  }, [searchParams, defaults]);

  const patch = useCallback(
    (update: Partial<T>) => {
      setSearchParams(
        (prev) => {
          const next = new URLSearchParams(prev);
          for (const [key, value] of Object.entries(update)) {
            if (value === undefined || value === null || value === "") {
              next.delete(key);
            } else {
              next.set(key, String(value));
            }
          }
          return next;
        },
        { replace: true },
      );
    },
    [setSearchParams],
  );

  return [current, patch];
}
