# pool.sh: the simulators and emulators several agent sessions share on one Mac: which ones make up
# the pool, which one is free, a claim on any of them (booting, starting or cloning one when none is
# up), one line per device for `vysu devices`, and adb / simctl on this owner's own device, under its
# lock: a raw `adb -s emulator-5556` is how one session ended up driving another one's Pixel.
# shellcheck shell=bash
# shellcheck disable=SC2153  # STATE, LOCKS, CLAIMS, LOGS, IOS_DEVICE and ANDROID_AVD are set in core.sh

# What this machine has, read once per command and kept in the main shell, where every command
# substitution below inherits it: `simctl list` and one console round trip per emulator are cheap,
# but not four times per device line.
POOL_SIMS=""   # « name<TAB>udid<TAB>state » per iOS simulator, the first of a name only (like ios_udid)
POOL_EMUS=""   # « serial<TAB>avd » per emulator attached
POOL_AVDS=""   # the AVD names the emulator knows, one per line
pool_load() { # ios | android
  case "$1" in
    ios) POOL_SIMS="$(pool_sims)";;
    android)
      POOL_EMUS="$(pool_emulators)"
      POOL_AVDS="$("$ANDROID_SDK/emulator/emulator" -list-avds 2>/dev/null || true)";;
  esac
}
pool_sims() {
  xcrun simctl list devices available -j 2>/dev/null | python3 -c '
import json, sys
try:
    devices = json.load(sys.stdin).get("devices") or {}
except ValueError:
    sys.exit(0)
seen = set()
for runtime, items in devices.items():
    if ".SimRuntime.iOS-" not in runtime:
        continue
    for d in items:
        if d["name"] in seen:
            continue
        seen.add(d["name"])
        print("%s\t%s\t%s" % (d["name"], d["udid"], d.get("state", "")))
' 2>/dev/null || true
}
pool_emulators() {
  local s
  for s in $(adb devices 2>/dev/null | awk '$1 ~ /^emulator-/ && $2 == "device" { print $1 }'); do
    printf '%s\t%s\n' "$s" "$(android_avd_of "$s")"
  done
}
pool_sim() { # name → « udid<TAB>state », or nothing when this machine has no such simulator
  printf '%s\n' "$POOL_SIMS" | awk -F'\t' -v n="$1" '$1 == n { print $2 "\t" $3; exit }'
}
pool_serial() { # avd → the serial it runs on, or nothing
  printf '%s\n' "$POOL_EMUS" | awk -F'\t' -v n="$1" '$2 == n { print $1; exit }'
}

# A clone vysu made is named after its source, « <name> (vysu N) »: that suffix is how the pool,
# `release --delete-clone` and `--prune-clones` tell it from a simulator somebody made by hand.
pool_is_clone() { case "$1" in *" (vysu "[0-9]*")") return 0;; esac; return 1; }
pool_clones() { # the vysu clones this machine has, one per line
  local n
  while IFS= read -r n; do
    if pool_is_clone "$n"; then printf '%s\n' "$n"; fi
  done <<EOF
$(printf '%s\n' "$POOL_SIMS" | cut -f1)
EOF
}
# The pool as the config names it. VYSU_IOS_DEVICES empty means the two simulators a project already
# declares (the recent one and the old one), so a project that says nothing still has a pool of two.
pool_ios_config() {
  local list; list="$(cfg IOS_DEVICES)"
  [ -n "$list" ] || list="$(cfg IOS_DEVICE "$IOS_DEFAULT_DEVICE"),$(cfg IOS_OLD_DEVICE)"
  printf '%s\n' "$list" | tr ',' '\n' | sed 's/^ *//; s/ *$//' | awk 'NF && !seen[$0]++'
}
pool_ios_names() { { pool_ios_config; pool_clones; } | awk 'NF && !seen[$0]++'; }
# shellcheck disable=SC2046  # splitting on « ; » is the point: one spec per AVD
pool_android_names() {
  local IFS=';' spec
  for spec in $(cfg ANDROID_AVDS); do printf '%s\n' "${spec%%:*}"; done | awk 'NF && !seen[$0]++'
}

