import { describe, it, expect } from "vitest";
import { z } from "zod";

// Replicate schemas from invoices.ts for unit testing
const createInvoiceSchema = z.object({
  order_id: z.number().int(),
  vat_rate: z.number().default(20),
  include_vat: z.boolean().default(true),
});

const createCreditNoteSchema = z.object({
  related_invoice_id: z.number().int(),
  reason: z.string().min(1),
  include_vat: z.boolean().optional(),
});

describe("createInvoiceSchema", () => {
  it("should accept valid input with all fields", () => {
    const result = createInvoiceSchema.parse({
      order_id: 1,
      vat_rate: 20,
      include_vat: true,
    });
    expect(result.order_id).toBe(1);
    expect(result.vat_rate).toBe(20);
    expect(result.include_vat).toBe(true);
  });

  it("should default include_vat to true", () => {
    const result = createInvoiceSchema.parse({ order_id: 1 });
    expect(result.include_vat).toBe(true);
    expect(result.vat_rate).toBe(20);
  });

  it("should accept include_vat=false", () => {
    const result = createInvoiceSchema.parse({
      order_id: 1,
      include_vat: false,
    });
    expect(result.include_vat).toBe(false);
  });

  it("should default vat_rate to 20", () => {
    const result = createInvoiceSchema.parse({ order_id: 1 });
    expect(result.vat_rate).toBe(20);
  });

  it("should reject non-integer order_id", () => {
    expect(() => createInvoiceSchema.parse({ order_id: 1.5 })).toThrow();
  });

  it("should reject missing order_id", () => {
    expect(() => createInvoiceSchema.parse({})).toThrow();
  });
});

describe("createCreditNoteSchema", () => {
  it("should accept valid input", () => {
    const result = createCreditNoteSchema.parse({
      related_invoice_id: 1,
      reason: "Returned goods",
    });
    expect(result.related_invoice_id).toBe(1);
    expect(result.reason).toBe("Returned goods");
    expect(result.include_vat).toBeUndefined();
  });

  it("should accept include_vat override", () => {
    const result = createCreditNoteSchema.parse({
      related_invoice_id: 1,
      reason: "Discount adjustment",
      include_vat: false,
    });
    expect(result.include_vat).toBe(false);
  });

  it("should reject empty reason", () => {
    expect(() =>
      createCreditNoteSchema.parse({
        related_invoice_id: 1,
        reason: "",
      }),
    ).toThrow();
  });

  it("should reject missing related_invoice_id", () => {
    expect(() =>
      createCreditNoteSchema.parse({
        reason: "test",
      }),
    ).toThrow();
  });

  it("should reject non-integer related_invoice_id", () => {
    expect(() =>
      createCreditNoteSchema.parse({
        related_invoice_id: 1.5,
        reason: "test",
      }),
    ).toThrow();
  });
});
