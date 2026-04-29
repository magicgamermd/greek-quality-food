import { spawnSync } from "node:child_process";
import {
  argFlag,
  closeConnections,
  getConnectionMode,
  queryRows,
  queryValue,
} from "../reconciliation/lib.js";

const DEFAULT_DOCKER_CONTAINER =
  process.env.RECON_POSTGRES_CONTAINER || "warehouse-backend-postgres-1";

const SEED_TIMESTAMP = "2026-04-08 11:51:36.457535+00";

const ORPHAN_INVENTORY_SQL = `
WITH inventory_with_incoming AS (
  SELECT DISTINCT ii.product_id
  FROM incoming_items ii
  JOIN incoming_goods ig ON ig.id = ii.incoming_goods_id
  WHERE ig.status = 'confirmed'
),
null_batch_inventory AS (
  SELECT i.product_id, i.quantity
  FROM inventory i
  WHERE i.batch_id IS NULL
    AND i.warehouse_id = 1
    AND i.quantity > 0
)
SELECT nb.product_id,
       p.sku,
       p.name_bg,
       nb.quantity AS current_qty,
       COALESCE(out_agg.out_qty, 0)::numeric(12,3) AS fulfilled_out_qty,
       (nb.quantity + COALESCE(out_agg.out_qty, 0))::numeric(12,3) AS original_seeded_qty
FROM null_batch_inventory nb
JOIN products p ON p.id = nb.product_id
LEFT JOIN inventory_with_incoming iwi ON iwi.product_id = nb.product_id
LEFT JOIN (
  SELECT oi.product_id, SUM(oi.quantity)::numeric(12,3) AS out_qty
  FROM order_items oi
  JOIN orders o ON o.id = oi.order_id
  WHERE o.status IN ('fulfilled', 'invoiced')
  GROUP BY oi.product_id
) out_agg ON out_agg.product_id = nb.product_id
WHERE iwi.product_id IS NULL
ORDER BY nb.product_id`;

type OrphanRow = {
  product_id: number;
  sku: string;
  name_bg: string;
  current_qty: number;
  fulfilled_out_qty: number;
  original_seeded_qty: number;
};

async function main() {
  const apply = argFlag("--apply");
  const connectionMode = await getConnectionMode();
  const orphans = await queryRows<OrphanRow>(ORPHAN_INVENTORY_SQL);

  if (orphans.length === 0) {
    console.log(
      JSON.stringify(
        {
          connection_mode: connectionMode,
          apply,
          orphans_found: 0,
          message: "Nothing to repair",
        },
        null,
        2,
      ),
    );
    return;
  }

  const totalAmount = orphans.reduce(
    (sum, row) => sum + Number(row.original_seeded_qty),
    0,
  );

  const summary = {
    connection_mode: connectionMode,
    apply,
    orphans_found: orphans.length,
    total_original_seeded_qty: totalAmount,
    orphans,
  };

  if (!apply) {
    console.log(JSON.stringify(summary, null, 2));
    console.error(
      `\nDry run: ${orphans.length} orphan inventory rows found. Run with --apply to create opening-balance incoming record.`,
    );
    return;
  }

  const valuesList = orphans
    .map(
      (row) =>
        `((SELECT id FROM ob_incoming), ${row.product_id}, ${Number(row.original_seeded_qty)}, 0, 0)`,
    )
    .join(",\n       ");

  const repairSql = `
    WITH ob_incoming AS (
      INSERT INTO incoming_goods (supplier_id, invoice_number, invoice_date, document_type, status, total_amount, created_at, updated_at)
      VALUES (NULL, 'OPENING-BALANCE-2026-04-08', '2026-04-08', 'opening_balance', 'confirmed', 0, '${SEED_TIMESTAMP}', NOW())
      RETURNING id
    ),
    ob_items AS (
      INSERT INTO incoming_items (incoming_goods_id, product_id, quantity, unit_price, total_price)
      VALUES ${valuesList}
      RETURNING id, product_id, quantity
    )
    SELECT (SELECT id FROM ob_incoming) AS incoming_goods_id,
           (SELECT COUNT(*) FROM ob_items) AS items_created,
           (SELECT SUM(quantity)::numeric(12,3) FROM ob_items) AS total_qty`;

  let result: Record<string, unknown>[];
  if (connectionMode === "pg") {
    result = await queryRows(repairSql);
  } else {
    result = runDockerPlainResult(repairSql);
  }

  console.log(
    JSON.stringify(
      {
        ...summary,
        repair_result: result[0] || null,
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

function runDockerPlainResult<T extends Record<string, unknown>>(
  sql: string,
): T[] {
  const result = spawnSync(
    "docker",
    [
      "exec",
      DEFAULT_DOCKER_CONTAINER,
      "psql",
      "-U",
      process.env.RECON_POSTGRES_USER || "mertm",
      "-d",
      process.env.RECON_POSTGRES_DB || "mertm_warehouse",
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

  const lines = result.stdout.trim().split("\n").filter(Boolean);
  if (lines.length === 0) return [];

  return lines.map((line) => {
    const [incoming_goods_id, items_created, total_qty] = line.split("|");
    return {
      incoming_goods_id: Number(incoming_goods_id),
      items_created: Number(items_created),
      total_qty: Number(total_qty),
    } as unknown as T;
  });
}
