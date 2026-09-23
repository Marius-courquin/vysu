#!/usr/bin/env python3
"""Before / after over a shots folder: a triptych page for an agent, a slider page for a human.

    compare.py <shots-dir> [--against <baseline-dir>] [--out <dir>] [--edge 1568] [--rows 2]

A capture `<label>.png` is paired with `<label>-base.png` when `vysu shots --baseline-url` left one
beside it, else with `<against>/<label>.png`, else with `<label>.prev.png`, the capture a `vysu
mshot` under the same label replaced; a capture with no baseline is named and skipped. The
third column is the marked image `<label>-changed.png` diff.py wrote, or the « après » again when
nothing changed. Statuses come from `diff.txt` when it is there, and from the verdicts an mshot
kept in meta.json.

`compare.png` (`compare-1.png`, `compare-2.png`… past `--rows` pairs) is the one to read: three
columns « avant » / « après » / « zones », one row per pair, the page fitted inside `--edge` px on
its long side — a model downsizes past ~1568 px, so a bigger page only costs tokens and never
shows more.

`compare.html` is the one to open: the same pairs as a before/after slider, plus an onion blend
and a zones toggle, in plain HTML/CSS/JS with no CDN and no asset. A baseline living outside the
folder is copied in as `<label>-base.png` first, so the page works from relative paths.
"""

import argparse
import json
import os
import re
import shutil
import sys
from pathlib import Path

from PIL import Image, ImageDraw

sys.path.insert(0, str(Path(__file__).resolve().parent))
import mark  # noqa: E402 — sibling script, reused for its system-font search

BG = (243, 244, 246)
CELL = (255, 255, 255)
LINE = (209, 213, 219)
TEXT = (17, 17, 17)
SOFT = (75, 85, 99)
COLUMNS = ("avant", "après", "zones")
SAME = "zones — identique"


def captures(directory):
    for path in sorted(directory.glob("*.png")):
        if path.name.startswith(("sheet", "compare")) or path.name.endswith(("-changed.png", "-base.png", ".prev.png")):
            continue
        yield path


def statuses(directory):
    """`<label>: <status>` per unindented diff.txt line (the indented ones are the zone detail), then
    the latest verdict an mshot kept in meta.json, which wins: it is the newer of the two."""
    found = {}
    path = directory / "diff.txt"
    for line in path.read_text().splitlines() if path.exists() else []:
        if not line or line[0].isspace() or ": " not in line:
            continue
        label, status = line.split(": ", 1)
        # The pixel count is already in the zone lines: a row caption only needs the headline.
        found[label] = re.sub(r" \(\d+ px\)", "", status.strip())
    try:
        verdicts = json.loads((directory / "meta.json").read_text()).get("verdicts") or {}
    except (OSError, ValueError):
        verdicts = {}
    for label, v in verdicts.items():
        if v.get("vs"):
            found[label] = "vs %s · %s" % (v["vs"], v.get("verdict"))
    return found


def pairs(shots, against):
    found, skipped = [], []
    for current in captures(shots):
        label = current.stem
        base = shots / f"{label}-base.png"
        if not base.exists():
            base = against / f"{label}.png" if against else None
            if base is None or not base.exists():
                base = shots / f"{label}.prev.png"
            if not base.exists():
                skipped.append(label)
                continue
        marked = shots / f"{label}-changed.png"
        found.append((label, base, current, marked if marked.exists() else None))
    return found, skipped


def draw_text(d, xy, text, font, fill, align="lt"):
    """Text placed by its ink box — no font anchor, which the bitmap fallback font refuses."""
    x, y = xy
    x0, y0, x1, y1 = d.textbbox((0, 0), text, font=font)
    if align[0] == "c":
        x -= (x1 - x0) / 2
    d.text((x - x0, y - y0), text, font=font, fill=fill)
    return x1 - x0, y1 - y0


PAD, GAP, ROW_CAP, CELL_CAP = 20, 14, 24, 20


