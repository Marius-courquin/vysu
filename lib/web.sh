# web.sh — everything that goes through agent-browser: one session per persona, the batch a whole
# capture run is queued into, the JS a page needs before it can be captured (devtools hidden,
# animations frozen, inner scrollers unfolded, the document warmed up), and the web verbs a flow
# is written in — go / click / fill / shot / check — plus `check`, `box` and `lang`.
# shellcheck shell=bash
# shellcheck disable=SC2034  # EV_TARGET is read by core.sh (ev_log)
# shellcheck disable=SC2153  # SHOTS, STATE, BATCH and the rest are set in core.sh

# agent-browser announces « restore: loaded; save: saved » on stderr once per call: a dozen
# identical lines for one flow, and nothing an agent can act on. Dropped here rather than at every
# call site, so anything else it has to say — and its exit code — still comes through. A file
# rather than a process substitution: an `ab` inside a command substitution must not have its
# stderr land after the command that produced it.
ab_quiet() { # <command…> — run it, with that one line filtered out of its stderr
  local err="$STATE/.ab-err-$$" rc=0
  mkdir -p "$STATE"
  "$@" 2>"$err" || rc=$?
  grep -Ev '^\[agent-browser\] (restore|save):' "$err" >&2 || true
  rm -f "$err"
  return "$rc"
}
session_of() { printf '%s-%s' "$(cfg PROJECT)" "$1"; }
ab() { lock_take "web-$(slug "$1")"; ab_quiet agent-browser --session "$(session_of "$1")" --restore "${@:2}"; }
# The primitive a connector drives the browser with: the same session, the same lock, no batch.
web() { ab "$@"; }
# The first visible button among several names: a label differs by language and by version, and a
# connector names what it expects to see rather than a selector.
web_click_any() { # persona "<name>" "<name>"…
  local persona="$1"; shift
  local name
  for name in "$@"; do
    [ -n "$name" ] || continue
    ab "$persona" find role button click --name "$name" >/dev/null 2>&1 && return 0
  done
  return 1
}
vysu_web_session() { agent-browser session list 2>/dev/null | grep -q "$(session_of "$1")\$"; }

# One process for a whole sequence instead of one per step: an agent-browser call costs ~0.3 s of
# node start-up, a capture run costs a dozen of them. Commands are queued with bcmd (arguments
# separated by tabs) and handed over as JSON on stdin, so a CSS selector or a block of JS never
# meets the shell's nor the command parser's quoting rules.
# The queue is a file, not a variable: brun is called inside a command substitution more often
# than not, and a variable emptied there would come back full in the parent shell.
bcmd() { local IFS=$'\t'; mkdir -p "$STATE"; printf '%s\n' "$*" >>"$BATCH"; }
brun() { # persona → the batch results as JSON, the queue emptied
  lock_take "web-$(slug "$1")"
  local json; json="$(python3 -c 'import sys, json; print(json.dumps([l.split("\t") for l in open(sys.argv[1]).read().splitlines() if l]))' "$BATCH")"
  rm -f "$BATCH"
  printf '%s' "$json" | ab_quiet agent-browser --session "$(session_of "$1")" --restore batch --json || true
}
# Reads those results: a failed step stops vysu here with what agent-browser said, and every
# « /*vysubox*/ » eval — the boxes an --ignore selector resolved to — comes back as one line. A wait
# that timed out is not a failure: the dashboard of a live app never goes network-idle, and the
# capture after it is still the picture that was asked for (hence no --bail either).
# « /*vysuexpand*/ » and « /*vysuwarm*/ » go to stderr instead: one line per viewport saying what
# the expansion and the warm-up scroll did, and stdout stays one line per --ignore eval, which is
# what the caller indexes by viewport.
bboxes() {
  python3 -c '
import sys, json
try:
    rs = json.loads(sys.stdin.read() or "[]")
except ValueError:
    sys.exit("vysu: agent-browser batch returned nothing")
for r in rs:
    if not r.get("success") and (r.get("command") or [""])[0] != "wait":
        sys.exit("vysu: « %s » failed: %s" % (" ".join(r.get("command") or []), r.get("error")))
    c = r.get("command") or []
    if len(c) > 1 and c[0] == "eval" and c[1].startswith("/*vysubox*/"):
        print(" ".join("%d,%d,%d,%d" % tuple(b) for b in ((r.get("result") or {}).get("result") or [])))
    if len(c) > 1 and c[0] == "eval" and c[1].startswith("/*vysuexpand*/"):
        n, h = ((r.get("result") or {}).get("result") or [0, 0])
        print("expand: %d pane(s) unfolded, document %d px" % (n, h), file=sys.stderr)
    if len(c) > 1 and c[0] == "eval" and c[1].startswith("/*vysuwarm*/"):
        n = (r.get("result") or {}).get("result") or 0
        print("warm: %s" % ("%d scroll step(s)" % n if n else "skipped, the page fits the viewport"), file=sys.stderr)
'
}

