import Fastify from "fastify";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../db.js", () => ({
  query: vi.fn(),
  transaction: vi.fn(),
}));

import econtRoutes, { __resetEcontCaches } from "../routes/econt.js";

async function buildApp() {
  const app = Fastify();
  app.addHook("onRequest", async (request) => {
    (request as any).user = { id: "u-1", email: "a@b.c", role: "admin" };
    (request as any).jwtVerify = async () => (request as any).user;
  });
  await app.register(econtRoutes, { prefix: "/econt" });
  return app;
}

describe("POST /econt/calculate", () => {
  const fetchMock = vi.fn();

  beforeEach(() => {
    fetchMock.mockReset();
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

  it("rejects missing receiverCity", async () => {
    const app = await buildApp();
    const res = await app.inject({
      method: "POST",
      url: "/econt/calculate",
      payload: { weight: 5 },
    });
    expect(res.statusCode).toBe(400);
  });

  it("calls Econt with calculate mode and converts BGN→EUR", async () => {
    fetchMock.mockResolvedValueOnce({
      ok: true,
      json: async () => ({ label: { totalPrice: 19.56 } }),
    });

    const app = await buildApp();
    const res = await app.inject({
      method: "POST",
      url: "/econt/calculate",
      payload: {
        receiverCity: "Пловдив",
        receiverOfficeCode: "4001",
        weight: 5,
        codAmount: 100,
      },
    });

    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.priceBGN).toBe(19.56);
    // 19.56 / 1.95583 ≈ 10.00 EUR
    expect(body.price).toBeCloseTo(10.0, 2);
    expect(body.currency).toBe("EUR");

    // Verify the request payload sent to Econt
    const call = fetchMock.mock.calls[0];
    expect(call[0]).toMatch(/createLabel\.json$/);
    const sentBody = JSON.parse(call[1].body);
    expect(sentBody.mode).toBe("calculate");
    expect(sentBody.label.receiverOfficeCode).toBe("4001");
    expect(sentBody.label.shipmentType).toBe("pack"); // weight 5 → pack
    expect(sentBody.label.weight).toBe(5);
    // COD converted EUR→BGN (100 * 1.95583 ≈ 195.58)
    expect(sentBody.label.services.cdAmount).toBeCloseTo(195.58, 2);
    expect(sentBody.label.services.cdCurrency).toBe("BGN");
  });

  it("uses receiverAddress when no office code is given", async () => {
    fetchMock.mockResolvedValueOnce({
      ok: true,
      json: async () => ({ label: { totalPrice: 0 } }),
    });
    const app = await buildApp();
    await app.inject({
      method: "POST",
      url: "/econt/calculate",
      payload: {
        receiverCity: "Варна",
        receiverStreet: "ул. Тест",
        receiverNum: "1",
        weight: 10,
      },
    });
    const sentBody = JSON.parse(fetchMock.mock.calls[0][1].body);
    expect(sentBody.label.receiverAddress.city.name).toBe("Варна");
    expect(sentBody.label.receiverAddress.street).toBe("ул. Тест");
    expect(sentBody.label.receiverOfficeCode).toBeUndefined();
  });

  it("chooses cargo shipmentType for 50<weight<=500", async () => {
    fetchMock.mockResolvedValueOnce({
      ok: true,
      json: async () => ({ label: { totalPrice: 0 } }),
    });
    const app = await buildApp();
    await app.inject({
      method: "POST",
      url: "/econt/calculate",
      payload: { receiverCity: "София", receiverOfficeCode: "1", weight: 100 },
    });
    expect(JSON.parse(fetchMock.mock.calls[0][1].body).label.shipmentType).toBe(
      "cargo",
    );
  });

  it("chooses pallet shipmentType for weight>500", async () => {
    fetchMock.mockResolvedValueOnce({
      ok: true,
      json: async () => ({ label: { totalPrice: 0 } }),
    });
    const app = await buildApp();
    await app.inject({
      method: "POST",
      url: "/econt/calculate",
      payload: { receiverCity: "София", receiverOfficeCode: "1", weight: 800 },
    });
    expect(JSON.parse(fetchMock.mock.calls[0][1].body).label.shipmentType).toBe(
      "pallet",
    );
  });
});
