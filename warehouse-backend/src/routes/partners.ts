import { FastifyInstance, FastifyRequest, FastifyReply } from "fastify";
import { z } from "zod";
import { query } from "../db.js";
import { partnerCreateSchema, partnerUpdateSchema } from "./partner-schemas.js";
import { requirePermission, PERMISSIONS } from "../lib/permissions.js";

const priceListItemSchema = z.object({
  items: z.array(
    z.object({
      product_id: z.number().int(),
      price: z.number().min(0),
    }),
  ),
});

async function requireAuth(request: FastifyRequest, reply: FastifyReply) {
  await request.jwtVerify();
}

const jwtVerify = async (request: FastifyRequest) => {
  await request.jwtVerify();
};

const partnersManagePreHandler = [
  jwtVerify,
  requirePermission(PERMISSIONS.PARTNERS_MANAGE),
];

export default async function partnerRoutes(app: FastifyInstance) {
  // GET /partners/lookup/:eik — auto-fill company data from EIK
  app.get(
    "/lookup/:eik",
    async (request: FastifyRequest, reply: FastifyReply) => {
      await requireAuth(request, reply);
      const { eik } = request.params as { eik: string };

      if (!/^\d{9,13}$/.test(eik)) {
        return reply.status(400).send({ error: "ЕИК трябва да е 9-13 цифри" });
      }

      try {
        const res = await fetch(`https://papagal.bg/api/eik/${eik}`);
        if (!res.ok) throw new Error("Not found");
        const data = (await res.json()) as Record<string, any>;
        return {
          name: data.company_name || data.name || "",
          address: data.address || "",
          city: data.city || "",
          vat_number:
            data.vat_number || (data.is_vat_registered ? `BG${eik}` : ""),
          manager: data.manager || data.representative || "",
        };
      } catch {
        return reply.status(404).send({ error: "Фирмата не е намерена" });
      }
    },
  );

  // GET /partners
  app.get("/", async (request: FastifyRequest, reply: FastifyReply) => {
    await requireAuth(request, reply);

    const { search, page, limit, category, catalog } = request.query as any;
    const pageNum = Math.max(1, parseInt(page) || 1);
    // Allow larger page size when catalog=true so dropdown consumers
    // (Orders, Invoices, Partners list) can fetch the full partner
    // directory in a single request. 5000 is safe — partners rarely
    // exceed a few hundred in practice.
    const maxLimit = catalog === "true" ? 5000 : 100;
    const pageSize = Math.min(maxLimit, Math.max(1, parseInt(limit) || 50));
    const offset = (pageNum - 1) * pageSize;

    const conditions: string[] = [];
    const params: any[] = [];
    let paramIdx = 1;

    if (search) {
      // Transliteration-aware: normalize both sides so "bakalia" matches "БАКАЛИЯ"
      // $N holds the raw pattern for eik/code; $N+1 holds the normalized pattern for name.
      conditions.push(
        `(
          normalize_search(p.name) ILIKE '%' || normalize_search($${paramIdx}) || '%'
          OR p.eik ILIKE $${paramIdx + 1}
          OR p.microinvest_code ILIKE $${paramIdx + 1}
        )`,
      );
      params.push(search, `%${search}%`);
      paramIdx += 2;
    }

    if (category) {
      conditions.push(`p.category = $${paramIdx}`);
      params.push(category);
      paramIdx++;
    }

    const where =
      conditions.length > 0 ? `WHERE ${conditions.join(" AND ")}` : "";

    // Snapshot WHERE-clause params for count query BEFORE pushing ORDER/LIMIT args
    const countParams = [...params];

    // When searching, rank by pg_trgm similarity DESC — most relevant first.
    // Otherwise alphabetical by name.
    let orderClause = "ORDER BY p.name";
    if (search) {
      orderClause = `ORDER BY similarity(normalize_search(p.name), normalize_search($${paramIdx})) DESC, p.name ASC`;
      params.push(search);
      paramIdx++;
    }

    const sql = `
      SELECT p.*, pl.name AS price_list_name
      FROM partners p
      LEFT JOIN price_lists pl ON pl.id = p.price_list_id
      ${where}
      ${orderClause}
      LIMIT $${paramIdx++} OFFSET $${paramIdx++}
    `;
    params.push(pageSize, offset);

    const { rows } = await query(sql, params);

    // Count total for pagination (uses WHERE-clause params only)
    const countSql = `SELECT COUNT(*) as total FROM partners p ${where}`;
    const { rows: countRows } = await query(countSql, countParams);
    const total = parseInt(countRows[0]?.total || "0");

    return {
      data: rows,
      pagination: { page: pageNum, limit: pageSize, total },
    };
  });

  // GET /partners/order-counts — count of orders per partner
  app.get(
    "/order-counts",
    async (request: FastifyRequest, reply: FastifyReply) => {
      await requireAuth(request, reply);
      const { rows } = await query(
        `SELECT partner_id, COUNT(*)::int AS order_count
         FROM orders
         WHERE status != 'cancelled'
         GROUP BY partner_id`,
      );
      const map: Record<number, number> = {};
      for (const r of rows) {
        map[r.partner_id] = r.order_count;
      }
      return map;
    },
  );

  // GET /partners/:id/order-objects — reusable object/store options by partner
  app.get(
    "/:id/order-objects",
    async (request: FastifyRequest, reply: FastifyReply) => {
      await requireAuth(request, reply);
      const { id } = request.params as { id: string };
      const partnerId = parseInt(id);
      if (Number.isNaN(partnerId)) {
        return reply.status(400).send({ error: "Invalid partner id" });
      }

      const {
        rows: [partner],
      } = await query("SELECT id FROM partners WHERE id = $1", [partnerId]);
      if (!partner) {
        return reply.status(404).send({ error: "Partner not found" });
      }

      const { rows } = await query(
        `SELECT po.id,
                po.partner_id,
                po.object_name,
                NULLIF(po.object_code, '') AS object_code,
                COUNT(o.id)::int AS usage_count,
                MAX(o.created_at) AS last_used_at
         FROM partner_order_objects po
         LEFT JOIN orders o ON o.partner_object_id = po.id
         WHERE po.partner_id = $1
         GROUP BY po.id
         ORDER BY LOWER(po.object_name), LOWER(po.object_code), po.id`,
        [partnerId],
      );

      return { data: rows };
    },
  );

  // GET /partners/:id
  app.get("/:id", async (request: FastifyRequest, reply: FastifyReply) => {
    await requireAuth(request, reply);
    const { id } = request.params as { id: string };
    const {
      rows: [partner],
    } = await query(
      `SELECT p.*, pl.name AS price_list_name
       FROM partners p
       LEFT JOIN price_lists pl ON pl.id = p.price_list_id
       WHERE p.id = $1`,
      [id],
    );
    if (!partner) {
      return reply.status(404).send({ error: "Partner not found" });
    }
    return partner;
  });

  // POST /partners
  app.post(
    "/",
    { preHandler: partnersManagePreHandler },
    async (request: FastifyRequest, reply: FastifyReply) => {
      const body = partnerCreateSchema.parse(request.body);

      // Individual partners never carry EIK / VAT / bank info even if the
      // client accidentally sent them. Normalise to null so the DB row is clean.
      const isIndividual = body.partner_type === "individual";
      const eik = isIndividual ? null : body.eik || null;
      const vatNumber = isIndividual ? null : body.vat_number || null;

      const { rows } = await query(
        `INSERT INTO partners
         (name, eik, vat_number, address, contact_person, phone, email,
          price_list_id, city, print_name, partner_type)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)
       RETURNING *`,
        [
          body.name,
          eik,
          vatNumber,
          body.address || null,
          body.contact_person || null,
          body.phone || null,
          body.email || null,
          body.price_list_id ?? null,
          body.city || null,
          body.print_name || null,
          body.partner_type,
        ],
      );

      return reply.status(201).send(rows[0]);
    },
  );

  // PUT /partners/:id
  app.put(
    "/:id",
    { preHandler: partnersManagePreHandler },
    async (request: FastifyRequest, reply: FastifyReply) => {
      const { id } = request.params as { id: string };
      const body = partnerUpdateSchema.parse(request.body);

      // For individuals, force-null EIK/VAT so lingering legacy values don't
      // persist when the client switches partner_type. Use a separate object
      // instead of mutating the parsed result — cleaner types at the SET-builder.
      const updatePayload: Record<string, unknown> = { ...body };
      if (body.partner_type === "individual") {
        updatePayload.eik = null;
        updatePayload.vat_number = null;
      }

      const fields: string[] = [];
      const values: any[] = [];
      let idx = 1;

      for (const [key, val] of Object.entries(updatePayload)) {
        if (val !== undefined) {
          fields.push(`${key} = $${idx++}`);
          values.push(val);
        }
      }

      if (fields.length === 0) {
        return reply.status(400).send({ error: "No fields to update" });
      }

      fields.push("updated_at = NOW()");
      values.push(id);

      const { rows } = await query(
        `UPDATE partners SET ${fields.join(", ")} WHERE id = $${idx} RETURNING *`,
        values,
      );

      if (rows.length === 0) {
        return reply.status(404).send({ error: "Partner not found" });
      }
      return rows[0];
    },
  );

  // GET /partners/:id/price-list
  app.get(
    "/:id/price-list",
    async (request: FastifyRequest, reply: FastifyReply) => {
      await requireAuth(request, reply);
      const { id } = request.params as { id: string };

      const {
        rows: [partner],
      } = await query("SELECT * FROM partners WHERE id = $1", [id]);

      if (!partner) {
        return reply.status(404).send({ error: "Partner not found" });
      }

      if (!partner.price_list_id) {
        return { partner_id: parseInt(id), price_list: null, items: [] };
      }

      const {
        rows: [priceList],
      } = await query("SELECT * FROM price_lists WHERE id = $1", [
        partner.price_list_id,
      ]);

      const { rows: items } = await query(
        `SELECT pli.*, p.name_bg, p.name_en, p.sku, p.unit
       FROM price_list_items pli
       JOIN products p ON p.id = pli.product_id
       WHERE pli.price_list_id = $1
       ORDER BY p.name_en`,
        [partner.price_list_id],
      );

      return {
        partner_id: parseInt(id),
        price_list: priceList,
        items,
      };
    },
  );

  // PUT /partners/:id/price-list — set/update price list items
  app.put(
    "/:id/price-list",
    { preHandler: partnersManagePreHandler },
    async (request: FastifyRequest, reply: FastifyReply) => {
      const { id } = request.params as { id: string };
      const body = priceListItemSchema.parse(request.body);

      const {
        rows: [partner],
      } = await query("SELECT * FROM partners WHERE id = $1", [id]);

      if (!partner) {
        return reply.status(404).send({ error: "Partner not found" });
      }

      let priceListId = partner.price_list_id;

      // Create price list if none exists
      if (!priceListId) {
        const {
          rows: [pl],
        } = await query(
          `INSERT INTO price_lists (name, description)
         VALUES ($1, $2) RETURNING id`,
          [`Price list for ${partner.name}`, `Auto-created for partner #${id}`],
        );
        priceListId = pl.id;
        await query("UPDATE partners SET price_list_id = $1 WHERE id = $2", [
          priceListId,
          id,
        ]);
      }

      // Upsert items
      for (const item of body.items) {
        await query(
          `INSERT INTO price_list_items (price_list_id, product_id, price)
         VALUES ($1, $2, $3)
         ON CONFLICT (price_list_id, product_id)
         DO UPDATE SET price = $3`,
          [priceListId, item.product_id, item.price],
        );
      }

      return {
        message: "Price list updated",
        price_list_id: priceListId,
        items_updated: body.items.length,
      };
    },
  );
}
