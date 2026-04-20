import { toast as sonnerToast } from "sonner";

/**
 * Central toast helper. Wraps sonner with a Bulgarian-locale-friendly API.
 * Import { toast } from "@/lib/toast" instead of calling alert() or
 * window.confirm().
 */
export const toast = {
  success: (message: string, description?: string) =>
    sonnerToast.success(message, description ? { description } : undefined),
  error: (message: string, description?: string) =>
    sonnerToast.error(message, description ? { description } : undefined),
  info: (message: string, description?: string) =>
    sonnerToast.info(message, description ? { description } : undefined),
  warning: (message: string, description?: string) =>
    sonnerToast.warning(message, description ? { description } : undefined),
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
