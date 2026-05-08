import Fastify from "fastify";
import { describe, expect, it } from "vitest";
import permissionsRoutes from "../routes/permissions.js";

async function buildApp() {
  const app = Fastify();
  app.addHook("onRequest", async (req) => {
    (req as any).user = { id: "u1", email: "x@y", role: "sales" };
    (req as any).jwtVerify = async () => (req as any).user;
  });
  await app.register(permissionsRoutes, { prefix: "/permissions" });
  return app;
}

async function buildAppNoAuth() {
  const app = Fastify();
  // No jwtVerify stub — request.jwtVerify() will throw, hitting the 401 branch
  await app.register(permissionsRoutes, { prefix: "/permissions" });
  return app;
}

describe("GET /permissions/registry", () => {
  it("returns the permission catalog with groups + bg labels", async () => {
    const app = await buildApp();
    try {
      const res = await app.inject({
        method: "GET",
        url: "/permissions/registry",
      });
      expect(res.statusCode).toBe(200);
      const body = res.json();
      expect(Array.isArray(body)).toBe(true);
      expect(body.length).toBe(19);
      const orders = body.find((p: any) => p.permission === "orders.manage");
      expect(orders).toMatchObject({
        permission: "orders.manage",
        group: "Продажби",
        label: "Поръчки — управление",
      });
      const belowCost = body.find(
        (p: any) => p.permission === "orders.below_cost_override",
      );
      expect(belowCost).toMatchObject({
        permission: "orders.below_cost_override",
        group: "Продажби",
      });
      const editAfterFulfill = body.find(
        (p: any) => p.permission === "orders.edit_after_fulfill",
      );
      expect(editAfterFulfill).toMatchObject({
        permission: "orders.edit_after_fulfill",
        group: "Продажби",
      });
    } finally {
      await app.close();
    }
  });

  it("returns 401 when request has no valid JWT", async () => {
    const app = await buildAppNoAuth();
    try {
      const res = await app.inject({
        method: "GET",
        url: "/permissions/registry",
      });
      expect(res.statusCode).toBe(401);
      expect(res.json().error).toBe("Unauthorized");
    } finally {
      await app.close();
    }
  });
});
