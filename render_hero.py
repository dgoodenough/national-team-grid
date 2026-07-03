#!/usr/bin/env python3
"""Render docs/assets/hero.png — the men's grid in the Ledger dark palette.
Mirrors the frontend's drawing (same ramp, same ordering) so the README screenshot
can be regenerated headlessly after any data refresh or re-theme. Stdlib + Pillow."""
import json
import math
from pathlib import Path

from PIL import Image, ImageDraw

DOCS = Path(__file__).resolve().parent / "docs"

CELL, MARGIN, BAND = 4, 26, 10          # px: cell size, label margin, confed strip
CHROME, SHEET, DIAG = "#17191c", "#24272b", "#0d0e10"
GRID_STRONG = "#454a52"
RAMP = [(0.00, (38, 60, 48)), (0.30, (43, 90, 61)), (0.55, (46, 125, 79)),
        (0.80, (58, 169, 103)), (1.00, (79, 214, 136))]
CONFED = {"AFC": "#e0524d", "CAF": "#37b98a", "CONCACAF": "#e6b54a",
          "CONMEBOL": "#4f8fd0", "OFC": "#b07a52", "UEFA": "#9a6ad6"}


def ramp(t):
    for i in range(1, len(RAMP)):
        if t <= RAMP[i][0]:
            (t0, c0), (t1, c1) = RAMP[i - 1], RAMP[i]
            f = (t - t0) / (t1 - t0)
            return tuple(round(a + (b - a) * f) for a, b in zip(c0, c1))
    return RAMP[-1][1]


def main():
    members = json.loads((DOCS / "data/members.json").read_text(encoding="utf-8"))["members"]
    matrix = json.loads((DOCS / "data/matrix_men.json").read_text(encoding="utf-8"))
    counts = {(p[0], p[1]): p[2] for p in matrix["pairs"]}
    max_log = math.log1p(matrix["max_count"])
    order = [m["id"] for m in members]              # members.json is pre-sorted confed+rank
    confed = {m["id"]: m["confed"] for m in members}
    n = len(order)

    size = MARGIN + n * CELL + 12
    img = Image.new("RGB", (size, size), CHROME)
    d = ImageDraw.Draw(img)

    ox = oy = MARGIN
    d.rectangle([ox, oy, ox + n * CELL, oy + n * CELL], fill=SHEET, outline=GRID_STRONG)
    for r, a in enumerate(order):
        for c, b in enumerate(order):
            x, y = ox + c * CELL, oy + r * CELL
            if a == b:
                col = DIAG
            else:
                k = (min(a, b), max(a, b))
                cnt = counts.get(k, 0)
                if not cnt:
                    continue                        # never-played = the sheet
                col = ramp(math.log1p(cnt) / max_log)
            d.rectangle([x, y, x + CELL - 1, y + CELL - 1], fill=col)

    # confederation strips (top + left)
    i = 0
    while i < n:
        j = i
        while j + 1 < n and confed[order[j + 1]] == confed[order[i]]:
            j += 1
        col = CONFED[confed[order[i]]]
        d.rectangle([ox + i * CELL, oy - BAND - 2, ox + (j + 1) * CELL - 1, oy - 3], fill=col)
        d.rectangle([ox - BAND - 2, oy + i * CELL, ox - 3, oy + (j + 1) * CELL - 1], fill=col)
        i = j + 1

    out = DOCS / "assets/hero.png"
    img.save(out)
    print(f"wrote {out} ({img.width}x{img.height})")


if __name__ == "__main__":
    main()
