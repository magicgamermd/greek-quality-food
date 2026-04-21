import "dotenv/config";
import { Pool } from "pg";
import fs from "node:fs";
import path from "node:path";

const EUR_TO_BGN = 1.95583;
const MERTBG_UA =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36";

type StoreProduct = {
  id: number;
  name: string;
  sku: string | null;
  description?: string;
  short_description?: string;
  prices: {
    price: string;
    currency_code: string;
    currency_minor_unit: number;
  };
  images?: Array<{ src: string; thumbnail?: string }>;
  categories?: Array<{ id: number; name: string; slug: string }>;
};

type StoreCategory = {
  id: number;
  name: string;
  slug: string;
  parent: number;
  count: number;
};

async function fetchJson<T>(url: string): Promise<T> {
  const r = await fetch(url, { headers: { "User-Agent": MERTBG_UA } });
  if (!r.ok) throw new Error(`${url} → HTTP ${r.status}`);
  return r.json() as Promise<T>;
}

async function loadCatalog(): Promise<{
  products: StoreProduct[];
  categories: StoreCategory[];
}> {
  const cacheDir = "/tmp/mertm_import";
  const pPath = path.join(cacheDir, "products.json");
  const cPath = path.join(cacheDir, "cats.json");

  let products: StoreProduct[];
  let categories: StoreCategory[];

  if (fs.existsSync(pPath) && fs.existsSync(cPath)) {
    console.log("Using cached catalog from /tmp/mertm_import/");
    products = JSON.parse(fs.readFileSync(pPath, "utf-8"));
    categories = JSON.parse(fs.readFileSync(cPath, "utf-8"));
  } else {
    console.log("Fetching catalog from mert.bg...");
    const pages: StoreProduct[][] = [];
    for (let page = 1; page <= 5; page++) {
      const batch = await fetchJson<StoreProduct[]>(
        `https://mert.bg/wp-json/wc/store/v1/products?per_page=100&page=${page}`,
      );
      if (!batch.length) break;
      pages.push(batch);
      if (batch.length < 100) break;
    }
    products = pages.flat();
    categories = await fetchJson<StoreCategory[]>(
      "https://mert.bg/wp-json/wc/store/v1/products/categories?per_page=100",
    );
  }

  console.log(
    `Loaded ${products.length} products, ${categories.length} categories`,
  );
  return { products, categories };
}

function stripHtml(s: string | undefined): string {
  if (!s) return "";
  return s
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/\s+/g, " ")
    .trim();
}

function eurCentsToBgn(cents: string): number {
  const eur = parseInt(cents, 10) / 100;
  return Math.round(eur * EUR_TO_BGN * 100) / 100;
}

function skuFor(p: StoreProduct): string {
  if (p.sku && p.sku.trim()) return p.sku.trim().slice(0, 50);
  return `MBG-${p.id}`;
}

function topLevelOf(
  catId: number,
  byId: Map<number, StoreCategory>,
): StoreCategory | null {
  const seen = new Set<number>();
  let cur: StoreCategory | undefined = byId.get(catId);
  while (cur && cur.parent !== 0 && !seen.has(cur.id)) {
    seen.add(cur.id);
    cur = byId.get(cur.parent);
  }
  return cur && cur.parent === 0 ? cur : null;
}

async function main() {
  const pool = new Pool({
    connectionString: process.env.DATABASE_URL,
  });

  try {
    const { products, categories } = await loadCatalog();

    const catById = new Map(categories.map((c) => [c.id, c]));
    const topLevels = categories.filter(
      (c) => c.parent === 0 && c.count > 0 && c.slug !== "bez-kategoriya",
    );

    console.log(`\nTop-level categories to insert (${topLevels.length}):`);
    for (const c of topLevels) {
      console.log(`  ${c.name} (${c.count} products)`);
    }

    const client = await pool.connect();
    try {
      await client.query("BEGIN");

      console.log("\n--- Clearing existing products/inventory/categories ---");
      await client.query("DELETE FROM inventory");
      await client.query("DELETE FROM products");
      await client.query("DELETE FROM categories");
      await client.query("ALTER SEQUENCE categories_id_seq RESTART WITH 1");
      await client.query("ALTER SEQUENCE products_id_seq RESTART WITH 1");
      await client.query("ALTER SEQUENCE inventory_id_seq RESTART WITH 1");

      const mertCatIdToDbId = new Map<number, number>();
      console.log("\n--- Inserting categories ---");
      for (const c of topLevels) {
        const r = await client.query<{ id: number }>(
          "INSERT INTO categories (name_bg, name_en) VALUES ($1, $2) RETURNING id",
          [c.name, c.name],
        );
        mertCatIdToDbId.set(c.id, r.rows[0].id);
      }

      const warehouseId = 1;
      console.log("\n--- Inserting products + inventory ---");
      let inserted = 0;
      let skipped = 0;
      const seenSkus = new Set<string>();

      for (const p of products) {
        const sku = skuFor(p);
        if (seenSkus.has(sku)) {
          skipped++;
          continue;
        }
        seenSkus.add(sku);

        const firstCat = p.categories?.[0];
        let dbCategoryId: number | null = null;
        if (firstCat) {
          const top = topLevelOf(firstCat.id, catById);
          if (top) dbCategoryId = mertCatIdToDbId.get(top.id) ?? null;
        }

        const selling = eurCentsToBgn(p.prices.price);
        if (selling <= 0) {
          skipped++;
          continue;
        }
        const purchase = Math.round(selling * 0.7 * 100) / 100;
        const image = p.images?.[0]?.src ?? null;
        const desc = stripHtml(p.short_description || p.description);
        const nameBg = p.name.trim().slice(0, 255);

        const r = await client.query<{ id: number }>(
          `INSERT INTO products
           (name_bg, name_en, sku, category_id, unit, description, image_url,
            purchase_price, selling_price, retail_price, is_active)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $9, true)
           RETURNING id`,
          [
            nameBg,
            nameBg,
            sku,
            dbCategoryId,
            "бр.",
            desc || null,
            image,
            purchase,
            selling,
          ],
        );
        const productId = r.rows[0].id;

        const qty =
          selling < 100 ? 20 : selling < 500 ? 10 : selling < 2000 ? 5 : 2;
        await client.query(
          `INSERT INTO inventory (product_id, warehouse_id, quantity) VALUES ($1, $2, $3)`,
          [productId, warehouseId, qty],
        );

        inserted++;
      }

      await client.query("COMMIT");
      console.log(`\n✓ Inserted ${inserted} products, skipped ${skipped}`);
      console.log(`✓ Inserted ${topLevels.length} categories`);
      console.log(`✓ Inventory rows created in warehouse #${warehouseId}`);
    } catch (e) {
      await client.query("ROLLBACK");
      throw e;
    } finally {
      client.release();
    }

    console.log("\n--- Final counts ---");
    const counts = await pool.query<{
      products: string;
      inventory: string;
      categories: string;
    }>(`
      SELECT
        (SELECT COUNT(*) FROM products)::text AS products,
        (SELECT COUNT(*) FROM inventory)::text AS inventory,
        (SELECT COUNT(*) FROM categories)::text AS categories
    `);
    console.log(counts.rows[0]);
  } finally {
    await pool.end();
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
