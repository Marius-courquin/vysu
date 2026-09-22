#!/usr/bin/env python3
"""take.py — a vysu recording read back as data.

`events` turns the raw step rows vysu appends while it records into the take's `events.json`: the
contract the Remotion toolkit consumes (version 1, documented in the visual-check skill).
`draft` proposes a starting `cut.json` from that file and `motion.txt`, so an agent writes the
montage in words — chapters, holds, what to keep — and never in frames or coordinates.

  take.py events --dir <take> --rows <rows.tsv> --clip ios.mp4 --kind mobile --platform ios \\
                 --t-stop 1758480131.412 [--scale 3] [--viewport 1440x900]
  take.py draft  --dir <take> --take <name>
"""
import argparse
import datetime
import json
import os
import re
import shlex
import subprocess
import sys

ACTIONS = ("tap", "fill", "key", "go", "relaunch")
DEAD_GAP = 1.2      # no moving frame for longer than this and the clip is cut there
LEAD_IN = 0.3       # a segment opens just before the gesture that starts it
SETTLE = 0.4        # and closes just after the screen stops moving
HOLD = 2            # a `shot` is an anchor: the draft freezes on it that long


def probe(path):
    """fps, duration and pixel size of the clip — everything the header cannot guess."""
    out = subprocess.run(
        ["ffprobe", "-v", "error", "-select_streams", "v:0",
         "-show_entries", "stream=r_frame_rate,width,height:format=duration",
         "-of", "json", path],
        capture_output=True, text=True)
    if out.returncode != 0:
        sys.exit("take: ffprobe failed on %s: %s" % (path, out.stderr.strip().splitlines()[-1:] or ""))
    d = json.loads(out.stdout or "{}")
    stream = (d.get("streams") or [{}])[0]
    num, _, den = (stream.get("r_frame_rate") or "30/1").partition("/")
    fps = float(num) / float(den or 1)
    duration = float((d.get("format") or {}).get("duration") or 0)
    return round(fps, 3), round(duration, 3), int(stream.get("width") or 0), int(stream.get("height") or 0)


def parse_step(line, kind, platform, override):
    """One flow line → the verb the toolkit knows, and the label a chapter can be hung on."""
    try:
        words = shlex.split(line)
    except ValueError:
        words = line.split()
    head = (words[0] if words else "").lower()
    rest = words[1:]
    first = rest[0] if rest else ""
    label, extra = override or "", {}
    if head == "sleep":
        return "sleep", "", extra
    if head in ("tap", "click", "longpress"):
        return "tap", label or first, extra
    if head == "press":
        # `press <key>` on the web is a keystroke; on a device it is a tap, by selector or by point.
        if kind == "web":
            return "key", label or first, extra
        return "tap", label or ("" if re.match(r"^-?[\d.]+$", first) else first), extra
    if head == "fill":
        return "fill", label or first, extra
    if head == "go":
        return "go", first, extra
    if head == "shot":
        extra["file"] = "%s-%s.png" % ("web" if kind == "web" else platform, first)
        return "shot", first, extra
    if head in ("check", "viewport", "relaunch"):
        return head, first if head == "viewport" else "", extra
    return "other", label, extra


def target_of(raw, kind):
    """« x y » from a device press, « x y w h » from a web box. Absent is an answer, not a failure."""
    parts = raw.split()
    try:
        nums = [round(float(p)) for p in parts]
    except ValueError:
        return None
    if len(nums) == 2:
        return {"x": nums[0], "y": nums[1]}
    if len(nums) == 4:
        return {"x": nums[0], "y": nums[1], "w": nums[2], "h": nums[3]}
    return None


def cmd_events(args):
    clip = os.path.join(args.dir, args.clip)
    fps, duration, px_w, px_h = probe(clip)
    # The recorder starts asynchronously — simctl, screenrecord and the browser all take an unknown
    # moment to write their first frame — while its end is an instant we hold: the call that stops
    # it has returned. The take is therefore anchored on that end, t0 walking back by the clip's own
    # duration. Steps that ran before the first frame keep the negative seconds that says so.
    t0 = args.t_stop - duration
    if args.viewport:
        w, h = (int(v) for v in args.viewport.lower().split("x"))
        unit = "px"
    else:
        scale = args.scale or 1
        w, h, unit = round(px_w / scale), round(px_h / scale), "pt"

    steps = []
    for raw in open(args.rows).read().splitlines():
        if not raw.strip():
            continue
        cells = raw.split("\t")
        cells += [""] * (7 - len(cells))
        i, start, end, ok, target, override, line = cells[:7]
        verb, label, extra = parse_step(line, args.kind, args.platform, override)
        step = {"i": int(i), "line": line, "verb": verb}
        if label:
            step["label"] = label
        step["start"] = round(float(start) - t0, 2)
        step["end"] = round(float(end) - t0, 2)
        step["ok"] = ok != "false"
        step.update(extra)
        box = target_of(target, args.kind)
        if box:
            step["target"] = box
        steps.append(step)

    events = {
        "version": 1,
        "kind": args.kind,
        "platform": args.platform,
        "clip": args.clip,
        "fps": fps,
        "duration": duration,
        "size": {"w": w, "h": h, "unit": unit},
        "t0": datetime.datetime.fromtimestamp(t0).astimezone().isoformat(timespec="milliseconds"),
        "steps": steps,
    }
    with open(os.path.join(args.dir, "events.json"), "w") as f:
        json.dump(events, f, ensure_ascii=False, indent=1)
    print("events.json: %d step(s) · clip %s · %.1f s @ %g fps · %d×%d %s"
          % (len(steps), args.clip, duration, fps, w, h, unit))


