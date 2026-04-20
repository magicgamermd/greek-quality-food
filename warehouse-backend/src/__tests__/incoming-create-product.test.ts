import Fastify from "fastify";
import { beforeEach, describe, expect, it, vi } from "vitest";
import incomingRoutes from "../routes/incoming.js";

vi.mock("../db.js", () => ({
  query: vi.fn(),
  transaction: vi.fn(),
}));

import { query, transaction } from "../db.js";

const mockQuery = vi.mocked(query);
const mockTransaction = vi.mocked(transaction);

function resultRows<T>(rows: T[]) {
  return { rows } as any;
}

function createPayload() {
  return {
    supplier_name: null,
    invoice_number: null,
    invoice_date: "2026-04-14",
    document_type: "invoice",
    strict_review_mode: false,
    allow_auto_create_unmatched: true,
    visible_row_count: 1,
    extracted_row_count: 1,
    warnings: [],
    completeness_status: "complete",
    items: [
      {
        row_number: 1,
        page_number: 1,
        product_name_raw: "НОВ ДЕЛИКАТЕС 250Г",
        product_name: "NEW DELICACY 250G",
        name_bg: "НОВ ДЕЛИКАТЕС 250Г",
        quantity: 3,
        unit_price: 7.8,
        selling_price: 12.4,
        unit: "бр",
      },
    ],
  };
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

  await app.register(incomingRoutes, { prefix: "/incoming" });
  return app;
}

describe("incoming unresolved row auto-create", () => {
  beforeEach(() => {
    mockQuery.mockReset();
    mockTransaction.mockReset();
  });

  it("creates a new product and links the incoming item when auto-create is allowed", async () => {
    mockQuery.mockResolvedValue(resultRows([]));

    const txQueries: Array<{ sql: string; params?: any[] }> = [];
    const txClient = {
      query: vi.fn(async (sql: string, params?: any[]) => {
        txQueries.push({ sql: String(sql), params });

        if (sql.includes("INSERT INTO incoming_goods")) {
          return resultRows([
            {
              id: 601,
              supplier_id: null,
              invoice_number: null,
              invoice_date: "2026-04-14",
              document_type: "invoice",
              scanned_file_path: null,
              status: "pending",
            },
          ]);
        }
        if (sql.includes("SELECT sku FROM products")) {
          return resultRows([{ sku: "10041" }]);
        }
        if (sql.includes("INSERT INTO products")) {
          return resultRows([{ id: 912 }]);
        }
        if (sql.includes("INSERT INTO incoming_items")) {
          return resultRows([
            {
              id: 7001,
              incoming_goods_id: 601,
              product_id: 912,
              batch_id: null,
              quantity: 3,
              unit_price: 7.8,
              total_price: 23.4,
            },
          ]);
        }
        if (sql.includes("SELECT id FROM product_aliases")) {
          return resultRows([]);
        }
        if (sql.includes("INSERT INTO product_aliases")) {
          return resultRows([]);
        }
        if (sql.includes("UPDATE incoming_goods SET total_amount")) {
          return resultRows([]);
        }
        return resultRows([]);
      }),
    };

    mockTransaction.mockImplementation(async (callback: any) =>
      callback(txClient as any),
    );

    const app = await buildApp();
    try {
      const res = await app.inject({
        method: "POST",
        url: "/incoming",
        payload: createPayload(),
      });

      expect(res.statusCode).toBe(201);
      expect(res.json()).toMatchObject({
        id: 601,
        total_amount: 23.4,
        items: [
          {
            id: 7001,
            product_id: 912,
            quantity: 3,
          },
        ],
      });

      const productInsert = txQueries.find(({ sql }) =>
        sql.includes("INSERT INTO products"),
      );
      expect(productInsert).toBeDefined();
      expect(productInsert?.params).toEqual([
        "НОВ ДЕЛИКАТЕС 250Г",
        "NEW DELICACY 250G",
        "10042",
        "pcs",
        null,
        null,
        7.8,
        12.4,
      ]);

      const incomingItemInsert = txQueries.find(({ sql }) =>
        sql.includes("INSERT INTO incoming_items"),
      );
      // MERT-M: no batch_id column on the insert any more.
      expect(incomingItemInsert?.params).toEqual([
        601, 912, 3, 7.8, 23.4, 12.4,
      ]);

      const aliasInsert = txQueries.find(({ sql }) =>
        sql.includes("INSERT INTO product_aliases"),
      );
      expect(aliasInsert?.params).toEqual([
        "НОВ ДЕЛИКАТЕС 250Г",
        "нов деликатес 250г",
        912,
        null,
      ]);
    } finally {
      await app.close();
    }
  });

  // MERT-M: the "creates pending batches with zero quantity" test was
  // removed — the incoming route no longer creates batches; any
  // batch_number / expiry_date keys are stripped by the Zod schema.
});
