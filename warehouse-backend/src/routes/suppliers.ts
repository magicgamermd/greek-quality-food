import { FastifyInstance, FastifyRequest, FastifyReply } from "fastify";
import { query } from "../db.js";

async function requireAuth(request: FastifyRequest, reply: FastifyReply) {
  await request.jwtVerify();
}

export default async function suppliersRoutes(app: FastifyInstance) {
  // GET /suppliers
  app.get("/", async (request: FastifyRequest, reply: FastifyReply) => {
    await requireAuth(request, reply);
    const { rows } = await query(
      "SELECT * FROM suppliers ORDER BY name ASC",
      [],
    );
    return reply.send({ data: rows });
  });

  // GET /suppliers/:id
  app.get("/:id", async (request: FastifyRequest, reply: FastifyReply) => {
    await requireAuth(request, reply);
    const { id } = request.params as any;
    const { rows } = await query("SELECT * FROM suppliers WHERE id = $1", [id]);
    if (rows.length === 0) {
      return reply.status(404).send({ error: "Supplier not found" });
    }
    return reply.send(rows[0]);
  });

  // POST /suppliers
  app.post("/", async (request: FastifyRequest, reply: FastifyReply) => {
    await requireAuth(request, reply);
    const {
      name,
      eik,
      vat_number,
      city,
      address,
      phone,
      email,
      contact_person,
      microinvest_code,
      print_name,
      fax,
      bank_name,
      bic,
      iban,
      vat_account,
      group_name,
      client_type,
      price_group,
      discount_percent,
      card_number,
      payment_days,
    } = request.body as any;
    if (!name) return reply.status(400).send({ error: "name е задължително" });
    const { rows } = await query(
      `INSERT INTO suppliers (name, eik, vat_number, city, address, phone, email, contact_person,
        microinvest_code, print_name, fax, bank_name, bic, iban, vat_account, group_name, client_type, price_group, discount_percent, card_number, payment_days)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21) RETURNING *`,
      [
        name,
        eik || null,
        vat_number || null,
        city || null,
        address || null,
        phone || null,
        email || null,
        contact_person || null,
        microinvest_code || null,
        print_name || null,
        fax || null,
        bank_name || null,
        bic || null,
        iban || null,
        vat_account || null,
        group_name || null,
        client_type || null,
        price_group || null,
        discount_percent || 0,
        card_number || null,
        payment_days || 0,
      ],
    );
    return reply.status(201).send(rows[0]);
  });

  // PUT /suppliers/:id
  app.put("/:id", async (request: FastifyRequest, reply: FastifyReply) => {
    await requireAuth(request, reply);
    const { id } = request.params as any;
    const {
      name,
      eik,
      vat_number,
      city,
      address,
      phone,
      email,
      contact_person,
      microinvest_code,
      print_name,
      fax,
      bank_name,
      bic,
      iban,
      vat_account,
      group_name,
      client_type,
      price_group,
      discount_percent,
      card_number,
      payment_days,
    } = request.body as any;
    const { rows } = await query(
      `UPDATE suppliers SET name=$1,eik=$2,vat_number=$3,city=$4,address=$5,phone=$6,email=$7,contact_person=$8,
        microinvest_code=$9,print_name=$10,fax=$11,bank_name=$12,bic=$13,iban=$14,vat_account=$15,group_name=$16,
        client_type=$17,price_group=$18,discount_percent=$19,card_number=$20,payment_days=$21,
        updated_at=NOW()
       WHERE id=$22 RETURNING *`,
      [
        name,
        eik || null,
        vat_number || null,
        city || null,
        address || null,
        phone || null,
        email || null,
        contact_person || null,
        microinvest_code || null,
        print_name || null,
        fax || null,
        bank_name || null,
        bic || null,
        iban || null,
        vat_account || null,
        group_name || null,
        client_type || null,
        price_group || null,
        discount_percent || 0,
        card_number || null,
        payment_days || 0,
        id,
      ],
    );
    return reply.send(rows[0]);
  });

  // GET /suppliers/delivery-counts — count of incoming goods per supplier
  app.get(
    "/delivery-counts",
    async (request: FastifyRequest, reply: FastifyReply) => {
      await requireAuth(request, reply);
      const { rows } = await query(
        `SELECT supplier_id, COUNT(*)::int AS delivery_count
       FROM incoming_goods
       GROUP BY supplier_id`,
        [],
      );
      const counts: Record<number, number> = {};
      for (const row of rows) {
        counts[row.supplier_id] = row.delivery_count;
      }
      return reply.send(counts);
    },
  );

  // DELETE /suppliers/:id
  app.delete("/:id", async (request: FastifyRequest, reply: FastifyReply) => {
    await requireAuth(request, reply);
    const { id } = request.params as any;
    await query("DELETE FROM suppliers WHERE id=$1", [id]);
    return reply.send({ success: true });
  });
}
