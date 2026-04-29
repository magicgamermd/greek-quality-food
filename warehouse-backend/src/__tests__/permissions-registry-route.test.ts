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
      expect(body.length).toBe(16);
      const orders = body.find((p: any) => p.permission === "orders.manage");
      expect(orders).toMatchObject({
        permission: "orders.manage",
        group: "Продажби",
        label: "Поръчки — управление",
      });
    } finally {
      await app.close();
    }
  });
});
