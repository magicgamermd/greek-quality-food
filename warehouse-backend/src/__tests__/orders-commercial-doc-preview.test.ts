import Fastify from "fastify";
import fs from "node:fs";
import { beforeEach, describe, expect, it, vi } from "vitest";
import ordersRoutes from "../routes/orders.js";

vi.mock("../db.js", () => ({
  query: vi.fn(),
  transaction: vi.fn(),
}));

// Улавяме редовете, подадени към PDF генератора, и пишем stub файл, за да
// може endpoint-ът да stream-не нещо (без да генерираме истинско PDF).
const capturedItems: any[] = [];
vi.mock("../services/document-pdf.js", async (importActual) => {
  const actual = await importActual<any>();
  return {
    ...actual,
    generateCommercialDocPdf: vi.fn(async ({ outputPath, items }: any) => {
      capturedItems.length = 0;
      capturedItems.push(...items);
      fs.writeFileSync(outputPath, "%PDF-1.4\n%stub\n");
    }),
  };
});

import { query, transaction } from "../db.js";

const mockQuery = vi.mocked(query);
const mockTransaction = vi.mocked(transaction);

function resultRows<T>(rows: T[]) {
  return { rows } as any;
}

async function buildApp() {
  const app = Fastify();
  app.addHook("onRequest", async (request) => {
    (request as any).user = {
      id: "u-admin",
      email: "admin@test.local",
      role: "admin",
    };
    (request as any).jwtVerify = async () => (request as any).user;
  });
  await app.register(ordersRoutes, { prefix: "/orders" });
  return app;
}

describe("commercial document — FEFO preview before fulfilment", () => {
  beforeEach(() => {
    mockQuery.mockReset();
    mockTransaction.mockReset();
    capturedItems.length = 0;
  });

  it("shows batch + expiry from the FEFO preview for a confirmed (not-yet-fulfilled) order", async () => {
    // Регресия/фийчър: партидите на ред от поръчка се записват в
    // order_item_batches чак при ЕКСПЕДИРАНЕ (deductBatched). Затова
    // търговският документ, отворен веднага след създаване на поръчката,
    // излизаше без партиди/срокове (fallback ред). Сега за неекспедиран
    // ред показваме FEFO ПРЕДВИЖДАНЕ (кои партиди ще излязат), така че
    // документът е пълен веднага — без да се пипа наличност или статус.

    // 1) loadOrderWithBatches → поръчката (статус confirmed = разрешено, но
    //    още неекспедирано).
    mockQuery.mockResolvedValueOnce(
      resultRows([
        {
          id: 5,
          order_number: 5,
          status: "confirmed",
          order_date: "2026-07-09",
          created_at: "2026-07-09T08:00:00Z",
          partner_id: 3,
          partner_name: "ТЕСТ КЛИЕНТ ООД",
          partner_eik: "111222333",
          partner_address: "ул. Тест 1",
          partner_city: "София",
          partner_phone: "0888000000",
          invoice_partner_id: null,
        },
      ]),
    );
    // 2) loadOrderWithBatches → редовете (нормален ред, с product_id + количество).
    mockQuery.mockResolvedValueOnce(
      resultRows([
        {
          id: 1,
          order_id: 5,
          product_id: 42,
          quantity: "4",
          line_status: "normal",
          sku: "SKU-42",
          name_bg: "Гръцко сирене",
          name_en: "Greek cheese",
          unit: "кг",
          brand: "OLYMPUS",
          batch_number: null,
          expiry_date: null,
        },
      ]),
    );
    // 3) getCompanySettings → SELECT * FROM settings WHERE id = 1
    mockQuery.mockResolvedValueOnce(resultRows([{}]));
    // 4) allocationRows (реалните order_item_batches) → ПРАЗНО (неекспедирано).
    mockQuery.mockResolvedValueOnce(resultRows([]));

    // Preview-ът: transaction((client) => allocateFefo(client, ...)). allocateFefo
    // прави ЕДНА заявка към inventory. Даваме партида L-777 със срок и наличност.
    mockTransaction.mockImplementation(async (callback: any) =>
      callback({
        query: vi.fn().mockResolvedValue(
          resultRows([
            {
              batch_id: 77,
              batch_number: "L-777",
              expiry_date: "2026-09-15",
              purchase_price: 3.2,
              available: 10,
            },
          ]),
        ),
      }),
    );

    const app = await buildApp();
    try {
      const res = await app.inject({
        method: "GET",
        url: "/orders/5/commercial-doc-pdf",
      });

      expect(res.statusCode).toBe(200);

      // Документът вече носи партидата + срока от предвиждането — не празен ред.
      expect(capturedItems).toHaveLength(1);
      expect(capturedItems[0]).toMatchObject({
        sku: "SKU-42",
        name_bg: "Гръцко сирене",
        quantity: 4,
        batch_number: "L-777",
        expiry_date: "2026-09-15",
      });
    } finally {
      await app.close();
    }
  });
});
