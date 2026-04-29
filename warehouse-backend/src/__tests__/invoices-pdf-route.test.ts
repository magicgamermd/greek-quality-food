/**
 * Route-level tests for GET /invoices/:id/pdf?copies={1,2}
 *
 * Strategy:
 * - db.js is fully mocked (no real Postgres connection needed).
 * - invoice-pdf.js is *not* mocked — we use the real generateInvoicePdf so
 *   that the on-disk files contain valid PDF bytes and page counts are
 *   meaningful.
 * - We create a real 1-page PDF in /tmp in beforeAll and point the mocked
 *   invoice row at it.  The copies=2 branch generates to a fresh tmpdir path
 *   via the real service.
 * - Fastify is bootstrapped inline (no shared buildApp helper) following the
 *   pattern established in invoice-cancel.test.ts, invoices-permissions.test.ts,
 *   etc.
 */

import Fastify from "fastify";
import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";
import type { FastifyInstance } from "fastify";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";

// ── Module mocks ───────────────────────────────────────────────────────────

vi.mock("../db.js", () => ({
  query: vi.fn(),
  transaction: vi.fn(),
}));

// We do NOT mock invoice-pdf.js — we need the real generateInvoicePdf so that
// the PDF bytes written to disk have accurate page counts.
// We also do NOT mock currency.js or order-stock.js — those are used by the
// real PDF service and by other routes, not by GET /invoices/:id/pdf itself.

// ── Imports after mocks ────────────────────────────────────────────────────

import { query } from "../db.js";
import invoiceRoutes from "../routes/invoices.js";
import { generateInvoicePdf } from "../services/invoice-pdf.js";

const mockQuery = vi.mocked(query);

// ── Helpers ────────────────────────────────────────────────────────────────

function resultRows<T>(rows: T[]) {
  return { rows, rowCount: rows.length } as any;
}

/** Count PDF page objects in raw PDF bytes (same technique as invoice-pdf.test.ts). */
function getPdfPageCount(buf: Buffer | string): number {
  const content = typeof buf === "string" ? buf : buf.toString("latin1");
  return (content.match(/\/Type\s*\/Page\b/g) || []).length;
}

