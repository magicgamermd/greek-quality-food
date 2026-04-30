import * as React from "react";
import { createPortal } from "react-dom";
import { Input } from "@/components/ui/input";
import { cn } from "@/lib/utils";
import { matchesSearch } from "@/lib/translit";
import { HighlightMatch } from "@/lib/highlight";

export interface ComboboxItem<T = unknown> {
  value: string;
  label: string;
  hint?: string;
  data?: T;
}

export interface ComboboxProps<T = unknown> {
  items: ComboboxItem<T>[];
  value: string | null | undefined;
  onChange: (value: string, item: ComboboxItem<T>) => void;
  onClear?: () => void;
  placeholder?: string;
  emptyMessage?: string;
  className?: string;
  inputClassName?: string;
  disabled?: boolean;
  /** Called on Enter when an item is picked — useful for "advance to next field" */
  onPickEnter?: () => void;
  /** Reference forwarded to the underlying input */
  inputRef?: React.Ref<HTMLInputElement>;
  /** Filter predicate override (default: case-insensitive substring match on label + hint) */
  filter?: (item: ComboboxItem<T>, query: string) => boolean;
  /** When true, input is resized to the label when selected (not filter query) */
  size?: "default" | "lg";
  /** Visual theme — "dark" matches the owner PWA dark surfaces */
  variant?: "light" | "dark";
}

/**
 * Searchable, keyboard-navigable combobox.
 * - Type to filter
 * - ↑/↓ to highlight
 * - Enter to select the highlighted item
 * - Escape to close
 */
