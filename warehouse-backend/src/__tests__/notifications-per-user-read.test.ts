// Batch I — Task 4
// Per-user read state isolation for the unified GET /notifications feed.
// The DB schema has notification_reads keyed on (user_id, notification_id);
// the GET handler must consult only the calling user's row. Mark-read /
// dismiss endpoints must persist only against the calling user.

import Fastify from "fastify";
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../db.js", () => ({ query: vi.fn() }));

import { query } from "../db.js";
import notificationRoutes from "../routes/notifications.js";

const mockQuery = vi.mocked(query);

async function buildApp(userId: string) {
  const app = Fastify();
  app.addHook("onRequest", async (req) => {
    (req as any).user = { id: userId, sub: userId };
    (req as any).jwtVerify = async () => (req as any).user;
  });
  await app.register(notificationRoutes, { prefix: "/notifications" });
  return app;
}

describe("GET /notifications — per-user read state", () => {
  beforeEach(() => mockQuery.mockReset());

  it("user A's read state does not affect user B's view", async () => {
    // Order of queries inside the GET handler:
    //   1) low_stock        → empty
    //   2) expiring         → empty
    //   3) persistent       → 1 row (id=5)
    //   4) notification_reads (per-user)
    mockQuery
      .mockResolvedValueOnce({ rows: [] } as any)
      .mockResolvedValueOnce({ rows: [] } as any)
      .mockResolvedValueOnce({
        rows: [
          {
            id: 5,
            type: "pending_order_ready",
            message: "X",
            payload: {},
            created_at: new Date(),
          },
        ],
      } as any)
      .mockResolvedValueOnce({
        rows: [
          { notification_id: "db-5", dismissed: false, read_at: new Date() },
        ],
      } as any);

    const appA = await buildApp("user-A");
    const resA = await appA.inject({ method: "GET", url: "/notifications" });
    expect(resA.statusCode).toBe(200);
    expect(JSON.parse(resA.body).data[0].is_read).toBe(true);
    await appA.close();

    // Same setup but user B has no read row.
    mockQuery
      .mockResolvedValueOnce({ rows: [] } as any)
      .mockResolvedValueOnce({ rows: [] } as any)
      .mockResolvedValueOnce({
        rows: [
          {
            id: 5,
            type: "pending_order_ready",
            message: "X",
            payload: {},
            created_at: new Date(),
          },
        ],
      } as any)
      .mockResolvedValueOnce({ rows: [] } as any);

    const appB = await buildApp("user-B");
    const resB = await appB.inject({ method: "GET", url: "/notifications" });
    expect(resB.statusCode).toBe(200);
    expect(JSON.parse(resB.body).data[0].is_read).toBe(false);
    await appB.close();
  });

  it("PUT /:id/read inserts a row for the calling user only", async () => {
    mockQuery.mockResolvedValueOnce({ rows: [] } as any);
    const app = await buildApp("user-A");
    await app.inject({ method: "PUT", url: "/notifications/db-5/read" });
    expect(mockQuery).toHaveBeenCalledWith(
      expect.stringContaining("INSERT INTO notification_reads"),
      expect.arrayContaining(["user-A", "db-5"]),
    );
    await app.close();
  });

  it("DELETE /:id sets dismissed=true for the user (no other user affected)", async () => {
    mockQuery.mockResolvedValueOnce({ rows: [] } as any);
    const app = await buildApp("user-A");
    await app.inject({ method: "DELETE", url: "/notifications/db-5" });
    expect(mockQuery.mock.calls[0][0]).toContain("dismissed");
    expect(mockQuery.mock.calls[0][1]).toEqual(
      expect.arrayContaining(["user-A", "db-5"]),
    );
    await app.close();
  });
});
