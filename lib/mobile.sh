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
# The text fields on screen, read from a capture rather than from the tree: a login form inside a
# system web surface (SafariViewService on iOS 18, a Chrome Custom Tab) is invisible to the
# platform's accessibility, and a connector that cannot read it has nothing else to aim at. Prints
# py/fields.py's JSON — boxes in points, top to bottom — and answers 1 when it sees none, so a
# connector can say what it expected instead of tapping at a constant.
mob_fields() { # platform
  local platform="$1"; [ -n "$platform" ] || die "mob_fields: ios or android"
  [ -f "$FIELDS" ] || die "fields.py missing ($FIELDS)"
  local png="$STATE/fields-$platform.png"
  mkdir -p "$STATE"
  # Same 1x capture as `vysu mshot`: the boxes then come back in the points a press is given in.
  local args=(); read -r -a args <<<"$(mcapture_args "$platform")"
  ad "$platform" screenshot "$png" "${args[@]}" >/dev/null
  "$FIELDS" "$png" --json
}

# expo or native: everything that is Metro (the bundler, the dev-launcher hand-off, the « Bundled »
# line a relaunch waits for) happens in expo mode only. A native app — Swift, Kotlin, Flutter, .NET —
# is installed, launched and read through accessibility exactly like a dev-client; it just has no
# bundler in front of it, and its log comes from the platform instead of from Metro.
mobile_kind() {
  local kind; kind="$(cfg MOBILE_KIND expo)"
  case "$kind" in expo|native) printf '%s' "$kind";; *) die "VYSU_MOBILE_KIND must be expo or native (got « $kind »)";; esac
}
# The app's own log in native mode, one file per platform, written by the tail `vysu up` starts. In
# expo mode, `js`: the JS console of ONE device (`vysu mlog <platform> --device`), one file per
# device, since Metro's log mixes every device that bundles from it.
mobile_device_slug() { if [ "$1" = android ]; then slug "$ANDROID_AVD"; else slug "$IOS_DEVICE"; fi; }
mobile_applog_file() { # platform [js]
  if [ "${2:-}" = js ]; then printf '%s/%s-js-%s.log' "$LOGS" "$1" "$(mobile_device_slug "$1")"
  else printf '%s/%s-app.log' "$LOGS" "$1"; fi
}
mobile_applog_pid() { # platform [js]
  if [ "${2:-}" = js ]; then printf '%s/jslog-%s-%s.pid' "$STATE" "$1" "$(mobile_device_slug "$1")"
  else printf '%s/applog-%s.pid' "$STATE" "$1"; fi
}
# The pid file holds one pid per line: the tail is a single process on iOS and on a recent Android,
# and an « adb logcat | grep » pair on an older one. The first line is the one whose death means the
# tail is over, and `applog_stop` kills them all.
mobile_applog_alive() { local f; f="$(mobile_applog_pid "$1" "${2:-}")"; [ -s "$f" ] && kill -0 "$(head -1 "$f")" 2>/dev/null; }
# `vysu mlog` with no platform: the one that was last written to, iOS when neither exists yet.
mobile_applog_platform() {
  local newest="" p
  for p in ios android; do
    [ -f "$(mobile_applog_file "$p")" ] || continue
    [ -z "$newest" ] || [ "$(mobile_applog_file "$p")" -nt "$(mobile_applog_file "$newest")" ] || continue
    newest="$p"
  done
  printf '%s' "${newest:-ios}"
}
# The executable inside the .app: what `log stream` matches a process on. A bundle id is not a
# process name, and `processImagePath ENDSWITH "/<exe>"` is the one predicate that holds across a
# relaunch (the pid changes, the path does not) without catching a neighbour of the same prefix.
ios_app_executable() { # bundle
  local path exe
  path="$(xcrun simctl get_app_container "$(ios_udid)" "$1" app 2>/dev/null)" || return 1
  [ -n "$path" ] || return 1
  exe="$(/usr/libexec/PlistBuddy -c 'Print :CFBundleExecutable' "$path/Info.plist" 2>/dev/null || true)"
  [ -n "$exe" ] || exe="$(basename "$path" .app)"
  printf '%s' "$exe"
}
# The uid the package runs under: `logcat --uid` then follows the app through every relaunch, where
# a pid filter would stop at the first force-stop.
android_app_uid() { # package
  adb shell dumpsys package "$1" 2>/dev/null | grep -m1 -oE '(userId|uid)=[0-9]+' | cut -d= -f2 | tr -d '\r'
}
# `logcat --uid` only exists from API 31: on an API 30 image the tail dies on « Unknown option
# '--uid' » and the log holds that one line. There, `-v uid` prints the uid of every line — « (10166:
# 2291) » — and the same filter is applied here, which survives a relaunch exactly as --uid does.
android_logcat_has_uid() { adb -s "$ANDROID_SERIAL" shell logcat --help 2>&1 | grep -q -- '--uid'; }
# The tail `vysu up <platform>` starts in native mode: the app's own log, from now on, into
# logs/<platform>-app.log, which `vysu mlog` then reads exactly as it reads Metro's. With `js` (expo
# mode, started by `vysu mrelaunch` and `vysu mlog <platform> --device|mark`), the JS console of this
# device only: React Native writes it to os_log under com.facebook.react.log / javascript on iOS (a
# console.log at the info level, which `log stream` hides unless asked), and to logcat under the
# ReactNativeJS tag on Android. Both filters outlive a relaunch, as the native ones do.
applog_start() { # platform [js]
  local platform="$1" kind="${2:-}" log pidf
  log="$(mobile_applog_file "$platform" "$kind")"; pidf="$(mobile_applog_pid "$platform" "$kind")"
  mobile_applog_alive "$platform" "$kind" && { echo "$platform: ${kind:+JS }log already tailing ($log)"; return 0; }
  mkdir -p "$LOGS" "$STATE"
  local bundle; bundle="$(cfg MOBILE_BUNDLE)"
  if [ "$kind" = js ] && [ "$platform" = android ]; then
    ( nohup adb -s "$ANDROID_SERIAL" logcat -v time -T 1 -s ReactNativeJS:V >"$log" 2>&1 </dev/null & echo $! >"$pidf" )
    echo "$platform: JS log → $log (vysu mlog $platform --device)"
    return 0
  fi
  if [ "$platform" = ios ]; then
    local exe; exe="$(ios_app_executable "$bundle" || true)"
    [ -n "$exe" ] || { echo "ios: $bundle is not installed, no ${kind:+JS }log (vysu up ios --reinstall)"; return 0; }
    local predicate="processImagePath ENDSWITH \"/$exe\" AND eventType == \"logEvent\" AND messageType != debug" level=()
    [ "$kind" != js ] || { predicate="processImagePath ENDSWITH \"/$exe\" AND subsystem == \"com.facebook.react.log\" AND category == \"javascript\""; level=(--level info); }
    ( nohup xcrun simctl spawn "$(ios_udid)" log stream --style compact ${level[@]+"${level[@]}"} \
        --predicate "$predicate" >"$log" 2>&1 </dev/null & echo $! >"$pidf" )
    [ "$kind" != js ] || { echo "ios: JS log → $log (vysu mlog ios --device)"; return 0; }
  else
    # `|| true`, like the iOS side: no uid is an answer — the app is not there, or the system
    # services are not back yet — and under pipefail the empty grep would end `up` on the spot,
    # before the line below could say which.
    local uid; uid="$(android_app_uid "$bundle" || true)"
    [ -n "$uid" ] || { echo "android: $bundle is not installed — no app log (vysu up android --reinstall)"; return 0; }
    if android_logcat_has_uid; then
      ( nohup adb -s "$ANDROID_SERIAL" logcat -v time -T 1 --uid="$uid" >"$log" 2>&1 </dev/null & echo $! >"$pidf" )
    else
      ( nohup sh -c "adb -s '$ANDROID_SERIAL' logcat -v time -v uid -T 1 2>/dev/null | grep --line-buffered -E '\( *$uid: *[0-9]+\)'" \
          >"$log" 2>/dev/null </dev/null & echo $! >"$pidf" )
      # The shell holds the pipeline, but killing it would leave `adb logcat` writing into a grep
      # nobody reads: its pid is noted too, and stopping it is what ends the other two.
      sleep 1
      pgrep -f "adb -s $ANDROID_SERIAL logcat -v time -v uid" >>"$pidf" 2>/dev/null || true
    fi
  fi
  echo "$platform: app log → $log (vysu mlog)"
}
applog_stop() { # platform…: what `vysu down applog` calls, the app tails and every device's JS tail
  local platform pidf pid what stopped=0
  for platform in "$@"; do
    for pidf in "$(mobile_applog_pid "$platform")" "$STATE/jslog-$platform-"*.pid; do
      [ -s "$pidf" ] || continue
      while read -r pid; do [ -z "$pid" ] || kill "$pid" 2>/dev/null || true; done <"$pidf"
      rm -f "$pidf"
      case "$pidf" in */jslog-*) what="JS log of $(basename "$pidf" .pid | sed "s/^jslog-$platform-//")";; *) what="app log";; esac
      echo "$platform: $what stopped"; stopped=1
    done
  done
  [ "$stopped" = 1 ] || echo "applog: nothing was tailing"
}

