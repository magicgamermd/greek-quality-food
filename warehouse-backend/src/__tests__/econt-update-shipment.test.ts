import Fastify from "fastify";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../db.js", () => ({
  query: vi.fn(),
  transaction: vi.fn(),
}));

import { query } from "../db.js";
import econtRoutes, { __resetEcontCaches } from "../routes/econt.js";

const mockQuery = vi.mocked(query);

async function buildApp() {
  const app = Fastify();
  app.addHook("onRequest", async (request) => {
    (request as any).user = { id: "u-1", email: "a@b.c", role: "admin" };
    (request as any).jwtVerify = async () => (request as any).user;
  });
  await app.register(econtRoutes, { prefix: "/econt" });
  return app;
}

describe("POST /econt/update-shipment", () => {
  const fetchMock = vi.fn();

  beforeEach(() => {
    fetchMock.mockReset();
    mockQuery.mockReset();
    __resetEcontCaches();
    vi.stubGlobal("fetch", fetchMock);
    process.env.ECONT_USERNAME = "u";
    process.env.ECONT_PASSWORD = "p";
    process.env.ECONT_SENDER_NAME = "MERT-M";
    process.env.ECONT_SENDER_PHONE = "0888111222";
    process.env.ECONT_SENDER_CITY = "София";
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("404 when order not found", async () => {
    mockQuery.mockResolvedValueOnce({ rows: [] } as any);
    const app = await buildApp();
    const res = await app.inject({
      method: "POST",
      url: "/econt/update-shipment",
      payload: { order_id: 99 },
    });
    expect(res.statusCode).toBe(404);
  });

  it("400 when order has no shipment number", async () => {
    mockQuery.mockResolvedValueOnce({
      rows: [{ id: 1, econt_shipment_number: null }],
    } as any);
    const app = await buildApp();
    const res = await app.inject({
      method: "POST",
      url: "/econt/update-shipment",
      payload: { order_id: 1 },
    });
    expect(res.statusCode).toBe(400);
  });

  it("recalculates COD/weight, deletes old, creates new", async () => {
    mockQuery
      // SELECT orders
      .mockResolvedValueOnce({
        rows: [
          {
            id: 7,
            econt_shipment_number: "OLD1",
            econt_receiver_name: "Иван",
            econt_receiver_phone: "0888",
            econt_office_code: "4001",
            econt_city: "Пловдив",
            econt_street: null,
            econt_street_num: null,
          },
        ],
      } as any)
      // SELECT SUM total_price
      .mockResolvedValueOnce({ rows: [{ total: "100.00" }] } as any)
      // SELECT weight sum
      .mockResolvedValueOnce({ rows: [{ tw: "5" }] } as any)
      // UPDATE orders
      .mockResolvedValueOnce({ rows: [] } as any);

    // fetch[0] = deleteLabels, fetch[1] = createLabel
    fetchMock
      .mockResolvedValueOnce({ ok: true, json: async () => ({}) })
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          label: { shipmentNumber: "NEW2", pdfURL: "https://econt/new.pdf" },
        }),
      });

    const app = await buildApp();
    const res = await app.inject({
      method: "POST",
      url: "/econt/update-shipment",
      payload: { order_id: 7 },
    });

    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.shipmentNumber).toBe("NEW2");
    expect(body.codAmount).toBeCloseTo(120, 2); // 100 * 1.2 VAT
    expect(body.weight).toBe(5);

    // Assert deleteLabels was called with the old number
    const deleteBody = JSON.parse(fetchMock.mock.calls[0][1].body);
    expect(deleteBody.shipmentNumbers).toEqual(["OLD1"]);

    // Assert the UPDATE SQL was issued
    const updateSql = mockQuery.mock.calls.at(-1)![0];
    expect(updateSql).toMatch(/UPDATE orders SET econt_shipment_number/);
  });

  it("continues when deleteLabels fails", async () => {
    mockQuery
      .mockResolvedValueOnce({
        rows: [
          {
            id: 8,
            econt_shipment_number: "OLDX",
            econt_receiver_name: "X",
            econt_receiver_phone: "0",
            econt_office_code: "1",
            econt_city: "София",
          },
        ],
      } as any)
      .mockResolvedValueOnce({ rows: [{ total: "0" }] } as any)
      .mockResolvedValueOnce({ rows: [{ tw: "1" }] } as any)
      .mockResolvedValueOnce({ rows: [] } as any);

    fetchMock
      .mockRejectedValueOnce(new Error("delete failed"))
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({ label: { shipmentNumber: "N2", pdfURL: "u" } }),
      });

    const app = await buildApp();
    const res = await app.inject({
      method: "POST",
      url: "/econt/update-shipment",
      payload: { order_id: 8 },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().shipmentNumber).toBe("N2");
  });
});
