import { FastifyInstance, FastifyRequest, FastifyReply } from "fastify";
import bcrypt from "bcryptjs";
import { z } from "zod";
import { query } from "../db.js";
import {
  requirePermission,
  PERMISSIONS,
  ROLE_DEFAULTS,
  getUserPermissions,
  invalidateUserPermissions,
  PERMISSION_REGISTRY,
} from "../lib/permissions.js";
import type { UserRole, Permission } from "../lib/permissions.js";

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

  // GET /users/:id/permissions — Get role defaults, overrides, and effective permissions (admin only)
  app.get(
    "/:id/permissions",
    {
      preHandler: [
        async (req: FastifyRequest) => {
          await req.jwtVerify();
        },
        requirePermission(PERMISSIONS.USERS_MANAGE),
      ],
    },
    async (request: FastifyRequest, reply: FastifyReply) => {
      const { id } = request.params as { id: string };

      const userResult = await query(
        "SELECT id, email, role, name FROM users WHERE id = $1",
        [id],
      );
      if (userResult.rows.length === 0) {
        return reply.status(404).send({ error: "User not found" });
      }
      const user = userResult.rows[0];

      const overridesResult = await query(
        `SELECT upo.permission, upo.granted, upo.reason, upo.created_at,
                c.id AS created_by_id, c.email AS created_by_email, c.name AS created_by_name
         FROM user_permission_overrides upo
         LEFT JOIN users c ON c.id = upo.created_by
         WHERE upo.user_id = $1
         ORDER BY upo.created_at DESC`,
        [id],
      );

      const overrides = overridesResult.rows.map((r) => ({
        permission: r.permission,
        granted: r.granted,
        reason: r.reason,
        created_at: r.created_at,
        created_by: r.created_by_id
          ? {
              id: r.created_by_id,
              email: r.created_by_email,
              name: r.created_by_name,
            }
          : null,
      }));

      const role = user.role as UserRole;
      const role_defaults = ROLE_DEFAULTS[role] ?? [];

      const effective = [...(await getUserPermissions(id))];

      return {
        user_id: id,
        role,
        role_defaults,
        overrides,
        effective,
      };
    },
  );

  // PATCH /users/:id/permissions/:permission — Set a per-user permission override (admin only)
  const VALID_PERMISSION_VALUES = PERMISSION_REGISTRY.map((p) => p.permission);

  const SetOverrideSchema = z.object({
    granted: z.boolean(),
    reason: z.string().max(255).optional(),
  });

  app.patch(
    "/:id/permissions/:permission",
    {
      preHandler: [
        async (req: FastifyRequest) => {
          await req.jwtVerify();
        },
        requirePermission(PERMISSIONS.USERS_MANAGE),
      ],
    },
    async (request: FastifyRequest, reply: FastifyReply) => {
      const { id, permission } = request.params as {
        id: string;
        permission: string;
      };

      if (!VALID_PERMISSION_VALUES.includes(permission as Permission)) {
        return reply.status(400).send({
          error: "unknown_permission",
          valid_permissions: VALID_PERMISSION_VALUES,
        });
      }

      const parsed = SetOverrideSchema.safeParse(request.body);
      if (!parsed.success) {
        return reply
          .status(400)
          .send({ error: "invalid_body", details: parsed.error.errors });
      }
      const { granted, reason } = parsed.data;

      const targetResult = await query(
        "SELECT id, role FROM users WHERE id = $1",
        [id],
      );
      if (targetResult.rows.length === 0) {
        return reply.status(404).send({ error: "User not found" });
      }
      const target = targetResult.rows[0];

      if (target.role === "admin") {
        return reply.status(400).send({ error: "admin_lockout_protection" });
      }
      if ((request.user as any).id === id) {
        return reply.status(400).send({ error: "self_modification_forbidden" });
      }

      await query(
        `INSERT INTO user_permission_overrides (user_id, permission, granted, reason, created_by)
         VALUES ($1, $2, $3, $4, $5)
         ON CONFLICT (user_id, permission)
         DO UPDATE SET granted = EXCLUDED.granted,
                       reason = EXCLUDED.reason,
                       created_by = EXCLUDED.created_by,
                       created_at = now()
         RETURNING id, granted, reason`,
        [id, permission, granted, reason ?? null, (request.user as any).id],
      );

      // CORRECTED: real audit_events schema has columns
      //   (actor_user_id, actor_email, action, entity_type, entity_id, diff)
      // entity_id is BIGINT and cannot hold a UUID, so we store the target user_id inside diff.
      const auditResult = await query(
        `INSERT INTO audit_events
           (actor_user_id, actor_email, action, entity_type, entity_id, diff)
         VALUES ($1, $2, $3, 'user', NULL, $4::jsonb)
         RETURNING id`,
        [
          (request.user as any).id,
          (request.user as any).email ?? null,
          "permission_override",
          JSON.stringify({
            user_id: id,
            permission,
            action: granted ? "grant" : "revoke",
            new: granted,
            reason: reason ?? null,
          }),
        ],
      );

      await invalidateUserPermissions(id);

      return {
        user_id: id,
        permission,
        granted,
        reason: reason ?? null,
        audit_event_id: auditResult.rows[0].id,
      };
    },
  );
}
