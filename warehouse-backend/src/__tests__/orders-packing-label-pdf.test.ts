// Smoke tests for GET /orders/:id/packing-label-pdf — internal box
// label printed during warehouse packing. Mirrors the protocol-pdf
// test pattern: route exists, returns 404 for missing order, streams
// a PDF for an existing one.
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
vi.mock("../services/packing-label-pdf.js", () => ({
  generatePackingLabelPdf: vi.fn(async (data: { outputPath: string }) => {
    const fs = await import("node:fs");
    const path = await import("node:path");
    fs.mkdirSync(path.dirname(data.outputPath), { recursive: true });
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

describe("GET /orders/:id/packing-label-pdf", () => {
  let app: any;

  beforeEach(() => mockQuery.mockReset());
  afterEach(async () => {
    if (app) await app.close();
  });

  it("returns 404 when order does not exist", async () => {
    mockQuery.mockResolvedValueOnce(rows([])); // loadOrderWithBatches: SELECT order

    app = await buildApp();
    const res = await app.inject({
      method: "GET",
      url: "/orders/9999/packing-label-pdf",
    });
    expect(res.statusCode).toBe(404);
  });

  it("returns a PDF stream for a pickup order", async () => {
    // loadOrderWithBatches: SELECT order JOIN partners
    mockQuery.mockResolvedValueOnce(
      rows([
        {
          id: 1,
          order_number: 42,
          partner_id: 7,
          partner_name: "СТАД-БЛИЗНАКОВ ЕООД",
          econt_city: null,
        },
      ]),
    );
    // loadOrderWithBatches: SELECT items
    mockQuery.mockResolvedValueOnce(
      rows([
        {
          id: 1001,
          order_id: 1,
          name_bg: "АСЕТ-АРМАТУРА ГОЛД",
          quantity: "5",
          unit: "бр.",
        },
      ]),
    );

    app = await buildApp();
    const res = await app.inject({
      method: "GET",
      url: "/orders/1/packing-label-pdf",
    });

    expect(res.statusCode).toBe(200);
    expect(res.headers["content-type"]).toMatch(/application\/pdf/);
  });

  it("returns a PDF stream for an Econt office order", async () => {
    mockQuery.mockResolvedValueOnce(
      rows([
        {
          id: 2,
          order_number: 43,
          partner_id: 8,
          partner_name: "Кафе Балкан ООД",
          econt_city: "София",
          econt_delivery_type: "office",
          econt_office_name: "Офис Витоша",
        },
      ]),
    );
    mockQuery.mockResolvedValueOnce(rows([])); // empty items list — still valid

    app = await buildApp();
    const res = await app.inject({
      method: "GET",
      url: "/orders/2/packing-label-pdf",
    });

    expect(res.statusCode).toBe(200);
    expect(res.headers["content-type"]).toMatch(/application\/pdf/);
  });
});
