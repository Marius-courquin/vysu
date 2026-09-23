#!/usr/bin/env python3
"""What a mobile screen says, read from agent-device's `snapshot -i --json`.

Usage: screen.py line <snap.json> [--prev <keys>] [--save <keys>] [--keyboard auto|yes|no] [--scale <n>]
       screen.py has <snap.json> <text> [--visible]
       screen.py sig <snap.json> [--geometry]
       screen.py field <snap.json> <label>
       screen.py editable <snap.json>

`line` is the one line an agent reads after each step: up to six labels in reading order, then the
node count, what changed since the previous snapshot (its keys saved by --save, read by --prev), the
keyboard and the focused field when the platform says so (`--scale`: the pixels per point of an
Android snapshot, whose boxes are in pixels where iOS gives points). `has` answers « is that text on screen »
the way `agent-device wait text` does (case-insensitive, contained in a label or a value), `--visible`
asking for its centre inside the viewport and nothing drawn over it (what `scroll-to` waits for).
`sig` prints the labels on screen as one string: two equal in a row is a screen at rest
(`--geometry` adds where each one sits: what tells a scroll that moved from one that did not).
`field` prints the centre of the text field a label names (its own label, else the field nearest
below a text holding it, else the one unlabelled field on screen, followed by « only »).
`editable` answers whether any text field is on screen at all.

Exit: 0 yes / printed, 1 no, 2 unreadable snapshot.
"""

import json
import re
import sys

MAX_LABELS = 6
MAX_LABEL_CHARS = 40
ICON_EDGE = 56  # pt / dp: a control this small is an icon, and its label is nothing anyone reads


def load_data(path):
    try:
        with open(path) as f:
            return (json.load(f) or {}).get("data") or {}
    except (OSError, ValueError):
        return {}


def load(path):
    nodes = load_data(path).get("nodes")
    return nodes if isinstance(nodes, list) else None


def rect(node):
    r = node.get("rect") or {}
    try:
        return float(r["x"]), float(r["y"]), float(r["width"]), float(r["height"])
    except (KeyError, TypeError, ValueError):
        return None


def kind(node):
    t = (node.get("type") or "").lower().rsplit(".", 1)[-1]
    if t in ("key", "keyboard") or "keyboard" in t:
        return "keyboard"
    if any(k in t for k in ("textfield", "edittext", "searchfield", "securetext", "textinput")) or node.get("editable"):
        return "field"
    if t in ("statictext", "textview", "text", "heading", "label"):
        return "text"
    if "image" in t and "button" not in t:
        return "image"
    return "other"


def viewport(nodes):
    # The roots are the windows: everything outside them is laid out but not on screen. iOS has
    # one (the app, full screen); Android has one per window, and a system dialog's buttons are
    # roots of their own.
    boxes = [rect(n) for n in nodes if n.get("depth", 0) == 0 and rect(n)] or [rect(n) for n in nodes if rect(n)]
    if not boxes:
        return None
    x0, y0 = min(b[0] for b in boxes), min(b[1] for b in boxes)
    return x0, y0, max(b[0] + b[2] for b in boxes) - x0, max(b[1] + b[3] for b in boxes) - y0


def is_root(node, nodes):
    # iOS puts the app itself at the top of the tree: it is not something on screen.
    return node.get("depth", 0) == 0 and (node.get("type") or "") == "Application"


def on_screen(node, vp, centre=False):
    # Android says it outright; iOS is judged by the box alone.
    if node.get("visibleToUser") is False:
        return False
    r = rect(node)
    if not r or not vp:
        return True
    x, y, w, h = r
    if centre:
        cx, cy = x + w / 2, y + h / 2
        return vp[0] <= cx <= vp[0] + vp[2] and vp[1] <= cy <= vp[1] + vp[3]
    return x < vp[0] + vp[2] and x + w > vp[0] and y < vp[1] + vp[3] and y + h > vp[1]


def clean(text):
    return " ".join(str(text or "").split()).strip(" ,")


# iOS names its scroll indicators in the system's language (« Barre de défilement verticale,
# 2 pages », « Vertical scroll bar, 1 page ») and gives them a percentage for a value: chrome.
PAGES = re.compile(r",\s*\d+\s+pages?$", re.I)


def scroll_indicator(node):
    return PAGES.search(clean(node.get("label"))) or clean(node.get("value")).endswith("%")


