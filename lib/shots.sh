# shots.sh — the captures and what is read back from them: `shots` (one per viewport, diffed),
# `mshot` (mobile, 1x, --full stitched), `walk` (the one call behind « check this screen »),
# `report`, `sheet`, `mark`, `frame`, and the housekeeping — `prune` and `cache clear`.
# shellcheck shell=bash
# shellcheck disable=SC2153  # SHOTS, DIFF, COMPARE, STITCH and the rest are set in core.sh

# agent-device captures the viewport of a native app, never the screen: there is no full-page
# screenshot on mobile, so a long screen is walked through instead — a capture, a scroll of half a
# viewport, the next capture — until two captures come back byte-identical (the scroller is at the
# end) or --max is reached, and stitch.py puts the pieces back together under the name the single
# capture would have had. The pieces stay in `full-frames/`: a seam worth doubting is read there,
# and at 1x they cost next to nothing to keep.
mshot_full() { # platform dir shot step max top bottom → tall capture, stitch report in $MSHOT_STITCH
  local platform="$1" dir="$2" shot="$3" step="$4" max="$5" top="$6" bottom="$7"
  [ -f "$STITCH" ] || die "stitch.py missing ($STITCH)"
  [ -f "$DIFF" ] || die "diff.py missing ($DIFF)"
  local frames="$dir/full-frames"; rm -rf "$frames"; mkdir -p "$frames"
  local args=(); read -r -a args <<<"$(mcapture_args "$platform")"
  ad "$platform" screenshot "$frames/f00.png" "${args[@]}" >/dev/null
  MSHOT_PROBE="$frames/f00.png"   # the notch band is measured on a viewport, not on the tall image
  # A step has to leave two captures something in common — that overlap is what stitch.py locates
  # the next one by. What the gesture asks for is not what the content does: agent-device's scroll
  # stops being proportional past ~200 pt, where it becomes a flick that always lands the same
  # distance away (587 pt on a recent iPhone, whether --pixels says 250, 300 or 393), while 150
  # moved it by 101. Hence 150 pt by default on both platforms: asking for more buys no ground and
  # thins the evidence stitch.py aligns on — a list of near-identical rows matches at several
  # offsets, and `ambiguous` or dropped captures is what that looks like.
  [ -n "$step" ] || step=150
  local i n=0 prev="$frames/f00.png" cur ended=0
  for i in $(seq 1 $((max - 1))); do
    ad "$platform" scroll down --pixels "$step" --settle >/dev/null 2>&1 || {
      echo "vysu: $platform: scroll refused after $n step(s) — nothing scrollable on this screen?" >&2
      ended=1; break
    }
    n="$i"
    cur="$(printf '%s/f%02d.png' "$frames" "$i")"
    ad "$platform" screenshot "$cur" "${args[@]}" >/dev/null
    # The same picture twice: the scroller did not move, so the screen has nothing left to show.
    # By pixels, not by bytes — two captures of one still screen come back as different PNG files
    # (agent-device re-encodes each one) while being the very same image, and `cmp` would never
    # end the walk. diff.py answers with its exit code: 0 identical, 1 zones.
    if cmp -s "$prev" "$cur" || "$DIFF" "$prev" "$cur" >/dev/null 2>&1; then
      rm -f "$cur"; ended=1; break
    fi
    prev="$cur"
  done
  [ "$ended" = 1 ] || echo "vysu: mshot --full stopped at --max $max captures (the screen may be longer)" >&2
  # stitch.py finds the fixed bands itself, by taking the rows every capture has in common. A bar
  # drawn *over* the scroller has none — a shell that blurs the feed under its status bar and its
  # floating tab bar has those rows change with what scrolls beneath them, and the detection comes
  # back « top 0 px · bottom 0 px ». The overlap is then judged on blurred rows and no capture
  # matches: that is the screen to pass --top / --bottom for.
  local sargs=()
  [ -z "$top" ] || sargs+=(--top "$top")
  [ -z "$bottom" ] || sargs+=(--bottom "$bottom")
  MSHOT_STITCH="$("$STITCH" "$frames" --out "$shot" ${sargs[@]+"${sargs[@]}"} 2>&1)" || die "stitch.py: $MSHOT_STITCH"
  # Back to where the screen was found, so the next command does not start halfway down it.
  ad "$platform" scroll top --settle >/dev/null 2>&1 || {
    for i in $(seq 1 "$n"); do ad "$platform" scroll up --pixels "$step" --settle >/dev/null 2>&1 || true; done
  }
}

