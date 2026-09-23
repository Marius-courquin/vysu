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
  local what="${1:-}"; [ -n "$what" ] || die "usage: vysu down <service> | all | metro | applog [ios|android]"
  case "$what" in
    all)
      need_project
      local s
      # In reverse: a dependency is stopped after what depends on it.
      for s in $(cfg SERVICES | tr ' ' '\n' | sed -n '1!G;h;$p'); do vysu_down "$s"; done
      return;;
    # This owner's isolated Metro, or the shared one when this owner is the one that started it.
    metro) metro_down; return;;
    # The log tails vysu started: the native app's, and each device's JS console in expo mode. No
    # platform named: both, whichever are running.
    applog) shift; [ $# -gt 0 ] || set -- ios android; applog_stop "$@"; return;;
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

# What `up <platform> --build` runs. A native project names it (`xcodebuild …`, `./gradlew …`); an
# Expo one gets the `expo run:` line it always had, so the two kinds share one code path.
mobile_build_cmd() { # platform
  local key=MOBILE_BUILD_IOS dev="$IOS_DEVICE"
  [ "$1" = ios ] || { key=MOBILE_BUILD_ANDROID; dev="$ANDROID_AVD"; }
  local cmd; cmd="$(cfg "$key")"
  [ -n "$cmd" ] || [ "$(mobile_kind)" != expo ] || cmd="npx expo run:$1 --device \"$dev\" --no-bundler"
  printf '%s' "$cmd"
}
# Where the app to install comes from when the device has none: the path the project names in
# native mode, the last dev-client build in expo mode (Xcode's DerivedData, gradle's debug apk).
mobile_app_artifact() { # platform mobile-dir
  if [ "$(mobile_kind)" = native ]; then
    if [ "$1" = ios ]; then project_path "$(cfg IOS_APP_PATH)"; else project_path "$(cfg ANDROID_APK)"; fi
    return
  fi
  [ "$1" = ios ] || { printf '%s' "$2/android/app/build/outputs/apk/debug/app-debug.apk"; return; }
  # shellcheck disable=SC2012  # the newest build is what is wanted, and `find -printf` is not on macOS
  ls -dt ~/Library/Developer/Xcode/DerivedData/*/Build/Products/Debug-iphonesimulator/*.app 2>/dev/null | head -1
}

mobile_up() {
  local what="$1"; shift
  local kind; kind="$(mobile_kind)"
  local build=0 reinstall=0 isolated=0 iso_port="" iso_dir=""
  while [ $# -gt 0 ]; do
    case "$1" in
      --avd) ANDROID_AVD="$2"; device_remember android-avd "$2"; shift 2;;
      --device) IOS_DEVICE="$2"; device_remember ios-device "$2"; shift 2;;
      --build) build=1; shift;;
      --reinstall) reinstall=1; shift;;
      --isolated) isolated=1; shift;;
      --port) iso_port="$2"; shift 2;;
      --dir) iso_dir="$2"; shift 2;;
      *) die "vysu up $what: unknown option $1";;
    esac
  done
  [ "$isolated" = 1 ] || [ -z "$iso_port$iso_dir" ] || die "vysu up $what: --port and --dir go with --isolated"
  [ "$isolated" = 0 ] || [ "$kind" = expo ] || die "vysu up $what --isolated: a native app has no Metro to isolate"
  local bundle; bundle="$(need_cfg MOBILE_BUNDLE "the app id on both platforms")"
  # Where a build runs: the mobile app's folder when the project names one, the project itself
  # otherwise — a native app often has no folder of its own to point at.
  local mdir="${MOBILE_DIR:-${VYSU_PROJECT_DIR:-$PWD}}"
  [ "$kind" != expo ] || [ -d "$mdir" ] || die "vysu up $what: VYSU_MOBILE_DIR does not point at the Expo app"
  # The env the app was built for: Metro's manifest (the app config → scheme, api url…) must be
  # generated for the same env, or the login callback scheme does not match.
  local menv=(); local pair
  for pair in $(cfg MOBILE_ENV); do menv+=("$pair"); done
  if [ "$build" = 1 ]; then
    local cmd; cmd="$(mobile_build_cmd "$what")"
    local key=MOBILE_BUILD_IOS; [ "$what" = ios ] || key=MOBILE_BUILD_ANDROID
    [ -n "$cmd" ] || die "vysu up $what --build: VYSU_$key is not set (the command that builds the app)"
    # Fire-and-forget, but not silent about how it ended: the last line of the log is the exit
    # status, so a `tail` answers « did it build? » without reading the tool's own wording.
    local script; script="$cmd
rc=\$?
echo \"vysu: $what build exited \$rc\"
exit \$rc"
    ( cd "$mdir" && env ${menv[@]+"${menv[@]}"} nohup sh -c "$script" >"$LOGS/$what-build.log" 2>&1 </dev/null & )
    echo "$what: build started in $mdir (5-10 min the first time) — tail -f $LOGS/$what-build.log"; return
  fi
  # The Metro this owner talks to. Shared by default (one checkout, one bundler, several sessions);
  # --isolated starts one for this owner alone, from its own checkout: without --dir, the worktree
  # the command runs in, when it belongs to the repository that holds VYSU_MOBILE_DIR.
  if [ "$isolated" = 1 ]; then
    [ -n "$iso_dir" ] || iso_dir="$(metro_worktree_mobile_dir)" \
      || die "vysu up $what --isolated: this folder is not a worktree of the mobile app's repository" "vysu up $what --isolated --dir <the Expo app folder to serve>"
    iso_dir="$(cd "$iso_dir" 2>/dev/null && pwd -P)" || die "vysu up $what --isolated: no such folder"
    metro_isolated_up "$what" "$iso_port" "$iso_dir" ${menv[@]+"${menv[@]}"}
  elif [ "$kind" = expo ]; then
    local mport; mport="$(metro_port)"
    if ! listening "$mport"; then
      metro_is_isolated && metro_need "vysu up $what" "$what"
      metro_shared_up "$mdir" "$mport" ${menv[@]+"${menv[@]}"}
    fi
  fi
  local port; port="$(metro_port)"
  local artifact; artifact="$(mobile_app_artifact "$what" "$mdir")"
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
      # A zygote restart brings `sys.boot_completed` back to 1 well before the system services are:
      # `up` used to return on a device whose activity manager still answered « is the system
      # running? », taking the app-log's dumpsys and the first launch down with it.
      sleep 20; wait_android_boot; wait_android_shell
    fi
    # Metro reachable as localhost from the emulator (adbd restarts drop it): expo only.
    [ "$kind" != expo ] || adb reverse "tcp:$port" "tcp:$port" >/dev/null
    if [ "$reinstall" = 1 ] || ! mobile_installed android "$bundle"; then
      if [ -n "$artifact" ] && [ -f "$artifact" ] && adb install -r "$artifact" >/dev/null 2>&1; then
        echo "android: $bundle installed on $ANDROID_AVD (from $artifact)"
      elif [ "$kind" = native ]; then
        echo "android: no $bundle on $ANDROID_AVD — set VYSU_ANDROID_APK, or vysu up android --build"
      else
        echo "android: no dev-client on $ANDROID_AVD (vysu up android --build)"
      fi
    elif [ "$kind" = native ]; then
      echo "android: $bundle already installed on $ANDROID_AVD"
    fi
    if [ "$kind" = expo ]; then
      ! mobile_installed android "$bundle" || mobile_quiet_dev_menu android "$bundle"
      echo "android: Metro on $port, $ANDROID_AVD booted on $ANDROID_SERIAL → vysu android open $bundle --foreground"
    else
      applog_start android
      echo "android: $ANDROID_AVD booted on $ANDROID_SERIAL → vysu android open $bundle --foreground"
    fi
  else
    ios_lock
    # Start of a mobile session: the one place where looking the UDID up again is worth it.
    local udid; udid="$(ios_udid --refresh)"
    [ "$udid" != booted ] || die "ios: no simulator named « $IOS_DEVICE » (xcrun simctl list devices)"
    xcrun simctl boot "$udid" >/dev/null 2>&1 || true
    open -a Simulator >/dev/null 2>&1 || true
    ios_freeze_status_bar
    if [ "$reinstall" = 1 ] || ! mobile_installed ios "$bundle"; then
      if [ -n "$artifact" ] && [ -d "$artifact" ] && xcrun simctl install "$udid" "$artifact" >/dev/null 2>&1; then
        echo "ios: $bundle installed on $IOS_DEVICE (from $artifact)"
      elif [ "$kind" = native ]; then
        echo "ios: no $bundle on $IOS_DEVICE — set VYSU_IOS_APP_PATH (a .app built for iphonesimulator), or vysu up ios --build"
      else
        echo "ios: no dev-client on $IOS_DEVICE (vysu up ios --build)"
      fi
    elif [ "$kind" = native ]; then
      echo "ios: $bundle already installed on $IOS_DEVICE"
    fi
    if [ "$kind" = expo ]; then
      ! mobile_installed ios "$bundle" || mobile_quiet_dev_menu ios "$bundle"
      echo "ios: Metro on $port, $IOS_DEVICE booted → vysu ios open \"$(cfg IOS_APP)\" --foreground"
    else
      applog_start ios
      echo "ios: $IOS_DEVICE booted → vysu ios open \"$(cfg IOS_APP)\" --foreground"
    fi
  fi
  # The device is pointed at the isolated Metro now, and proves it: the relaunch waits for that
  # Metro's own « Bundled » line.
  [ "$isolated" = 0 ] || vysu_mrelaunch "$what"
}
