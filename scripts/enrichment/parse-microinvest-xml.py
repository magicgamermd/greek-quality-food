#!/usr/bin/env python3
"""Enrich partners + suppliers с EIK/VAT/city/address от Microinvest XML exports."""
import os, sys, subprocess, json
from collections import defaultdict

SOURCE = "/Users/magic/Projects/greek-foods-platform/microinvest-export"

def parse_xml(path, encoding="cp1251"):
    """Parse pipe-delimited Microinvest "XML" — actually CSV with | sep."""
    parties = {}  # name → {full_name, mol, city, address, vat, eik}
    with open(path, "rb") as fh:
        raw = fh.read()
    text = raw.decode(encoding, errors="replace")
    for line in text.splitlines():
        cols = line.split("|")
        if len(cols) < 12:
            continue
        full_name = cols[6].strip()
        mol = cols[7].strip()
        city = cols[8].strip()
        address = cols[9].strip()
        vat_full = cols[10].strip()
        eik = cols[11].strip()
        if not full_name or not eik:
            continue
        # Prefer first occurrence (sometimes later ones have empty fields)
        if full_name not in parties:
            parties[full_name] = {
                "name": full_name,
                "mol": mol or None,
                "city": city or None,
                "address": address or None,
                "vat_number": vat_full or None,
                "eik": eik or None,
            }
    return parties

def normalize_name(n):
    """Normalize for fuzzy match: uppercase, no punctuation, no extra spaces."""
    n = n.upper()
    for ch in '."\'`,()/\\':
        n = n.replace(ch, " ")
    n = " ".join(n.split())
    # Remove ООД / ЕООД / ET / AD / EAD suffixes for better match
    for suf in [" ЕООД", " ООД", " ЕТ", " АД", " ЕАД", " КД", " КДА"]:
        if n.endswith(suf):
            n = n[: -len(suf)].strip()
    return n

# Parse exports
clients = parse_xml(os.path.join(SOURCE, "PRODAJBIEXPORT.xml"))
suppliers_raw = parse_xml(os.path.join(SOURCE, "DOSTAVKIEXPORT.xml"))
print(f"Clients parsed: {len(clients)}")
print(f"Suppliers parsed: {len(suppliers_raw)}")

# Build name → record map
clients_by_norm = {normalize_name(n): rec for n, rec in clients.items()}
suppliers_by_norm = {normalize_name(n): rec for n, rec in suppliers_raw.items()}

# Output JSON for the SQL UPDATE script
out = {
    "clients_by_norm": clients_by_norm,
    "suppliers_by_norm": suppliers_by_norm,
}
with open("/tmp/enrichment.json", "w", encoding="utf-8") as fh:
    json.dump(out, fh, ensure_ascii=False, indent=2)
print(f"Wrote /tmp/enrichment.json ({len(clients_by_norm)} clients + {len(suppliers_by_norm)} suppliers)")