# Which API the page actually talked to. The state file only knows about a dev server vysu started
# itself, and one launched by hand outside vysu makes it lie: the session's own requests do not.
# The last request, not the first: with --baseline-url the baseline origin is captured first, and
# the page under test — the one the meta is about — is always the one captured last.
web_api() { # persona
  local pattern host pair
  pattern="$(cfg API_PATTERN)"
  host="$(ab "$1" network requests 2>/dev/null | grep -oE "https?://[^/ ]+$pattern" | tail -1 | sed -E "s#^https?://##; s#$pattern\$##")"
  if [ -z "$host" ]; then cat "$STATE/web.api" 2>/dev/null || echo unknown; return; fi
  # `host=label` pairs: what a report calls that API, rather than the host an agent has to decode.
  for pair in $(cfg API_HOSTS); do
    [ "${pair%%=*}" = "$host" ] || continue
    printf '%s\n' "${pair#*=}"; return
  done
  printf '%s\n' "$host"
}

# The language the web app is in, and where it is kept. An app that has no such key says so: `lang`
# dies rather than writing a localStorage entry nothing reads.
lang_read_js() { # [prefix] → a JS expression evaluating to the stored language, or nothing
  local key default; key="$(cfg LANG_STORAGE_KEY)"; default="$(cfg LANG)"
  [ -n "$key" ] || return 0
  printf '%s(() => { try { return localStorage.getItem("%s") || "%s" } catch (e) { return "%s" } })()' \
    "${1:-}" "$key" "$default" "$default"
}
WEB_LANG=""
web_lang_init() { # persona — read once per flow: only `click t:<key>` needs it
  [ -z "$WEB_LANG" ] || return 0
  local js; js="$(lang_read_js)"
  if [ -n "$js" ]; then
    WEB_LANG="$(ab "$1" eval "$js" 2>/dev/null | tail -1 | tr -d '"')"
  fi
  WEB_LANG="${WEB_LANG:-$(cfg LANG)}"
}

# Dev-only devtools badges sit over a corner of the page; they are not the UI under review.
NO_DEVTOOLS="document.querySelectorAll('.tsqd-parent-container, button[aria-label*=\"Devtools\"]').forEach(e => { e.style.display = 'none' })"
# --freeze: a blinking caret or a spinner mid-turn is the whole difference between « identical » and
# « 0.2 % changed » on a page nothing touched.
FREEZE_CSS='*,*::before,*::after{animation:none!important;transition:none!important;caret-color:transparent!important}'
# An app shell that never scrolls the document — a full-height grid whose content scrolls inside one
# pane — brings back the first screen and nothing else from `screenshot --full`, which only ever
# grows to the document. Before a --full capture, every in-flow pane that scrolls is let go of its
# height, along with its ancestors up to <html>, and the document grows to the real content.
# A pane inside a `position: fixed` subtree is skipped: a toast, a drawer, a devtools panel parked
# below the fold never add to the document, and expanding one only paints it over the page.
# Under 200 px tall or laid out nowhere (getClientRects), it is chrome, not the screen under review.
EXPAND_JS='/*vysuexpand*/(() => { const floats = e => { for (let n = e; n; n = n.parentElement) if (getComputedStyle(n).position === "fixed") return true; return false }; const panes = [...document.querySelectorAll("body *")].filter(e => e.clientHeight >= 200 && e.scrollHeight > e.clientHeight + 20 && /(auto|scroll)/.test(getComputedStyle(e).overflowY) && e.getClientRects().length && !floats(e)); const marked = new Set(); for (const p of panes) for (let e = p; e && e !== document.documentElement; e = e.parentElement) marked.add(e); marked.forEach(e => e.setAttribute("data-vysu-expand", "")); const s = document.createElement("style"); s.id = "vysu-expand"; s.textContent = "html,body,[data-vysu-expand]{height:auto!important;max-height:none!important;min-height:0!important;overflow:visible!important}"; document.head.appendChild(s); return [panes.length, document.scrollingElement.scrollHeight] })()'
# A page that reveals its sections as they cross the viewport — an IntersectionObserver, a lazy
# image, a counter that counts up — paints each of them once, on the way past. A --full capture of a
# page just opened therefore holds the sections above the fold finished and the ones below
# half-drawn, and two runs of the same page disagree on which. Before such a capture the document is
# walked once, a viewport at a time, leaving frames in between for the observers to fire, and left
# back at the top. A page that fits the viewport has nothing to reveal and is skipped.
WARM_JS='/*vysuwarm*/(async () => { const d = document.scrollingElement, step = innerHeight; if (d.scrollHeight <= step + 8) return 0; const frame = () => new Promise(r => requestAnimationFrame(() => requestAnimationFrame(r))); let n = 0; for (let y = 0; y < d.scrollHeight; y += step) { d.scrollTo({ top: y, behavior: "instant" }); await frame(); await new Promise(r => setTimeout(r, 60)); n++ } d.scrollTo({ top: 0, behavior: "instant" }); await frame(); return n })()'
# Back to a normal layout, so the next viewport measures its own panes rather than the expanded ones.
RESTORE_JS='document.getElementById("vysu-expand")?.remove(); document.querySelectorAll("[data-vysu-expand]").forEach(e => e.removeAttribute("data-vysu-expand"))'