vysu_mshot() {
  local platform="${1:-}" name="${2:-}"; [ -n "$platform" ] && [ -n "$name" ] || die "usage: vysu mshot ios|android <name> [label] [--baseline <name>] [--full [--step 150] [--max 12] [--top <pt>] [--bottom <pt>]]"
  shift 2
  local label="screen"; case "${1:-}" in ''|--*) ;; *) label="$1"; shift;; esac
  local baseline="" full=0 step="" max=12 top="" bottom=""
  while [ $# -gt 0 ]; do
    case "$1" in
      --baseline) baseline="$2"; shift 2;;
      --full) full=1; shift;;
      --step) step="$2"; shift 2;;
      --max) max="$2"; shift 2;;
      --top) top="$2"; shift 2;;
      --bottom) bottom="$2"; shift 2;;
      *) die "vysu mshot: unknown option $1";;
    esac
  done
  local dir="$SHOTS/$name"; mkdir -p "$dir"
  local shot="$dir/$platform-$label.png"
  MSHOT_PROBE="$shot"; MSHOT_STITCH=""
  if [ "$full" = 1 ]; then
    mshot_full "$platform" "$dir" "$shot" "$step" "$max" "$top" "$bottom"
  else
    local args=(); read -r -a args <<<"$(mcapture_args "$platform")"
    ad "$platform" screenshot "$shot" "${args[@]}" >/dev/null
  fi
  echo "$shot"
  [ "$full" = 0 ] || printf '%s\n' "$MSHOT_STITCH" | sed 's/^/  /'
  local dev="$ANDROID_AVD"; [ "$platform" = android ] || dev="$IOS_DEVICE"
  local fullmeta=(); [ "$full" = 0 ] || fullmeta=(full=true)
  meta_write "$dir" kind=mobile platform="$platform" device="$dev" ${fullmeta[@]+"${fullmeta[@]}"} \
    "textsize=$(mstate_get "$platform" textsize normal)" "appearance=$(mstate_get "$platform" appearance light)" \
    "lang=$(mstate_get "$platform" lang "$(cfg LANG)")" \
    "mobile_sha=$(repo_sha "${MOBILE_DIR:-$VYSU_PROJECT_DIR}")"
  [ -n "$baseline" ] || return 0
  [ -f "$DIFF" ] || die "diff.py missing ($DIFF)"
  local base="$SHOTS/$baseline/$platform-$label.png"
  [ -f "$base" ] || die "no baseline capture $base"
  # Both captures are 1x, so the zones are already in points: no --scale to convert. The battery
  # corner is left out: agent-device repaints the clock and the bars, not the battery, and the
  # charging bolt animates — a 20x13 pt zone on every otherwise still screen. The band stops above
  # the app: 44 pt under a notch (content starts at 59), 20 pt on a home-button phone. Measured on
  # $MSHOT_PROBE — a viewport, which a --full capture no longer is, and whose aspect ratio is what
  # tells a notch from a home button. The band sits at the top of the tall image all the same.
  local ign_args=()
  [ "$platform" != ios ] || ign_args+=(--ignore "$(python3 -c "
import sys
from PIL import Image
im = Image.open(sys.argv[1])
print('%d,0,70,%d' % (im.width - 70, 44 if im.height > 2 * im.width else 20))" "$MSHOT_PROBE")")
  local out rc=0
  out="$("$DIFF" "$base" "$shot" --mark "$dir/$platform-$label-changed.png" ${ign_args[@]+"${ign_args[@]}"} 2>&1)" || rc=$?
  [ "$rc" -le 1 ] || die "diff.py: $out"
  printf '%s\n' "$out" | sed 's/^/  /'
  printf '%s\n' "$out" | awk -v l="$platform-$label" 'NR == 1 { print l ": " $0; next } { print "  " $0 }' >>"$dir/diff.txt"
}

