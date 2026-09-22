#!/usr/bin/env python3
"""Where two screenshots differ, in text first: the changed zones, then the images if asked.

Usage: diff.py <baseline.png> <current.png> [--out diff.png] [--mark marked.png] [--threshold 0.1]
               [--ignore x,y,w,h]... [--scale N] [--min-area 64] [--pad 24] [--json]

A pixel counts as changed when its largest channel delta passes `--threshold` (0..1, the meaning
agent-browser gives `diff screenshot --threshold`) *and* at least one of its eight neighbours
changed too: font hinting repaints single pixels, a real change never does. `--ignore` blanks a
region of both images beforehand (a relative timestamp, an avatar). Changed pixels are then
clustered over an 8 px grid so the report names a handful of places instead of thousands of pixels.

`--out` writes the classic red-on-dimmed diff; `--mark` writes the one image worth opening: the
current screenshot with every zone boxed and numbered, cropped around them. `--scale` also gives
the boxes in points/dp (3 on a 3x device). Exit: 0 identical or below threshold, 1 zones, 2 error.
"""

import argparse
import json
import sys
from pathlib import Path

import numpy as np
from PIL import Image

sys.path.insert(0, str(Path(__file__).resolve().parent))
import mark  # noqa: E402 — sibling script, reused so the marked image looks like `nv mark`

CELL = 8  # clustering grid: fine enough to separate a button from its row, coarse enough to stay cheap
MAX_ZONES = 12
RED = (225, 29, 72)  # #e11d48, mark.py's colour


def parse_region(spec):
    x, y, w, h = (int(float(v)) for v in spec.split(","))
    return x, y, w, h


def denoise(mask):
    """Keep only changed pixels that have a changed neighbour: drops 1-px anti-aliasing noise."""
    h, w = mask.shape
    padded = np.zeros((h + 2, w + 2), dtype=bool)
    padded[1:-1, 1:-1] = mask
    neighbours = np.zeros_like(mask)
    for dy in range(3):
        for dx in range(3):
            if dy == 1 and dx == 1:
                continue
            neighbours |= padded[dy:dy + h, dx:dx + w]
    return mask & neighbours


