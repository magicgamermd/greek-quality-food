import { FastifyInstance, FastifyRequest, FastifyReply } from "fastify";
import { query } from "../db.js";

async function requireAuth(request: FastifyRequest, reply: FastifyReply) {
  await request.jwtVerify();
}

export default async function categoriesRoutes(app: FastifyInstance) {
  // GET /categories
  app.get("/", async (request: FastifyRequest, reply: FastifyReply) => {
    await requireAuth(request, reply);
    const { rows } = await query(
      "SELECT * FROM categories ORDER BY name_bg ASC",
      [],
    );
    return reply.send({ data: rows });
  });

  // POST /categories
  app.post("/", async (request: FastifyRequest, reply: FastifyReply) => {
    await requireAuth(request, reply);
    const { name_bg, name_en } = request.body as any;
    if (!name_bg) {
      return reply.status(400).send({ error: "name_bg е задължително" });
    }
    const { rows } = await query(
      "INSERT INTO categories (name_bg, name_en) VALUES ($1, $2) RETURNING *",
      [name_bg, name_en || null],
    );
    return reply.status(201).send(rows[0]);
  });

  // DELETE /categories/:id
  app.delete("/:id", async (request: FastifyRequest, reply: FastifyReply) => {
    await requireAuth(request, reply);
    const { id } = request.params as any;
    await query("DELETE FROM categories WHERE id = $1", [id]);
    return reply.send({ success: true });
  });
}
