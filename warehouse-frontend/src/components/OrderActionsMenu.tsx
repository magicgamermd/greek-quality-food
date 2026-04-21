import { useState, useRef, useEffect } from "react";
import { MoreVertical } from "lucide-react";
import type { Order } from "@/types";

interface Props {
  order: Order;
  onRecordPayment: (order: Order) => void;
}

export function OrderActionsMenu({ order, onRecordPayment }: Props) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const handler = (e: MouseEvent) => {
      if (!ref.current?.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener("mousedown", handler);
    return () => document.removeEventListener("mousedown", handler);
  }, [open]);

  const cancelled = order.status === "cancelled";

  return (
    <div ref={ref} className="relative inline-block">
      <button
        type="button"
        onClick={(e) => {
          e.stopPropagation();
          setOpen((v) => !v);
        }}
        className="p-1 hover:bg-gray-100 rounded"
        aria-label="Действия"
        title="Действия"
      >
        <MoreVertical className="h-4 w-4" />
      </button>
      {open && (
        <div className="absolute right-0 top-full mt-1 z-50 bg-white border rounded-lg shadow-lg py-1 min-w-[180px]">
          <button
            type="button"
            className="w-full text-left px-3 py-1.5 text-sm hover:bg-gray-50 disabled:opacity-50 disabled:cursor-not-allowed"
            disabled={cancelled}
            title={cancelled ? "Анулирана поръчка" : undefined}
            onClick={(e) => {
              e.stopPropagation();
              onRecordPayment(order);
              setOpen(false);
            }}
          >
            Запиши плащане
          </button>
        </div>
      )}
    </div>
  );
}