def keyboard_nodes(nodes):
    """The ids of the keyboard and of everything drawn with it (its keys, the prediction bar, the
    « next keyboard » and dictation buttons): iOS hosts all of it in a window of its own, which is
    left out whole. Without a window to go by, only the keyboard's own subtree is."""
    by_index = {n.get("index"): n for n in nodes if n.get("index") is not None}
    tops = set()
    for n in nodes:
        if kind(n) != "keyboard":
            continue
        cur = n
        while True:
            parent = by_index.get(cur.get("parentIndex"))
            if parent is None or parent.get("depth", 0) == 0:
                break
            cur = parent
        top = cur if (cur.get("type") or "").lower() == "window" else n
        tops.add(id(top))
    if not tops:
        return set()
    out = set()
    for n in nodes:
        cur, seen = n, 0
        while cur is not None and seen < 64:
            if id(cur) in tops:
                out.add(id(n))
                break
            cur, seen = by_index.get(cur.get("parentIndex")), seen + 1
        if kind(n) == "keyboard":
            out.add(id(n))
    return out


def screen_nodes(nodes):
    kb = keyboard_nodes(nodes)
    return [n for n in nodes if not is_root(n, nodes) and id(n) not in kb]


def keyboard_up(nodes, vp):
    # A hardware keyboard leaves the software one laid out below the screen: only one that
    # overlaps the viewport is up.
    return any(kind(n) == "keyboard" and on_screen(n, vp) for n in nodes)


def summary_labels(nodes, vp, scale):
    area = (vp[2] * vp[3]) if vp else 0
    picked = []
    for n in screen_nodes(nodes):
        label = clean(n.get("label"))
        if not label or not re.search(r"[^\W\d_]", label) or scroll_indicator(n):
            continue
        k = kind(n)
        # Two letters are an avatar's initials or a badge, unless something can be pressed there (OK).
        if len(label) < 3 and k in ("text", "other") and "button" not in (n.get("type") or "").lower():
            continue
        if k == "image" or not on_screen(n, vp):
            continue
        # A bar names itself (« Barre d'onglets », « Tab Bar »): its tabs say more, and come later.
        if re.search(r"(tab|tool|nav\w*)[-_ ]?bar", (n.get("type") or "").lower()):
            continue
        r = rect(n)
        if r:
            # A wrapper the size of the screen names the screen's container, not something read.
            if area and r[2] * r[3] >= 0.8 * area:
                continue
            if k not in ("text", "field") and max(r[2], r[3]) <= ICON_EDGE * scale:
                continue
        picked.append((round((r[1] if r else 0) / (4 * scale)), r[0] if r else 0, label))
    picked.sort(key=lambda p: (p[0], p[1]))
    out = []
    for _, _, label in picked:
        if label in out:
            continue
        out.append(label)
        if len(out) == MAX_LABELS:
            break
    return [l if len(l) <= MAX_LABEL_CHARS else l[: MAX_LABEL_CHARS - 1].rstrip() + "…" for l in out]


def keys(nodes):
    return ["%s|%s|%s" % ((n.get("type") or ""), clean(n.get("label")), n.get("identifier") or "") for n in screen_nodes(nodes)]


def delta(prev, cur):
    left = list(prev)
    added = 0
    for k in cur:
        if k in left:
            left.remove(k)
        else:
            added += 1
    return added, len(left)


def focused(nodes):
    # Android names the focused field; its label is then what it holds (the hint only while it is
    # empty), and a password field is named as one rather than read out.
    for n in screen_nodes(nodes):
        if n.get("focused") and kind(n) == "field":
            if n.get("password"):
                return "password"
            return clean(n.get("label"))[:MAX_LABEL_CHARS] or clean(n.get("identifier")) or "field"
    return ""


def cmd_line(path, prev, save, keyboard, scale):
    nodes = load(path)
    if nodes is None:
        print("screen: (nothing readable)")
        return 2
    vp = viewport(nodes)
    labels = summary_labels(nodes, vp, scale)
    cur = keys(nodes)
    facts = ["%d nodes" % len(cur)]
    if prev:
        try:
            with open(prev) as f:
                before = [l.rstrip("\n") for l in f if l.strip()]
            added, removed = delta(before, cur)
            facts.append("+%d −%d" % (added, removed))
        except OSError:
            pass
    if save:
        with open(save, "w") as f:
            f.write("\n".join(cur) + "\n")
    if keyboard == "yes" or (keyboard == "auto" and keyboard_up(nodes, vp)):
        facts.append("keyboard")
    field = focused(nodes)
    if field:
        facts.append('focus "%s"' % field)
    # A notification shade, a permission prompt, an « app not responding » dialog: what the tree
    # shows is not the app, and the step that follows has to deal with that first.
    if (load_data(path).get("androidSnapshot") or {}).get("systemSurfaceOnly"):
        facts.append("system dialog over the app")
    print("screen: %s (%s)" % (" · ".join(labels) or "(no label)", ", ".join(facts)))
    return 0


