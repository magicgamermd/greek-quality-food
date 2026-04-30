// warehouse-backend/src/__tests__/reports-daily.test.ts
//
// Integration tests for GET /reports/daily-pdf:
//   - admin happy path returns application/pdf
//   - non-permission user (warehouse) returns 403
//   - bad date format returns 400
//   - future date returns 200 (empty sections, still a valid PDF)
import Fastify, { FastifyInstance } from "fastify";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../db.js", () => ({
  query: vi.fn(async () => ({ rows: [] })),
  transaction: vi.fn(),
}));
vi.mock("../lib/redis.js", () => ({
  getRedis: vi.fn(async () => ({
    get: vi.fn(async () => null),
    setex: vi.fn(async () => "OK"),
    del: vi.fn(async () => 0),
  })),
}));
vi.mock("../services/daily-report-pdf.js", () => ({
  generateDailyReportPdf: vi.fn(async (data: any) => {
    // Write a tiny stub PDF so fs.createReadStream has something to read.
    const fs = await import("node:fs");
    fs.writeFileSync(data.outputPath, "%PDF-1.4\n%test\n");
  }),
}));

import { query } from "../db.js";
import reportsRoutes from "../routes/reports.js";

const mockQuery = vi.mocked(query);

function rows<T>(list: T[]) {
  return { rows: list } as any;
}

async function buildApp(role = "admin"): Promise<FastifyInstance> {
  const app = Fastify();
  app.addHook("onRequest", async (req) => {
    (req as any).user = { id: "u1", email: "test@mertm.bg", role };
    (req as any).jwtVerify = async () => (req as any).user;
  });
  await app.register(reportsRoutes, { prefix: "/reports" });
  return app;
}

describe("GET /reports/daily-pdf", () => {
  let app: FastifyInstance;

  beforeEach(() => mockQuery.mockReset());
  afterEach(async () => {
    if (app) await app.close();
  });

  it("returns 200 + application/pdf for admin with default date (today)", async () => {
    // Stub all queries (the assembler runs ~8 of them: settings + 7 aggregations).
    // Returning empty rows everywhere is fine — the route still produces a
    // valid empty-day PDF via the (mocked) generateDailyReportPdf service.
    mockQuery
      .mockResolvedValueOnce(rows([{ company_name: "Acme" }]))
      .mockResolvedValue(rows([]));

    app = await buildApp("admin");
    const res = await app.inject({ method: "GET", url: "/reports/daily-pdf" });
    expect(res.statusCode).toBe(200);
    expect(res.headers["content-type"]).toContain("application/pdf");
  });

  it("returns 200 for an explicit date in YYYY-MM-DD format", async () => {
    mockQuery
      .mockResolvedValueOnce(rows([{ company_name: "Acme" }]))
      .mockResolvedValue(rows([]));

    app = await buildApp("admin");
    const res = await app.inject({
      method: "GET",
      url: "/reports/daily-pdf?date=2026-04-30",
    });
    expect(res.statusCode).toBe(200);
  });

  it("returns 400 on invalid date format (/-separators)", async () => {
    app = await buildApp("admin");
    const res = await app.inject({
      method: "GET",
      url: "/reports/daily-pdf?date=2026/04/30",
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toMatch(/YYYY-MM-DD/);
  });

  it("returns 403 for warehouse role (no REPORTS_VIEW permission)", async () => {
    app = await buildApp("warehouse");
    const res = await app.inject({ method: "GET", url: "/reports/daily-pdf" });
    expect(res.statusCode).toBe(403);
  });

  it("returns 200 for a future date (sections are just empty)", async () => {
    mockQuery
      .mockResolvedValueOnce(rows([{ company_name: "Acme" }]))
      .mockResolvedValue(rows([]));

    app = await buildApp("admin");
    const future = new Date(Date.now() + 86400000).toISOString().slice(0, 10);
    const res = await app.inject({
      method: "GET",
      url: `/reports/daily-pdf?date=${future}`,
    });
    expect(res.statusCode).toBe(200);
  });
});