export function Combobox<T = unknown>({
  items,
  value,
  onChange,
  onClear,
  placeholder,
  emptyMessage = "Няма намерени резултати.",
  className,
  inputClassName,
  disabled,
  onPickEnter,
  inputRef,
  filter,
  size = "default",
  variant = "light",
}: ComboboxProps<T>) {
  const isDark = variant === "dark";
  const [open, setOpen] = React.useState(false);
  const [query, setQuery] = React.useState("");
  const [highlight, setHighlight] = React.useState(0);
  const boxRef = React.useRef<HTMLDivElement>(null);
  // The portal-rendered dropdown lives outside boxRef, so the outside-click
  // handler must also consider it "inside" — otherwise mousedown on an
  // option closes the menu before the click event reaches the button.
  const dropdownRef = React.useRef<HTMLDivElement>(null);
  // Position of the input (for the portal-rendered dropdown). Recalculated
  // on open / scroll / resize so the dropdown stays glued to the input even
  // when the page underneath scrolls.
  const [dropdownPos, setDropdownPos] = React.useState<{
    top: number;
    left: number;
    width: number;
  } | null>(null);

  const updateDropdownPos = React.useCallback(() => {
    if (!boxRef.current) return;
    const rect = boxRef.current.getBoundingClientRect();
    setDropdownPos({
      top: rect.bottom + 4,
      left: rect.left,
      width: rect.width,
    });
  }, []);

  React.useEffect(() => {
    if (!open) return;
    updateDropdownPos();
    const handler = () => updateDropdownPos();
    window.addEventListener("scroll", handler, true);
    window.addEventListener("resize", handler);
    return () => {
      window.removeEventListener("scroll", handler, true);
      window.removeEventListener("resize", handler);
    };
  }, [open, updateDropdownPos]);

  const selectedItem = React.useMemo(
    () => items.find((i) => i.value === value) ?? null,
    [items, value],
  );

  // Track whether we just had a selection — onClear should fire ONLY on
  // the first keystroke after a selection (the "user is replacing it"
  // transition), not on every subsequent character.
  const hadSelectionRef = React.useRef<boolean>(Boolean(selectedItem));
  React.useEffect(() => {
    hadSelectionRef.current = Boolean(selectedItem);
  }, [selectedItem]);

  const defaultFilter = React.useCallback(
    (item: ComboboxItem<T>, q: string) => {
      if (!q) return true;
      // Cyrillic/Latin/Greek transliteration-aware match
      return matchesSearch(`${item.label} ${item.hint ?? ""}`, q);
    },
    [],
  );

  const filtered = React.useMemo(() => {
    const f = filter ?? defaultFilter;
    return items.filter((item) => f(item, query));
  }, [items, query, filter, defaultFilter]);

  // Clamp highlight when filtered changes
  React.useEffect(() => {
    if (highlight >= filtered.length) {
      setHighlight(Math.max(0, filtered.length - 1));
    }
  }, [filtered.length, highlight]);

  // Close on outside click — but treat the portalled dropdown as "inside"
  React.useEffect(() => {
    if (!open) return;
    const handleClick = (e: MouseEvent) => {
      const target = e.target as Node;
      const inBox = boxRef.current?.contains(target);
      const inDropdown = dropdownRef.current?.contains(target);
      if (!inBox && !inDropdown) {
        setOpen(false);
      }
    };
    document.addEventListener("mousedown", handleClick);
    return () => document.removeEventListener("mousedown", handleClick);
  }, [open]);

  const selectItem = (item: ComboboxItem<T>, viaEnter = false) => {
    onChange(item.value, item);
    setOpen(false);
    setQuery("");
    if (viaEnter && onPickEnter) onPickEnter();
  };

  const handleKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key === "ArrowDown") {
      if (!open) {
        setOpen(true);
        return;
      }
      if (filtered.length === 0) return;
      e.preventDefault();
      setHighlight((h) => Math.min(h + 1, filtered.length - 1));
      return;
    }
    if (e.key === "ArrowUp") {
      if (filtered.length === 0) return;
      e.preventDefault();
      setHighlight((h) => Math.max(h - 1, 0));
      return;
    }
    if (e.key === "Escape") {
      if (open) {
        e.preventDefault();
        setOpen(false);
      }
      return;
    }
    if (e.key === "Enter") {
      if (open && filtered.length > 0) {
        e.preventDefault();
        const pick = filtered[Math.min(highlight, filtered.length - 1)];
        selectItem(pick, true);
        return;
      }
      // Already selected and closed — let parent advance focus
      if (!open && selectedItem && onPickEnter) {
        e.preventDefault();
        onPickEnter();
      }
    }
  };

  const displayValue = open ? query : (selectedItem?.label ?? query);

  // Unique IDs for WAI-ARIA relationships
  const reactId = React.useId();
  const listboxId = `combobox-listbox-${reactId}`;
  const getOptionId = (idx: number) => `combobox-option-${reactId}-${idx}`;
  const activeDescendantId =
    open && filtered.length > 0 ? getOptionId(highlight) : undefined;

  return (
    <div className={cn("relative", className)} ref={boxRef}>
      <Input
        ref={inputRef}
        disabled={disabled}
        className={cn(
          size === "lg" ? "h-12 text-base" : "h-11",
          isDark &&
            "bg-[#12162a] border-[#243055] text-[#f3f6ff] placeholder:text-[#6b7692] focus-visible:ring-[#4f7cff]",
          inputClassName,
        )}
        value={displayValue}
        // WAI-ARIA combobox pattern (1.2)
        role="combobox"
        aria-expanded={open}
        aria-controls={listboxId}
        aria-autocomplete="list"
        aria-activedescendant={activeDescendantId}
        autoComplete="off"
        onChange={(e) => {
          setQuery(e.target.value);
          setOpen(true);
          setHighlight(0);
          // Only clear when transitioning FROM "has selection" TO "user is typing"
          // — not on every subsequent keystroke after the selection was cleared.
          if (selectedItem && onClear && hadSelectionRef.current) {
            onClear();
            hadSelectionRef.current = false;
          }
        }}
        onClick={() => {
          setOpen(true);
          if (selectedItem) {
            setQuery(selectedItem.label);
          }
        }}
        onKeyDown={handleKeyDown}
        placeholder={placeholder}
      />
      {open &&
        dropdownPos &&
        createPortal(
          <div
            ref={dropdownRef}
            id={listboxId}
            role="listbox"
            // Fixed positioning + portal to <body> escapes any clipping
            // dialog/scroll container above us. z-index sits above Radix
            // Dialog overlay (z-50). pointerEvents:auto breaks inheritance
            // when a modal Radix Dialog sets body{pointer-events:none} —
            // without it, real mouse clicks pass *through* the dropdown to
            // whatever sits underneath (often the dialog's Cancel button),
            // closing the dialog without selecting an option.
            style={{
              position: "fixed",
              top: dropdownPos.top,
              left: dropdownPos.left,
              width: dropdownPos.width,
              zIndex: 100,
              pointerEvents: "auto",
            }}
            // Prevent Radix Dialog's outside-click handler from closing the
            // dialog when user clicks inside the portalled dropdown — Radix
            // treats portal content as "outside" by default.
            onMouseDown={(e) => e.stopPropagation()}
            onPointerDown={(e) => e.stopPropagation()}
            className={cn(
              "border rounded-md shadow-lg max-h-72 overflow-y-auto",
              isDark
                ? "bg-[#12162a] border-[#243055]"
                : "bg-white border-gray-200",
            )}
          >
            {filtered.length === 0 ? (
              <div
                className={cn(
                  "px-4 py-3 text-sm",
                  isDark ? "text-[#9aa8d6]" : "text-gray-500",
                )}
                role="status"
              >
                {emptyMessage}
              </div>
            ) : (
              filtered.map((item, idx) => {
                const isHighlighted = idx === highlight;
                const isSelected = item.value === value;
                return (
                  <button
                    key={item.value}
                    id={getOptionId(idx)}
                    type="button"
                    role="option"
                    aria-selected={isSelected}
                    ref={(el) => {
                      if (el && isHighlighted) {
                        el.scrollIntoView({ block: "nearest" });
                      }
                    }}
                    className={cn(
                      "w-full text-left px-4 py-2.5 text-sm",
                      isDark
                        ? isHighlighted
                          ? "bg-[#4f7cff]/20"
                          : "hover:bg-[#161c34]"
                        : isHighlighted
                          ? "bg-emerald-50"
                          : "hover:bg-gray-50",
                      isSelected && !isHighlighted && "font-medium",
                    )}
                    onMouseEnter={() => setHighlight(idx)}
                    // onMouseDown (not onClick) — fires synchronously before
                    // any focus-loss / outside-click handler could close the
                    // dropdown. preventDefault avoids stealing focus from
                    // the input so blur doesn't reset state mid-click.
                    onMouseDown={(e) => {
                      e.preventDefault();
                      selectItem(item);
                    }}
                  >
                    <div
                      className={isDark ? "text-[#f3f6ff]" : "text-gray-900"}
                    >
                      <HighlightMatch text={item.label} query={query} />
                    </div>
                    {item.hint ? (
                      <div
                        className={cn(
                          "text-xs mt-0.5",
                          isDark ? "text-[#9aa8d6]" : "text-gray-500",
                        )}
                      >
                        <HighlightMatch text={item.hint} query={query} />
                      </div>
                    ) : null}
                  </button>
                );
              })
            )}
          </div>,
          document.body,
        )}
    </div>
  );
}
