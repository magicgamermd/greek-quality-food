import { FastifyInstance, FastifyRequest, FastifyReply } from "fastify";
import bcrypt from "bcryptjs";
import { z } from "zod";
import { query } from "../db.js";
import { requirePermission, PERMISSIONS } from "../lib/permissions.js";

const createUserSchema = z.object({
  name: z.string().min(2),
  email: z.string().email(),
  password: z.string().min(6),
  role: z.enum(["admin", "warehouse", "accountant"]).default("accountant"),
});

const updateRoleSchema = z.object({
  role: z.enum(["admin", "warehouse", "accountant"]),
});

const jwtVerify = async (request: FastifyRequest) => {
  await request.jwtVerify();
};

const adminPreHandler = [
  jwtVerify,
  requirePermission(PERMISSIONS.USERS_MANAGE),
];

export default async function usersRoutes(app: FastifyInstance) {
  // GET /users — List all users (admin only)
  app.get(
    "/",
    { preHandler: adminPreHandler },
    async (request: FastifyRequest, reply: FastifyReply) => {
      const { page, limit } = request.query as any;
      const pageNum = Math.max(1, parseInt(page) || 1);
      const pageSize = Math.min(100, Math.max(1, parseInt(limit) || 50));
      const offset = (pageNum - 1) * pageSize;

      const { rows } = await query(
        `SELECT id, name, email, role, created_at
       FROM users
       ORDER BY created_at DESC
       LIMIT $1 OFFSET $2`,
        [pageSize, offset],
      );

      const { rows: countResult } = await query(
        "SELECT COUNT(*) as count FROM users",
      );
      const total = parseInt(countResult[0].count, 10);

      return {
        data: rows,
        pagination: {
          total,
          page: pageNum,
          limit: pageSize,
          pages: Math.ceil(total / pageSize),
        },
      };
    },
  );

  // POST /users — Create new user (admin only)
  app.post(
    "/",
    { preHandler: adminPreHandler },
    async (request: FastifyRequest, reply: FastifyReply) => {
      const body = createUserSchema.parse(request.body);

      // Check duplicate email
      const { rows: dup } = await query(
        "SELECT id FROM users WHERE email = $1",
        [body.email],
      );
      if (dup.length > 0) {
        return reply.status(409).send({ error: "Email already registered" });
      }

      const passwordHash = await bcrypt.hash(body.password, 12);

      const { rows } = await query(
        `INSERT INTO users (name, email, password_hash, role)
       VALUES ($1, $2, $3, $4)
       RETURNING id, name, email, role, created_at`,
        [body.name, body.email, passwordHash, body.role],
      );

      return reply.status(201).send(rows[0]);
    },
  );

  // PATCH /users/:id/role — Change user role (admin only)
  app.patch(
    "/:id/role",
    { preHandler: adminPreHandler },
    async (request: FastifyRequest, reply: FastifyReply) => {
      const { id } = request.params as { id: string };
      const body = updateRoleSchema.parse(request.body);

      // Cannot change own role
      if (id === request.user.id) {
        return reply.status(400).send({ error: "Cannot change your own role" });
      }

      // Check user exists
      const { rows: userRows } = await query(
        "SELECT id FROM users WHERE id = $1",
        [id],
      );
      if (userRows.length === 0) {
        return reply.status(404).send({ error: "User not found" });
      }

      // Update role
      const { rows } = await query(
        `UPDATE users SET role = $1, updated_at = NOW() WHERE id = $2
       RETURNING id, name, email, role, created_at`,
        [body.role, id],
      );

      return rows[0];
    },
  );

  // DELETE /users/:id — Delete user (admin only)
  app.delete(
    "/:id",
    { preHandler: adminPreHandler },
    async (request: FastifyRequest, reply: FastifyReply) => {
      const { id } = request.params as { id: string };

      // Cannot delete self
      if (id === request.user.id) {
        return reply
          .status(400)
          .send({ error: "Cannot delete your own account" });
      }

      // Check user exists
      const { rows: userRows } = await query(
        "SELECT id FROM users WHERE id = $1",
        [id],
      );
      if (userRows.length === 0) {
        return reply.status(404).send({ error: "User not found" });
      }

      // Delete user
      await query("DELETE FROM users WHERE id = $1", [id]);

      return { message: "User deleted successfully" };
    },
  );
}
