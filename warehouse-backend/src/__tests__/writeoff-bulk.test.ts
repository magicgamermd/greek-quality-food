// warehouse-backend/src/__tests__/writeoff-bulk.test.ts
//
// GQF: многоредов брак протокол. POST /inventory/write-offs/bulk създава
// N реда, които споделят ЕДИН protocol_number, декрементира партиди +
// inventory, и при провал на който и да е ред цялата транзакция се отменя.
// Следва pattern-а от negative-inventory.test.ts: vi.mock("../db.js"), auth
// инжектиран през onRequest hook, assertions върху SQL към mock client-а.
import Fastify, { FastifyInstance } from "fastify";
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../db.js", () => ({
  query: vi.fn(async () => ({ rows: [] })),
  transaction: vi.fn(),
}));

import { transaction } from "../db.js";
import writeoffRoutes from "../routes/writeoffs.js";

const mockTransaction = vi.mocked(transaction);

function rows<T>(list: T[]) {
  return { rows: list, rowCount: list.length } as any;
}

async function buildApp(): Promise<FastifyInstance> {
  const app = Fastify();
  app.addHook("onRequest", async (request) => {
    (request as any).user = {
      id: "u-admin",
      email: "admin@gqf.bg",
      role: "admin",
    };
    (request as any).jwtVerify = async () => (request as any).user;
  });
  await app.register(writeoffRoutes, { prefix: "/inventory/write-offs" });
  return app;
}