vysu_shots() {
  local persona="${1:-}" name="${2:-}"; [ -n "$persona" ] && [ -n "$name" ] || die "usage: vysu shots <persona> <name> [--url <url>] [--sizes WxH,…] [--dark] [--full] [--no-expand] [--no-warm] [--freeze] [--lang <l>] [--ignore <css>]… [--baseline <name> | --baseline-url <url>]"
  shift 2
  local url="" sizes; sizes="$(cfg SIZES)"
  local dark=0 full="" baseline="" baseurl="" lang="" freeze=0 expand=1 warm=1
  local ignore=()
  while [ $# -gt 0 ]; do
    case "$1" in
      --url) url="$2"; shift 2;;
      --sizes) sizes="$2"; shift 2;;
      --dark) dark=1; shift;;
      --full) full="--full"; shift;;
      --no-expand) expand=0; shift;;
      --no-warm) warm=0; shift;;
      --freeze) freeze=1; shift;;
      --lang) lang="$2"; shift 2;;
      --ignore) ignore+=("$2"); shift 2;;
      --baseline) baseline="$2"; shift 2;;
      --baseline-url) baseurl="$2"; shift 2;;
      *) die "vysu shots: unknown option $1";;
    esac
  done
  [ -z "$baseline" ] || [ -z "$baseurl" ] || die "vysu shots: --baseline and --baseline-url are exclusive"
  [ -z "$baseline" ] || [ -d "$SHOTS/$baseline" ] || die "no baseline folder $SHOTS/$baseline"
  [ -z "$baseurl" ] || [ -n "$url" ] || die "vysu shots: --baseline-url needs --url (the page under test)"
  # « @ » is the shorthand for « the same path on the baseline origin »: a branch on localhost read
  # against the deployed main, without spelling the url out twice.
  if [ "$baseurl" = "@" ]; then
    local origin; origin="$(cfg BASELINE_ORIGIN)"
    [ -n "$origin" ] || die "vysu shots: --baseline-url @ needs VYSU_BASELINE_ORIGIN"
    baseurl="${origin%/}$(printf '%s' "$url" | sed -E 's#^https?://[^/]*##')"
  fi
  lang_check "$lang"
  # A page that scrolls the document already (a marketing site, a Storybook story) needs nothing
  # unfolded, and --no-expand is how a sticky section is seen where it sticks rather than at the top.
  [ -n "$full" ] || expand=0
  # Nothing below the fold to reveal without --full: the capture stops at the window either way.
  [ -n "$full" ] || warm=0
  local diffing=""; [ -z "$baseline$baseurl" ] || diffing=1
  # A diff taken on a page that still moves reads as a change: the baseline modes freeze by themselves.
  [ -z "$diffing" ] || { freeze=1; [ -f "$DIFF" ] || die "diff.py missing ($DIFF)"; }

  local dir="$SHOTS/$name"; mkdir -p "$dir"
  [ -z "$diffing" ] || : >"$dir/diff.txt"
  # The boxes of an --ignore selector are resolved viewport by viewport (a header is not the same
  # box at 360 and at 1440), inside the batch, and read back from its results.
  local ign_js=""
  if [ ${#ignore[@]} -gt 0 ]; then
    local sels; sels="$(printf '%s\n' "${ignore[@]}" | python3 -c 'import sys, json; print(json.dumps([l for l in sys.stdin.read().splitlines() if l]))')"
    local off="[0, 0]"; [ -z "$full" ] || off="[Math.round(scrollX), Math.round(scrollY)]"
    ign_js="/*vysubox*/$sels.flatMap(s => [...document.querySelectorAll(s)]).map(e => { const r = e.getBoundingClientRect(), o = $off; return [Math.round(r.x) + o[0], Math.round(r.y) + o[1], Math.round(r.width), Math.round(r.height)] })"
  fi

  local schemes="light"; [ "$dark" = 1 ] && schemes="light dark"
  local to_open=0; [ -z "$url" ] || to_open=1
  local changed=0 scheme size suffix label cur base line
  for scheme in $schemes; do
    suffix=""; [ "$scheme" = dark ] && suffix="-dark"
    if [ "$freeze" = 1 ]; then bcmd set media "$scheme" reduced-motion; else bcmd set media "$scheme"; fi
    if [ -n "$baseurl" ]; then
      # Both origins in the same batch and the same session, one login serving the two, and every
      # viewport captured before switching back: a navigation is the expensive part, not a resize.
      bopen "$baseurl" "$lang" "$freeze"
      for size in ${sizes//,/ }; do
        bcmd set viewport "${size%x*}" "${size#*x}"
        bsettle
        [ "$expand" = 0 ] || bexpand
        [ "$warm" = 0 ] || bwarm
        bcmd screenshot $full "$dir/${size}${suffix}-base.png"
        [ "$expand" = 0 ] || bunexpand
      done
      bopen "$url" "$lang" "$freeze"
    elif [ "$to_open" = 1 ]; then
      bopen "$url" "$lang" "$freeze"; to_open=0
    else
      bchrome "$freeze"
    fi
    for size in ${sizes//,/ }; do
      bcmd set viewport "${size%x*}" "${size#*x}"
      bsettle
      [ "$expand" = 0 ] || bexpand
      [ "$warm" = 0 ] || bwarm
      [ -z "$ign_js" ] || bcmd eval "$ign_js"
      bcmd screenshot $full "$dir/${size}${suffix}.png"
      [ "$expand" = 0 ] || bunexpand
    done
    local boxes=(); while IFS= read -r line; do boxes+=("$line"); done < <(brun "$persona" | bboxes)

    local idx=0
    for size in ${sizes//,/ }; do
      label="${size}${suffix}"; cur="$dir/${label}.png"
      local bx="${boxes[$idx]:-}"; idx=$((idx + 1))
      echo "$cur"
      [ -n "$diffing" ] || continue
      base="$SHOTS/$baseline/${label}.png"; [ -z "$baseurl" ] || base="$dir/${label}-base.png"
      [ -f "$base" ] || { echo "  (no baseline for $label)"; continue; }
      local ign_args=() b
      for b in $bx; do ign_args+=(--ignore "$b"); done
      local out rc=0
      out="$("$DIFF" "$base" "$cur" --mark "$dir/${label}-changed.png" ${ign_args[@]+"${ign_args[@]}"} 2>&1)" || rc=$?
      [ "$rc" -le 1 ] || die "diff.py: $out"
      printf '%s\n' "$out" | sed 's/^/  /'
      printf '%s\n' "$out" | awk -v l="$label" 'NR == 1 { print l ": " $0; next } { print "  " $0 }' >>"$dir/diff.txt"
      [ "$rc" = 0 ] || changed=$((changed + 1))
    done
  done
  # Back to the state the next command expects, and the language the app is actually left in.
  bcmd set media light
  bcmd set viewport 1440 900
  local read_lang applied=""
  read_lang="$(lang_read_js)"
  if [ -n "$read_lang" ]; then
    bcmd eval "$read_lang"
    applied="$(brun "$persona" | python3 -c 'import sys, json; rs = json.load(sys.stdin); print((rs[-1].get("result") or {}).get("result") or "")' 2>/dev/null || true)"
  else
    brun "$persona" | bboxes >/dev/null
  fi

  local ign_json='[]'; [ ${#ignore[@]} -eq 0 ] || ign_json="$(printf '%s\n' "${ignore[@]}" | python3 -c 'import sys, json; print(json.dumps([l for l in sys.stdin.read().splitlines() if l]))')"
  meta_write "$dir" kind=web persona="$persona" url="$url" \
    "baseline=${baseline:-null}" "baseline_url=${baseurl:-null}" "lang=${lang:-${applied:-$(cfg LANG)}}" \
    "schemes=$(python3 -c 'import sys, json; print(json.dumps(sys.argv[1].split()))' "$schemes")" \
    "sizes=$(python3 -c 'import sys, json; print(json.dumps(sys.argv[1].split(",")))' "$sizes")" \
    "freeze=$( [ "$freeze" = 1 ] && echo true || echo false )" "ignore=$ign_json" \
    "full=$( [ -n "$full" ] && echo true || echo false )" \
    "expand=$( [ "$expand" = 1 ] && echo true || echo false )" \
    "warm=$( [ "$warm" = 1 ] && echo true || echo false )" \
    "web_sha=$(repo_sha "${WEB_REPO:-$VYSU_PROJECT_DIR}")" \
    "web_branch=$(repo_branch "${WEB_REPO:-$VYSU_PROJECT_DIR}")" \
    "api=$(web_api "$persona")"

  if [ -n "$diffing" ]; then
    if [ "$changed" = 0 ]; then echo "sheet: skipped (identical)"
    else echo "changed: $changed viewport(s) → vysu sheet $name"; fi
  fi
}

# The one call behind « check this screen »: open it, collect what the browser complained about,
# capture every viewport, diff them, and print the report — six commands' worth in one.
vysu_walk() {
  local persona="${1:-}" name="${2:-}"; [ -n "$persona" ] && [ -n "$name" ] || die "usage: vysu walk <persona> <name> --url <url> [shots options…]"
  shift 2
  local args=() url=""
  while [ $# -gt 0 ]; do
    case "$1" in
      --url) url="$2"; args+=(--url "$2"); shift 2;;
      --check) shift;;   # accepted for symmetry: a walk always checks
      *) args+=("$1"); shift;;
    esac
  done
  [ -n "$url" ] || die "vysu walk: --url is required"
  # Up front rather than on the first `ab`: that one drops stderr, and with it the « waiting for » line.
  lock_take "$(resource_of "$persona")"
  # This walk answers for itself: whatever the session collected before it is not its business.
  ab "$persona" errors --clear >/dev/null 2>&1 || true
  ab "$persona" network requests --clear >/dev/null 2>&1 || true
  vysu_shots "$persona" "$name" ${args[@]+"${args[@]}"} >/dev/null
  vysu_check "$persona" --save "$name" >/dev/null
  vysu_report "$name"
}

# A shots folder read back in one screenful: what it is, what moved, what the browser complained
# about, and the single image worth spending tokens on. Everything else is named, not shown.
vysu_report() {
  local name="${1:-}"; [ -n "$name" ] || die "usage: vysu report <name> [--md]"
  local dir="$SHOTS/$name"; [ -d "$dir" ] || die "no shots folder $dir"
  python3 - "$dir" "${2:-}" <<'PY'
import json, os, sys

directory, flag = sys.argv[1], sys.argv[2]
lines, meta = [], {}
try:
    meta = json.load(open(os.path.join(directory, "meta.json")))
except Exception:
    pass

head = [meta.get("kind", "shots"), meta.get("persona"), meta.get("url") or meta.get("device")]
if meta.get("lang"):
    head.append("lang " + meta["lang"])
for key, label in (("sizes", "size"), ("schemes", "scheme")):
    if meta.get(key):
        head.append("%d %s%s" % (len(meta[key]), label, "s" if len(meta[key]) > 1 else ""))
for key in ("textsize", "appearance"):
    if meta.get(key):
        head.append("%s %s" % (key, meta[key]))
if meta.get("baseline_url"):
    head.append("vs " + meta["baseline_url"])
elif meta.get("baseline"):
    head.append("vs " + meta["baseline"])
sha = meta.get("web_sha") or meta.get("mobile_sha")
if sha:
    head.append("sha %s%s" % (sha, " (%s)" % meta["web_branch"] if meta.get("web_branch") else ""))
if meta.get("api"):
    head.append("api " + meta["api"])
if meta.get("date"):
    head.append(meta["date"][:16].replace("T", " "))
lines.append(" · ".join(str(h) for h in head if h))

# A recording: the one line saying the clip is machine-readable, so `vysu cut` is the next command.
if meta.get("events"):
    try:
        events = json.load(open(os.path.join(directory, "events.json")))
        lines.append("clip: %s · %.1f s · %d steps (events.json)"
                     % (events.get("clip", ""), events.get("duration") or 0, len(events.get("steps") or [])))
    except Exception:
        pass

# diff.txt: one « <label>: … » line per capture, its zones indented under it, « marked: <path> »
# naming the image to open.
status, marked, zones = {}, {}, []
label = None
for raw in open(os.path.join(directory, "diff.txt")).read().splitlines() if os.path.exists(os.path.join(directory, "diff.txt")) else []:
    if not raw.strip():
        continue
    if not raw.startswith(" "):
        label, _, rest = raw.partition(": ")
        status[label] = rest
    elif raw.strip().startswith("marked:"):
        marked[label] = raw.split("marked:", 1)[1].strip()
    else:
        zones.append((label, raw.rstrip()))
for lab in status:
    lines.append("%s: %s" % (lab, status[lab]))
zone_at = len(lines)
lines.extend("  %s %s" % (lab, text.strip()) for lab, text in zones)

# check.txt: « ## <what> » sections, « (none) » when there is nothing to say.
check = os.path.join(directory, "check.txt")
if os.path.exists(check):
    sections, current = {}, None
    for raw in open(check).read().splitlines():
        if raw.startswith("## "):
            current = raw[3:]
            sections[current] = []
        elif raw and raw != "(none)" and current:
            sections[current].append(raw)
    bad = [(what, found) for what, found in sections.items() if found]
    lines.append("check: clean" if not bad else "check: " + ", ".join("%d %s" % (len(f), w) for w, f in bad))
    for what, found in bad:
        lines.extend("  " + l[:160] for l in found[:3])

shots = sorted(f for f in os.listdir(directory) if f.endswith(".png") and not f.startswith(("sheet", "compare")))
compares = sorted(f for f in os.listdir(directory) if f.startswith("compare") and f.endswith(".png"))
diffed = any(f.endswith("-base.png") or f.endswith("-changed.png") for f in shots)
# Naming the pictures that did not move is what keeps an agent from opening them.
quiet = [f for f in shots if not f.endswith("-changed.png") and status.get(f[:-4], "identical").startswith("identical")]
if status and quiet:
    lines.append("identical, do not read: " + ", ".join(quiet))
read = [marked[lab] for lab in status if lab in marked]
if compares:
    # A compare page carries the marked image already: it replaces it rather than adding to it.
    read = [os.path.join(directory, f) for f in compares]
elif diffed:
    lines.append("compare: vysu sheet %s --compare" % os.path.basename(directory))
if not status and not compares:
    # Without a diff there is nothing to single out: the sheet is the one thing worth opening, and
    # four full-size captures are 7k tokens for the same picture.
    sheets = sorted(f for f in os.listdir(directory) if f.startswith("sheet") and f.endswith(".png"))
    read = [os.path.join(directory, f) for f in sheets]
    if not sheets:
        lines.append("sheet: vysu sheet %s" % os.path.basename(directory))
for path in read:
    lines.append("read: " + path)

if len(lines) > 25 and zones:  # zone detail is the only part worth losing
    keep = max(0, 25 - (len(lines) - len(zones)) - 1)
    if keep < len(zones):
        lines = (lines[:zone_at + keep]
                 + ["  … %d more zone(s) in %s/diff.txt" % (len(zones) - keep, directory)]
                 + lines[zone_at + len(zones):])
if flag == "--md":
    lines = ["```"] + lines + ["```"]
print("\n".join(lines))
PY
}

# The one image an agent reads back. An image is downsized to a 1568 px long edge first, so a tall
# sheet of everything comes back as unreadable thumbnails for the same 1800 tokens: every page fits
# inside that square (py/sheet.py picks the columns), and past --max captures the folder is split
# into pages of even size. A baseline sits next to its current; a marked diff and the capture an
# mshot replaced are left out unless --only names them. --strip is one row at one scale: a before
# and an after side by side. index.html keeps them all, for a human.
# Composed with Pillow, not rendered in the browser: it used to wait on a shared `render` session
# and come back blank when an image had not loaded yet.
vysu_sheet() {
  local name="${1:-}"; [ -n "$name" ] || die "usage: vysu sheet <name> [--cols N] [--max N] [--only \"<glob>,…\"] [--strip] [--open] [--compare [--against <name>]]"
  shift
  local cols="" max=6 want_open=0 compare=0 against="" only="" strip=0
  while [ $# -gt 0 ]; do
    case "$1" in
      --cols) cols="$2"; shift 2;;
      --max) max="$2"; shift 2;;
      --only) only="$2"; shift 2;;
      --strip) strip=1; shift;;
      --open) want_open=1; shift;;
      --compare) compare=1; shift;;
      --against) against="$2"; shift 2;;
      *) die "vysu sheet: unknown option $1";;
    esac
  done
  local dir="$SHOTS/$name"; [ -d "$dir" ] || die "no shots folder $dir"
  # A grid answers « what do these screens look like »; a comparison answers « what moved ». compare.py
  # owns both of its outputs: the triptych an agent reads, the slider page a human drags.
  if [ "$compare" = 1 ]; then
    [ -f "$COMPARE" ] || die "compare.py missing ($COMPARE)"
    local cargs=(--edge "$SHEET_EDGE")
    [ -z "$against" ] || { [ -d "$SHOTS/$against" ] || die "no shots folder $SHOTS/$against"; cargs+=(--against "$SHOTS/$against"); }
    local out; out="$("$COMPARE" "$dir" "${cargs[@]}")"
    printf '%s\n' "$out"
    [ "$want_open" != 1 ] || open "$(printf '%s\n' "$out" | grep '\.html$' | head -1)" 2>/dev/null || true
    return
  fi
  local sheet="$PY/sheet.py"; [ -f "$sheet" ] || die "sheet.py missing ($sheet)"
  local sargs=(--name "$name" --max "$max" --edge "$SHEET_EDGE")
  [ -z "$cols" ] || sargs+=(--cols "$cols")
  [ -z "$only" ] || sargs+=(--only "$only")
  [ "$strip" = 0 ] || sargs+=(--strip)
  # sheet.py says on stderr why it composed nothing (no capture, a glob that matches none).
  local out; out="$("$sheet" "$dir" "${sargs[@]}")" || exit 1
  printf '%s\n' "$out"
  [ "$want_open" = 1 ] && open "$(printf '%s\n' "$out" | head -1)" || true
}

