// Single source of truth for invoice "Начин на плащане" values.
// Distinct from payments.payment_method (which records HOW a payment was
// actually executed). This describes the payment basis printed on the
// invoice PDF — what the buyer is asked to do.

import { z } from "zod";

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

export const invoicePaymentMethodSchema = z
  .enum(INVOICE_PAYMENT_METHODS)
  .default("bank");
