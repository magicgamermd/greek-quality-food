// Mirror of warehouse-backend/src/lib/invoice-payment-method.ts.
// Frontend has no shared package with backend, so the enum + labels are
// duplicated. Keep in sync.

export const INVOICE_PAYMENT_METHODS = ["cash", "bank", "cod"] as const;

export type InvoicePaymentMethod = (typeof INVOICE_PAYMENT_METHODS)[number];

export const INVOICE_PAYMENT_METHOD_LABELS: Record<
  InvoicePaymentMethod,
  string
> = {
  cash: "В брой",
  bank: "Банков превод",
  cod: "Наложен платеж",
};

export const INVOICE_PAYMENT_METHOD_OPTIONS: ReadonlyArray<{
  value: InvoicePaymentMethod;
  label: string;
}> = INVOICE_PAYMENT_METHODS.map((value) => ({
  value,
  label: INVOICE_PAYMENT_METHOD_LABELS[value],
}));
