#!/usr/bin/env python3
"""What an mshot found, in one line, and remembered for `vysu report`.

    verdict.py <shots-dir> <capture> previous|baseline:<name>|new|skipped [--diff <file>|-] [--quiet]
               [--device <name>]

`<capture>` is the file name without .png (`android-home`). With `previous` or `baseline:<name>`,
`--diff` holds what diff.py printed (text mode) for the two captures; the line printed is

    vs previous: unchanged
    vs previous: 3 zones changed (0,120 393x80 · 12,400 200x40 · +1) · <marked png>

and `--quiet` records it without a word (--baseline prints diff.py's own lines, as it always did).
`new` (nothing to compare with) and `skipped` (--no-prev) only record. The record is the capture's
latest verdict, under `verdicts` in the folder's meta.json: `vysu report` reads it back, one line
per capture, and names the marked image of the latest change as the one to open.
"""

import argparse
import datetime
import json
import os
import re
import sys

ZONES_SHOWN = 3


def parse(text):
    """diff.py's text report → (changed zones count, zone boxes, marked path, size change)."""
    count, zones, marked, size = 0, [], None, None
    for line in text.splitlines():
        line = line.strip()
        m = re.match(r"size mismatch: baseline (\d+x\d+), current (\d+x\d+)", line)
        if m:
            size = "%s → %s" % (m.group(1), m.group(2))
            continue
        m = re.match(r"changed .* · (\d+) zones?$", line)
        if m:
            count = int(m.group(1))
            continue
        m = re.match(r"\d+\. x (\d+) y (\d+) w (\d+) h (\d+) px", line)
        if m:
            zones.append("%s,%s %sx%s" % m.groups())
            continue
        if line.startswith("marked:"):
            marked = line.split(":", 1)[1].strip()
    return count, zones, marked, size


def record(directory, capture, entry):
    path = os.path.join(directory, "meta.json")
    meta = {}
    if os.path.exists(path):
        try:
            meta = json.load(open(path))
        except ValueError:
            meta = {}
    entry["at"] = datetime.datetime.now().astimezone().isoformat(timespec="seconds")
    meta.setdefault("verdicts", {})[capture] = entry
    tmp = path + ".tmp"
    json.dump(meta, open(tmp, "w"), ensure_ascii=False, indent=1)
    os.replace(tmp, path)


def main():
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("shots")
    parser.add_argument("capture")
    parser.add_argument("vs")
    parser.add_argument("--diff", help="diff.py's text output, a file or - for stdin")
    parser.add_argument("--device", default="")
    parser.add_argument("--quiet", action="store_true")
    args = parser.parse_args()

    entry = {"device": args.device} if args.device else {}
    if args.vs in ("new", "skipped"):
        entry.update(vs=None, verdict="new" if args.vs == "new" else "not compared (--no-prev)")
        record(args.shots, args.capture, entry)
        return
    if args.vs != "previous" and not args.vs.startswith("baseline:"):
        sys.exit("verdict: vs must be previous, baseline:<name>, new or skipped (got %s)" % args.vs)

    text = ""
    if args.diff:
        text = sys.stdin.read() if args.diff == "-" else open(args.diff).read()
    count, zones, marked, size = parse(text)
    vs = "previous" if args.vs == "previous" else "baseline " + args.vs.split(":", 1)[1]
    if count:
        shown = " · ".join(zones[:ZONES_SHOWN]) + (" · +%d" % (count - ZONES_SHOWN) if count > ZONES_SHOWN else "")
        verdict = "%d zone%s changed" % (count, "s" if count > 1 else "")
        detail = "%s (%s)" % (verdict, shown) if shown else verdict
    else:
        verdict = detail = "unchanged"
    if size:
        detail = "size %s, %s" % (size, detail)
    entry.update(vs=vs, verdict=verdict, zones=zones[:ZONES_SHOWN], more=max(0, count - ZONES_SHOWN),
                 size=size, marked=marked if count else None)
    record(args.shots, args.capture, entry)
    if not args.quiet:
        print("  vs %s: %s%s" % (vs, detail, " · " + marked if count and marked else ""))


if __name__ == "__main__":
    main()