# What a page needs before it can be captured, spent on a navigation only: a viewport change starts
# none, it just has to be given time to repaint (bsettle). The cap on networkidle is what makes it
# usable at all — a page that never goes quiet (an open stream, a poll) would otherwise hold the
# batch for 60 s, and agent-browser calls the wait a success either way, so --bail stays safe.
bsettle() { bcmd wait 300; }
# What the page under review must not show. Queued once per page: a hidden badge and an injected
# stylesheet survive a viewport change, only a navigation wipes them — so also queued for a scheme
# that opens nothing, which is the `vysu shots` of a page already on screen.
bchrome() { # freeze
  local js="$NO_DEVTOOLS"
  [ "$1" = 1 ] && js="$js; { const s = document.createElement('style'); s.textContent = '$FREEZE_CSS'; document.head.appendChild(s) }"
  bcmd eval "$js"
}
# Around a --full capture, and around that one only: the boxes of an --ignore selector are measured
# after the expansion (the page they are cut out of is the expanded one) and the restore is queued
# right after the screenshot, so a viewport change never starts from a layout vysu itself stretched.
bexpand() { bcmd eval "$EXPAND_JS"; bsettle; }
bunexpand() { bcmd eval "$RESTORE_JS"; }
# After the expansion — the document the warm-up walks is the one about to be captured — and before
# the --ignore boxes, which are then measured from the top the capture starts at.
bwarm() { bcmd eval "$WARM_JS"; bsettle; }
bopen() { # url lang freeze — everything a fresh page needs before it can be captured
  bcmd open "$1"
  # The language key is read at boot only: the page has to come back for the language to apply.
  local key; key="$(cfg LANG_STORAGE_KEY)"
  [ -z "$2" ] || [ -z "$key" ] || { bcmd eval "localStorage.setItem('$key', '$2')"; bcmd reload; }
  bcmd wait --load networkidle --timeout 2500
  bsettle
  bchrome "$3"
}

