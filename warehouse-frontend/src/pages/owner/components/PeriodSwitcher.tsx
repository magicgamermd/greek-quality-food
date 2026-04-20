import { type Period, PERIOD_LABELS } from "@/hooks/usePeriod";
import { cn } from "@/lib/utils";

const ORDER: Period[] = ["today", "yesterday", "week", "month"];

export function PeriodSwitcher({
  value,
  onChange,
}: {
  value: Period;
  onChange: (p: Period) => void;
}) {
  return (
    <div className="flex gap-1 p-1 rounded-xl bg-[#12162a] border border-[#243055]">
      {ORDER.map((p) => (
        <button
          key={p}
          type="button"
          onClick={() => onChange(p)}
          className={cn(
            "flex-1 px-3 py-1.5 text-xs font-medium rounded-lg transition-colors",
            value === p
              ? "bg-[#4f7cff] text-white shadow-sm"
              : "text-[#9aa8d6] hover:text-[#f3f6ff] hover:bg-[#161c34]",
          )}
        >
          {PERIOD_LABELS[p]}
        </button>
      ))}
    </div>
  );
}
