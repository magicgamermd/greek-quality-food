import Fastify from "fastify";
import { beforeEach, describe, expect, it, vi } from "vitest";
import invoiceRoutes from "../routes/invoices.js";
import fs from "node:fs";
import path from "node:path";
import { Readable } from "node:stream";

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

import { query } from "../db.js";

const mockQuery = vi.mocked(query);

function resultRows<T>(rows: T[]) {
  return { rows } as any;
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

describe("invoice route filters", () => {
  beforeEach(() => {
    mockQuery.mockReset();
    vi.restoreAllMocks();
  });

  it("applies search, payment status, invoice number, and date filters", async () => {
    // Main SELECT + count query (payment_status triggers HAVING → count subquery).
    mockQuery.mockResolvedValueOnce(resultRows([]));
    mockQuery.mockResolvedValueOnce(resultRows([{ total: "0" }]));

    const app = await buildApp();
    try {
      const res = await app.inject({
        method: "GET",
        url:
          "/invoices?document_type=invoice&payment_status=unpaid" +
          "&date_from=2026-04-01&date_to=2026-04-30" +
          "&invoice_number=INV-42&q=Bakalia&limit=100",
      });

      expect(res.statusCode).toBe(200);
      expect(res.json()).toEqual({
        data: [],
        pagination: { page: 1, limit: 100, total: 0 },
      });
      expect(mockQuery).toHaveBeenCalledTimes(2);

      const [sql, params] = mockQuery.mock.calls[0] as [string, any[]];
      expect(sql).toContain("i.document_type = $1");
      expect(sql).toContain("DATE(i.invoice_date) >= $2");
      expect(sql).toContain("DATE(i.invoice_date) <= $3");
      expect(sql).toContain("i.invoice_number ILIKE $4");
      // q now uses transliteration-aware normalize_search over partner name
      // combined with raw ILIKE on invoice_number (shared paramIdx).
      expect(sql).toContain("i.invoice_number ILIKE $5");
      expect(sql).toContain(
        "normalize_search(p.name) ILIKE '%' || normalize_search($6) || '%'",
      );
      expect(sql).toContain("HAVING CASE WHEN i.status = 'cancelled'");
      // ORDER BY ranks by partner-name similarity when q is provided.
      expect(sql).toContain(
        "similarity(normalize_search(p.name), normalize_search($8))",
      );
      expect(params).toEqual([
        "invoice",
        "2026-04-01",
        "2026-04-30",
        "%INV-42%",
        "%Bakalia%",
        "Bakalia",
        "unpaid",
        "Bakalia",
        100,
        0,
      ]);
    } finally {
      await app.close();
    }
  });

  it("falls back to the current uploads path when stored pdf_path is stale", async () => {
    mockQuery.mockResolvedValueOnce(
      resultRows([
        {
          id: 12,
          invoice_number: "INV-12",
          pdf_path: "/old/release/uploads/invoices/INV-12.pdf",
        },
      ]),
    );

    vi.spyOn(fs, "existsSync").mockImplementation(
      (candidate) =>
        String(candidate) === path.resolve("uploads", "invoices", "INV-12.pdf"),
    );

    const createReadStreamSpy = vi
      .spyOn(fs, "createReadStream")
      .mockReturnValue(Readable.from(["pdf"]) as any);

    const app = await buildApp();
    try {
      const res = await app.inject({
        method: "GET",
        url: "/invoices/12/pdf",
      });

      expect(res.statusCode).toBe(200);
      expect(createReadStreamSpy).toHaveBeenCalledWith(
        path.resolve("uploads", "invoices", "INV-12.pdf"),
      );
    } finally {
      await app.close();
    }
  });
});
