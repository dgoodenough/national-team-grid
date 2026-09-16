#!/usr/bin/env python3
"""Render the project's raster images from the built data.

  docs/assets/hero.png            the unfolded sheet, for the README
  docs/assets/og.png              1200x630 share card (og:image / twitter:image)
  docs/assets/apple-touch-icon.png  180x180 home-screen icon

Mirrors the frontend's drawing — same ramp, same ordering, same confederation colours,
all of which are read straight out of docs/style.css so there is exactly one place those
values are written down. Regenerate after any data refresh or re-theme:

    python render_hero.py

Stdlib + Pillow (the only third-party dependency in the project, and only for this file —
build.py itself is stdlib-only).
"""
import json
import math
import re
from pathlib import Path

from PIL import Image, ImageDraw, ImageFont

ROOT = Path(__file__).resolve().parent
DOCS = ROOT / "docs"

CELL, MARGIN, BAND = 4, 26, 10          # px: cell size, label margin, confed strip
CHROME, SHEET, DIAG = "#17191c", "#24272b", "#0d0e10"
GRID_STRONG = "#454a52"

# Fonts, best first. DejaVu ships with Pillow's test suite and with ubuntu-latest, so the
# share card renders identically in CI; the bitmap default is a last resort.
FONT_CANDIDATES = [
    "/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf",
    "/usr/share/fonts/truetype/liberation/LiberationSans-Bold.ttf",
    "/System/Library/Fonts/Supplemental/Arial Bold.ttf",
]
FONT_CANDIDATES_REG = [
    "/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf",
    "/usr/share/fonts/truetype/liberation/LiberationSans-Regular.ttf",
    "/System/Library/Fonts/Supplemental/Arial.ttf",
]


def load_font(size: int, bold: bool = True):
    for path in (FONT_CANDIDATES if bold else FONT_CANDIDATES_REG):
        if Path(path).exists():
            return ImageFont.truetype(path, size)
    return ImageFont.load_default()


def css_vars() -> dict[str, str]:
    """Pull the custom properties out of the stylesheets' :root blocks.

    The confederation colours and the meetings ramp live in the stylesheet because the app
    reads them from there at runtime; parsing them here keeps this script from being a
    second, silently-drifting copy of the palette. tokens.css is read first and style.css
    second, so the app-level aliases win, matching the cascade in the browser."""
    out: dict[str, str] = {}
    for name in ("tokens.css", "style.css"):
        text = (DOCS / name).read_text(encoding="utf-8")
        root = re.search(r":root\s*\{(.*?)\n\}", text, re.S)
        if not root:
            raise SystemExit(f"could not find the :root block in docs/{name}")
        out.update(re.findall(r"(--[\w-]+)\s*:\s*([^;]+);", root.group(1)))
    return out


VARS = css_vars()


def hexrgb(value: str) -> tuple[int, int, int]:
    v = value.strip().lstrip("#")
    return tuple(int(v[i:i + 2], 16) for i in (0, 2, 4))


RAMP = [(stop / 100, hexrgb(VARS[f"--ramp-{stop}"])) for stop in (0, 30, 55, 80, 100)]
CONFED = {c: VARS[f"--confed-{c.lower()}"].strip() for c in
          ("AFC", "CAF", "CONCACAF", "CONMEBOL", "OFC", "UEFA")}


def ramp(t: float) -> tuple[int, int, int]:
    for i in range(1, len(RAMP)):
        if t <= RAMP[i][0]:
            (t0, c0), (t1, c1) = RAMP[i - 1], RAMP[i]
            f = (t - t0) / (t1 - t0)
            return tuple(round(a + (b - a) * f) for a, b in zip(c0, c1))
    return RAMP[-1][1]


def load_sheet():
    """The members in the order the app puts them in, and both archives' meeting counts.

    members.json is written in men's-rank order, but the sheet carries both games, and one
    sheet cannot be sorted by a table it only half uses: the app orders a team by its better
    rank of the two. Re-sort here, or the picture stops matching the site.

    Both halves are read against the busiest fixture in either archive, exactly as the app
    does, so the women's half comes out genuinely paler rather than being flattered by a
    scale of its own."""
    data = json.loads((DOCS / "data/members.json").read_text(encoding="utf-8"))
    confed_order = data["confederation_order"]

    def rank(m):
        rs = [r for r in (m["mens_rank"], m["womens_rank"]) if r is not None]
        return min(rs) if rs else 10 ** 9

    members = sorted(data["members"],
                     key=lambda m: (confed_order.index(m["confed"]), rank(m), m["name"]))
    counts, played, max_count = {}, {}, 1
    for gender in ("men", "women"):
        matrix = json.loads((DOCS / f"data/matrix_{gender}.json").read_text(encoding="utf-8"))
        counts[gender] = {(p[0], p[1]): p[2] for p in matrix["pairs"]}
        played[gender] = len(matrix["pairs"])
        max_count = max(max_count, matrix["max_count"])
    return members, counts, played, max_count


