#!/usr/bin/env bash
# ETL: миграция на партньори / доставчици / продукти / категории /
# обекти на партньори / алиаси от Greek Foods → Greek Quality Food.
#
# Предусловия:
#   - Greek Foods tmp Postgres на host:5435 (restore-нат от backup dump)
#   - Greek Quality Food Postgres на host:5434 (docker compose up)
#   - greek-quality-food миграциите вече са пуснати
#
# Стратегия за избягване на FK violations и schema drift:
#   - Изтичай в правилен ред: warehouses → categories → partners →
#     suppliers → products → aliases → partner_order_objects
#   - На таргета: TRUNCATE CASCADE + RESTART IDENTITY за всяка таблица
#     (запазва users, settings, fiscal config — не ги докосваме)
#   - Пренасяме само intersection-а от колоните (общи между source/target)
#   - Sequences се рестартират автоматично от RESTART IDENTITY

set -euo pipefail

SOURCE_URL="postgres://greekfoods:greekfoods_secret@localhost:5435/greekfoods_warehouse"
TARGET_URL="postgres://greekquality:devpass_gqf@localhost:5434/greekquality_warehouse"

PSQL_SRC=(psql "$SOURCE_URL")
PSQL_TGT=(psql "$TARGET_URL")

echo "==> Проверка на връзките"
"${PSQL_SRC[@]}" -c "SELECT 'source OK', version()" | head -3
"${PSQL_TGT[@]}" -c "SELECT 'target OK', version()" | head -3

# Общи колони (intersection между source и target) — генерираме за
# всяка таблица. Резултат: comma-separated списък.
common_cols() {
  local table="$1"
  "${PSQL_TGT[@]}" -tAc "
    SELECT string_agg(s.column_name, ',' ORDER BY s.ordinal_position)
    FROM information_schema.columns s
    WHERE s.table_schema = 'public' AND s.table_name = '$table'
      AND s.column_name IN (
        SELECT column_name FROM dblink(
          '$SOURCE_URL',
          \$\$SELECT column_name FROM information_schema.columns
             WHERE table_schema='public' AND table_name='$table'\$\$
        ) AS t(column_name TEXT)
      );
  " 2>/dev/null
}

# По-чист fallback: ползваме psql от източника и таргета поотделно
# да добием колоните, и правим intersection в bash.
get_columns() {
  local url="$1"
  local table="$2"
  psql "$url" -tAc "
    SELECT column_name
    FROM information_schema.columns
    WHERE table_schema='public' AND table_name='$table'
    ORDER BY ordinal_position
  "
}

intersect_cols() {
  local table="$1"
  local src tgt
  src=$(get_columns "$SOURCE_URL" "$table" | sort -u)
  tgt=$(get_columns "$TARGET_URL" "$table" | sort -u)
  comm -12 <(echo "$src") <(echo "$tgt") | paste -sd, -
}

migrate_table() {
  local table="$1"
  local cols
  cols=$(intersect_cols "$table")

  if [ -z "$cols" ]; then
    echo "  ⚠ $table: няма общи колони — пропускам"
    return 0
  fi

  echo ""
  echo "==> $table"
  echo "    общи колони: $cols"

  local src_count
  src_count=$("${PSQL_SRC[@]}" -tAc "SELECT count(*) FROM $table")
  echo "    source rows: $src_count"

  echo "    truncating target..."
  "${PSQL_TGT[@]}" -c "TRUNCATE $table RESTART IDENTITY CASCADE" >/dev/null

  echo "    copying..."
  "${PSQL_SRC[@]}" -c "COPY (SELECT $cols FROM $table) TO STDOUT" \
    | "${PSQL_TGT[@]}" -c "COPY $table ($cols) FROM STDIN" >/dev/null

  local tgt_count
  tgt_count=$("${PSQL_TGT[@]}" -tAc "SELECT count(*) FROM $table")
  echo "    target rows: $tgt_count"

  if [ "$src_count" != "$tgt_count" ]; then
    echo "    ✗ MISMATCH"
    return 1
  fi

  # Reset sequence to max(id)+1 to avoid future INSERT collisions.
  local has_id
  has_id=$("${PSQL_TGT[@]}" -tAc "
    SELECT 1 FROM information_schema.columns
    WHERE table_schema='public' AND table_name='$table' AND column_name='id'
    LIMIT 1
  ")
  if [ "$has_id" = "1" ]; then
    "${PSQL_TGT[@]}" -c "
      SELECT setval(pg_get_serial_sequence('$table','id'),
                    COALESCE((SELECT MAX(id) FROM $table), 1),
                    (SELECT MAX(id) IS NOT NULL FROM $table));
    " >/dev/null
  fi
  echo "    ✓ done"
}

echo ""
echo "============================================="
echo "  Greek Foods → Greek Quality Food  ETL"
echo "============================================="

# Order matters: parents → children
migrate_table warehouses
migrate_table categories
migrate_table partners
migrate_table suppliers
migrate_table products
migrate_table product_aliases
migrate_table supplier_aliases
migrate_table partner_order_objects

echo ""
echo "==> ETL приключен"
"${PSQL_TGT[@]}" -c "
SELECT
  (SELECT count(*) FROM partners) AS partners,
  (SELECT count(*) FROM suppliers) AS suppliers,
  (SELECT count(*) FROM products) AS products,
  (SELECT count(*) FROM categories) AS categories,
  (SELECT count(*) FROM warehouses) AS warehouses,
  (SELECT count(*) FROM product_aliases) AS product_aliases,
  (SELECT count(*) FROM supplier_aliases) AS supplier_aliases,
  (SELECT count(*) FROM partner_order_objects) AS partner_objects;
"