# Where a device is at: booted · running on emulator-NNNN · shut down · not on this machine.
pool_power() { # platform [name]: the owner's device when no name is given
  local name
  if [ "$1" = ios ]; then
    name="${2:-$IOS_DEVICE}"
    [ -n "$POOL_SIMS" ] || POOL_SIMS="$(pool_sims)"
    local st; st="$(pool_sim "$name" | cut -f2)"
    case "$st" in
      Booted) echo booted;;
      Shutdown) echo "shut down";;
      '') echo "not on this machine";;
      *) printf '%s\n' "$st" | tr '[:upper:]' '[:lower:]';;
    esac
  else
    name="${2:-$ANDROID_AVD}"
    [ -n "$POOL_EMUS$POOL_AVDS" ] || pool_load android
    local s; s="$(pool_serial "$name")"
    if [ -n "$s" ]; then echo "running on $s"
    elif printf '%s\n' "$POOL_AVDS" | grep -qxF "$name"; then echo "shut down"
    else echo "not on this machine"; fi
  fi
}
pool_is_up() { case "$1" in booted|running\ on\ *) return 0;; esac; return 1; }

# Taken by nobody but this owner: « mine », « theirs » or nothing. claim_why drops an expired or an
# orphaned claim on the way, so what is left is a claim somebody alive still holds.
pool_claim_state() { # resource
  [ -z "$(claim_why "$1")" ] || { echo theirs; return; }
  [ ! -f "$CLAIMS/$1" ] || echo mine
}
# A command of somebody else running on it right now: a device with no claim is not free while an
# agent is halfway through an `mrelaunch` on it, and it would only wait for it anyway.
pool_locked() { # resource
  local d="$LOCKS/$1"
  [ -d "$d" ] && lock_alive "$d" && [ "$(cat "$d/pid" 2>/dev/null || true)" != "$VYSU_PID" ]
}

# What vysu last applied to that device (mstate_line without its « state: »). The locals shadow the
# owner's device for the functions called from here only: bash scopes them dynamically.
pool_mstate() { # platform name
  local IOS_DEVICE="$2" ANDROID_AVD="$2"
  mstate_line "$(mstate_file "$1")" | sed 's/^state[^:]*: //'
}
# One line per device, the same for `vysu devices` and for the list a busy `claim --any` prints:
# ios « iPhone 17 Pro » booted · claimed by codex:5120 until 15:40 (login flow) · textsize xl · by …
pool_line() { # platform name power
  local platform="$1" name="$2" power="$3" r f held owner until_s note lock="" st
  r="$platform-$(slug "$name")"; f="$CLAIMS/$r"
  claim_why "$r" >/dev/null   # an expired or orphaned claim is gone before it is printed
  if [ -f "$f" ]; then
    owner="$(claim_field "$f" owner)"; until_s="$(claim_field "$f" until)"; note="$(claim_field "$f" note)"
    held="claimed by $owner"
    [ "$owner" != "$(vysu_owner)" ] || held="$held (you)"
    held="$held until $(date -r "${until_s:-0}" +%H:%M)${note:+ ($note)}"
  else
    held=free
  fi
  # The command cut at 48 characters (python: sed would cut a « À » in half in a C locale): a `vysu mdo`
  # line runs to 120, and the device is what the line is about.
  if pool_locked "$r"; then
    lock=" · lock: $(lock_who "$LOCKS/$r" | python3 -c 'import re, sys; print(re.sub(r"« (.{48}).+ »", "« \\1… »", sys.stdin.read().strip()))')"
  fi
  st="$(pool_mstate "$platform" "$name")"
  case "$st" in '('*) st="";; esac
  local mine=""
  if [ "$platform" = ios ] && [ "$name" = "$IOS_DEVICE" ]; then mine=" · your device"; fi
  if [ "$platform" = android ] && [ "$name" = "$ANDROID_AVD" ]; then mine=" · your device"; fi
  printf '%s « %s » %s · %s%s%s%s\n' "$platform" "$name" "$power" "$held" "$lock" "${st:+ · $st}" "$mine"
}

# `vysu devices`: every device of the pool, every clone, every simulator booted and every emulator
# running, whoever started it. No snapshot and no agent-device session: it answers in a second.
vysu_devices() {
  case "${1:-}" in
    --prune-clones) shift; pool_prune_clones "$@"; return;;
    '') ;;
    *) die "usage: vysu devices [--prune-clones [--dry-run]]";;
  esac
  pool_load ios; pool_load android
  local n names
  names="$( { pool_ios_names; printf '%s\n' "$POOL_SIMS" | awk -F'\t' '$3 == "Booted" { print $1 }'
    pool_claimed ios "$(printf '%s\n' "$POOL_SIMS" | cut -f1)"; printf '%s\n' "$IOS_DEVICE"; } | awk 'NF && !seen[$0]++')"
  while IFS= read -r n; do
    [ -z "$n" ] || pool_line ios "$n" "$(pool_power ios "$n")"
  done <<EOF