def watermark_ink() -> tuple[int, int, int]:
    """The half-labels, matching the canvas: --ink at 62% over the page ground."""
    c0, c1 = hexrgb(CHROME), hexrgb(VARS["--ink"])
    return tuple(round(a + (b - a) * 0.62) for a, b in zip(c0, c1))


def played_grey(t: float) -> tuple[int, int, int]:
    """Played cell in never-played mode: paper-2 up to ink-3, so the meetings recede.

    Mirrors cellColor() in app.js, which does the same lerp when the highlight is on."""
    c0, c1 = hexrgb(VARS["--paper-2"]), hexrgb(VARS["--ink-3"])
    return tuple(round(a + (b - a) * t) for a, b in zip(c0, c1))


def draw_grid(d: ImageDraw.ImageDraw, members, counts, max_count, ox: int, oy: int,
              cell: int, band: int | None = None, never: bool = False,
              label: bool = False) -> int:
    """Paint the unfolded sheet at (ox, oy). Returns its pixel size.

    Every pairing appears twice in a symmetric matrix, so half the grid was only ever a
    mirror: the men's record goes above the diagonal and the women's below it, which is
    what the site shows on the view it opens on.

    never=True renders that landing view: the pairings that have not happened flood red and
    the ones that have fade to grey, so the picture is of the absence rather than the
    record. label=True adds the crease's two watermarks, which only fit when the whole
    sheet is in frame."""
    max_log = math.log1p(max_count)
    order = [m["id"] for m in members]
    confed = {m["id"]: m["confed"] for m in members}
    n = len(order)
    size = n * cell

    ground = hexrgb(VARS["--never-hi"]) if never else SHEET
    d.rectangle([ox, oy, ox + size, oy + size], fill=ground, outline=GRID_STRONG)
    for r, a in enumerate(order):
        for c, b in enumerate(order):
            if a == b:
                col = DIAG
            else:
                gender = "men" if c > r else "women"
                cnt = counts[gender].get((min(a, b), max(a, b)), 0)
                if not cnt:
                    continue                        # never-played = the ground, already painted
                col = played_grey(math.log1p(cnt) / max_log) if never \
                    else ramp(math.log1p(cnt) / max_log)
            x, y = ox + c * cell, oy + r * cell
            d.rectangle([x, y, x + cell - 1, y + cell - 1], fill=col)

    # The crease. Without a rule down it the two archives read as one noisy square.
    d.line([(ox, oy), (ox + size, oy + size)],
           fill=GRID_STRONG, width=max(1, min(3, round(cell * 0.3))))
    if label:
        pt = max(12, min(58, size // 15))
        font = load_font(pt)
        for text, fx, fy in (("MEN'S", 0.70, 0.28), ("WOMEN'S", 0.30, 0.72)):
            box = d.textbbox((0, 0), text, font=font)
            d.text((ox + size * fx - (box[2] - box[0]) / 2 - box[0],
                    oy + size * fy - (box[3] - box[1]) / 2 - box[1]),
                   text, font=font, fill=watermark_ink(),
                   stroke_width=max(2, pt // 8), stroke_fill=hexrgb(CHROME))

    if band:                                        # confederation strips (top + left)
        font = load_font(max(9, band - 3))
        i = 0
        while i < n:
            j = i
            while j + 1 < n and confed[order[j + 1]] == confed[order[i]]:
                j += 1
            name = confed[order[i]]
            col = CONFED[name]
            x0, x1 = ox + i * cell, ox + (j + 1) * cell - 1
            d.rectangle([x0, oy - band - 2, x1, oy - 3], fill=col)
            d.rectangle([ox - band - 2, oy + i * cell,
                         ox - 3, oy + (j + 1) * cell - 1], fill=col)
            # Name the block when it is wide enough to hold the word. CONMEBOL and OFC
            # are ten and eleven teams wide and never are, which is what the key is for.
            w = d.textlength(name, font=font)
            if w <= (x1 - x0) - 6:
                d.text(((x0 + x1) / 2 - w / 2, oy - band - 1), name,
                       font=font, fill=hexrgb(VARS["--band-strip-ink"]))
            i = j + 1
    return n * cell


def wrap(d: ImageDraw.ImageDraw, text: str, font, width: float) -> list[str]:
    """Greedy-wrap to a pixel width.

    The share card's text column is painted before the copy, so a line that outruns the
    column is not clipped — it lands on the grid. Measuring beats counting characters."""
    lines: list[str] = []
    line = ""
    for word in text.split():
        trial = f"{line} {word}".strip()
        if line and d.textlength(trial, font=font) > width:
            lines.append(line)
            line = word
        else:
            line = trial
    if line:
        lines.append(line)
    return lines


def draw_key(d: ImageDraw.ImageDraw, x: int, y: int, cell: int, order) -> None:
    """One line under the grid saying what the two colours and the strips mean.

    Without it the hero is an attractive abstract: nothing in the picture says the axes are
    countries, or that red is the subject rather than an error."""
    font = load_font(15, bold=False)
    sw = 13
    def chip(x, label, fill, bold=False):
        d.rectangle([x, y + 2, x + sw, y + 2 + sw], fill=fill)
        f = load_font(15, bold=bold)
        d.text((x + sw + 7, y), label, font=f, fill=hexrgb(VARS["--ink-2"]))
        return x + sw + 7 + d.textlength(label, font=f) + 22
    x = chip(x, "never played", hexrgb(VARS["--never-hi"]), bold=True)
    x = chip(x, "have played", played_grey(0.55))
    for name in order:
        x = chip(x, name, CONFED[name].strip())


def render_hero() -> Path:
    members, counts, _played, max_count = load_sheet()
    KEY = 34                                        # strip under the grid for the key
    span = MARGIN + len(members) * CELL + 12
    img = Image.new("RGB", (span, span + KEY), CHROME)
    d = ImageDraw.Draw(img)
    draw_grid(d, members, counts, max_count, MARGIN, MARGIN, CELL, BAND,
              never=True, label=True)
    seen = list(dict.fromkeys(m["confed"] for m in members))
    draw_key(d, MARGIN, span + 4, CELL, seen)
    out = DOCS / "assets/hero.png"
    img.save(out)
    print(f"wrote {out} ({img.width}x{img.height})")
    return out


def render_og() -> Path:
    """1200x630 share card: the headline stat, then the grid it comes from.

    This is what a paste of the URL renders as in Slack, iMessage, Bluesky and the rest —
    the single most-seen view of the project, and until now it was a blank rectangle."""
    W, H = 1200, 630
    members, counts, played, max_count = load_sheet()
    n = len(members)
    possible = n * (n - 1) // 2

    img = Image.new("RGB", (W, H), CHROME)
    d = ImageDraw.Draw(img)

    # Grid on the right, bleeding off three edges so it reads as a fragment of something
    # much bigger than the card.
    PANEL = 596                                     # text column width
    cell = 4
    grid_px = n * cell
    # No watermarks here: the card shows a fragment, and one of the two would fall off it.
    # The crease still runs through the fragment, and the text column says what it divides.
    draw_grid(d, members, counts, max_count, PANEL + 24, (H - grid_px) // 2, cell, never=True)

    # Text column painted over the grid, so a long line can never collide with it.
    d.rectangle([0, 0, PANEL, H], fill=CHROME)
    d.line([(PANEL, 0), (PANEL, H)], fill=hexrgb(GRID_STRONG), width=1)
    x, y = 72, 132
    # Green, because the numeral counts what has happened. It is the same green the grid
    # uses for a played pairing, and it holds up against near-black at thumbnail size.
    column = PANEL - x - 24
    d.text((x, y), f"{played['men']:,}", font=load_font(116),
           fill=hexrgb(VARS["--ramp-100"]))
    y += 132
    head = load_font(38)
    for line in wrap(d, f"men's fixtures played, {played['women']:,} women's", head, column):
        d.text((x, y), line, font=head, fill=(231, 234, 240))
        y += 48
    y += 18
    body = load_font(23, bold=False)
    for line in wrap(d, f"of the {possible:,} possible pairings between FIFA's {n} members "
                        "— men's above the diagonal, women's below. The rest is the picture.",
                     body, column):
        d.text((x, y), line, font=body, fill=(154, 163, 178))
        y += 32

    d.text((x, H - 88), "FIFAGAMI",
           font=load_font(21), fill=hexrgb(VARS["--ramp-100"]))
    # The card gets screenshotted and re-posted without the link it was attached to.
    d.text((x, H - 58), "dgoodenough.github.io/fifagami",
           font=load_font(19, bold=False), fill=hexrgb(VARS["--ink-3"]))

    out = DOCS / "assets/og.png"
    img.save(out)
    print(f"wrote {out} ({img.width}x{img.height}, "
          f"{played['men']:,} men's / {played['women']:,} women's)")
    return out


def render_touch_icon() -> Path:
    """180x180 iOS home-screen icon — the same 4x4 motif as assets/favicon.svg."""
    S, pad, gap = 180, 17, 6
    cell = (S - 2 * pad - 3 * gap) // 4
    img = Image.new("RGB", (S, S), CHROME)
    d = ImageDraw.Draw(img)
    greens = [VARS["--ramp-100"], VARS["--ramp-80"], VARS["--ramp-30"]]
    motif = [[None, 0, "sheet", 1],
             [0, None, 2, "sheet"],
             ["sheet", 2, None, 0],
             [1, "sheet", 0, None]]
    for r in range(4):
        for c in range(4):
            v = motif[r][c]
            col = DIAG if v is None else (SHEET if v == "sheet" else greens[v].strip())
            x, y = pad + c * (cell + gap), pad + r * (cell + gap)
            d.rectangle([x, y, x + cell, y + cell], fill=col)
    out = DOCS / "assets/apple-touch-icon.png"
    img.save(out)
    print(f"wrote {out} ({img.width}x{img.height})")
    return out


def main() -> int:
    (DOCS / "assets").mkdir(parents=True, exist_ok=True)
    render_hero()
    render_og()
    render_touch_icon()
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
