# mobile.sh — everything that goes through agent-device: choosing and addressing a simulator or an
# emulator (UDID, serial, scale, all remembered per device), what vysu last applied to it
# (text size, appearance, language, persona), the verbs a mobile flow is written in — tap / shot /
# relaunch — and the Metro log.
# shellcheck shell=bash
# shellcheck disable=SC2034  # EV_TARGET is read by core.sh (ev_log)
# shellcheck disable=SC2153  # STATE, LOGS, IOS_DEVICE and ANDROID_AVD are set in core.sh

# Flags after the positionals: that is the order agent-device documents. $1 = ios | android.
ad() {
  local platform="$1"; shift
  case "$platform" in
    # One agent-device session per device: a session stays bound to the one it opened.
    ios) ios_lock; agent-device "$@" --session "$(cfg PROJECT)-ios-$(slug "$IOS_DEVICE")" --platform ios --device "$IOS_DEVICE";;
    android) android_select; agent-device "$@" --session "$(cfg PROJECT)-android-$(slug "$ANDROID_AVD")" --platform android --serial "$ANDROID_SERIAL";;
    *) die "platform must be ios or android";;
  esac
}
# The primitive a connector drives a device with.
mob() { ad "$@"; }
# By accessible name first, by visible text otherwise (a dev-menu button carries no role).
ad_press_if() {
  ad "$1" press "role=\"button\" label=\"$2\"" --settle >/dev/null 2>&1 \
    || ad "$1" press "text=\"$2\"" --settle >/dev/null 2>&1
}
mob_press_if() { ad_press_if "$@"; }
mob_wait_text() { ad "$1" wait text "$2" "${3:-8000}" >/dev/null 2>&1; }
# A label a system dialog shows in the simulator's own locale: a connector names the ones it knows,
# the engine tries each in turn and never fails on a dialog that did not show up.
mob_press_any() { # platform "<label>,<label>…"
  local platform="$1" label IFS=,
  for label in $2; do
    [ -n "$label" ] || continue
    ad_press_if "$platform" "$label" && return 0
  done
  return 1
}
# The same, for a list whose labels are not alternatives but a sequence: each one is pressed if it
# is there. « Enter directly » then « Back home » are two dialogs in a row, not two names for one.
mob_press_all() { # platform "<label>,<label>…"
  local platform="$1" label pressed=1 IFS=,
  for label in $2; do
    [ -n "$label" ] || continue
    ad_press_if "$platform" "$label" && pressed=0
  done
  return "$pressed"
}
mobile_app() { [ "$1" = ios ] && printf '%s' "$(cfg IOS_APP)" || printf '%s' "$(cfg MOBILE_BUNDLE)"; }
# `simctl … booted` is ambiguous once two simulators run: always address the chosen device's UDID.
# Resolving it costs a full `simctl list` (~1 s), so it is remembered per device name; `sim` forgets
# the file when simctl no longer knows that UDID (a simulator deleted or recreated meanwhile).
ios_udid() {
  local f; f="$STATE/ios-udid-$(slug "$IOS_DEVICE")"
  [ "${1:-}" != "--refresh" ] || rm -f "$f"
  [ -s "$f" ] && { cat "$f"; return; }
  local udid; udid="$(xcrun simctl list devices available -j | python3 -c "import sys,json; d=json.load(sys.stdin)['devices']; print(next((x['udid'] for r in d for x in d[r] if x['name']==sys.argv[1]), 'booted'))" "$IOS_DEVICE")"
  [ "$udid" = booted ] || { mkdir -p "$STATE"; printf '%s' "$udid" >"$f"; }
  printf '%s' "$udid"
}
# The status bar is chrome, not UI, and it moves: the charging bolt pulses, so two captures of a
# still screen differ. Asked for once per session — it is honoured up to iOS 18 and silently dropped
# on the iOS 26 runtimes (`simctl status_bar list` comes back empty right after a successful
# override), which is why a capture is also compared with its battery corner masked (mshot).
ios_freeze_status_bar() {
  sim status_bar override --time 9:41 --batteryState discharging --batteryLevel 100 --wifiBars 3 --cellularBars 4 >/dev/null 2>&1 || true
}
sim() { # xcrun simctl <verb> <the chosen simulator> …, retried once on a stale cached UDID
  ios_lock
  local out rc=0
  out="$(xcrun simctl "$1" "$(ios_udid)" "${@:2}" 2>&1)" || rc=$?
  if [ "$rc" != 0 ] && printf '%s' "$out" | grep -qi 'invalid device\|unable to find\|not found'; then
    rc=0; out="$(xcrun simctl "$1" "$(ios_udid --refresh)" "${@:2}" 2>&1)" || rc=$?
  fi
  [ -z "$out" ] || printf '%s\n' "$out"
  return "$rc"
}
# `adb` picks « the » device and fails with « more than one device/emulator » as soon as a second
# emulator is attached: every android path resolves the serial of $ANDROID_AVD first and exports it,
# which adb honours for every command — agent-device's own adb calls included.
# Asking an emulator its AVD name costs a console round trip, so it is remembered per AVD and only
# looked up again when that serial stops answering.
android_avd_of() { adb -s "$1" emu avd name 2>/dev/null | head -1 | tr -d '\r'; }
android_serial() { # → emulator-NNNN, or nothing when $ANDROID_AVD is not running
  local f s; f="$STATE/android-serial-$(slug "$ANDROID_AVD")"
  # The cached serial is checked by name rather than by liveness: an emulator restarted while
  # another one held 5554 comes back on another port, and the port it left is taken by its neighbour.
  if [ -s "$f" ]; then
    s="$(cat "$f")"
    [ "$(android_avd_of "$s")" != "$ANDROID_AVD" ] || { printf '%s' "$s"; return; }
    rm -f "$f"
  fi
  for s in $(adb devices 2>/dev/null | awk '$1 ~ /^emulator-/ && $2 == "device" { print $1 }'); do
    [ "$(android_avd_of "$s")" = "$ANDROID_AVD" ] || continue
    mkdir -p "$STATE"; printf '%s' "$s" >"$f"; printf '%s' "$s"; return
  done
}
android_select() { # what every android path starts with: the emulator is locked, then addressed
  android_lock
  ANDROID_SERIAL="$(android_serial)"; export ANDROID_SERIAL
  [ -n "$ANDROID_SERIAL" ] || die "android: $ANDROID_AVD is not running (vysu up android --avd $ANDROID_AVD)"
}
wait_android_boot() { # on $ANDROID_SERIAL; bounded: a vanished device must not spin forever
  local i; for i in $(seq 1 80); do
    [ "$(adb shell getprop sys.boot_completed 2>/dev/null | tr -d '\r')" = "1" ] && return 0; sleep 3
  done
  die "android: emulator not booted after 4 min (see $LOGS/android-emulator.log)"
}
# A zygote restart takes adbd with it: `sys.boot_completed` comes back as 1 while the shell still
# answers nothing, and a launch sent then is simply lost. Wait for a real command to answer too.
wait_android_shell() {
  local i; for i in $(seq 1 40); do
    [ "$(adb shell getprop sys.boot_completed 2>/dev/null | tr -d '\r')" = "1" ] \
      && [ -n "$(adb shell dumpsys window 2>/dev/null)" ] && return 0
    sleep 3
  done
  die "android: shell still not answering 2 min after the restart"
}
# `emulator -avd <name>` takes the next free even port (5554, 5556…), so the serial of the one just
# started is only known once it answers to its own name.
wait_android_serial() {
  local i s; for i in $(seq 1 60); do
    s="$(android_serial)"; [ -z "$s" ] || { printf '%s' "$s"; return 0; }
    sleep 2
  done
  die "android: $ANDROID_AVD never showed up in adb devices (see $LOGS/android-emulator.log)"
}

