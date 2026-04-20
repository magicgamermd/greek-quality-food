import Fastify from "fastify";
import { beforeEach, describe, expect, it, vi } from "vitest";
import incomingRoutes from "../routes/incoming.js";
import { normalizeAliasName } from "../utils/product-matching.js";

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

async function buildApp() {
  const app = Fastify();

  app.addHook("onRequest", async (request) => {
    (request as any).user = {
      id: "u-owner",
      email: "owner@test.local",
      role: "owner_mobile",
    };
    (request as any).jwtVerify = async () => (request as any).user;
  });

  await app.register(incomingRoutes, { prefix: "/incoming" });
  return app;
}

type AliasRecord = {
  id: number;
  alias_name: string;
  alias_name_normalized: string;
  product_id: number;
  supplier_id: number | null;
};

function buildStatefulTxClient() {
  const queries: Array<{ sql: string; params?: any[] }> = [];
  const aliases: AliasRecord[] = [];
  let nextIncomingId = 600;
  let nextItemId = 7000;
  let nextAliasId = 9000;

  const client = {
    aliases,
    queries,
    query: vi.fn(async (sql: string, params?: any[]) => {
      queries.push({ sql: String(sql), params });

      if (sql.includes("SELECT id FROM suppliers WHERE name ILIKE")) {
        return resultRows([{ id: 55 }]);
      }

      if (sql.includes("INSERT INTO incoming_goods")) {
        nextIncomingId += 1;
        return resultRows([
          {
            id: nextIncomingId,
            supplier_id: 55,
            invoice_number: params?.[1] ?? null,
            invoice_date: params?.[2] ?? "2026-04-14",
            document_type: params?.[3] ?? "invoice",
            scanned_file_path: params?.[4] ?? null,
            status: "pending",
          },
        ]);
      }

      if (sql.includes("SELECT id FROM products WHERE id = $1")) {
        return resultRows(params?.[0] === 321 ? [{ id: 321 }] : []);
      }

      if (sql.includes("SELECT pa.product_id")) {
        const normalizedCandidates = (params?.[0] ?? []) as string[];
        const rawCandidates = (params?.[1] ?? []) as string[];
        const supplierId = (params?.[2] ?? null) as number | null;
        const match = aliases.find((alias) => {
          const normalizedHit = normalizedCandidates.includes(alias.alias_name_normalized.toLowerCase());
          const rawHit = rawCandidates.includes(alias.alias_name.trim().toLowerCase());
          const supplierHit = supplierId == null || alias.supplier_id === supplierId || alias.supplier_id == null;
          return supplierHit && (normalizedHit || rawHit);
        });
        return resultRows(match ? [{ product_id: match.product_id }] : []);
      }

      if (sql.includes("INSERT INTO incoming_items")) {
        nextItemId += 1;
        return resultRows([
          {
            id: nextItemId,
            incoming_goods_id: params?.[0],
            product_id: params?.[1],
            batch_id: params?.[2] ?? null,
            quantity: params?.[3],
            unit_price: params?.[4],
            total_price: params?.[5],
          },
        ]);
      }

      if (sql.includes("SELECT id FROM product_aliases")) {
        const normalized = String(params?.[0] ?? "").toLowerCase();
        const supplierId = (params?.[1] ?? null) as number | null;
        const existing = aliases.find(
          (alias) =>
            alias.alias_name_normalized.toLowerCase() === normalized && alias.supplier_id === supplierId,
        );
        return resultRows(existing ? [{ id: existing.id }] : []);
      }

      if (sql.includes("INSERT INTO product_aliases")) {
        aliases.push({
          id: ++nextAliasId,
          alias_name: params?.[0],
          alias_name_normalized: params?.[1],
          product_id: params?.[2],
          supplier_id: params?.[3] ?? null,
        });
        return resultRows([]);
      }

      if (sql.includes("UPDATE product_aliases")) {
        const alias = aliases.find((entry) => entry.id === params?.[3]);
        if (alias) {
          alias.alias_name = params?.[0];
          alias.alias_name_normalized = params?.[1];
          alias.product_id = params?.[2];
        }
        return resultRows([]);
      }

      if (sql.includes("UPDATE incoming_goods SET total_amount")) {
        return resultRows([]);
      }

      return resultRows([]);
    }),
  };

  return client;
}

describe("incoming alias-learning second pass regression", () => {
  beforeEach(() => {
    mockQuery.mockReset();
    mockTransaction.mockReset();
    mockQuery.mockResolvedValue(resultRows([]));
  });

  it("persists a manually bound OCR alias on first pass and auto-matches an equivalent OCR row on second pass", async () => {
    const txClient = buildStatefulTxClient();
    mockTransaction.mockImplementation(async (fn: any) => fn(txClient as any));

    const app = await buildApp();
    try {
      const firstPassRawName = '  ФЕТА   СИРЕНЕ "250Г"  ';
      const secondPassRawName = "фета сирене 250г";

      const firstPass = await app.inject({
        method: "POST",
        url: "/incoming",
        payload: {
          supplier_name: "Test Supplier",
          invoice_number: "GF-ALIAS-1",
          invoice_date: "2026-04-14",
          document_type: "invoice",
          strict_review_mode: true,
          allow_auto_create_unmatched: false,
          visible_row_count: 1,
          extracted_row_count: 1,
          warnings: [],
          completeness_status: "complete",
          items: [
            {
              row_number: 1,
              page_number: 1,
              product_name_raw: firstPassRawName,
              product_name: "Feta Cheese 250g",
              name_bg: "Фета сирене 250г",
              product_id: 321,
              quantity: 5,
              unit_price: 4.5,
              unit: "бр",
            },
          ],
        },
      });

      expect(firstPass.statusCode).toBe(201);
      expect(txClient.aliases).toEqual([
        {
          id: 9001,
          alias_name: firstPassRawName.trim(),
          alias_name_normalized: normalizeAliasName(firstPassRawName),
          product_id: 321,
          supplier_id: 55,
        },
      ]);

      const secondPass = await app.inject({
        method: "POST",
        url: "/incoming",
        payload: {
          supplier_name: "Test Supplier",
          invoice_number: "GF-ALIAS-2",
          invoice_date: "2026-04-15",
          document_type: "invoice",
          strict_review_mode: false,
          allow_auto_create_unmatched: false,
          visible_row_count: 1,
          extracted_row_count: 1,
          warnings: [],
          completeness_status: "complete",
          items: [
            {
              row_number: 1,
              page_number: 1,
              product_name_raw: secondPassRawName,
              product_name: "Feta Cheese 250g",
              name_bg: "Фета сирене 250г",
              quantity: 3,
              unit_price: 4.5,
              unit: "бр",
            },
          ],
        },
      });

      expect(secondPass.statusCode).toBe(201);
      expect(secondPass.json().items[0].product_id).toBe(321);

      const aliasLookup = txClient.queries.find(
        ({ sql, params }) =>
          sql.includes("SELECT pa.product_id") &&
          Array.isArray(params?.[0]) &&
          (params?.[0] as string[]).includes(normalizeAliasName(secondPassRawName)),
      );
      expect(aliasLookup).toBeDefined();

      const secondIncomingItemInsert = [...txClient.queries]
        .reverse()
        .find(({ sql }) => sql.includes("INSERT INTO incoming_items"));
      expect(secondIncomingItemInsert?.params).toEqual([602, 321, null, 3, 4.5, 13.5, null]);

      expect(
        txClient.queries.some(({ sql }) => sql.includes("INSERT INTO products")),
      ).toBe(false);
    } finally {
      await app.close();
    }
  });
});
