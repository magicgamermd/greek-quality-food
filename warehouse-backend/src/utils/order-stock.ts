type DbExecutor = {
  query: (
    text: string,
    params?: any[],
  ) => Promise<{ rows: any[]; rowCount?: number | null }>;
};

// GQF: връща `qty` обратно в наличност по точните партиди, от които е било
// изписано (order_item_batches). Ползва се и при пълно (cancel/credit) и при
// частично възстановяване. Връща колко количество е поето от записаните
// партиди, за да може callerът да fallback-не за остатъка (legacy редове без
// order_item_batches). При delete=true изтрива/намалява consumed редовете.
async function restoreFromBatchAllocations(
  db: DbExecutor,
  orderItemId: number,
  productId: number,
  maxQty: number,
): Promise<number> {
  const { rows: allocations } = await db.query(
    `SELECT id, batch_id, quantity
       FROM order_item_batches
      WHERE order_item_id = $1
      ORDER BY id`,
    [orderItemId],
  );
  if (allocations.length === 0) return 0;

  let remaining = maxQty;
  for (const alloc of allocations) {
    if (remaining <= 0.0001) break;
    const allocQty = parseFloat(alloc.quantity);
    const restoreQty = Math.min(allocQty, remaining);
    if (restoreQty <= 0) continue;

    const restored = await db.query(
      `UPDATE inventory SET quantity = quantity + $1, updated_at = NOW()
         WHERE product_id = $2 AND batch_id = $3 AND warehouse_id = 1`,
      [restoreQty, productId, alloc.batch_id],
    );
    if (!restored.rowCount) {
      await db.query(
        `INSERT INTO inventory (product_id, batch_id, warehouse_id, quantity, updated_at)
         VALUES ($1, $2, 1, $3, NOW())`,
        [productId, alloc.batch_id, restoreQty],
      );
    }
    await db.query(
      "UPDATE batches SET quantity = quantity + $1 WHERE id = $2",
      [restoreQty, alloc.batch_id],
    );

    // Consume the allocation row: namaliava ili iztriva (audit за частичен restore).
    if (restoreQty >= allocQty - 0.0001) {
      await db.query("DELETE FROM order_item_batches WHERE id = $1", [
        alloc.id,
      ]);
    } else {
      await db.query(
        "UPDATE order_item_batches SET quantity = quantity - $1 WHERE id = $2",
        [restoreQty, alloc.id],
      );
    }
    remaining -= restoreQty;
  }
  return maxQty - remaining;
}

// Частичен restore — ползва се от partial credit note flow-а. Приема
// списък от {order_item_id, quantity} и възстановява именно тези
// количества (не цялото количество от реда). Запазва batch_id-то,
// което беше избрано при fulfill, за да върне в правилната партида.
export async function restorePartialItemsToInventory(
  db: DbExecutor,
  items: Array<{ order_item_id: number; quantity: number }>,
) {
  if (items.length === 0) return;
  const orderItemIds = items.map((i) => i.order_item_id);
  const { rows: orderItems } = await db.query(
    `SELECT id, product_id, batch_id, quantity AS original_qty
       FROM order_items
      WHERE id = ANY($1::int[])`,
    [orderItemIds],
  );
  const oiById = new Map<number, any>(orderItems.map((r: any) => [r.id, r]));

  for (const restore of items) {
    const oi = oiById.get(restore.order_item_id);
    if (!oi) continue;
    const qty = restore.quantity;
    if (qty <= 0) continue;
    const orig = parseFloat(oi.original_qty);
    if (qty > orig + 0.0001) {
      throw new Error(
        `restorePartialItemsToInventory: quantity ${qty} exceeds original ${orig} for order_item ${oi.id}`,
      );
    }

    // GQF: предпочитаме точните партиди от order_item_batches. Каквото не е
    // покрито (legacy редове без allocations) се възстановява по стария път.
    const restoredFromBatches = await restoreFromBatchAllocations(
      db,
      oi.id,
      oi.product_id,
      qty,
    );
    const leftover = qty - restoredFromBatches;
    if (leftover <= 0.0001) continue;

    if (oi.batch_id) {
      const restored = await db.query(
        `UPDATE inventory SET quantity = quantity + $1, updated_at = NOW()
         WHERE product_id = $2 AND batch_id = $3 AND warehouse_id = 1`,
        [leftover, oi.product_id, oi.batch_id],
      );
      if (!restored.rowCount) {
        await db.query(
          `INSERT INTO inventory (product_id, batch_id, warehouse_id, quantity, updated_at)
           VALUES ($1, $2, 1, $3, NOW())`,
          [oi.product_id, oi.batch_id, leftover],
        );
      }
      await db.query(
        "UPDATE batches SET quantity = quantity + $1 WHERE id = $2",
        [leftover, oi.batch_id],
      );
    } else {
      const { rows: invRows } = await db.query(
        `SELECT id FROM inventory
         WHERE product_id = $1 AND warehouse_id = 1
         ORDER BY batch_id ASC NULLS FIRST LIMIT 1`,
        [oi.product_id],
      );
      if (invRows.length > 0) {
        await db.query(
          "UPDATE inventory SET quantity = quantity + $1, updated_at = NOW() WHERE id = $2",
          [leftover, invRows[0].id],
        );
      } else {
        await db.query(
          `INSERT INTO inventory (product_id, warehouse_id, quantity, updated_at)
           VALUES ($1, 1, $2, NOW())`,
          [oi.product_id, leftover],
        );
      }
    }
  }
}

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

    // GQF: първо връщаме по точните партиди от order_item_batches. Остатъкът
    // (legacy редове без allocations) минава по стария fallback.
    const restoredFromBatches = await restoreFromBatchAllocations(
      db,
      item.id,
      item.product_id,
      qty,
    );
    const leftover = qty - restoredFromBatches;
    if (leftover <= 0.0001) continue;

    if (item.batch_id) {
      const restored = await db.query(
        `UPDATE inventory SET quantity = quantity + $1, updated_at = NOW()
         WHERE product_id = $2 AND batch_id = $3 AND warehouse_id = 1`,
        [leftover, item.product_id, item.batch_id],
      );

      if (!restored.rowCount) {
        await db.query(
          `INSERT INTO inventory (product_id, batch_id, warehouse_id, quantity, updated_at)
           VALUES ($1, $2, 1, $3, NOW())`,
          [item.product_id, item.batch_id, leftover],
        );
      }

      await db.query(
        "UPDATE batches SET quantity = quantity + $1 WHERE id = $2",
        [leftover, item.batch_id],
      );
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
          [leftover, invRows[0].id],
        );
      } else {
        await db.query(
          `INSERT INTO inventory (product_id, warehouse_id, quantity, updated_at)
           VALUES ($1, 1, $2, NOW())`,
          [item.product_id, leftover],
        );
      }
    }
  }
}
