// Batch — Econt calendar validation
// POST /econt/validate-shipment-date wraps Econt's createLabel API in
// `mode: "validate"` and reflects success/failure back as
// {valid:bool, reason?:string}. The 24h in-memory cache lets the
// frontend calendar re-open without hitting Econt for the same
// route+date.

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

describe("POST /econt/validate-shipment-date", () => {
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

  it("rejects missing required fields", async () => {
    const app = await buildApp();
    const res = await app.inject({
      method: "POST",
      url: "/econt/validate-shipment-date",
      payload: { receiverCity: "Пловдив" }, // missing weight + date
    });
    expect(res.statusCode).toBe(400);
  });

  it("returns {valid:true} when Econt accepts the date", async () => {
    fetchMock.mockResolvedValueOnce({
      ok: true,
      json: async () => ({ label: {} }),
    });

    const app = await buildApp();
    const res = await app.inject({
      method: "POST",
      url: "/econt/validate-shipment-date",
      payload: {
        receiverCity: "Пловдив",
        receiverOfficeCode: "4001",
        weight: 5,
        date: "2026-05-08",
      },
    });

    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ valid: true });

    const call = fetchMock.mock.calls[0];
    const sent = JSON.parse(call[1].body);
    expect(sent.mode).toBe("validate");
    expect(sent.label.sendDate).toBe("2026-05-08");
    expect(sent.label.receiverOfficeCode).toBe("4001");
  });

  it("returns {valid:false, reason} when Econt rejects the date", async () => {
    fetchMock.mockResolvedValueOnce({
      ok: false,
      text: async () =>
        JSON.stringify({
          message: "Error",
          innerErrors: [
            { message: "Моля, изберете ден за доставка на пратката" },
          ],
        }),
    });

    const app = await buildApp();
    const res = await app.inject({
      method: "POST",
      url: "/econt/validate-shipment-date",
      payload: {
        receiverCity: "Пловдив",
        receiverStreet: "ул. Тестова",
        receiverNum: "1",
        weight: 5,
        date: "2026-05-09", // a Saturday
      },
    });

    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.valid).toBe(false);
    expect(body.reason).toContain("Моля, изберете ден");
  });

  it("caches the same route+date for 24h (second call doesn't hit Econt)", async () => {
    fetchMock.mockResolvedValueOnce({
      ok: true,
      json: async () => ({ label: {} }),
    });

    const app = await buildApp();
    const payload = {
      receiverCity: "Варна",
      receiverOfficeCode: "9001",
      weight: 3,
      date: "2026-05-12",
    };

    const r1 = await app.inject({
      method: "POST",
      url: "/econt/validate-shipment-date",
      payload,
    });
    expect(r1.json()).toEqual({ valid: true });

    // Second call — fetch should NOT have been invoked again.
    const r2 = await app.inject({
      method: "POST",
      url: "/econt/validate-shipment-date",
      payload,
    });
    expect(r2.json()).toEqual({ valid: true });

    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("address-mode payload omits receiverOfficeCode", async () => {
    fetchMock.mockResolvedValueOnce({
      ok: true,
      json: async () => ({ label: {} }),
    });

    const app = await buildApp();
    await app.inject({
      method: "POST",
      url: "/econt/validate-shipment-date",
      payload: {
        receiverCity: "София",
        receiverStreet: "ул. Александър Македонски",
        receiverNum: "11",
        weight: 10,
        date: "2026-05-08",
      },
    });

    const sent = JSON.parse(fetchMock.mock.calls[0][1].body);
    expect(sent.label.receiverOfficeCode).toBeUndefined();
    expect(sent.label.receiverAddress).toMatchObject({
      street: "ул. Александър Македонски",
      num: "11",
    });
  });
});
