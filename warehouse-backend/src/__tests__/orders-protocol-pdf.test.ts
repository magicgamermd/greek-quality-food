// Smoke tests for the GET /orders/:id/protocol-pdf endpoint added by
// Batch G+H. Exercise: route exists, returns 404 for missing order,
// streams a PDF for an existing one (with the service mocked).
import Fastify from "fastify";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

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
vi.mock("../services/protocol-pdf.js", () => ({
  generateProtocolPdf: vi.fn(async (data: { outputPath: string }) => {
    // Write a tiny PDF-looking file so the route's createReadStream
    // doesn't ENOENT. Content doesn't matter for these tests.
    const fs = await import("node:fs");
    const path = await import("node:path");
    const dir = path.dirname(data.outputPath);
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(data.outputPath, "%PDF-1.4\n");
  }),
}));

import { query } from "../db.js";
import ordersRoutes from "../routes/orders.js";

const mockQuery = vi.mocked(query);

function rows<T>(list: T[]) {
  return { rows: list } as any;
}

async function buildApp() {
  const app = Fastify();
  app.addHook("onRequest", async (req) => {
    (req as any).user = { id: "u-admin", email: "x@y", role: "admin" };
    (req as any).jwtVerify = async () => (req as any).user;
  });
  await app.register(ordersRoutes, { prefix: "/orders" });
  return app;
}

describe("GET /orders/:id/protocol-pdf", () => {
  let app: any;

  beforeEach(() => mockQuery.mockReset());
  afterEach(async () => {
    if (app) await app.close();
  });

  it("returns 404 when order does not exist", async () => {
    mockQuery
      // loadOrderWithBatches: SELECT order
      .mockResolvedValueOnce(rows([]));

    app = await buildApp();
    const res = await app.inject({
      method: "GET",
      url: "/orders/9999/protocol-pdf",
    });
    expect(res.statusCode).toBe(404);
  });

  it("returns a PDF stream for an existing order", async () => {
    // loadOrderWithBatches: SELECT order JOIN partners
    mockQuery.mockResolvedValueOnce(
      rows([
        {
          id: 1,
          order_number: 42,
          partner_id: 7,
          invoice_id: null,
        },
      ]),
    );
    // loadOrderWithBatches: SELECT items
    mockQuery.mockResolvedValueOnce(
      rows([
        {
          id: 1001,
          order_id: 1,
          name_bg: "Скара X",
          quantity: "1",
          unit_price: "100",
          total_price: "100",
          unit: "бр.",
        },
      ]),
    );
    // getCompanySettings: SELECT * FROM settings WHERE id = 1
    mockQuery.mockResolvedValueOnce(
      rows([
        {
          company_name: "MERT-M",
          eik: "1",
          city: "София",
          mol: "Иван Иванов",
        },
      ]),
    );
    // SELECT name, eik, contact_person FROM partners
    mockQuery.mockResolvedValueOnce(
      rows([
        {
          name: "Партньор",
          eik: "999",
          contact_person: "Петър Петров",
        },
      ]),
    );

    app = await buildApp();
    const res = await app.inject({
      method: "GET",
      url: "/orders/1/protocol-pdf",
    });

    expect(res.statusCode).toBe(200);
    expect(res.headers["content-type"]).toMatch(/application\/pdf/);
  });
});
