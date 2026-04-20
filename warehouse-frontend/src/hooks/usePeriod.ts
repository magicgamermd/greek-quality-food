import { useSearchParams } from "react-router-dom";

export type Period = "today" | "yesterday" | "week" | "month" | "custom";

export const PERIOD_LABELS: Record<Period, string> = {
  today: "Днес",
  yesterday: "Вчера",
  week: "Седмица",
  month: "Месец",
  custom: "Период",
};

/**
 * URL-synchronized period state, shared by owner pages so switching
 * period on Dashboard is preserved when navigating to Top / Payments.
 */
export function usePeriod(): {
  period: Period;
  from?: string;
  to?: string;
  setPeriod: (p: Period, range?: { from?: string; to?: string }) => void;
} {
  const [params, setParams] = useSearchParams();
  const period = (params.get("period") as Period) || "today";
  const from = params.get("from") || undefined;
  const to = params.get("to") || undefined;

  const setPeriod = (p: Period, range?: { from?: string; to?: string }) => {
    setParams(
      (prev) => {
        const next = new URLSearchParams(prev);
        next.set("period", p);
        if (p === "custom") {
          if (range?.from) next.set("from", range.from);
          if (range?.to) next.set("to", range.to);
        } else {
          next.delete("from");
          next.delete("to");
        }
        return next;
      },
      { replace: true },
    );
  };

  return { period, from, to, setPeriod };
}
