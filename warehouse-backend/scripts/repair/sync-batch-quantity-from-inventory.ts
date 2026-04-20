import { spawnSync } from "node:child_process";
import {
  argFlag,
  closeConnections,
  getConnectionMode,
  queryRows,
  sampleLimit,
} from "../reconciliation/lib.js";

type RepairCandidate = {
  batch_id: number;
  incoming_goods_id: number | null;
  delivery_status: string | null;
  product_id: number;
  sku: string;
  name_bg: string;
  batch_number: string;
  current_batch_qty: number;
  target_batch_qty: number;
  delta_qty: number;
  linked_incoming_qty: number;
  repair_reason: "confirmed_double_count" | "pending_preconfirm_batch_qty";
};

const DEFAULT_DOCKER_CONTAINER =
  process.env.RECON_POSTGRES_CONTAINER || "warehouse-backend-postgres-1";

const CANDIDATE_SQL = `WITH inventory_totals AS (
  SELECT batch_id, COALESCE(SUM(quantity), 0)::numeric(12,3) AS inventory_qty
  FROM inventory
  GROUP BY batch_id
),
linked_delivery AS (
  SELECT ii.batch_id,
         COALESCE(SUM(ii.quantity), 0)::numeric(12,3) AS linked_incoming_qty,
         COUNT(*) AS linked_rows,
         COUNT(DISTINCT ii.incoming_goods_id) AS linked_deliveries,
         MIN(ig.status) AS min_status,
         MAX(ig.status) AS max_status
  FROM incoming_items ii
  JOIN incoming_goods ig ON ig.id = ii.incoming_goods_id
  WHERE ii.batch_id IS NOT NULL
  GROUP BY ii.batch_id
),
drift AS (
  SELECT b.id AS batch_id,
         b.delivery_id AS incoming_goods_id,
         ig.status AS delivery_status,
         b.product_id,
         p.sku,
         p.name_bg,
         b.batch_number,
         b.quantity::numeric(12,3) AS current_batch_qty,
         COALESCE(it.inventory_qty, 0)::numeric(12,3) AS target_batch_qty,
         (b.quantity - COALESCE(it.inventory_qty, 0))::numeric(12,3) AS delta_qty,
         COALESCE(ld.linked_incoming_qty, 0)::numeric(12,3) AS linked_incoming_qty,
         COALESCE(ld.linked_rows, 0) AS linked_rows,
         COALESCE(ld.linked_deliveries, 0) AS linked_deliveries,
         ld.min_status,
         ld.max_status,
         CASE
           WHEN ig.status = 'confirmed'
             AND COALESCE(ld.linked_deliveries, 0) = 1
             AND ld.min_status = 'confirmed'
             AND ld.max_status = 'confirmed'
             AND ABS((b.quantity - COALESCE(it.inventory_qty, 0)) - COALESCE(ld.linked_incoming_qty, 0)) <= 0.001
             THEN 'confirmed_double_count'
           WHEN ig.status = 'pending'
             AND ABS(COALESCE(it.inventory_qty, 0)) <= 0.001
             THEN 'pending_preconfirm_batch_qty'
         END AS repair_reason
  FROM batches b
  JOIN products p ON p.id = b.product_id
  LEFT JOIN incoming_goods ig ON ig.id = b.delivery_id
  LEFT JOIN inventory_totals it ON it.batch_id = b.id
  LEFT JOIN linked_delivery ld ON ld.batch_id = b.id
  WHERE ABS(b.quantity - COALESCE(it.inventory_qty, 0)) > 0.001
)
SELECT batch_id,
       incoming_goods_id,
       delivery_status,
       product_id,
       sku,
       name_bg,
       batch_number,
       current_batch_qty,
       target_batch_qty,
       delta_qty,
       linked_incoming_qty,
       repair_reason
FROM drift
WHERE repair_reason IS NOT NULL
ORDER BY batch_id`;