async function buildApp(): Promise<FastifyInstance> {
  const app = Fastify({ logger: false });

  // Bypass real JWT — inject an admin user identity on every request.
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

// ── Minimal test data ──────────────────────────────────────────────────────

const TEST_PDF_DIR = path.join(os.tmpdir(), "mertm-route-pdf-tests");

const baseInvoice = {
  id: 42,
  invoice_number: "MM-TEST-0042",
  invoice_date: "2026-04-29",
  document_type: "invoice",
  status: "issued",
  partner_id: 1,
  include_vat: true,
  currency: null,
  pdf_path: "", // filled in beforeAll
};

const basePartner = {
  id: 1,
  name: "Test Partner EOOD",
  eik: "123456789",
  vat_number: "BG123456789",
  address: "ул. Тест 1, Sofia",
};

const baseCompany = {
  company_name: "MERT-M EOOD",
  address: "Sofia, Bulgaria",
  eik: "123456789",
  vat_number: "BG123456789",
  iban: "BG00TEST",
  phone: "0888111222",
  email: "office@mertm.bg",
};

const baseItems = [
  {
    name_bg: "Шкаф Liebherr",
    name_en: "Liebherr Fridge",
    sku: "LB-001",
    unit: "бр",
    quantity: 1,
    unit_price: 1000,
    total_price: 1000,
  },
];

// ── Test suite ─────────────────────────────────────────────────────────────

describe("GET /invoices/:id/pdf — copies query parameter", () => {
  let app: FastifyInstance;
  let cachedPdfPath: string;

  beforeAll(async () => {
    fs.mkdirSync(TEST_PDF_DIR, { recursive: true });

    // Create a real 1-page PDF to serve as the on-disk cache.
    cachedPdfPath = path.join(
      TEST_PDF_DIR,
      `${baseInvoice.invoice_number}.pdf`,
    );
    await generateInvoicePdf({
      invoice: {
        invoice_number: baseInvoice.invoice_number,
        invoice_date: baseInvoice.invoice_date,
        total_net: 1000,
        total_vat: 200,
        total_gross: 1200,
      },
      partner: basePartner,
      company: baseCompany,
      items: baseItems,
      vatRate: 20,
      includeVat: true,
      outputPath: cachedPdfPath,
      copies: 1,
    });

    baseInvoice.pdf_path = cachedPdfPath;

    app = await buildApp();
  });

  afterAll(async () => {
    await app.close();
    fs.rmSync(TEST_PDF_DIR, { recursive: true, force: true });
  });

  beforeEach(() => {
    mockQuery.mockReset();

    // The admin role short-circuits hasPermission before touching the DB,
    // so only ONE query is made per request in the default path:
    //   SELECT * FROM invoices WHERE id = $1
    // Individual tests that expect more queries (copies=2) append additional
    // mockResolvedValueOnce calls after this setup.
    mockQuery.mockResolvedValueOnce(resultRows([{ ...baseInvoice }]));
  });

  // ── Test 1: default (no query) → 1-page ──────────────────────────────

  it("returns a 1-page PDF when no copies query is given (default)", async () => {
    const res = await app.inject({
      method: "GET",
      url: `/invoices/${baseInvoice.id}/pdf`,
    });

    expect(res.statusCode).toBe(200);
    expect(res.headers["content-type"]).toMatch(/application\/pdf/);
    expect(getPdfPageCount(res.rawPayload)).toBe(1);
  });

  // ── Test 2: copies=1 → 1-page ────────────────────────────────────────

  it("returns a 1-page PDF when copies=1", async () => {
    // beforeEach already set up two mock returns; we need one more for the
    // permission check that runs on this request.
    // Actually beforeEach sets up 2 calls per test: permission + invoice query.
    const res = await app.inject({
      method: "GET",
      url: `/invoices/${baseInvoice.id}/pdf?copies=1`,
    });

    expect(res.statusCode).toBe(200);
    expect(res.headers["content-type"]).toMatch(/application\/pdf/);
    expect(getPdfPageCount(res.rawPayload)).toBe(1);
  });

  // ── Test 3: copies=2 → 2-page, cache unchanged ───────────────────────

  it("returns a 2-page PDF for copies=2 without rewriting the on-disk cache", async () => {
    const sizeBefore = fs.statSync(cachedPdfPath).size;

    // The copies=2 branch calls generateInvoicePdf (the real one, since we
    // didn't mock it) and also needs partner + company data.  Provide extra
    // mock returns for: orders query, items query, partners query, settings.
    // But wait — copies=2 path will be implemented to gather partner/company
    // data from the DB then generate to a temp path.  The exact queries depend
    // on the implementation.  We add stubs here that cover the expected calls.
    mockQuery
      // order lookup (SELECT * FROM orders WHERE invoice_id = ?)
      .mockResolvedValueOnce(resultRows([{ id: 10, partner_id: 1 }]))
      // items lookup
      .mockResolvedValueOnce(resultRows(baseItems))
      // partner lookup
      .mockResolvedValueOnce(resultRows([basePartner]))
      // settings (getCompanySettings)
      .mockResolvedValueOnce(resultRows([baseCompany]));

    const res = await app.inject({
      method: "GET",
      url: `/invoices/${baseInvoice.id}/pdf?copies=2`,
    });

    expect(res.statusCode).toBe(200);
    expect(res.headers["content-type"]).toMatch(/application\/pdf/);
    expect(getPdfPageCount(res.rawPayload)).toBe(2);

    // On-disk cache must remain unchanged (still 1-page, same size).
    const sizeAfter = fs.statSync(cachedPdfPath).size;
    expect(sizeAfter).toBe(sizeBefore);
    const cachedPageCount = getPdfPageCount(fs.readFileSync(cachedPdfPath));
    expect(cachedPageCount).toBe(1);
  });

  // ── Test 4: invalid copies → 400 with "copies" in error body ─────────

  it("returns 400 for invalid copies values (0, 3, 99, abc, -1)", async () => {
    for (const bad of ["0", "3", "99", "abc", "-1"]) {
      // Each iteration: reset and provide the invoice SELECT mock.
      // The 400 validation must happen AFTER the invoice is fetched (so that
      // 403 still wins over 400 for unauthorized users) — the implementation
      // is expected to validate copies after fetching the invoice.
      mockQuery.mockReset();
      mockQuery.mockResolvedValueOnce(resultRows([{ ...baseInvoice }]));

      const res = await app.inject({
        method: "GET",
        url: `/invoices/${baseInvoice.id}/pdf?copies=${bad}`,
      });

      expect(res.statusCode, `Expected 400 for copies=${bad}`).toBe(400);
      const body = res.json();
      expect(
        body.error,
        `Expected error body to mention "copies" for value "${bad}"`,
      ).toMatch(/copies/i);
    }
  });
});