def row_height(sizes, inner):
    return max(round(h * min(1.0, inner / w)) for w, h in sizes)


def measure(rows, width):
    """Column width, per-row image height and page height for a page `width` px wide."""
    col_w = (width - 2 * PAD - 2 * GAP) // 3
    heights = [row_height(sizes, col_w - 2) for sizes in rows]
    total = 2 * PAD + sum(ROW_CAP + h + CELL_CAP + GAP for h in heights) - GAP
    return col_w, heights, total


def compose(page, labels, edge, out):
    """One triptych page: three columns per pair, scaled so the long side stays inside `edge`."""
    sizes = [[Image.open(p).size for p, _ in cells] for cells in page]
    widest = max(w for row in sizes for w, _ in row)
    width = min(edge, 2 * PAD + 2 * GAP + 3 * widest)
    for _ in range(4):
        col_w, heights, total = measure(sizes, width)
        if total <= edge:
            break
        width = max(3 * 120, round(width * edge / total))
    col_w, heights, total = measure(sizes, width)

    im = Image.new("RGB", (width, total), BG)
    d = ImageDraw.Draw(im)
    f_row, f_cell = mark.font(15), mark.font(12)
    y = PAD
    for cells, caption, height in zip(page, labels, heights):
        draw_text(d, (PAD, y), caption, f_row, TEXT)
        y += ROW_CAP
        for index, (path, note) in enumerate(cells):
            x = PAD + index * (col_w + GAP)
            d.rectangle((x, y, x + col_w - 1, y + height - 1), fill=CELL)
            thumb = Image.open(path).convert("RGB")
            scale = min(1.0, (col_w - 2) / thumb.width, (height - 2) / thumb.height)
            if scale < 1.0:
                thumb = thumb.resize((max(1, round(thumb.width * scale)),
                                      max(1, round(thumb.height * scale))), Image.LANCZOS)
            im.paste(thumb, (x + (col_w - thumb.width) // 2, y + (height - thumb.height) // 2))
            d.rectangle((x, y, x + col_w - 1, y + height - 1), outline=LINE)
            draw_text(d, (x + col_w // 2, y + height + 4), note, f_cell, SOFT, align="ct")
        y += height + CELL_CAP + GAP
    im.save(out)
    print(f"{out} {width}x{total}")


HTML_HEAD = """<!doctype html><meta charset="utf-8"><title>compare — %s</title>
<style>
body{margin:0;padding:24px;background:#e5e7eb;font:13px/1.5 system-ui,sans-serif;color:#111}
h1{font-size:15px;margin:0 0 16px}
figure{margin:0 0 24px;background:#f9fafb;border:1px solid #d1d5db;border-radius:8px;padding:12px}
figcaption{margin-bottom:8px;font-variant-numeric:tabular-nums}
.stage{position:relative;overflow:hidden;background:#fff;border:1px solid #d1d5db}
.stage img{display:block;width:100%%;height:auto}
.stage .before{position:absolute;inset:0;width:100%%;height:100%%;object-fit:contain;
  clip-path:inset(0 calc(100%% - var(--x)) 0 0)}
.stage .zones{position:absolute;inset:0;width:100%%;height:100%%;object-fit:contain;
  background:#fff;visibility:hidden}
.stage::after{content:"";position:absolute;top:0;bottom:0;left:var(--x);width:2px;background:#e11d48}
.stage.onion .before{clip-path:none;opacity:var(--o)}
.stage.onion::after{display:none}
.stage.zones .before,.stage.zones::after{display:none}
.stage.zones .zones{visibility:visible}
.bar{display:flex;align-items:center;gap:10px;margin-top:8px}
.bar input{flex:1}
button{font:inherit;padding:3px 10px;border:1px solid #d1d5db;border-radius:6px;background:#fff;cursor:pointer}
button[aria-pressed="true"]{background:#111;color:#fff;border-color:#111}
</style>
<h1>%s — %s</h1>
<script>
function slide(el){const s=el.closest('figure').querySelector('.stage');
  s.style.setProperty('--x',el.value+'%%');s.style.setProperty('--o',el.value/100)}
function mode(btn,name){const f=btn.closest('figure'),s=f.querySelector('.stage');
  const on=!btn.getAttribute('aria-pressed')||btn.getAttribute('aria-pressed')==='false';
  f.querySelectorAll('button').forEach(b=>b.setAttribute('aria-pressed','false'));
  s.classList.remove('onion','zones');
  btn.setAttribute('aria-pressed',on);if(on)s.classList.add(name)}
</script>
"""


def write_html(rows, out, title, subtitle):
    parts = [HTML_HEAD % (title, title, subtitle)]
    for label, caption, before, after, zones in rows:
        parts.append(f'<figure><figcaption>{caption}</figcaption>')
        parts.append('<div class="stage" style="--x:50%;--o:0.5">')
        parts.append(f'<img class="after" src="{after}" alt="{label} après">')
        parts.append(f'<img class="before" src="{before}" alt="{label} avant">')
        if zones:
            parts.append(f'<img class="zones" src="{zones}" alt="{label} zones">')
        parts.append('</div><div class="bar">'
                     '<input type="range" min="0" max="100" value="50" oninput="slide(this)">'
                     '<button aria-pressed="false" onclick="mode(this,\'onion\')">onion</button>')
        if zones:
            parts.append('<button aria-pressed="false" onclick="mode(this,\'zones\')">zones</button>')
        parts.append('</div></figure>')
    out.write_text("\n".join(parts))
    print(out)


def main():
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("shots", type=Path, help="the vysu shots folder to read")
    parser.add_argument("--against", type=Path, help="folder holding the baseline captures")
    parser.add_argument("--out", type=Path, help="where the pages go (default: the shots folder)")
    parser.add_argument("--edge", type=int, default=1568, help="longest side of a page, in px")
    parser.add_argument("--rows", type=int, default=2, help="pairs per page")
    args = parser.parse_args()

    if not args.shots.is_dir():
        sys.exit(f"compare: no shots folder {args.shots}")
    if args.against and not args.against.is_dir():
        sys.exit(f"compare: no baseline folder {args.against}")
    out_dir = args.out or args.shots
    out_dir.mkdir(parents=True, exist_ok=True)

    found, skipped = pairs(args.shots, args.against)
    if skipped:
        print(f"no baseline: {', '.join(skipped)}")
    if not found:
        sys.exit(f"compare: no pair in {args.shots}")

    status = statuses(args.shots)
    copied = 0
    page_rows, html_rows = [], []

    def rel(path):  # the pages may sit outside the shots folder: address the images from there
        return os.path.relpath(path, out_dir)

    for label, base, current, marked in found:
        if base.parent != args.shots:
            # The slider page addresses its images relatively: a baseline from elsewhere moves in.
            base = Path(shutil.copy(base, args.shots / f"{label}-base.png"))
            copied += 1
        caption = f"{label} — {status[label]}" if label in status else label
        page_rows.append((
            [(base, COLUMNS[0]), (current, COLUMNS[1]), (marked or current, COLUMNS[2] if marked else SAME)],
            caption,
        ))
        html_rows.append((label, caption, rel(base), rel(current), rel(marked) if marked else ""))
    if copied:
        print(f"copied {copied} baseline(s) into {args.shots}")

    pages = [page_rows[i:i + args.rows] for i in range(0, len(page_rows), args.rows)]
    for index, page in enumerate(pages, 1):
        name = "compare.png" if len(pages) == 1 else f"compare-{index}.png"
        compose([cells for cells, _ in page], [caption for _, caption in page], args.edge, out_dir / name)

    count = f"{len(found)} paire" + ("s" if len(found) > 1 else "")
    write_html(html_rows, out_dir / "compare.html", args.shots.name, count)


if __name__ == "__main__":
    main()
