#!/usr/bin/env python3
"""Motion report over a recording (vysu mrec): where the picture moves, and what flashes.

    motion.py <frames-dir | video.mp4> [--fps 60] [--scale 3] [--crop w:h:x:y]
              [--flash-min 4] [--flash-max 12] [--min-change 0.5] [--dump <dir>]

Two readings of the frames, both in plain text so an agent can act on them without looking:

- **timeline** — runs of consecutive frames that differ from the previous one (a transition, a
  scroll, a reveal), with how much of the picture moved and the box it moved in;
- **transients** — pixel rows that leave their resting value for `--flash-min` to `--flash-max`
  frames and come back to it, their neighbours holding still: a hairline at a seam, a flash, a
  control that shows for a few frames. Those are what a screenshot never catches and what the eye
  reports as « something blinked » (the edges of a cross-fading label flicker for a frame or two
  too — `--flash-min` keeps them out).

A video is read straight from ffmpeg as a grayscale pipe: no PNG sequence on disk (9 s at 60 fps
is 550 files and 100+ MB), and `--crop w:h:x:y` is ffmpeg's own order, in pixels. A directory is
read as its PNGs in name order instead. Frames are numbered from f00001 either way, matching the
`f%05d.png` a manual `ffmpeg -vf fps=…` would write. `--scale` turns pixel rows into points/dp for
the report (3 on a 3x iPhone); without it rows are reported in pixels. `--dump <dir>` writes just
the frames the report names, so an agent reads three pictures instead of five hundred.
"""

import argparse
import shutil
import subprocess
import sys
from pathlib import Path

import numpy as np
from PIL import Image

# A pixel counts as changed past this luminance delta; a row as departed past this delta of its mean.
PIXEL_DELTA = 16
ROW_DELTA = 4

VIDEO_SUFFIXES = {".mp4", ".mov", ".webm", ".m4v"}


def frame_name(index):
    """0-based frame index → the f00001 name the report and the dumps use."""
    return f"f{index + 1:05d}"


def video_filter(fps, crop):
    chain = f"fps={fps:g}"
    if crop:
        chain += f",crop={crop}"
    return chain


def video_size(path, crop):
    if crop:
        w, h = crop.split(":")[:2]
        return int(w), int(h)
    probe = subprocess.run(
        ["ffprobe", "-v", "error", "-select_streams", "v:0",
         "-show_entries", "stream=width,height", "-of", "csv=p=0", str(path)],
        capture_output=True, text=True,
    )
    try:
        w, h = probe.stdout.strip().split(",")[:2]
        return int(w), int(h)
    except ValueError:
        sys.exit(f"motion: ffprobe found no video stream in {path}\n{probe.stderr.strip()}")


def video_frames(path, fps, crop):
    """Grayscale frames streamed from ffmpeg, one numpy array at a time."""
    width, height = video_size(path, crop)
    # `format=gray` lands within a level of the PNG route it replaces (ffmpeg does the same
    # yuv→luma conversion Pillow's .convert("L") did on the extracted PNGs).
    chain = video_filter(fps, crop) + ",format=gray"
    proc = subprocess.Popen(
        ["ffmpeg", "-v", "error", "-i", str(path), "-vf", chain, "-f", "rawvideo", "-pix_fmt", "gray", "-"],
        stdout=subprocess.PIPE,
    )
    size = width * height
    try:
        while True:
            buffer = proc.stdout.read(size)
            if len(buffer) < size:
                break
            yield np.frombuffer(buffer, dtype=np.uint8).reshape(height, width)
    finally:
        proc.stdout.close()
        proc.wait()


def dir_frames(files):
    for file in files:
        yield np.asarray(Image.open(file).convert("L"), dtype=np.uint8)


