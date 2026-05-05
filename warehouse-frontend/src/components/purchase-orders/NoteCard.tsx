import { useMemo } from "react";

interface NoteItem {
  product_id: number;
  product_name?: string;
  quantity: number;
}

export interface NoteCardData {
  id: number;
  label: string | null;
  created_at: string;
  items: NoteItem[];
  total_quantity: number;
  item_count: number;
}

interface NoteCardProps {
  note: NoteCardData;
  selected: boolean;
  onToggle: () => void;
  onOpen: () => void;
}

const VISIBLE_ITEMS = 3;

export function NoteCard({ note, selected, onToggle, onOpen }: NoteCardProps) {
  const visible = useMemo(
    () => note.items.slice(0, VISIBLE_ITEMS),
    [note.items],
  );
  const hidden = Math.max(0, note.items.length - VISIBLE_ITEMS);
  const tsLabel = formatShortDate(note.created_at);

  return (
    <div
      className={
        "relative flex flex-col bg-white border rounded-lg p-3 cursor-pointer transition-all " +
        (selected
          ? "border-[#f97316] ring-2 ring-orange-200"
          : "border-gray-200 hover:border-[#f97316]")
      }
      onClick={onOpen}
    >
      <button
        type="button"
        aria-label="Избери бележка"
        className={
          "absolute top-2.5 right-2.5 w-4 h-4 rounded border-[1.5px] flex items-center justify-center " +
          (selected
            ? "bg-[#f97316] border-[#f97316]"
            : "bg-white border-gray-300")
        }
        onClick={(e) => {
          e.stopPropagation();
          onToggle();
        }}
      >
        {selected && (
          <span className="block w-1 h-2 border-r-[1.5px] border-b-[1.5px] border-white rotate-45 -mt-0.5" />
        )}
      </button>

      <div className="flex justify-between items-center mb-1.5 pr-6">
        <span className="text-[11px] font-semibold text-gray-500">
          {note.label || "Бележка"}
        </span>
        <span className="text-[11px] text-gray-400">{tsLabel}</span>
      </div>

      <ul className="m-0 pl-3.5 text-xs leading-[1.55] text-gray-700 marker:text-[#f97316]">
        {visible.map((item, idx) => (
          <li key={`${item.product_id}-${idx}`}>
            {item.product_name ?? `Продукт #${item.product_id}`}{" "}
            <span className="font-semibold text-[#f97316]">
              ×{item.quantity}
            </span>
          </li>
        ))}
      </ul>

      <div className="flex justify-between items-center mt-2 pt-2 border-t border-dashed border-gray-200 text-[11px]">
        <span className="text-gray-500 font-medium">
          {note.item_count} продукта · {note.total_quantity} бр.
        </span>
        {hidden > 0 && (
          <span className="text-[#f97316] font-semibold">+ {hidden} още →</span>
        )}
      </div>
    </div>
  );
}

function formatShortDate(iso: string): string {
  const d = new Date(iso);
  const day = d.toLocaleDateString("bg-BG", { weekday: "short" });
  const time = d.toLocaleTimeString("bg-BG", {
    hour: "2-digit",
    minute: "2-digit",
  });
  return `${day} ${time}`;
}
