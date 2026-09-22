#!/usr/bin/env python3
"""The text fields of a mobile screen, read from the picture rather than from the tree.

Usage: fields.py <screenshot.png> [--scale N] [--json] [--min-width 0.5] [--min-height 36]
                 [--max-height 72] [--edge 10]

A login form inside a system web surface — SafariViewService on iOS 18, a Chrome Custom Tab — is
invisible to the platform's accessibility, and a connector that cannot read it used to tap at
constants ("the e-mail sits at 57 % of the height"). This finds the boxes instead: a text field is
a rounded rectangle with a continuous border, wider than half the screen, 36 to 72 pt tall, light
inside. Boxes come back top to bottom, in points — `--scale` is the pixels per point of the capture
(1 for what `vysu mshot` writes, which is already 1x).

Plain output is one `x,y,w,h` per line, the spelling `vysu box` and `vysu mark` use; `--json` is the
array of `{x, y, w, h}` objects `mob_fields` hands a connector. Exit: 0 with boxes, 1 with none,
2 on an error.
"""

import argparse
import json
import sys

import numpy as np
from PIL import Image


def border_rows(gray, edge, min_run):
    """Rows that hold a horizontal line: a run of columns differing from the row above.

    Returns, per candidate row, the (x0, x1) of its longest such run. A 2 px border answers on both
    of its rows; the caller keeps the first of each streak.
    """
    delta = np.abs(np.diff(gray, axis=0)) > edge
    rows = {}
    for y in range(delta.shape[0]):
        columns = np.flatnonzero(delta[y])
        if columns.size < min_run:
            continue
        # The longest contiguous run of edge columns: a rounded corner leaves the first and last
        # few columns out, a background gradient leaves gaps everywhere.
        splits = np.flatnonzero(np.diff(columns) > 1)
        best = None
        for start, end in zip(
            np.concatenate(([0], splits + 1)), np.concatenate((splits, [columns.size - 1]))
        ):
            run = (columns[start], columns[end])
            if best is None or run[1] - run[0] > best[1] - best[0]:
                best = run
        if best is not None and best[1] - best[0] + 1 >= min_run:
            rows[y] = best
    return rows


def streaks(rows):
    """One representative per streak of consecutive border rows, widest run first."""
    kept, streak = [], []
    for y in sorted(rows):
        if streak and y == streak[-1] + 1:
            streak.append(y)
            continue
        if streak:
            kept.append(max(streak, key=lambda r: rows[r][1] - rows[r][0]))
        streak = [y]
    if streak:
        kept.append(max(streak, key=lambda r: rows[r][1] - rows[r][0]))
    return kept


def light_inside(gray, top, bottom, x0, x1):
    """A field's interior: light and even. A button, an image or a block of text is neither."""
    inner = gray[top + 3 : bottom - 2, x0 + 4 : x1 - 3]
    if inner.size == 0:
        return False
    return inner.mean() > 170 and inner.std() < 42


def closed_sides(gray, top, bottom, x0, x1, edge):
    """Both sides carry a vertical border, which is what makes the rectangle a box.

    Two horizontal lines with whitespace between them — the gap under a field, the room above a
    button — otherwise read as a field twice as often as a field does. The border is looked for a
    few pixels out from the ends of the horizontal run, since a rounded corner cuts that run short.
    """
    rows = slice(top + 4, bottom - 3)
    inner = gray[top + 3 : bottom - 2, x0 + 4 : x1 - 3]
    if inner.size == 0 or rows.start >= rows.stop:
        return False
    level = inner.mean()
    for lo, hi in ((x0 - 14, x0 + 5), (x1 - 4, x1 + 15)):
        lo, hi = max(lo, 0), min(hi, gray.shape[1])
        if lo >= hi:
            return False
        column = gray[rows, lo:hi] < level - edge
        if column.size == 0 or column.mean(axis=0).max() < 0.6:
            return False
    return True


def fields(image, scale, min_width, min_height, max_height, edge):
    gray = np.asarray(image.convert("L"), dtype=np.int16)
    height, width = gray.shape
    min_run = int(width * min_width)
    rows = border_rows(gray, edge, min_run)
    candidates = streaks(rows)
    boxes = []
    for i, top in enumerate(candidates):
        x0, x1 = rows[top]
        for bottom in candidates[i + 1 :]:
            span = bottom - top
            if span < min_height * scale:
                continue
            if span > max_height * scale:
                break
            bx0, bx1 = rows[bottom]
            # The same rectangle: both borders start and end together, give or take a corner.
            if abs(bx0 - x0) > width * 0.05 or abs(bx1 - x1) > width * 0.05:
                continue
            if not light_inside(gray, top, bottom, x0, x1):
                continue
            if not closed_sides(gray, top, bottom, x0, x1, edge):
                continue
            boxes.append((x0, top, x1 - x0 + 1, span + 1))
            break
    # A field found twice is one field: its border answered on two rows a pixel apart, or a line
    # above it paired with its own bottom and wrapped it. The inner box is the field itself.
    unique = []
    for box in sorted(boxes, key=lambda b: (b[1], -b[3])):
        if unique:
            last = unique[-1]
            overlap = min(last[1] + last[3], box[1] + box[3]) - max(last[1], box[1])
            if abs(last[1] - box[1]) <= 4 or overlap > 0.5 * min(last[3], box[3]):
                if box[3] < last[3]:
                    unique[-1] = box
                continue
        unique.append(box)
    return [
        {"x": round(x / scale), "y": round(y / scale), "w": round(w / scale), "h": round(h / scale)}
        for x, y, w, h in unique
    ]


def main():
    parser = argparse.ArgumentParser(add_help=True)
    parser.add_argument("image")
    parser.add_argument("--scale", type=float, default=1.0, help="pixels per point of the capture")
    parser.add_argument("--json", action="store_true", help="the boxes as a JSON array")
    parser.add_argument("--min-width", type=float, default=0.5, help="of the screen's width")
    parser.add_argument("--min-height", type=float, default=36.0, help="points")
    parser.add_argument("--max-height", type=float, default=72.0, help="points")
    parser.add_argument("--edge", type=float, default=10.0, help="what counts as a border, 0..255")
    args = parser.parse_args()

    try:
        image = Image.open(args.image)
    except OSError as error:
        sys.exit("fields.py: %s" % error)
    boxes = fields(
        image, args.scale, args.min_width, args.min_height, args.max_height, args.edge
    )
    if args.json:
        print(json.dumps(boxes))
    else:
        for box in boxes:
            print("%d,%d,%d,%d" % (box["x"], box["y"], box["w"], box["h"]))
    return 0 if boxes else 1


if __name__ == "__main__":
    try:
        sys.exit(main())
    except KeyboardInterrupt:
        sys.exit(2)