def scan(frames, min_change):
    """One pass over the frames: the movement runs, and the row means the transients need."""
    runs = []  # (start, end, max_ratio, bbox)
    means = []
    current = None
    previous = None
    for index, frame in enumerate(frames):
        means.append(frame.astype(np.float32).mean(axis=1))
        frame = frame.astype(np.int16)
        if previous is not None:
            changed = np.abs(frame - previous) > PIXEL_DELTA
            ratio = changed.mean() * 100
            if ratio >= min_change:
                ys, xs = np.nonzero(changed)
                box = (int(xs.min()), int(ys.min()), int(xs.max() - xs.min() + 1), int(ys.max() - ys.min() + 1))
                if current is None:
                    current = [index, index, ratio, box]
                else:
                    current[1] = index
                    current[2] = max(current[2], ratio)
                    x0 = min(current[3][0], box[0]); y0 = min(current[3][1], box[1])
                    x1 = max(current[3][0] + current[3][2], box[0] + box[2])
                    y1 = max(current[3][1] + current[3][3], box[1] + box[3])
                    current[3] = (x0, y0, x1 - x0, y1 - y0)
            elif current is not None:
                runs.append(tuple(current))
                current = None
        previous = frame
    if current is not None:
        runs.append(tuple(current))
    if len(means) < 2:
        sys.exit("motion: fewer than two frames")
    return runs, np.stack(means)  # frames × rows


# A transient is a thin thing: its neighbours this many rows out must hold still meanwhile — a
# cross-fading label or a scrolling list moves whole bands of rows, a seam or a hairline does not.
NEIGHBOUR_REACH = 3


def transients(means, flash_min, flash_max):
    """Rows that depart from their resting value for a short run and come back to it, alone."""
    frames, height = means.shape
    # Frame differs from the previous one, for every row at once: most rows never move and the
    # python scan below then skips them (an uncropped 3x recording is 2600 rows, nearly all still).
    departures = np.zeros(means.shape, dtype=bool)
    departures[1:] = np.abs(means[1:] - means[:-1]) > ROW_DELTA
    found = {}  # row → list of (start, end, delta)
    for y in (int(row) for row in np.nonzero(departures.any(axis=0))[0]):
        v = means[:, y]
        away = departures[:, y]
        i = 0
        while i < frames:
            if not away[i]:
                i += 1
                continue
            start = i
            base = v[start - 1] if start > 0 else v[start]
            # The run lasts while the row stays away from the value it left.
            j = start
            while j < frames and abs(v[j] - base) > ROW_DELTA:
                j += 1
            length = j - start
            if flash_min <= length <= flash_max and j < frames and isolated(means, y, start, j):
                found.setdefault(y, []).append((start, j - 1, float(v[start:j].mean() - base)))
            i = max(j, start + 1)
    return found


def isolated(means, y, start, end):
    """Whether the rows just outside a small band around `y` hold their value over the run."""
    height = means.shape[1]
    for n in (y - NEIGHBOUR_REACH, y + NEIGHBOUR_REACH):
        if n < 0 or n >= height:
            continue
        neighbour = means[:, n]
        base = neighbour[start - 1] if start > 0 else neighbour[start]
        if np.mean(np.abs(neighbour[start:end] - base) > ROW_DELTA) > 0.2:
            return False
    return True


def group_rows(found):
    """Adjacent rows flashing over overlapping frames read as one line: (start, end, [(row, delta)…])."""
    events = sorted((y, start, end, delta) for y, runs in found.items() for start, end, delta in runs)
    grouped = []
    for y, start, end, delta in events:
        for group in grouped:
            g_start, g_end, band = group
            if y - band[-1][0] <= 1 and start <= g_end and end >= g_start:
                group[0], group[1] = min(g_start, start), max(g_end, end)
                band.append((y, delta))
                break
        else:
            grouped.append([start, end, [(y, delta)]])
    return sorted(grouped, key=lambda g: (g[0], g[2][0][0]))


def fmt_rows(y0, y1, scale):
    if scale:
        return f"rows {y0}–{y1} px ({y0 / scale:.1f}–{(y1 + 1) / scale:.1f} pt)"
    return f"rows {y0}–{y1} px"


def dump_indices(reported):
    """The frames worth writing: the edges of every run, plus the frame just before it."""
    wanted = set()
    for start, end in reported:
        wanted.update({max(0, start - 1), start, end})
    return sorted(wanted)


def dump_from_dir(files, indices, out_dir, scale):
    for index in indices:
        im = Image.open(files[index])
        if scale and scale != 1:
            im = im.resize((round(im.width / scale), round(im.height / scale)), Image.LANCZOS)
        im.convert("RGB").save(out_dir / f"{frame_name(index)}.png")