# Is the app on the device? `simctl listapps | grep -q` cannot answer it: grep leaves on its first
# match, listapps dies of SIGPIPE and pipefail reads that as « no ». `get_app_container` answers for
# a system app too, and the Android side matches on a captured string for the same reason.
# Is there an agent-device session on that device? Reading the tree needs one (`vysu <platform>
# open …`), and without it every snapshot is an immediate error: a wait that polls it would only
# burn its fifteen tries.
mobile_session_open() { # platform
  local sessions; sessions="$(agent-device session list 2>/dev/null || true)"
  case "$sessions" in *"\"$(mobile_session_name "$1")\""*) return 0;; esac
  return 1
}
mobile_installed() { # platform bundle
  if [ "$1" = ios ]; then
    xcrun simctl get_app_container "$(ios_udid)" "$2" app >/dev/null 2>&1
  else
    local pkgs; pkgs="$(adb shell pm list packages "$2" 2>/dev/null | tr -d '\r')"
    case "$pkgs" in *"package:$2"*) return 0;; esac
    return 1
  fi
}
mobile_session_name() { printf '%s-%s-%s' "$(cfg PROJECT)" "$1" "$(mobile_device_slug "$1")"; }
# The session a snapshot needs, reopened quietly when it is gone (a daemon restart, a `close`): agents
# used to re-run `open --foreground` by hand after every relaunch. `open` without --relaunch only
# brings the running app forward; the first one on a new runtime builds agent-device's runner.
mobile_session_ensure() { # platform
  mobile_session_open "$1" && return 0
  ad "$1" open "$(mobile_app "$1")" --timeout "$(mobile_open_timeout "$1")" >/dev/null 2>&1
}
# Every agent-device call a wait makes is bounded, or a thrashing emulator turns a 60 s budget into
# eight minutes (seen: a relaunch that took 486 s). An iOS open may have to build the XCTest runner
# first, which is minutes on a loaded Mac; an Android open has nothing to build.
mobile_open_timeout() { [ "$1" = ios ] && printf 180000 || printf 60000; }
MOBILE_SNAPSHOT_TIMEOUT=15000
# A session bound to another device. An emulator restarted while another one held its port comes back
# on a new serial, and the session named after it still points at the old one: every command then
# fails with « already bound to … ». `agent-device close` with no app ends the session and closes no
# app (it only closes an app it is named), so dropping it and reopening is safe. When the serial is
# held by a session named after ANOTHER AVD of this project, that one is the same leftover seen from
# the other side (vysu binds a session to the serial of the AVD it is named after, and to nothing
# else), and it is dropped too.
mobile_session_repair() { # platform "<the error agent-device answered>"
  local platform="$1" name out other
  name="$(mobile_session_name "$platform")"
  case "$2" in *"is already bound to"*) agent-device close --session "$name" >/dev/null 2>&1 || true;; esac
  out="$(ad "$platform" open "$(mobile_app "$platform")" --timeout "$(mobile_open_timeout "$platform")" 2>&1 >/dev/null)" && return 0
  [ "$platform" = android ] || return 1
  other="$(printf '%s\n' "$out" | sed -n 's/.*in use by session "\([^"]*\)".*/\1/p' | head -1)"
  case "$other" in "$(cfg PROJECT)-android-"*) [ "$other" != "$name" ] || return 1;; *) return 1;; esac
  agent-device close --session "$other" >/dev/null 2>&1 || true
  log "android: dropped the session $other, left over on $ANDROID_SERIAL from an emulator restart"
  ad "$platform" open "$(mobile_app "$platform")" --timeout "$(mobile_open_timeout "$platform")" >/dev/null 2>&1
}
# Does this text hold a line matching this ERE? `grep -c` reads everything it is given, where a
# `printf | grep -q` leaves early and the SIGPIPE it leaves behind reads as « no » under pipefail.
text_has() { [ "$(printf '%s\n' "$1" | grep -cE "$2" || true)" != 0 ]; }

