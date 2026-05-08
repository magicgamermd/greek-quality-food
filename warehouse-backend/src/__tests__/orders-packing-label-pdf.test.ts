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
import { generatePackingLabelPdf } from "../services/packing-label-pdf.js";

const mockQuery = vi.mocked(query);
const mockGen = vi.mocked(generatePackingLabelPdf);

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

  beforeEach(() => {
    mockQuery.mockReset();
    mockGen.mockClear();
  });
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

  it("passes replacement flag and per-item is_returning to the generator", async () => {
    // Замяна order (#181 от UI screenshot-a): two give lines, two return
    // lines. Ензикалият тест е, че route-ът пробутва is_replacement и
    // is_returning надолу, иначе принтираната бележка не различава "дай"
    // от "приеми обратно".
    mockQuery.mockResolvedValueOnce(
      rows([
        {
          id: 181,
          order_number: 181,
          partner_id: 9,
          partner_name: "Физическо лице — краен потребител",
          econt_city: null,
          is_replacement: true,
        },
      ]),
    );
    mockQuery.mockResolvedValueOnce(
      rows([
        {
          id: 5001,
          order_id: 181,
          name_bg: "САК ЗА ШАТРА 3*3 NEW Y-804",
          quantity: "1",
          unit: "бр.",
          is_returning: false,
        },
        {
          id: 5002,
          order_id: 181,
          name_bg: "САК ЗА ШАТРА 3*4.5 Y-2085",
          quantity: "1",
          unit: "бр.",
          is_returning: true,
        },
      ]),
    );

    app = await buildApp();
    const res = await app.inject({
      method: "GET",
      url: "/orders/181/packing-label-pdf",
    });

    expect(res.statusCode).toBe(200);
    expect(mockGen).toHaveBeenCalledTimes(1);
    const callArg = mockGen.mock.calls[0][0];
    expect(callArg.isReplacement).toBe(true);
    expect(callArg.items).toEqual([
      expect.objectContaining({
        name_bg: "САК ЗА ШАТРА 3*3 NEW Y-804",
        is_returning: false,
      }),
      expect.objectContaining({
        name_bg: "САК ЗА ШАТРА 3*4.5 Y-2085",
        is_returning: true,
      }),
    ]);
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