# What vysu last applied to a device: a mobile capture records it, and `tap t:<key>` reads the
# language back from it. Per device, like the scale cache: two emulators run side by side, and a
# `mrelaunch android --lang en` on one of them used to make `tap t:common.close` look for the
# English label on the other, still in the first language.
mstate_file() { # platform
  local dev="$ANDROID_AVD"; [ "$1" = android ] || dev="$IOS_DEVICE"
  printf '%s/state-%s-%s.env' "$STATE" "$1" "$(slug "$dev")"
}
# `|| true`: a key that is not there is an answer, not a failure — and under pipefail a silent grep
# would otherwise end an « v="$(mstate_field …)" » on the spot.
mstate_field() { grep "^$2=" "$1" 2>/dev/null | tail -1 | cut -d= -f2- || true; }
# Every setter goes through here, so every write also says who made it and when: the next agent
# reads « by codex:5120 at 14:52 » in `vysu claim` instead of wondering whose device it just took.
mstate_set() { # platform key value
  local f; f="$(mstate_file "$1")"; mkdir -p "$STATE"; touch "$f"
  { grep -Ev "^($2|by|at)=" "$f" || true; echo "$2=$3"; echo "by=$(vysu_owner)"; date +at=%s; } >"$f.tmp"
  mv "$f.tmp" "$f"
}
mstate_get() { # platform key [default]
  local v; v="$(mstate_field "$(mstate_file "$1")" "$2")"
  printf '%s' "${v:-${3:-}}"
}
# Pixels per point (iOS) or per dp (Android) of the running device, for the motion report and for
# capturing at 1x. Two screenshots to find out: remembered per device until `vysu cache clear`.
mobile_scale() {
  local dev="$ANDROID_AVD"; [ "$1" = ios ] && dev="$IOS_DEVICE"
  local f; f="$STATE/scale-$1-$(slug "$dev")"
  [ -s "$f" ] && { cat "$f"; return; }
  local scale
  if [ "$1" = android ]; then
    android_select
    scale="$(python3 -c "import sys; print(int(sys.argv[1]) / 160)" "$(adb shell wm density | grep -oE '[0-9]+' | head -1)")"
  else
    # agent-device captures at 1x and prints that logical size (« (402x874 @1x) »); simctl captures
    # the device's pixels. Their ratio is the scale.
    local logical; logical="$(ad ios screenshot /tmp/vysu-scale-1x.png 2>/dev/null | grep -oE '\([0-9]+x[0-9]+ @1x\)' | grep -oE '^\([0-9]+' | tr -d '(')"
    sim io screenshot /tmp/vysu-scale.png >/dev/null 2>&1
    local px; px="$(python3 -c "from PIL import Image; print(Image.open('/tmp/vysu-scale.png').width)")"
    scale="$(python3 -c "import sys; print(round(int(sys.argv[1]) / int(sys.argv[2])))" "$px" "${logical:-$px}")"
  fi
  mkdir -p "$STATE"; printf '%s' "$scale" >"$f"
  printf '%s\n' "$scale"
}
# What a 1x capture asks of agent-device. iOS captures at 1x already, and has its clock and bars
# repainted (the battery is masked at diff time); Android hands back device pixels — 1080x2400 on a
# Pixel 8, three times the tokens of the same picture in dp, and boxes a report in pixels the rest
# of vysu counts in dp.
mcapture_args() { # platform → the flags, space-separated
  [ "$1" != ios ] || { printf '%s' --normalize-status-bar; return; }
  printf '%s %s' --scale "$(python3 -c "import sys; print(round(1 / float(sys.argv[1]), 4))" "$(mobile_scale "$1")")"
}

