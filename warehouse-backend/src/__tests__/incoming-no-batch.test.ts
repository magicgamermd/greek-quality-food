// MERT-M Foundation — Task 7: incoming route must be batch-free.
//
// The upstream plan describes this test file with a `/auth/login` +
// `build()` bootstrap using a seeded admin user (admin@mertm.bg). No seed
// script for that user exists in this repo, so a real login would fail at
// `beforeAll`. We instead use the project pattern: `vi.mock("../db.js")`
// + auth injected via `onRequest` hook (see `inventory-no-batch.test.ts`
// and `incoming-confirm-inventory.test.ts`). The assertions from the plan
// (no `batch_number`/`expiry_date` on returned items) remain unchanged.
import Fastify, { FastifyInstance } from "fastify";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

vi.mock("../db.js", () => ({
  query: vi.fn(async () => ({ rows: [] })),
  transaction: vi.fn(),
}));

import { query, transaction } from "../db.js";
import incomingRoutes from "../routes/incoming.js";

const mockQuery = vi.mocked(query);
const mockTransaction = vi.mocked(transaction);

function rows<T>(list: T[]) {
  return { rows: list } as any;
}

async function buildTestApp(): Promise<FastifyInstance> {
  const app = Fastify();
  app.addHook("onRequest", async (request) => {
    (request as any).user = {
      id: "u-admin",
      email: "admin@mertm.bg",
      role: "admin",
    };
    (request as any).jwtVerify = async () => (request as any).user;
  });
  await app.register(incomingRoutes, { prefix: "/incoming" });
  return app;
}

describe("incoming route (MERT-M, batch-free)", () => {
  let app: FastifyInstance;

  beforeAll(async () => {
    app = await buildTestApp();
  });

  afterAll(async () => {
    await app.close();
  });

  it("POST /incoming creates doc; items do not carry batch_number or expiry_date", async () => {
    // Duplicate-invoice guard runs outside the transaction, using the
    // module-level `query`. No invoice_number in payload → skipped here.
    mockQuery.mockReset();

    // The route's supplier-resolve path runs (alias → exact → fuzzy) then
    // creates a new supplier + alias, then the incoming doc, then the
    // item. Walk the exact call sequence for this payload:
    //   supplier_name="Test Supplier", no eik / vat / supplier_id.
    const clientQuery = vi
      .fn()
      // 1. supplier_aliases alias-exact lookup (normalize_search join)
      .mockResolvedValueOnce(rows([]))
      // 2. suppliers exact-name (ILIKE)
      .mockResolvedValueOnce(rows([]))
      // 3. suppliers fuzzy (similarity / word_similarity)
      .mockResolvedValueOnce(rows([]))
      // 4. INSERT INTO suppliers ... RETURNING id
      .mockResolvedValueOnce(rows([{ id: 42 }]))
      // 5. INSERT INTO supplier_aliases (learn the mapping)
      .mockResolvedValueOnce(rows([]))
      // 6. INSERT INTO incoming_goods ... RETURNING *
      .mockResolvedValueOnce(
        rows([
          {
            id: 200,
            supplier_id: 42,
            status: "pending",
          },
        ]),
      )
      // 7. SELECT id FROM products WHERE id = $1 (explicit product_id check)
      .mockResolvedValueOnce(rows([{ id: 1 }]))
      // 8. INSERT INTO incoming_items ... RETURNING *
      //    (the NEW batch-free column list — no batch_id, no batch_number)
      .mockResolvedValueOnce(
        rows([
          {
            id: 2001,
            incoming_goods_id: 200,
            product_id: 1,
            quantity: "5",
            unit_price: "20",
            total_price: "100",
            selling_price: null,
          },
        ]),
      )
      // 9. UPDATE incoming_goods SET total_amount
      .mockResolvedValueOnce(rows([]));

    mockTransaction.mockImplementation(async (callback: any) =>
      callback({ query: clientQuery }),
    );

    const res = await app.inject({
      method: "POST",
      url: "/incoming",
      payload: {
        supplier_name: "Test Supplier",
        items: [{ product_id: 1, quantity: 5, unit_cost: 20, unit_price: 20 }],
      },
    });

    expect(res.statusCode).toBe(201);
    const body = JSON.parse(res.body);
    expect(body.items?.[0]).not.toHaveProperty("batch_number");
    expect(body.items?.[0]).not.toHaveProperty("expiry_date");
    expect(body.items?.[0]).not.toHaveProperty("production_date");

    // Guard the INSERT SQL — neither batch_id nor the former batch-only
    // columns are emitted for incoming_items any more.
    const insertItemsCall = clientQuery.mock.calls.find((call: any[]) =>
      String(call[0]).includes("INSERT INTO incoming_items"),
    );
    expect(insertItemsCall).toBeDefined();
    const insertSql = String(insertItemsCall![0]);
    expect(insertSql).not.toMatch(/\bbatch_id\b/);
    expect(insertSql).not.toMatch(/\bbatch_number\b/);
    expect(insertSql).not.toMatch(/\bexpiry_date\b/);
    expect(insertSql).not.toMatch(/\bproduction_date\b/);

    // And no INSERT INTO batches anywhere in this flow.
    const batchInsert = clientQuery.mock.calls.find((call: any[]) =>
      String(call[0]).includes("INSERT INTO batches"),
    );
    expect(batchInsert).toBeUndefined();
  });
});
