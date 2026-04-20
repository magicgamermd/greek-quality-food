import Fastify from "fastify";
import { beforeEach, describe, expect, it, vi } from "vitest";
import incomingRoutes from "../routes/incoming.js";

vi.mock("../db.js", () => ({
  query: vi.fn(),
  transaction: vi.fn(),
}));

import { query } from "../db.js";

const mockQuery = vi.mocked(query);

function resultRows<T>(rows: T[]) {
  return { rows } as any;
}

async function buildAppWithRole(role: "admin" | "warehouse") {
  const app = Fastify();

  app.addHook("onRequest", async (request) => {
    (request as any).user = {
      id: "u-test",
      email: "test@greekfoods.bg",
      role,
    };
    (request as any).jwtVerify = async () => (request as any).user;
  });

  await app.register(incomingRoutes, { prefix: "/incoming" });
  return app;
}

describe("incoming batch patch companion pairing", () => {
  beforeEach(() => {
    mockQuery.mockReset();
  });

  it("targets exact incoming line by incoming_item_id for duplicate products", async () => {
    mockQuery
      .mockResolvedValueOnce(
        resultRows([{ id: 41, batch_id: null, product_id: 7 }]),
      )
      .mockResolvedValueOnce(resultRows([{ id: 701 }]))
      .mockResolvedValueOnce(resultRows([]))
      .mockResolvedValueOnce(resultRows([]))
      .mockResolvedValueOnce(
        resultRows([{ id: 42, batch_id: null, product_id: 7 }]),
      )
      .mockResolvedValueOnce(resultRows([{ id: 702 }]))
      .mockResolvedValueOnce(resultRows([]))
      .mockResolvedValueOnce(resultRows([]));

    const app = await buildAppWithRole("warehouse");
    try {
      const res = await app.inject({
        method: "PATCH",
        url: "/incoming/99/batches",
        payload: {
          items: [
            {
              incoming_item_id: 41,
              product_id: 7,
              batch_number: "LOT-41",
              expiry_date: "2026-12-01",
            },
            {
              incoming_item_id: 42,
              product_id: 7,
              batch_number: "LOT-42",
              expiry_date: "2026-12-15",
            },
          ],
        },
      });

      expect(res.statusCode).toBe(200);
      expect(res.json()).toEqual({ ok: true });
      expect(mockQuery).toHaveBeenCalledTimes(8);

      const firstSelect = mockQuery.mock.calls[0];
      expect(String(firstSelect[0])).toContain("ii.id = $2");
      expect(firstSelect[1]).toEqual(["99", 41]);

      const secondSelect = mockQuery.mock.calls[4];
      expect(String(secondSelect[0])).toContain("ii.id = $2");
      expect(secondSelect[1]).toEqual(["99", 42]);
    } finally {
      await app.close();
    }
  });

  it("falls back to product_id selector for older clients", async () => {
    mockQuery
      .mockResolvedValueOnce(resultRows([{ id: 55, batch_id: 900, product_id: 8 }]))
      .mockResolvedValueOnce(resultRows([]));

    const app = await buildAppWithRole("warehouse");
    try {
      const res = await app.inject({
        method: "PATCH",
        url: "/incoming/100/batches",
        payload: {
          items: [
            {
              product_id: 8,
              batch_number: "LEGACY-8",
              expiry_date: "2026-11-01",
            },
          ],
        },
      });

      expect(res.statusCode).toBe(200);
      expect(res.json()).toEqual({ ok: true });
      expect(mockQuery).toHaveBeenCalledTimes(2);

      const selectCall = mockQuery.mock.calls[0];
      expect(String(selectCall[0])).toContain("ii.product_id = $2");
      expect(selectCall[1]).toEqual(["100", 8]);

      const updateCall = mockQuery.mock.calls[1];
      expect(String(updateCall[0])).toContain("UPDATE batches");
    } finally {
      await app.close();
    }
  });

  it("uses production_date-derived batch when creating a new batch and links confirmed inventory", async () => {
    mockQuery
      .mockResolvedValueOnce(
        resultRows([
          {
            id: 60,
            batch_id: null,
            product_id: 11,
            invoice_date: "2026-04-08",
          },
        ]),
      )
      .mockResolvedValueOnce(resultRows([{ id: 811 }]))
      .mockResolvedValueOnce(resultRows([]))
      .mockResolvedValueOnce(resultRows([]));

    const app = await buildAppWithRole("warehouse");
    try {
      const res = await app.inject({
        method: "PATCH",
        url: "/incoming/101/batches",
        payload: {
          items: [
            {
              incoming_item_id: 60,
              production_date: "2026-04-10",
            },
          ],
        },
      });

      expect(res.statusCode).toBe(200);
      expect(res.json()).toEqual({ ok: true });
      expect(mockQuery).toHaveBeenCalledTimes(4);

      const insertCall = mockQuery.mock.calls[1];
      expect(String(insertCall[0])).toContain("INSERT INTO batches");
      expect(insertCall[1]).toEqual([11, "10042026", null, 101, "2026-04-08"]);

      const incomingItemUpdate = mockQuery.mock.calls[2];
      expect(String(incomingItemUpdate[0])).toContain("UPDATE incoming_items SET batch_id = $1");
      expect(incomingItemUpdate[1]).toEqual([811, 60]);

      const inventoryLink = mockQuery.mock.calls[3];
      expect(String(inventoryLink[0])).toContain("UPDATE inventory SET batch_id = $1");
      expect(inventoryLink[1]).toEqual([811, 11]);
    } finally {
      await app.close();
    }
  });
});