# Expo's dev menu opens on top of the app at launch until its first-run intro has been seen once, on
# every fresh install and on every simulator that never had it dismissed: 27 times in one audit.
# Its two preferences are set before the launch instead (expo-dev-menu 56: `EXDevMenuIsOnboardingFinished`
# / `EXDevMenuShowsAtLaunch` in the app's standard user defaults on iOS; `isOnboardingFinished` /
# `showsAtLaunch` in shared_prefs/expo.modules.devmenu.sharedpreferences.xml on Android). Written with
# the app stopped, since the app keeps its own copy while it runs. iOS goes through the simulator's
# own `defaults` on the container's plist path: its cfprefsd is the one the app reads from, where a
# plain write to the file could be overwritten by that daemon's cache. Android needs a debuggable build
# for `run-as`, which a dev-client is; a release build answers « not debuggable » and is left alone.
mobile_quiet_dev_menu() { # platform bundle
  local platform="$1" bundle="$2"
  if [ "$platform" = ios ]; then
    local data plist; data="$(xcrun simctl get_app_container "$(ios_udid)" "$bundle" data 2>/dev/null)" || return 0
    plist="$data/Library/Preferences/$bundle"
    [ "$(plutil -extract EXDevMenuIsOnboardingFinished raw "$plist.plist" 2>/dev/null)" != true ] \
      || [ "$(plutil -extract EXDevMenuShowsAtLaunch raw "$plist.plist" 2>/dev/null)" != false ] || return 0
    sim spawn defaults write "$plist" EXDevMenuIsOnboardingFinished -bool YES >/dev/null 2>&1 || true
    sim spawn defaults write "$plist" EXDevMenuShowsAtLaunch -bool NO >/dev/null 2>&1 || true
    return 0
  fi
  local prefs=shared_prefs/expo.modules.devmenu.sharedpreferences.xml cur
  cur="$(adb shell run-as "$bundle" cat "$prefs" 2>/dev/null | tr -d '\r' || true)"
  case "$cur" in *"run-as:"*) return 0;; esac   # not debuggable, or not installed
  case "$cur" in *'name="isOnboardingFinished" value="true"'*) case "$cur" in *'name="showsAtLaunch" value="false"'*) return 0;; esac;; esac
  case "$cur" in *"<map"*) ;; *) cur="<?xml version='1.0' encoding='utf-8' standalone='yes' ?>
