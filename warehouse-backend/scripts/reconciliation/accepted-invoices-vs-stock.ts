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

  const productRowsChecked = Number(
    await queryValue(
      `WITH coverage AS (
         SELECT product_id FROM incoming_items ii
         JOIN incoming_goods ig ON ig.id = ii.incoming_goods_id
         WHERE ig.status = 'confirmed'
         UNION
         SELECT product_id FROM inventory
         UNION
         SELECT product_id FROM order_items oi
         JOIN orders o ON o.id = oi.order_id
         WHERE o.status IN ('fulfilled', 'invoiced')
       )
       SELECT COUNT(*)::int AS count FROM coverage`,
      0,
    ),
  );

  const productBalanceMismatches = await queryRows(
    `WITH incoming_by_product AS (
       SELECT ii.product_id, COALESCE(SUM(ii.quantity), 0)::numeric(12,3) AS incoming_qty
       FROM incoming_items ii
       JOIN incoming_goods ig ON ig.id = ii.incoming_goods_id
       WHERE ig.status = 'confirmed'
       GROUP BY ii.product_id
     ),
     outgoing_by_product AS (
       SELECT oi.product_id, COALESCE(SUM(oi.quantity), 0)::numeric(12,3) AS outgoing_qty
       FROM order_items oi
       JOIN orders o ON o.id = oi.order_id
       WHERE o.status IN ('fulfilled', 'invoiced')
       GROUP BY oi.product_id
     ),
     actual_by_product AS (
       SELECT product_id, COALESCE(SUM(quantity), 0)::numeric(12,3) AS actual_qty
       FROM inventory
       GROUP BY product_id
     ),
     coverage AS (
       SELECT product_id FROM incoming_by_product
       UNION
       SELECT product_id FROM outgoing_by_product
       UNION
       SELECT product_id FROM actual_by_product
     )
     SELECT c.product_id,
            p.sku,
            p.name_bg,
            COALESCE(i.incoming_qty, 0)::numeric(12,3) AS confirmed_in_qty,
            COALESCE(o.outgoing_qty, 0)::numeric(12,3) AS committed_out_qty,
            COALESCE(a.actual_qty, 0)::numeric(12,3) AS actual_inventory_qty,
            (COALESCE(i.incoming_qty, 0) - COALESCE(o.outgoing_qty, 0))::numeric(12,3) AS expected_inventory_qty,
            (COALESCE(a.actual_qty, 0) - (COALESCE(i.incoming_qty, 0) - COALESCE(o.outgoing_qty, 0)))::numeric(12,3) AS delta_qty,
            CASE
              WHEN COALESCE(a.actual_qty, 0) > (COALESCE(i.incoming_qty, 0) - COALESCE(o.outgoing_qty, 0)) THEN 'inventory_higher_than_reconstructed_flow'
              ELSE 'inventory_lower_than_reconstructed_flow'
            END AS mismatch_type
     FROM coverage c
     JOIN products p ON p.id = c.product_id
     LEFT JOIN incoming_by_product i ON i.product_id = c.product_id
     LEFT JOIN outgoing_by_product o ON o.product_id = c.product_id
     LEFT JOIN actual_by_product a ON a.product_id = c.product_id
     WHERE ABS(COALESCE(a.actual_qty, 0) - (COALESCE(i.incoming_qty, 0) - COALESCE(o.outgoing_qty, 0))) > 0.001
     ORDER BY ABS(COALESCE(a.actual_qty, 0) - (COALESCE(i.incoming_qty, 0) - COALESCE(o.outgoing_qty, 0))) DESC,
              c.product_id`,
  );

  const confirmedItemsChecked = Number(
    await queryValue(
      `SELECT COUNT(*)::int AS count
       FROM incoming_items ii
       JOIN incoming_goods ig ON ig.id = ii.incoming_goods_id
       WHERE ig.status = 'confirmed'`,
      0,
    ),
  );

  const linkageMismatches = await queryRows(
    `WITH confirmed_items AS (
       SELECT ig.id AS incoming_goods_id,
              ig.invoice_number,
              ii.id AS incoming_item_id,
              ii.product_id,
              ii.batch_id,
              ii.quantity::numeric(12,3) AS incoming_qty
       FROM incoming_items ii
       JOIN incoming_goods ig ON ig.id = ii.incoming_goods_id
       WHERE ig.status = 'confirmed'
     )
     SELECT ci.incoming_goods_id,
            ci.invoice_number,
            ci.incoming_item_id,
            ci.product_id,
            p.sku,
            p.name_bg,
            ci.batch_id,
            b.product_id AS batch_product_id,
            inv.id AS inventory_row_id,
            COALESCE(inv.quantity, 0)::numeric(12,3) AS inventory_qty,
            ci.incoming_qty,
            CASE
              WHEN ci.batch_id IS NOT NULL AND b.id IS NULL THEN 'incoming_item_points_to_missing_batch'
              WHEN ci.batch_id IS NOT NULL AND b.product_id <> ci.product_id THEN 'batch_product_mismatch'
              WHEN ci.batch_id IS NOT NULL AND inv.id IS NULL THEN 'confirmed_batch_has_no_inventory_row'
            END AS mismatch_type
     FROM confirmed_items ci
     JOIN products p ON p.id = ci.product_id
     LEFT JOIN batches b ON b.id = ci.batch_id
     LEFT JOIN inventory inv
       ON inv.product_id = ci.product_id
      AND inv.batch_id IS NOT DISTINCT FROM ci.batch_id
      AND inv.warehouse_id = 1
     WHERE (ci.batch_id IS NOT NULL AND b.id IS NULL)
        OR (ci.batch_id IS NOT NULL AND b.product_id <> ci.product_id)
        OR (ci.batch_id IS NOT NULL AND inv.id IS NULL)
     ORDER BY ci.incoming_goods_id DESC, ci.incoming_item_id DESC`,
  );

  const batchRowsChecked = Number(
    await queryValue(`SELECT COUNT(*)::int AS count FROM batches`, 0),
  );

  const batchQuantityDrift = await queryRows(
    `SELECT b.id AS batch_id,
            b.delivery_id AS incoming_goods_id,
            b.product_id,
            p.sku,
            p.name_bg,
            b.batch_number,
            b.quantity::numeric(12,3) AS batch_qty,
            COALESCE(SUM(inv.quantity), 0)::numeric(12,3) AS inventory_qty,
            (b.quantity - COALESCE(SUM(inv.quantity), 0))::numeric(12,3) AS delta_qty,
            CASE
              WHEN b.quantity > COALESCE(SUM(inv.quantity), 0) THEN 'batch_higher_than_inventory'
              ELSE 'inventory_higher_than_batch'
            END AS mismatch_type
     FROM batches b
     JOIN products p ON p.id = b.product_id
     LEFT JOIN inventory inv ON inv.batch_id = b.id
     GROUP BY b.id, p.sku, p.name_bg
     HAVING ABS(b.quantity - COALESCE(SUM(inv.quantity), 0)) > 0.001
     ORDER BY ABS(b.quantity - COALESCE(SUM(inv.quantity), 0)) DESC, b.id DESC`,
  );

  const sections: ReconciliationSection[] = [
    {
      key: "product-balance",
      title: "Confirmed incoming minus committed outgoing vs current inventory",
      severity_on_mismatch: "critical",
      rows_checked: productRowsChecked,
      mismatches_found: productBalanceMismatches.length,
      recommended_next_action:
        "Inspect inventory mutation paths for the flagged products; replay confirm/fulfill/cancel flow and verify no duplicate or missing stock mutation occurred.",
      sample_mismatches: productBalanceMismatches.slice(0, samples),
    },
    {
      key: "incoming-linkage",
      title: "Confirmed incoming item linkage to batch/inventory rows",
      severity_on_mismatch: "critical",
      rows_checked: confirmedItemsChecked,
      mismatches_found: linkageMismatches.length,
      recommended_next_action:
        "Repair incoming_items.batch_id or recreate the missing inventory row for the confirmed delivery before the next stock-affecting deployment.",
      sample_mismatches: linkageMismatches.slice(0, samples),
    },
    {
      key: "batch-vs-inventory",
      title: "Batch quantity mirror vs inventory quantity sum",
      severity_on_mismatch: "critical",
      rows_checked: batchRowsChecked,
      mismatches_found: batchQuantityDrift.length,
      recommended_next_action:
        "Backtrace batch quantity edits for the affected delivery IDs; batch.quantity and inventory must move together on confirm, fulfill, and cancel paths.",
      sample_mismatches: batchQuantityDrift.slice(0, samples),
    },
  ];

  const report = buildReport(
    "Reconciliation 1 — Accepted invoices vs stock movements",
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
