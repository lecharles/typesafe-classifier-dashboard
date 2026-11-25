#!/usr/bin/env python3
"""Render docs/COMMIT-TRAIN-C.md into public/jev-ledger.html (JEV-only ledger of record)."""
import html
import re
from pathlib import Path

ROOT = Path("/home/hermes/projects/typesafe-classifier-dashboard")
SRC = ROOT / "docs" / "COMMIT-TRAIN-C.md"
OUT = ROOT / "public" / "jev-ledger.html"
COMMIT_BASE = "https://github.com/lecharles/typesafe-classifier-dashboard/commit/"

lines = SRC.read_text().splitlines()

# locate pipe table
rows = []
in_table = False
for ln in lines:
    s = ln.strip()
    if s.startswith("|") and s.endswith("|"):
        cells = [c.strip() for c in s.strip("|").split("|")]
        if all(re.fullmatch(r":?-+:?", c) for c in cells):
            continue  # separator row
        if not in_table:
            header = cells
            in_table = True
        else:
            rows.append(cells)

def link_commits(text: str) -> str:
    esc = html.escape(text)
    return re.sub(
        r"\b([0-9a-f]{7,40})\b",
        lambda m: f'<a class="c" href="{COMMIT_BASE}{m.group(1)}">{m.group(1)[:7]}</a>',
        esc,
    )

body_rows = []
for r in rows:
    r = (r + ["", "", "", "", ""])[:5]
    row_html = "".join(
        f"<td>{link_commits(c)}</td>" if i > 0 else f"<td class='k'>{html.escape(c)}</td>"
        for i, c in enumerate(r)
    )
    status = r[2].upper()
    cls = "ship" if "SHIP" in status else ""
    row_html = row_html.replace(f"<td>{html.escape(r[2])}</td>", f'<td class="st {cls}">{html.escape(r[2])}</td>')
    body_rows.append(f"<tr>{row_html}</tr>")

# notes section (everything after the table)
try:
    idx = lines.index("Notes:")
    notes = "\n".join(lines[idx + 1 :])
except ValueError:
    notes = ""
note_items = [ln[2:] for ln in notes.splitlines() if ln.strip().startswith("- ")]
notes_html = "".join(f"<li>{link_commits(html.escape(n))}</li>" for n in note_items)

doc = f"""<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8"/>
<meta name="viewport" content="width=device-width, initial-scale=1"/>
<title>JEV (Typesafe Classifier) — Roadmap Ledger</title>
<style>
:root {{ color-scheme: dark; }}
body {{ background:#0b0e14; color:#dbe2ee; font:15px/1.6 -apple-system,Segoe UI,Roboto,sans-serif; margin:0; padding:32px 20px; }}
.wrap {{ max-width:1080px; margin:0 auto; }}
h1 {{ font-size:22px; margin:0 0 4px; }}
.sub {{ color:#8b96ab; font-size:13px; margin-bottom:24px; }}
.sub a {{ color:#7aa2ff; }}
table {{ border-collapse:collapse; width:100%; font-size:13.5px; }}
th,td {{ border:1px solid #1e2634; padding:8px 10px; text-align:left; vertical-align:top; }}
th {{ background:#131a26; color:#9fb0c8; position:sticky; top:0; }}
td.k {{ white-space:nowrap; font-weight:600; color:#e8cf8a; }}
td.st {{ white-space:nowrap; }}
.st.ship {{ color:#6fd08c; font-weight:600; }}
a.c {{ color:#7aa2ff; text-decoration:none; font-family:ui-monospace,Menlo,monospace; font-size:12.5px; }}
a.c:hover {{ text-decoration:underline; }}
ul {{ margin:28px 0 0; padding-left:20px; }}
li {{ margin-bottom:14px; color:#aab5c8; font-size:13px; }}
h2 {{ font-size:16px; margin:32px 0 8px; color:#9fb0c8; }}
</style>
</head>
<body>
<div class="wrap">
<h1>JEV (Typesafe Classifier) — Roadmap Ledger</h1>
<div class="sub">Ledger of record for the JEV project only. Source: <a href="{COMMIT_BASE.rstrip('/')}">{COMMIT_BASE.rstrip('/')}</a> · docs/COMMIT-TRAIN-C.md</div>
<table>
<thead><tr><th>Row</th><th>Slice</th><th>Status</th><th>Commit</th><th>Date (PT)</th></tr></thead>
<tbody>
{''.join(body_rows)}
</tbody>
</table>
<h2>Notes</h2>
<ul>
{notes_html}
</ul>
</div>
</body>
</html>
"""
OUT.write_text(doc)
print(f"wrote {OUT} ({len(doc)} bytes, {len(rows)} rows)")
