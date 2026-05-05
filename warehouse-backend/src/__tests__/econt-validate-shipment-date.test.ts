// Econt calendar validation
// POST /econt/validate-shipment-date wraps Econt's createLabel API in
// `mode:"validate"`. Office delivery short-circuits to {valid:true}
// (Econt accepts every date for any office). Address delivery sends a
// complete payload — senderAgent + shipmentDescription, receiverAgent
// matching receiverClient — and classifies Econt errors:
// date-specific rejections become {valid:false}, config errors soft-
// fail to {valid:true}. 24h in-memory cache by route+date.

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

  it("office mode short-circuits to valid without calling Econt", async () => {
    const app = await buildApp();
    const res = await app.inject({
      method: "POST",
      url: "/econt/validate-shipment-date",
      payload: {
        receiverCity: "Пловдив",
        receiverOfficeCode: "4001",
        weight: 5,
        date: "2026-05-09", // a Saturday — would block in static rules
      },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ valid: true });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("address mode: returns {valid:true} when Econt accepts the date", async () => {
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
        receiverStreet: "ул. Тестова",
        receiverNum: "1",
        weight: 5,
        date: "2026-05-08",
      },
    });

    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ valid: true });

    const sent = JSON.parse(fetchMock.mock.calls[0][1].body);
    expect(sent.mode).toBe("validate");
    expect(sent.label.sendDate).toBe("2026-05-08");
    expect(sent.label.receiverAddress).toMatchObject({
      street: "ул. Тестова",
      num: "1",
    });
    // The fix: complete payload Econt requires for validate mode.
    expect(sent.label.senderAgent).toBeDefined();
    expect(sent.label.receiverAgent).toBeDefined();
    expect(sent.label.shipmentDescription).toBeTruthy();
  });

  it("address mode: returns {valid:false, reason} on date-specific Econt rejection", async () => {
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
        receiverCity: "София",
        receiverStreet: "ул. Тестова",
        receiverNum: "1",
        weight: 5,
        date: "2026-05-08",
      },
    });

    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.valid).toBe(false);
    expect(body.reason).toContain("Моля, изберете ден");
  });

  it("address mode: soft-fails to {valid:true} on a non-date Econt rejection", async () => {
    // E.g. sender misconfig — Econt's wording doesn't mention the date.
    // We treat this as 'Econt validation never got to date check' and
    // let the user pick the day; the actual create-shipment call will
    // surface the same error properly.
    fetchMock.mockResolvedValueOnce({
      ok: false,
      text: async () =>
        JSON.stringify({
          message: "Error",
          innerErrors: [
            {
              message:
                "За юридическо лице, задължително се попълва упълномощено лице.",
            },
          ],
        }),
    });

    const app = await buildApp();
    const res = await app.inject({
      method: "POST",
      url: "/econt/validate-shipment-date",
      payload: {
        receiverCity: "София",
        receiverStreet: "ул. Тестова",
        receiverNum: "1",
        weight: 5,
        date: "2026-05-09",
      },
    });

    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ valid: true });
  });

  it("caches address-mode result for 24h (second call doesn't hit Econt)", async () => {
    fetchMock.mockResolvedValueOnce({
      ok: true,
      json: async () => ({ label: {} }),
    });

    const app = await buildApp();
    const payload = {
      receiverCity: "Варна",
      receiverStreet: "ул. Морска",
      receiverNum: "5",
      weight: 3,
      date: "2026-05-12",
    };

    const r1 = await app.inject({
      method: "POST",
      url: "/econt/validate-shipment-date",
      payload,
    });
    expect(r1.json()).toEqual({ valid: true });

    const r2 = await app.inject({
      method: "POST",
      url: "/econt/validate-shipment-date",
      payload,
    });
    expect(r2.json()).toEqual({ valid: true });

    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});