# The screens that prove the app has booted, as a grep alternation: the project names them, since
# nothing else about the app is known here. Absent, the wait falls back to a fixed delay.
mobile_ready_grep() {
  local texts; texts="$(cfg MOBILE_READY_TEXT)"
  [ -n "$texts" ] || return 1
  printf '%s' "$texts" | tr ',' '\n' | sed 's/^/"/; s/$/"/' | paste -sd'|' -
}
# A freshly installed dev-client shows Expo's launcher until it is handed the Metro bundle URL.
mobile_load_bundle() {
  local scheme; scheme="$(cfg MOBILE_SCHEME)"
  [ -n "$scheme" ] || return 0
  local on_launcher=0
  if [ "$1" = android ]; then
    adb shell dumpsys window 2>/dev/null | grep -q "DevLauncherActivity" && on_launcher=1
  else
    ad ios snapshot -i 2>/dev/null | grep -q '"Development Build"' && on_launcher=1
  fi
  if [ "$on_launcher" = 1 ]; then
    local metro="localhost:8081"
    local url="$scheme://expo-development-client/?url=http%3A%2F%2Flocalhost%3A8081"
    # Which Metro this dev-client is bound to: an agent taking the device over needs it to know
    # whether the bundle on screen is the one its own branch serves.
    mstate_set "$1" metro "$metro"
    if [ "$1" = ios ]; then
      sim openurl "$url" >/dev/null
      sleep 2; mob_press_any ios "Ouvrir,Open" || true   # iOS 18 confirms a custom-scheme URL from simctl
    else adb shell am start -a android.intent.action.VIEW -d "$url" >/dev/null 2>&1; fi
    # First bundle of a fresh Metro takes a while; poll the window instead of guessing a delay.
    local ready; ready="$(mobile_ready_grep || true)"
    local i; for i in $(seq 1 30); do
      sleep 3
      if [ "$1" = android ]; then adb shell dumpsys window 2>/dev/null | grep -q "MainActivity" && break
      elif [ -n "$ready" ]; then ad ios snapshot -i 2>/dev/null | grep -q "$ready" && break
      else break; fi
    done
    sleep 5
  fi
}

