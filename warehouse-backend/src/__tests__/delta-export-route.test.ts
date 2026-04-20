import Fastify from "fastify";
import * as iconv from "iconv-lite";
import { beforeEach, describe, expect, it, vi } from "vitest";
import exportRoutes from "../routes/export.js";

vi.mock("../db.js", () => ({
  query: vi.fn(),
}));

import { query } from "../db.js";

const mockQuery = vi.mocked(query);

function resultRows<T>(rows: T[]) {
  return { rows } as any;
}

async function buildApp(role: "admin" | "accountant" | "warehouse" = "accountant") {
  const app = Fastify();

  app.addHook("onRequest", async (request) => {
    (request as any).user = {
      id: "u-accountant",
      email: "accountant@test.local",
      role,
    };
    (request as any).jwtVerify = async () => (request as any).user;
  });

  await app.register(exportRoutes, { prefix: "/export" });
  return app;
}

describe("delta export route", () => {
  beforeEach(() => {
    mockQuery.mockReset();
  });

  it("exports sales rows as CP1251 with document + payment pairs", async () => {
    mockQuery
      .mockResolvedValueOnce(
        resultRows([
          {
            invoice_number: "GF-2026-0001",
            invoice_date: "2026-05-03",
            total_gross: "120.00",
            total_vat: "20.00",
            include_vat: true,
            document_type: "invoice",
            partner_name: "Тест Клиент ЕООД",
            contact_person: "Иван Тестов",
            city: "София",
            address: "ул. Тест 1",
            vat_number: "BG123456789",
            eik: "123456789",
          },
          {
            invoice_number: "КИ-0000000042",
            invoice_date: "2026-05-04T12:30:00.000Z",
            total_gross: "48.00",
            total_vat: "8.00",
            include_vat: true,
            document_type: "credit_note",
            partner_name: "Тест Клиент ЕООД",
            contact_person: "Иван Тестов",
            city: "София",
            address: "ул. Тест 1",
            vat_number: "BG123456789",
            eik: "123456789",
          },
          {
            invoice_number: "ДИ-0000000055",
            invoice_date: "2026-05-05",
            total_gross: "60.00",
            total_vat: "10.00",
            include_vat: false,
            document_type: "debit_note",
            partner_name: "Тест Клиент ЕООД",
            contact_person: "Иван Тестов",
            city: "София",
            address: "ул. Тест 1",
            vat_number: "BG123456789",
            eik: "123456789",
          },
        ]),
      )
      .mockResolvedValueOnce(resultRows([]));

    const app = await buildApp();
    try {
      const res = await app.inject({
        method: "GET",
        url: "/export/delta-pro?from=2026-05-01&to=2026-05-31&type=all",
      });

      expect(res.statusCode).toBe(200);
      expect(res.headers["content-type"]).toContain("application/octet-stream");
      expect(res.headers["content-disposition"]).toContain("attachment; filename=");
      expect(mockQuery).toHaveBeenCalledTimes(2);

      const [salesSql, salesParams] = mockQuery.mock.calls[0] as [string, string[]];
      expect(salesSql).toContain("i.status = 'active'");
      expect(salesParams).toEqual(["2026-05-01", "2026-05-31"]);

      const decoded = iconv.decode(Buffer.from(res.rawPayload), "win1251");
      expect(decoded).toContain("\r\n");

      const lines = decoded.split("\r\n");
      expect(lines).toHaveLength(6);
      expect(lines[0]).toBe(
        "2|03.05.2026|0020260001|Ф-ра|120.00|16|Тест Клиент ЕООД|Иван Тестов|София|ул. Тест 1|BG123456789|123456789|   |Издадена фактура| |20.00",
      );
      expect(lines[1]).toBe(
        "10|03.05.2026|0020260001|Ф-ра|120.00|8|Тест Клиент ЕООД|Иван Тестов|София|ул. Тест 1|BG123456789|123456789|   |Плащане в брой| |0.00",
      );
      expect(lines[2]).toBe(
        "9|04.05.2026|0000000042|КИ|48.00|16|Тест Клиент ЕООД|Иван Тестов|София|ул. Тест 1|BG123456789|123456789|   |Кредитно известие| |8.00",
      );
      expect(lines[4]).toBe(
        "7|05.05.2026|0000000055|Д-ги|60.00|8|Тест Клиент ЕООД|Иван Тестов|София|ул. Тест 1|BG123456789|123456789|   |Дебитно известие| |0.00",
      );
    } finally {
      await app.close();
    }
  });

  it("exports only confirmed purchases and computes VAT for BG suppliers", async () => {
    mockQuery.mockResolvedValueOnce(
      resultRows([
        {
          invoice_number: "55",
          invoice_date: "2026-05-06",
          total_amount: "120.00",
          supplier_name: "БГ Доставчик ООД",
          contact_person: "Мария",
          address: "гр. Пловдив",
          vat_number: "BG987654321",
          eik: "987654321",
        },
        {
          invoice_number: "133",
          invoice_date: "2026-05-07",
          total_amount: "964.06",
          supplier_name: "DAGKOS ATHANASIOS",
          contact_person: "DAGKOS ATHANASIOS",
          address: "CHRISOSTOMOU SMIRNIS 71 DIAVATA",
          vat_number: "EL162507551",
          eik: "EL162507551",
        },
      ]),
    );

    const app = await buildApp("admin");
    try {
      const res = await app.inject({
        method: "GET",
        url: "/export/delta-pro?from=2026-05-01&to=2026-05-31&type=purchases",
      });

      expect(res.statusCode).toBe(200);
      expect(mockQuery).toHaveBeenCalledTimes(1);

      const [purchasesSql] = mockQuery.mock.calls[0] as [string, string[]];
      expect(purchasesSql).toContain("ig.status = 'confirmed'");

      const decoded = iconv.decode(Buffer.from(res.rawPayload), "win1251");
      const lines = decoded.split("\r\n");
      expect(lines).toEqual([
        "1|06.05.2026|0000000055|Ф-ра|120.00|16|БГ Доставчик ООД|Мария||гр. Пловдив|BG987654321|987654321|   |Получена фактура| |20.00",
        "10|06.05.2026|0000000055|Ф-ра|120.00|8|БГ Доставчик ООД|Мария||гр. Пловдив|BG987654321|987654321|   |Плащане в брой| |0.00",
        "1|07.05.2026|0000000133|Ф-ра|964.06|11|DAGKOS ATHANASIOS|DAGKOS ATHANASIOS||CHRISOSTOMOU SMIRNIS 71 DIAVATA|EL162507551|EL162507551|   |Получена фактура| |0.00",
        "10|07.05.2026|0000000133|Ф-ра|964.06|8|DAGKOS ATHANASIOS|DAGKOS ATHANASIOS||CHRISOSTOMOU SMIRNIS 71 DIAVATA|EL162507551|EL162507551|   |Плащане в брой| |0.00",
      ]);
    } finally {
      await app.close();
    }
  });

  it("forbids warehouse users from exporting", async () => {
    const app = await buildApp("warehouse");
    try {
      const res = await app.inject({
        method: "GET",
        url: "/export/delta-pro?from=2026-05-01&to=2026-05-31&type=sales",
      });

      expect(res.statusCode).toBe(403);
      expect(mockQuery).not.toHaveBeenCalled();
    } finally {
      await app.close();
    }
  });
});