<map>
</map>";; esac
  local tmp; tmp="$STATE/.devmenu-$$.xml"; mkdir -p "$STATE"
  printf '%s\n' "$cur" | grep -vE 'name="(isOnboardingFinished|showsAtLaunch)"' \
    | sed 's#</map>#    <boolean name="isOnboardingFinished" value="true" />\
    <boolean name="showsAtLaunch" value="false" />\
</map>#' >"$tmp"
  adb shell "run-as $bundle sh -c 'mkdir -p shared_prefs && cat > $prefs'" <"$tmp" >/dev/null 2>&1 || true
  rm -f "$tmp"
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
# Expo's launcher (« Development Build » and its server list) or its error page (« There was a problem
# loading the project »: the load timed out on a busy Mac, or Metro was down): either way the app
# never got its bundle, and handing it the URL again is the fix for both.
MOBILE_LAUNCHER_GREP='"Development Build"|There was a problem loading the project'
mobile_on_launcher() { # platform [snapshot text already read]
  if [ "$1" = android ]; then
    local focus; focus="$(adb shell dumpsys window 2>/dev/null | grep mCurrentFocus || true)"
    case "$focus" in *DevLauncher*) return 0;; esac
    return 1
  fi
  local snap="${2:-}"
  [ -n "$snap" ] || snap="$(ad ios snapshot -i --timeout "$MOBILE_SNAPSHOT_TIMEOUT" 2>/dev/null || true)"
  text_has "$snap" "$MOBILE_LAUNCHER_GREP"
}
# The dev-client, started straight into this owner's Metro: the launcher never shows, so nothing has
# to be handed to it afterwards. iOS reads `--initialUrl <url>` from its launch arguments
# (expo-dev-launcher's initialUrlFromProcessInfo), which also spares the « Open in … ? » confirmation
# iOS 18 puts in front of a custom-scheme URL sent by simctl. Android takes the dev-client deep link as
# a VIEW intent, the one way in: its launcher never reloads the last app by itself (a plain launch sat
# on it for the ten seconds the old relaunch waited before handing the URL over).
MOBILE_HANDED_AT=0
mobile_hand_bundle() { # platform [lang]
  local platform="$1" lang="${2:-}" bundle port url
  MOBILE_HANDED_AT="$(date +%s)"
  bundle="$(cfg MOBILE_BUNDLE)"; port="$(metro_port)"; url="$(metro_url "$port")"
  if [ "$platform" = android ]; then
    adb reverse "tcp:$port" "tcp:$port" >/dev/null 2>&1 || true
    adb shell am start -a android.intent.action.VIEW \
      -d "$(cfg MOBILE_SCHEME)://expo-development-client/?url=$(printf '%s' "$url" | sed 's/:/%3A/g; s#/#%2F#g')" \
      "$bundle" >/dev/null 2>&1
  else
    sim terminate "$bundle" >/dev/null 2>&1 || true
    if [ -n "$lang" ]; then
      sim launch "$bundle" --initialUrl "$url" -AppleLanguages "($lang)" -AppleLocale "$(ios_locale_of "$lang")" >/dev/null
    else
      sim launch "$bundle" --initialUrl "$url" >/dev/null
    fi
  fi
  mobile_record_metro "$platform" "$port"
}
# Which Metro this dev-client is bound to: an agent taking the device over needs it to know whether
# the bundle on screen is the one its own branch serves, and whose isolated Metro that is.
mobile_record_metro() { # platform port
  local iso=""; ! metro_is_isolated || iso="$(vysu_owner)"
  mstate_set "$1" metro "localhost:$2"
  [ "$(mstate_get "$1" metro_isolated)" = "$iso" ] || mstate_set "$1" metro_isolated "$iso"
}
# A dev-client sitting on Expo's launcher (a fresh install, a load that timed out) is handed this
# owner's Metro URL, then waited for: the bundle served, the first screen up. A no-op anywhere else.
# The primitive a connector calls right after its own `open`.
mobile_load_bundle() { # platform
  [ -n "$(cfg MOBILE_SCHEME)" ] || return 0
  mobile_on_launcher "$1" || return 0
  local log from; log="$(metro_log)"; from="$(metro_lines "$log")"
  mobile_hand_bundle "$1"
  mobile_wait_bundled "$1" "$log" "$from" 120 "vysu: $1"
  mobile_wait_ready "$1" 40 || true
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
# A bare language becomes a locale: the region is the language's own where the two share a code
# (fr-FR, de-DE), and the usual one where they do not (en-US, not en-EN).
android_locale_of() {
  case "$1" in
    *-*) printf '%s' "$1";;
    en) printf 'en-US';; ja) printf 'ja-JP';; zh) printf 'zh-CN';; ko) printf 'ko-KR';;
    sv) printf 'sv-SE';; da) printf 'da-DK';; cs) printf 'cs-CZ';; el) printf 'el-GR';; uk) printf 'uk-UA';;
    *) printf '%s-%s' "$1" "$(echo "$1" | tr '[:lower:]' '[:upper:]')";;
  esac
}
ios_locale_of() { printf '%s' "$(android_locale_of "$1")" | tr '-' '_'; }

