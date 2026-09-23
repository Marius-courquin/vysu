#!/usr/bin/env python3
"""Demo-ready exports: a drawn device frame around a capture, alone or on a pitch canvas.

    frame.py <in.png | in.mp4 | in.webm | folder> [--out <file | dir>]
             [--device auto|phone|phone-home|tablet|browser|none] [--preset framed|pitch]
             [--bg '#hex' | brand] [--title "…"] [--caption "…"] [--size 1920x1080] [--fps 30]

Bezels are drawn with Pillow, generic and brand-neutral, no image asset: `phone` a rounded bezel
with a dynamic-island pill, `phone-home` the same with a speaker band and a home button, `tablet`
a wider rounded bezel, `browser` a light window chrome (three dots, a URL pill carrying
`--caption`) above the capture, `none` nothing. The capture's own corners are masked to the
bezel's radius, so they disappear under it instead of poking out square.

`--device auto` reads the capture's shape, its scale included — a 3x device clip frames like the
phone it came from: portrait taller than 1.9:1 → `phone`; portrait 1.45–1.9:1 and no wider than
480 px once divided by its likely scale (2 past 600 px, 3 past 900) → `phone-home`; any other
portrait → `tablet`; landscape at least 700 px wide → `browser`; anything else → `none`.

`--preset framed` (default) writes the framed capture at its own pixel size plus the bezel, on a
transparent background (`--bg` fills it instead). `--preset pitch` centres it on a `--size` canvas
— 80 % of the height for a device, 90 % of the width for a browser — over `--bg` (default `brand`:
a soft gradient from the Nidz primary tint to white), `--title` top-left and `--caption` under it.

A video in gives an H.264 mp4 out at `--fps`: the frame is drawn once as two PNGs (the background,
then the bezel with the screen punched out) and ffmpeg overlays the scaled video between them.
A folder in frames every capture and clip it holds into `<folder>/demo/`.
"""

import argparse
import shutil
import subprocess
import sys
import tempfile
from pathlib import Path

import numpy as np
from PIL import Image, ImageDraw

sys.path.insert(0, str(Path(__file__).resolve().parent))
import mark  # noqa: E402 — sibling script, reused for its system-font search

PRIMARY_TINT = (230, 240, 255)  # tokens: primary.tint #E6F0FF
INK = (42, 30, 20)              # tokens: foreground #2A1E14
MUTED = (107, 91, 74)           # tokens: muted.foreground #6B5B4A
ACCENT = (250, 129, 30)         # tokens: secondary #FA811E
BEZEL = (13, 13, 15, 255)
GLASS = (62, 62, 70, 255)       # the hairline where a bezel meets the screen, and the hardware bits
CHROME = (237, 234, 228, 255)
CHROME_LINE = (214, 206, 195, 255)
DOT = (198, 190, 179, 255)
WHITE = (255, 255, 255, 255)

VIDEO_SUFFIXES = {".mp4", ".webm", ".mov", ".m4v"}
DEVICES = ["auto", "phone", "phone-home", "tablet", "browser", "none"]


def rgba(value):
    v = str(value).lstrip("#")
    if len(v) == 3:
        v = "".join(c * 2 for c in v)
    if len(v) == 6:
        v += "ff"
    if len(v) != 8:
        sys.exit(f"frame: --bg wants 'brand' or a #hex colour, got {value}")
    return tuple(int(v[i:i + 2], 16) for i in (0, 2, 4, 6))


def detect(w, h):
    """The frame a capture asks for, from its shape and its likely device scale."""
    if h > w:
        ratio = h / w
        if ratio >= 1.9:
            return "phone"
        scale = 3 if w >= 900 else 2 if w >= 600 else 1
        return "phone-home" if ratio >= 1.45 and w / scale <= 480 else "tablet"
    return "browser" if w >= 700 else "none"


def geometry(device, w, h):
    """(left, top, right, bottom) bezel margins, outer radius, screen radius, rounded screen corners."""
    if device == "phone":
        b = max(6, round(0.035 * w))
        r = round(0.115 * w)
        return (b, b, b, b), r + b, r, (True,) * 4
    if device == "phone-home":
        b = max(5, round(0.032 * w))
        return (b, round(0.135 * w), b, round(0.185 * w)), round(0.10 * w), 0, (True,) * 4
    if device == "tablet":
        b = max(8, round(0.05 * w))
        r = round(0.022 * w)
        return (b, b, b, b), r + b, r, (True,) * 4
    if device == "browser":
        c = min(56, max(26, round(0.030 * w)))
        s = max(1, round(w / 700))
        r = round(c * 0.30)
        # Only the bottom corners are rounded: the top two sit under the chrome bar.
        return (s, c, s, s), r, max(2, r - s), (False, False, True, True)
    return (0, 0, 0, 0), 0, 0, (True,) * 4


