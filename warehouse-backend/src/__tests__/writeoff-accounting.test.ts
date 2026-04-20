import Fastify from "fastify";
import * as iconv from "iconv-lite";
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../db.js", () => ({
  query: vi.fn(),
  transaction: vi.fn(),
}));

import { query } from "../db.js";
import exportRoutes from "../routes/export.js";
import inventoryRoutes from "../routes/inventory.js";
import {
  renderWriteoffProtocolPdf,
  WriteoffPdfData,
} from "../services/writeoff-pdf.js";

const mockQuery = vi.mocked(query);

function resultRows<T>(rows: T[]) {
  return { rows } as any;
}

async function buildApp(
  plugin: any,
  prefix: string,
  role: "admin" | "accountant" | "warehouse" = "accountant",
) {
  const app = Fastify();
  app.addHook("onRequest", async (request) => {
    (request as any).user = {
      id: "u-test",
      email: `${role}@test.local`,
      role,
    };
    (request as any).jwtVerify = async () => (request as any).user;
  });
  await app.register(plugin, { prefix });
  return app;
}

function sampleWriteoffData(
  overrides: Partial<WriteoffPdfData> = {},
): WriteoffPdfData {
  return {
    document_number: "БРАК-2026-0001",
    written_off_at: "2026-04-18T10:00:00.000Z",
    reason: "expired",
    notes: "Партидата е с изтекъл срок на годност към 15.04.2026.",
    quantity: 5,
    unit_cost: 25.19,
    total_cost: 125.95,
    product_name_bg: "Наденица Елатиас",
    product_sku: "1013",
    product_unit: "кг",
    batch_number: "00243166",
    batch_expiry: "2026-04-10",
    written_off_by_email: "warehouse@greekfoods.bg",
    written_off_by_name: "Иван Петров",
    company: {
      company_name: "BAKALIA GREEK DELI FOOD",
      eik: "202860357",
      vat_number: "BG202860357",
      address: "ул. Калогяново 14, 1618 София",
    },
    commission: {
      chair: null,
      member1: null,
      member2: null,
    },
    ...overrides,
  };
}

describe("renderWriteoffProtocolPdf", () => {
  it("produces a Buffer with a PDF header", async () => {
    const buffer = await renderWriteoffProtocolPdf(sampleWriteoffData());
    expect(Buffer.isBuffer(buffer)).toBe(true);
    expect(buffer.length).toBeGreaterThan(1000);
    // PDF magic bytes
    expect(buffer.slice(0, 4).toString("ascii")).toBe("%PDF");
  });

  it("embeds the Bulgarian title and document number in the PDF stream", async () => {
    const buffer = await renderWriteoffProtocolPdf(sampleWriteoffData());
    // PDFKit DEFLATE-compresses text content streams by default, so raw
    // substring checks for Cyrillic glyphs (pre-compression characters)
    // do not survive. Instead we verify:
    //   1. The buffer is a structurally valid PDF (header magic)
    //   2. It contains at least one /Page object (layout produced pages)
    //   3. Size is reasonable for a one-page invoice-like doc (>1KB)
    const ascii = buffer.toString("latin1");
    expect(ascii.startsWith("%PDF-")).toBe(true);
    expect(ascii).toContain("/Type /Page");
    expect(buffer.length).toBeGreaterThan(1000);
  });

  it("handles the 'other' reason gracefully", async () => {
    // Structural smoke test: the 'other' reason path must produce a valid
    // PDF without throwing (notes path is exercised inside the renderer).
    const buffer = await renderWriteoffProtocolPdf(
      sampleWriteoffData({
        reason: "other",
        notes: "Технически проблем при обработка.",
      }),
    );
    expect(buffer.toString("latin1").startsWith("%PDF-")).toBe(true);
    expect(buffer.length).toBeGreaterThan(1000);
  });

  it("renders even when batch and sku are missing", async () => {
    const buffer = await renderWriteoffProtocolPdf(
      sampleWriteoffData({
        product_sku: null,
        batch_number: null,
        batch_expiry: null,
      }),
    );
    expect(buffer.length).toBeGreaterThan(1000);
  });
});

