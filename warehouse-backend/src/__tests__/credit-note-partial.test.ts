// Integration tests for partial credit note flow on POST /invoices/credit-note.
//
// Covers:
//   1) Full credit note — backward-compatible (no `items` payload), totals
//      negate the parent invoice directly.
//   2) Partial — single line, full quantity → totals computed from selected.
//   3) Partial — multiple lines, fractional quantities.
//   4) Reject when order_item_id is not from the parent order.
//   5) Reject when quantity exceeds the original.
//   6) Partial + restore_stock=true → calls restorePartialItemsToInventory
//      (not the full-order helper) with the requested line/quantity pairs.

import Fastify from "fastify";
import { beforeEach, describe, expect, it, vi } from "vitest";
import invoiceRoutes from "../routes/invoices.js";

vi.mock("../db.js", () => ({
  query: vi.fn(),
  transaction: vi.fn(),
}));

vi.mock("../services/invoice-pdf.js", () => ({
  generateInvoicePdf: vi.fn(async () => undefined),
}));

vi.mock("../utils/currency.js", () => ({
  formatEurAmount: vi.fn((value: number | string) => String(value)),
}));

vi.mock("../utils/order-stock.js", () => ({
  restoreOrderItemsToInventory: vi.fn(async () => undefined),
  restorePartialItemsToInventory: vi.fn(async () => undefined),
}));

import { query, transaction } from "../db.js";
import {
  restoreOrderItemsToInventory,
  restorePartialItemsToInventory,
} from "../utils/order-stock.js";

const mockQuery = vi.mocked(query);
const mockTransaction = vi.mocked(transaction);
const mockRestoreFull = vi.mocked(restoreOrderItemsToInventory);
const mockRestorePartial = vi.mocked(restorePartialItemsToInventory);

function rowsRes<T>(rows: T[]) {
  return { rows, rowCount: rows.length } as any;
}

async function buildApp() {
  const app = Fastify();
  app.addHook("onRequest", async (request) => {
    (request as any).user = {
      id: "u-admin",
      email: "admin@test.local",
      role: "admin",
    };
    (request as any).jwtVerify = async () => (request as any).user;
  });
  await app.register(invoiceRoutes, { prefix: "/invoices" });
  return app;
}

// Stub-ваме всички top-level query() извиквания (settings load, permission
// resolution и т.н.) — credit-note handler-а живее в transaction(), който
// има отделен mock. Default връща празен rowset.
function setupTopLevelQueryStubs() {
  // settings.company_settings load — ако се извика
  mockQuery.mockResolvedValue(
    rowsRes([{ company_name: "Acme", show_bgn_on_invoice: false }]),
  );
}

// Helper that builds the full sequence of client.query() responses inside the
// transaction for a credit-note request, given the partial/full mode and the
// invoice/order shape.
function buildClientQuery(opts: {
  invoice: any;
  existingCN?: any[];
  orderId?: number | null;
  orderItems?: any[];
  partner?: any;
}) {
  const counter = { current_val: 7 };
  const newCn = {
    id: 999,
    invoice_number: `КИ-${String(counter.current_val).padStart(10, "0")}`,
  };
  return vi
    .fn()
    .mockImplementationOnce(async () => rowsRes([{ id: opts.invoice.id }])) // SELECT FOR UPDATE
    .mockImplementationOnce(async () => rowsRes([opts.invoice])) // SELECT original invoice
    .mockImplementationOnce(async () => rowsRes(opts.existingCN ?? [])) // existing CN check
    .mockImplementationOnce(async () =>
      rowsRes(opts.orderId ? [{ id: opts.orderId }] : []),
    ) // SELECT order linked to invoice
    .mockImplementationOnce(async () => rowsRes(opts.orderItems ?? [])) // SELECT order_items
    .mockImplementationOnce(async () => rowsRes([counter])) // UPDATE document_counters
    .mockImplementationOnce(async () => rowsRes([newCn])) // INSERT new credit note
    .mockImplementationOnce(async () =>
      rowsRes([opts.partner ?? { id: 5, name: "P" }]),
    ) // SELECT partner
    .mockImplementationOnce(async () => rowsRes([])); // UPDATE invoices SET pdf_path
}

