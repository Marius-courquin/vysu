# core.sh — where everything starts: the project's `.vysu/config` and the values in force, the
# paths under $VYSU_STATE, die / usage / slug / log, the owner a lock is attributed to, the locks
# and claims several agents share a Mac through, meta.json, and the clip / event plumbing.
# shellcheck shell=bash

VYSU_PID=$$
VYSU_CMD="${VYSU_CMD:-vysu}"
# A die inside a command substitution or a pipeline (« $(brun …) », « ab … | tail -1 ») would end
# that subshell only, and let the command carry on with an empty result: the signal ends the script
# itself, through its EXIT trap.
trap 'exit 1' USR1
die() { echo "vysu: $*" >&2; kill -USR1 "$VYSU_PID" 2>/dev/null; exit 1; }
log() { echo "vysu: $*" >&2; }
usage() { awk 'NR > 1 { if (substr($0, 1, 1) != "#") exit; print }' "$VYSU_ENGINE/bin/vysu"; }
slug() { printf '%s' "$1" | tr '[:upper:]' '[:lower:]' | tr -c 'a-z0-9\n' '-' | tr -s '-'; }
deprecated() { echo "vysu: « $1 » is the old spelling — use « $2 » (it still works for now)" >&2; }

# --- the project, and the values in force ------------------------------------------------------