# Press by accessible label, else by visible text, else by the first element whose label contains
# it (a row announcing « title, description »), and settle. Nothing matched is a failed step, not
# the end of vysu — it says so and returns 1, exactly like `web_click`: `mflow` still stops on the
# step that went wrong (with its number), while `mrec` reports it, plays the rest and keeps its clip.
vysu_mtap() {
  local platform="${1:-}" label="${2:-}"; [ -n "$platform" ] && [ -n "$label" ] || die "usage: vysu mtap ios|android \"<label>\""
  ad_press "$platform" press "label=\"$label\"" --settle \
    || ad_press "$platform" press "text=\"$label\"" --settle \
    || ad_press "$platform" find "$label" press --first \
    || { echo "vysu: $platform: nothing labelled « $label » (vysu $platform snapshot -i)" >&2; return 1; }
}
# Every press goes through --json: the answer carries the point that was hit (data.x / data.y), the
# only place a tap's coordinates ever exist, and a recording needs them to draw its ripple. The
# human line stays what it was — agent-device's own « Tapped label="…" (166, 822) ».
ad_press() { # platform <press|find …> — prints the message, leaves the point in $EV_TARGET
  local platform="$1"; shift
  local out; out="$(ad "$platform" "$@" --json 2>/dev/null)" || return 1
  local parsed; parsed="$(printf '%s' "$out" | python3 -c '
import json, sys
try:
    d = json.loads(sys.stdin.read() or "{}")
except ValueError:
    sys.exit(1)
if not d.get("success", True):
    sys.exit(1)
data = d.get("data") or {}
print((data.get("message") or "").splitlines()[0] if data.get("message") else "")
x, y = data.get("x"), data.get("y")
print("%g %g" % (x, y) if isinstance(x, (int, float)) and isinstance(y, (int, float)) else "")
')" || return 1
  EV_TARGET="$(printf '%s\n' "$parsed" | sed -n 2p)"
  printf '%s\n' "$parsed" | sed -n 1p
}

# Text size as the elderly set it: « large » is the biggest non-accessibility step, « xl » the
# extended range (iOS AX XXXL, Android 2.0 — 1.3 is the ceiling before Android 14).
vysu_textsize() {
  local platform="${1:-}" size="${2:-normal}"
  [ "$platform" != android ] || android_select
  case "$platform:$size" in
    ios:normal) sim ui content_size large >/dev/null;;
    ios:large) sim ui content_size extra-extra-extra-large >/dev/null;;
    ios:xl) sim ui content_size accessibility-extra-extra-extra-large >/dev/null;;
    android:normal) adb shell settings put system font_scale 1.0; adb shell wm density reset >/dev/null;;
    android:large) adb shell settings put system font_scale 1.3;;
    android:xl)
      local sdk; sdk="$(adb shell getprop ro.build.version.sdk | tr -d '\r')"
      if [ "${sdk:-0}" -ge 34 ]; then adb shell settings put system font_scale 2.0
      else adb shell settings put system font_scale 1.3; local d; d="$(adb shell wm density | grep -oE '[0-9]+' | head -1)"; adb shell wm density $((d * 12 / 10)) >/dev/null; fi;;
    *) die "usage: vysu textsize ios|android normal|large|xl";;
  esac
  mstate_set "$platform" textsize "$size"
  echo "$platform: text size $size (takes effect on launch: vysu mrelaunch $platform, or vysu mrelaunch $platform --textsize $size in one go)"
}

