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

describe("POST /econt/create-shipment", () => {
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

  it("creates shipment with office code, persists to order", async () => {
    fetchMock.mockResolvedValueOnce({
      ok: true,
      json: async () => ({
        label: { shipmentNumber: "ABC123", pdfURL: "https://econt/x.pdf" },
      }),
    });
    mockQuery.mockResolvedValueOnce({ rows: [] } as any);

    const app = await buildApp();
    const res = await app.inject({
      method: "POST",
      url: "/econt/create-shipment",
      payload: {
        order_id: 42,
        receiverName: "Иван Петров",
        receiverPhone: "0888999000",
        receiverCity: "Пловдив",
        receiverOfficeCode: "4001",
        weight: 10,
        codAmount: 200,
      },
    });

    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.shipmentNumber).toBe("ABC123");
    expect(body.pdfURL).toBe("https://econt/x.pdf");
    expect(body.trackingUrl).toBe(
      "https://www.econt.com/services/track-shipment/ABC123",
    );

    // Assert DB update persisted shipment fields
    expect(mockQuery).toHaveBeenCalledTimes(1);
    const [sql, params] = mockQuery.mock.calls[0];
    expect(sql).toMatch(/UPDATE orders SET econt_shipment_number/);
    expect(params).toEqual([
      "ABC123",
      "https://www.econt.com/services/track-shipment/ABC123",
      "https://econt/x.pdf",
      42,
    ]);
  });

  it("falls back to searching offices by city when no code given", async () => {
    // First fetch = getOffices, second = createLabel
    fetchMock
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          offices: [
            {
              code: "4001",
              name: "Пловдив Офис 1",
              shipmentTypes: ["courier"],
              address: { city: { name: "Пловдив" } },
            },
            {
              code: "4002",
              name: "Пловдив",
              shipmentTypes: ["courier"],
              address: { city: { name: "Пловдив" } },
            },
          ],
        }),
      })
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          label: { shipmentNumber: "DEF456", pdfURL: "https://econt/y.pdf" },
        }),
      });
    mockQuery.mockResolvedValueOnce({ rows: [] } as any);

    const app = await buildApp();
    const res = await app.inject({
      method: "POST",
      url: "/econt/create-shipment",
      payload: {
        order_id: 43,
        receiverName: "Мария",
        receiverPhone: "0888",
        receiverCity: "Пловдив",
        weight: 5,
      },
    });
    expect(res.statusCode).toBe(200);
    // Main office fallback = the one whose name equals the city
    const createCall = JSON.parse(fetchMock.mock.calls[1][1].body);
    expect(createCall.label.receiverOfficeCode).toBe("4002");
  });

  it("uses receiverAddress when street is provided", async () => {
    fetchMock.mockResolvedValueOnce({
      ok: true,
      json: async () => ({
        label: { shipmentNumber: "GHI", pdfURL: "u" },
      }),
    });
    mockQuery.mockResolvedValueOnce({ rows: [] } as any);
    const app = await buildApp();
    await app.inject({
      method: "POST",
      url: "/econt/create-shipment",
      payload: {
        order_id: 44,
        receiverName: "X",
        receiverPhone: "0",
        receiverCity: "Варна",
        receiverStreet: "ул. Y",
        receiverNum: "5",
        weight: 3,
      },
    });
    const body = JSON.parse(fetchMock.mock.calls[0][1].body);
    expect(body.label.receiverAddress.street).toBe("ул. Y");
    expect(body.label.receiverAddress.num).toBe("5");
    expect(body.label.receiverOfficeCode).toBeUndefined();
  });

  it("returns 400 when no office found and no street given", async () => {
    fetchMock.mockResolvedValueOnce({
      ok: true,
      json: async () => ({ offices: [] }),
    });
    const app = await buildApp();
    const res = await app.inject({
      method: "POST",
      url: "/econt/create-shipment",
      payload: {
        order_id: 45,
        receiverName: "X",
        receiverPhone: "0",
        receiverCity: "НеизвестенГрад",
        weight: 3,
      },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toMatch(/НеизвестенГрад/);
  });

  it("does not UPDATE order when order_id is missing", async () => {
    fetchMock.mockResolvedValueOnce({
      ok: true,
      json: async () => ({
        label: { shipmentNumber: "JKL", pdfURL: "u" },
      }),
    });
    const app = await buildApp();
    const res = await app.inject({
      method: "POST",
      url: "/econt/create-shipment",
      payload: {
        receiverName: "X",
        receiverPhone: "0",
        receiverCity: "София",
        receiverOfficeCode: "1001",
        weight: 3,
      },
    });
    expect(res.statusCode).toBe(200);
    expect(mockQuery).not.toHaveBeenCalled();
  });
});