def movements(path):
    """motion.txt's timeline, in clip seconds: when the picture moved, and for how long."""
    if not os.path.exists(path):
        return []
    text = open(path).read().splitlines()
    head = re.search(r"@\s*([\d.]+)\s*fps", text[0] if text else "")
    fps = float(head.group(1)) if head else 30.0
    spans = []
    for raw in text:
        m = re.match(r"^f(\d+)[–-]f(\d+):", raw)
        if m:
            spans.append((int(m.group(1)) / fps, (int(m.group(2)) + 1) / fps))
    return sorted(spans)


def clusters(spans, lo, hi):
    """The movement inside [lo, hi], dead time longer than DEAD_GAP dropped."""
    inside = [(max(a, lo), min(b, hi)) for a, b in spans if b > lo and a < hi]
    out = []
    for a, b in inside:
        if out and a - out[-1][1] <= DEAD_GAP:
            out[-1][1] = max(out[-1][1], b)
        else:
            out.append([a, b])
    return out


def cmd_draft(args):
    events = json.load(open(os.path.join(args.dir, "events.json")))
    duration = events.get("duration") or 0
    spans = movements(os.path.join(args.dir, "motion.txt"))
    meta = {}
    try:
        meta = json.load(open(os.path.join(args.dir, "meta.json")))
    except Exception:
        pass

    def segments(lo, hi):
        lo, hi = max(0.0, lo - LEAD_IN), min(duration, hi)
        found = clusters(spans, lo, hi + DEAD_GAP)
        if not found:
            return [{"from": round(lo, 2), "to": round(hi, 2)}] if hi - lo >= 0.2 else []
        out = []
        for a, b in found:
            a, b = max(lo, a - LEAD_IN), min(duration, b + SETTLE)
            if b - a >= 0.2:
                out.append({"from": round(a, 2), "to": round(b, 2)})
        return out

    keep, chapters, run = [], [], []
    def flush():
        if run:
            keep.extend(segments(run[0]["start"], run[-1]["end"]))
            del run[:]
    for step in events.get("steps", []):
        if step["verb"] in ACTIONS:
            run.append(step)
        elif step["verb"] == "sleep" and run:
            run.append(step)
        elif step["verb"] == "shot":
            flush()
            keep.append({"hold": "shot:%s" % step.get("label", ""), "seconds": HOLD})
            chapters.append({"at": "shot:%s" % step.get("label", ""), "kicker": "", "title": "", "body": ""})
        else:
            flush()
    flush()
    if not chapters:
        chapters = [{"at": "step:%d" % s["i"], "kicker": "", "title": "", "body": ""}
                    for s in events.get("steps", []) if s["verb"] in ACTIONS]

    cut = {
        "version": 1,
        "take": args.take,
        "formats": ["landscape", "portrait"],
        # The project's video theme, resolved by the engine: `.vysu/themes/<name>` first, then the
        # toolkit's own. Absent from the config, the neutral `default` theme is what renders.
        "theme": os.environ.get("VYSU_THEME") or "default",
        "lang": meta.get("lang") or "fr",
        "intro": {"title": re.sub(r"[-_]+", " ", args.take).strip().capitalize(), "subtitle": ""},
        "outro": {"title": "", "caption": ""},
        "keep": keep,
        "chapters": chapters,
        "milestones": [],
        "taps": [],
    }
    print(json.dumps(cut, ensure_ascii=False, indent=1))


def main():
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    sub = parser.add_subparsers(dest="command", required=True)

    ev = sub.add_parser("events")
    ev.add_argument("--dir", required=True)
    ev.add_argument("--rows", required=True)
    ev.add_argument("--clip", required=True)
    ev.add_argument("--kind", required=True, choices=["mobile", "web"])
    ev.add_argument("--platform", required=True)
    ev.add_argument("--t-stop", type=float, required=True)
    ev.add_argument("--scale", type=float, default=0)
    ev.add_argument("--viewport", default="")
    ev.set_defaults(func=cmd_events)

    dr = sub.add_parser("draft")
    dr.add_argument("--dir", required=True)
    dr.add_argument("--take", required=True)
    dr.set_defaults(func=cmd_draft)

    args = parser.parse_args()
    args.func(args)


if __name__ == "__main__":
    main()
