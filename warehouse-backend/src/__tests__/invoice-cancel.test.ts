import Fastify from "fastify";
import { beforeEach, describe, expect, it, vi } from "vitest";
import invoiceRoutes from "../routes/invoices.js";

vi.mock("../db.js", () => ({
  query: vi.fn(),
  transaction: vi.fn(),
}));

vi.mock("../services/invoice-pdf.js", () => ({
  generateInvoicePdf: vi.fn(),
}));

vi.mock("../utils/currency.js", () => ({
  formatEurAmount: vi.fn((value: number) => value),
}));

import { query, transaction } from "../db.js";

const mockQuery = vi.mocked(query);
const mockTransaction = vi.mocked(transaction);

function resultRows<T>(rows: T[]) {
  return { rows, rowCount: rows.length } as any;
}

function result(rowCount = 1) {
  return { rows: [], rowCount } as any;
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

describe("invoice cancel endpoint", () => {
  beforeEach(() => {
    mockQuery.mockReset();
    mockTransaction.mockReset();
  });

  it("cancels the linked order and restores inventory plus batch quantity", async () => {
    const clientQuery = vi
      .fn()
      .mockResolvedValueOnce(
        resultRows([
          {
            id: 13,
            document_type: "invoice",
            status: "issued",
            invoice_number: "INV-13",
          },
        ]),
      )
      .mockResolvedValueOnce(resultRows([{ total: "0" }]))
      .mockResolvedValueOnce(resultRows([]))
      .mockResolvedValueOnce(
        resultRows([{ id: 13, status: "cancelled", invoice_number: "INV-13" }]),
      )
      .mockResolvedValueOnce(
        resultRows([{ id: 12, order_number: "12", status: "invoiced" }]),
      )
      .mockResolvedValueOnce(
        resultRows([
          {
            id: 501,
            order_id: 12,
            product_id: 101,
            quantity: "3",
            batch_id: 701,
          },
        ]),
      )
      // GQF: SELECT order_item_batches за реда → празно (legacy ред без
      // allocations) → fallback към batch_id пътя.
      .mockResolvedValueOnce(resultRows([]))
      .mockResolvedValueOnce(result(1))
      .mockResolvedValueOnce(result(1))
      .mockResolvedValueOnce(result(1))
      .mockResolvedValueOnce(result(1));

    mockTransaction.mockImplementation(async (callback: any) =>
      callback({ query: clientQuery }),
    );

    const app = await buildApp();
    try {
      const res = await app.inject({
        method: "POST",
        url: "/invoices/13/cancel",
        payload: { reason: "Client requested annulment" },
      });

      expect(res.statusCode).toBe(200);
      expect(res.json()).toEqual({
        invoice: { id: 13, status: "cancelled", invoice_number: "INV-13" },
        order_id: 12,
      });

      expect(mockTransaction).toHaveBeenCalledTimes(1);
      expect(clientQuery).toHaveBeenCalledTimes(11);

      expect(String(clientQuery.mock.calls[5][0])).toContain(
        "SELECT * FROM order_items",
      );
      // call 6 = SELECT order_item_batches (empty → fallback)
      expect(String(clientQuery.mock.calls[6][0])).toContain(
        "FROM order_item_batches",
      );
      expect(String(clientQuery.mock.calls[7][0])).toContain(
        "UPDATE inventory SET quantity = quantity + $1",
      );
      expect(clientQuery.mock.calls[7][1]).toEqual([3, 101, 701]);
      expect(String(clientQuery.mock.calls[8][0])).toContain(
        "UPDATE batches SET quantity = quantity + $1",
      );
      expect(clientQuery.mock.calls[8][1]).toEqual([3, 701]);
      expect(String(clientQuery.mock.calls[9][0])).toContain(
        "status = 'cancelled'",
      );
      expect(clientQuery.mock.calls[9][1]).toEqual([
        12,
        13,
        "INV-13",
        "Client requested annulment",
      ]);
    } finally {
      await app.close();
    }
  });

  it("restores non-batch stock before cancelling the linked order", async () => {
    const clientQuery = vi
      .fn()
      .mockResolvedValueOnce(
        resultRows([
          {
            id: 21,
            document_type: "invoice",
            status: "issued",
            invoice_number: "INV-21",
          },
        ]),
      )
      .mockResolvedValueOnce(resultRows([{ total: "0" }]))
      .mockResolvedValueOnce(resultRows([]))
      .mockResolvedValueOnce(
        resultRows([{ id: 21, status: "cancelled", invoice_number: "INV-21" }]),
      )
      .mockResolvedValueOnce(
        resultRows([{ id: 44, order_number: "44", status: "fulfilled" }]),
      )
      .mockResolvedValueOnce(
        resultRows([
          {
            id: 900,
            order_id: 44,
            product_id: 202,
            quantity: "2",
            batch_id: null,
          },
        ]),
      )
      // GQF: SELECT order_item_batches → празно (legacy ред) → fallback.
      .mockResolvedValueOnce(resultRows([]))
      .mockResolvedValueOnce(resultRows([{ id: 3001 }]))
      .mockResolvedValueOnce(result(1))
      .mockResolvedValueOnce(result(1))
      .mockResolvedValueOnce(result(1));

    mockTransaction.mockImplementation(async (callback: any) =>
      callback({ query: clientQuery }),
    );

    const app = await buildApp();
    try {
      const res = await app.inject({
        method: "POST",
        url: "/invoices/21/cancel",
        payload: { reason: "Duplicate invoice" },
      });

      expect(res.statusCode).toBe(200);
      expect(res.json().order_id).toBe(44);

      // call 6 = SELECT order_item_batches (empty → fallback)
      expect(String(clientQuery.mock.calls[6][0])).toContain(
        "FROM order_item_batches",
      );
      expect(String(clientQuery.mock.calls[7][0])).toContain(
        "SELECT id FROM inventory",
      );
      expect(clientQuery.mock.calls[7][1]).toEqual([202]);
      expect(String(clientQuery.mock.calls[8][0])).toContain(
        "UPDATE inventory SET quantity = quantity + $1, updated_at = NOW() WHERE id = $2",
      );
      expect(clientQuery.mock.calls[8][1]).toEqual([2, 3001]);
      expect(String(clientQuery.mock.calls[9][0])).toContain(
        "status = 'cancelled'",
      );
    } finally {
      await app.close();
    }
  });
});
