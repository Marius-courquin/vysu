#!/usr/bin/env python3
"""A burst of screenshots read back as the few frames that differ (vysu mburst).

Usage: burst.py <raw-dir> --out-dir <dir> --platform ios|android [--scale 3] [--threshold 0.1]
                [--min-area 64] [--band 44] [--edge 1568] [--max-thumbs 12]

<raw-dir> holds the device-pixel captures (000.png, 001.png…) and times.tsv (index, start, end:
epoch seconds of each capture). Each frame is brought down to 1x (points / dp: what every other vysu
capture is in), then compared with the last frame kept, through diff.py's own rule (a pixel counts
when a channel moves past --threshold and a neighbour moved too, and a change needs a zone of
--min-area pixels), so « near-identical » means here exactly what `diff.py` exit 0 means. The
status-bar band (--band pt at the top) is left out of that comparison: its clock and battery move on
a still screen.

Writes <platform>-burst-NN.png for every distinct frame (NN = its index in the burst, so the text
line and the files name the same frame), <platform>-burst-strip.png (one row, no wider than --edge,
each frame labelled with its index and time), and prints one line:

    burst: 14 frames in 3.0s, 4 distinct · 00 0.0s · 03 0.9s (38 % changed) · 05 1.5s (12 %)

then the strip's path. Exit 0; 2 on a read error.
"""

import argparse
import sys
from pathlib import Path

import numpy as np
from PIL import Image, ImageDraw

sys.path.insert(0, str(Path(__file__).resolve().parent))
import diff  # noqa: E402 (sibling script): the same « changed » rule as every other vysu comparison
import mark  # noqa: E402 (sibling script), reused for its system-font search

GAP = 8         # px between two thumbnails of the strip
LABEL_H = 22    # px of label band under each thumbnail
BG = (24, 24, 27)
FG = (244, 244, 245)


def read_times(raw):
    """index → capture midpoint (epoch s): a capture shows the screen somewhere inside its call."""
    times = {}
    path = raw / "times.tsv"
    if path.exists():
        for line in path.read_text().splitlines():
            parts = line.split("\t")
            if len(parts) >= 3:
                try:
                    times[int(parts[0])] = (float(parts[1]) + float(parts[2])) / 2
                except ValueError:
                    continue
    return times


def to_1x(im, scale):
    if scale <= 1:
        return im.convert("RGB")
    size = (max(1, round(im.width / scale)), max(1, round(im.height / scale)))
    return im.convert("RGB").resize(size, Image.LANCZOS)


def changed(before, after, threshold, min_area, band):
    """(distinct?, changed share of the picture) under diff.py's rule, the status band left out."""
    w, h = min(before.width, after.width), min(before.height, after.height)
    a = np.asarray(before, dtype=np.int16)[:h, :w].copy()
    b = np.asarray(after, dtype=np.int16)[:h, :w].copy()
    if band:
        a[:band] = 0
        b[:band] = 0
    mask = diff.denoise(np.abs(a - b).max(axis=2) > threshold * 255)
    px = int(mask.sum())
    if not px:
        return False, 0.0
    zones = diff.zones_of(mask, 24, min_area)
    return bool(zones), px / (w * h)


def strip(frames, labels, edge, out):
    """One row of thumbnails, each labelled, the whole row no wider than `edge`."""
    n = len(frames)
    fw, fh = frames[0].size
    width = min(fw, (edge - GAP * (n + 1)) // n)
    height = round(fh * width / fw)
    im = Image.new("RGB", (GAP + n * (width + GAP), GAP + height + LABEL_H + GAP // 2), BG)
    d = ImageDraw.Draw(im)
    font = mark.font(max(11, min(15, width // 9)))
    for i, (frame, label) in enumerate(zip(frames, labels)):
        x = GAP + i * (width + GAP)
        im.paste(frame.resize((width, height), Image.LANCZOS), (x, GAP))
        tw = d.textlength(label, font=font)
        d.text((x + (width - tw) / 2, GAP + height + 4), label, font=font, fill=FG)
    im.save(out)


def main():
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("raw", type=Path)
    parser.add_argument("--out-dir", type=Path, required=True)
    parser.add_argument("--platform", required=True)
    parser.add_argument("--scale", type=float, default=1)
    parser.add_argument("--threshold", type=float, default=0.1)
    parser.add_argument("--min-area", type=int, default=64)
    parser.add_argument("--band", type=int, default=-1, help="pt of status bar left out (-1: from the screen's shape)")
    parser.add_argument("--edge", type=int, default=1568)
    parser.add_argument("--max-thumbs", type=int, default=12)
    args = parser.parse_args()

    paths = sorted(p for p in args.raw.glob("[0-9][0-9][0-9].png") if p.stat().st_size)
    if not paths:
        print("burst: no frame was captured", file=sys.stderr)
        raise SystemExit(2)
    times = read_times(args.raw)
    t0 = times.get(int(paths[0].stem))

    kept = []   # (index, seconds, percent-or-None, image)
    last = None
    for path in paths:
        index = int(path.stem)
        try:
            im = to_1x(Image.open(path), args.scale)
        except OSError:
            continue  # a capture cut short when the burst stopped: nothing to read in it
        band = args.band
        if band < 0:
            # 44 pt under a notch or a punch-hole, 20 on a home-button phone: mshot's own rule.
            band = 44 if im.height > 2 * im.width else 20
        seconds = (times[index] - t0) if (t0 is not None and index in times) else None
        if last is None:
            kept.append((index, seconds, None, im))
            last = im
            continue
        distinct, share = changed(last, im, args.threshold, args.min_area, band)
        if distinct:
            kept.append((index, seconds, share * 100, im))
            last = im
    total = len(paths)
    last_t = times.get(int(paths[-1].stem))
    span = (last_t - t0) if (last_t is not None and t0 is not None) else 0.0

    args.out_dir.mkdir(parents=True, exist_ok=True)
    for old in args.out_dir.glob(f"{args.platform}-burst-*.png"):
        old.unlink()
    digits = max(2, len(str(int(paths[-1].stem))))
    parts = []
    for n, (index, seconds, pct, im) in enumerate(kept):
        name = f"{index:0{digits}d}"
        im.save(args.out_dir / f"{args.platform}-burst-{name}.png")
        when = f"{seconds:.1f}s" if seconds is not None else "?s"
        if pct is None:
            parts.append(f"{name} {when}")
        else:
            # The first distinct frame says what the number is; the rest just give it.
            # Under 1 %, one decimal: a distinct frame never reads « 0 % » (a tab pill sliding over).
            share = f"{pct:.1f}" if pct < 1 else f"{pct:.0f}"
            parts.append(f"{name} {when} ({share} %{' changed' if n == 1 else ''})")

    # Past a dozen thumbnails a 1568 px row stops being readable: an even sample, first and last kept.
    shown = kept
    if len(kept) > args.max_thumbs:
        step = (len(kept) - 1) / (args.max_thumbs - 1)
        shown = [kept[round(i * step)] for i in range(args.max_thumbs)]
    labels = [f"{index:0{digits}d} · {seconds:.1f}s" if seconds is not None else f"{index:0{digits}d}"
              for index, seconds, _, _ in shown]
    strip_path = args.out_dir / f"{args.platform}-burst-strip.png"
    strip([im for _, _, _, im in shown], labels, args.edge, strip_path)

    line = f"burst: {total} frames in {span:.1f}s, {len(kept)} distinct · " + " · ".join(parts)
    print(line)
    sampled = f" ({len(shown)} of {len(kept)})" if len(shown) < len(kept) else ""
    print(f"{strip_path}{sampled}")


if __name__ == "__main__":
    main()
