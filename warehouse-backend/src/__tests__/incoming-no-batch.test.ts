// GQF — входящата доставка заснема партида + срок на годност на реда.
//
// (Бивш MERT-M batch-free тест — обърнат за Greek Quality Food: create
// пътят вече персистира batch_number/expiry_date на incoming_items;
// реалните партиди/наличност се създават при confirm, не тук.)
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

describe("incoming route (GQF, batch/expiry on the line)", () => {
  let app: FastifyInstance;

  beforeAll(async () => {
    app = await buildTestApp();
  });

  afterAll(async () => {
    await app.close();
  });

  it("POST /incoming creates doc; persists batch_number/expiry_date on the line", async () => {
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
      //    (GQF: column list now carries batch_number + expiry_date; the
      //    real batch + per-batch inventory are created at confirm, not here)
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
            batch_number: "L-2026-07",
            expiry_date: "2026-12-31",
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
        items: [
          {
            product_id: 1,
            quantity: 5,
            unit_cost: 20,
            unit_price: 20,
            batch_number: "L-2026-07",
            expiry_date: "2026-12-31",
          },
        ],
      },
    });

    expect(res.statusCode).toBe(201);

    // Guard the INSERT SQL — incoming_items now carries batch_number +
    // expiry_date, but still NOT batch_id (resolved at confirm).
    const insertItemsCall = clientQuery.mock.calls.find((call: any[]) =>
      String(call[0]).includes("INSERT INTO incoming_items"),
    );
    expect(insertItemsCall).toBeDefined();
    const insertSql = String(insertItemsCall![0]);
    expect(insertSql).toMatch(/\bbatch_number\b/);
    expect(insertSql).toMatch(/\bexpiry_date\b/);
    expect(insertSql).not.toMatch(/\bbatch_id\b/);

    // The line's batch/expiry values are passed as parameters.
    const insertParams = insertItemsCall![1];
    expect(insertParams).toContain("L-2026-07");
    expect(insertParams).toContain("2026-12-31");

    // No INSERT INTO batches in the create flow — that happens at confirm.
    const batchInsert = clientQuery.mock.calls.find((call: any[]) =>
      String(call[0]).includes("INSERT INTO batches"),
    );
    expect(batchInsert).toBeUndefined();
  });
});
