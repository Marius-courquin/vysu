#!/usr/bin/env python3
"""Contact sheets of a shots folder: the PNG an agent reads back, and index.html for a human.

    sheet.py <shots-dir> [--name <title>] [--cols N] [--max 6] [--edge 1568]
             [--only "<glob>[,<glob>…]"] [--strip]

A model downsizes an image past a 1568 px long edge (then ≈ w×h/750 tokens), so a page bigger than
that square only costs tokens and shows less: every page is composed to fit inside `--edge`, and a
thumbnail is never blown up past its own pixels. A grid page picks its column count for the largest
thumbnails that fit (six phone captures: three columns, two rows, one page); past `--max` captures
the folder is split into pages of even size. `sheet.png` (`sheet-1.png`, `sheet-2.png`…) plus
`index.html`, which holds the same captures at full size.

`--strip` is one row instead, every capture at the same scale so a before and an after line up:
`sheet-strip.png`. It leaves the grid pages and index.html alone.

Picked by default: every capture, in the order they were taken, a `-base.png` next to its current.
Left out: sheets, compare pages, a marked diff (`-changed.png`) and the capture an mshot replaced
(`.prev.png`): they are read on their own. `--only` picks captures by file name instead, in the
order of its globs (then by time within one glob); a glob reaches a `.prev.png` or a `-changed.png`
only when it spells it (`*.prev.png`, `*-changed.png`), so `android-home*` stays the captures.

Composed with Pillow rather than rendered by a browser: nothing to wait for, no blank page when an
image loads late, and no browser session to share with other agents.
"""

import argparse
import fnmatch
import html
import math
import os
import sys
import time
from pathlib import Path

from PIL import Image, ImageDraw

sys.path.insert(0, str(Path(__file__).resolve().parent))
import mark  # noqa: E402 (a sibling script, reused for its system-font search)

BG = (243, 244, 246)
CELL = (255, 255, 255)
LINE = (209, 213, 219)
TEXT = (17, 17, 17)
SOFT = (75, 85, 99)
PAD, GAP, HEAD, CAP = 16, 12, 30, 20  # page margin, gutter, title line, caption line under a thumbnail


def side_file(name):
    """'prev' or 'changed' for the files a sheet leaves out unless a glob names them."""
    if name.endswith(".prev.png"):
        return "prev"
    if name.endswith("-changed.png"):
        return "changed"
    return None


def candidates(directory):
    # A leading dot is a capture in flight (mshot writes `.<label>.new.png` before it renames it).
    return [f for f in os.listdir(directory)
            if f.endswith(".png") and not f.startswith((".", "sheet", "compare"))
            and os.path.isfile(os.path.join(directory, f))]


def mtime(directory, name):
    return os.path.getmtime(os.path.join(directory, name))


def pick(directory, only):
    files = candidates(directory)
    if only:
        order = []
        for glob in only:
            hits = [f for f in files if fnmatch.fnmatchcase(f, glob)
                    and (side_file(f) is None or side_file(f) in glob) and f not in order]
            order += sorted(hits, key=lambda f: mtime(directory, f))
        return order
    files = sorted((f for f in files if side_file(f) is None), key=lambda f: mtime(directory, f))
    # A baseline sits right before its current, whatever the order they were written in.
    bases = {f[: -len("-base.png")] + ".png": f for f in files if f.endswith("-base.png")}
    order = []
    for f in files:
        if f.endswith("-base.png"):
            continue
        if f in bases:
            order.append(bases[f])
        order.append(f)
    return order + [f for f in files if f.endswith("-base.png") and f not in order]


def grid(sizes, cols, edge):
    """Cell size, rows and the smallest thumbnail scale of `sizes` laid out on `cols` columns."""
    rows = math.ceil(len(sizes) / cols)
    cell_w = (edge - 2 * PAD - (cols - 1) * GAP) / cols
    cell_h = (edge - 2 * PAD - HEAD - (rows - 1) * GAP) / rows - CAP
    if cell_w < 40 or cell_h < 40:
        return None
    scales = [min(1.0, (cell_w - 2) / w, (cell_h - 2) / h) for w, h in sizes]  # 2: the cell's border
    return cell_w, cell_h, rows, scales


def layout(sizes, cols, edge):
    """The column count (given, or the one with the largest thumbnails), then the scale of each."""
    tried = [cols] if cols else range(1, len(sizes) + 1)
    best = None
    for c in tried:
        g = grid(sizes, c, edge)
        if g is None:
            continue
        _, _, rows, scales = g
        width = max(round(w * s) for (w, _), s in zip(sizes, scales))
        height = max(round(h * s) for (_, h), s in zip(sizes, scales))
        area = (c * width) * (rows * height)
        # Largest worst thumbnail first; between equals, the smaller page (fewer tokens, same picture).
        key = (round(min(scales), 3), -area)
        if best is None or key > best[0]:
            best = (key, c, scales)
    if best is None:
        sys.exit("vysu: --cols %s leaves no room for a thumbnail" % cols)
    return best[1], best[2]


def ellipsize(d, text, font, width):
    if d.textlength(text, font=font) <= width:
        return text
    while len(text) > 4 and d.textlength(text + "…", font=font) > width:
        text = text[:-1]
    return text + "…"