$names
EOF
  names="$( { pool_android_names; printf '%s\n' "$POOL_EMUS" | cut -f2; pool_claimed android "$POOL_AVDS"
    printf '%s\n' "$ANDROID_AVD"; } | awk 'NF && !seen[$0]++')"
  while IFS= read -r n; do
    [ -z "$n" ] || pool_line android "$n" "$(pool_power android "$n")"
  done <<EOF
$names
EOF
  pool_sweep_choices
}
# The devices of this machine somebody claims, out of the pool or not: a claim names a resource, so
# each name is matched through its slug.
pool_claimed() { # platform "<name per line>"
  local n
  while IFS= read -r n; do
    if [ -n "$n" ] && [ -f "$CLAIMS/$1-$(slug "$n")" ]; then printf '%s\n' "$n"; fi
  done <<EOF
$2
EOF
}
# The device choices an agent session left behind (`ios-device.claude-41234`): once its process is
# gone nobody reads that file again, until a new process is handed the same pid and inherits a
# device it never chose. Only the « <name>-<pid> » shape an owner detected from its process has,
# and only a pid that no longer exists: an owner named by hand is never touched.
pool_sweep_choices() {
  local f suffix pid name
  for f in "$STATE"/ios-device.* "$STATE"/android-avd.*; do
    [ -f "$f" ] || continue
    suffix="${f##*/}"; suffix="${suffix#*.}"
    pid="${suffix##*-}"; name="${suffix%-*}"
    case "$pid" in ''|*[!0-9]*) continue;; esac
    case "$name" in ''|*[!A-Za-z0-9._]*) continue;; esac
    if ! ps -p "$pid" >/dev/null 2>&1; then rm -f "$f"; fi
  done
}

# --- claim --any -------------------------------------------------------------------------------

# The device a `claim --any` takes, in this order: one this owner already claims (a second `--any`
# in the same task must not collect a second device), a free booted one, a free shut-down one it
# boots (Android: while fewer than VYSU_ANDROID_MAX_RUNNING emulators run, 4 GB of RAM each), and
# on iOS a clone of a shut-down pool member, up to VYSU_IOS_MAX_CLONES. Within each rank the owner's
# current device first: the app, its login and its state are already there.
# Sets POOL_ACTION (own | booted | boot | start | clone), POOL_NAME, POOL_SRC; POOL_WHY says why
# there is no clone or no start when POOL_ACTION stays empty.
POOL_ACTION=""; POOL_NAME=""; POOL_SRC=""; POOL_WHY=""
pool_rank() { # current-best candidate → the candidate, the owner's device winning a tie
  if [ -z "$1" ] || [ "$2" = "$3" ]; then printf '%s' "$2"; else printf '%s' "$1"; fi
}
pool_pick() { # platform
  local platform="$1" current n power r own="" own_down="" up="" down="" names
  POOL_ACTION=""; POOL_NAME=""; POOL_SRC=""; POOL_WHY=""
  if [ "$platform" = ios ]; then current="$IOS_DEVICE"; names="$(pool_ios_names)"
  else current="$ANDROID_AVD"; names="$(pool_android_names)"; fi
  while IFS= read -r n; do
    [ -n "$n" ] || continue
    power="$(pool_power "$platform" "$n")"
    [ "$power" != "not on this machine" ] || continue
    r="$platform-$(slug "$n")"
    case "$(pool_claim_state "$r")" in
      mine)
        # One this owner holds already, up first: a second `--any` in the same task gets the
        # device of the first one back instead of a second device.
        if pool_is_up "$power"; then own="$(pool_rank "$own" "$n" "$current")"
        else own_down="$(pool_rank "$own_down" "$n" "$current")"; fi
        continue;;
      theirs) continue;;
    esac
    ! pool_locked "$r" || continue
    if pool_is_up "$power"; then up="$(pool_rank "$up" "$n" "$current")"
    elif [ "$power" = "shut down" ]; then down="$(pool_rank "$down" "$n" "$current")"; fi
  done <<EOF