# Discovery, in the order the design note gives: an explicit $VYSU_CONFIG (so a config can be tried
# from outside its project), then $VYSU_PROJECT_DIR, then the first ancestor of $PWD holding
# `.vysu/config` — like `.git`. Nothing found is not an error: anonymous web captures still work,
# and only a command needing a persona, a service or a connector says what is missing.
VYSU_PROJECT_DIR="${VYSU_PROJECT_DIR:-}"
VYSU_CONFIG_FILE=""
config_find() {
  if [ -n "${VYSU_CONFIG:-}" ]; then
    [ -f "$VYSU_CONFIG" ] || die "no config file $VYSU_CONFIG (VYSU_CONFIG)"
    VYSU_CONFIG_FILE="$VYSU_CONFIG"
    [ -n "$VYSU_PROJECT_DIR" ] || VYSU_PROJECT_DIR="$(cd "$(dirname "$VYSU_CONFIG_FILE")/.." && pwd)"
    return 0
  fi
  if [ -n "$VYSU_PROJECT_DIR" ]; then
    [ -f "$VYSU_PROJECT_DIR/.vysu/config" ] || return 0
    VYSU_CONFIG_FILE="$VYSU_PROJECT_DIR/.vysu/config"
    return 0
  fi
  local dir; dir="$(pwd -P)"
  while [ "$dir" != / ] && [ -n "$dir" ]; do
    if [ -f "$dir/.vysu/config" ]; then
      VYSU_PROJECT_DIR="$dir"; VYSU_CONFIG_FILE="$dir/.vysu/config"; return 0
    fi
    dir="$(dirname "$dir")"
  done
}
# An environment variable wins over the file: the snapshot of what was already exported is taken
# before any file is sourced and replayed after, so `VYSU_ORIGIN=… vysu shots` overrides the config
# without editing it. `export` inside a function is global in bash, which is what makes this work.
VYSU_ENV_KEYS=""
config_env_snapshot() {
  export -p | sed -n 's/^declare -x \(VYSU_[A-Za-z0-9_]*\)=/export \1=/p; s/^export \(VYSU_[A-Za-z0-9_]*\)=/export \1=/p'
}
config_load() {
  local snapshot; snapshot="$(config_env_snapshot)"
  VYSU_ENV_KEYS=" $(printf '%s\n' "$snapshot" | sed -n 's/^export \([A-Za-z0-9_]*\)=.*/\1/p' | tr '\n' ' ')"
  config_find
  # The global device file `vysu setup` writes sits below the project config: a machine says which
  # simulators it has, a project says which ones it wants.
  # shellcheck disable=SC1091  # the user's own file, absent on a fresh machine
  [ ! -f "$HOME/.vysu/devices.env" ] || { set -a; . "$HOME/.vysu/devices.env"; set +a; }
  # shellcheck disable=SC1090  # the project's own file, its path only known at runtime
  [ -z "$VYSU_CONFIG_FILE" ] || { set -a; . "$VYSU_CONFIG_FILE"; set +a; }
  eval "$snapshot"
  config_defaults
  config_paths
}
# Where a value came from, for `vysu doctor`.
config_origin() { # KEY
  case "$VYSU_ENV_KEYS" in *" VYSU_$1 "*) printf 'env'; return;; esac
  local set_in="^[[:space:]]*(export[[:space:]]+)?VYSU_$1="
  if [ -n "$VYSU_CONFIG_FILE" ] && grep -qE "$set_in" "$VYSU_CONFIG_FILE" 2>/dev/null; then printf 'config'; return; fi
  if [ -f "$HOME/.vysu/devices.env" ] && grep -qE "$set_in" "$HOME/.vysu/devices.env" 2>/dev/null; then printf 'devices.env'; return; fi
  printf 'default'
}
# The one reader a connector, a driver and every lib use: the value in force, or the default given.
cfg() { # KEY [default]
  local name="VYSU_$1" value
  value="${!name:-}"
  printf '%s' "${value:-${2:-}}"
}
# The engine's own defaults are the values nv ran on, minus everything an app decides: an origin, a
# bundle id or a locale folder has no sensible default and stays empty, and the command that needs
# one says so.
# shellcheck disable=SC2034  # every name here is read by the other libs, which shellcheck checks apart
config_defaults() {
  : "${VYSU_PROJECT:=$( [ -n "$VYSU_PROJECT_DIR" ] && basename "$VYSU_PROJECT_DIR" || echo default )}"
  : "${VYSU_STATE:=$HOME/.vysu/$VYSU_PROJECT}"
  : "${VYSU_ORIGIN:=}"
  : "${VYSU_LOGIN_PATH:=/login}"
  : "${VYSU_BASELINE_ORIGIN:=}"
  : "${VYSU_SIZES:=360x800,768x1024,1280x800,1440x900}"
  : "${VYSU_LANGS:=}"
  : "${VYSU_LANG:=}"
  : "${VYSU_LANG_STORAGE_KEY:=}"
  : "${VYSU_LOCALES:=}"
  : "${VYSU_WEB_REPO:=}"
  : "${VYSU_API_PATTERN:=/api/}"
  : "${VYSU_API_HOSTS:=}"
  # No login until a project names a connector: `login` then opens the url and `auth token` prints
  # nothing, which is the right answer for a static site, a Storybook and a page behind no door.
  : "${VYSU_AUTH:=none}"
  : "${VYSU_MOBILE_BUNDLE:=}"
  : "${VYSU_IOS_APP:=}"
  : "${VYSU_MOBILE_DIR:=}"
  : "${VYSU_MOBILE_ENV:=}"
  : "${VYSU_MOBILE_SCHEME:=}"
  : "${VYSU_IOS_DEVICE:=}"
  : "${VYSU_IOS_OLD_DEVICE:=vysu iPhone SE (iOS 18)}"
  : "${VYSU_ANDROID_AVD:=}"
  : "${VYSU_ANDROID_LOCALE:=}"
  : "${VYSU_SERVICES:=}"
  : "${VYSU_PUSH:=}"
  : "${VYSU_THEME:=default}"
  : "${VYSU_MIN_VERSION:=}"
  : "${VYSU_LOCK_WAIT:=90}"
  # The simulator and the AVDs to drive, and the specs `vysu setup` creates. A project renames them
  # in its own config; the engine's own names carry its prefix so two projects never share a device.
  IOS_DEFAULT_DEVICE="iPhone 17 Pro"
  ANDROID_DEFAULT_AVD="vysu_pixel8_api36"
  : "${VYSU_ANDROID_AVDS:=vysu_pixel8_api36:36:pixel_8:;vysu_pixel10pro_api36:36:pixel_8_pro:hw.lcd.width=1280 hw.lcd.height=2856 hw.lcd.density=480;vysu_pixel4a_api30:30:pixel_4a:}"
  ANDROID_SDK="${ANDROID_HOME:-$HOME/Library/Android/sdk}"
  # Models downsize an image before tokenising it (Claude: a 1568 px long edge, then ≈ w×h/750
  # tokens; OpenAI: 512 px tiles, the cost following the pixels too — the numbers here are measured
  # on Claude, the order of magnitude holds for all). Past that edge a contact sheet loses its
  # thumbnails and costs the same: every sheet is rendered to fit inside that square.
  SHEET_EDGE=1568
  # The cadence every take is normalized to, and the one the montage renders at: a mobile recorder
  # has none of its own, and 30 fps is what the video output asks for.
  CLIP_FPS=30
}
# shellcheck disable=SC2034  # likewise: the paths below are the ones the other libs address
config_paths() {
  STATE="$VYSU_STATE"
  # An env-only override, so a personas file can be tried without moving the state folder.
  PERSONAS="${VYSU_PERSONAS:-$STATE/personas.env}"
  SHOTS="${VYSU_SHOTS:-$STATE/shots}"
  LOGS="$STATE/logs"
  LOCKS="$STATE/locks"
  CLAIMS="$STATE/claims"
  LOCK_WAIT="$VYSU_LOCK_WAIT"
  PY="$VYSU_ENGINE/py"
  MARK="$PY/mark.py"; MOTION="$PY/motion.py"; DIFF="$PY/diff.py"; FRAME="$PY/frame.py"
  COMPARE="$PY/compare.py"; STITCH="$PY/stitch.py"; TAKE="$PY/take.py"; FIELDS="$PY/fields.py"
  REMOTION="$VYSU_ENGINE/remotion"
  # Relative to the project: that is how a config names a folder inside its own repo.
  LOCALES="$(project_path "$(cfg LOCALES)")"
  WEB_REPO="$(project_path "$(cfg WEB_REPO)")"
  MOBILE_DIR="$(project_path "$(cfg MOBILE_DIR)")"
  BATCH="$STATE/.batch-$$"
  export VYSU_PROJECT_DIR VYSU_PROJECT VYSU_STATE VYSU_THEME
}
project_path() { # a config path, absolute or relative to the project dir
  [ -n "$1" ] || return 0
  case "$1" in /*|'~'/*) printf '%s' "${1/#\~/$HOME}";; *) printf '%s/%s' "${VYSU_PROJECT_DIR:-$PWD}" "$1";; esac
}
# Every command that needs more than an anonymous browser says the same thing when there is no
# project here: the fix is one command, and it is not a stack trace.
need_project() { [ -n "$VYSU_CONFIG_FILE" ] || die "no .vysu/config here (vysu init)"; }
need_cfg() { # KEY explanation — a config key a command cannot work without
  local v; v="$(cfg "$1")"
  [ -n "$v" ] || { need_project; die "VYSU_$1 is not set in $VYSU_CONFIG_FILE ($2)"; }
  printf '%s' "$v"
}
# `vysu <name>` with no engine command of that name: the project's own executable, with everything
# vysu resolved exported so the command reads the same values the engine does.
project_command() { [ -n "$VYSU_PROJECT_DIR" ] && [ -x "$VYSU_PROJECT_DIR/.vysu/commands/$1" ]; }
exec_project_command() {
  local name="$1"; shift
  local var
  for var in $(compgen -v | grep '^VYSU_'); do export "${var?}"; done
  exec "$VYSU_PROJECT_DIR/.vysu/commands/$name" "$@"
}

# --- who holds what ----------------------------------------------------------------------------

# Several agent sessions share this Mac's simulators, emulators and browser sessions, and two of
# them driving the same one interleave their taps. Each command takes the lock of what it is about
# to touch — lazily, in the wrappers everything goes through — and holds it until it exits.
# `mkdir` is the acquire: atomic everywhere, and it leaves the holder readable inside.
LOCKS_HELD=""
# The same session runs dozens of vysu commands from as many shells: what they have in common is
# the process that drives them — an agent CLI, or the terminal a human typed in. It is the first
# ancestor that is not plumbing: a shell, an interpreter, a wrapper. Hence « claude:41234 »,
# « codex:5120 », « Terminal:882 ». A CLI shipped as a node script is named after its own binary,
# so only a bare « node » counts as plumbing.
VYSU_PLUMBING=" bash zsh sh dash fish vysu nv rtk python3 python node env xargs timeout script tmux login "
VYSU_OWNER_ID="${VYSU_OWNER:-}"
vysu_owner() {
  [ -z "$VYSU_OWNER_ID" ] || { printf '%s' "$VYSU_OWNER_ID"; return; }
  local pid="$VYSU_PID" comm i
  for i in $(seq 1 20); do
    pid="$(ps -o ppid= -p "$pid" 2>/dev/null | tr -d ' ')"
    { [ -n "$pid" ] && [ "$pid" -gt 1 ]; } 2>/dev/null || break
    comm="$(ps -o comm= -p "$pid" 2>/dev/null | sed 's#.*/##' | tr ' ' '-')"
    [ -n "$comm" ] || continue
    case "$VYSU_PLUMBING" in *" $comm "*) continue;; esac
    VYSU_OWNER_ID="$comm:$pid"; break
  done
  VYSU_OWNER_ID="${VYSU_OWNER_ID:-shell:$PPID}"
  printf '%s' "$VYSU_OWNER_ID"
}
# The remembered device choice is per owner: several agent sessions share this Mac, and one of them
# running `vysu up android --avd <other>` must not move another session's next command onto that
# AVD. A choice is therefore only written under its owner — all the windows of one terminal, or one
# agent CLI, share theirs. The machine-wide file is still read as the fallback, for an owner that
# never chose and for whatever an older run left behind.
device_file() { printf '%s/%s.%s' "$STATE" "$1" "$(slug "$(vysu_owner)")"; }
device_remember() { # ios-device | android-avd, value
  mkdir -p "$STATE"
  printf '%s' "$2" >"$(device_file "$1")"
}
device_choice() { # ios-device | android-avd, default → this owner's choice, else the machine's
  local f; f="$(device_file "$1")"
  [ -s "$f" ] || f="$STATE/$1"
  [ -s "$f" ] && cat "$f" || printf '%s' "$2"
}
device_origin() { # ios-device | android-avd → where the value in force comes from, for `vysu doctor`
  [ ! -s "$(device_file "$1")" ] || { printf ' (remembered for %s)' "$(vysu_owner)"; return; }
  [ ! -s "$STATE/$1" ] || printf ' (remembered)'
}
devices_resolve() { # the config still wins over what was remembered
  IOS_DEVICE="$(cfg IOS_DEVICE)"
  [ -n "$IOS_DEVICE" ] || IOS_DEVICE="$(device_choice ios-device "$IOS_DEFAULT_DEVICE")"
  ANDROID_AVD="$(cfg ANDROID_AVD)"
  [ -n "$ANDROID_AVD" ] || ANDROID_AVD="$(device_choice android-avd "$ANDROID_DEFAULT_AVD")"
}
resource_of() { # ios | android | <persona> | a resource name → the resource to lock or claim
  case "$1" in
    ios) printf 'ios-%s' "$(slug "$IOS_DEVICE")";;
    android) printf 'android-%s' "$(slug "$ANDROID_AVD")";;
    ios-*|android-*|web-*) printf '%s' "$1";;
    *) printf 'web-%s' "$(slug "$1")";;
  esac
}
lock_alive() { local p; p="$(cat "$1/pid" 2>/dev/null || true)"; [ -n "$p" ] && kill -0 "$p" 2>/dev/null; }
lock_who() { # lock dir → who holds it, doing what, for how long
  # The holder writes its identity just after the mkdir that publishes the lock, and a waiter that
  # started at the same moment lands in between: one beat is all it takes to read a full lock.
  local s; [ -s "$1/since" ] || sleep 0.2
  s="$(cat "$1/since" 2>/dev/null || true)"
  printf '%s running « %s » for %ss' "$(cat "$1/owner" 2>/dev/null || echo '?')" \
    "$(cat "$1/cmd" 2>/dev/null || echo '?')" "$(( $(date +%s) - ${s:-$(date +%s)} ))"
}
claim_field() { grep "^$2=" "$1" 2>/dev/null | cut -d= -f2-; }
# A claim is a lease that outlives one command: a mobile task is a dozen vysu calls, and another
# agent must not slip a relaunch between two of them. Own claims are transparent, expired ones are gone.
claim_why() { # resource → why it cannot be taken, or nothing
  local f="$CLAIMS/$1" owner until_s
  [ -f "$f" ] || return 0
  owner="$(claim_field "$f" owner)"; until_s="$(claim_field "$f" until)"
  [ "$owner" != "$(vysu_owner)" ] || return 0
  [ "$(date +%s)" -lt "${until_s:-0}" ] || { rm -f "$f"; return 0; }
  printf 'claimed by %s until %s (vysu release %s --force to take it over)' \
    "$owner" "$(date -r "$until_s" +%H:%M)" "$1"
}
lock_take() { # resource — waits for a foreign lock or claim, then holds it until this process exits
  local r="$1" i=0 waited=0 dir why
  case " $LOCKS_HELD " in *" $r "*) return 0;; esac   # taken once, kept for the whole command
  dir="$LOCKS/$r"
  # Same process, one command substitution earlier: the lock came back, the list it was noted in
  # did not. Without this the command would wait for itself.
  [ "$(cat "$dir/pid" 2>/dev/null || true)" != "$VYSU_PID" ] || { LOCKS_HELD="$LOCKS_HELD $r"; return 0; }
  mkdir -p "$LOCKS"
  while :; do
    why="$(claim_why "$r")"
    if [ -z "$why" ]; then
      # A lock whose process is gone is an agent that crashed: it must not hold the device for good.
      [ ! -d "$dir" ] || lock_alive "$dir" || rm -rf "$dir"
      if mkdir "$dir" 2>/dev/null; then
        printf '%s' "$(vysu_owner)" >"$dir/owner"; printf '%s' "$VYSU_PID" >"$dir/pid"
        date +%s >"$dir/since"; printf '%s' "$VYSU_CMD" >"$dir/cmd"
        LOCKS_HELD="$LOCKS_HELD $r"
        [ "$waited" = 0 ] || echo "vysu: $r taken after ${waited}s" >&2
        return 0
      fi
      why="busy — $(lock_who "$dir") (VYSU_LOCK_WAIT=$LOCK_WAIT to wait longer)"
    fi
    [ "$i" -lt "$((LOCK_WAIT * 2))" ] || die "$r $why"
    [ "$i" != 0 ] || echo "vysu: $r $why — waiting" >&2
    i=$((i + 1)); waited=$((i / 2)); sleep 0.5
  done
}
locks_release() { # EXIT: give back every lock carrying this pid, and only those
  # By pid rather than by $LOCKS_HELD: a lock taken inside a command substitution was recorded in
  # that subshell's copy of the list, and would outlive the command it belonged to.
  local d
  for d in "$LOCKS"/*; do
    [ -d "$d" ] || continue
    if [ "$(cat "$d/pid" 2>/dev/null || true)" = "$VYSU_PID" ]; then rm -rf "$d"; fi
  done
}
ios_lock() { lock_take "ios-$(slug "$IOS_DEVICE")"; }
android_lock() { lock_take "android-$(slug "$ANDROID_AVD")"; }

# A screen recording must not outlive vysu: between `record start` and `record stop` any die — a
# lock given up, an i18n key that does not exist — would leave `screenrecord` filling /sdcard or
# simctl holding a half-written mp4, and the next `vysu mrec` would record on top of it. The pid of
# the recorder in flight lives here, and the EXIT trap stops it whichever way vysu ends.
REC_PID=""
REC_PLATFORM=""
rec_stop() {
  [ -n "$REC_PID" ] || return 0
  local pid="$REC_PID"; REC_PID=""
  if [ "$REC_PLATFORM" = android ]; then adb shell pkill -INT screenrecord >/dev/null 2>&1 || true
  else kill -INT "$pid" 2>/dev/null || true; fi
  wait "$pid" 2>/dev/null || true
}
# auth_test_close is a no-op unless `vysu auth test` is running: its throwaway browser session is
# closed whichever way vysu ends, a failed login included.
trap 'auth_test_close; rm -f "$BATCH" "$STATE/.ab-err-$$"; rec_stop; locks_release' EXIT

# --- what a capture and a take remember --------------------------------------------------------

# What a shots folder holds, in one file: `vysu report` reads it back instead of guessing from the
# file names, and a capture two weeks old still says which branch and which API it came from.
meta_write() { # dir key=value…  (a value that parses as JSON is stored as JSON)
  local dir="$1"; shift
  python3 - "$dir/meta.json" "$@" <<'PY'
import datetime, json, os, sys

path = sys.argv[1]
meta = {}
if os.path.exists(path):
    try:
        meta = json.load(open(path))
    except ValueError:
        meta = {}
for arg in sys.argv[2:]:
    key, value = arg.split("=", 1)
    if value[:1] in "[{" or value in ("true", "false", "null"):
        try:
            value = json.loads(value)
        except ValueError:
            pass
    meta[key] = value
meta["date"] = datetime.datetime.now().astimezone().isoformat(timespec="seconds")
json.dump(meta, open(path, "w"), ensure_ascii=False, indent=1)
PY
}
# The git checkout a capture is attributed to: the project's web or mobile folder when the config
# names one, the project itself otherwise.
repo_sha() { git -C "${1:-$VYSU_PROJECT_DIR}" rev-parse --short HEAD 2>/dev/null || echo unknown; }
repo_branch() { git -C "${1:-$VYSU_PROJECT_DIR}" rev-parse --abbrev-ref HEAD 2>/dev/null || echo unknown; }

# What a recording knows about its own steps: when each one ran, whether it worked, and where it
# landed. One raw row per step while the take runs — take.py turns them into events.json at the
# end, once the clip's duration says where its first frame was. Empty $EV_ROWS = not recording,
# so `vysu flow` and `vysu mflow` pay nothing and write nothing.
EV_ROWS=""
EV_I=0
EV_TARGET=""   # « x y » (a device press) or « x y w h » (a web box), set by the step that acted
EV_LABEL=""    # the label a « t:<i18n.key> » step resolved to, which the raw line no longer holds
# bash 3.2 has no $EPOCHREALTIME, and a python start-up per step would show in the clip.
now() { perl -MTime::HiRes=time -e 'printf "%.3f", time'; }
ev_log() { # "<line>" <start> <end> true|false
  [ -n "$EV_ROWS" ] || return 0
  EV_I=$((EV_I + 1))
  printf '%s\t%s\t%s\t%s\t%s\t%s\t%s\n' "$EV_I" "$2" "$3" "$4" "$EV_TARGET" "$EV_LABEL" \
    "$(printf '%s' "$1" | tr '\t\n' '  ')" >>"$EV_ROWS"
}
# One transcode at the end of a take, so every consumer reads the same clip: H.264 yuv420p (what
# Remotion, QuickTime and a browser all play), faststart, a keyframe every second — seeking one
# frame otherwise decodes a whole GOP — and even dimensions, which yuv420p requires.
# Constant frame rate, and that is the deviation worth naming: simctl and screenrecord only emit a
# frame when the screen changes (a 19 s take came back as 106 frames on a 600 timebase, « 5.5 fps »),
# so a mobile clip has no native cadence to keep and its frame numbers mean nothing to a montage.
# Resampling to a fixed rate makes second N frame N × fps, which is what Remotion trims on.
clip_normalize() { # <clip.mp4 wanted> <source> <fps>
  local out="$1" src="$2" fps="$3" tmp err
  tmp="$out.norm.mp4"
  err="$(ffmpeg -nostdin -y -i "$src" -an -c:v libx264 -crf 18 -preset veryfast -pix_fmt yuv420p \
    -r "$fps" -fps_mode cfr -g "$fps" -movflags +faststart \
    -vf 'scale=trunc(iw/2)*2:trunc(ih/2)*2' "$tmp" 2>&1)" || {
    rm -f "$tmp"; die "ffmpeg: $(printf '%s' "$err" | tail -1)"
  }
  [ "$src" = "$out" ] || rm -f "$src"
  mv "$tmp" "$out"
}

# The visible label of an i18n key (`tap t:screen.home.title`), in the language the app was last
# launched in. An interpolated value (« {{n}} messages ») keeps its longest literal piece, which
# vysu_mtap then matches with its « contains » fallback.
i18n_label() { # lang key
  [ -n "$LOCALES" ] || die "t:<key> needs VYSU_LOCALES (the folder holding <lang>.json)"
  local file="$LOCALES/$1.json"
  [ -f "$file" ] || die "no locale file $file (VYSU_LOCALES)"
  python3 -c '
import re, sys, json
d = json.load(open(sys.argv[1]))
for part in sys.argv[2].split("."):
    if not isinstance(d, dict) or part not in d:
        sys.exit("vysu: no i18n key « %s » in %s" % (sys.argv[2], sys.argv[1]))
    d = d[part]
if not isinstance(d, str):
    sys.exit("vysu: i18n key « %s » is not a label" % sys.argv[2])
literal = max((p.strip() for p in re.split(r"{{[^}]*}}", d)), key=len)
if not literal:
    sys.exit("vysu: i18n key « %s » is all interpolation (%s)" % (sys.argv[2], d))
print(literal)
' "$file" "$2"
}
# A language the project declares, or the default one. A flow that names none takes VYSU_LANG.
lang_check() { # lang — dies unless the config lists it
  local langs; langs="$(cfg LANGS)"
  [ -n "$1" ] || return 0
  [ -n "$langs" ] || die "--lang needs VYSU_LANGS (the languages the app offers)"
  case ",$langs," in *",$1,"*) return 0;; esac
  die "--lang is one of $langs"
}

# --- the plumbing every target shares ----------------------------------------------------------

# One reader for « a file, or stdin »: a flow, a recording and an import all take « - ».
read_lines() { if [ "$1" = - ]; then cat; else cat "$1"; fi; }

listening() { lsof -nP -iTCP:"$1" -sTCP:LISTEN >/dev/null 2>&1; }
kill_port() { # the port must be free when the function returns, or the next `up` sees a ghost
  lsof -nP -tiTCP:"$1" -sTCP:LISTEN | xargs kill 2>/dev/null || true
  local i; for i in $(seq 1 20); do listening "$1" || return 0; sleep 0.5; done
  lsof -nP -tiTCP:"$1" -sTCP:LISTEN | xargs kill -9 2>/dev/null || true
}
wait_http() { # url seconds label
  # -m: a port that accepts the connection but never answers (a half-started bundler) would
  # otherwise hang inside one curl, well past the budget this loop is supposed to bound.
  local i; for i in $(seq 1 "$2"); do curl -s -m 5 -o /dev/null "$1" && return 0; sleep 1; done
  die "$3: not up after $2s"
}

# --- claims ------------------------------------------------------------------------------------

# A lock lasts one command; a mobile task lasts twenty. A claim says « this device is mine until
# then », and every other agent's command waits on it exactly as it waits on a lock.
vysu_claim() {
  local what="${1:-}"; [ -n "$what" ] || die "usage: vysu claim ios|android|<persona> [--minutes 30] [--note \"<why>\"]"
  shift
  local minutes=30 note=""
  while [ $# -gt 0 ]; do
    case "$1" in
      --minutes) minutes="$2"; shift 2;;
      --note) note="$2"; shift 2;;
      *) die "vysu claim: unknown option $1";;
    esac
  done
  local r; r="$(resource_of "$what")"
  local held; held="$(claim_why "$r")"
  [ -z "$held" ] || die "$r $held"
  local until_s=$(( $(date +%s) + minutes * 60 ))
  mkdir -p "$CLAIMS"
  { echo "owner=$(vysu_owner)"; echo "until=$until_s"; echo "note=$note"; } >"$CLAIMS/$r"
  echo "claimed: $r until $(date -r "$until_s" +%H:%M) by $(vysu_owner) (vysu release $what)"
  case "$r" in
    ios-*|android-*)
      local platform="${r%%-*}" args
      mstate_line "$(mstate_file "$platform")"
      mscreen_line "$platform"
      args="$(mreset_args "$platform")"
      [ -z "$args" ] || echo "reset: vysu mrelaunch $platform$args"
      ;;
    # A web session carries its own login and its own URL: there is nothing vysu has to remember
    # for it, so the state is read from the browser rather than from a file.
    web-*)
      local persona="${r#web-}"
      if vysu_web_session "$persona"; then
        echo "state: url $(ab "$persona" eval "location.href$(lang_read_js ' + \" · lang \" + ')" | tail -1 | tr -d '"')"
      else
        echo "state: (no session — vysu login $persona)"
      fi
      ;;
  esac
}
vysu_release() {
  local what="${1:-}"; [ -n "$what" ] || die "usage: vysu release ios|android|<persona> [--force] [--reset]"
  shift
  local force=0 reset=0
  while [ $# -gt 0 ]; do
    case "$1" in
      --force) force=1; shift;;
      --reset) reset=1; shift;;
      *) die "vysu release: unknown option $1";;
    esac
  done
  local r f owner; r="$(resource_of "$what")"; f="$CLAIMS/$r"
  [ -f "$f" ] || { echo "release: no claim on $r"; return; }
  owner="$(claim_field "$f" owner)"
  [ "$owner" = "$(vysu_owner)" ] || [ "$force" = 1 ] || die "$r is claimed by $owner (vysu release $what --force to take it over)"
  # Handing a device back the way it was found: the next agent's `vysu claim` then reads a device
  # in its defaults instead of a large-text dark one it has to notice before believing a capture.
  [ "$reset" = 0 ] || vysu_reset "$r"
  rm -f "$f"
  echo "released: $r (was $owner)"
}
vysu_reset() { # resource — back to the defaults, only what differs from them
  case "$1" in
    ios-*|android-*)
      local platform="${1%%-*}" args
      args="$(mreset_args "$platform")"
      [ -n "$args" ] || { echo "reset: $platform already in its defaults"; return; }
      listening 8081 || { echo "reset: $platform left as it is — Metro is not running (vysu up $platform)"; return; }
      # shellcheck disable=SC2086  # the flags are built as a word list on purpose
      vysu_mrelaunch "$platform" $args >/dev/null
      echo "reset: vysu mrelaunch $platform$args"
      ;;
    web-*)
      local persona="${1#web-}" lang
      vysu_web_session "$persona" || { echo "reset: no $persona session"; return; }
      bcmd set media light
      bcmd set viewport 1440 900
      local default_lang; default_lang="$(cfg LANG)"
      if [ -z "$(cfg LANG_STORAGE_KEY)" ] || [ -z "$default_lang" ]; then
        brun "$persona" | bboxes >/dev/null
        echo "reset: $persona → media light, viewport 1440x900"
        return
      fi
      bcmd eval "$(lang_read_js)"
      lang="$(brun "$persona" | python3 -c 'import sys, json; rs = json.load(sys.stdin); print((rs[-1].get("result") or {}).get("result") or "")' 2>/dev/null || true)"
      local didlang=""
      [ -z "$lang" ] || [ "$lang" = "$default_lang" ] || { vysu_lang "$persona" "$default_lang" >/dev/null; didlang=", lang $default_lang"; }
      echo "reset: $persona → media light, viewport 1440x900$didlang"
      ;;
  esac
}
# What is held right now: a lock whose process is gone is left out, the next command that waits drops it.
locks_report() {
  local d f r u note
  for d in "$LOCKS"/*; do
    [ -d "$d" ] || continue
    lock_alive "$d" || continue
    echo "lock: $(basename "$d") — $(lock_who "$d")"
  done
  for f in "$CLAIMS"/*; do
    [ -f "$f" ] || continue
    r="$(basename "$f")"; u="$(claim_field "$f" until)"; note="$(claim_field "$f" note)"
    echo "claim: $r — $(claim_field "$f" owner) until $(date -r "${u:-0}" +%H:%M) ($(( (${u:-0} - $(date +%s)) / 60 )) min left)${note:+ « $note »}"
  done
}