vysu_mark() { python3 "$MARK" "$@"; }

# frame.py turns a capture or a clip into something to show: a drawn device frame around a screen,
# a 16:9 slide for a deck. A shots folder name or a file path, and whatever frame.py accepts.
vysu_frame() {
  local given="${1:-}"; [ -n "$given" ] || die "usage: vysu frame <name|file> [frame.py options…]"
  shift
  [ -f "$FRAME" ] || die "frame.py missing ($FRAME)"
  local target="$given"; [ -e "$target" ] || target="$SHOTS/$given"
  [ -e "$target" ] || die "no shots folder nor file « $given »"
  "$FRAME" "$target" "$@"
}

# Captures pile up: a month of them is gigabytes of PNGs nothing will ever read again. Age is the
# default sieve; --match names the folders of one task, whose captures are dead the moment it ends,
# whatever their age. Given both, a folder has to be old *and* named: « --match "*" --days 30 » is
# the plain prune.
vysu_prune() {
  local days="" dry=0 match=() g
  while [ $# -gt 0 ]; do
    case "$1" in
      --days) days="${2:-30}"; shift 2;;
      --dry-run) dry=1; shift;;
      # « --match "rv-* tv-*" » is two globs: split on spaces, with globbing off so the shell does
      # not expand them against the current directory before find ever sees them.
      --match)
        set -f
        for g in ${2:-}; do match+=("$g"); done
        set +f; shift 2;;
      *) die "vysu prune: unknown option $1";;
    esac
  done
  [ -n "$days" ] || [ ${#match[@]} -gt 0 ] || days=30
  [ -d "$SHOTS" ] || die "no shots folder $SHOTS"
  for g in ${match[@]+"${match[@]}"}; do
    case "$g" in
      # A glob that takes everything is the whole shots folder of every task running on this Mac.
      '' | '*') [ -n "$days" ] || die "vysu prune: --match « ${g:-} » takes every folder — give --days too to bound it";;
      */*) die "vysu prune: --match matches a folder name, not a path ($g)";;
    esac
  done
  # Rooted at $SHOTS, one level deep, and -name only ever sees a basename: nothing outside can match.
  local find_args=(-mindepth 1 -maxdepth 1 -type d)
  [ -z "$days" ] || find_args+=(-mtime "+$days")
  if [ ${#match[@]} -gt 0 ]; then
    local first=1
    find_args+=(\()
    for g in "${match[@]}"; do
      [ "$first" = 1 ] && first=0 || find_args+=(-o)
      find_args+=(-name "$g")
    done
    find_args+=(\))
  fi
  local what=""
  [ ${#match[@]} -eq 0 ] || what=" matching $(printf '%s ' "${match[@]}" | sed 's/ $//')"
  [ -z "$days" ] || what="$what older than $days days"
  local n=0 kb=0 d
  if [ "$dry" = 1 ]; then
    while IFS= read -r d; do
      [ -n "$d" ] || continue
      echo "$d"; n=$((n + 1)); kb=$((kb + $(du -sk "$d" | cut -f1)))
    done < <(find "$SHOTS" "${find_args[@]}")
    echo "would prune: $n folder(s)$what, $((kb / 1024)) MB freed ($SHOTS)"
    return
  fi
  local before after
  before="$(du -sk "$SHOTS" | cut -f1)"
  while IFS= read -r d; do
    [ -n "$d" ] || continue
    # `vysu video` copies the take's clip under the toolkit's public/ so staticFile() can serve it.
    # Nothing else ever reclaims that copy, and it is the take's whole clip: it goes with the take.
    rm -rf "$d" "$REMOTION/public/takes/$(basename "$d")"; n=$((n + 1))
  done < <(find "$SHOTS" "${find_args[@]}")
  after="$(du -sk "$SHOTS" | cut -f1)"
  echo "pruned: $n folder(s)$what, $(( (before - after) / 1024 )) MB freed ($SHOTS)"
}

vysu_cache() {
  [ "${1:-}" = clear ] || die "usage: vysu cache clear"
  local n=0 f
  for f in "$STATE"/ios-udid-* "$STATE"/android-serial-* "$STATE"/scale-* "$STATE"/state-*; do [ -e "$f" ] || continue; rm -f "$f"; n=$((n + 1)); done
  echo "cache: $n file(s) dropped (simulator UDIDs, emulator serials, device scales, applied text size / appearance / language)"
}
