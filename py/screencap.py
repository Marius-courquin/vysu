#!/usr/bin/env python3
"""A device-pixel screen capture brought down to 1x: `adb exec-out screencap -p | screencap.py`.

    screencap.py --scale <px per dp> --out <capture.png> [<raw.png>]

The raw PNG comes on stdin (or from a file). `adb exec-out` may put a warning line before it, so
the image is read from its PNG signature on. It is resized by 1/scale (2.625 on a Pixel 8: 1080x2400
becomes 411x914 dp), the size every other vysu capture and box is counted in: a quarter of the
pixels, a quarter of the tokens, and the boxes of a diff come out in the dp a press is given in.
Exit 0 written, 2 no image.
"""

import argparse
import io
import sys

from PIL import Image

SIGNATURE = b"\x89PNG\r\n\x1a\n"


def main():
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("raw", nargs="?", help="the device-pixel PNG (default: stdin)")
    parser.add_argument("--scale", type=float, required=True, help="device pixels per dp / point")
    parser.add_argument("--out", required=True)
    args = parser.parse_args()

    data = open(args.raw, "rb").read() if args.raw else sys.stdin.buffer.read()
    start = data.find(SIGNATURE)
    if start < 0:
        print("screencap: no PNG in %d bytes of output" % len(data), file=sys.stderr)
        raise SystemExit(2)
    try:
        im = Image.open(io.BytesIO(data[start:]))
        im.load()
    except OSError as exc:
        print("screencap: %s" % exc, file=sys.stderr)
        raise SystemExit(2)
    im = im.convert("RGB")
    if args.scale > 1:
        size = (max(1, round(im.width / args.scale)), max(1, round(im.height / args.scale)))
        # reduce() averages whole pixel blocks first (cheap, no ringing), LANCZOS does the fraction.
        im = im.reduce(int(args.scale)) if float(args.scale).is_integer() else im.resize(size, Image.LANCZOS)
    im.save(args.out)


if __name__ == "__main__":
    main()
