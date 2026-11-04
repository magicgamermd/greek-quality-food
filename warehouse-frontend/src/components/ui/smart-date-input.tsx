import * as React from "react";
import { Input } from "@/components/ui/input";
import { dottedFromIso, isoFromDottedDate } from "@/lib/dateInput";

/**
 * Дата като ДД.ММ.ГГГГ (срок на годност в доставката) — независимо от
 * езика на браузъра; родният календар показва мм/дд/гггг на английски
 * Chrome. Точките се слагат сами, „ДД.ММ.ГГ“ става 20ГГ при излизане.
 * Нагоре праща ISO `YYYY-MM-DD`; "" при изтрито поле или невъзможна дата
 * (31.02), която се вижда в червено. Enter/Tab минават през onKeyDown.
 */
export const SmartDateInput = React.forwardRef<
  HTMLInputElement,
  {
    value: string; // ISO YYYY-MM-DD (или „18-07-27“ от сканиране) или ""
    onChange: (iso: string) => void;
    onKeyDown?: (e: React.KeyboardEvent<HTMLInputElement>) => void;
    disabled?: boolean;
    className?: string;
    placeholder?: string;
    "aria-label"?: string;
  }
>(
  (
    {
      value,
      onChange,
      onKeyDown,
      disabled,
      className,
      placeholder,
      "aria-label": ariaLabel,
    },
    ref,
  ) => {
    const [display, setDisplay] = React.useState(() => dottedFromIso(value));
    const innerRef = React.useRef<HTMLInputElement | null>(null);

    // Стойността отвън (зареждане, сканиране) — само докато не се пише.
    React.useEffect(() => {
      const dotted = dottedFromIso(value);
      if (document.activeElement !== innerRef.current && dotted !== display) {
        setDisplay(dotted);
      }
      // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [value]);

    const digits = display.replace(/\D/g, "");
    const complete = digits.length === 6 || digits.length === 8;
    const invalid = complete && isoFromDottedDate(display) === null;

    const emit = (text: string) => {
      const count = text.replace(/\D/g, "").length;
      if (count === 0) {
        onChange("");
        return;
      }
      // Непълна дата не трие валидната стойност горе.
      if (count !== 6 && count !== 8) return;
      onChange(isoFromDottedDate(text) ?? "");
    };

    const handleChange = (e: React.ChangeEvent<HTMLInputElement>) => {
      const typed = e.target.value.replace(/\D/g, "").slice(0, 8);
      const formatted =
        typed.length <= 2
          ? typed
          : typed.length <= 4
            ? `${typed.slice(0, 2)}.${typed.slice(2)}`
            : `${typed.slice(0, 2)}.${typed.slice(2, 4)}.${typed.slice(4)}`;
      setDisplay(formatted);
      emit(formatted);
    };

    const handleBlur = () => {
      // ДД.ММ.ГГ → ДД.ММ.20ГГ и на екрана.
      if (digits.length === 6) {
        const expanded = `${digits.slice(0, 2)}.${digits.slice(2, 4)}.20${digits.slice(4, 6)}`;
        setDisplay(expanded);
        emit(expanded);
      }
    };

    return (
      <Input
        ref={(el) => {
          innerRef.current = el;
          if (typeof ref === "function") ref(el);
          else if (ref)
            (ref as React.MutableRefObject<HTMLInputElement | null>).current =
              el;
        }}
        type="text"
        inputMode="numeric"
        autoComplete="off"
        value={display}
        onChange={handleChange}
        onBlur={handleBlur}
        onKeyDown={onKeyDown}
        disabled={disabled}
        aria-label={ariaLabel}
        aria-invalid={invalid || undefined}
        title={invalid ? "Невъзможна дата" : undefined}
        className={`${className ?? ""} ${invalid ? "border-red-500 text-red-600" : ""}`}
        placeholder={placeholder ?? "ДД.ММ.ГГГГ"}
        maxLength={10}
      />
    );
  },
);
SmartDateInput.displayName = "SmartDateInput";