$names
EOF
  if [ -n "$own" ]; then POOL_ACTION=own; POOL_NAME="$own"; return; fi
  local running max; running="$(printf '%s\n' "$POOL_EMUS" | awk 'NF' | wc -l | tr -d ' ')"
  max="$(cfg ANDROID_MAX_RUNNING 2)"
  if [ -n "$own_down" ]; then
    POOL_NAME="$own_down"
    if [ "$platform" = ios ]; then POOL_ACTION=boot
    elif [ "$running" -lt "$max" ]; then POOL_ACTION=start
    else POOL_ACTION=own; fi   # held but stopped, and no room to start it: said on the device line
    return
  fi
  if [ -n "$up" ]; then POOL_ACTION=booted; POOL_NAME="$up"; return; fi
  if [ "$platform" = android ]; then
    if [ -n "$down" ] && [ "$running" -lt "$max" ]; then POOL_ACTION=start; POOL_NAME="$down"; return; fi
    if [ -n "$down" ]; then POOL_WHY="start: « $down » is free but $running emulators already run (VYSU_ANDROID_MAX_RUNNING=$max)"
    else POOL_WHY="start: no AVD of the pool is both free and stopped (VYSU_ANDROID_AVDS)"; fi
    return
  fi
  if [ -n "$down" ]; then POOL_ACTION=boot; POOL_NAME="$down"; return; fi
  # A clone copies the source's disk (the app installed, its login, its settings), which is the
  # whole point, and `simctl clone` only copies a simulator that is shut down.
  local clones src=""
  max="$(cfg IOS_MAX_CLONES 1)"
  clones="$(pool_clones | awk 'NF' | wc -l | tr -d ' ')"
  if [ "$clones" -ge "$max" ]; then
    POOL_WHY="clone: VYSU_IOS_MAX_CLONES=$max reached ($clones on this machine)"; return
  fi
  while IFS= read -r n; do
    [ -n "$n" ] || continue
    [ "$(pool_power ios "$n")" = "shut down" ] || continue
    ! pool_locked "ios-$(slug "$n")" || continue
    src="$n"; break
  done <<EOF
