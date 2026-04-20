import { spawnSync } from "node:child_process";
import {
  argFlag,
  argValue,
  closeConnections,
  getConnectionMode,
  queryRows,
  sampleLimit,
} from "../reconciliation/lib.js";

const DEFAULT_DOCKER_CONTAINER =
  process.env.RECON_POSTGRES_CONTAINER || "warehouse-backend-postgres-1";

type RepairCandidate = {
  batch_id: number;
  delivery_id: number;
  invoice_number: string | null;
  invoice_date: string;
  imported_at: string;
  product_id: number;
  sku: string;
  name_bg: string;
  batch_number: string;
  expiry_date: string | null;
  received_date: string;
  repair_reason: "received_date_defaulted_to_import_day";
};

function parseDeliveryId() {
  const raw = argValue("--delivery-id");
  if (raw == null) return null;
  const parsed = Number(raw);
  if (!Number.isInteger(parsed) || parsed <= 0) {
    throw new Error(`Invalid --delivery-id value: ${raw}`);
  }
  return parsed;
}

function candidateSql(deliveryId: number | null) {
  const deliveryFilter = deliveryId == null ? "" : `AND ig.id = ${deliveryId}`;

  return `SELECT b.id AS batch_id,
                 ig.id AS delivery_id,
                 ig.invoice_number,
                 ig.invoice_date,
                 ig.created_at::date AS imported_at,
                 b.product_id,
                 p.sku,
                 p.name_bg,
                 b.batch_number,
                 b.expiry_date,
                 b.received_date,
                 'received_date_defaulted_to_import_day'::text AS repair_reason
          FROM batches b
          JOIN incoming_goods ig ON ig.id = b.delivery_id
          JOIN products p ON p.id = b.product_id
          WHERE ig.status = 'confirmed'
            AND ig.invoice_date IS NOT NULL
            AND b.received_date IS NOT NULL
            AND b.received_date > ig.invoice_date
            AND b.received_date = ig.created_at::date
            ${deliveryFilter}
          ORDER BY ig.id, b.id`;
}

async function main() {
  const apply = argFlag("--apply");
  const samples = sampleLimit();
  const deliveryId = parseDeliveryId();
  const connectionMode = await getConnectionMode();
  const sql = candidateSql(deliveryId);
  const candidates = await queryRows<RepairCandidate>(sql);

  const summary = {
    connection_mode: connectionMode,
    apply,
    delivery_id: deliveryId,
    candidates_found: candidates.length,
    sample_candidates: candidates.slice(0, samples),
  };

  if (!apply) {
    console.log(JSON.stringify(summary, null, 2));
    return;
  }

  if (deliveryId == null) {
    throw new Error("Refusing to apply without --delivery-id=<id>.");
  }

  const updateSql = `WITH candidates AS (${sql}),
updated AS (
  UPDATE batches AS b
  SET received_date = c.invoice_date,
      updated_at = NOW()
  FROM candidates AS c
  WHERE b.id = c.batch_id
  RETURNING c.batch_id,
            c.delivery_id,
            c.invoice_number,
            c.invoice_date,
            c.imported_at,
            c.product_id,
            c.sku,
            c.name_bg,
            c.batch_number,
            c.expiry_date,
            c.received_date,
            c.repair_reason
)
SELECT * FROM updated ORDER BY batch_id`;

  const repaired =
    connectionMode === "pg"
      ? await queryRows<RepairCandidate>(updateSql)
      : runDockerJsonResult<RepairCandidate>(
          `WITH candidates AS (${sql}),
updated AS (
  UPDATE batches AS b
  SET received_date = c.invoice_date,
      updated_at = NOW()
  FROM candidates AS c
  WHERE b.id = c.batch_id
  RETURNING c.batch_id,
            c.delivery_id,
            c.invoice_number,
            c.invoice_date,
            c.imported_at,
            c.product_id,
            c.sku,
            c.name_bg,
            c.batch_number,
            c.expiry_date,
            c.received_date,
            c.repair_reason
)
SELECT COALESCE(json_agg(row_to_json(updated) ORDER BY batch_id), '[]'::json)::text FROM updated`,
        );

  console.log(
    JSON.stringify(
      {
        ...summary,
        repaired_rows: repaired.length,
        sample_repaired: repaired.slice(0, samples),
      },
      null,
      2,
    ),
  );
}

main()
  .catch((error) => {
    console.error(error instanceof Error ? error.message : error);
    process.exitCode = 1;
  })
  .finally(async () => {
    await closeConnections();
  });

function runDockerJsonResult<T>(sql: string): T[] {
  const result = spawnSync(
    "docker",
    [
      "exec",
      DEFAULT_DOCKER_CONTAINER,
      "psql",
      "-U",
      process.env.RECON_POSTGRES_USER || "greekfoods",
      "-d",
      process.env.RECON_POSTGRES_DB || "greekfoods_warehouse",
      "-Atqc",
      sql,
    ],
    { encoding: "utf8" },
  );

  if (result.status !== 0) {
    throw new Error(
      `Docker psql query failed: ${result.stderr || result.stdout || "unknown error"}`,
    );
  }

  const raw = result.stdout.trim() || "[]";
  return JSON.parse(raw) as T[];
}
