import Fastify from "fastify";
import cors from "@fastify/cors";
import jwt from "@fastify/jwt";
import multipart from "@fastify/multipart";
import cookie from "@fastify/cookie";
import rateLimit from "@fastify/rate-limit";
import dotenv from "dotenv";

import dbPool from "./db.js";
import authRoutes from "./routes/auth.js";
import productRoutes from "./routes/products.js";
import inventoryRoutes from "./routes/inventory.js";
import incomingRoutes from "./routes/incoming.js";
import orderRoutes from "./routes/orders.js";
import partnerRoutes from "./routes/partners.js";
import invoiceRoutes from "./routes/invoices.js";
import paymentRoutes from "./routes/payments.js";
import analyticsRoutes from "./routes/analytics.js";
import categoriesRoutes from "./routes/categories.js";
import suppliersRoutes from "./routes/suppliers.js";
import usersRoutes from "./routes/users.js";
import settingsRoutes from "./routes/settings.js";
import notificationRoutes from "./routes/notifications.js";
import importRoutes from "./routes/import.js";
import exportRoutes from "./routes/export.js";
import productAliasRoutes from "./routes/product-aliases.js";
import fiscalRoutes from "./routes/fiscal.js";
import econtRoutes from "./routes/econt.js";
import chatRoutes from "./routes/chat.js";
import agentRoutes from "./routes/agent.js";

dotenv.config();

// Extend Fastify types for JWT user
declare module "@fastify/jwt" {
  interface FastifyJWT {
    payload: { id: string; email: string; role: string };
    user: { id: string; email: string; role: string };
  }
}