vysu_appearance() {
  local platform="${1:-}" mode="${2:-light}"
  [ "$platform" != android ] || android_select
  case "$platform:$mode" in
    ios:light|ios:dark) sim ui appearance "$mode" >/dev/null;;
    android:light) adb shell cmd uimode night no >/dev/null;;
    android:dark) adb shell cmd uimode night yes >/dev/null;;
    *) die "usage: vysu appearance ios|android light|dark";;
  esac
  mstate_set "$platform" appearance "$mode"
  echo "$platform: appearance $mode"
}

# A language as the two platforms spell it: « fr » is fr-FR to Android and fr_FR to iOS. A project
# whose languages are not plain two-letter codes gives the full tag in VYSU_LANGS.
android_locale_of() { case "$1" in *-*) printf '%s' "$1";; *) printf '%s-%s' "$1" "$(echo "$1" | tr '[:lower:]' '[:upper:]')";; esac; }
ios_locale_of() { printf '%s' "$(android_locale_of "$1")" | tr '-' '_'; }

# Kill and relaunch the dev-client, then wait for the bundle: a fast refresh after files moved or
# a provider changed leaves ghosts (stale contexts, cold caches) that a screenshot cannot tell from a
# bug — behaviour is judged on a clean launch. Text size and appearance are applied in between,
# since both take effect on launch.
vysu_mrelaunch() {
  local platform="${1:-}"; [ -n "$platform" ] || die "usage: vysu mrelaunch ios|android [--textsize normal|large|xl] [--appearance light|dark] [--lang <l>]"
  shift
  local textsize="" appearance="" lang=""
  while [ $# -gt 0 ]; do
    case "$1" in
      --textsize) textsize="$2"; shift 2;;
      --appearance) appearance="$2"; shift 2;;
      --lang) lang="$2"; shift 2;;
      *) die "vysu mrelaunch: unknown option $1";;
    esac
  done
  lang_check "$lang"
  local bundle; bundle="$(need_cfg MOBILE_BUNDLE "the app id on both platforms")"
  [ "$platform" != android ] || android_select
  listening 8081 || die "vysu mrelaunch: Metro is not running (vysu up $platform)"
  if [ "$platform" = android ]; then adb shell am force-stop "$bundle" >/dev/null 2>&1
  else sim terminate "$bundle" >/dev/null 2>&1 || true; fi
  [ -z "$textsize" ] || vysu_textsize "$platform" "$textsize" >/dev/null
  [ -z "$appearance" ] || vysu_appearance "$platform" "$appearance" >/dev/null
  # The app reads the OS locale at launch (expo-localization). iOS takes it per launch; Android has
  # to be told system-wide, which costs a zygote restart, so it is only done when it differs.
  if [ -n "$lang" ] && [ "$platform" = android ]; then
    local android_locale; android_locale="$(android_locale_of "$lang")"
    if [ "$(adb shell getprop persist.sys.locale 2>/dev/null | tr -d '\r')" != "$android_locale" ]; then
      adb root >/dev/null 2>&1 && adb shell "setprop persist.sys.locale $android_locale; setprop ctl.restart zygote" >/dev/null 2>&1
      sleep 20; wait_android_boot; wait_android_shell
    fi
  fi
  [ -z "$lang" ] || mstate_set "$platform" lang "$lang"
  sleep 1
  # Metro says when it has handed the bundle over (« iOS Bundled … » / « Android Bundled … »):
  # cheaper and surer than reading the tree, which a dev-client shows nothing of until then.
  local log="$LOGS/metro.log" from; from="$(wc -l <"$log" 2>/dev/null | tr -d ' ')"; from="${from:-0}"
  local tag="iOS"; [ "$platform" = android ] && tag="Android"
  if [ "$platform" = android ]; then
    adb reverse tcp:8081 tcp:8081 >/dev/null 2>&1
    adb shell monkey -p "$bundle" -c android.intent.category.LAUNCHER 1 >/dev/null 2>&1
  elif [ -n "$lang" ]; then
    sim launch "$bundle" -AppleLanguages "($lang)" -AppleLocale "$(ios_locale_of "$lang")" >/dev/null
  else sim launch "$bundle" >/dev/null; fi
  local i; for i in $(seq 1 45); do
    sleep 2
    tail -n "+$((from + 1))" "$log" 2>/dev/null | grep -q "$tag Bundled" && { mstate_set "$platform" metro localhost:8081; break; }
    # A fresh install sits on Expo's launcher until it is handed the bundle URL. Retried every 10
    # iterations: after a zygote restart the dev-client comes up late, and a single early attempt
    # finds no launcher on screen to hand the URL to. It is a no-op when the launcher is not there.
    case "$i" in 5|15|25|35) mobile_load_bundle "$platform";; esac
  done
  [ "$i" -lt 45 ] || die "vysu mrelaunch: Metro never served the $tag bundle (see $log)"
  # The bundle is served, the JS boot (providers, first queries, the tab shell) is not over: wait for
  # a screen rather than for a guessed delay. Those labels are the app's first screens, which only
  # the project can name (VYSU_MOBILE_READY_TEXT) — without them, a fixed delay is all there is.
  local ready; ready="$(mobile_ready_grep || true)"
  local j booted=0
  if [ -n "$ready" ]; then
    # shellcheck disable=SC2034  # the counter only bounds the loop
    for j in $(seq 1 15); do
      ad "$platform" snapshot -i 2>/dev/null | grep -q "$ready" && { booted=1; break; }
      sleep 1
    done
  fi
  [ "$booted" = 1 ] || sleep 5
  echo "$platform: relaunched${textsize:+ (text size $textsize)}${appearance:+ ($appearance)}${lang:+ ($lang)}"
}

