import * as React from "react";
import { Input } from "@/components/ui/input";

/**
 * Smart date input — accepts `DD.MM.YY` or `DD.MM.YYYY` and auto-expands
 * 2-digit year to `20YY`. Emits ISO `YYYY-MM-DD` to parent. Compatible with
 * all keyboard flows (Enter/Tab supported via onKeyDown passthrough).
 */
export const SmartDateInput = React.forwardRef<
  HTMLInputElement,
  {
    value: string; // ISO YYYY-MM-DD or empty
    onChange: (iso: string) => void;
    onKeyDown?: (e: React.KeyboardEvent<HTMLInputElement>) => void;
    disabled?: boolean;
    className?: string;
    placeholder?: string;
  }
>(({ value, onChange, onKeyDown, disabled, className, placeholder }, ref) => {
  const isoToDot = (iso: string): string => {
    if (!iso) return "";
    const parts = iso.split("T")[0].split("-");
    if (parts.length !== 3) return "";
    return `${parts[2]}.${parts[1]}.${parts[0]}`;
  };

  const [display, setDisplay] = React.useState(() => isoToDot(value));
  const innerRef = React.useRef<HTMLInputElement | null>(null);

  // Sync from parent when not focused
  React.useEffect(() => {
    const dotted = isoToDot(value);
    if (document.activeElement !== innerRef.current && dotted !== display) {
      setDisplay(dotted);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [value]);

  const parseAndEmit = (text: string) => {
    const digits = text.replace(/\./g, "").replace(/\D/g, "");
    // Only emit when we have a complete date (6 or 8 digits).
    // For partial input (1-5 or 7 digits) do NOT call onChange — avoid
    // wiping out a previously-valid ISO the parent is holding.
    if (digits.length !== 6 && digits.length !== 8) {
      // Emit empty only when user fully clears the field
      if (digits.length === 0) onChange("");
      return;
    }
    const dd = digits.slice(0, 2);
    const mm = digits.slice(2, 4);
    const yyyy =
      digits.length === 6 ? `20${digits.slice(4, 6)}` : digits.slice(4, 8);
    const day = parseInt(dd, 10);
    const mon = parseInt(mm, 10);
    if (day < 1 || day > 31 || mon < 1 || mon > 12 || !/^\d{4}$/.test(yyyy)) {
      onChange("");
      return;
    }
    onChange(`${yyyy}-${mm}-${dd}`);
  };

  const handleChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const raw = e.target.value;
    const digits = raw.replace(/[^\d]/g, "").slice(0, 8);
    let formatted = "";
    if (digits.length <= 2) formatted = digits;
    else if (digits.length <= 4)
      formatted = `${digits.slice(0, 2)}.${digits.slice(2)}`;
    else
      formatted = `${digits.slice(0, 2)}.${digits.slice(2, 4)}.${digits.slice(4)}`;
    setDisplay(formatted);
    parseAndEmit(formatted);
  };

  const handleBlur = () => {
    const digits = display.replace(/\./g, "");
    if (digits.length === 6) {
      // Expand YY → 20YY both in display AND emit the full ISO
      const expanded = `${digits.slice(0, 2)}.${digits.slice(2, 4)}.20${digits.slice(4, 6)}`;
      setDisplay(expanded);
      parseAndEmit(expanded);
    }
  };

  return (
    <Input
      ref={(el) => {
        innerRef.current = el;
        if (typeof ref === "function") ref(el);
        else if (ref)
          (ref as React.MutableRefObject<HTMLInputElement | null>).current = el;
      }}
      type="text"
      inputMode="numeric"
      value={display}
      onChange={handleChange}
      onBlur={handleBlur}
      onKeyDown={onKeyDown}
      disabled={disabled}
      className={className}
      placeholder={placeholder ?? "ДД.ММ.ГГ"}
      maxLength={10}
    />
  );
});
SmartDateInput.displayName = "SmartDateInput";