$(pool_ios_config)
EOF
  if [ -z "$src" ]; then
    POOL_WHY="clone: a clone needs a shut-down source, and every pool device is booted (its holder shuts one down: vysu simctl shutdown)"
    return
  fi
  local i=1; while [ -n "$(pool_sim "$src (vysu $i)")" ]; do i=$((i + 1)); done
  POOL_ACTION=clone; POOL_SRC="$src"; POOL_NAME="$src (vysu $i)"
}
pool_busy_report() { # platform: who holds what, on stderr
  local n names
  if [ "$1" = ios ]; then names="$(pool_ios_names)"; else names="$(pool_android_names)"; fi
  while IFS= read -r n; do
    [ -z "$n" ] || printf '  %s\n' "$(pool_line "$1" "$n" "$(pool_power "$1" "$n")")" >&2
  done <<EOF
$names
EOF
  [ -z "$POOL_WHY" ] || printf '  %s\n' "$POOL_WHY" >&2
}
pool_claim_any() { # platform minutes note nowait
  local platform="$1" minutes="$2" note="$3" nowait="$4" start said=0 waited
  start="$(date +%s)"
  while :; do
    # Two `--any` at the same moment would pick the same free device: the choice and the claim that
    # seals it are made under one pool-wide lock, dropped as soon as the claim is written.
    lock_take "pool-$platform"
    pool_load "$platform"
    pool_pick "$platform"
    [ -z "$POOL_ACTION" ] || break
    lock_drop "pool-$platform"
    waited=$(( $(date +%s) - start ))
    if [ "$nowait" = 1 ] || [ "$waited" -ge "$LOCK_WAIT" ]; then
      echo "vysu: no free $platform device in the pool$( [ "$said" = 0 ] || printf ' after %ss' "$waited"):" >&2
      pool_busy_report "$platform"
      die "no free $platform device" "vysu claim $platform --any (waits VYSU_LOCK_WAIT=${LOCK_WAIT}s for one)"
    fi
    if [ "$said" = 0 ]; then
      echo "vysu: no free $platform device, waiting up to ${LOCK_WAIT}s (VYSU_LOCK_WAIT):" >&2
      pool_busy_report "$platform"; said=1
    fi
    sleep 3
  done
  local name="$POOL_NAME" r done_line=""
  r="$platform-$(slug "$name")"
  claim_write "$r" "$minutes" "$note" "$name"
  if [ "$POOL_ACTION" = clone ]; then
    local src_udid; src_udid="$(pool_sim "$POOL_SRC" | cut -f1)"
    echo "vysu: cloning « $POOL_SRC » into « $name »…" >&2
    if ! xcrun simctl clone "$src_udid" "$name" >/dev/null 2>&1; then
      rm -f "$CLAIMS/$r"; die "ios: could not clone « $POOL_SRC » (xcrun simctl clone)"
    fi
    done_line="cloned from « $POOL_SRC », booted"
  fi
  lock_drop "pool-$platform"
  if [ "$platform" = ios ]; then IOS_DEVICE="$name"; device_remember ios-device "$name"
  else ANDROID_AVD="$name"; device_remember android-avd "$name"; fi
  device_named "$platform"
  case "$POOL_ACTION" in
    boot|clone)
      echo "vysu: booting « $name »…" >&2
      pool_ios_boot || { rm -f "$CLAIMS/$r"; die "ios: « $name » did not boot" "vysu devices"; }
      [ -n "$done_line" ] || done_line="booted (it was shut down)";;
    start)
      echo "vysu: starting « $name »…" >&2
      pool_android_start || { rm -f "$CLAIMS/$r"; die "android: « $name » did not start (see $LOGS/android-emulator.log)" "vysu devices"; }
      done_line="started on $ANDROID_SERIAL";;
  esac
  POOL_SIMS=""; POOL_EMUS=""; POOL_AVDS=""   # what was just booted is read again by the report
  claim_report "$platform" "$r" "$done_line"
}
# A shut-down simulator, booted the way `vysu up ios` does it (the Simulator window, the status bar),
# and waited for up to the springboard (`bootstatus`, not just the « Booted » flag). Bounded: a
# simulator that never comes up must not hold the claim forever. 1 when it did not boot.
pool_ios_boot() {
  ios_lock
  local udid; udid="$(ios_udid --refresh)"
  [ "$udid" != booted ] || return 1
  xcrun simctl boot "$udid" >/dev/null 2>&1 || true
  open -a Simulator >/dev/null 2>&1 || true
  xcrun simctl bootstatus "$udid" >/dev/null 2>&1 &
  local pid=$! i
  for i in $(seq 1 180); do kill -0 "$pid" 2>/dev/null || break; sleep 1; done
  kill "$pid" 2>/dev/null || true; wait "$pid" 2>/dev/null || true
  xcrun simctl list devices 2>/dev/null | grep -F "$udid" | grep -q '(Booted)' || return 1
  ios_freeze_status_bar
}
# A stopped AVD, started with the flags `vysu up android` starts one with (host GPU, 4 GB, no
# snapshot), and waited for until it has booted. 1 when it never came up.
pool_android_start() {
  android_lock
  mkdir -p "$LOGS"
  nohup "$ANDROID_SDK/emulator/emulator" -avd "$ANDROID_AVD" -gpu host -memory 4096 -cores 4 -dns-server 1.1.1.1,8.8.8.8 -no-snapshot-load -no-boot-anim >"$LOGS/android-emulator.log" 2>&1 </dev/null &
  local i s=""
  for i in $(seq 1 60); do s="$(android_serial)"; [ -z "$s" ] || break; sleep 2; done
  [ -n "$s" ] || return 1
  ANDROID_SERIAL="$s"; export ANDROID_SERIAL
  for i in $(seq 1 80); do
    [ "$(adb shell getprop sys.boot_completed 2>/dev/null | tr -d '\r')" != 1 ] || break
    sleep 3
  done
  [ "$(adb shell getprop sys.boot_completed 2>/dev/null | tr -d '\r')" = 1 ] || return 1
  # Metro reachable as localhost from the emulator: an expo concern only.
  [ "$(mobile_kind)" != expo ] || adb reverse "tcp:$(metro_port)" "tcp:$(metro_port)" >/dev/null 2>&1 || true
}

# --- clones ------------------------------------------------------------------------------------