def matches(node, needle):
    return any(needle in clean(node.get(k)).casefold() for k in ("label", "value"))


def cmd_has(path, text, visible):
    nodes = load(path)
    if nodes is None:
        return 2
    vp = viewport(nodes)
    needle = clean(text).casefold()
    for n in screen_nodes(nodes):
        if not matches(n, needle):
            continue
        if not visible and on_screen(n, vp):
            return 0
        # iOS marks what a bar or a sheet is drawn over: it is on screen, not reachable.
        if visible and on_screen(n, vp, centre=True) and "covered" not in (n.get("presentationHints") or []):
            return 0
    return 1


def cmd_sig(path, geometry):
    nodes = load(path)
    if nodes is None:
        return 2
    vp = viewport(nodes)
    parts = []
    for n in screen_nodes(nodes):
        if not on_screen(n, vp):
            continue
        part = clean(n.get("label"))
        # Where things sit, too: a scroll moves every row and may leave the same ones on screen.
        if geometry and rect(n):
            part += "@%d,%d" % (round(rect(n)[0]), round(rect(n)[1]))
        parts.append(part)
    print("\x1f".join(sorted(parts)))
    return 0


def centre(node):
    x, y, w, h = rect(node)
    return "%d %d" % (round(x + w / 2), round(y + h / 2))


def cmd_field(path, label):
    nodes = load(path)
    if nodes is None:
        return 2
    vp = viewport(nodes)
    needle = clean(label).casefold()
    fields = [n for n in screen_nodes(nodes) if kind(n) == "field" and rect(n) and on_screen(n, vp)]
    for n in fields:
        if matches(n, needle) or needle in clean(n.get("identifier")).casefold():
            print(centre(n))
            return 0
    # A form label is a text of its own above the field (« E-mail », then the box): the nearest
    # field starting below it, overlapping it horizontally, is the one it names.
    best = None
    for t in screen_nodes(nodes):
        if kind(t) == "field" or not rect(t) or not matches(t, needle):
            continue
        tx, ty, tw, th = rect(t)
        for f in fields:
            fx, fy, fw, fh = rect(f)
            if fy + fh / 2 < ty or fx > tx + tw or fx + fw < tx:
                continue
            gap = fy - ty
            if best is None or gap < best[0]:
                best = (gap, f)
    if best:
        print(centre(best[1]))
        return 0
    # iOS does not hand a text input's placeholder to the tree: « Rechercher une conversation » is
    # on screen and nowhere in the snapshot. With one field on screen there is nothing to confuse it
    # with, and the caller says which one it took.
    if len(fields) == 1 and not clean(fields[0].get("label")):
        print(centre(fields[0]) + " only")
        return 0
    return 1


def cmd_editable(path):
    nodes = load(path)
    if nodes is None:
        return 2
    vp = viewport(nodes)
    return 0 if any(kind(n) == "field" and on_screen(n, vp) for n in screen_nodes(nodes)) else 1


def main(argv):
    if len(argv) < 3:
        sys.stderr.write(__doc__)
        return 2
    cmd, path, rest = argv[1], argv[2], argv[3:]
    if cmd == "line":
        opts = {"--prev": "", "--save": "", "--keyboard": "auto", "--scale": "1"}
        while rest:
            if rest[0] not in opts or len(rest) < 2:
                sys.stderr.write("screen.py line: unknown option %s\n" % rest[0])
                return 2
            opts[rest[0]] = rest[1]
            rest = rest[2:]
        try:
            scale = float(opts["--scale"]) or 1.0
        except ValueError:
            scale = 1.0
        return cmd_line(path, opts["--prev"], opts["--save"], opts["--keyboard"], scale)
    if cmd == "has" and rest:
        return cmd_has(path, rest[0], "--visible" in rest[1:])
    if cmd == "sig":
        return cmd_sig(path, "--geometry" in rest)
    if cmd == "field" and rest:
        return cmd_field(path, rest[0])
    if cmd == "editable":
        return cmd_editable(path)
    sys.stderr.write(__doc__)
    return 2


if __name__ == "__main__":
    sys.exit(main(sys.argv))