# Start the app. In expo mode with a dev-client scheme, straight into this owner's Metro
# (mobile_hand_bundle). Otherwise Android goes through the launcher intent (`am start` needs the
# activity name, which only the app knows); iOS takes the language per launch, which is why `--lang`
# is its own pair of arguments here and a system setting on the other platform.
mobile_launch() { # platform bundle [lang]
  if [ "$(mobile_kind)" = expo ] && [ -n "$(cfg MOBILE_SCHEME)" ]; then
    mobile_hand_bundle "$1" "${3:-}"; return
  fi
  if [ "$1" = android ]; then
    # Metro is reachable as localhost from the emulator: an expo concern, and adbd restarts drop it.
    if [ "$(mobile_kind)" = expo ]; then local port; port="$(metro_port)"; adb reverse "tcp:$port" "tcp:$port" >/dev/null 2>&1 || true; fi
    adb shell monkey -p "$2" -c android.intent.category.LAUNCHER 1 >/dev/null 2>&1
  elif [ -n "${3:-}" ]; then
    sim launch "$2" -AppleLanguages "($3)" -AppleLocale "$(ios_locale_of "$3")" >/dev/null
  else
    sim launch "$2" >/dev/null
  fi
}

# Metro says when it has handed the bundle over (« iOS Bundled … » / « Android Bundled … »): cheaper
# and surer than reading the tree, which a dev-client shows nothing of until then. A « Bundling
# failed » for the same platform ends the wait at once, with the error: an edit that broke the build
# (maybe another session's, on the same checkout) otherwise reads as a two-minute timeout. A launcher
# or its error page is handed the URL again from the first look, not after a guessed delay.
mobile_wait_bundled() { # platform log from seconds "<who, for the error>"
  local platform="$1" log="$2" from="$3" budget="$4" who="$5" tag last t0 looked=0 handed=0 err
  tag="$(metro_tag "$platform")"; t0="$(date +%s)"
  while :; do
    last="$(tail -n "+$((from + 1))" "$log" 2>/dev/null | grep -E "(^|[^A-Za-z])$tag (Bundled|Bundling failed) [0-9]" | tail -1 || true)"
    case "$last" in
      *"$tag Bundled "*) MOBILE_BUNDLED_AT="$(date +%s)"; mobile_record_metro "$platform" "$(metro_port)"; return 0;;
      *"$tag Bundling failed "*)
        err="$(metro_bundle_error_since "$from" "$log" || true)"
        die "$who: Metro could not bundle for $tag: ${err:-see $log}" \
          "fix it (the edit may be another session's on the same checkout), then vysu mrelaunch $platform";;
    esac
    [ $(( $(date +%s) - t0 )) -lt "$budget" ] || die "$who: Metro never served the $tag bundle in ${budget}s (see $log)"
    # Every few seconds, not on every turn: a look costs a snapshot on iOS. And not in the first 20 s
    # after a hand-off: the Android launcher holds the focus for as long as it fetches the manifest,
    # and on a loaded Mac that is many seconds of a load going well, which a new hand-off would
    # restart. Twice at most, then the budget decides.
    if [ -n "$(cfg MOBILE_SCHEME)" ] && [ "$handed" -lt 2 ] && [ $(( $(date +%s) - MOBILE_HANDED_AT )) -ge 20 ] \
      && [ $(( $(date +%s) - looked )) -ge 5 ]; then
      looked="$(date +%s)"
      if [ "$platform" = android ] || mobile_session_open ios; then
        mobile_on_launcher "$platform" && { mobile_hand_bundle "$platform" "${MOBILE_LAUNCH_LANG:-}"; handed=$((handed + 1)); }
      fi
    fi
    sleep 0.5
  done
}

