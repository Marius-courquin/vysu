#!/usr/bin/env python3
"""One tall image out of the captures of a scrolling mobile screen (vysu mshot --full).

    stitch.py <frames-dir | f00.png f01.png …> --out <tall.png> [--top N] [--bottom N] [--json]

agent-device captures the viewport of a native app, never the page: a long screen comes back as a
sequence of captures taken while scrolling, each one carrying the same fixed chrome (status bar +
top bar, and often a tab bar or a CTA at the bottom). This puts them back together.

The fixed bands are found, not configured: the leading rows that are identical across *all* the
captures are the top band, the trailing ones the bottom band; `--top`/`--bottom` (px) override the
detection when the content itself happens to repeat. Between two captures the overlap gives the
scroll offset — the last rows of one located in the next, coarse then refined at full resolution,
then every surviving candidate re-judged on the whole shared region: a list of same-height rows
matches at every multiple of its row period, and only the full overlap separates the true offset
from its harmonics. Real ties are that period, so the smallest offset wins — it skips no content.
An offset of zero, or no plausible match at all, means the scroller had already hit the end: the
capture is a duplicate and gets dropped. A region with nothing in it (a blank stretch) matches
everywhere, so there the largest plausible offset wins and the line says `ambiguous`.

Output is one PNG at 1x: the top band once, every capture's new rows, the bottom band once.
Exit: 0 stitched, 2 error (no capture, mismatched widths).
"""

import argparse
import json
import sys
from pathlib import Path

import numpy as np
from PIL import Image

BAND_DELTA = 8  # max channel delta for two pixels of a fixed band to count as the same
BAND_RATIO = 0.995  # … on this share of the row, the rest being a spinner or an antialiased glyph
TAIL = 120  # rows of capture i looked up in capture i+1
TAIL_FRACTION = 0.25  # … unless the scrolling region is short, then a quarter of it
MIN_OVERLAP = 24  # a long scroll leaves less than the tail in common: still enough rows to judge
DOWN = 4  # coarse search: every 4th row and column, then full resolution around the candidates
MATCH_MAX = 0.05  # mean abs luma delta (0..1) above which the two captures share nothing
# A tail score is sampled evidence: everything within this much of the best stays a candidate for
# the full-overlap judgement, which is the one that decides.
CANDIDATE_RATIO = 2
# Two offsets tie on the full overlap when their scores are this close: the ratio leaves room for a
# match softened by resampling, the floor for a pixel-exact one, whose score is 0 and would
# otherwise tie with nothing else. Wider than this and a harmonic of a repeating list — visibly
# worse, just not by much — passes for the real offset.
MATCH_RATIO = 1.05
MATCH_FLOOR = 1e-4
COARSE_SLACK = 0.01  # a coarse score is a sampled one: refine every candidate this close to the best
DUP_MAX = 0.002  # mean abs luma delta over the whole region: under it the captures are one picture
DETAIL_MIN = 2.0  # levels of standard deviation under which a strip is blank, so it proves nothing


def load(paths):
    frames = []
    for path in paths:
        try:
            frames.append(np.asarray(Image.open(path).convert("RGB"), dtype=np.uint8))
        except OSError as exc:
            print(f"stitch: {exc}", file=sys.stderr)
            raise SystemExit(2)
    return frames


def bands(frames):
    """(top, bottom): leading and trailing rows identical across every capture."""
    stack = np.stack(frames).astype(np.int16)
    same = (np.abs(stack - stack[0]).max(axis=3) <= BAND_DELTA).mean(axis=2)  # captures × rows
    fixed = same.min(axis=0) >= BAND_RATIO
    height = fixed.size
    top = int(np.argmin(fixed)) if not fixed.all() else height
    bottom = int(np.argmin(fixed[::-1])) if not fixed.all() else 0
    return top, bottom


def luma(frame):
    return frame[:, :, 0] * 0.299 + frame[:, :, 1] * 0.587 + frame[:, :, 2] * 0.114


def score_at(region_a, region_b, offset, tail_rows, step=1):
    """(score, detail) of the tail of a at that offset: mean abs delta (0..1), and how textured it is.

    Past `rows - tail_rows` the tail no longer fits in b, and only the part still shared is compared:
    a long scroll leaves a thin overlap, which is exactly the case that has to be measurable.
    """
    rows = region_a.shape[0]
    start = max(rows - tail_rows, offset)
    a = region_a[start::step]
    b = region_b[start - offset:rows - offset:step]
    return float(np.abs(a[:, ::step] - b[:, ::step]).mean()) / 255, float(a.std())


def resolve(scores, ratio):
    """(offsets that tie for best, their scores, whether the evidence is blank).

    Flat strips prove nothing, so texture decides first: when some candidates land on textured
    pixels only those are judged, and when none does the match is blank and says nothing at all.
    """
    textured = {d: score for d, (score, detail) in scores.items() if detail >= DETAIL_MIN}
    considered = textured or {d: score for d, (score, _) in scores.items()}
    best = min(considered.values())
    tie = best * ratio + MATCH_FLOOR
    return sorted(d for d, score in considered.items() if score <= tie), considered, not textured


