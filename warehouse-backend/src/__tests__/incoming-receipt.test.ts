import Fastify from "fastify";
import fs from "node:fs";
import path from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";
import incomingRoutes from "../routes/incoming.js";

vi.mock("../db.js", () => ({
  query: vi.fn(),
  transaction: vi.fn(),
}));

vi.mock("../lib/redis.js", () => ({
  getRedis: vi.fn(async () => ({
    get: vi.fn(async () => null),
    setex: vi.fn(async () => "OK"),
    del: vi.fn(async () => 0),
  })),
}));

vi.mock("../services/document-pdf.js", () => ({
  generateIncomingStockReceiptPdf: vi
    .fn()
    .mockImplementation(async ({ outputPath }) => {
      fs.mkdirSync(path.dirname(outputPath), { recursive: true });
      fs.writeFileSync(outputPath, "%PDF-1.4\n%%EOF\n");
    }),
}));

import { query } from "../db.js";
import { generateIncomingStockReceiptPdf } from "../services/document-pdf.js";

type Role = "admin" | "warehouse" | "sales" | "owner_mobile";

const mockQuery = vi.mocked(query);

function resultRows<T>(rows: T[]) {
  return { rows } as any;
}

async function buildAppWithRole(role: Role) {
  const app = Fastify();

  app.addHook("onRequest", async (request) => {
    (request as any).user = {
      id: "u-role",
      email: "role@test.local",
      role,
    };
    (request as any).jwtVerify = async () => (request as any).user;
  });

  await app.register(incomingRoutes, { prefix: "/incoming" });
  return app;
}

describe("incoming stock receipt endpoint", () => {
  beforeEach(() => {
    mockQuery.mockReset();
  });

  it("forbids sales role (lacks incoming.manage)", async () => {
    // MERT-M permissions: sales role does not have INCOMING_MANAGE in
    // ROLE_DEFAULTS, so the requirePermission middleware rejects with
    // 403 after the single permission lookup query.
    mockQuery.mockResolvedValueOnce(
      resultRows([{ role: "sales", overrides: [] }]),
    );

    const app = await buildAppWithRole("sales");
    try {
      const res = await app.inject({
        method: "GET",
        url: "/incoming/10/receipt",
      });

      expect(res.statusCode).toBe(403);
      // Only the permission lookup ran — no business-logic queries.
      expect(mockQuery).toHaveBeenCalledTimes(1);
    } finally {
      await app.close();
    }
  });

  it("rejects receipt generation for non-confirmed incoming documents", async () => {
    mockQuery.mockResolvedValueOnce(
      resultRows([
        {
          id: 10,
          status: "pending",
          invoice_number: "INV-10",
        },
      ]),
    );

    // Admin short-circuits the permission check, so only the single
    // SELECT against incoming_goods runs before the 409.
    const app = await buildAppWithRole("admin");
    try {
      const res = await app.inject({
        method: "GET",
        url: "/incoming/10/receipt",
      });

      expect(res.statusCode).toBe(409);
      expect(res.json()).toEqual({
        error: "Stock receipt is available only for confirmed deliveries",
      });
      expect(mockQuery).toHaveBeenCalledTimes(1);
    } finally {
      await app.close();
    }
  });

  it("passes company settings as buyer and supplier record as supplier to receipt pdf", async () => {
    const pdfMock = vi.mocked(generateIncomingStockReceiptPdf);
    pdfMock.mockClear();

    mockQuery
      .mockResolvedValueOnce(
        resultRows([
          {
            id: 12,
            status: "confirmed",
            invoice_number: "INV-2026-12",
            invoice_date: "2026-03-15",
            created_at: "2026-03-15T10:30:00.000Z",
            supplier_name: "DELIFU",
            supplier_eik: "987654321",
            supplier_vat: "BG987654321",
            supplier_address: "ул. Доставчик 5",
            supplier_city: "Пловдив",
            supplier_phone: "0888000111",
            supplier_contact: "Никос",
          },
        ]),
      )
      .mockResolvedValueOnce(
        resultRows([
          {
            sku: "SKU-12",
            name_bg: "Фета",
            name_en: "Feta",
            unit: "kg",
            quantity: 2,
            unit_price: 7.5,
            total_price: 15,
          },
        ]),
      )
      .mockResolvedValueOnce(
        resultRows([
          {
            company_name: "Бакалия Greek Deli Food",
            eik: "202860357",
            vat_number: "BG202860357",
            address: "бул. България 100",
            city: "София",
            phone: "0886291003",
            mol: "Евгени Терзийски",
          },
        ]),
      )
      .mockResolvedValueOnce(
        resultRows([
          {
            name: "Основен склад",
            address: "бул. Европа 1",
          },
        ]),
      );

    const app = await buildAppWithRole("admin");
    try {
      const res = await app.inject({
        method: "GET",
        url: "/incoming/12/receipt",
      });

      expect(res.statusCode).toBe(200);
      expect(res.headers["content-type"]).toContain("application/pdf");
      expect(pdfMock).toHaveBeenCalledTimes(1);
      expect(pdfMock).toHaveBeenCalledWith(
        expect.objectContaining({
          doc_number: "СР-0000012",
          reference_number: "INV-2026-12",
          buyer: expect.objectContaining({
            name: "Бакалия Greek Deli Food",
            eik: "202860357",
            vat_number: "BG202860357",
            address: "бул. България 100",
            city: "София",
            phone: "0886291003",
            mol: "Евгени Терзийски",
          }),
          supplier: expect.objectContaining({
            name: "DELIFU",
            eik: "987654321",
            vat_number: "BG987654321",
            address: "ул. Доставчик 5",
            city: "Пловдив",
            phone: "0888000111",
            mol: "Никос",
          }),
          warehouse_name: "Основен склад, бул. Европа 1",
          items: [
            expect.objectContaining({
              sku: "SKU-12",
              name_bg: "Фета",
              unit: "kg",
              quantity: 2,
              unit_price: 7.5,
              total_price: 15,
              currency: "EUR",
            }),
          ],
        }),
      );
    } finally {
      await app.close();
    }
  });
});