def compose(directory, names, scales, cols, title, edge, out):
    thumbs = []
    for name, scale in zip(names, scales):
        im = Image.open(os.path.join(directory, name)).convert("RGB")
        if scale < 1.0:
            im = im.resize((max(1, round(im.width * scale)), max(1, round(im.height * scale))), Image.LANCZOS)
        thumbs.append(im)
    rows = math.ceil(len(thumbs) / cols)
    # Cells as wide as the widest thumbnail of the page: a page of small captures stays small. Wide
    # enough for a caption all the same, as long as the columns still fit the square.
    cell_w = max(max(t.width for t in thumbs) + 2, min(180, (edge - 2 * PAD - (cols - 1) * GAP) // cols))
    row_h = [max(t.height for t in thumbs[r * cols:(r + 1) * cols]) + 2 for r in range(rows)]
    width = 2 * PAD + cols * cell_w + (cols - 1) * GAP
    height = 2 * PAD + HEAD + sum(h + CAP for h in row_h) + (rows - 1) * GAP
    page = Image.new("RGB", (width, height), BG)
    d = ImageDraw.Draw(page)
    f_head, f_cap = mark.font(15), mark.font(12)
    d.text((PAD, PAD), ellipsize(d, title, f_head, width - 2 * PAD), font=f_head, fill=TEXT)
    y = PAD + HEAD
    for r in range(rows):
        for c, (name, thumb) in enumerate(zip(names[r * cols:(r + 1) * cols], thumbs[r * cols:(r + 1) * cols])):
            x = PAD + c * (cell_w + GAP)
            d.rectangle((x, y, x + cell_w - 1, y + row_h[r] - 1), fill=CELL, outline=LINE)
            page.paste(thumb, (x + (cell_w - thumb.width) // 2, y + 1))
            d.text((x + 2, y + row_h[r] + 4), ellipsize(d, name[:-4], f_cap, cell_w - 4), font=f_cap, fill=SOFT)
        y += row_h[r] + CAP + GAP
    page.save(out)


def write_html(directory, title, pages, edge):
    out = ["""<!doctype html><meta charset="utf-8"><title>%s</title>
<style>body{margin:0;background:#e5e7eb;font:12px/1.4 system-ui,sans-serif;color:#111}
section{max-width:%dpx;box-sizing:border-box;padding:16px;background:#f3f4f6;display:grid;gap:12px;
grid-template-columns:repeat(auto-fill,minmax(240px,1fr));align-items:start}
h1{grid-column:1/-1;font-size:14px;margin:0}
figure{margin:0;background:#fff;border:1px solid #d1d5db;border-radius:6px;padding:6px;min-width:0}
img{display:block;max-width:100%%;height:auto;margin:0 auto}
figcaption{margin-top:4px;color:#4b5563;font-variant-numeric:tabular-nums}</style>""" % (html.escape(title), edge)]
    for i, page in enumerate(pages, 1):
        suffix = " · %d/%d" % (i, len(pages)) if len(pages) > 1 else ""
        out.append('<section id="p%d"><h1>%s%s</h1>' % (i, html.escape(title), suffix))
        for f in page:
            out.append('<figure><img src="%s" alt="%s"><figcaption>%s</figcaption></figure>'
                       % (html.escape(f), html.escape(f), html.escape(f)))
        out.append("</section>")
    path = os.path.join(directory, "index.html")
    open(path, "w").write("\n".join(out))
    return path


def main():
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("shots", type=Path)
    parser.add_argument("--name", help="the title on the page (default: the folder name)")
    parser.add_argument("--cols", type=int, default=0, help="columns of a grid page (default: the best fit)")
    parser.add_argument("--max", type=int, default=6, help="captures per grid page")
    parser.add_argument("--edge", type=int, default=1568, help="longest side of a page, in px")
    parser.add_argument("--only", default="", help="comma-separated file name globs, in the order wanted")
    parser.add_argument("--strip", action="store_true", help="one row, every capture at the same scale")
    args = parser.parse_args()

    directory = str(args.shots)
    if not os.path.isdir(directory):
        sys.exit("vysu: no shots folder %s" % directory)
    only = [g.strip() for g in args.only.split(",") if g.strip()]
    names = pick(directory, only)
    if not names:
        sys.exit("vysu: no capture %sin %s" % ("matches « %s » " % args.only if only else "", directory))
    title = "%s · %s" % (args.name or os.path.basename(directory.rstrip("/")), time.strftime("%Y-%m-%d %H:%M"))
    sizes = [Image.open(os.path.join(directory, f)).size for f in names]

    if args.strip:
        # One scale for all: a before and an after of one screen stay the same size, and a smaller
        # phone still reads smaller. The row is fitted inside the square like any page.
        room_w = (args.edge - 2 * PAD - (len(names) - 1) * GAP) / len(names) - 2
        room_h = args.edge - 2 * PAD - HEAD - CAP - 2
        scale = min(1.0, room_w / max(w for w, _ in sizes), room_h / max(h for _, h in sizes))
        out = os.path.join(directory, "sheet-strip.png")
        compose(directory, names, [scale] * len(names), len(names), title, args.edge, out)
        print(out)
        return

    for stale in os.listdir(directory):
        if stale == "sheet.png" or (stale.startswith("sheet-") and stale[6:-4].isdigit() and stale.endswith(".png")):
            os.remove(os.path.join(directory, stale))
    count = math.ceil(len(names) / max(1, args.max))
    per = math.ceil(len(names) / count)  # 8 captures are two pages of 4, not a page of 6 and one of 2
    pages = [names[i:i + per] for i in range(0, len(names), per)]
    print(write_html(directory, title, pages, args.edge))
    for i, page in enumerate(pages, 1):
        cols, scales = layout([sizes[names.index(f)] for f in page], args.cols, args.edge)
        out = os.path.join(directory, "sheet.png" if len(pages) == 1 else "sheet-%d.png" % i)
        compose(directory, page, scales, cols, title + (" · %d/%d" % (i, len(pages)) if len(pages) > 1 else ""),
                args.edge, out)
        print(out)


if __name__ == "__main__":
    main()
