// Групи по доставчик (Microinvest, 04.11.2026): доставка от доставчик
// слага в неговата група продуктите, които още нямат група. Групата се
// намира по supplier_id; ако няма — същото име без доставчик се свързва,
// иначе се създава нова. Продукт, вече в група (ръчно), не се мести.
import type pg from "pg";

/** Името на групата: без излишни интервали („FARM KOUKAKIS  S.A.“). */
export function cleanGroupName(value: string | null | undefined): string {
  return String(value ?? "")
    .trim()
    .replace(/\s+/g, " ");
}

type Queryable = Pick<pg.PoolClient, "query">;

async function supplierGroupId(
  client: Queryable,
  supplierId: number,
): Promise<number | null> {
  const linked = await client.query<{ id: number }>(
    "SELECT id FROM product_groups WHERE supplier_id = $1",
    [supplierId],
  );
  if (linked.rows[0]) return linked.rows[0].id;

  const supplier = await client.query<{ name: string | null }>(
    "SELECT name FROM suppliers WHERE id = $1",
    [supplierId],
  );
  const name = cleanGroupName(supplier.rows[0]?.name);
  if (!name) return null;

  // Група със същото име без доставчик → свързва се с него. Сравнява се
  // тук (главни/малки и на кирилица), не с lower() в базата.
  const free = await client.query<{ id: number; name: string }>(
    "SELECT id, name FROM product_groups WHERE supplier_id IS NULL",
  );
  const key = name.toLocaleLowerCase("bg");
  const same = free.rows.find(
    (row) => cleanGroupName(row.name).toLocaleLowerCase("bg") === key,
  );
  if (same) {
    await client.query(
      "UPDATE product_groups SET supplier_id = $1, updated_at = NOW() WHERE id = $2",
      [supplierId, same.id],
    );
    return same.id;
  }

  const created = await client.query<{ id: number }>(
    `INSERT INTO product_groups (name, supplier_id) VALUES ($1, $2)
     ON CONFLICT DO NOTHING
     RETURNING id`,
    [name, supplierId],
  );
  return created.rows[0]?.id ?? null;
}

/**
 * Продуктите без група от доставката → групата на доставчика.
 * Връща колко продукта са получили група.
 */
export async function assignSupplierGroup(
  client: Queryable,
  supplierId: number | null | undefined,
  productIds: Array<number | string | null | undefined>,
): Promise<number> {
  const ids = [
    ...new Set(
      productIds
        .map((id) => Number(id))
        .filter((id) => Number.isInteger(id) && id > 0),
    ),
  ];
  if (!supplierId || ids.length === 0) return 0;

  const ungrouped = await client.query<{ count: number }>(
    `SELECT COUNT(*)::int AS count FROM products
      WHERE id = ANY($1::int[]) AND product_group_id IS NULL`,
    [ids],
  );
  if (!ungrouped.rows[0]?.count) return 0;

  const groupId = await supplierGroupId(client, supplierId);
  if (!groupId) return 0;

  const result = await client.query(
    `UPDATE products SET product_group_id = $1, updated_at = NOW()
      WHERE id = ANY($2::int[]) AND product_group_id IS NULL`,
    [groupId, ids],
  );
  return result.rowCount ?? 0;
}
