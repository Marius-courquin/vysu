# services.sh — `up` and `down` know no stack: a service is a CMD, a DIR, a PORT, a HEALTH check and
# a STOP, declared in the project's config. The two mobile targets stay here because they are Expo
# and simulator mechanics, not app logic: Metro, the emulator, the dev-client build and its install.
# shellcheck shell=bash

service_key() { cfg "SERVICE_${1}_${2}" "${3:-}"; }
service_known() { # name → is it declared
  local s
  for s in $(cfg SERVICES); do [ "$s" != "$1" ] || return 0; done
  return 1
}
# A health check is a url when it holds « :// », the literal `port` when a TCP listen is all there
# is to wait for, and a command otherwise.
service_wait() { # name timeout
  local health port i
  health="$(service_key "$1" HEALTH)"
  port="$(service_key "$1" PORT)"
  [ -n "$health" ] || { [ -n "$port" ] && health=port || return 0; }
  case "$health" in
    *://*) wait_http "$health" "$2" "$1";;
    port)
      [ -n "$port" ] || die "vysu up $1: HEALTH is « port » but VYSU_SERVICE_${1}_PORT is not set"
      for i in $(seq 1 "$2"); do listening "$port" && return 0; sleep 1; done
      die "$1: nothing listening on $port after ${2}s";;
    *)
      # shellcheck disable=SC2034  # the counter only bounds the loop
      for i in $(seq 1 "$2"); do eval "$health" >/dev/null 2>&1 && return 0; sleep 1; done
      die "$1: « $health » never succeeded in ${2}s";;
  esac
}
# What a report calls the API the app talks to, when `up` is the one that decided it: an --env value
# that is a url is mapped through VYSU_API_HOSTS exactly as a request from the network log would be.
service_record_api() { # the k=v pairs the service was started with
  local pair value host label found=0
  for pair in "$@"; do
    value="${pair#*=}"
    case "$value" in *://*) ;; *) continue;; esac
    host="$(printf '%s' "$value" | sed -E 's#^https?://##; s#/.*$##')"
    label="$host"
    for value in $(cfg API_HOSTS); do
      [ "${value%%=*}" = "$host" ] || continue
      label="${value#*=}"; break
    done
    mkdir -p "$STATE"; printf '%s' "$label" >"$STATE/web.api"; found=1
  done
  [ "$found" = 1 ] || rm -f "$STATE/web.api"
}

vysu_up() {
  local what="${1:-}"; [ -n "$what" ] || die "usage: vysu up <service> | all | ios | android"
  shift || true
  mkdir -p "$LOGS"
  case "$what" in
    all)
      need_project
      local s
      for s in $(cfg SERVICES); do vysu_up "$s"; done
      return;;
    ios|android) mobile_up "$what" "$@"; return;;
  esac
  need_project
  service_known "$what" || die "vysu up: unknown service '$what' (VYSU_SERVICES = $(cfg SERVICES))"
  local env_pairs=()
  while [ $# -gt 0 ]; do
    case "$1" in
      --env) env_pairs+=("$2"); shift 2;;
      *) die "vysu up $what: unknown option $1";;
    esac
  done
  local cmd dir port timeout declared
  cmd="$(service_key "$what" CMD)"; [ -n "$cmd" ] || die "vysu up $what: VYSU_SERVICE_${what}_CMD is not set"
  dir="$(project_path "$(service_key "$what" DIR)")"; dir="${dir:-${VYSU_PROJECT_DIR:-$PWD}}"
  port="$(service_key "$what" PORT)"
  timeout="$(service_key "$what" TIMEOUT 30)"
  declared="$(service_key "$what" ENV)"
  # Already up is not a failure: the point of `up` is that the service is there afterwards.
  if [ -n "$port" ] && listening "$port"; then
    echo "$what: already listening on $port (vysu down $what to restart it)"
    return
  fi
  # The config's own ENV first, the command line's after, so `--env` overrides a declared default.
  local all_env=() pair
  for pair in $declared; do all_env+=("$pair"); done
  for pair in ${env_pairs[@]+"${env_pairs[@]}"}; do all_env+=("$pair"); done
  # `nohup … &` inside its own subshell: the service outlives this vysu, and its log is the one
  # place its output goes.
  ( cd "$dir" && env ${all_env[@]+"${all_env[@]}"} nohup sh -c "$cmd" >"$LOGS/$what.log" 2>&1 </dev/null & )
  service_record_api ${all_env[@]+"${all_env[@]}"}
  service_wait "$what" "$timeout"
  local where="$what"; [ -z "$port" ] || where="http://localhost:$port"
  echo "$what: $where${all_env[*]+ — ${all_env[*]}} (log: $LOGS/$what.log)"
}

vysu_down() {
  local what="${1:-}"; [ -n "$what" ] || die "usage: vysu down <service> | all | metro"
  case "$what" in
    all)
      need_project
      local s
      # In reverse: a dependency is stopped after what depends on it.
      for s in $(cfg SERVICES | tr ' ' '\n' | sed -n '1!G;h;$p'); do vysu_down "$s"; done
      return;;
    metro) kill_port 8081; echo "metro: stopped"; return;;
  esac
  need_project
  service_known "$what" || die "vysu down: unknown service '$what' (VYSU_SERVICES = $(cfg SERVICES))"
  local stop port dir
  stop="$(service_key "$what" STOP)"
  port="$(service_key "$what" PORT)"
  dir="$(project_path "$(service_key "$what" DIR)")"; dir="${dir:-${VYSU_PROJECT_DIR:-$PWD}}"
  if [ -n "$stop" ]; then
    ( cd "$dir" && eval "$stop" >/dev/null 2>&1 ) || true
  elif [ -n "$port" ]; then
    kill_port "$port"
  else
    die "vysu down $what: neither VYSU_SERVICE_${what}_STOP nor _PORT is set"
  fi
  echo "$what: stopped"
}