# The screens that prove the app has booted come from the project (VYSU_MOBILE_READY_TEXT). On the way
# there, what stands between a launch and the app is cleared from the first look: Expo's dev menu and
# its first-run intro, pressed away by VYSU_MOBILE_DISMISS_LABELS only while the menu's own texts are
# on screen (an app button that happens to say « Close » is never pressed), and the launcher, handed
# the URL again. The session the snapshots need is reopened when it is gone or bound elsewhere.
# Answers 1 when the ready text never showed within the budget.
MOBILE_DEVMENU_GREP='Runtime version|This is the developer menu'
MOBILE_NOT_READY=""   # why mobile_wait_ready answered 1, for the caller's one line
MOBILE_BUNDLED_AT=0   # when the last « Bundled » line was seen, for the time split the caller prints
# React Native's red box: a JS error the app cannot render past. Nothing will get ready behind it,
# and its first line is what the agent needs to read.
# Its two buttons, together: « DISMISS (ESC) » and « RELOAD (R, R) » (the label may break a line).
mobile_redbox() { text_has "$1" '\[button\] "(DISMISS|Dismiss)' && text_has "$1" '\[button\] "(RELOAD|Reload)'; }
mobile_redbox_message() { # snapshot text → the error, cut at 160 characters
  printf '%s\n' "$1" | grep -E '\[[a-z-]+\] "[^"]{25,}' | grep -vE '"(DISMISS|Dismiss|RELOAD|Reload)' \
    | head -1 | sed 's/^[^"]*"//; s/"$//' | cut -c1-160 || true
}
mobile_wait_ready() { # platform seconds
  local platform="$1" budget="$2" ready snap t0 dismissed=0 handed=0 repaired=0
  MOBILE_NOT_READY="ready text not seen (vysu $platform snapshot -i)"
  ready="$(mobile_ready_grep || true)"
  # Without them, a fixed delay is all there is.
  [ -n "$ready" ] || { sleep 5; return 0; }
  mobile_session_ensure "$platform" || { MOBILE_NOT_READY="screen not checked, no agent-device session (vysu $platform open …)"; return 1; }
  t0="$(date +%s)"
  while [ $(( $(date +%s) - t0 )) -lt "$budget" ]; do
    # The whole tree, not -i: the dev menu's texts are no controls, and Android's -i leaves them out.
    # --force-full: a repeated unchanged Android snapshot otherwise answers with a bare « unchanged ».
    snap="$(ad "$platform" snapshot --force-full --timeout "$MOBILE_SNAPSHOT_TIMEOUT" 2>&1 || true)"
    case "$snap" in
      *SESSION_NOT_FOUND*|*"is already bound to"*|*DEVICE_IN_USE*)
        [ "$repaired" = 0 ] || return 1
        repaired=1; mobile_session_repair "$platform" "$snap" || return 1
        continue;;
    esac
    if [ "$dismissed" -lt 3 ] && text_has "$snap" "$MOBILE_DEVMENU_GREP"; then
      dismissed=$((dismissed + 1))
      # The intro has a button; the Android menu behind it is a bottom sheet with none, which the
      # back key closes (on iOS the menu has its close button, one of the labels).
      mob_press_any "$platform" "$(cfg MOBILE_DISMISS_LABELS 'Continue,Close')" \
        || { [ "$platform" != android ] || ad android back >/dev/null 2>&1 || true; }
      continue
    fi
    if mobile_redbox "$snap"; then
      MOBILE_NOT_READY="red box: $(mobile_redbox_message "$snap")"
      return 2
    fi
    text_has "$snap" "$ready" && return 0
    # A process that died on the way (a native crash under memory pressure was seen) leaves the home
    # screen up, and the budget would be spent waiting for an app that is not there. One `pidof`.
    if [ "$platform" = android ] && [ -z "$(adb shell pidof "$(cfg MOBILE_BUNDLE)" 2>/dev/null | tr -d '\r')" ]; then
      MOBILE_NOT_READY="the app is not running, it crashed or was closed (adb logcat -b crash)"
      return 1
    fi
    if [ "$handed" -lt 2 ] && [ -n "$(cfg MOBILE_SCHEME)" ] && [ $(( $(date +%s) - MOBILE_HANDED_AT )) -ge 20 ] \
      && mobile_on_launcher "$platform" "$snap"; then
      handed=$((handed + 1))
      local log from; log="$(metro_log)"; from="$(metro_lines "$log")"
      mobile_hand_bundle "$platform" "${MOBILE_LAUNCH_LANG:-}"
      mobile_wait_bundled "$platform" "$log" "$from" 90 "vysu: $platform"
      continue
    fi
    sleep 1
  done
  return 1
}

