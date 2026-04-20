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

async function buildAppWithRole(role: string) {
  const app = Fastify();

  app.addHook("onRequest", async (request) => {
    (request as any).user = {
      id: "u-owner",
      email: "owner@test.local",
      role,
    };
    (request as any).jwtVerify = async () => (request as any).user;
  });

  await app.register(incomingRoutes, { prefix: "/incoming" });
  return app;
}

describe("incoming cancel endpoint", () => {
  beforeEach(() => {
    mockQuery.mockReset();
    mockTransaction.mockReset();
  });

  it("forbids warehouse role from cancelling incoming documents", async () => {
    const app = await buildAppWithRole("warehouse");
    try {
      const res = await app.inject({
        method: "PUT",
        url: "/incoming/55/cancel",
      });

      expect(res.statusCode).toBe(403);
      expect(mockTransaction).not.toHaveBeenCalled();
    } finally {
      await app.close();
    }
  });

  it("allows owner_mobile to cancel pending incoming document", async () => {
    const clientQuery = vi
      .fn()
      .mockResolvedValueOnce(
        resultRows([{ id: 55, status: "pending", invoice_number: "INV-55" }]),
      )
      .mockResolvedValueOnce(resultRows([{ id: 55, status: "cancelled" }]))
      .mockResolvedValueOnce(resultRows([]));

    mockTransaction.mockImplementation(async (callback: any) =>
      callback({ query: clientQuery }),
    );

    const app = await buildAppWithRole("owner_mobile");
    try {
      const res = await app.inject({
        method: "PUT",
        url: "/incoming/55/cancel",
        payload: { reason: "Грешно сканирана фактура" },
      });

      expect(res.statusCode).toBe(200);
      expect(res.json()).toEqual({
        message: "Доставката е отказана.",
        incoming: { id: 55, status: "cancelled" },
      });

      expect(mockTransaction).toHaveBeenCalledTimes(1);
      expect(clientQuery).toHaveBeenCalledTimes(3);
      expect(String(clientQuery.mock.calls[0][0])).toContain("FOR UPDATE");
      expect(String(clientQuery.mock.calls[1][0])).toContain("UPDATE incoming_goods");
      expect(String(clientQuery.mock.calls[2][0])).toContain("INSERT INTO notifications");
      expect(clientQuery.mock.calls[2][1]).toEqual([
        "Доставка #55 (фактура INV-55) е отказана. Причина: Грешно сканирана фактура",
      ]);
    } finally {
      await app.close();
    }
  });

  it("rejects cancelling non-pending incoming document", async () => {
    const clientQuery = vi
      .fn()
      .mockResolvedValueOnce(
        resultRows([{ id: 56, status: "confirmed", invoice_number: "INV-56" }]),
      );

    mockTransaction.mockImplementation(async (callback: any) =>
      callback({ query: clientQuery }),
    );

    const app = await buildAppWithRole("owner_mobile");
    try {
      const res = await app.inject({
        method: "PUT",
        url: "/incoming/56/cancel",
      });

      expect(res.statusCode).toBe(400);
      expect(res.json().message).toContain("Cannot cancel: status is confirmed");
      expect(clientQuery).toHaveBeenCalledTimes(1);
    } finally {
      await app.close();
    }
  });
});