def cell_mask(mask):
    """The changed mask reduced to a grid of CELL×CELL cells, a cell on when it holds any changed pixel."""
    h, w = mask.shape
    rows, cols = -(-h // CELL), -(-w // CELL)
    padded = np.zeros((rows * CELL, cols * CELL), dtype=bool)
    padded[:h, :w] = mask
    return padded.reshape(rows, CELL, cols, CELL).any(axis=(1, 3))


def components(cells):
    """Bounding boxes [x0, y0, x1, y1] of the 4-connected groups of on-cells, in cell coordinates."""
    rows, cols = cells.shape
    seen = np.zeros(cells.shape, dtype=bool)
    boxes = []
    for start in zip(*np.nonzero(cells)):
        if seen[start]:
            continue
        seen[start] = True
        y0 = y1 = int(start[0])
        x0 = x1 = int(start[1])
        stack = [(y0, x0)]  # plain ints: numpy scalars would leak all the way into the JSON report
        while stack:
            y, x = stack.pop()
            y0, y1 = min(y0, y), max(y1, y)
            x0, x1 = min(x0, x), max(x1, x)
            for ny, nx in ((y - 1, x), (y + 1, x), (y, x - 1), (y, x + 1)):
                if 0 <= ny < rows and 0 <= nx < cols and cells[ny, nx] and not seen[ny, nx]:
                    seen[ny, nx] = True
                    stack.append((ny, nx))
        boxes.append([x0, y0, x1, y1])
    return boxes


def merge(boxes, pad):
    """Fuse boxes separated by less than `pad` px of untouched picture, until nothing moves."""
    moved = True
    while moved:
        moved = False
        kept = []
        for box in boxes:
            for other in kept:
                if (box[0] - pad <= other[2] and box[2] + pad >= other[0]
                        and box[1] - pad <= other[3] and box[3] + pad >= other[1]):
                    other[0], other[1] = min(other[0], box[0]), min(other[1], box[1])
                    other[2], other[3] = max(other[2], box[2]), max(other[3], box[3])
                    moved = True
                    break
            else:
                kept.append(list(box))
        boxes = kept
    return boxes


def tighten(changed, x0, y0, x1, y1):
    """The box hugging the changed pixels inside a region, plus how many there are (None when empty)."""
    sub = changed[y0:y1 + 1, x0:x1 + 1]
    count = int(sub.sum())
    if not count:
        return None
    ys, xs = np.nonzero(sub.any(axis=1))[0], np.nonzero(sub.any(axis=0))[0]
    return [x0 + int(xs[0]), y0 + int(ys[0]), x0 + int(xs[-1]), y0 + int(ys[-1])], count


def zones_of(changed, pad, min_area):
    """Changed pixels grouped into zones, biggest first: {x, y, w, h, px, ratio}."""
    height, width = changed.shape
    boxes = []
    for x0, y0, x1, y1 in components(cell_mask(changed)):
        # Cells are 8 px coarse: hug the changed pixels themselves so the box points precisely.
        tight = tighten(changed, x0 * CELL, y0 * CELL,
                        min((x1 + 1) * CELL, width) - 1, min((y1 + 1) * CELL, height) - 1)
        if tight:
            boxes.append(tight[0])
    found = []
    for x0, y0, x1, y1 in merge(boxes, pad):
        box, count = tighten(changed, x0, y0, x1, y1)
        if count < min_area:
            continue
        zone = {"x": box[0], "y": box[1], "w": box[2] - box[0] + 1, "h": box[3] - box[1] + 1, "px": count}
        zone["ratio"] = count / (zone["w"] * zone["h"])
        found.append(zone)
    return sorted(found, key=lambda z: -z["px"])


def write_diff(current, changed, path):
    """The current screenshot at 35 % brightness with the changed pixels painted red."""
    arr = (np.asarray(current, dtype=np.uint16) * 35 // 100).astype(np.uint8)
    height, width = changed.shape
    arr[:height, :width][changed] = RED
    Image.fromarray(arr).save(path)


def write_mark(current, zones, pad, path):
    """The one image an agent should read: zones boxed and numbered on the current screenshot."""
    shapes = [("box", (z["x"], z["y"], z["w"], z["h"]), str(i)) for i, z in enumerate(zones, 1)]
    covered = sum(z["w"] * z["h"] for z in zones) / (current.width * current.height)
    im = mark.render(
        current.convert("RGBA"), shapes, grow=4, dim=True,
        crop="auto" if covered <= 0.6 else None, pad=pad,
    )
    im.convert("RGB").save(path)


def fmt_box(z, scale):
    line = f"x {z['x']} y {z['y']} w {z['w']} h {z['h']} px"
    if scale:
        line += f" = x {z['x'] / scale:.0f} y {z['y'] / scale:.0f} w {z['w'] / scale:.0f} h {z['h'] / scale:.0f} pt"
    return line


def main():
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("baseline", type=Path)
    parser.add_argument("current", type=Path)
    parser.add_argument("--out", type=Path, help="red-on-dimmed diff image")
    parser.add_argument("--mark", dest="marked", type=Path, help="current screenshot, zones boxed and cropped")
    parser.add_argument("--threshold", type=float, default=0.1, help="channel delta (0..1) for a pixel to count")
    parser.add_argument("--ignore", action="append", default=[], metavar="x,y,w,h", help="blank a region first")
    parser.add_argument("--scale", type=float, default=0, help="pixels per point/dp (0: report pixels only)")
    parser.add_argument("--min-area", type=int, default=64, help="smallest zone worth reporting, in changed pixels")
    # --pad is pixels, not points: a 3x device capture wants roughly 3x the pad to group the same cards.
    parser.add_argument("--pad", type=int, default=24, help="px of slack when fusing zones and cropping the mark")
    parser.add_argument("--json", action="store_true")
    args = parser.parse_args()

    try:
        baseline = Image.open(args.baseline).convert("RGB")
        current = Image.open(args.current).convert("RGB")
    except OSError as exc:
        print(f"diff: {exc}", file=sys.stderr)
        raise SystemExit(2)

    mismatch = baseline.size != current.size
    width, height = min(baseline.width, current.width), min(baseline.height, current.height)
    before = np.asarray(baseline, dtype=np.int16)[:height, :width]
    after = np.asarray(current, dtype=np.int16)[:height, :width]
    for spec in args.ignore:
        try:
            x, y, w, h = parse_region(spec)
        except ValueError:
            print(f"diff: --ignore wants x,y,w,h, got {spec}", file=sys.stderr)
            raise SystemExit(2)
        region = (slice(max(0, y), max(0, y + h)), slice(max(0, x), max(0, x + w)))
        before[region] = 0
        after[region] = 0

    changed = denoise(np.abs(before - after).max(axis=2) > args.threshold * 255)
    changed_px = int(changed.sum())
    ratio = 100 * changed_px / (width * height)
    zones = zones_of(changed, args.pad, args.min_area) if changed_px else []

    marked = None
    if zones:
        if args.out:
            write_diff(current, changed, args.out)
        if args.marked:
            write_mark(current, zones[:MAX_ZONES], args.pad, args.marked)
            marked = str(args.marked)

    if args.json:
        print(json.dumps({
            "changed_ratio": round(ratio / 100, 6),
            "changed_px": changed_px,
            "zones": [{"x": z["x"], "y": z["y"], "w": z["w"], "h": z["h"], "ratio": round(z["ratio"], 4)}
                      for z in zones[:MAX_ZONES]],
            "size_mismatch": mismatch,
            "marked": marked,
        }))
        raise SystemExit(1 if zones else 0)

    if mismatch:
        print(f"size mismatch: baseline {baseline.width}x{baseline.height}, "
              f"current {current.width}x{current.height} — compared on {width}x{height}")
    if not changed_px:
        print("identical")
        raise SystemExit(0)
    if not zones:
        print(f"changed {ratio:.1f} % · below threshold")
        raise SystemExit(0)

    shown = zones[:MAX_ZONES]
    print(f"changed {ratio:.1f} % ({changed_px} px) · {len(zones)} zone{'s' if len(zones) > 1 else ''}")
    for index, zone in enumerate(shown, 1):
        print(f"{index}. {fmt_box(zone, args.scale)}  ({zone['ratio'] * 100:.0f} % of the zone)")
    if len(zones) > len(shown):
        print(f"… and {len(zones) - len(shown)} more")
    if marked:
        print(f"marked: {marked}")
    raise SystemExit(1)


if __name__ == "__main__":
    main()
