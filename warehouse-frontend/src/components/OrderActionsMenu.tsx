import { useState, useRef, useEffect, useLayoutEffect } from "react";
import { createPortal } from "react-dom";
import { MoreVertical } from "lucide-react";
import type { Order } from "@/types";

interface Props {
  order: Order;
  onRecordPayment: (order: Order) => void;
}

const MENU_W = 180;
const MENU_H = 40; // single-item menu, ~40px tall
const GAP = 4;

export function OrderActionsMenu({ order, onRecordPayment }: Props) {
  const [open, setOpen] = useState(false);
  const [pos, setPos] = useState<{ top: number; left: number } | null>(null);
  const btnRef = useRef<HTMLButtonElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);

  // Position the menu relative to the button via getBoundingClientRect.
  // Rendered through a portal so it isn't clipped by the table's
  // overflow container — the row's own height isn't enough for an
  // absolute-positioned dropdown when there's only one row.
  useLayoutEffect(() => {
    if (!open || !btnRef.current) return;
    const r = btnRef.current.getBoundingClientRect();
    const vh = window.innerHeight;
    const vw = window.innerWidth;
    // Flip up when there's not enough room below the button.
    const openUp = r.bottom + GAP + MENU_H > vh;
    const top = openUp ? r.top - GAP - MENU_H : r.bottom + GAP;
    // Right-align with the button; clamp to viewport.
    const rawLeft = r.right - MENU_W;
    const left = Math.max(8, Math.min(rawLeft, vw - MENU_W - 8));
    setPos({ top, left });
  }, [open]);

  useEffect(() => {
    if (!open) return;
    const handler = (e: MouseEvent) => {
      const target = e.target as Node;
      if (btnRef.current?.contains(target)) return;
      if (menuRef.current?.contains(target)) return;
      setOpen(false);
    };
    const onScroll = () => setOpen(false);
    document.addEventListener("mousedown", handler);
    window.addEventListener("scroll", onScroll, true);
    window.addEventListener("resize", onScroll);
    return () => {
      document.removeEventListener("mousedown", handler);
      window.removeEventListener("scroll", onScroll, true);
      window.removeEventListener("resize", onScroll);
    };
  }, [open]);

  const cancelled = order.status === "cancelled";

  return (
    <>
      <button
        ref={btnRef}
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
      {open &&
        pos &&
        createPortal(
          <div
            ref={menuRef}
            style={{
              position: "fixed",
              top: pos.top,
              left: pos.left,
              width: MENU_W,
              zIndex: 1000,
            }}
            className="bg-white border rounded-lg shadow-lg py-1"
          >
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
          </div>,
          document.body,
        )}
    </>
  );
}
