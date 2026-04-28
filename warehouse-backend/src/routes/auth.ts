import { FastifyInstance, FastifyRequest, FastifyReply } from "fastify";
import bcrypt from "bcryptjs";
import { z } from "zod";
import { query } from "../db.js";
import { hasPermission, PERMISSIONS } from "../lib/permissions.js";

// Pre-computed bcrypt hash used for timing-attack protection when an
// unknown email is supplied. Cost factor matches the one used for real
// password hashes (12) so the compare runtime is equivalent.
// Hash of the string "invalid" at cost 12 — never matches any real password.
const DUMMY_BCRYPT_HASH =
  "$2a$12$CwTycUXWue0Thq9StjUM0uJ8Q3kq1f7hJjCVx6TjY4u7v5XkFqfBe";

const loginSchema = z.object({
  email: z.string().email(),
  password: z.string().min(6),
});

const registerSchema = z.object({
  name: z.string().min(2),
  email: z.string().email(),
  password: z.string().min(6),
  role: z.enum(["admin", "warehouse", "accountant"]).default("accountant"),
});

export default async function authRoutes(app: FastifyInstance) {
  // POST /auth/login
  app.post("/login", async (request: FastifyRequest, reply: FastifyReply) => {
    const body = loginSchema.parse(request.body);

    const { rows } = await query(
      "SELECT id, name, email, password_hash, role FROM users WHERE email = $1",
      [body.email],
    );

    if (rows.length === 0) {
      // Perform a dummy bcrypt compare to equalize response time and
      // avoid leaking existence of accounts via timing.
      await bcrypt.compare(body.password, DUMMY_BCRYPT_HASH);
      return reply.status(401).send({ error: "Invalid email or password" });
    }

    const user = rows[0];
    const valid = await bcrypt.compare(body.password, user.password_hash);

    if (!valid) {
      return reply.status(401).send({ error: "Invalid email or password" });
    }

    const token = app.jwt.sign({
      id: user.id,
      email: user.email,
      role: user.role,
    });

    return {
      token,
      user: {
        id: user.id,
        name: user.name,
        email: user.email,
        role: user.role,
      },
    };
  });

  // POST /auth/register (admin only — or first user)
  app.post(
    "/register",
    async (request: FastifyRequest, reply: FastifyReply) => {
      const body = registerSchema.parse(request.body);

      // Check if any users exist (first user becomes admin)
      const { rows: existing } = await query(
        "SELECT COUNT(*) as count FROM users",
      );
      const isFirstUser = parseInt(existing[0].count, 10) === 0;

      // If not first user, require auth + users.manage permission.
      // (Bootstrap: the very first user becomes admin without auth.)
      if (!isFirstUser) {
        try {
          await request.jwtVerify();
          const allowed = await hasPermission(
            request.user as { id: string; role: string },
            PERMISSIONS.USERS_MANAGE,
          );
          if (!allowed) {
            return reply.status(403).send({
              error: "Forbidden",
              required_permission: PERMISSIONS.USERS_MANAGE,
            });
          }
        } catch {
          return reply.status(401).send({ error: "Unauthorized" });
        }
      }

      // Check duplicate email
      const { rows: dup } = await query(
        "SELECT id FROM users WHERE email = $1",
        [body.email],
      );
      if (dup.length > 0) {
        return reply.status(409).send({ error: "Email already registered" });
      }

      const passwordHash = await bcrypt.hash(body.password, 12);
      const role = isFirstUser ? "admin" : body.role;

      const { rows } = await query(
        `INSERT INTO users (name, email, password_hash, role)
       VALUES ($1, $2, $3, $4)
       RETURNING id, name, email, role, created_at`,
        [body.name, body.email, passwordHash, role],
      );

      return reply.status(201).send(rows[0]);
    },
  );

  // POST /auth/logout
  app.post("/logout", async (_request: FastifyRequest, reply: FastifyReply) => {
    // JWT is stateless — client discards token.
    // Could add token blacklist via Redis if needed.
    return { message: "Logged out" };
  });

  // GET /auth/me
  app.get("/me", async (request: FastifyRequest, reply: FastifyReply) => {
    try {
      await request.jwtVerify();
    } catch {
      return reply.status(401).send({ error: "Unauthorized" });
    }

    const { rows } = await query(
      "SELECT id, name, email, role, created_at FROM users WHERE id = $1",
      [request.user.id],
    );

    if (rows.length === 0) {
      return reply.status(404).send({ error: "User not found" });
    }

    return rows[0];
  });
}
