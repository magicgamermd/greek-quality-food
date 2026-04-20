type DbExecutor = {
  query: (
    text: string,
    params?: any[],
  ) => Promise<{ rows: any[]; rowCount?: number | null }>;
};

export async function restoreOrderItemsToInventory(
  db: DbExecutor,
  orderId: number,
) {
  const { rows: items } = await db.query(
    "SELECT * FROM order_items WHERE order_id = $1",
    [orderId],
  );

  for (const item of items) {
    const qty = parseFloat(item.quantity);
    if (qty <= 0) continue;

    if (item.batch_id) {
      const restored = await db.query(
        `UPDATE inventory SET quantity = quantity + $1, updated_at = NOW()
         WHERE product_id = $2 AND batch_id = $3 AND warehouse_id = 1`,
        [qty, item.product_id, item.batch_id],
      );

      if (!restored.rowCount) {
        await db.query(
          `INSERT INTO inventory (product_id, batch_id, warehouse_id, quantity, updated_at)
           VALUES ($1, $2, 1, $3, NOW())`,
          [item.product_id, item.batch_id, qty],
        );
      }

      await db.query("UPDATE batches SET quantity = quantity + $1 WHERE id = $2", [
        qty,
        item.batch_id,
      ]);
    } else {
      const { rows: invRows } = await db.query(
        `SELECT id FROM inventory
         WHERE product_id = $1 AND warehouse_id = 1
         ORDER BY batch_id ASC NULLS FIRST LIMIT 1`,
        [item.product_id],
      );

      if (invRows.length > 0) {
        await db.query(
          "UPDATE inventory SET quantity = quantity + $1, updated_at = NOW() WHERE id = $2",
          [qty, invRows[0].id],
        );
      } else {
        await db.query(
          `INSERT INTO inventory (product_id, warehouse_id, quantity, updated_at)
           VALUES ($1, 1, $2, NOW())`,
          [item.product_id, qty],
        );
      }
    }
  }
}
