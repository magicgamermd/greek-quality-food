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

describe("econt label-pdf / track / download", () => {
  const fetchMock = vi.fn();

  beforeEach(() => {
    fetchMock.mockReset();
    mockQuery.mockReset();
    __resetEcontCaches();
    vi.stubGlobal("fetch", fetchMock);
    process.env.ECONT_USERNAME = "u";
    process.env.ECONT_PASSWORD = "p";
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("GET /label-pdf returns cached DB URL without API call", async () => {
    mockQuery.mockResolvedValueOnce({
      rows: [{ econt_pdf_url: "https://econt/cached.pdf" }],
    } as any);
    const app = await buildApp();
    const res = await app.inject({
      method: "GET",
      url: "/econt/label-pdf/ABC",
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().pdfURL).toBe("https://econt/cached.pdf");
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("GET /label-pdf fetches and caches when DB empty", async () => {
    mockQuery
      .mockResolvedValueOnce({ rows: [{}] } as any) // no cached URL
      .mockResolvedValueOnce({ rows: [] } as any); // UPDATE
    fetchMock.mockResolvedValueOnce({
      ok: true,
      json: async () => ({ pdfURL: "https://econt/fresh.pdf" }),
    });
    const app = await buildApp();
    const res = await app.inject({
      method: "GET",
      url: "/econt/label-pdf/XYZ",
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().pdfURL).toBe("https://econt/fresh.pdf");
    // Second mockQuery call is the UPDATE caching step
    expect(mockQuery.mock.calls[1][0]).toMatch(
      /UPDATE orders SET econt_pdf_url/,
    );
  });

  it("GET /track returns statuses", async () => {
    fetchMock.mockResolvedValueOnce({
      ok: true,
      json: async () => ({
        shipmentStatuses: [
          { status: "delivered", time: "2026-04-21T10:00:00Z" },
        ],
      }),
    });
    const app = await buildApp();
    const res = await app.inject({ method: "GET", url: "/econt/track/SN42" });
    expect(res.statusCode).toBe(200);
    expect(res.json().shipmentNumber).toBe("SN42");
    expect(res.json().statuses).toHaveLength(1);
  });

  it("GET /label-pdf-download streams PDF binary from cached URL", async () => {
    const pdfBytes = Buffer.concat([
      Buffer.from([0x25, 0x50, 0x44, 0x46]), // "%PDF" magic
      Buffer.alloc(600, 0x20),
    ]);
    mockQuery.mockResolvedValueOnce({
      rows: [{ econt_pdf_url: "https://econt/cached.pdf" }],
    } as any);
    fetchMock.mockResolvedValueOnce({
      ok: true,
      arrayBuffer: async () =>
        pdfBytes.buffer.slice(
          pdfBytes.byteOffset,
          pdfBytes.byteOffset + pdfBytes.byteLength,
        ),
    });

    const app = await buildApp();
    const res = await app.inject({
      method: "GET",
      url: "/econt/label-pdf-download/SN99",
    });
    expect(res.statusCode).toBe(200);
    expect(res.headers["content-type"]).toBe("application/pdf");
    expect(res.headers["content-disposition"]).toMatch(/waybill-SN99/);
  });
});
