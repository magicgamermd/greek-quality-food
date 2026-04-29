// MERT-M agent connector — minimal, read-only surface designed for the
// AI / Telegram tester layer. Every handler:
//   * calls `request.jwtVerify()` so a regular JWT works AND so the
//     INTERNAL_API_KEY hook in src/index.ts can short-circuit it for
//     service-to-service calls (the hook only triggers for paths in
//     INTERNAL_ALLOWED_PREFIXES — `/agent` is in that allowlist).
//   * uses parameterized SQL only.
//   * never writes — POST/PUT/DELETE are intentionally absent here.
import { FastifyInstance, FastifyRequest, FastifyReply } from "fastify";
import { query } from "../db.js";

async function requireAuth(request: FastifyRequest, _reply: FastifyReply) {
  await request.jwtVerify();
}

function clampLimit(raw: unknown, fallback: number, max: number): number {
  const parsed = parseInt(String(raw ?? ""), 10);
  if (!Number.isFinite(parsed) || parsed <= 0) return fallback;
  return Math.min(max, parsed);
}

export default async function agentRoutes(app: FastifyInstance) {
  // GET /agent/health — auth + DB ping. Distinct from the public /health
  // probe so that monitoring tools / agents can detect "DB up AND my
  // credentials still work" in a single call.
  app.get("/health", async (request: FastifyRequest, reply: FastifyReply) => {
    await requireAuth(request, reply);
    if (reply.sent) return;

    let dbConnected = true;
    try {
      await query("SELECT 1");
    } catch {
      dbConnected = false;
    }

    return reply.code(dbConnected ? 200 : 503).send({
      ok: dbConnected,
      service: "mertm-agent-api",
      database: dbConnected ? "connected" : "disconnected",
      actor: {
        id: request.user?.id ?? null,
        role: request.user?.role ?? null,
      },
      timestamp: new Date().toISOString(),
    });
  });

  // GET /agent/products/search?q=&limit=
  // Lightweight product lookup keyed off name_bg / name_en / sku / brand.
  // Returns a flat array shaped for the conversational tester / AI agent.
  app.get(
    "/products/search",
    async (request: FastifyRequest, reply: FastifyReply) => {
      await requireAuth(request, reply);
      if (reply.sent) return;

      const { q, limit } = request.query as { q?: string; limit?: string };
      const trimmed = typeof q === "string" ? q.trim() : "";
      if (!trimmed) {
        return reply
          .status(400)
          .send({ error: "Missing required query parameter `q`." });
      }
      const pageSize = clampLimit(limit, 20, 20);

      const sql = `
        SELECT p.id, p.sku, p.name_bg, p.name_en, p.brand, p.unit,
               p.selling_price, p.purchase_price,
               COALESCE(SUM(inv.quantity), 0)::numeric AS total_stock
        FROM products p
        LEFT JOIN inventory inv ON inv.product_id = p.id
        WHERE
          normalize_search(p.name_bg) ILIKE '%' || normalize_search($1) || '%'
          OR normalize_search(p.name_en) ILIKE '%' || normalize_search($1) || '%'
          OR p.sku ILIKE $2
          OR p.brand ILIKE $2
        GROUP BY p.id
        ORDER BY
          CASE
            WHEN LOWER(COALESCE(p.sku, '')) = $3 THEN 0
            WHEN LOWER(COALESCE(p.name_bg, '')) = $3 THEN 0
            WHEN LOWER(COALESCE(p.name_en, '')) = $3 THEN 0
            WHEN LOWER(COALESCE(p.name_bg, '')) LIKE $4 THEN 1
            WHEN LOWER(COALESCE(p.name_en, '')) LIKE $4 THEN 1
            WHEN LOWER(COALESCE(p.sku, '')) LIKE $4 THEN 1
            ELSE 2
          END,
          p.name_bg
        LIMIT $5
      `;
      const lower = trimmed.toLowerCase();
      const { rows } = await query(sql, [
        trimmed,
        `%${trimmed}%`,
        lower,
        `${lower}%`,
        pageSize,
      ]);

      return {
        query: trimmed,
        limit: pageSize,
        count: rows.length,
        data: rows,
      };
    },
  );

  // GET /agent/inventory?search=&has_stock=&limit=
  // Aggregated stock per product. Mirrors /inventory but returns a smaller
  // payload tailored for agent prompts and skips pagination metadata the
  // tester does not need.
  app.get(
    "/inventory",
    async (request: FastifyRequest, reply: FastifyReply) => {
      await requireAuth(request, reply);
      if (reply.sent) return;

      const { search, has_stock, limit } = request.query as {
        search?: string;
        has_stock?: string;
        limit?: string;
      };
      const trimmed = typeof search === "string" ? search.trim() : "";
      const pageSize = clampLimit(limit, 20, 20);

      const conditions: string[] = [];
      const params: any[] = [];
      let idx = 1;

      if (trimmed) {
        conditions.push(`(
          normalize_search(p.name_bg) ILIKE '%' || normalize_search($${idx}) || '%'
          OR normalize_search(p.name_en) ILIKE '%' || normalize_search($${idx}) || '%'
          OR p.sku ILIKE $${idx + 1}
        )`);
        params.push(trimmed, `%${trimmed}%`);
        idx += 2;
      }

      const where =
        conditions.length > 0 ? `WHERE ${conditions.join(" AND ")}` : "";

      const havingConds: string[] = [];
      if (has_stock === "true") {
        havingConds.push("COALESCE(SUM(inv.quantity), 0) > 0");
      } else if (has_stock === "false" || has_stock === "zero") {
        havingConds.push("COALESCE(SUM(inv.quantity), 0) = 0");
      }
      const having =
        havingConds.length > 0 ? `HAVING ${havingConds.join(" AND ")}` : "";

      const limitParam = `$${idx}`;
      params.push(pageSize);

      const sql = `
        SELECT p.id AS product_id, p.sku, p.name_bg, p.name_en, p.unit,
               p.low_stock_threshold, p.selling_price,
               COALESCE(SUM(inv.quantity), 0)::numeric AS total_quantity
        FROM products p
        LEFT JOIN inventory inv ON inv.product_id = p.id
        ${where}
        GROUP BY p.id
        ${having}
        ORDER BY p.name_bg
        LIMIT ${limitParam}
      `;

      const { rows } = await query(sql, params);

      return {
        search: trimmed || null,
        has_stock: has_stock ?? null,
        limit: pageSize,
        count: rows.length,
        data: rows,
      };
    },
  );
}
