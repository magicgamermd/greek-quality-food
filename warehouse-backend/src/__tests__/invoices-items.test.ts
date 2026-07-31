// GET /invoices/:id/items — редовете на поръчката зад фактурата.
// Нужен на диалога „Кредитно известие" (Фактури): за частично КИ
// потребителят избира продукти/количества от оригиналната фактура.
import Fastify from "fastify";
import { beforeEach, describe, expect, it, vi } from "vitest";
import invoiceRoutes from "../routes/invoices.js";

vi.mock("../db.js", () => ({
  query: vi.fn(),
  transaction: vi.fn(),
}));

import { query } from "../db.js";

const mockQuery = vi.mocked(query);

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

describe("GET /invoices/:id/items", () => {
  beforeEach(() => {
    mockQuery.mockReset();
  });

  it("връща редовете на свързаната поръчка (без awaiting)", async () => {
    mockQuery
      // 1: фактурата съществува
      .mockResolvedValueOnce(
        rowsRes([{ id: 100, document_type: "invoice", status: "active" }]),
      )
      // 2: поръчката зад нея
      .mockResolvedValueOnce(rowsRes([{ id: 50 }]))
      // 3: редовете
      .mockResolvedValueOnce(
        rowsRes([
          {
            order_item_id: 11,
            product_id: 5,
            name_bg: "Сирене",
            sku: "SIR-1",
            unit: "кг",
            quantity: "2",
            unit_price: "50",
            total_price: "100",
          },
        ]),
      );

    const app = await buildApp();
    try {
      const res = await app.inject({
        method: "GET",
        url: "/invoices/100/items",
      });
      expect(res.statusCode).toBe(200);
      const body = res.json();
      expect(body.order_id).toBe(50);
      expect(body.data).toHaveLength(1);
      expect(body.data[0]).toMatchObject({
        order_item_id: 11,
        name_bg: "Сирене",
        quantity: "2",
        unit_price: "50",
      });
      // awaiting редовете не участват в КИ — заявката ги изключва.
      const itemsSql = String(mockQuery.mock.calls[2][0]);
      expect(itemsSql).toContain("line_status != 'awaiting'");
    } finally {
      await app.close();
    }
  });

  it("фактура без свързана поръчка → празен списък, не грешка", async () => {
    mockQuery
      .mockResolvedValueOnce(
        rowsRes([{ id: 100, document_type: "invoice", status: "active" }]),
      )
      .mockResolvedValueOnce(rowsRes([]));

    const app = await buildApp();
    try {
      const res = await app.inject({
        method: "GET",
        url: "/invoices/100/items",
      });
      expect(res.statusCode).toBe(200);
      expect(res.json()).toEqual({ order_id: null, data: [] });
    } finally {
      await app.close();
    }
  });

  it("несъществуваща фактура → 404", async () => {
    mockQuery.mockResolvedValueOnce(rowsRes([]));

    const app = await buildApp();
    try {
      const res = await app.inject({
        method: "GET",
        url: "/invoices/999/items",
      });
      expect(res.statusCode).toBe(404);
    } finally {
      await app.close();
    }
  });
});