# Kill and relaunch the app, then wait for the bundle: a fast refresh after files moved or
# a provider changed leaves ghosts (stale contexts, cold caches) that a screenshot cannot tell from a
# bug: behaviour is judged on a clean launch. Text size and appearance are applied in between,
# since both take effect on launch. No fixed sleep on the way: every wait is a condition with a bound.
MOBILE_LAUNCH_LANG=""
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
  local kind; kind="$(mobile_kind)"
  local start; start="$(date +%s)"
  [ "$platform" != android ] || android_select
  [ "$platform" != ios ] || ios_lock
  [ "$kind" != expo ] || metro_need "vysu mrelaunch" "$platform"
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
      # `adb root` restarts adbd, which takes the native app-log tail down with it: without this the
      # log freezes at the last line before the language change and `vysu mlog` answers « nothing
      # since the mark » for the rest of the session. A no-op when the tail is still alive.
      [ "$kind" != native ] || applog_start "$platform" >/dev/null
    fi
  fi
  [ -z "$lang" ] || mstate_set "$platform" lang "$lang"
  MOBILE_LAUNCH_LANG="$lang"
  if [ "$kind" = expo ]; then
    mobile_quiet_dev_menu "$platform" "$bundle"
    local log from; log="$(metro_log)"; from="$(metro_lines "$log")"
    mobile_launch "$platform" "$bundle" "$lang"
    mobile_wait_bundled "$platform" "$log" "$from" 180 "vysu mrelaunch"
    # This device's own JS console, for `vysu mlog <platform> --device`: started once, it follows
    # the app through every later relaunch.
    applog_start "$platform" js >/dev/null 2>&1 || true
  else
    # Native: nothing sits between the launch and the first frame, so there is nothing to wait for
    # but the app itself: VYSU_MOBILE_READY_TEXT below, or the fixed delay when it names nothing.
    mobile_launch "$platform" "$bundle" "$lang"
  fi
  local note="" split=""
  mobile_wait_ready "$platform" 60 || note=", $MOBILE_NOT_READY"
  [ "$MOBILE_BUNDLED_AT" = 0 ] || split=" (bundled after $(( MOBILE_BUNDLED_AT - start ))s)"
  echo "$platform: relaunched in $(( $(date +%s) - start ))s$split${textsize:+ (text size $textsize)}${appearance:+ ($appearance)}${lang:+ ($lang)}$note"
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