web_go() { # persona url — a navigation settled the way a capture needs it, devtools badges hidden
  bcmd open "$2"
  bcmd wait --load networkidle --timeout 2500
  bsettle
  bchrome 0
  brun "$1" | bboxes >/dev/null
}
# Where a click is about to land, in CSS pixels. agent-browser's `find … click` answers with nothing
# but success, and the marker attribute it leaves is gone by the time the click returns: the box has
# to be read *before* the gesture, by an eval resolving the same three rules as web_click below
# (accessible name = aria-label or text, matched as a case-insensitive substring, like Playwright).
# Only when a recording is in flight, and never fatal: a box that cannot be found costs a ripple,
# not a step.
web_box_of() { # persona label [field] → « x y w h », or nothing
  local js; js="$(python3 -c '
import json, sys
print("""(() => {
  const want = %s.trim().toLowerCase(), field = %s;
  const shown = e => e.getClientRects().length > 0;
  const name = e => ((e.getAttribute("aria-label") || e.textContent || "").trim().toLowerCase());
  const pick = sel => [...document.querySelectorAll(sel)].find(e => shown(e) && name(e).includes(want));
  let e;
  if (field) {
    const named = c => ((c.getAttribute("aria-label") || c.placeholder || [...(c.labels || [])].map(l => l.textContent).join(" ")).trim().toLowerCase());
    e = [...document.querySelectorAll("input, textarea, select")].find(c => shown(c) && named(c).includes(want));
  } else {
    e = pick("button, [role=button], input[type=submit]") || pick("a, [role=link]")
      || [...document.querySelectorAll("body *")].find(c => !c.children.length && shown(c) && name(c).includes(want));
  }
  if (!e) return "";
  const r = e.getBoundingClientRect();
  return [r.x, r.y, r.width, r.height].map(Math.round).join(" ");
})()""" % (json.dumps(sys.argv[1]), "true" if sys.argv[2] else "false"))' "$2" "${3:-}")"
  ab "$1" eval "$js" 2>/dev/null | tail -1 | tr -d '"' || true
}
# By button name, then by link name, then by visible text: the same label is a button on one screen
# and a link on the next, and a flow names what it sees rather than how it is marked up. A step that
# finds nothing says why and hands its failure back, rather than ending the script itself: the runner
# is then the one that names the step number, and a recording is stopped instead of left running.
web_click() { # persona label
  [ -z "$EV_ROWS" ] || EV_TARGET="$(web_box_of "$1" "$2")"
  ab "$1" find role button click --name "$2" >/dev/null 2>&1 \
    || ab "$1" find role link click --name "$2" >/dev/null 2>&1 \
    || ab "$1" find text "$2" click >/dev/null 2>&1 \
    || { echo "vysu: nothing labelled « $2 » (vysu $1 snapshot -i -c)" >&2; return 1; }
  ab "$1" wait 300 >/dev/null
}
web_fill() { # persona label value — by <label>, then by placeholder (a search box carries no label)
  [ -z "$EV_ROWS" ] || EV_TARGET="$(web_box_of "$1" "$2" field)"
  ab "$1" find label "$2" fill "$3" >/dev/null 2>&1 \
    || ab "$1" find placeholder "$2" fill "$3" >/dev/null 2>&1 \
    || { echo "vysu: no field labelled « $2 » (vysu $1 snapshot -i -c)" >&2; return 1; }
}
web_shot() { # persona shots "<label> [--full] [--no-expand]" — the page as it stands, into the shots folder
  [ -n "$2" ] || die "vysu: « shot $3 » needs --shots <name> (or a recording name)"
  local words=(); read -r -a words <<<"$3"
  local label="${words[0]:-}" full="" expand=1 word
  [ -n "$label" ] || die "vysu: « shot » needs a label"
  for word in ${words[@]+"${words[@]:1}"}; do
    case "$word" in
      --full) full="--full";;
      --no-expand) expand=0;;
      *) die "vysu: « shot $label » takes --full / --no-expand, not $word";;
    esac
  done
  [ -n "$full" ] || expand=0
  local dir="$SHOTS/$2"; mkdir -p "$dir"
  # Same three beats as a --full capture in `vysu shots`, one `ab` call each: a flow runs outside the batch.
  [ "$expand" = 0 ] || { ab "$1" eval "$EXPAND_JS" >/dev/null; ab "$1" wait 300 >/dev/null; }
  # shellcheck disable=SC2086  # $full is a flag or nothing, and must not become an empty argument
  ab "$1" screenshot $full "$dir/web-$label.png" >/dev/null
  [ "$expand" = 0 ] || ab "$1" eval "$RESTORE_JS" >/dev/null
  echo "$dir/web-$label.png"
}
# One line of a web flow / a recording: vysu's own verbs, then anything agent-browser accepts.
#   go <url> · click "<label>" · click t:<i18n.key> · fill "<label>" "<value>" · press <key>
#   · sleep <s> · shot <label> [--full] · check · viewport WxH   (`tap` reads as `click`, as on mobile)
web_step() {
  local persona="$1" shots="$2" step="$3"
  case "$step" in
    ''|\#*) ;;
    sleep\ *) sleep "${step#sleep }";;
    go\ *) web_go "$persona" "${step#go }";;
    viewport\ *) local wh="${step#viewport }"; ab "$persona" set viewport "${wh%x*}" "${wh#*x}" >/dev/null;;
    # By i18n key: the flow survives a wording change, and reads the same in every language.
    click\ t:*|click\ \"t:*|click\ \'t:*|tap\ t:*|tap\ \"t:*|tap\ \'t:*)
      local key="${step#* }"; key="${key#[\"\']}"; key="${key%[\"\']}"; key="${key#t:}"
      web_lang_init "$persona"
      EV_LABEL="$(i18n_label "$WEB_LANG" "$key")"
      web_click "$persona" "$EV_LABEL";;
    click\ *|tap\ *) eval "web_click \"\$persona\" ${step#* }";;
    fill\ *) eval "web_fill \"\$persona\" ${step#fill }";;
    press\ *) ab "$persona" press "${step#press }" >/dev/null;;
    shot\ *) web_shot "$persona" "$shots" "${step#shot }";;
    check)
      [ -n "$shots" ] || die "vysu: « check » needs --shots <name> (or a recording name)"
      mkdir -p "$SHOTS/$shots"; vysu_check "$persona" | tee -a "$SHOTS/$shots/check.txt";;
    *) eval "ab \"\$persona\" $step" | tail -1;;
  esac
}
# What a web flow or a recording was taken against, in the file `vysu report` already reads.
web_meta() { # dir persona [key=value…]
  meta_write "$1" kind=web persona="$2" "lang=${WEB_LANG:-$(cfg LANG)}" \
    "web_sha=$(repo_sha "${WEB_REPO:-$VYSU_PROJECT_DIR}")" \
    "web_branch=$(repo_branch "${WEB_REPO:-$VYSU_PROJECT_DIR}")" \
    "api=$(web_api "$2")" "${@:3}"
}

