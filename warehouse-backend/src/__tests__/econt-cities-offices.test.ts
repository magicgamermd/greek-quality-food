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

describe("econt cities/offices", () => {
  const fetchMock = vi.fn();

  beforeEach(() => {
    fetchMock.mockReset();
    __resetEcontCaches();
    vi.stubGlobal("fetch", fetchMock);
    process.env.ECONT_USERNAME = "u";
    process.env.ECONT_PASSWORD = "p";
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("returns empty list for short query", async () => {
    const app = await buildApp();
    const res = await app.inject({ method: "GET", url: "/econt/cities?q=П" });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ data: [] });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("filters cities by name substring (case-insensitive)", async () => {
    fetchMock.mockResolvedValueOnce({
      ok: true,
      json: async () => ({
        cities: [
          { id: 1, name: "София", nameEn: "Sofia", postCode: "1000" },
          { id: 2, name: "Пловдив", nameEn: "Plovdiv", postCode: "4000" },
          { id: 3, name: "Варна", nameEn: "Varna", postCode: "9000" },
        ],
      }),
    });

    const app = await buildApp();
    const res = await app.inject({ method: "GET", url: "/econt/cities?q=plo" });

    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.data).toHaveLength(1);
    expect(body.data[0]).toEqual({
      id: 2,
      name: "Пловдив",
      nameEn: "Plovdiv",
      postCode: "4000",
    });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("caches cities across requests", async () => {
    fetchMock.mockResolvedValueOnce({
      ok: true,
      json: async () => ({
        cities: [{ id: 1, name: "София", nameEn: "Sofia", postCode: "1000" }],
      }),
    });

    const app = await buildApp();
    await app.inject({ method: "GET", url: "/econt/cities?q=соф" });
    await app.inject({ method: "GET", url: "/econt/cities?q=sof" });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("filters offices by city (case-insensitive exact match)", async () => {
    fetchMock.mockResolvedValueOnce({
      ok: true,
      json: async () => ({
        offices: [
          {
            code: "1001",
            name: "София Офис 1",
            address: { fullAddress: "бул. X", city: { name: "София" } },
          },
          {
            code: "4001",
            name: "Пловдив Офис 1",
            address: { fullAddress: "ул. Y", city: { name: "Пловдив" } },
          },
        ],
      }),
    });

    const app = await buildApp();
    const res = await app.inject({
      method: "GET",
      url: "/econt/offices?city=пловдив",
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().data).toHaveLength(1);
    expect(res.json().data[0].code).toBe("4001");
  });

  it("rejects unauthenticated requests", async () => {
    const app = Fastify();
    await app.register(econtRoutes, { prefix: "/econt" });
    const res = await app.inject({
      method: "GET",
      url: "/econt/cities?q=sofia",
    });
    expect(res.statusCode).toBe(401);
  });
});