def dump_from_video(path, fps, crop, indices, out_dir, scale):
    # One ffmpeg pass picking the wanted frames: `select` counts frames after `fps`, as we do.
    select = "+".join(f"eq(n\\,{i})" for i in indices)
    chain = f"{video_filter(fps, crop)},select='{select}'"
    if scale and scale != 1:
        # Device frames are 3x: a 1x dump costs an agent ~470 tokens to read instead of ~1500.
        chain += f",scale=iw/{scale:g}:ih/{scale:g}"
    staging = out_dir / ".motion-dump"
    shutil.rmtree(staging, ignore_errors=True)
    staging.mkdir(parents=True)
    subprocess.run(
        ["ffmpeg", "-v", "error", "-y", "-i", str(path), "-vf", chain,
         "-fps_mode", "passthrough", str(staging / "%05d.png")],
        check=True,
    )
    for written, index in zip(sorted(staging.glob("*.png")), indices):
        written.replace(out_dir / f"{frame_name(index)}.png")
    shutil.rmtree(staging, ignore_errors=True)


def main():
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("source", type=Path, help="a frames directory, or a video ffmpeg can read")
    parser.add_argument("--fps", type=float, default=60)
    parser.add_argument("--scale", type=float, default=0, help="pixels per point/dp (0: report pixels only)")
    parser.add_argument("--crop", default="", metavar="w:h:x:y", help="ffmpeg crop, pixels (video source only)")
    parser.add_argument("--flash-min", type=int, default=4, help="shortest run (frames) worth reporting")
    parser.add_argument("--flash-max", type=int, default=12, help="longest run (frames) still called a flash")
    parser.add_argument("--min-change", type=float, default=0.5, help="%% of pixels changed to count as movement")
    parser.add_argument("--dump", type=Path, help="write the frames the report names, downscaled to 1x")
    args = parser.parse_args()

    video = args.source.suffix.lower() in VIDEO_SUFFIXES
    files = []
    if video:
        if not args.source.exists():
            sys.exit(f"motion: no video {args.source}")
        if not shutil.which("ffmpeg") or not shutil.which("ffprobe"):
            sys.exit("motion: ffmpeg/ffprobe missing (brew install ffmpeg)")
        frames = video_frames(args.source, args.fps, args.crop)
    else:
        if args.crop:
            sys.exit("motion: --crop needs a video source (crop the frames with ffmpeg instead)")
        files = sorted(args.source.glob("*.png"))
        if len(files) < 2:
            sys.exit(f"motion: fewer than two frames in {args.source}")
        frames = dir_frames(files)

    runs, means = scan(frames, args.min_change)
    count, height = means.shape
    names = [file.stem for file in files] if files else [frame_name(i) for i in range(count)]
    ms = 1000 / args.fps
    print(f"{count} frames @ {args.fps:g} fps ({count * ms / 1000:.1f} s)")

    reported = []  # (start, end) of every run named below, for --dump

    print("\n## timeline (frames that move)")
    if not runs:
        print("(still)")
    for start, end, ratio, (x, y, w, h) in runs:
        area = f"x {x} y {y} w {w} h {h}"
        if args.scale:
            s = args.scale
            area += f" px = x {x / s:.0f} y {y / s:.0f} w {w / s:.0f} h {h / s:.0f} pt"
        print(f"{names[start]}–{names[end]}: {(end - start + 1) * ms:.0f} ms, up to {ratio:.0f} % of the picture, in {area}")
        reported.append((start, end))

    print(f"\n## transients (rows that leave their resting value for {args.flash_min}–{args.flash_max} frames and come back)")
    grouped = group_rows(transients(means, args.flash_min, args.flash_max))
    # A transition legitimately shakes every row for a few frames: keep the thin ones, drop the bands
    # taller than a tenth of the picture.
    shown = 0
    for start, end, band in grouped:
        y0, y1 = band[0][0], band[-1][0]
        if y1 - y0 + 1 > height / 10:
            continue
        delta = sum(d for _, d in band) / len(band)
        print(f"{fmt_rows(y0, y1, args.scale)}: {names[start]}–{names[end]} ({(end - start + 1) * ms:.0f} ms), Δ {delta:+.0f} levels")
        reported.append((start, end))
        shown += 1
    if shown == 0:
        print("(none)")

    if args.dump:
        indices = dump_indices(reported)
        args.dump.mkdir(parents=True, exist_ok=True)
        if indices:
            if video:
                dump_from_video(args.source, args.fps, args.crop, indices, args.dump, args.scale)
            else:
                dump_from_dir(files, indices, args.dump, args.scale)
        print(f"\ndumped {len(indices)} frames to {args.dump}")


if __name__ == "__main__":
    main()
