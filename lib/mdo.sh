# mdo.sh — a mobile screen driven in one call: `mdo` runs a list of steps and answers each with one
# line (✓ / ✗, what it did) and what the screen shows after it, `mwait` waits for a text (or for its
# absence, or for a screen at rest) in one line. An agent used to spend a press, a sleep, a snapshot
# and a grep per action, and wrote its own step.sh / next-until.sh / scrollfind.sh around them; the
# verbs those scripts were made of are in `mobile_step` (mobile.sh), so `mflow` and `mrec` read them
# too.
# shellcheck shell=bash
# shellcheck disable=SC2153  # STATE, SHOTS, PY, IOS_DEVICE and ANDROID_AVD are set in core.sh
# shellcheck disable=SC2034  # MSHOT_PREFIX is read by mobile_step (mobile.sh)

# The device a command drives, taken before its first step: the « waiting for … » line of a busy
# device then reaches the caller, instead of vanishing into the output a step is read back from.
mdo_lock() { # platform
  device_guard "$1"
  lock_take "$(resource_of "$1")"
  [ "$1" != android ] || android_select
}
mdo_use() { # platform device — the device every following call addresses, lock and claim included
  if [ "$1" = ios ]; then IOS_DEVICE="$2"; else ANDROID_AVD="$2"; fi
}
mdo_device() { if [ "$1" = ios ]; then printf '%s' "$IOS_DEVICE"; else printf '%s' "$ANDROID_AVD"; fi; }
# A matrix names devices the machine may not be running: said before the first step, with the fix.
mdo_ready() { # platform device
  if [ "$1" = ios ]; then
    xcrun simctl list devices booted -j 2>/dev/null | python3 -c '
import json, sys
d = json.load(sys.stdin).get("devices") or {}
sys.exit(0 if any(x.get("name") == sys.argv[1] for r in d.values() for x in r) else 1)' "$2" \
      || die "ios: « $2 » is not booted" "vysu up ios --device \"$2\""
  else
    [ -n "$(android_serial)" ] || die "android: $2 is not running" "vysu up android --avd $2"
  fi
}
# Reading the tree needs an agent-device session on that device; the first one on a simulator
# costs the runner's build (up to a minute), which is why it is only opened when missing.
mdo_session() { # platform
  mobile_session_open "$1" && return 0
  echo "vysu: opening an agent-device session on $(mdo_device "$1") (the first one takes up to a minute)" >&2
  ad "$1" open "$(mobile_app "$1")" --foreground >/dev/null 2>&1 \
    || die "$1: no agent-device session on $(mdo_device "$1")" "vysu $1 open \"$(mobile_app "$1")\" --foreground"
}

