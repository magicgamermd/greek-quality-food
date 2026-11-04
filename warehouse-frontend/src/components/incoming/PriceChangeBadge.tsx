import { cn } from "@/lib/utils";
import { formatPriceChange, type PriceChange } from "@/lib/priceChange";

// Малкият знак до „Ед. цена“: кехлибарен при поскъпване, зелен при
// поевтиняване. Само предупреждение — продажните цени не се пипат.
export function PriceChangeBadge({
  change,
  className,
}: {
  change: PriceChange | null;
  className?: string;
}) {
  if (!change) return null;
  const up = change.direction === "up";
  const text = formatPriceChange(change);
  return (
    <span
      className={cn(
        "inline-flex items-center rounded border px-1.5 py-0.5 text-[11px] font-medium leading-tight whitespace-nowrap tabular-nums",
        up
          ? "border-amber-300 bg-amber-50 text-amber-800"
          : "border-emerald-300 bg-emerald-50 text-emerald-800",
        className,
      )}
      title={`Нова доставна цена (последна → тази доставка). ${
        up ? "Поскъпване" : "Поевтиняване"
      } — провери продажната цена.`}
      aria-label={`${up ? "Поскъпване" : "Поевтиняване"} на доставната цена: ${text}`}
    >
      {text}
    </span>
  );
}