// Build the Fastify app (plugins + routes) without binding to a port.
// Exported so Vitest tests can boot the full route table and assert
// endpoint presence / absence without opening a socket. Each call
// returns a fresh Fastify instance so multiple tests can build in
// isolation within a single process.
export async function build() {
  const app = Fastify({
    logger: {
      level: process.env.NODE_ENV === "production" ? "info" : "debug",
    },
  });

  // Plugins
  const corsOrigin = process.env.CORS_ORIGIN;
  const explicitCorsOrigins = corsOrigin
    ? corsOrigin
        .split(",")
        .map((s) => s.trim())
        .filter(Boolean)
    : [];
  // MERT-M deploys self-hosted on Mac Mini M4 — no Cloudflare Pages preview
  // patterns are needed. If a CDN preview deploy is added later, add a
  // MERT-M-specific regex here. Removed greek-foods-platform.pages.dev
  // pattern that would otherwise allow Greek Foods preview origins.
  const corsPreviewPatterns: RegExp[] = [];
  const devCorsOrigins = [
    "http://localhost:3010",
    "http://127.0.0.1:3010",
    "http://localhost:5173",
    "http://127.0.0.1:5173",
  ];
  const devCorsPatterns = [
    /^http:\/\/(?:10\.\d{1,3}\.\d{1,3}\.\d{1,3}|192\.168\.\d{1,3}\.\d{1,3}|172\.(?:1[6-9]|2\d|3[01])\.\d{1,3}\.\d{1,3}):5173$/,
  ];

  await app.register(cors, {
    origin: (origin, cb) => {
      if (!origin) {
        cb(null, true);
        return;
      }

      if (
        explicitCorsOrigins.includes(origin) ||
        devCorsOrigins.includes(origin) ||
        devCorsPatterns.some((pattern) => pattern.test(origin)) ||
        corsPreviewPatterns.some((pattern) => pattern.test(origin))
      ) {
        cb(null, true);
        return;
      }

      cb(new Error(`Origin ${origin} not allowed by CORS`), false);
    },
    credentials: true,
  });

  // JWT_SECRET is REQUIRED in every environment (prod, staging, preview, dev,
  // test). The previous fallback to "dev-secret-change-me" only triggered
  // outside NODE_ENV=production, which silently leaked the weak dev secret
  // into staging / preview deploys where NODE_ENV may be set to anything.
  // Dev and test environments must provide JWT_SECRET via .env (or the
  // vitest setup file at src/__tests__/setup.ts).
  if (!process.env.JWT_SECRET) {
    throw new Error(
      "JWT_SECRET is required. Set it in the environment (.env for dev/test, secret store for staging/prod).",
    );
  }

  await app.register(jwt, {
    secret: process.env.JWT_SECRET,
    sign: { expiresIn: process.env.JWT_EXPIRES_IN || "8h" },
  });

  // Rate limit — applied per-route via routeOptions.config.rateLimit
  await app.register(rateLimit, {
    global: false,
    max: 10,
    timeWindow: "15 minutes",
  });

  await app.register(multipart, {
    limits: { fileSize: 50 * 1024 * 1024 }, // 50MB
  });

  await app.register(cookie);

  // Auth decorator
  app.decorate("authenticate", async function (request: any, reply: any) {
    try {
      await request.jwtVerify();
    } catch (err) {
      reply.status(401).send({ error: "Unauthorized" });
    }
  });

  // Internal API key for service-to-service auth (AI service → backend).
  // Only grants admin context on dedicated internal paths — never on user-
  // facing routes — and does NOT monkey-patch request.jwtVerify globally.
  //
  // Allowed path prefixes (AI service needs these during invoice scan + match):
  //   /ai/                  — AI-specific endpoints
  //   /internal/            — reserved for future internal-only endpoints
  //   /product-aliases/     — alias lookup + learn during product matching
  //   /products             — read-only catalog access for similarity scoring
  //   /agent                — read-only agent connector (Telegram tester / AI agent)
  const internalApiKey = process.env.INTERNAL_API_KEY;
  const INTERNAL_ALLOWED_PREFIXES = [
    "/ai/",
    "/internal/",
    "/product-aliases",
    "/products",
    "/agent",
  ];
  if (internalApiKey) {
    app.addHook("onRequest", async (request: any) => {
      const auth = request.headers.authorization;
      if (auth !== `Bearer ${internalApiKey}`) return;

      const url = typeof request.url === "string" ? request.url : "";
      const pathname = url.split("?")[0];
      const allowed = INTERNAL_ALLOWED_PREFIXES.some((prefix) =>
        pathname.startsWith(prefix),
      );
      if (!allowed) return;

      request.user = {
        id: "ai-service",
        email: "ai@mertm.bg",
        role: "admin",
        name: "AI Service",
      };
      // Routes call `request.jwtVerify()` via their own requireAuth helpers.
      // When the internal API key is valid AND the path is whitelisted above,
      // short-circuit jwtVerify so downstream code sees request.user without
      // needing a JWT. Scope-limited: this override never leaks to other paths.
      request.jwtVerify = async () => request.user;
    });
  }

  // Global error handler — catch errors with statusCode from transactions
  app.setErrorHandler((error: any, request, reply) => {
    const statusCode = error.statusCode || 500;
    const message = error.message || "Internal server error";
    if (statusCode >= 500) {
      request.log.error(error);
    }
    reply.status(statusCode).send({ error: message });
  });

  // Health check — includes DB connectivity. Returns HTTP 503 when DB
  // is unreachable so Railway / Docker / load balancer healthchecks
  // actually flap (a 200 with status:"degraded" silently kept routing
  // traffic to a broken replica before this fix).
  app.get("/health", async (_req, reply) => {
    let dbConnected = true;
    try {
      const { query: dbQuery } = await import("./db.js");
      await dbQuery("SELECT 1");
    } catch {
      dbConnected = false;
    }
    reply.code(dbConnected ? 200 : 503).send({
      status: dbConnected ? "ok" : "degraded",
      database: dbConnected ? "connected" : "disconnected",
      timestamp: new Date().toISOString(),
      version: "1.0.0",
    });
  });

  // Routes
  await app.register(
    async (scope) => {
      scope.addHook("onRoute", (routeOptions) => {
        routeOptions.config = {
          ...(routeOptions.config || {}),
          rateLimit: { max: 10, timeWindow: "15 minutes" },
        };
      });
      await scope.register(authRoutes);
    },
    { prefix: "/auth" },
  );
  await app.register(productRoutes, { prefix: "/products" });
  await app.register(inventoryRoutes, { prefix: "/inventory" });
  await app.register(incomingRoutes, { prefix: "/incoming" });
  await app.register(orderRoutes, { prefix: "/orders" });
  await app.register(partnerRoutes, { prefix: "/partners" });
  await app.register(invoiceRoutes, { prefix: "/invoices" });
  await app.register(paymentRoutes, { prefix: "/payments" });
  await app.register(analyticsRoutes, { prefix: "/analytics" });
  await app.register(categoriesRoutes, { prefix: "/categories" });
  await app.register(suppliersRoutes, { prefix: "/suppliers" });
  await app.register(usersRoutes, { prefix: "/users" });
  await app.register(settingsRoutes, { prefix: "/settings" });
  await app.register(notificationRoutes, { prefix: "/notifications" });
  await app.register(importRoutes, { prefix: "/import" });
  await app.register(exportRoutes, { prefix: "/export" });
  await app.register(productAliasRoutes, { prefix: "/product-aliases" });
  await app.register(fiscalRoutes, { prefix: "/fiscal" });
  await app.register(econtRoutes, { prefix: "/econt" });
  await app.register(chatRoutes);
  await app.register(agentRoutes, { prefix: "/agent" });

  return app;
}

async function start() {
  const app = await build();

  // Graceful shutdown — drain in-flight requests + close DB pool before exit.
  // Without this, Railway/PM2 redeploys would SIGTERM the process mid-
  // transaction, leaving incoming_goods/orders rows in inconsistent state.
  //
  // Order matters:
  //   1. app.close() — Fastify stops accepting new connections, waits for
  //      in-flight handlers to finish (default 5s timeout).
  //   2. pool.end() — pg.Pool drains idle clients, returning ROLLBACK on
  //      any still-open transactions.
  const shutdown = async (signal: string) => {
    app.log.info({ signal }, "shutdown initiated");
    try {
      await app.close();
      await dbPool.end();
      app.log.info("shutdown complete");
      process.exit(0);
    } catch (err) {
      app.log.error({ err }, "shutdown failed");
      process.exit(1);
    }
  };

  process.on("SIGTERM", () => void shutdown("SIGTERM"));
  process.on("SIGINT", () => void shutdown("SIGINT"));

  // Start server
  const port = parseInt(process.env.PORT || "3000", 10);
  const host = process.env.HOST || "0.0.0.0";

  await app.listen({ port, host });
  console.log(`🏛️  МЕРТ-М Warehouse API running on http://${host}:${port}`);
}

// Auto-start when running the server directly. Skipped under Vitest so
// tests can import { build } without binding to a port or spawning
// SIGTERM/SIGINT handlers that interfere with the runner.
if (!process.env.VITEST) {
  start().catch((err) => {
    console.error("Failed to start server:", err);
    process.exit(1);
  });
}