def offset_between(region_a, region_b):
    """(offset, score, ambiguous): how far the content of b has scrolled past a."""
    rows = region_a.shape[0]
    if float(np.abs(region_a - region_b).mean()) / 255 <= DUP_MAX:
        return 0, 0.0, False
    tail_rows = min(TAIL, max(8, int(rows * TAIL_FRACTION)))
    limit = rows - MIN_OVERLAP
    if limit <= 0:
        return 0, 1.0, False
    coarse = {d: score_at(region_a, region_b, d, tail_rows, DOWN) for d in range(0, limit + 1, DOWN)}
    best_coarse = min(score for score, _ in coarse.values())
    scores = {}
    for d in (d for d, (score, _) in coarse.items() if score <= best_coarse + COARSE_SLACK):
        for fine in range(max(0, d - DOWN + 1), min(limit, d + DOWN - 1) + 1):
            if fine not in scores:
                scores[fine] = score_at(region_a, region_b, fine, tail_rows)
    # The tail only nominates: on a list of same-height rows it matches at every multiple of the row
    # period, and a blank tail matches wherever it lands. Re-judge every nominee on the whole shared
    # region at full resolution — all the evidence there is — and take the best outright.
    candidates, _, _ = resolve(scores, CANDIDATE_RATIO)
    tied, considered, blank = resolve({d: score_at(region_a, region_b, d, rows) for d in candidates},
                                      MATCH_RATIO)
    # A remaining tie on textured pixels is that row period: the smallest offset wins, it is the one
    # that skips no content. Blank pixels prove nothing, so there the longest stitch is the better
    # guess and the line says so.
    chosen = tied[-1] if blank else tied[0]
    return chosen, considered[chosen], blank and tied[-1] - tied[0] > 1


def compose(frames, kept, top, bottom):
    """The tall image: top band, then every kept capture's new rows, then the bottom band."""
    height, width = frames[0].shape[:2]
    rows = height - top - bottom
    total = top + rows + sum(offset for _, offset in kept[1:]) + bottom
    out = np.empty((total, width, 3), dtype=np.uint8)
    out[:top] = frames[kept[0][0]][:top]
    out[top:top + rows] = frames[kept[0][0]][top:top + rows]
    cursor = top + rows
    for index, offset in kept[1:]:
        out[cursor:cursor + offset] = frames[index][height - bottom - offset:height - bottom]
        cursor += offset
    out[cursor:] = frames[kept[-1][0]][height - bottom:]
    return out


def main():
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("frames", nargs="+", type=Path, help="a frames directory, or the captures in scroll order")
    parser.add_argument("--out", type=Path, required=True, help="the tall PNG to write")
    parser.add_argument("--top", type=int, help="fixed top band height in px (skip the detection)")
    parser.add_argument("--bottom", type=int, help="fixed bottom band height in px (skip the detection)")
    parser.add_argument("--json", action="store_true")
    args = parser.parse_args()

    paths = args.frames
    if len(paths) == 1 and paths[0].is_dir():
        paths = sorted(paths[0].glob("*.png"))
    if not paths:
        print("stitch: no capture", file=sys.stderr)
        raise SystemExit(2)

    frames = load(paths)
    names = [path.stem for path in paths]
    height, width = frames[0].shape[:2]
    for name, frame in zip(names, frames):
        if frame.shape != frames[0].shape:
            print(f"stitch: {name} is {frame.shape[1]}x{frame.shape[0]}, expected {width}x{height}", file=sys.stderr)
            raise SystemExit(2)

    if len(frames) == 1:
        top, bottom = height, 0
    else:
        top, bottom = bands(frames)
    if args.top is not None:
        top = args.top
    if args.bottom is not None:
        bottom = args.bottom
    if top + bottom >= height:
        # Everything repeats: nothing scrolled, so the first capture is already the whole picture.
        top, bottom = height, 0

    regions = [luma(frame[top:height - bottom]) for frame in frames]
    kept = [(0, 0)]  # (capture index, new rows it brings)
    dropped = []
    lines = []
    ambiguities = 0
    for index in range(1, len(frames)):
        previous = kept[-1][0]
        offset, quality, ambiguous = (0, 1.0, False) if top >= height else \
            offset_between(regions[previous], regions[index])
        if offset == 0 or quality > MATCH_MAX:
            dropped.append(names[index])
            lines.append(f"{names[index]} duplicate of {names[previous]}, dropped")
            continue
        kept.append((index, offset))
        ambiguities += ambiguous
        lines.append(f"{names[index]} +{offset} px" + (" · ambiguous" if ambiguous else ""))

    out = compose(frames, kept, top, bottom)
    args.out.parent.mkdir(parents=True, exist_ok=True)
    Image.fromarray(out).save(args.out)

    if args.json:
        print(json.dumps({
            "out": str(args.out),
            "width": out.shape[1],
            "height": out.shape[0],
            "top": top,
            "bottom": bottom,
            "captures": len(frames),
            "used": len(kept),
            "offsets": [offset for _, offset in kept[1:]],
            "dropped": dropped,
            "ambiguous": ambiguities,
        }))
        raise SystemExit(0)

    print(f"top {top} px · bottom {bottom} px")
    for line in lines:
        print(line)
    plural = "s" if len(frames) > 1 else ""
    print(f"{args.out} {out.shape[1]}x{out.shape[0]} · {len(frames)} capture{plural}, {len(kept)} used")


if __name__ == "__main__":
    main()