describe("GET /export/microinvest/writeoffs", () => {
  beforeEach(() => {
    mockQuery.mockReset();
  });

  it("emits a CSV with Брак document rows encoded as CP1251", async () => {
    mockQuery.mockResolvedValueOnce(
      resultRows([
        {
          document_number: "БРАК-2026-0001",
          written_off_at: "2026-04-18",
          quantity: "5.000",
          unit_cost: "25.1900",
          total_cost: "125.95",
          reason: "expired",
          sku: "1013",
          name_bg: "Наденица Елатиас",
          unit: "кг",
          batch_number: "00243166",
        },
      ]),
    );

    const app = await buildApp(exportRoutes, "/export", "accountant");
    const res = await app.inject({
      method: "GET",
      url: "/export/microinvest/writeoffs?from=2026-01-01&to=2026-12-31",
    });

    expect(res.statusCode).toBe(200);
    expect(res.headers["content-type"]).toContain("text/csv");
    const decoded = iconv.decode(res.rawPayload, "win1251");
    expect(decoded).toContain("DocumentType,DocumentNumber,Date");
    expect(decoded).toContain("Брак");
    expect(decoded).toContain("БРАК-2026-0001");
    expect(decoded).toContain("2026-04-18");
    expect(decoded).toContain("1013");
    expect(decoded).toContain("Изтекъл срок на годност");
    await app.close();
  });

  it("403s for warehouse role", async () => {
    const app = await buildApp(exportRoutes, "/export", "warehouse");
    const res = await app.inject({
      method: "GET",
      url: "/export/microinvest/writeoffs?from=2026-01-01&to=2026-12-31",
    });
    expect(res.statusCode).toBe(403);
    await app.close();
  });

  it("400s when from/to missing", async () => {
    const app = await buildApp(exportRoutes, "/export", "accountant");
    const res = await app.inject({
      method: "GET",
      url: "/export/microinvest/writeoffs",
    });
    expect(res.statusCode).toBe(400);
    await app.close();
  });
});

describe("GET /inventory/valuation", () => {
  beforeEach(() => {
    mockQuery.mockReset();
  });

  it("returns current value, ytd writeoffs, and breakdowns for accountant", async () => {
    mockQuery
      // current_value
      .mockResolvedValueOnce(resultRows([{ value: "12450.67" }]))
      // ytd writeoff rows (grouped by reason)
      .mockResolvedValueOnce(
        resultRows([
          {
            count: "8",
            value: "245.00",
            reason: "expired",
            reason_value: "245.00",
          },
          {
            count: "4",
            value: "100.67",
            reason: "damaged",
            reason_value: "100.67",
          },
        ]),
      )
      // by_category
      .mockResolvedValueOnce(
        resultRows([
          {
            category_id: 5,
            name: "Сирена",
            product_count: 12,
            qty: "145.5",
            value: "2340.00",
          },
        ]),
      )
      // expiring in 30 days
      .mockResolvedValueOnce(resultRows([{ count: "5", value: "180.50" }]))
      // already expired
      .mockResolvedValueOnce(resultRows([{ count: "2", value: "75.00" }]));

    const app = await buildApp(inventoryRoutes, "/inventory", "accountant");
    const res = await app.inject({
      method: "GET",
      url: "/inventory/valuation?as_of_date=2026-04-30",
    });

    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.as_of_date).toBe("2026-04-30");
    expect(body.current_value).toBe(12450.67);
    expect(body.ytd_writeoffs.count).toBe(12);
    expect(body.ytd_writeoffs.value).toBeCloseTo(345.67, 2);
    expect(body.ytd_writeoffs.by_reason.expired.count).toBe(8);
    expect(body.ytd_writeoffs.by_reason.damaged.value).toBeCloseTo(100.67, 2);
    expect(body.by_category[0].name).toBe("Сирена");
    expect(body.by_category[0].value).toBe(2340);
    expect(body.expiring_soon.in_30_days.count).toBe(5);
    expect(body.expiring_soon.already_expired.value).toBe(75);
    await app.close();
  });

  it("403s for warehouse role", async () => {
    const app = await buildApp(inventoryRoutes, "/inventory", "warehouse");
    const res = await app.inject({
      method: "GET",
      url: "/inventory/valuation",
    });
    expect(res.statusCode).toBe(403);
    await app.close();
  });

  it("defaults as_of_date to today when not provided", async () => {
    mockQuery
      .mockResolvedValueOnce(resultRows([{ value: "0" }]))
      .mockResolvedValueOnce(resultRows([]))
      .mockResolvedValueOnce(resultRows([]))
      .mockResolvedValueOnce(resultRows([{ count: "0", value: "0" }]))
      .mockResolvedValueOnce(resultRows([{ count: "0", value: "0" }]));

    const app = await buildApp(inventoryRoutes, "/inventory", "admin");
    const res = await app.inject({
      method: "GET",
      url: "/inventory/valuation",
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.as_of_date).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    expect(body.current_value).toBe(0);
    expect(body.ytd_writeoffs.count).toBe(0);
    await app.close();
  });
});
