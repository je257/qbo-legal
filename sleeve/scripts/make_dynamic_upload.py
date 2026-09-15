#!/usr/bin/env python3
"""Generate the YCharts dynamic-portfolio upload file for P:1746345.

Appends a new allocation block (dated today, or --date YYYY-MM-DD) with the
canonical sleeve targets from ../drift-bands.json to the stacked history in
../data/dynamic_upload_history.xlsx, and writes the ready-to-upload file.

After the user uploads the generated file to YCharts, copy it over
data/dynamic_upload_history.xlsx (and commit) so the stored history stays
canonical. Requires: openpyxl.
"""
import json
import sys
from datetime import date, datetime
from pathlib import Path

import openpyxl

HERE = Path(__file__).resolve().parent
HISTORY = HERE.parent / "data" / "dynamic_upload_history.xlsx"
BANDS = HERE.parent / "drift-bands.json"


def main() -> None:
    as_of = date.today()
    for arg in sys.argv[1:]:
        if arg.startswith("--date="):
            as_of = date.fromisoformat(arg.split("=", 1)[1])

    rows = []
    wb = openpyxl.load_workbook(HISTORY, data_only=True)
    for r in wb["Sheet1"].iter_rows(min_row=2, max_col=3, values_only=True):
        d, sym, w = r
        if d is None or sym is None or w is None:
            continue
        rows.append((d.date() if isinstance(d, datetime) else d, str(sym).strip(), float(w)))
    if any(d >= as_of for d, _, _ in rows):
        sys.exit(f"History already contains a block on/after {as_of} — refusing to append out of order.")

    bands = json.load(open(BANDS))
    targets = {t: round(p["sleeveTargetPct"] / 100, 6) for t, p in bands["positions"].items()}
    total = round(sum(targets.values()), 10)
    if abs(total - 1.0) > 1e-9:
        sys.exit(f"Targets sum to {total}, not 1.0 — fix drift-bands.json first.")

    out = openpyxl.Workbook()
    sheet = out.active
    sheet.title = "Sheet1"
    sheet.append(["Date", "Symbol", "Target Weight"])
    for d, sym, w in rows:
        sheet.append([d, sym, w])
    for sym, w in sorted(targets.items(), key=lambda kv: (-kv[1], kv[0])):
        sheet.append([as_of, sym, w])
    for cell in sheet["A"]:
        cell.number_format = "m/d/yyyy"

    dest = HERE.parent / "data" / f"GI_Stock_Sleeve_Dynamic_Update_{as_of}.xlsx"
    out.save(dest)
    print(f"Wrote {dest} — {len(rows)} history rows + {len(targets)} new rows dated {as_of} (sum 1.0).")


if __name__ == "__main__":
    main()
