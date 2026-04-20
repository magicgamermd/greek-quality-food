import { useEffect, useState } from "react";

/**
 * Returns `value` after it has stayed unchanged for `delay` ms.
 * Use to throttle server-side search queries so typing doesn't hammer the API.
 *
 * @example
 * const [search, setSearch] = useState("");
 * const debouncedSearch = useDebouncedValue(search, 300);
 * useQuery({ queryKey: ["partners", debouncedSearch], ... });
 */
export function useDebouncedValue<T>(value: T, delay = 300): T {
  const [debounced, setDebounced] = useState(value);

  useEffect(() => {
    const timer = window.setTimeout(() => setDebounced(value), delay);
    return () => window.clearTimeout(timer);
  }, [value, delay]);

  return debounced;
}