def draw_text(d, xy, text, font, fill, align="lt"):
    """Text placed by its ink box — no font anchor, which the bitmap fallback font refuses."""
    x, y = xy
    x0, y0, x1, y1 = d.textbbox((0, 0), text, font=font)
    if align[0] == "c":
        x -= (x1 - x0) / 2
    elif align[0] == "r":
        x -= x1 - x0
    if align[1] == "m":
        y -= (y1 - y0) / 2
    d.text((x - x0, y - y0), text, font=font, fill=fill)
    return x1 - x0, y1 - y0


def fit(d, text, font, width):
    if d.textlength(text, font=font) <= width:
        return text
    while text and d.textlength(text + "…", font=font) > width:
        text = text[:-1]
    return text + "…"


def browser_chrome(d, fw, side, chrome, caption):
    cy = chrome // 2
    rad = max(2, round(chrome * 0.10))
    x = side + round(chrome * 0.55)
    for _ in range(3):
        d.ellipse((x - rad, cy - rad, x + rad, cy + rad), fill=DOT)
        x += round(chrome * 0.40)
    ph = round(chrome * 0.52)
    x0, x1 = side + round(chrome * 2.1), fw - side - round(chrome * 0.6)
    if x1 - x0 < 2 * ph:
        return
    d.rounded_rectangle((x0, cy - ph // 2, x1, cy + ph // 2), radius=ph // 2,
                        fill=WHITE, outline=CHROME_LINE, width=1)
    if caption:
        f = mark.font(max(9, round(ph * 0.55)))
        draw_text(d, (x0 + ph * 0.45, cy), fit(d, caption, f, x1 - x0 - ph), f, MUTED, align="lm")


def home_details(d, fw, fh, margins, w):
    _, top, _, bottom = margins
    sw, sh = round(0.17 * w), max(3, round(0.016 * w))
    cx, cy = fw // 2, round(top * 0.55)
    d.rounded_rectangle((cx - sw // 2, cy - sh // 2, cx + sw // 2, cy + sh // 2), radius=sh // 2, fill=GLASS)
    rad = max(2, round(0.012 * w))
    dx = cx - sw // 2 - round(0.05 * w)
    d.ellipse((dx - rad, cy - rad, dx + rad, cy + rad), fill=GLASS)
    hr, hy = round(0.055 * w), fh - bottom // 2
    d.ellipse((cx - hr, hy - hr, cx + hr, hy + hr), outline=GLASS, width=max(2, round(0.006 * w)))


def overlay_of(device, w, h, caption=""):
    """A transparent canvas the size of the framed capture: bezel painted, screen punched out."""
    margins, r_out, r_in, corners = geometry(device, w, h)
    left, top, right, bottom = margins
    fw, fh = w + left + right, h + top + bottom
    im = Image.new("RGBA", (fw, fh), (0, 0, 0, 0))
    if device == "none":
        return im, margins, r_in, corners
    d = ImageDraw.Draw(im)
    screen = (left, top, left + w - 1, top + h - 1)
    if device == "browser":
        d.rounded_rectangle((0, 0, fw - 1, fh - 1), radius=r_out, fill=CHROME,
                            outline=CHROME_LINE, width=max(1, left))
    else:
        d.rounded_rectangle((0, 0, fw - 1, fh - 1), radius=r_out, fill=BEZEL)
    d.rounded_rectangle(screen, radius=r_in, corners=corners, fill=(0, 0, 0, 0))
    if device == "browser":
        browser_chrome(d, fw, left, top, caption)
        return im, margins, r_in, corners
    edge = max(1, round(min(margins) * 0.2))
    d.rounded_rectangle((left - edge, top - edge, screen[2] + edge, screen[3] + edge),
                        radius=r_in + edge, corners=corners, outline=GLASS, width=edge)
    if device == "phone":
        pw, ph = round(0.30 * w), round(0.088 * w)
        x, y = left + (w - pw) // 2, top + round(0.027 * w)
        d.rounded_rectangle((x, y, x + pw, y + ph), radius=ph // 2, fill=BEZEL)
    elif device == "phone-home":
        home_details(d, fw, fh, margins, w)
    else:
        rad = max(2, round(0.005 * w))
        cx, cy = fw // 2, top // 2
        d.ellipse((cx - rad, cy - rad, cx + rad, cy + rad), fill=GLASS)
    return im, margins, r_in, corners


def frame_image(im, device, caption=""):
    """The capture under its bezel, on a transparent canvas."""
    w, h = im.size
    overlay, (left, top, _, _), r_in, corners = overlay_of(device, w, h, caption)
    canvas = Image.new("RGBA", overlay.size, (0, 0, 0, 0))
    shot = im.convert("RGBA")
    mask = shot
    if r_in:
        mask = Image.new("L", (w, h), 0)
        ImageDraw.Draw(mask).rounded_rectangle((0, 0, w - 1, h - 1), radius=r_in, corners=corners, fill=255)
    canvas.paste(shot, (left, top), mask)
    return Image.alpha_composite(canvas, overlay)


def gradient(size, start, end):
    w, h = size
    x = np.linspace(0, 1, w, dtype=np.float32)[None, :]
    y = np.linspace(0, 1, h, dtype=np.float32)[:, None]
    t = (x + y) / 2
    t = (t * t * (3 - 2 * t))[..., None]  # smoothstep: the tint fades out without a visible band
    a, b = np.array(start, dtype=np.float32), np.array(end, dtype=np.float32)
    return Image.fromarray((a + (b - a) * t).astype(np.uint8), "RGB").convert("RGBA")


def background(size, bg):
    if bg == "brand":
        return gradient(size, PRIMARY_TINT, (255, 255, 255))
    return Image.new("RGBA", size, rgba(bg))


def pitch_layout(size, bg, title, caption, framed_size, device):
    """The pitch canvas without the device, plus the (x, y, w, h) box the framed device goes in."""
    width, height = size
    canvas = background(size, bg)
    d = ImageDraw.Draw(canvas)
    margin = round(width * 0.055)
    top = margin
    if title:
        tw, th = draw_text(d, (margin, margin), title, mark.font(round(height * 0.058)), INK)
        # A short brand rule under the headline: the one place the pitch says Nidz, the bezel being
        # deliberately anonymous.
        rule = round(height * 0.007)
        d.rounded_rectangle((margin, margin + th + round(height * 0.028),
                             margin + max(64, round(tw * 0.18)), margin + th + round(height * 0.028) + rule),
                            radius=rule // 2, fill=ACCENT)
        top = margin + th + round(height * 0.075)
    caption_font = mark.font(round(height * 0.024))
    bottom = height - margin - (round(height * 0.06) if caption else 0)
    box_w, box_h = width - 2 * margin, bottom - top
    fw, fh = framed_size
    target = 0.90 * width / fw if device == "browser" else 0.80 * height / fh
    scale = min(target, box_w / fw, box_h / fh)
    dw, dh = max(2, round(fw * scale)), max(2, round(fh * scale))
    dx, dy = (width - dw) // 2, top + (box_h - dh) // 2
    if caption:
        draw_text(d, (width // 2, dy + dh + round(height * 0.028)), caption, caption_font, MUTED, align="ct")
    return canvas, (dx, dy, dw, dh)


def probe(path):
    out = subprocess.run(
        ["ffprobe", "-v", "error", "-select_streams", "v:0",
         "-show_entries", "stream=width,height", "-of", "csv=p=0", str(path)],
        capture_output=True, text=True,
    )
    try:
        w, h = out.stdout.strip().split(",")[:2]
        return int(w), int(h)
    except ValueError:
        sys.exit(f"frame: ffprobe found no video stream in {path}\n{out.stderr.strip()}")


def render_video(src, out, device, preset, bg, title, caption, size, fps):
    if not shutil.which("ffmpeg") or not shutil.which("ffprobe"):
        sys.exit("frame: ffmpeg/ffprobe missing (brew install ffmpeg)")
    w, h = probe(src)
    if device == "auto":
        device = detect(w, h)
    overlay, margins, _, _ = overlay_of(device, w, h, caption)
    if preset == "pitch":
        back, (dx, dy, dw, dh) = pitch_layout(size, bg or "brand", title, caption, overlay.size, device)
        scale = dw / overlay.width
        left, top, right, bottom = (round(m * scale) for m in margins)
        bezel = Image.new("RGBA", back.size, (0, 0, 0, 0))
        bezel.paste(overlay.resize((dw, dh), Image.LANCZOS), (dx, dy))
        screen = (dx + left, dy + top, dw - left - right, dh - top - bottom)
    else:
        # H.264 has no alpha: the framed preset needs a real backdrop, white unless asked otherwise.
        fw, fh = overlay.size
        canvas_size = (fw + fw % 2, fh + fh % 2)
        back = background(canvas_size, bg or "#ffffff")
        bezel = Image.new("RGBA", canvas_size, (0, 0, 0, 0))
        bezel.paste(overlay, (0, 0))
        screen = (margins[0], margins[1], w, h)
    with tempfile.TemporaryDirectory() as tmp:
        back_png, bezel_png = Path(tmp) / "back.png", Path(tmp) / "bezel.png"
        back.convert("RGB").save(back_png)
        bezel.save(bezel_png)
        sx, sy, sw, sh = screen
        # `shortest=1` on the overlay that carries the video: without it the looped background
        # never ends and ffmpeg encodes for ever (`-shortest` does not reach inside filter_complex).
        chain = (f"[1:v]fps={fps:g},scale={sw}:{sh}[v];"
                 f"[0:v][v]overlay={sx}:{sy}:shortest=1[a];[a][2:v]overlay=0:0[o]")
        subprocess.run(
            ["ffmpeg", "-v", "error", "-y", "-loop", "1", "-framerate", f"{fps:g}", "-i", str(back_png),
             "-i", str(src), "-i", str(bezel_png), "-filter_complex", chain, "-map", "[o]", "-an",
             "-c:v", "libx264", "-crf", "20", "-preset", "veryfast", "-pix_fmt", "yuv420p",
             "-movflags", "+faststart", "-shortest", str(out)],
            check=True,
        )
    print(f"{out} {back.width}x{back.height} {device}")


def render_image(src, out, device, preset, bg, title, caption, size):
    im = Image.open(src)
    if device == "auto":
        device = detect(im.width, im.height)
    framed = frame_image(im, device, caption)
    if preset == "pitch":
        canvas, (dx, dy, dw, dh) = pitch_layout(size, bg or "brand", title, caption, framed.size, device)
        canvas.alpha_composite(framed.resize((dw, dh), Image.LANCZOS), (dx, dy))
        framed = canvas
    elif bg:
        framed = Image.alpha_composite(background(framed.size, bg), framed)
    framed.save(out)
    print(f"{out} {framed.width}x{framed.height} {device}")


def is_capture(path):
    """A file worth framing: a capture or a clip, not a sheet, a baseline, a diff, a compare page or
    the capture an mshot replaced."""
    name = path.name
    if path.suffix.lower() in VIDEO_SUFFIXES:
        return True
    if path.suffix.lower() != ".png" or not path.is_file():
        return False
    return not (name.startswith(("sheet", "compare", ".")) or name.endswith(("-changed.png", "-base.png", ".prev.png")))


def main():
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("source", type=Path, help="a capture, a clip, or a folder of them")
    parser.add_argument("--out", type=Path, help="output file (single input) or directory (folder input)")
    parser.add_argument("--device", default="auto", choices=DEVICES)
    parser.add_argument("--preset", default="framed", choices=["framed", "pitch"])
    parser.add_argument("--bg", help="'brand' (soft primary-tint gradient) or #rrggbb")
    parser.add_argument("--title", help="pitch only: headline, top-left")
    parser.add_argument("--caption", help="under the device, and in the browser URL pill")
    parser.add_argument("--size", default="1920x1080", help="pitch canvas, WxH")
    parser.add_argument("--fps", type=float, default=30)
    args = parser.parse_args()

    try:
        size = tuple(int(v) for v in args.size.lower().split("x"))
        if len(size) != 2:
            raise ValueError
    except ValueError:
        sys.exit(f"frame: --size wants WxH, got {args.size}")
    size = tuple(v + v % 2 for v in size)  # yuv420p wants even dimensions
    if not args.source.exists():
        sys.exit(f"frame: no {args.source}")

    jobs = []
    if args.source.is_dir():
        out_dir = args.out or args.source / "demo"
        out_dir.mkdir(parents=True, exist_ok=True)
        for src in sorted(args.source.iterdir()):
            if is_capture(src):
                video = src.suffix.lower() in VIDEO_SUFFIXES
                jobs.append((src, out_dir / f"{src.stem}-{args.preset}{'.mp4' if video else '.png'}", video))
        if not jobs:
            sys.exit(f"frame: no capture in {args.source}")
    else:
        video = args.source.suffix.lower() in VIDEO_SUFFIXES
        out = args.out or args.source.with_name(
            f"{args.source.stem}-{args.preset}{'.mp4' if video else '.png'}")
        if args.out and args.out.is_dir():
            out = args.out / f"{args.source.stem}-{args.preset}{'.mp4' if video else '.png'}"
        jobs.append((args.source, out, video))

    for src, out, video in jobs:
        out.parent.mkdir(parents=True, exist_ok=True)
        if video:
            render_video(src, out, args.device, args.preset, args.bg, args.title, args.caption, size, args.fps)
        else:
            render_image(src, out, args.device, args.preset, args.bg, args.title, args.caption, size)


if __name__ == "__main__":
    main()
