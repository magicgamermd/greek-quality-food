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

const PARTNER_PRICE_CASE = `CASE COALESCE(ro.price_group, 'Цена на едро')
  WHEN 'Цена на дребно' THEN COALESCE(ro.retail_price, ro.selling_price)
  WHEN 'Ценова група 1' THEN COALESCE(ro.price_group_1, ro.selling_price)
  WHEN 'Ценова група 2' THEN COALESCE(ro.price_group_2, ro.selling_price)
  WHEN 'Ценова група 3' THEN COALESCE(ro.price_group_3, ro.selling_price)
  WHEN 'Ценова група 4' THEN COALESCE(ro.price_group_4, ro.selling_price)
  WHEN 'Ценова група 5' THEN COALESCE(ro.price_group_5, ro.selling_price)
  WHEN 'Ценова група 6' THEN COALESCE(ro.price_group_6, ro.selling_price)
  WHEN 'Ценова група 7' THEN COALESCE(ro.price_group_7, ro.selling_price)
  WHEN 'Ценова група 8' THEN COALESCE(ro.price_group_8, ro.selling_price)
  ELSE ro.selling_price
END`;

async function main() {
  const samples = sampleLimit();

  const purchaseRowsChecked = Number(
    await queryValue(
      `SELECT COUNT(*)::int AS count
       FROM (
         SELECT DISTINCT ON (ii.product_id) ii.product_id
         FROM incoming_items ii
         JOIN incoming_goods ig ON ig.id = ii.incoming_goods_id
         WHERE ig.status = 'confirmed' AND ii.unit_price > 0
         ORDER BY ii.product_id,
                  COALESCE(ig.invoice_date, DATE(ig.updated_at), DATE(ig.created_at)) DESC,
                  ig.id DESC,
                  ii.id DESC
       ) latest`,
      0,
    ),
  );

  const purchaseDrift = await queryRows(
    `WITH latest_incoming AS (
       SELECT DISTINCT ON (ii.product_id)
              ii.product_id,
              ig.id AS incoming_goods_id,
              ig.invoice_number,
              COALESCE(ig.invoice_date, DATE(ig.updated_at), DATE(ig.created_at)) AS source_date,
              ii.unit_price::numeric(12,4) AS latest_unit_price
       FROM incoming_items ii
       JOIN incoming_goods ig ON ig.id = ii.incoming_goods_id
       WHERE ig.status = 'confirmed' AND ii.unit_price > 0
       ORDER BY ii.product_id,
                COALESCE(ig.invoice_date, DATE(ig.updated_at), DATE(ig.created_at)) DESC,
                ig.id DESC,
                ii.id DESC
     )
     SELECT p.id AS product_id,
            p.sku,
            p.name_bg,
            p.purchase_price::numeric(12,4) AS master_purchase_price,
            li.latest_unit_price,
            (COALESCE(p.purchase_price, 0) - li.latest_unit_price)::numeric(12,4) AS delta_price,
            li.incoming_goods_id,
            li.invoice_number,
            li.source_date,
            'purchase_price_drift_from_latest_confirmed_incoming' AS mismatch_type
     FROM latest_incoming li
     JOIN products p ON p.id = li.product_id
     WHERE ABS(COALESCE(p.purchase_price, 0) - li.latest_unit_price) > 0.01
     ORDER BY ABS(COALESCE(p.purchase_price, 0) - li.latest_unit_price) DESC, p.id DESC`,
  );

  const stockedProductsChecked = Number(
    await queryValue(
      `SELECT COUNT(*)::int AS count
       FROM (
         SELECT p.id
         FROM products p
         LEFT JOIN inventory inv ON inv.product_id = p.id
         GROUP BY p.id
         HAVING COALESCE(SUM(inv.quantity), 0) > 0
       ) stocked`,
      0,
    ),
  );

  const inventorySurfaceDrift = await queryRows(
    `WITH inventory_surface AS (
       SELECT p.id AS product_id,
              MAX(p.purchase_price)::numeric(12,4) AS surfaced_purchase_price,
              MAX(p.selling_price)::numeric(12,4) AS surfaced_selling_price,
              MAX(p.retail_price)::numeric(12,4) AS surfaced_retail_price,
              MAX(p.price_group_1)::numeric(12,4) AS surfaced_price_group_1,
              MAX(p.price_group_2)::numeric(12,4) AS surfaced_price_group_2
       FROM products p
       LEFT JOIN inventory inv ON inv.product_id = p.id
       GROUP BY p.id
       HAVING COALESCE(SUM(inv.quantity), 0) > 0
     )
     SELECT p.id AS product_id,
            p.sku,
            p.name_bg,
            p.purchase_price::numeric(12,4) AS master_purchase_price,
            s.surfaced_purchase_price,
            p.selling_price::numeric(12,4) AS master_selling_price,
            s.surfaced_selling_price,
            p.retail_price::numeric(12,4) AS master_retail_price,
            s.surfaced_retail_price,
            'inventory_surface_projection_drift' AS mismatch_type
     FROM inventory_surface s
     JOIN products p ON p.id = s.product_id
     WHERE COALESCE(p.purchase_price, 0) IS DISTINCT FROM COALESCE(s.surfaced_purchase_price, 0)
        OR COALESCE(p.selling_price, 0) IS DISTINCT FROM COALESCE(s.surfaced_selling_price, 0)
        OR COALESCE(p.retail_price, 0) IS DISTINCT FROM COALESCE(s.surfaced_retail_price, 0)
        OR COALESCE(p.price_group_1, 0) IS DISTINCT FROM COALESCE(s.surfaced_price_group_1, 0)
        OR COALESCE(p.price_group_2, 0) IS DISTINCT FROM COALESCE(s.surfaced_price_group_2, 0)
     ORDER BY p.id DESC`,
  );

  const recentOrderItemsChecked = Number(
    await queryValue(
      `SELECT COUNT(*)::int AS count
       FROM order_items oi
       JOIN orders o ON o.id = oi.order_id
       WHERE o.created_at >= NOW() - INTERVAL '30 days'
         AND o.status IN ('pending', 'confirmed', 'processing', 'fulfilled', 'invoiced')`,
      0,
    ),
  );

  const recentOrderPriceDrift = await queryRows(
    `WITH recent_orders AS (
       SELECT o.id AS order_id,
              o.partner_id,
              o.created_at,
              oi.id AS order_item_id,
              oi.product_id,
              oi.unit_price::numeric(12,4) AS stored_unit_price,
              partner.name AS partner_name,
              partner.price_group,
              partner.price_list_id,
              p.sku,
              p.name_bg,
              p.selling_price::numeric(12,4) AS selling_price,
              p.retail_price::numeric(12,4) AS retail_price,
              p.price_group_1::numeric(12,4) AS price_group_1,
              p.price_group_2::numeric(12,4) AS price_group_2,
              p.price_group_3::numeric(12,4) AS price_group_3,
              p.price_group_4::numeric(12,4) AS price_group_4,
              p.price_group_5::numeric(12,4) AS price_group_5,
              p.price_group_6::numeric(12,4) AS price_group_6,
              p.price_group_7::numeric(12,4) AS price_group_7,
              p.price_group_8::numeric(12,4) AS price_group_8,
              pli.price::numeric(12,4) AS partner_price
       FROM order_items oi
       JOIN orders o ON o.id = oi.order_id
       JOIN partners partner ON partner.id = o.partner_id
       JOIN products p ON p.id = oi.product_id
       LEFT JOIN price_list_items pli
         ON pli.price_list_id = partner.price_list_id
        AND pli.product_id = oi.product_id
       WHERE o.created_at >= NOW() - INTERVAL '30 days'
         AND o.status IN ('pending', 'confirmed', 'processing', 'fulfilled', 'invoiced')
     )
     SELECT ro.order_id,
            ro.order_item_id,
            ro.partner_id,
            ro.partner_name,
            ro.product_id,
            ro.sku,
            ro.name_bg,
            ro.price_group,
            ro.price_list_id,
            ro.stored_unit_price,
            COALESCE(ro.partner_price, ${PARTNER_PRICE_CASE}, 0)::numeric(12,4) AS current_visible_price,
            (ro.stored_unit_price - COALESCE(ro.partner_price, ${PARTNER_PRICE_CASE}, 0))::numeric(12,4) AS delta_price,
            CASE
              WHEN ro.partner_price IS NOT NULL THEN 'recent_order_price_list_drift'
              WHEN ${PARTNER_PRICE_CASE} IS DISTINCT FROM ro.selling_price THEN 'recent_order_price_group_drift'
              ELSE 'recent_order_selling_price_drift'
            END AS mismatch_type
     FROM recent_orders ro
     WHERE ABS(ro.stored_unit_price - COALESCE(ro.partner_price, ${PARTNER_PRICE_CASE}, 0)) > 0.01
     ORDER BY ABS(ro.stored_unit_price - COALESCE(ro.partner_price, ${PARTNER_PRICE_CASE}, 0)) DESC,
              ro.order_id DESC,
              ro.order_item_id DESC`,
  );

  const sections: ReconciliationSection[] = [
    {
      key: "purchase-vs-latest-incoming",
      title: "Master purchase price vs latest confirmed incoming price",
      severity_on_mismatch: "critical",
      rows_checked: purchaseRowsChecked,
      mismatches_found: purchaseDrift.length,
      recommended_next_action:
        "Inspect the incoming confirm path or later product edits for the flagged SKUs; purchase_price should reflect the latest accepted incoming unit_price unless deliberately overridden.",
      sample_mismatches: purchaseDrift.slice(0, samples),
    },
    {
      key: "inventory-surface",
      title: "Master prices vs inventory-visible price projection",
      severity_on_mismatch: "critical",
      rows_checked: stockedProductsChecked,
      mismatches_found: inventorySurfaceDrift.length,
      recommended_next_action:
        "If any rows appear, the inventory projection is stale or aliasing the wrong fields and should be fixed immediately before operators see wrong prices.",
      sample_mismatches: inventorySurfaceDrift.slice(0, samples),
    },
    {
      key: "recent-order-resolution",
      title: "Stored recent order prices vs current operational resolution chain",
      severity_on_mismatch: "warning",
      rows_checked: recentOrderItemsChecked,
      mismatches_found: recentOrderPriceDrift.length,
      recommended_next_action:
        "Review whether the flagged differences are expected historical price changes or unintended drift between current visible prices and stored operational documents.",
      sample_mismatches: recentOrderPriceDrift.slice(0, samples),
    },
  ];

  const report = buildReport(
    "Reconciliation 3 — Product master prices vs visible operational prices",
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
