import { toast as sonnerToast } from "sonner";

type ToastAction = { label: string; onClick: () => void };
type ToastOpts = {
  description?: string;
  duration?: number;
  action?: ToastAction;
};

const normalize = (opt?: string | ToastOpts): ToastOpts | undefined => {
  if (opt == null) return undefined;
  if (typeof opt === "string") return { description: opt };
  return opt;
};

/**
 * Central toast helper. Wraps sonner with a Bulgarian-locale-friendly API.
 * Import { toast } from "@/lib/toast" instead of calling alert() or
 * window.confirm().
 *
 * Second arg accepts either a description string (shorthand) or an options
 * object with { description?, duration? }.
 */
export const toast = {
  success: (message: string, opt?: string | ToastOpts) =>
    sonnerToast.success(message, normalize(opt)),
  error: (message: string, opt?: string | ToastOpts) =>
    sonnerToast.error(message, normalize(opt)),
  info: (message: string, opt?: string | ToastOpts) =>
    sonnerToast.info(message, normalize(opt)),
  warning: (message: string, opt?: string | ToastOpts) =>
    sonnerToast.warning(message, normalize(opt)),
  message: (message: string) => sonnerToast(message),
  /** Fire-and-forget promise wrapper with loading → success/error states */
  promise: <T>(
    promise: Promise<T>,
    opts: {
      loading: string;
      success: string | ((data: T) => string);
      error: string | ((err: unknown) => string);
    },
  ) => sonnerToast.promise(promise, opts),
};

export { sonnerToast };