# One line of a flow / a recording: vysu's own verbs, then anything agent-device accepts.
#   sleep <s> · tap "<label>" · tap t:<i18n.key> · shot <label> [--full] · relaunch [opts] · press … · wait …
mobile_step() {
  local platform="$1" shots="$2" step="$3"
  case "$step" in
    ''|\#*) ;;
    sleep\ *) sleep "${step#sleep }";;
    # By i18n key: the flow survives a wording change, and reads the same in every language.
    tap\ t:*|tap\ \"t:*|tap\ \'t:*)
      local key="${step#tap }"; key="${key#[\"\']}"; key="${key%[\"\']}"; key="${key#t:}"
      EV_LABEL="$(i18n_label "$(mstate_get "$platform" lang "$(cfg LANG)")" "$key")"
      vysu_mtap "$platform" "$EV_LABEL";;
    tap\ *) eval "vysu_mtap \"\$platform\" ${step#tap }";;
    # A bare press / longpress is agent-device's own verb, and its answer holds the point it hit:
    # worth the same --json round-trip as a `tap`, so a recording gets a ripple out of it too.
    press\ *|longpress\ *) eval "ad_press \"\$platform\" $step";;
    shot\ *)
      [ -n "$shots" ] || die "vysu: « $step » needs --shots <name> (or a recording name)"
      local words=(); read -r -a words <<<"${step#shot }"
      local label="${words[0]:-}" mfull=() word
      [ -n "$label" ] || die "vysu: « shot » needs a label"
      for word in ${words[@]+"${words[@]:1}"}; do
        case "$word" in
          --full) mfull=(--full);;
          *) die "vysu: « shot $label » takes --full, not $word";;
        esac
      done
      vysu_mshot "$platform" "$shots" "$label" ${mfull[@]+"${mfull[@]}"};;
    relaunch*) eval "vysu_mrelaunch \"\$platform\" ${step#relaunch}";;
    *) eval "ad \"\$platform\" $step" | tail -1;;
  esac
}