# Everything remembered about a device that no longer exists: its UDID, scale and state caches, and
# every owner's choice naming it: the next command of that owner falls back to the config instead
# of failing on a simulator that is gone.
pool_forget_device() { # platform name
  local s f; s="$(slug "$2")"
  rm -f "$STATE/ios-udid-$s" "$STATE/scale-$1-$s" "$STATE/state-$1-$s.env"
  for f in "$STATE"/ios-device "$STATE"/ios-device.*; do
    [ -f "$f" ] || continue
    if [ "$(cat "$f")" = "$2" ]; then rm -f "$f"; fi
  done
}
pool_delete_clone() { # name: shut down and delete one vysu clone
  local name="$1" udid
  pool_is_clone "$name" || die "« $name » is not a vysu clone: only a « <name> (vysu N) » simulator is deleted"
  [ -n "$POOL_SIMS" ] || POOL_SIMS="$(pool_sims)"
  udid="$(pool_sim "$name" | cut -f1)"
  [ -n "$udid" ] || { pool_forget_device ios "$name"; echo "deleted: ios « $name » was already gone"; return; }
  # Its agent-device session is bound to that UDID: a later clone of the same name would inherit a
  # session pointing at a simulator that no longer exists.
  local session; session="$(cfg PROJECT)-ios-$(slug "$name")"
  case "$(agent-device session list 2>/dev/null || true)" in
    *"\"$session\""*) agent-device close --session "$session" >/dev/null 2>&1 || true;;
  esac
  xcrun simctl shutdown "$udid" >/dev/null 2>&1 || true
  xcrun simctl delete "$udid" >/dev/null 2>&1 || die "ios: could not delete « $name » (xcrun simctl delete $udid)"
  pool_forget_device ios "$name"
  echo "deleted: ios « $name »"
}
# `vysu devices --prune-clones`: the clones nobody claims and nobody is driving, deleted: a clone is
# a whole simulator on disk, and one booted is 1-2 GB of RAM on a machine that has none to spare.
pool_prune_clones() {
  local dry=0
  case "${1:-}" in --dry-run) dry=1;; '') ;; *) die "usage: vysu devices --prune-clones [--dry-run]";; esac
  pool_load ios
  local n r any=0
  while IFS= read -r n; do
    [ -n "$n" ] || continue
    any=1; r="ios-$(slug "$n")"
    claim_why "$r" >/dev/null
    if [ -f "$CLAIMS/$r" ]; then echo "kept: ios « $n » claimed by $(claim_field "$CLAIMS/$r" owner)"; continue; fi
    if pool_locked "$r"; then echo "kept: ios « $n » in use ($(lock_who "$LOCKS/$r"))"; continue; fi
    if [ "$dry" = 1 ]; then echo "would delete: ios « $n » ($(pool_power ios "$n"))"; continue; fi
    lock_take "$r"   # nobody claims it or drives it, and nobody starts to while it goes
    pool_delete_clone "$n"
  done <<EOF
$(pool_clones)
EOF
  [ "$any" = 1 ] || echo "clones: none"
}

# --- adb and simctl on this owner's device -----------------------------------------------------

# `vysu adb …`: the owner's AVD, locked and addressed by its serial, never « the » device adb would
# pick, nor the serial of an emulator another session holds. A serial given here would defeat that,
# and `kill-server` takes every emulator's adb connection down for every session: both refused.
vysu_adb() {
  [ $# -gt 0 ] || die "usage: vysu adb <adb args…>  (on $ANDROID_AVD, the owner's AVD)"
  local a
  for a in "$@"; do
    case "$a" in
      -s|-e|-d|-t|-H|-P|-L|-s*|-t*) die "vysu adb runs on $ANDROID_AVD, this owner's AVD: $a is not taken" "vysu claim android --avd <name>, then vysu adb …";;
      kill-server) die "vysu adb kill-server would cut every emulator's connection, for every session";;
      -*) ;;
      *) break;;   # the adb command: what follows is its own arguments
    esac
  done
  android_select
  local rc=0
  adb -s "$ANDROID_SERIAL" "$@" || rc=$?
  return "$rc"
}
# `vysu simctl <verb> …`: the owner's simulator UDID after the verb, under its lock. Run as is, not
# through `sim`: `spawn … log stream` and `io … recordVideo` stream, and `sim` holds the output
# until the end. The staleness `sim` recovers from after the fact is checked up front instead: a
# UDID remembered for a simulator deleted since has no folder any more.
vysu_simctl() {
  local verb="${1:-}"; [ -n "$verb" ] || die "usage: vysu simctl <verb> [args…]  (on « $IOS_DEVICE », the owner's simulator)"
  shift
  local rc=0
  case "$verb" in
    # The verbs that take no device, or several: as they are.
    list|create|clone|runtime|help|pair|unpair|pair_activate|diagnose|-*)
      xcrun simctl "$verb" "$@" || rc=$?
      return "$rc";;
  esac
  ios_lock
  local udid; udid="$(ios_udid)"
  [ -d "$HOME/Library/Developer/CoreSimulator/Devices/$udid" ] || udid="$(ios_udid --refresh)"
  [ "$udid" != booted ] || die "ios: no simulator named « $IOS_DEVICE »" "vysu devices"
  xcrun simctl "$verb" "$udid" "$@" || rc=$?
  return "$rc"
}