# The app's log, from the last mark: `vysu mlog mark` before an action, `vysu mlog` after it: the
# console.error / warnings of that window only. In expo mode that log is Metro's (the port this owner
# talks to), which mixes every device bundling from it; `--device` reads this device's own JS console
# instead (mobile_applog_file … js). In native mode it is the platform tail `vysu up` started
# (logs/<platform>-app.log), and `vysu mlog ios|android` says which one when both are running.
# Marks are per owner: two sessions marking the same Metro log no longer move each other's window.
mlog_mark_file() { printf '%s/marks/%s/%s' "$STATE" "$(slug "$(vysu_owner)")" "$(basename "$1")"; }
mlog_mark() { # log → « <name> at line N »
  local f; f="$(mlog_mark_file "$1")"; mkdir -p "$(dirname "$f")"
  wc -l <"$1" | tr -d ' ' >"$f"
  printf '%s at line %s' "$(basename "$1" .log)" "$(cat "$f")"
}
mlog_since() { # log → the first line after this owner's mark (a mark past the end: a restarted tail)
  local f from=0; f="$(mlog_mark_file "$1")"
  [ -s "$f" ] && from="$(cat "$f")"
  [ "$from" -le "$(wc -l <"$1" | tr -d ' ')" ] || from=0
  printf '%s' "$from"
}
# What an agent reads: ANSI colours out, VYSU_MLOG_IGNORE's lines dropped and counted (one ERE, its
# alternatives `|`-separated), and with --errors only the error and warning lines plus the first line
# of each stack, each cut at 200 characters, a line seen N times printed once with « ×N ».
mlog_filter() { # errors(0|1): stdin → stdout
  local ign; ign="$(cfg MLOG_IGNORE)"
  local text ignored=0
  text="$(sed $'s/\033\\[[0-9;]*m//g')"
  if [ -n "$ign" ]; then
    ignored="$(printf '%s\n' "$text" | grep -cE "$ign" || true)"
    text="$(printf '%s\n' "$text" | grep -vE "$ign" || true)"
  fi
  if [ "$1" = 1 ]; then
    text="$(printf '%s\n' "$text" | LC_ALL=C awk '
      function keep(l,   o) {
        o = l; l = substr(l, 1, 200)
        # A cut inside a multi-byte character would leave invalid UTF-8 behind.
        if (length(o) > 200) sub(/[\200-\377]+$/, "", l)
        if (!(l in count)) order[++n] = l
        count[l]++
      }
      /^[ \t]+at / { if (stack) { keep($0); stack = 0 }; next }
      /^ *(ERROR|WARN|error|warn)[ :]/ || /Bundling failed/ || /^Error[ :[]/ || /[A-Za-z]*(Error|Exception):/ ||
      /Unable to resolve/ || / [EWF]\/[^ ]/ || /^[0-9-]+ [0-9:.]+ +(E|F|W) / || /(Warning|WARNING):/ {
        keep($0); stack = 1; next
      }
      /^ *(LOG|INFO|DEBUG) / || / Bundled [0-9]/ { stack = 0 }
      END { for (i = 1; i <= n; i++) print order[i] (count[order[i]] > 1 ? " \303\227" count[order[i]] : "") }
    ')"
  fi
  [ -z "$text" ] || printf '%s\n' "$text"
  [ "$ignored" = 0 ] || echo "($ignored lines ignored by VYSU_MLOG_IGNORE)"
}
vysu_mlog() {
  local platform="" device=0 errors=0 action="" n=40
  while [ $# -gt 0 ]; do
    case "$1" in
      ios|android) platform="$1"; shift;;
      --device) device=1; shift;;
      --errors) errors=1; shift;;
      mark) action="mark"; shift;;
      --tail) action="tail"; shift; case "${1:-}" in ''|*[!0-9]*) ;; *) n="$1"; shift;; esac;;
      *) die "usage: vysu mlog [ios|android] [--device] [--errors] [mark | --tail N]";;
    esac
  done
  local kind; kind="$(mobile_kind)"
  local log name metro=""
  if [ "$kind" = expo ]; then
    metro="$(metro_log)"
    if [ "$device" = 1 ] || { [ "$action" = mark ] && [ -n "$platform" ]; }; then
      platform="${platform:-ios}"
      [ "$platform" != android ] || android_select
      # This device's JS console: started on first use, and said so, since what came before it
      # is not in it.
      if ! mobile_applog_alive "$platform" js; then
        applog_start "$platform" js >/dev/null
        [ "$action" = mark ] || echo "$platform: JS log started now, nothing before this line (vysu mlog $platform --device after the action)"
      fi
    fi
    if [ "$device" = 1 ]; then log="$(mobile_applog_file "$platform" js)"; name="$platform JS"
    else log="$metro"; name="metro :$(metro_port)"; fi
  else
    # A native app's log is already its own device's: --device changes nothing here.
    device=0
    platform="${platform:-$(mobile_applog_platform)}"
    log="$(mobile_applog_file "$platform")"; name="$platform"
    # A dead tail and a quiet app read the same on screen (an empty answer) and the difference
    # matters: a tail dies with the adbd it was attached to (`adb root`, an emulator restart), and
    # every line after that is simply not in the file.
    mobile_applog_alive "$platform" \
      || echo "vysu: $platform: the app log is no longer tailing, it stops at $(date -r "$log" +%H:%M) (vysu up $platform)" >&2
  fi
  [ "$device" = 0 ] || mobile_applog_alive "$platform" js \
    || echo "vysu: $platform: the JS log is no longer tailing (vysu mlog $platform --device restarts it)" >&2
  [ -f "$log" ] || die "no $log (vysu up ${platform:-ios|android} starts it)"
  case "$action" in
    # Every log this owner may read next: Metro's, each device's JS console, each native app tail.
    mark)
      local f out=""
      for f in "$metro" "$LOGS"/*-js-*.log "$LOGS"/ios-app.log "$LOGS"/android-app.log; do
        [ -n "$f" ] && [ -f "$f" ] || continue
        out="$out · $(mlog_mark "$f")"
      done
      echo "marked: ${out# · }";;
    tail) tail -n "$((n * 20))" "$log" | mlog_filter "$errors" | tail -n "$n";;
    '')
      # A broken bundle first: the screen may be stale because an edit (maybe another session's,
      # on the same checkout) no longer compiles, and nothing else in the log says it that plainly.
      if [ -n "$metro" ] && [ -f "$metro" ]; then
        local err; err="$(metro_bundle_error_since "$(mlog_since "$metro")" "$metro" || true)"
        [ -z "$err" ] || echo "metro: bundle failed since the mark: $err"
      fi
      local since; since="$(tail -n "+$(( $(mlog_since "$log") + 1 ))" "$log" | mlog_filter "$errors")"
      if [ -n "$since" ]; then printf '%s\n' "$since"
      elif [ "$errors" = 1 ]; then echo "($name: no error or warning since the mark)"
      else echo "($name: nothing since the mark)"; fi;;
  esac
}

# --- what a device was left in, for `vysu claim` and `vysu doctor` -----------------------------

mstate_line() { # state file [device] → « state: … », only the keys that are set
  local f="$1" k v out=""
  for k in textsize appearance lang persona; do
    v="$(mstate_field "$f" "$k")"; [ -z "$v" ] || out="$out · $k $v"
  done
  # Metro is an expo notion: a native app has no bundler behind the screen to name. Whose isolated
  # Metro it is, when it is one, and whether it still answers: a device bound to a stopped Metro
  # shows the last screen it had, which is not the branch it claims to show.
  if [ "$(mobile_kind)" = expo ]; then
    v="$(mstate_field "$f" metro)"
    if [ -n "$v" ]; then
      local iso; iso="$(mstate_field "$f" metro_isolated)"
      out="$out · metro ${v#localhost}${iso:+ (isolated, $iso)}"
      listening "${v##*:}" || out="$out (not running)"
    fi
  fi
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
  mobile_session_open "$1" || { echo "screen: (no session — vysu $1 open …)"; return; }
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