const UNCLASSIFIED_SQL = `WITH inventory_totals AS (
  SELECT batch_id, COALESCE(SUM(quantity), 0)::numeric(12,3) AS inventory_qty
  FROM inventory
  GROUP BY batch_id
),
linked_delivery AS (
  SELECT ii.batch_id,
         COALESCE(SUM(ii.quantity), 0)::numeric(12,3) AS linked_incoming_qty,
         COUNT(*) AS linked_rows,
         COUNT(DISTINCT ii.incoming_goods_id) AS linked_deliveries,
         MIN(ig.status) AS min_status,
         MAX(ig.status) AS max_status
  FROM incoming_items ii
  JOIN incoming_goods ig ON ig.id = ii.incoming_goods_id
  WHERE ii.batch_id IS NOT NULL
  GROUP BY ii.batch_id
),
drift AS (
  SELECT b.id AS batch_id,
         b.delivery_id AS incoming_goods_id,
         ig.status AS delivery_status,
         b.product_id,
         p.sku,
         p.name_bg,
         b.batch_number,
         b.quantity::numeric(12,3) AS current_batch_qty,
         COALESCE(it.inventory_qty, 0)::numeric(12,3) AS target_batch_qty,
         (b.quantity - COALESCE(it.inventory_qty, 0))::numeric(12,3) AS delta_qty,
         COALESCE(ld.linked_incoming_qty, 0)::numeric(12,3) AS linked_incoming_qty,
         COALESCE(ld.linked_rows, 0) AS linked_rows,
         COALESCE(ld.linked_deliveries, 0) AS linked_deliveries,
         ld.min_status,
         ld.max_status,
         CASE
           WHEN ig.status = 'confirmed'
             AND COALESCE(ld.linked_deliveries, 0) = 1
             AND ld.min_status = 'confirmed'
             AND ld.max_status = 'confirmed'
             AND ABS((b.quantity - COALESCE(it.inventory_qty, 0)) - COALESCE(ld.linked_incoming_qty, 0)) <= 0.001
             THEN 'confirmed_double_count'
           WHEN ig.status = 'pending'
             AND ABS(COALESCE(it.inventory_qty, 0)) <= 0.001
             THEN 'pending_preconfirm_batch_qty'
         END AS repair_reason
  FROM batches b
  JOIN products p ON p.id = b.product_id
  LEFT JOIN incoming_goods ig ON ig.id = b.delivery_id
  LEFT JOIN inventory_totals it ON it.batch_id = b.id
  LEFT JOIN linked_delivery ld ON ld.batch_id = b.id
  WHERE ABS(b.quantity - COALESCE(it.inventory_qty, 0)) > 0.001
)
SELECT batch_id,
       incoming_goods_id,
       delivery_status,
       product_id,
       sku,
       name_bg,
       batch_number,
       current_batch_qty,
       target_batch_qty,
       delta_qty,
       linked_incoming_qty
FROM drift
WHERE repair_reason IS NULL
ORDER BY batch_id`;

async function main() {
  const apply = argFlag("--apply");
  const samples = sampleLimit();
  const connectionMode = await getConnectionMode();
  const candidates = await queryRows<RepairCandidate>(CANDIDATE_SQL);
  const unclassified = await queryRows<Record<string, unknown>>(UNCLASSIFIED_SQL);

  const summary = {
    connection_mode: connectionMode,
    apply,
    candidates_found: candidates.length,
    candidates_by_reason: candidates.reduce<Record<string, number>>((acc, row) => {
      acc[row.repair_reason] = (acc[row.repair_reason] || 0) + 1;
      return acc;
    }, {}),
    unclassified_drift_rows: unclassified.length,
    sample_candidates: candidates.slice(0, samples),
    sample_unclassified: unclassified.slice(0, samples),
  };

  if (!apply) {
    console.log(JSON.stringify(summary, null, 2));
    return;
  }

  if (unclassified.length > 0) {
    console.error(JSON.stringify(summary, null, 2));
    throw new Error(
      `Refusing to apply repair while ${unclassified.length} drift rows remain unclassified.`,
    );
  }

  const updateCte = `WITH candidates AS (${CANDIDATE_SQL}),
updated AS (
  UPDATE batches AS b
  SET quantity = c.target_batch_qty,
      updated_at = NOW()
  FROM candidates AS c
  WHERE b.id = c.batch_id
  RETURNING c.batch_id,
            c.incoming_goods_id,
            c.delivery_status,
            c.product_id,
            c.sku,
            c.name_bg,
            c.batch_number,
            c.current_batch_qty,
            c.target_batch_qty,
            c.delta_qty,
            c.linked_incoming_qty,
            c.repair_reason
)`;
  const updateSql = `${updateCte}
SELECT * FROM updated ORDER BY batch_id`;
  const updateJsonSql = `${updateCte}
SELECT COALESCE(json_agg(row_to_json(updated) ORDER BY batch_id), '[]'::json)::text FROM updated`;

  const repaired =
    connectionMode === "pg"
      ? await queryRows<RepairCandidate>(updateSql)
      : runDockerJsonResult<RepairCandidate>(updateJsonSql);

  console.log(
    JSON.stringify(
      {
        ...summary,
        repaired_rows: repaired.length,
        repaired_by_reason: repaired.reduce<Record<string, number>>((acc, row) => {
          acc[row.repair_reason] = (acc[row.repair_reason] || 0) + 1;
          return acc;
        }, {}),
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
