#!/usr/bin/env python3
"""Point at what matters in a screenshot: boxes, labels, a dimmed surrounding, a padded crop, a zoom.

Usage: mark.py <in.png> --out <out.png> [--box x,y,w,h[:label]]... [--circle cx,cy,r[:label]]...
                [--grow 10] [--crop x,y,w,h | --crop auto] [--pad 32] [--zoom 2] [--dim] [--color e11d48]

Coordinates are pixels of the input image (a 1x screenshot: what `vysu box` prints for the web). `--crop
auto` crops around every box/circle with `--pad` margin; `--dim` darkens everything outside them;
`--zoom` upscales the result (small crops read better at 2x). `--grow` widens every shape by N px on
each side before drawing: element boxes hug the text, and a full-page capture (no scrollbar) lands a
few pixels off, so the dimming would otherwise bite the first letters. Pillow only — no other dependency.
"""

import sys

from PIL import Image, ImageDraw, ImageFont

COLOR = "#e11d48"


def parse_shape(spec):
    label = None
    if ":" in spec:
        spec, label = spec.split(":", 1)
    nums = [int(float(v)) for v in spec.split(",")]
    return nums, label


def font(size):
    for name in ("/System/Library/Fonts/Helvetica.ttc", "/System/Library/Fonts/SFNS.ttf", "DejaVuSans-Bold.ttf"):
        try:
            return ImageFont.truetype(name, size)
        except OSError:
            continue
    return ImageFont.load_default()


def render(im, shapes, grow=10, dim=False, color=COLOR, crop=None, pad=32, zoom=1.0):
    """Draw `shapes` — (kind, values, label), kind 'box' (x,y,w,h) or 'circle' (cx,cy,r) — on an RGBA image."""
    w, h = im.size
    stroke = max(3, round(min(w, h) / 220))
    rects = []
    for kind, v, _ in shapes:
        if kind == "box":
            x, y, bw, bh = v
            r = (x, y, x + bw, y + bh)
        else:
            cx, cy, rad = v
            r = (cx - rad, cy - rad, cx + rad, cy + rad)
        rects.append((max(0, r[0] - grow), max(0, r[1] - grow), min(w, r[2] + grow), min(h, r[3] + grow)))

    if dim and rects:
        overlay = Image.new("RGBA", im.size, (0, 0, 0, 120))
        cut = ImageDraw.Draw(overlay)
        for r in rects:
            cut.rounded_rectangle(r, radius=stroke * 3, fill=(0, 0, 0, 0))
        im = Image.alpha_composite(im, overlay)

    draw = ImageDraw.Draw(im)
    f = font(max(13, round(min(w, h) / 60)))
    placed = []
    for (kind, v, label), r in zip(shapes, rects):
        if kind == "box":
            draw.rounded_rectangle(r, radius=stroke * 3, outline=color, width=stroke)
        else:
            draw.ellipse(r, outline=color, width=stroke)
        if label:
            tw = draw.textlength(label, font=f) + 16
            th = f.size + 8
            lx, ly = r[0], r[1] - th - stroke
            if ly < 0:
                ly = r[3] + stroke
            # Labels of neighbouring shapes must not sit on each other: push down until clear.
            while any(lx < px1 and lx + tw > px0 and ly < py1 and ly + th > py0 for px0, py0, px1, py1 in placed):
                ly += th + 4
            placed.append((lx, ly, lx + tw, ly + th))
            draw.rounded_rectangle((lx, ly, lx + tw, ly + th), radius=6, fill=color)
            draw.text((lx + 8, ly + 3), label, fill="white", font=f)

    if crop == "auto" and rects:
        allr = rects + placed
        x0 = max(0, min(r[0] for r in allr) - pad)
        y0 = max(0, min(r[1] for r in allr) - pad)
        x1 = min(w, max(r[2] for r in allr) + pad)
        y1 = min(h, max(r[3] for r in allr) + pad)
        im = im.crop((x0, y0, x1, y1))
    elif isinstance(crop, list):
        x, y, cw, ch = crop
        im = im.crop((max(0, x), max(0, y), min(w, x + cw), min(h, y + ch)))

    if zoom != 1.0:
        im = im.resize((round(im.width * zoom), round(im.height * zoom)), Image.LANCZOS)
    return im


def main():
    args = sys.argv[1:]
    if not args or args[0].startswith("--"):
        sys.exit(__doc__)
    src = args.pop(0)
    out = None
    boxes, circles = [], []
    crop, pad, zoom, dim, color, grow = None, 32, 1.0, False, COLOR, 10
    while args:
        a = args.pop(0)
        if a == "--out":
            out = args.pop(0)
        elif a == "--box":
            boxes.append(parse_shape(args.pop(0)))
        elif a == "--circle":
            circles.append(parse_shape(args.pop(0)))
        elif a == "--crop":
            v = args.pop(0)
            crop = "auto" if v == "auto" else [int(float(x)) for x in v.split(",")]
        elif a == "--pad":
            pad = int(args.pop(0))
        elif a == "--grow":
            grow = int(args.pop(0))
        elif a == "--zoom":
            zoom = float(args.pop(0))
        elif a == "--dim":
            dim = True
        elif a == "--color":
            color = "#" + args.pop(0).lstrip("#")
        else:
            sys.exit(f"unknown option {a}\n{__doc__}")
    if not out:
        sys.exit("--out is required")

    im = Image.open(src).convert("RGBA")
    shapes = [("box", b, l) for b, l in boxes] + [("circle", c, l) for c, l in circles]
    im = render(im, shapes, grow=grow, dim=dim, color=color, crop=crop, pad=pad, zoom=zoom)

    im.convert("RGB").save(out)
    print(out, f"{im.width}x{im.height}")


if __name__ == "__main__":
    main()
