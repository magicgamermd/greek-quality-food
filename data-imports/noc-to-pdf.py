#!/usr/bin/env python3
"""Render produkti-noc-only.csv to a landscape A4 PDF table."""
import csv
import subprocess
from pathlib import Path

CSV  = Path("/Users/magic/Projects/mert-m/data-imports/produkti-noc-only.csv")
HTML = Path("/Users/magic/Projects/mert-m/data-imports/produkti-noc-only.html")
PDF  = Path("/Users/magic/Projects/mert-m/data-imports/produkti-noc-only.pdf")

with CSV.open(encoding="utf-8") as f:
    rows = list(csv.reader(f))
header, data = rows[0], rows[1:]

# Build minimal HTML
def cell(s, klass=""):
    s_escaped = (s.replace("&", "&amp;").replace("<", "&lt;").replace(">", "&gt;"))
    return f"<td class='{klass}'>{s_escaped}</td>"

def row_html(row):
    sku, mi_code, name, unit, unit_raw, qty, p1, p2, p3 = row
    return (
        "<tr>"
        + cell(sku, "sku")
        + cell(name, "name")
        + cell(unit, "unit")
        + cell(unit_raw, "unit_raw")
        + cell(qty, "num")
        + cell(p1, "num")
        + cell(p2, "num")
        + cell(p3, "num")
        + "</tr>"
    )

body_rows = "\n".join(row_html(r) for r in data)

html = f"""<!DOCTYPE html>
<html lang="bg">
<head>
<meta charset="utf-8">
<title>NOC-only продукти ({len(data)})</title>
<style>
@page {{ size: A4 landscape; margin: 10mm; }}
body {{ font-family: 'Helvetica', 'Arial', sans-serif; font-size: 8pt; }}
h1 {{ font-size: 12pt; margin: 0 0 6pt 0; }}
.subtitle {{ font-size: 9pt; color: #555; margin-bottom: 6pt; }}
table {{ border-collapse: collapse; width: 100%; }}
th, td {{ border: 0.3pt solid #ccc; padding: 2pt 4pt; vertical-align: top; }}
th {{ background: #eee; font-weight: bold; text-align: left; }}
.sku {{ font-family: monospace; white-space: nowrap; }}
.name {{ max-width: 90mm; }}
.unit, .unit_raw {{ text-align: center; white-space: nowrap; }}
.num {{ text-align: right; font-variant-numeric: tabular-nums; white-space: nowrap; }}
tr:nth-child(even) td {{ background: #fafafa; }}
</style>
</head>
<body>
<h1>NOC-only продукти</h1>
<div class="subtitle">{len(data)} продукта без Microinvest код от ПРОДУКТИ.txt — 2026-04-29</div>
<table>
<thead>
<tr>
  <th>SKU</th><th>Име</th><th>Мярка</th><th>Оригинал</th>
  <th>Кол.</th><th>Доставна</th><th>Цена дребно</th><th>Цена едро</th>
</tr>
</thead>
<tbody>
{body_rows}
</tbody>
</table>
</body>
</html>"""

HTML.write_text(html, encoding="utf-8")
print(f"html: {HTML}")

subprocess.run(["weasyprint", str(HTML), str(PDF)], check=True)
print(f"pdf:  {PDF}")