vysu_check() {
  local persona="${1:-}"; [ -n "$persona" ] || die "usage: vysu check <persona> [--save <name>]"
  lock_take "$(resource_of "$persona")"   # every `ab` below drops stderr, the « waiting » line with it
  local save=""; [ "${2:-}" != "--save" ] || save="${3:-}"
  local pattern; pattern="$(cfg API_PATTERN)"
  local out
  out="$({
    echo "## JS errors"
    # The same error is thrown once per render: --json carries the message the plain output drops,
    # and one line per distinct message is all an agent can act on.
    ab "$persona" errors --json 2>/dev/null | python3 -c '
import sys, json
try:
    errors = (json.load(sys.stdin).get("data") or {}).get("errors") or []
except ValueError:
    errors = []
seen = {}
for e in errors:
    text = (e.get("text") or "").strip() or "(empty)"
    seen[text] = seen.get(text, 0) + 1
for text, n in seen.items():
    print(text if n == 1 else "%s (x%d)" % (text, n))
if not seen:
    print("(none)")
' || true
    echo "## failed API requests"
    ab "$persona" network requests 2>/dev/null | grep -E "$pattern" | grep -vE ' (2[0-9]{2}|304)$' | grep -vE '^\[[0-9A-F]{32}\] OPTIONS' || echo "(none)"
  })"
  printf '%s\n' "$out"
  # --save: the shots folder keeps it, so `vysu report` can say « clean » without a second call.
  [ -z "$save" ] || { mkdir -p "$SHOTS/$save"; printf '%s\n' "$out" >"$SHOTS/$save/check.txt"; }
  # Each check covers what happened since the previous one.
  ab "$persona" network requests --clear >/dev/null 2>&1 || true
  ab "$persona" console --clear >/dev/null 2>&1 || true
}

vysu_lang() {
  local persona="${1:-}" lang="${2:-}"
  [ -n "$persona" ] && [ -n "$lang" ] || die "usage: vysu lang <persona> <lang>"
  local key; key="$(cfg LANG_STORAGE_KEY)"
  [ -n "$key" ] || die "vysu lang: this project stores no language (VYSU_LANG_STORAGE_KEY is empty)"
  lang_check "$lang"
  bcmd eval "localStorage.setItem('$key', '$lang')"
  bcmd reload
  bcmd wait --load networkidle --timeout 2500
  brun "$persona" | bboxes >/dev/null
  echo "$persona: $key = $lang"
}

# Element bounds for `vysu mark`: viewport-relative, 1x — take the screenshot of the same viewport
# without scrolling in between.
vysu_box() {
  local persona="${1:-}" sel="${2:-}" page=0; [ -n "$persona" ] && [ -n "$sel" ] || die "usage: vysu box <persona> <selector|@ref> [--page]"
  [ "${3:-}" = "--page" ] && page=1
  # --page: document coordinates, what a `screenshot --full` capture is measured in.
  local off="0,0"; [ "$page" = 1 ] && off="$(ab "$persona" eval "Math.round(window.scrollX)+','+Math.round(window.scrollY)" 2>/dev/null | tail -1 | tr -d '"')"
  ab "$persona" get box "$sel" --json 2>/dev/null | tail -1 \
    | python3 -c "
import sys,json
d=json.load(sys.stdin).get('data') or {}
if 'x' not in d: sys.exit('vysu box: no box for $sel — refs need a fresh snapshot (vysu <p> snapshot -i), or use a CSS selector')
ox,oy=map(int,'$off'.split(',')); print('%d,%d,%d,%d' % (round(d['x'])+ox, round(d['y'])+oy, round(d['width']), round(d['height'])))"
}
