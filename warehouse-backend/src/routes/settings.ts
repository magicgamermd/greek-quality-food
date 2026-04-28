import { FastifyInstance, FastifyRequest, FastifyReply } from "fastify";
import { z } from "zod";
import { query } from "../db.js";
import { requirePermission, PERMISSIONS } from "../lib/permissions.js";

const updateSettingsSchema = z.object({
  company_name: z.string().nullish(),
  address: z.string().nullish(),
  eik: z.string().nullish(),
  vat_number: z.string().nullish(),
  iban: z.string().nullish(),
  phone: z.string().nullish(),
  // Accept empty strings for email (user clearing the field)
  email: z.union([z.literal(""), z.string().email(), z.null()]).optional(),
  bank_name: z.string().nullish(),
  bic: z.string().nullish(),
  mol: z.string().nullish(),
  // Fiscal printer settings
  fiscal_enabled: z.boolean().optional(),
  fiscal_connection_type: z.enum(["fpgate", "serial"]).nullish(),
  fiscal_fpgate_url: z.string().nullish(),
  fiscal_printer_id: z.string().nullish(),
  fiscal_serial_port: z.string().nullish(),
  fiscal_auto_print: z.boolean().optional(),
  fiscal_operator_id: z.string().nullish(),
  fiscal_operator_password: z.string().nullish(),
  // Write-off commission defaults (НАП protocol auto-fill)
  writeoff_commission_chair: z.string().max(255).nullish(),
  writeoff_commission_member1: z.string().max(255).nullish(),
  writeoff_commission_member2: z.string().max(255).nullish(),
});

async function requireAuth(request: FastifyRequest) {
  await request.jwtVerify();
}

const adminPreHandler = [
  requireAuth,
  requirePermission(PERMISSIONS.SETTINGS_MANAGE),
];

// Ensure settings table exists
async function ensureSettingsTable() {
  try {
    await query(
      `CREATE TABLE IF NOT EXISTS settings (
        id INTEGER PRIMARY KEY,
        company_name TEXT,
        address TEXT,
        eik TEXT,
        vat_number TEXT,
        iban TEXT,
        phone TEXT,
        email TEXT,
        updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      )`,
    );
  } catch (err) {
    console.error("Failed to create settings table:", err);
  }
}

export default async function settingsRoutes(app: FastifyInstance) {
  // Ensure table exists on startup
  await ensureSettingsTable();

  // GET /settings — Get company settings (all roles)
  app.get(
    "/",
    { preHandler: [requireAuth] },
    async (request: FastifyRequest, reply: FastifyReply) => {
      const { rows } = await query("SELECT * FROM settings WHERE id = 1");

      if (rows.length === 0) {
        // Return empty settings
        return {
          id: 1,
          company_name: null,
          address: null,
          eik: null,
          vat_number: null,
          iban: null,
          phone: null,
          email: null,
          bank_name: null,
          bic: null,
          mol: null,
          updated_at: null,
        };
      }

      return rows[0];
    },
  );

  // POST /settings — Save company settings (admin only)
  app.post(
    "/",
    { preHandler: adminPreHandler },
    async (request: FastifyRequest, reply: FastifyReply) => {
      const body = updateSettingsSchema.parse(request.body);

      // Check if settings exist
      const { rows: existing } = await query(
        "SELECT id FROM settings WHERE id = 1",
      );

      if (existing.length === 0) {
        // Insert new settings
        const { rows } = await query(
          `INSERT INTO settings (id, company_name, address, eik, vat_number, iban, phone, email, bank_name, bic, mol,
         fiscal_enabled, fiscal_connection_type, fiscal_fpgate_url, fiscal_printer_id, fiscal_serial_port, fiscal_auto_print, fiscal_operator_id, fiscal_operator_password,
         updated_at)
         VALUES (1, $1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18, NOW())
         RETURNING *`,
          [
            body.company_name || null,
            body.address || null,
            body.eik || null,
            body.vat_number || null,
            body.iban || null,
            body.phone || null,
            body.email || null,
            body.bank_name || null,
            body.bic || null,
            body.mol || null,
            body.fiscal_enabled ?? false,
            body.fiscal_connection_type || "fpgate",
            body.fiscal_fpgate_url || "http://localhost:8182",
            body.fiscal_printer_id || null,
            body.fiscal_serial_port || null,
            body.fiscal_auto_print ?? false,
            body.fiscal_operator_id || "1",
            body.fiscal_operator_password || "0000",
          ],
        );
        return reply.status(201).send(rows[0]);
      } else {
        // Update existing settings
        const setClauses: string[] = [];
        const params: any[] = [];
        let idx = 1;

        const fields: [string, any][] = [
          ["company_name", body.company_name],
          ["address", body.address],
          ["eik", body.eik],
          ["vat_number", body.vat_number],
          ["iban", body.iban],
          ["phone", body.phone],
          ["email", body.email],
          ["bank_name", body.bank_name],
          ["bic", body.bic],
          ["mol", body.mol],
          ["fiscal_enabled", body.fiscal_enabled],
          ["fiscal_connection_type", body.fiscal_connection_type],
          ["fiscal_fpgate_url", body.fiscal_fpgate_url],
          ["fiscal_printer_id", body.fiscal_printer_id],
          ["fiscal_serial_port", body.fiscal_serial_port],
          ["fiscal_auto_print", body.fiscal_auto_print],
          ["fiscal_operator_id", body.fiscal_operator_id],
          ["fiscal_operator_password", body.fiscal_operator_password],
          ["writeoff_commission_chair", body.writeoff_commission_chair],
          ["writeoff_commission_member1", body.writeoff_commission_member1],
          ["writeoff_commission_member2", body.writeoff_commission_member2],
        ];

        for (const [field, value] of fields) {
          if (value !== undefined) {
            setClauses.push(`${field} = $${idx++}`);
            params.push(value);
          }
        }

        if (setClauses.length === 0) {
          const { rows: current } = await query(
            "SELECT * FROM settings WHERE id = 1",
          );
          return current[0];
        }

        setClauses.push("updated_at = NOW()");

        const { rows } = await query(
          `UPDATE settings SET ${setClauses.join(", ")} WHERE id = 1 RETURNING *`,
          params,
        );
        return rows[0];
      }
    },
  );
}