# Metro's log, from the last mark: `vysu mlog mark` before an action, `vysu mlog` after it — the
# app's console.error / warnings of that window only.
vysu_mlog() {
  local log="$LOGS/metro.log" markfile="$STATE/metro.mark"
  [ -f "$log" ] || die "no $log (vysu up ios|android starts Metro)"
  case "${1:-}" in
    mark) wc -l <"$log" | tr -d ' ' >"$markfile"; echo "metro: marked at line $(cat "$markfile")";;
    --tail) tail -n "${2:-40}" "$log";;
    '') local from=0; [ -f "$markfile" ] && from="$(cat "$markfile")"
        # A restarted Metro starts a fresh log: a mark past its end means « since the start ».
        [ "$from" -le "$(wc -l <"$log" | tr -d ' ')" ] || from=0
        local since; since="$(tail -n "+$((from + 1))" "$log" || true)"
        [ -n "$since" ] && printf '%s\n' "$since" || echo "(nothing since the mark)";;
    *) die "usage: vysu mlog [mark | --tail N]";;
  esac
}

# --- what a device was left in, for `vysu claim` and `vysu doctor` -----------------------------

mstate_line() { # state file [device] → « state: … », only the keys that are set
  local f="$1" k v out=""
  for k in textsize appearance lang persona; do
    v="$(mstate_field "$f" "$k")"; [ -z "$v" ] || out="$out · $k $v"
  done
  v="$(mstate_field "$f" metro)"; [ -z "$v" ] || out="$out · metro ${v#localhost}"
  v="$(mstate_field "$f" by)"; [ -z "$v" ] || out="$out · by $v"
  v="$(mstate_field "$f" at)"; [ -z "$v" ] || out="$out at $(date -r "$v" +%H:%M)"
  [ -z "$out" ] && out="(no state recorded)" || out="${out# · }"
  printf 'state%s: %s\n' "${2:+ $2}" "$out"
}
# What the device is showing, without asking for the tree twice: the labels agent-device already
# answers with, deduplicated and cut at six — enough to name the screen, cheap enough to print on
# every claim. Only for a session that is already open: opening one costs a minute of runner build.
mscreen_line() { # platform
  local dev="$ANDROID_AVD"; [ "$1" = android ] || dev="$IOS_DEVICE"
  if ! agent-device session list 2>/dev/null | grep -q "\"$(cfg PROJECT)-$1-$(slug "$dev")\""; then
    echo "screen: (no session — vysu $1 open …)"; return
  fi
  [ "$1" != android ] || [ -n "$(android_serial)" ] || { echo "screen: (emulator not running)"; return; }
  local labels
  labels="$(ad "$1" snapshot -i --json --timeout 20000 2>/dev/null | python3 -c '
import sys, json
try:
    nodes = (json.loads(sys.stdin.read() or "{}").get("data") or {}).get("nodes") or []
except ValueError:
    nodes = []
seen = []
for n in nodes:
    # The root node is the app itself, not something on screen.
    if n.get("type") == "Application":
        continue
    label = (n.get("label") or "").strip()
    if len(label) < 3 or label in seen:
        continue
    seen.append(label)
    if len(seen) == 6:
        break
print(" · ".join(seen))
' 2>/dev/null || true)"
  echo "screen: ${labels:-(nothing readable)}"
}
mreset_args() { # platform → the mrelaunch flags that put it back to the defaults, or nothing
  local p="$1" default_lang; default_lang="$(cfg LANG)"
  [ "$(mstate_get "$p" textsize normal)" = normal ] || printf ' --textsize normal'
  [ "$(mstate_get "$p" appearance light)" = light ] || printf ' --appearance light'
  # A --lang costs a zygote restart on Android: only asked for when it is not already the default.
  [ -z "$default_lang" ] || [ "$(mstate_get "$p" lang "$default_lang")" = "$default_lang" ] || printf ' --lang %s' "$default_lang"
}
