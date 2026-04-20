import * as React from "react";
import { createRoot, type Root } from "react-dom/client";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DialogFooter,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";

type Variant = "default" | "danger";

interface ConfirmOptions {
  title?: string;
  description?: string;
  confirmText?: string;
  cancelText?: string;
  variant?: Variant;
}

interface PromptOptions extends Omit<ConfirmOptions, "variant"> {
  /** Initial value for the input */
  defaultValue?: string;
  placeholder?: string;
  /** Minimum characters required to enable confirm (default 0 = any length) */
  minLength?: number;
}

interface ConfirmDialogProps extends ConfirmOptions {
  open: boolean;
  onClose: (result: boolean) => void;
}

interface PromptDialogProps extends PromptOptions {
  open: boolean;
  onClose: (result: string | null) => void;
}

function ConfirmDialog({
  open,
  onClose,
  title = "Потвърждение",
  description,
  confirmText = "Потвърди",
  cancelText = "Отказ",
  variant = "default",
}: ConfirmDialogProps) {
  const cancelRef = React.useRef<HTMLButtonElement>(null);

  // Auto-focus the safe "Cancel" button on open — prevents accidental
  // confirmation if user reflexively presses Enter.
  React.useEffect(() => {
    if (open) {
      const t = setTimeout(() => cancelRef.current?.focus(), 50);
      return () => clearTimeout(t);
    }
  }, [open]);

  return (
    <Dialog open={open} onOpenChange={(o) => !o && onClose(false)}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>{title}</DialogTitle>
          {description && <DialogDescription>{description}</DialogDescription>}
        </DialogHeader>
        <DialogFooter className="gap-2">
          <Button
            ref={cancelRef}
            variant="outline"
            onClick={() => onClose(false)}
          >
            {cancelText}
          </Button>
          <Button
            onClick={() => onClose(true)}
            className={
              variant === "danger"
                ? "bg-red-600 hover:bg-red-700 text-white"
                : undefined
            }
          >
            {confirmText}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function PromptDialog({
  open,
  onClose,
  title = "Въведете стойност",
  description,
  confirmText = "Потвърди",
  cancelText = "Отказ",
  defaultValue = "",
  placeholder,
  minLength = 0,
}: PromptDialogProps) {
  const [value, setValue] = React.useState(defaultValue);
  const inputRef = React.useRef<HTMLInputElement>(null);

  React.useEffect(() => {
    if (open) {
      setValue(defaultValue);
      const t = setTimeout(() => {
        inputRef.current?.focus();
        inputRef.current?.select();
      }, 50);
      return () => clearTimeout(t);
    }
  }, [open, defaultValue]);

  const canSubmit = value.trim().length >= minLength;

  return (
    <Dialog open={open} onOpenChange={(o) => !o && onClose(null)}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>{title}</DialogTitle>
          {description && <DialogDescription>{description}</DialogDescription>}
        </DialogHeader>
        <div className="space-y-2">
          <Label htmlFor="prompt-input" className="sr-only">
            {title}
          </Label>
          <Input
            id="prompt-input"
            ref={inputRef}
            value={value}
            onChange={(e) => setValue(e.target.value)}
            placeholder={placeholder}
            onKeyDown={(e) => {
              if (e.key === "Enter" && canSubmit) onClose(value);
            }}
          />
        </div>
        <DialogFooter className="gap-2">
          <Button variant="outline" onClick={() => onClose(null)}>
            {cancelText}
          </Button>
          <Button onClick={() => onClose(value)} disabled={!canSubmit}>
            {confirmText}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

// Module-level singleton root to avoid leaking mount nodes
let containerEl: HTMLDivElement | null = null;
let reactRoot: Root | null = null;

function ensureRoot(): Root {
  if (reactRoot) return reactRoot;
  containerEl = document.createElement("div");
  containerEl.setAttribute("data-confirm-dialog-root", "");
  document.body.appendChild(containerEl);
  reactRoot = createRoot(containerEl);
  return reactRoot;
}

/**
 * Imperative replacement for window.confirm(). Returns Promise<boolean>.
 *
 * Usage:
 *   if (await confirm({ title: "Изтриване?", variant: "danger" })) {
 *     deleteMutation.mutate(id);
 *   }
 */
export function confirm(options: ConfirmOptions = {}): Promise<boolean> {
  return new Promise((resolve) => {
    const root = ensureRoot();

    const handleClose = (result: boolean) => {
      // Re-render as closed so the dialog exit animation can run
      root.render(
        <ConfirmDialog {...options} open={false} onClose={() => {}} />,
      );
      // Clean up after animation
      setTimeout(() => resolve(result), 150);
    };

    root.render(
      <ConfirmDialog {...options} open={true} onClose={handleClose} />,
    );
  });
}

/**
 * Imperative replacement for window.prompt(). Returns Promise<string | null>
 * (null when cancelled; string when confirmed, even if empty).
 *
 * Usage:
 *   const reason = await prompt({ title: "Причина", minLength: 2 });
 *   if (reason !== null) { ... }
 */
export function prompt(options: PromptOptions = {}): Promise<string | null> {
  return new Promise((resolve) => {
    const root = ensureRoot();

    const handleClose = (result: string | null) => {
      root.render(
        <PromptDialog {...options} open={false} onClose={() => {}} />,
      );
      setTimeout(() => resolve(result), 150);
    };

    root.render(
      <PromptDialog {...options} open={true} onClose={handleClose} />,
    );
  });
}