# --- the two mobile targets --------------------------------------------------------------------

mobile_up() {
  local what="$1"; shift
  local mdir; mdir="$MOBILE_DIR"
  [ -n "$mdir" ] && [ -d "$mdir" ] || die "vysu up $what: VYSU_MOBILE_DIR does not point at the Expo app"
  local bundle; bundle="$(need_cfg MOBILE_BUNDLE "the app id on both platforms")"
  # The env the dev-clients were built for: Metro's manifest (the app config → scheme, api url…)
  # must be generated for the same env, or the login callback scheme does not match.
  local menv=(); local pair
  for pair in $(cfg MOBILE_ENV); do menv+=("$pair"); done
  if [ "${1:-}" = "--avd" ]; then ANDROID_AVD="$2"; device_remember android-avd "$2"; shift 2; fi
  if [ "${1:-}" = "--device" ]; then IOS_DEVICE="$2"; device_remember ios-device "$2"; shift 2; fi
  if [ "${1:-}" = "--build" ]; then
    local dev="$IOS_DEVICE"; [ "$what" = android ] && dev="$ANDROID_AVD"
    (cd "$mdir" && env ${menv[@]+"${menv[@]}"} nohup npx expo run:"$what" --device "$dev" --no-bundler >"$LOGS/$what-build.log" 2>&1 </dev/null &)
    echo "$what: native build started (5-10 min the first time) — tail -f $LOGS/$what-build.log"; return
  fi
  if ! listening 8081; then
    (cd "$mdir" && env ${menv[@]+"${menv[@]}"} nohup npx expo start >"$LOGS/metro.log" 2>&1 </dev/null &)
    wait_http http://localhost:8081/status 60 metro
  fi
  if [ "$what" = android ]; then
    android_lock
    # Emulators run side by side, each addressed by its serial (4 GB of RAM each, so two at most
    # in practice): the one asked for is started when it is not attached, the others are left alone.
    if [ -z "$(android_serial)" ]; then
      # An AVD ships with the GPU off and 1.5 GB: software rendering, ANRs at boot. Force host GPU + RAM.
      nohup "$ANDROID_SDK/emulator/emulator" -avd "$ANDROID_AVD" -gpu host -memory 4096 -cores 4 -dns-server 1.1.1.1,8.8.8.8 -no-snapshot-load -no-boot-anim >"$LOGS/android-emulator.log" 2>&1 </dev/null &
      wait_android_serial >/dev/null
    fi
    ANDROID_SERIAL="$(android_serial)"; export ANDROID_SERIAL
    wait_android_boot
    # A Google APIs image accepts adb root, so the locale the UI is reviewed in is set once.
    local locale; locale="$(cfg ANDROID_LOCALE)"
    if [ -n "$locale" ] && [ "$(adb shell getprop persist.sys.locale 2>/dev/null | tr -d '\r')" != "$locale" ]; then
      adb root >/dev/null 2>&1 && adb shell "setprop persist.sys.locale $locale; setprop ctl.restart zygote" >/dev/null 2>&1
      sleep 20; wait_android_boot
    fi
    adb reverse tcp:8081 tcp:8081 >/dev/null   # Metro reachable as localhost from the emulator (adbd restarts drop it)
    # A new AVD has no app yet: install the last dev-client built by --build.
    if ! adb shell pm list packages 2>/dev/null | grep -q "$bundle"; then
      local apk="$mdir/android/app/build/outputs/apk/debug/app-debug.apk"
      [ -f "$apk" ] && adb install -r "$apk" >/dev/null 2>&1 && echo "android: dev-client installed on $ANDROID_AVD" || echo "android: no dev-client on $ANDROID_AVD (vysu up android --build)"
    fi
    echo "android: Metro on 8081, $ANDROID_AVD booted on $ANDROID_SERIAL → vysu android open $bundle --foreground"
  else
    ios_lock
    # Start of a mobile session: the one place where looking the UDID up again is worth it.
    local udid; udid="$(ios_udid --refresh)"
    [ "$udid" != booted ] || die "ios: no simulator named « $IOS_DEVICE » (xcrun simctl list devices)"
    xcrun simctl boot "$udid" >/dev/null 2>&1 || true
    open -a Simulator >/dev/null 2>&1 || true
    ios_freeze_status_bar
    # A new simulator has no app yet: install the last dev-client built by --build. Xcode writes it
    # under DerivedData, named after the Xcode project the Expo prebuild generated.
    if ! xcrun simctl listapps "$udid" 2>/dev/null | grep -q "$bundle"; then
      # shellcheck disable=SC2012  # the newest build is what is wanted, and `find -printf` is not on macOS
      local app
      # shellcheck disable=SC2012  # the newest build is what is wanted; `find -printf` is not on macOS
      app="$(ls -dt ~/Library/Developer/Xcode/DerivedData/*/Build/Products/Debug-iphonesimulator/*.app 2>/dev/null | head -1)"
      [ -n "$app" ] && xcrun simctl install "$udid" "$app" >/dev/null 2>&1 && echo "ios: dev-client installed on $IOS_DEVICE" || echo "ios: no dev-client on $IOS_DEVICE (vysu up ios --build)"
    fi
    echo "ios: Metro on 8081, $IOS_DEVICE booted → vysu ios open \"$(cfg IOS_APP)\" --foreground"
  fi
}
