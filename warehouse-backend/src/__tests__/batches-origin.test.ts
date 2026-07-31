// GET /batches?product_id — партидата казва ОТ КОЯ доставка е.
// Складът гледа партидите на продукт и трябва да знае произхода:
// номер на фактурата на доставчика и датата на приемане.
import Fastify from "fastify";
import { beforeEach, describe, expect, it, vi } from "vitest";
import batchRoutes from "../routes/batches.js";

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
    (request as any).user = { id: "u1", role: "admin" };
    (request as any).jwtVerify = async () => (request as any).user;
  });
  await app.register(batchRoutes, { prefix: "/batches" });
  return app;
}

describe("GET /batches — произход на партидата", () => {
  beforeEach(() => {
    mockQuery.mockReset();
    mockQuery.mockResolvedValue(rowsRes([]));
  });

  it("списъкът включва доставка (номер, дата, доставчик) чрез delivery_id", async () => {
    const app = await buildApp();
    try {
      const res = await app.inject({
        method: "GET",
        url: "/batches?product_id=59",
      });
      expect(res.statusCode).toBe(200);
      const sql = String(mockQuery.mock.calls[0][0]);
      expect(sql).toContain(
        "LEFT JOIN incoming_goods ig ON ig.id = b.delivery_id",
      );
      expect(sql).toContain("source_invoice_number");
      expect(sql).toContain("source_invoice_date");
      expect(sql).toContain("source_supplier_name");
    } finally {
      await app.close();
    }
  });
});
