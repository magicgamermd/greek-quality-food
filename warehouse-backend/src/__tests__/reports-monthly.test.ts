// warehouse-backend/src/__tests__/reports-monthly.test.ts
//
// Smoke tests for GET /reports/monthly-pdf:
//   - admin happy path returns application/pdf
//   - non-permission user (warehouse) returns 403
//   - bad month format returns 400
//   - default month (no query param) defaults to current YYYY-MM
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
vi.mock("../services/monthly-report-pdf.js", () => ({
  generateMonthlyReportPdf: vi.fn(async (data: { outputPath: string }) => {
    const fs = await import("node:fs");
    fs.writeFileSync(data.outputPath, "%PDF-1.4\n%test\n");
  }),
}));

import { query } from "../db.js";
import reportsRoutes from "../routes/reports.js";
import { generateMonthlyReportPdf } from "../services/monthly-report-pdf.js";

const mockQuery = vi.mocked(query);
const mockGen = vi.mocked(generateMonthlyReportPdf);

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

describe("GET /reports/monthly-pdf", () => {
  let app: FastifyInstance;

  beforeEach(() => {
    mockQuery.mockReset();
    mockGen.mockClear();
  });
  afterEach(async () => {
    if (app) await app.close();
  });

  it("returns 200 + application/pdf for admin with explicit month", async () => {
    // Stub all queries (~10 aggregations); empty rows are fine — асемблерът
    // строи валиден празен месечен отчет.
    mockQuery
      .mockResolvedValueOnce(rows([{ company_name: "Acme" }]))
      .mockResolvedValue(rows([]));

    app = await buildApp("admin");
    const res = await app.inject({
      method: "GET",
      url: "/reports/monthly-pdf?month=2026-04",
    });
    expect(res.statusCode).toBe(200);
    expect(res.headers["content-type"]).toContain("application/pdf");
    expect(mockGen).toHaveBeenCalledTimes(1);
    const callArg = mockGen.mock.calls[0][0];
    expect(callArg.month).toBe("2026-04");
  });

  it("defaults to current month when no query param", async () => {
    mockQuery
      .mockResolvedValueOnce(rows([{ company_name: "Acme" }]))
      .mockResolvedValue(rows([]));
    app = await buildApp("admin");
    const res = await app.inject({
      method: "GET",
      url: "/reports/monthly-pdf",
    });
    expect(res.statusCode).toBe(200);
    const today = new Date().toISOString().slice(0, 7);
    expect(mockGen.mock.calls[0][0].month).toBe(today);
  });

  it("returns 400 on invalid month format (full date)", async () => {
    app = await buildApp("admin");
    const res = await app.inject({
      method: "GET",
      url: "/reports/monthly-pdf?month=2026-04-30",
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toMatch(/YYYY-MM/);
  });

  it("returns 400 on invalid month format (slash separator)", async () => {
    app = await buildApp("admin");
    const res = await app.inject({
      method: "GET",
      url: "/reports/monthly-pdf?month=2026/04",
    });
    expect(res.statusCode).toBe(400);
  });

  it("returns 403 for warehouse role (no REPORTS_VIEW permission)", async () => {
    app = await buildApp("warehouse");
    const res = await app.inject({
      method: "GET",
      url: "/reports/monthly-pdf?month=2026-04",
    });
    expect(res.statusCode).toBe(403);
  });

  it("uses correct from/to range — first and last day of month", async () => {
    // Hijack-ваме query mock-а за да хванем `from`/`to` параметрите на
    // заявките. Февруари 2026 → 2026-02-01 .. 2026-02-28.
    mockQuery
      .mockResolvedValueOnce(rows([{ company_name: "Acme" }]))
      .mockResolvedValue(rows([]));
    app = await buildApp("admin");
    await app.inject({
      method: "GET",
      url: "/reports/monthly-pdf?month=2026-02",
    });
    // Първото извикване с range параметри е daily breakdown query —
    // взимаме всички calls и търсим тези с 2 string args.
    const rangeCalls = mockQuery.mock.calls.filter(
      (c: any[]) =>
        Array.isArray(c[1]) &&
        c[1].length === 2 &&
        c[1][0] === "2026-02-01" &&
        c[1][1] === "2026-02-28",
    );
    expect(rangeCalls.length).toBeGreaterThan(0);
  });
});