describe("POST /inventory/write-offs/bulk — многоредов брак протокол", () => {
  beforeEach(() => {
    mockTransaction.mockReset();
  });

  it("създава N реда с един споделен protocol_number и декрементира партиди/inventory", async () => {
    // Two lines, both batch-backed. Sequence resolves the protocol number,
    // then per line: product SELECT, batch FOR UPDATE, INSERT writeoff,
    // UPDATE batches, UPDATE inventory, INSERT audit_events.
    const clientQuery = vi
      .fn()
      // nextval -> seq 7 => БРАК-<year>-0007
      .mockResolvedValueOnce(rows([{ seq: 7 }]))
      // line 1: product
      .mockResolvedValueOnce(rows([{ id: 10, purchase_price: "5.00" }]))
      // line 1: batch FOR UPDATE
      .mockResolvedValueOnce(
        rows([
          { id: 100, product_id: 10, quantity: "20", purchase_price: "5.00" },
        ]),
      )
      // line 1: INSERT writeoff RETURNING *
      .mockResolvedValueOnce(
        rows([{ id: 1, total_cost: "10.00", protocol_number: null }]),
      )
      // line 1: UPDATE batches
      .mockResolvedValueOnce(rows([]))
      // line 1: UPDATE inventory
      .mockResolvedValueOnce(rows([]))
      // line 1: INSERT audit_events
      .mockResolvedValueOnce(rows([]))
      // line 2: product
      .mockResolvedValueOnce(rows([{ id: 11, purchase_price: "3.00" }]))
      // line 2: batch FOR UPDATE
      .mockResolvedValueOnce(
        rows([
          { id: 200, product_id: 11, quantity: "8", purchase_price: "3.00" },
        ]),
      )
      // line 2: INSERT writeoff RETURNING *
      .mockResolvedValueOnce(
        rows([{ id: 2, total_cost: "9.00", protocol_number: null }]),
      )
      // line 2: UPDATE batches
      .mockResolvedValueOnce(rows([]))
      // line 2: UPDATE inventory
      .mockResolvedValueOnce(rows([]))
      // line 2: INSERT audit_events
      .mockResolvedValueOnce(rows([]));

    mockTransaction.mockImplementation(async (callback: any) =>
      callback({ query: clientQuery }),
    );

    const app = await buildApp();
    try {
      const res = await app.inject({
        method: "POST",
        url: "/inventory/write-offs/bulk",
        payload: {
          notes: "Месечен брак",
          lines: [
            { product_id: 10, batch_id: 100, quantity: 2, reason: "expired" },
            { product_id: 11, batch_id: 200, quantity: 3, reason: "damaged" },
          ],
        },
      });

      expect(res.statusCode).toBe(201);
      const body = res.json();
      const year = new Date().getUTCFullYear();
      const protocol = `БРАК-${year}-0007`;
      expect(body.protocol_number).toBe(protocol);
      expect(body.count).toBe(2);
      expect(body.total_cost).toBe(19);
      expect(body.lines).toHaveLength(2);

      // nextval pulled exactly ONCE — one protocol number for the whole act.
      const nextvalCalls = clientQuery.mock.calls.filter((c: any[]) =>
        String(c[0]).includes("nextval('stock_writeoff_doc_seq')"),
      );
      expect(nextvalCalls).toHaveLength(1);

      // Both INSERTs carry the SAME protocol_number, distinct document_number.
      const insertCalls = clientQuery.mock.calls.filter((c: any[]) =>
        String(c[0]).includes("INSERT INTO stock_writeoffs"),
      );
      expect(insertCalls).toHaveLength(2);
      // params order: document_number, protocol_number, ...
      expect(insertCalls[0][1][0]).toBe(`${protocol}-1`);
      expect(insertCalls[0][1][1]).toBe(protocol);
      expect(insertCalls[1][1][0]).toBe(`${protocol}-2`);
      expect(insertCalls[1][1][1]).toBe(protocol);

      // Both batches decremented by their line quantity.
      const batchUpdates = clientQuery.mock.calls.filter((c: any[]) =>
        String(c[0]).includes("UPDATE batches SET quantity = quantity -"),
      );
      expect(batchUpdates).toHaveLength(2);
      expect(batchUpdates[0][1]).toEqual([2, 100]);
      expect(batchUpdates[1][1]).toEqual([3, 200]);

      // Inventory decremented for both lines.
      const invUpdates = clientQuery.mock.calls.filter((c: any[]) =>
        String(c[0]).includes("UPDATE inventory"),
      );
      expect(invUpdates).toHaveLength(2);
    } finally {
      await app.close();
    }
  });

  it("отменя цялата транзакция (rollback) при провал на ред — недостатъчно количество", async () => {
    // The real transaction() rolls back when its callback throws. We emulate
    // that contract: if the callback throws, transaction() rejects and NO
    // commit happens. Line 2 has insufficient batch quantity → throws.
    const clientQuery = vi
      .fn()
      // nextval
      .mockResolvedValueOnce(rows([{ seq: 8 }]))
      // line 1: product
      .mockResolvedValueOnce(rows([{ id: 10, purchase_price: "5.00" }]))
      // line 1: batch FOR UPDATE
      .mockResolvedValueOnce(
        rows([
          { id: 100, product_id: 10, quantity: "20", purchase_price: "5.00" },
        ]),
      )
      // line 1: INSERT writeoff
      .mockResolvedValueOnce(rows([{ id: 1, total_cost: "10.00" }]))
      // line 1: UPDATE batches
      .mockResolvedValueOnce(rows([]))
      // line 1: UPDATE inventory
      .mockResolvedValueOnce(rows([]))
      // line 1: INSERT audit_events
      .mockResolvedValueOnce(rows([]))
      // line 2: product
      .mockResolvedValueOnce(rows([{ id: 11, purchase_price: "3.00" }]))
      // line 2: batch FOR UPDATE — only 1 available, line wants 3
      .mockResolvedValueOnce(
        rows([
          { id: 200, product_id: 11, quantity: "1", purchase_price: "3.00" },
        ]),
      );

    // Emulate transaction() rollback semantics: rethrow whatever the callback
    // throws (so the route's catch maps it to the HTTP error).
    mockTransaction.mockImplementation(async (callback: any) => {
      return callback({ query: clientQuery });
    });

    const app = await buildApp();
    try {
      const res = await app.inject({
        method: "POST",
        url: "/inventory/write-offs/bulk",
        payload: {
          lines: [
            { product_id: 10, batch_id: 100, quantity: 2, reason: "expired" },
            { product_id: 11, batch_id: 200, quantity: 3, reason: "damaged" },
          ],
        },
      });

      expect(res.statusCode).toBe(400);
      const body = res.json();
      // Error indicates which line index failed (0-based) + Bulgarian message.
      expect(body.line_index).toBe(1);
      expect(body.error).toContain("Ред 2");
      expect(body.error).toContain("Недостатъчно");

      // Line 2 never reached its INSERT — only line 1 was inserted before the
      // throw, and the (mocked) transaction would roll that back in real life.
      const insertCalls = clientQuery.mock.calls.filter((c: any[]) =>
        String(c[0]).includes("INSERT INTO stock_writeoffs"),
      );
      expect(insertCalls).toHaveLength(1);
    } finally {
      await app.close();
    }
  });
});