describe("POST /invoices/credit-note — partial", () => {
  beforeEach(() => {
    mockQuery.mockReset();
    mockTransaction.mockReset();
    mockRestoreFull.mockClear();
    mockRestorePartial.mockClear();
    setupTopLevelQueryStubs();
  });

  const baseInvoice = {
    id: 100,
    partner_id: 5,
    invoice_number: "INV-100",
    total_net: "200",
    total_vat: "40",
    total_gross: "240",
    include_vat: true,
    status: "active",
    document_type: "invoice",
  };

  const baseOrderItems = [
    {
      id: 11,
      order_id: 50,
      product_id: 1,
      batch_id: null,
      name_bg_snapshot: "Хладилник",
      name_en_snapshot: "Fridge",
      sku_snapshot: "SKU-1",
      quantity: "2",
      unit_price: "50",
      total_price: "100",
      line_status: "normal",
      unit: "бр.",
    },
    {
      id: 12,
      order_id: 50,
      product_id: 2,
      batch_id: null,
      name_bg_snapshot: "Фритюрник",
      name_en_snapshot: "Fryer",
      sku_snapshot: "SKU-2",
      quantity: "1",
      unit_price: "100",
      total_price: "100",
      line_status: "normal",
      unit: "бр.",
    },
  ];

  it("full credit note (no items) — totals negate parent invoice", async () => {
    const clientQuery = buildClientQuery({
      invoice: baseInvoice,
      orderId: 50,
      orderItems: baseOrderItems,
    });
    mockTransaction.mockImplementation(async (cb: any) =>
      cb({ query: clientQuery }),
    );

    const app = await buildApp();
    try {
      const res = await app.inject({
        method: "POST",
        url: "/invoices/credit-note",
        payload: { related_invoice_id: 100, reason: "Full reversal" },
      });
      expect(res.statusCode).toBe(201);
      // Find the INSERT INTO invoices call (the 7th in our sequence) and
      // assert the totals are -200 / -40 / -240.
      const insertCall = clientQuery.mock.calls.find((c: any[]) =>
        String(c[0]).includes("INSERT INTO invoices"),
      );
      expect(insertCall).toBeDefined();
      const params = insertCall![1] as any[];
      expect(params[2]).toBeCloseTo(-200, 2); // total_net
      expect(params[3]).toBeCloseTo(-40, 2); // total_vat
      expect(params[4]).toBeCloseTo(-240, 2); // total_gross
    } finally {
      await app.close();
    }
  });

  it("partial — single line full quantity → totals from selected (gross-based)", async () => {
    const clientQuery = buildClientQuery({
      invoice: baseInvoice,
      orderId: 50,
      orderItems: baseOrderItems,
    });
    mockTransaction.mockImplementation(async (cb: any) =>
      cb({ query: clientQuery }),
    );

    const app = await buildApp();
    try {
      const res = await app.inject({
        method: "POST",
        url: "/invoices/credit-note",
        payload: {
          related_invoice_id: 100,
          reason: "Returned 1 fryer",
          // Refund-ваме целия Fryer (item 12, qty=1, unit_price=100 gross)
          items: [{ order_item_id: 12, quantity: 1 }],
        },
      });
      expect(res.statusCode).toBe(201);
      const insertCall = clientQuery.mock.calls.find((c: any[]) =>
        String(c[0]).includes("INSERT INTO invoices"),
      );
      const params = insertCall![1] as any[];
      // unit_price=100 е gross (с ДДС). totalGross = 1 × 100 = 100;
      // totalNet = 100 / 1.2 = 83.33; totalVat = 100 - 83.33 = 16.67
      expect(params[2]).toBeCloseTo(-83.33, 2);
      expect(params[3]).toBeCloseTo(-16.67, 2);
      expect(params[4]).toBeCloseTo(-100, 2);
    } finally {
      await app.close();
    }
  });

  it("partial — multiple lines, fractional quantities (gross-based)", async () => {
    const clientQuery = buildClientQuery({
      invoice: baseInvoice,
      orderId: 50,
      orderItems: baseOrderItems,
    });
    mockTransaction.mockImplementation(async (cb: any) =>
      cb({ query: clientQuery }),
    );

    const app = await buildApp();
    try {
      const res = await app.inject({
        method: "POST",
        url: "/invoices/credit-note",
        payload: {
          related_invoice_id: 100,
          reason: "Partial",
          items: [
            { order_item_id: 11, quantity: 1 }, // 1 × 50 = 50 gross
            { order_item_id: 12, quantity: 0.5 }, // 0.5 × 100 = 50 gross
          ],
        },
      });
      expect(res.statusCode).toBe(201);
      const insertCall = clientQuery.mock.calls.find((c: any[]) =>
        String(c[0]).includes("INSERT INTO invoices"),
      );
      const params = insertCall![1] as any[];
      // totalGross = 100; totalNet = 100/1.2 = 83.33; totalVat = 16.67
      expect(params[2]).toBeCloseTo(-83.33, 2);
      expect(params[3]).toBeCloseTo(-16.67, 2);
      expect(params[4]).toBeCloseTo(-100, 2);
    } finally {
      await app.close();
    }
  });

  it("partial with include_vat=false → net = gross (no VAT extracted)", async () => {
    const noVatInvoice = { ...baseInvoice, include_vat: false };
    const clientQuery = buildClientQuery({
      invoice: noVatInvoice,
      orderId: 50,
      orderItems: baseOrderItems,
    });
    mockTransaction.mockImplementation(async (cb: any) =>
      cb({ query: clientQuery }),
    );

    const app = await buildApp();
    try {
      const res = await app.inject({
        method: "POST",
        url: "/invoices/credit-note",
        payload: {
          related_invoice_id: 100,
          reason: "Non-VAT partial",
          items: [{ order_item_id: 12, quantity: 1 }],
        },
      });
      expect(res.statusCode).toBe(201);
      const insertCall = clientQuery.mock.calls.find((c: any[]) =>
        String(c[0]).includes("INSERT INTO invoices"),
      );
      const params = insertCall![1] as any[];
      // Без ДДС: totalNet = totalGross = 100; totalVat = 0
      expect(params[2]).toBeCloseTo(-100, 2);
      expect(params[3]).toBeCloseTo(0, 2);
      expect(params[4]).toBeCloseTo(-100, 2);
    } finally {
      await app.close();
    }
  });

  it("rejects order_item_id that is not part of the linked order", async () => {
    const clientQuery = buildClientQuery({
      invoice: baseInvoice,
      orderId: 50,
      orderItems: baseOrderItems,
    });
    mockTransaction.mockImplementation(async (cb: any) =>
      cb({ query: clientQuery }),
    );

    const app = await buildApp();
    try {
      const res = await app.inject({
        method: "POST",
        url: "/invoices/credit-note",
        payload: {
          related_invoice_id: 100,
          reason: "test",
          items: [{ order_item_id: 999, quantity: 1 }],
        },
      });
      expect(res.statusCode).toBe(400);
    } finally {
      await app.close();
    }
  });

  it("rejects quantity exceeding original", async () => {
    const clientQuery = buildClientQuery({
      invoice: baseInvoice,
      orderId: 50,
      orderItems: baseOrderItems,
    });
    mockTransaction.mockImplementation(async (cb: any) =>
      cb({ query: clientQuery }),
    );

    const app = await buildApp();
    try {
      const res = await app.inject({
        method: "POST",
        url: "/invoices/credit-note",
        payload: {
          related_invoice_id: 100,
          reason: "test",
          // item 12 има qty=1, заявяваме 2 → reject
          items: [{ order_item_id: 12, quantity: 2 }],
        },
      });
      expect(res.statusCode).toBe(400);
    } finally {
      await app.close();
    }
  });

  it("partial + restore_stock=true → calls partial restore helper, not full", async () => {
    const clientQuery = buildClientQuery({
      invoice: baseInvoice,
      orderId: 50,
      orderItems: baseOrderItems,
    });
    mockTransaction.mockImplementation(async (cb: any) =>
      cb({ query: clientQuery }),
    );

    const app = await buildApp();
    try {
      const res = await app.inject({
        method: "POST",
        url: "/invoices/credit-note",
        payload: {
          related_invoice_id: 100,
          reason: "Returned 1 fryer",
          restore_stock: true,
          items: [{ order_item_id: 12, quantity: 1 }],
        },
      });
      expect(res.statusCode).toBe(201);
      expect(mockRestorePartial).toHaveBeenCalledTimes(1);
      const args = mockRestorePartial.mock.calls[0];
      expect(args[1]).toEqual([{ order_item_id: 12, quantity: 1 }]);
      expect(mockRestoreFull).not.toHaveBeenCalled();
    } finally {
      await app.close();
    }
  });

  it("full + restore_stock=true → calls full restore helper, not partial", async () => {
    const clientQuery = buildClientQuery({
      invoice: baseInvoice,
      orderId: 50,
      orderItems: baseOrderItems,
    });
    mockTransaction.mockImplementation(async (cb: any) =>
      cb({ query: clientQuery }),
    );

    const app = await buildApp();
    try {
      const res = await app.inject({
        method: "POST",
        url: "/invoices/credit-note",
        payload: {
          related_invoice_id: 100,
          reason: "Full reversal",
          restore_stock: true,
        },
      });
      expect(res.statusCode).toBe(201);
      expect(mockRestoreFull).toHaveBeenCalledTimes(1);
      expect(mockRestorePartial).not.toHaveBeenCalled();
    } finally {
      await app.close();
    }
  });
});
