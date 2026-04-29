import type { FastifyInstance, FastifyRequest, FastifyReply } from "fastify";
import { PERMISSION_REGISTRY } from "../lib/permissions.js";

export default async function permissionsRoutes(app: FastifyInstance) {
  app.get("/registry", async (request: FastifyRequest, reply: FastifyReply) => {
    try {
      await request.jwtVerify();
    } catch {
      return reply.status(401).send({ error: "Unauthorized" });
    }
    return PERMISSION_REGISTRY;
  });
}
