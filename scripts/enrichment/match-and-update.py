#!/usr/bin/env python3
"""Match Microinvest enrichment data + UPDATE production DB."""
import json, subprocess, os

PROD_DB = "postgresql://postgres:dEjxKVuUXfcmwOwkneMSJruzKauFPSdJ@yamabiko.proxy.rlwy.net:41276/railway"
sys_path = os.path.dirname(os.path.realpath(__file__))

with open("/tmp/enrichment.json", "r", encoding="utf-8") as fh:
    data = json.load(fh)

def normalize_name(n):
    n = (n or "").upper()
    for ch in '."\'`,()/\\':
        n = n.replace(ch, " ")
    n = " ".join(n.split())
    for suf in [" ЕООД", " ООД", " ЕТ", " АД", " ЕАД", " КД", " КДА"]:
        if n.endswith(suf):
            n = n[: -len(suf)].strip()
    return n

def fetch_target(table):
    """Get id + name from production DB."""
    out = subprocess.run(
        ["psql", PROD_DB, "-tAc", f"SELECT id || '|' || name FROM {table}"],
        capture_output=True, text=True, check=True
    ).stdout
    rows = []
    for line in out.strip().splitlines():
        if "|" in line:
            pid, name = line.split("|", 1)
            rows.append((int(pid), name))
    return rows

def build_updates(target_rows, source_by_norm, table):
    """Match by normalized name; produce SQL UPDATE statements."""
    sql_lines = []
    matched = 0
    for pid, name in target_rows:
        norm = normalize_name(name)
        rec = source_by_norm.get(norm)
        if not rec:
            # fallback: substring match (only if norm has 5+ chars)
            if len(norm) >= 5:
                for k, v in source_by_norm.items():
                    if norm in k or k in norm:
                        rec = v
                        break
        if not rec:
            continue
        # Build UPDATE statement (escape single quotes)
        def esc(v):
            if v is None: return "NULL"
            return "'" + str(v).replace("'", "''") + "'"
        sets = []
        if rec.get("eik"): sets.append(f"eik = {esc(rec['eik'])}")
        if rec.get("vat_number"): sets.append(f"vat_number = {esc(rec['vat_number'])}")
        if rec.get("city"): sets.append(f"city = {esc(rec['city'])}")
        if rec.get("address"): sets.append(f"address = {esc(rec['address'])}")
        if rec.get("mol"): sets.append(f"contact_person = {esc(rec['mol'])}")
        if not sets:
            continue
        sql_lines.append(f"UPDATE {table} SET {', '.join(sets)} WHERE id = {pid};")
        matched += 1
    print(f"  {table}: {matched}/{len(target_rows)} matched")
    return sql_lines

partners = fetch_target("partners")
suppliers = fetch_target("suppliers")

clients_norm = data["clients_by_norm"]
suppliers_norm = data["suppliers_by_norm"]

# Some clients in Microinvest may correspond to suppliers in our DB
# and vice versa — match both ways for better coverage.
all_norm = {**clients_norm, **suppliers_norm}

print("Building UPDATE statements...")
sql_parts = []
sql_parts += build_updates(partners, all_norm, "partners")
sql_parts += build_updates(suppliers, all_norm, "suppliers")

# Write SQL file
with open("/tmp/enrichment.sql", "w", encoding="utf-8") as fh:
    fh.write("BEGIN;\n")
    fh.write("\n".join(sql_parts))
    fh.write("\nCOMMIT;\n")
print(f"\nWrote /tmp/enrichment.sql with {len(sql_parts)} UPDATEs")