# A step as its ✓ line prints it: the value of a `fill` is not echoed back (it may be a password).
mdo_echo() {
  case "$1" in
    fill\ *)
      if mstep_words "${1#fill }" 2>/dev/null; then
        local v="${MSTEP_W[1]:-}"
        printf 'fill "%s" (%s chars)' "${MSTEP_W[0]:-}" "${#v}"; return
      fi;;
  esac
  printf '%s' "$1"
}
# Why a step failed, in the words of its last line on stderr, without the « vysu: ios: » prefix or
# the « (vysu … snapshot -i) » hint: the screen line that follows it is the better hint.
mdo_reason() { # err-file [out-file]
  local line
  line="$(grep -v '^next: ' "$1" 2>/dev/null | grep -v '^[[:space:]]*$' | tail -1 || true)"
  [ -n "$line" ] || line="$(grep -v '^[[:space:]]*$' "${2:-/dev/null}" 2>/dev/null | tail -1 || true)"
  # Twice: a `die` adds its own « vysu: » in front of a message that may already carry one.
  line="${line#vysu: }"; line="${line#vysu: }"; line="${line#ios: }"; line="${line#android: }"
  line="${line% (vysu *)}"
  printf '%s' "${line:-failed}"
}
mdo_detail() { # out-file → the step's last line, a capture shown by its file name
  local line; line="$(grep -v '^[[:space:]]*$' "$1" 2>/dev/null | tail -1 || true)"
  case "$line" in /*.png) line="$(basename "$line")";; esac
  printf '%s' "$line"
}

# What a run leaves to be undone or said if vysu dies halfway through a step (a lock given up, an
# i18n key that does not exist): the step on stage, the devices whose text size it changed.
MDO_LIVE=""
MDO_PLATFORM=""
MDO_CHANGED=""
MDO_HOME=""
# `die` ends vysu through USR1, while the step's stdout and stderr are going to the files it is read
# back from: the handler says which step died and why on the streams saved at the start (fd 8 and
# 7), and still puts the text sizes back.
mdo_died() {
  trap 'exit 1' USR1
  if [ -n "$MDO_LIVE" ]; then
    local f; f="$(msnap_file "$MDO_PLATFORM")"
    printf '✗ %s %s · %s\n' "${MDO_LIVE%%	*}" "$(mdo_echo "${MDO_LIVE#*	}")" "$(mdo_reason "$f.err")" >&8
    grep '^next: ' "$f.err" >&7 2>/dev/null || true
    MDO_LIVE=""
  fi
  mdo_restore "$MDO_PLATFORM" >&8 2>&7 || true
}

# One step: ✓ / ✗, its number, the step as written, what it answered — then the screen after it.
mdo_step() { # platform shots n "<step>" → the step's status
  local p="$1" shots="$2" n="$3" step="$4" f rc=0
  f="$(msnap_file "$p")"; mkdir -p "$STATE"
  MDO_LIVE="$n	$step"
  mobile_step "$p" "$shots" "$step" >"$f.out" 2>"$f.err" </dev/null || rc=$?
  MDO_LIVE=""
  local detail
  if [ "$rc" = 0 ]; then
    detail="$(mdo_detail "$f.out")"
    case "$step" in screen) detail="";; esac
    printf '✓ %s %s%s\n' "$n" "$(mdo_echo "$step")" "${detail:+ · $detail}"
  else
    printf '✗ %s %s · %s\n' "$n" "$(mdo_echo "$step")" "$(mdo_reason "$f.err" "$f.out")"
  fi
  if [ "$step" = screen ] && [ "$rc" = 0 ]; then
    printf '  %s\n' "$(tail -1 "$f.out")"
  elif [ "$MSNAP_FRESH" = 1 ]; then
    printf '  '; mscreen "$p" fresh
  else
    printf '  '; mscreen "$p"
  fi
  return "$rc"
}

# The steps once, on the device in force, numbered from 1 in every run of a matrix: « ✗ 3 » is the
# third step the caller wrote, whichever device and text size it failed on. The failures add up in
# $MDO_FAILED; 1 when the run has to stop there (a failure without --keep-going).
MDO_FAILED=0
MDO_N=0
mdo_run() { # platform shots keep step…
  local p="$1" shots="$2" keep="$3" step n=0; shift 3
  mdo_session "$p"
  mscreen_reset "$p"
  for step in "$@"; do
    n=$((n + 1)); MDO_N=$((MDO_N + 1))
    mdo_step "$p" "$shots" "$n" "$step" && continue
    MDO_FAILED=$((MDO_FAILED + 1))
    [ "$keep" = 1 ] || return 1
  done
}

# Back to normal text on every device the run changed, and back to the device the command started
# on: the next command, and the next agent, find them the way they were.
mdo_restore() { # platform
  local p="$1" dev
  [ -n "$MDO_CHANGED" ] || return 0
  local changed="$MDO_CHANGED"; MDO_CHANGED=""
  while IFS= read -r dev; do
    [ -n "$dev" ] || continue
    mdo_use "$p" "$dev"
    vysu_mrelaunch "$p" --textsize normal >/dev/null
    echo "restored: $dev · textsize normal"
  done <<<"$changed"
  [ -z "$MDO_HOME" ] || mdo_use "$p" "$MDO_HOME"
}

vysu_mdo() {
  local platform="${1:-}"
  local usage='usage: vysu mdo ios|android [--shots <name>] [--keep-going] [--devices "<a>,<b>"] [--textsize "normal,xl"] -- "<step>" …  |  vysu mdo ios|android <file|-> [options]'
  case "$platform" in ios|android) shift;; *) die "$usage";; esac
  local shots="" keep=0 devices="" sizes="" file="" given=0 steps=() line
  while [ $# -gt 0 ]; do
    case "$1" in
      --shots) shots="${2:-}"; shift; [ $# -eq 0 ] || shift;;
      --keep-going) keep=1; shift;;
      --devices) devices="${2:-}"; shift; [ $# -eq 0 ] || shift;;
      --textsize) sizes="${2:-}"; shift; [ $# -eq 0 ] || shift;;
      --) shift; given=1; steps=("$@"); break;;
      -) file=-; shift;;
      -*) die "vysu mdo: unknown option $1 (steps go after --)";;
      *) [ -z "$file" ] || die "$usage"; file="$1"; shift;;
    esac
  done
  [ "$given" = 0 ] || [ -z "$file" ] || die "vysu mdo: steps after -- or a file, not both"
  [ -z "$devices" ] || device_named "$platform"   # a matrix says which devices, every one of them
  if [ -n "$file" ]; then
    [ "$file" = - ] || [ -f "$file" ] || die "no step file « $file » (steps go after --: vysu mdo $platform -- \"<step>\" …)"
    while IFS= read -r line || [ -n "$line" ]; do steps+=("$line"); done < <(read_lines "$file")
  fi
  # Blank lines and comments are not steps: the numbers an agent reads are the ones it wrote.
  local run=() s
  for s in ${steps[@]+"${steps[@]}"}; do
    s="${s#"${s%%[![:space:]]*}"}"; s="${s%"${s##*[![:space:]]}"}"
    case "$s" in ''|\#*) continue;; esac
    run+=("$s")
  done
  [ ${#run[@]} -gt 0 ] || die "$usage"
  # A capture needs a folder: one is named for the run when the caller did not give one.
  if [ -z "$shots" ]; then
    for s in "${run[@]}"; do case "$s" in shot\ *) shots="mdo-$platform-$(date +%Y%m%d-%H%M%S)"; break;; esac; done
  fi
  local t
  for t in $(printf '%s' "$sizes" | tr ',' ' '); do
    case "$t" in normal|large|xl) ;; *) die "vysu mdo: --textsize takes normal, large and xl (not « $t »)";; esac
  done

  MDO_PLATFORM="$platform"; MDO_HOME="$(mdo_device "$platform")"; MDO_CHANGED=""
  MDO_FAILED=0; MDO_N=0; MSHOT_TAKEN=""; MSHOT_PREFIX=""
  local matrix=0; [ -z "$devices$sizes" ] || matrix=1
  [ -n "$devices" ] || devices="$MDO_HOME"
  local devs=() d
  while IFS= read -r d; do
    d="${d#"${d%%[![:space:]]*}"}"; d="${d%"${d##*[![:space:]]}"}"
    [ -z "$d" ] || devs+=("$d")
  done < <(printf '%s\n' "$devices" | tr ',' '\n')
  # Every device named is checked before the first step runs: a matrix that dies on its third
  # device has already spent the first two.
  if [ "$devices" != "$MDO_HOME" ]; then
    for d in "${devs[@]}"; do mdo_use "$platform" "$d"; mdo_ready "$platform" "$d"; done
  fi
  # `-`: the text size the device already has, left alone.
  local tsizes=(-)
  [ -z "$sizes" ] || read -r -a tsizes <<<"$(printf '%s' "$sizes" | tr ',' ' ')"

  exec 7>&2 8>&1
  trap 'mdo_died; exit 1' USR1
  local stop=0 dslug size now_size note
  for d in "${devs[@]}"; do
    mdo_use "$platform" "$d"
    mdo_lock "$platform"
    dslug="$(slug "$d")"; dslug="${dslug%-}"
    for size in "${tsizes[@]}"; do
      now_size="$(mstate_get "$platform" textsize normal)"; note=""
      if [ "$size" != - ] && [ "$size" != "$now_size" ]; then
        mdo_session "$platform"
        vysu_mrelaunch "$platform" --textsize "$size" >/dev/null
        case "
$MDO_CHANGED" in *"
$d
"*) ;; *) MDO_CHANGED="$MDO_CHANGED$d
";; esac
        note=" (relaunched)"; now_size="$size"
      fi
      if [ "$matrix" = 1 ]; then
        echo "▸ $d · textsize $now_size$note"
        MSHOT_PREFIX="$dslug-$now_size-"
      fi
      mdo_run "$platform" "$shots" "$keep" "${run[@]}" || { stop=1; break; }
    done
    [ "$stop" = 0 ] || break
  done
  mdo_restore "$platform"
  trap 'exit 1' USR1
  exec 7>&- 8>&-

  local taken; taken="$(printf '%s' "$MSHOT_TAKEN" | grep -c . || true)"
  printf '%s' "$MSHOT_TAKEN" | sed '/^$/d; s/^/shot: /'
  if [ "$taken" -ge 2 ]; then
    vysu_sheet "$shots" | grep '\.png$' | sed 's/^/sheet: /'
  fi
  [ "$MDO_FAILED" = 0 ] || { echo "mdo: $MDO_FAILED of $MDO_N step(s) failed"; return 1; }
}

# One wait, one line: « ✓ « text » after 1.2s », or « ✗ » with why and what the screen shows.
vysu_mwait() {
  local platform="${1:-}"
  local usage='usage: vysu mwait ios|android "<text>" [--gone] [--timeout <s>]  |  vysu mwait ios|android --idle [--timeout <s>]'
  case "$platform" in ios|android) shift;; *) die "$usage";; esac
  local text="" gone=0 idle=0 timeout=10
  while [ $# -gt 0 ]; do
    case "$1" in
      --gone) gone=1; shift;;
      --idle) idle=1; shift;;
      --timeout) timeout="${2:-}"; shift; [ $# -eq 0 ] || shift;;
      -*) die "vysu mwait: unknown option $1";;
      *) [ -z "$text" ] || die "$usage"; text="$1"; shift;;
    esac
  done
  { [ "$idle" = 1 ] && [ -z "$text" ]; } || { [ "$idle" = 0 ] && [ -n "$text" ]; } || die "$usage"
  seconds_ok "$timeout" || die "vysu mwait: --timeout takes seconds (not « $timeout »)"
  mdo_lock "$platform"
  local f rc=0; f="$(msnap_file "$platform")"; mkdir -p "$STATE"
  if [ "$idle" = 1 ]; then mwait_idle "$platform" "$timeout" >"$f.out" 2>"$f.err" || rc=$?
  elif [ "$gone" = 1 ]; then mwait_gone "$platform" "$text" "$timeout" >"$f.out" 2>"$f.err" || rc=$?
  else mwait_text "$platform" "$text" "$timeout" >"$f.out" 2>"$f.err" || rc=$?; fi
  [ "$rc" != 0 ] || { echo "✓ $(mdo_detail "$f.out")"; return 0; }
  # No delta on a line of its own: the previous screen this device was read at is another command's.
  rm -f "$f.keys"
  # gone and idle end on a snapshot of their own; `wait text` polled agent-device's.
  local fresh=""; { [ "$idle" = 0 ] && [ "$gone" = 0 ]; } || fresh=fresh
  echo "✗ $(mdo_reason "$f.err") · $(mscreen "$platform" ${fresh:+"$fresh"})"
  return 1
}
