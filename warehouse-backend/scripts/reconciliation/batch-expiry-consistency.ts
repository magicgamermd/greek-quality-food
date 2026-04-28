// ⚠️ DEPRECATED for MERT-M (2026-04-28):
// MERT-M sells durable goods (commercial kitchen equipment) and does
// NOT track batches or expiry dates. This reconciliation check was
// inherited from the greek-foods-platform clone which sold perishable
// food. Running it against the MERT-M schema will fail or return empty
// because the relevant tables/columns don't exist.
//
// Kept in the tree as dead code (Phase 3 Q5 B decision) — minimise diff
// against the upstream baseline. To remove entirely: delete this file
// and drop it from scripts/reconciliation/run-all.ts.

import {
  argFlag,
  buildReport,
  closeConnections,
  getConnectionMode,
  printReport,
  queryRows,
  queryValue,
  sampleLimit,
  type ReconciliationSection,
} from "./lib.js";

async function main() {
  const samples = sampleLimit();

  const linkedIncomingChecked = Number(
    await queryValue(
      `SELECT COUNT(*)::int AS count
       FROM incoming_items ii
       JOIN incoming_goods ig ON ig.id = ii.incoming_goods_id
       WHERE ig.status = 'confirmed' AND ii.batch_id IS NOT NULL`,
      0,
    ),
  );

  const incomingBatchAnomalies = await queryRows(
    `SELECT ig.id AS incoming_goods_id,
            ig.invoice_number,
            ii.id AS incoming_item_id,
            ii.product_id,
            p.sku,
            p.name_bg,
            ii.batch_id,
            b.batch_number,
            b.expiry_date,
            b.received_date,
            b.delivery_id,
            CASE
              WHEN b.id IS NULL THEN 'incoming_item_points_to_missing_batch'
              WHEN b.product_id <> ii.product_id THEN 'batch_product_mismatch'
              WHEN b.delivery_id IS DISTINCT FROM ig.id THEN 'batch_delivery_link_drift'
              WHEN NULLIF(TRIM(b.batch_number), '') IS NULL THEN 'missing_batch_number'
              WHEN b.expiry_date IS NULL THEN 'missing_expiry_date'
              WHEN b.received_date IS NOT NULL AND b.expiry_date < b.received_date THEN 'expiry_before_received'
            END AS mismatch_type
     FROM incoming_items ii
     JOIN incoming_goods ig ON ig.id = ii.incoming_goods_id
     JOIN products p ON p.id = ii.product_id
     LEFT JOIN batches b ON b.id = ii.batch_id
     WHERE ig.status = 'confirmed'
       AND ii.batch_id IS NOT NULL
       AND (
         b.id IS NULL
         OR b.product_id <> ii.product_id
         OR b.delivery_id IS DISTINCT FROM ig.id
         OR NULLIF(TRIM(b.batch_number), '') IS NULL
         OR b.expiry_date IS NULL
         OR (b.received_date IS NOT NULL AND b.expiry_date < b.received_date)
       )
     ORDER BY ig.id DESC, ii.id DESC`,
  );

  const inventoryBatchRowsChecked = Number(
    await queryValue(
      `SELECT COUNT(*)::int AS count FROM inventory WHERE batch_id IS NOT NULL`,
      0,
    ),
  );

  const inventoryBatchAnomalies = await queryRows(
    `SELECT inv.id AS inventory_id,
            inv.product_id,
            p.sku,
            p.name_bg,
            inv.batch_id,
            inv.quantity::numeric(12,3) AS inventory_qty,
            b.product_id AS batch_product_id,
            b.batch_number,
            b.expiry_date,
            CASE
              WHEN b.id IS NULL THEN 'inventory_points_to_missing_batch'
              WHEN b.product_id <> inv.product_id THEN 'inventory_batch_product_mismatch'
              WHEN inv.quantity > 0 AND NULLIF(TRIM(b.batch_number), '') IS NULL THEN 'inventory_batch_missing_number'
              WHEN inv.quantity > 0 AND b.expiry_date IS NULL THEN 'inventory_batch_missing_expiry'
            END AS mismatch_type
     FROM inventory inv
     JOIN products p ON p.id = inv.product_id
     LEFT JOIN batches b ON b.id = inv.batch_id
     WHERE inv.batch_id IS NOT NULL
       AND (
         b.id IS NULL
         OR b.product_id <> inv.product_id
         OR (inv.quantity > 0 AND NULLIF(TRIM(b.batch_number), '') IS NULL)
         OR (inv.quantity > 0 AND b.expiry_date IS NULL)
       )
     ORDER BY inv.id DESC`,
  );

  const expiringBatchesChecked = Number(
    await queryValue(
      `SELECT COUNT(*)::int AS count
       FROM batches b
       LEFT JOIN inventory inv ON inv.batch_id = b.id
       WHERE b.expiry_date IS NOT NULL
         AND b.expiry_date >= CURRENT_DATE
         AND COALESCE(inv.quantity, 0) > 0`,
      0,
    ),
  );

  const expiringSurfaceDrift = await queryRows(
    `WITH canonical AS (
       SELECT b.id AS batch_id,
              b.product_id,
              p.sku,
              p.name_bg,
              b.batch_number,
              b.expiry_date,
              COALESCE(SUM(inv.quantity), 0)::numeric(12,3) AS expected_qty
       FROM batches b
       JOIN products p ON p.id = b.product_id
       LEFT JOIN inventory inv ON inv.batch_id = b.id
       WHERE b.expiry_date IS NOT NULL
         AND b.expiry_date <= CURRENT_DATE + 365
         AND b.expiry_date >= CURRENT_DATE
         AND COALESCE(inv.quantity, 0) > 0
       GROUP BY b.id, p.sku, p.name_bg
     ),
     expiring_surface AS (
       SELECT b.id AS batch_id,
              COUNT(*)::int AS surfaced_row_count,
              COALESCE(SUM(COALESCE(inv.quantity, 0)), 0)::numeric(12,3) AS surfaced_qty
       FROM batches b
       JOIN products p ON p.id = b.product_id
       LEFT JOIN inventory inv ON inv.batch_id = b.id
       WHERE b.expiry_date IS NOT NULL
         AND b.expiry_date <= CURRENT_DATE + 365
         AND b.expiry_date >= CURRENT_DATE
         AND COALESCE(inv.quantity, 0) > 0
       GROUP BY b.id
     )
     SELECT c.batch_id,
            c.product_id,
            c.sku,
            c.name_bg,
            c.batch_number,
            c.expiry_date,
            c.expected_qty,
            e.surfaced_row_count,
            e.surfaced_qty,
            (e.surfaced_qty - c.expected_qty)::numeric(12,3) AS delta_qty,
            CASE
              WHEN e.surfaced_row_count > 1 THEN 'expiring_endpoint_duplicate_rows'
              WHEN ABS(e.surfaced_qty - c.expected_qty) > 0.001 THEN 'expiring_endpoint_quantity_drift'
            END AS mismatch_type
     FROM canonical c
     JOIN expiring_surface e ON e.batch_id = c.batch_id
     WHERE e.surfaced_row_count > 1
        OR ABS(e.surfaced_qty - c.expected_qty) > 0.001
     ORDER BY e.surfaced_row_count DESC, ABS(e.surfaced_qty - c.expected_qty) DESC, c.batch_id DESC`,
  );

  const sections: ReconciliationSection[] = [
    {
      key: "incoming-batch-metadata",
      title: "Confirmed incoming batch metadata integrity",
      severity_on_mismatch: "critical",
      rows_checked: linkedIncomingChecked,
      mismatches_found: incomingBatchAnomalies.length,
      recommended_next_action:
        "Correct the affected batch row and re-check incoming_items.batch_id links; batch_number, expiry_date, and delivery_id should describe the accepted delivery exactly.",
      sample_mismatches: incomingBatchAnomalies.slice(0, samples),
    },
    {
      key: "inventory-batch-links",
      title: "Inventory rows pointing at valid batch metadata",
      severity_on_mismatch: "critical",
      rows_checked: inventoryBatchRowsChecked,
      mismatches_found: inventoryBatchAnomalies.length,
      recommended_next_action:
        "Repair or recreate the broken inventory-to-batch references before expiring-stock workflows or FEFO fulfillment depend on them.",
      sample_mismatches: inventoryBatchAnomalies.slice(0, samples),
    },
    {
      key: "expiring-surface",
      title: "Expiring inventory surface vs canonical batch/inventory truth",
      severity_on_mismatch: "warning",
      rows_checked: expiringBatchesChecked,
      mismatches_found: expiringSurfaceDrift.length,
      recommended_next_action:
        "If duplicate rows appear, harden /inventory/expiring to aggregate by batch_id so operators do not see split or overstated expiring quantities.",
      sample_mismatches: expiringSurfaceDrift.slice(0, samples),
    },
  ];

  const report = buildReport(
    "Reconciliation 2 — Incoming batch/expiry vs inventory batch/expiry",
    await getConnectionMode(),
    sections,
  );

  printReport(report, argFlag("--json"));
  process.exitCode = report.total_mismatches_found > 0 ? 1 : 0;
}

main()
  .catch((error) => {
    console.error(error instanceof Error ? error.message : error);
    process.exitCode = 1;
  })
  .finally(async () => {
    await closeConnections();
  });
