# mctl.sh — the device conditions an agent used to reach past vysu for: a deep link opened in the
# running app (`mopen`), the network cut and brought back (`mnet`), a permission granted, denied or
# put back to « ask » (`mperm`), and a burst of 1x frames around one step (`mburst`). Each is the raw
# `xcrun simctl` / `adb` call, made under vysu's device lock, read back before it claims anything,
# and answered in one line. They return 1 with one line on stderr instead of calling `die`: a flow
# step calls them, and a link that did not land is a failed step, not the end of the flow.
# shellcheck shell=bash
# shellcheck disable=SC2153  # STATE, SHOTS, LOGS, PY and the rest are set in core.sh

# One line on stderr, in die's colours. It does not return 1 itself: every caller says `return 1`
# on the next word, so the exit status never depends on whether errexit was on at that point.
mctl_why() { printf '%svysu: %s%s\n' "${E_ON:-}" "$*" "${E_OFF:-}" >&2; }
mctl_platform() { # platform usage → 0 for ios|android, the usage line otherwise
  case "$1" in ios|android) return 0;; esac
  mctl_why "usage: $2"; return 1
}
mctl_int() { case "$1" in ''|*[!0-9]*) return 1;; esac; }
mctl_num() { case "$1" in ''|.|*[!0-9.]*|*.*.*) return 1;; esac; }

# Is the app's process alive? iOS: launchd names an app « UIKitApplication:<id>[…] » and lists it
# with a pid while it runs, « - » once it has exited. A permission change on either platform ends it.
mctl_app_running() { # platform bundle
  if [ "$1" = android ]; then
    [ -n "$(adb shell pidof "$2" 2>/dev/null | tr -d '\r')" ]
  else
    ios_lock
    local list; list="$(xcrun simctl spawn "$(ios_udid)" launchctl list 2>/dev/null || true)"
    printf '%s\n' "$list" | awk -v b="UIKitApplication:$2[" 'index($3, b) == 1 && $1 ~ /^[0-9]+$/ { found = 1 } END { exit !found }'
  fi
}
# Up = running AND past Expo's launcher. A cold deep link is the one that goes wrong: a dev-client
# not yet handed its bundle opens on the launcher and keeps the link there (seen on both platforms
# with the real app: a raw cold `am start -d` / `simctl openurl` parks it on « Development Build »
# for good), and a second link lands there too. Android answers in one `dumpsys window`; iOS needs
# a snapshot, the price of not handing a link to the launcher.
mopen_app_up() { # platform bundle
  mctl_app_running "$1" "$2" || return 1
  [ "$(mobile_kind)" = expo ] || return 0
  if [ "$1" = android ]; then
    ! adb shell dumpsys window 2>/dev/null | grep -m1 mCurrentFocus | grep -q DevLauncherActivity
  else
    case "$(ad ios snapshot -i 2>/dev/null || true)" in *'"Development Build"'*) return 1;; esac
  fi
}

# --- mopen ---------------------------------------------------------------------------------------

# A route is appended to VYSU_MOBILE_DEEPLINK (« myapp:/// » + « discussions/42 »); anything holding
# « :// » is already a URL and goes as it is — an https universal link included.
mopen_url() { # route|url → the url
  case "$1" in *://*) printf '%s' "$1"; return 0;; esac
  local prefix route="$1"; prefix="$(cfg MOBILE_DEEPLINK)"
  [ -n "$prefix" ] || { mctl_why "mopen: « $1 » is a route and VYSU_MOBILE_DEEPLINK is not set (the prefix a route is appended to, e.g. myapp:///), or pass a full url"; return 1; }
  while [ "${route#/}" != "$route" ]; do route="${route#/}"; done
  printf '%s%s' "$prefix" "$route"
}
# iOS asks « Ouvrir dans « App » ? » before handing a custom-scheme URL from simctl to the app, the
# way Safari would. The alert belongs to SpringBoard, not to the app, and does not always come (an
# https link, a runtime that skips it): it is looked for in one snapshot, and pressed only if there.
mopen_confirm_ios() {
  local i tree
  for i in 1 2 3; do
    tree="$(ad ios snapshot -i 2>/dev/null || true)"
    case "$tree" in
      *'"Ouvrir"'*|*'"Open"'*) mob_press_any ios "Ouvrir,Open" && return 0;;
    esac
    [ "$i" = 3 ] || sleep 0.4
  done
  return 0
}
# What is on screen, reduced to a checksum: the tree before the link against the tree after it.
mopen_sig() { ad "$1" snapshot -i 2>/dev/null | grep '^@' | cksum | tr -d ' \t' || true; }
vysu_mopen() {
  local usage="vysu mopen ios|android <route|url> [--wait \"<text>\"] [--timeout <s>]"
  local platform="${1:-}" target="${2:-}"
  mctl_platform "$platform" "$usage" || return 1
  [ -n "$target" ] || { mctl_why "usage: $usage"; return 1; }
  shift 2
  local wait_text="" timeout=10
  while [ $# -gt 0 ]; do
    case "$1" in
      --wait) [ -n "${2:-}" ] || { mctl_why "mopen: --wait needs a text"; return 1; }; wait_text="$2"; shift 2;;
      --timeout) mctl_int "${2:-}" || { mctl_why "mopen: --timeout is whole seconds"; return 1; }; timeout="$2"; shift 2;;
      *) mctl_why "mopen: unknown option $1 (usage: $usage)"; return 1;;
    esac
  done
  local url bundle; url="$(mopen_url "$target")" || return 1
  bundle="$(cfg MOBILE_BUNDLE)"
  [ -n "$bundle" ] || { mctl_why "mopen: VYSU_MOBILE_BUNDLE is not set (the app id on both platforms)"; return 1; }
  [ "$platform" != android ] || android_select
  if ! mopen_app_up "$platform" "$bundle"; then
    log "$platform: $bundle is not up (not running, or on the launcher): launching it first, so the link reaches the app"
    vysu_mrelaunch "$platform" >/dev/null || { mctl_why "$platform: the cold start before $url failed"; return 1; }
    # A relaunch can still come up on the launcher (seen after a raw cold link had parked the
    # dev-client there), and the link must not be handed to it: the bundle URL first, in expo mode.
    [ "$(mobile_kind)" != expo ] || mobile_load_bundle "$platform"
  fi
  # The screen before the link, when there is no text to wait for: `am start` and `openurl` return
  # as soon as the intent is delivered, and the app routes it a second or two later (2.2 s measured
  # on an API 30 emulator, a sheet closing first). A « stable » wait alone reads the old screen, and
  # so does a change test against a screen still loading (a discussion painting its comments): the
  # screen is let settle first. `--wait` is the quick and sure way; this is the fallback.
  local before=""
  if [ -z "$wait_text" ]; then
    ad "$platform" wait stable 400 4000 >/dev/null 2>&1 || true
    before="$(mopen_sig "$platform")"
  fi
  if [ "$platform" = ios ]; then
    sim openurl "$url" >/dev/null 2>&1 || { mctl_why "ios: simctl refused $url (no app claims that scheme?)"; return 1; }
    mopen_confirm_ios
  else
    # To the package, so no chooser and no browser picks it up. `am start` always adds NEW_TASK, and
    # with the singleTask activity an Expo app declares, that brings the existing task forward and
    # hands the link to it (onNewIntent) instead of stacking a second copy of the app. The URL is
    # quoted for the device's shell: a « ? » or a « & » would otherwise be read there.
    local q out
    q="'$(printf '%s' "$url" | sed "s/'/'\\\\''/g")'"
    out="$(adb shell "am start -a android.intent.action.VIEW -d $q $bundle" 2>&1 | tr -d '\r')"
    case "$out" in
      *Error*|*Exception*) mctl_why "android: $(printf '%s\n' "$out" | grep -m1 -E 'Error|Exception')"; return 1;;
    esac
  fi
  if [ -n "$wait_text" ]; then
    ad "$platform" wait text "$wait_text" "$((timeout * 1000))" >/dev/null 2>&1 || {
      mctl_why "$platform: opened $url but « $wait_text » did not show within ${timeout}s · $(mscreen_line "$platform")"
      return 1
    }
  else
    # No text to wait for: until the tree differs from the one before the link (5 s at most: a link
    # to the screen already shown changes nothing), then until it holds still for half a second (the
    # push animation, the first query landing), bounded so a screen that never settles costs 5 s.
    local until_t; until_t="$(perl -e 'printf "%.3f", $ARGV[0] + 5' "$(now)")"
    while [ "$(mopen_sig "$platform")" = "$before" ]; do
      perl -e 'exit($ARGV[0] < $ARGV[1] ? 0 : 1)' "$(now)" "$until_t" || break
      sleep 0.2
    done
    ad "$platform" wait stable 500 5000 >/dev/null 2>&1 || true
  fi
  echo "$platform: opened $url · $(mscreen_line "$platform")"
}

# --- mnet ----------------------------------------------------------------------------------------

# The emulator's radios, through airplane mode: the one switch that cuts Wi-Fi and cellular for the
# whole device and that the app sees exactly as a user's. `adb reverse` rides the adb channel, not
# the network, so Metro keeps serving the bundle while the app's own requests fail.
mnet_airplane() { adb shell settings get global airplane_mode_on 2>/dev/null | tr -d '\r'; }
mnet_default_network() { # → the active network's id, or « none »
  local n; n="$(adb shell dumpsys connectivity 2>/dev/null | grep -m1 'Active default network' | tr -d '\r' || true)"
  n="${n##*: }"; printf '%s' "${n:-none}"
}
vysu_mnet() {
  local usage="vysu mnet ios|android offline|online"
  local platform="${1:-}" want="${2:-}"
  mctl_platform "$platform" "$usage" || return 1
  case "$want" in offline|online) ;; *) mctl_why "usage: $usage"; return 1;; esac
  if [ "$platform" = ios ]; then
    # Nothing vysu could do here would be honest: simctl has no network verb, and a simulator uses
    # the Mac's own stack, so the only switch is host-wide, and cutting the Mac is not vysu's call.
    mctl_why "ios: a simulator has no network switch of its own (it shares the Mac's stack, and simctl has none): check offline on Android (vysu mnet android offline), or turn the Mac's Wi-Fi off yourself, which cuts everything on it (Metro on localhost keeps serving)"
    return 1
  fi
  android_select
  local on=0 verb=disable; [ "$want" = online ] || { on=1; verb=enable; }
  # `cmd connectivity airplane-mode` exists from API 30 and broadcasts the change itself. Below it,
  # the setting plus the broadcast the Settings app sends; recent images refuse that broadcast to the
  # shell, which is why the setting is read back rather than trusted.
  adb shell cmd connectivity airplane-mode "$verb" >/dev/null 2>&1 || true
  if [ "$(mnet_airplane)" != "$on" ]; then
    local state=false; [ "$on" = 0 ] || state=true
    adb shell settings put global airplane_mode_on "$on" >/dev/null 2>&1 || true
    adb shell am broadcast -a android.intent.action.AIRPLANE_MODE --ez state "$state" >/dev/null 2>&1 || true
  fi
  [ "$(mnet_airplane)" = "$on" ] || { mctl_why "android: airplane_mode_on still reads $(mnet_airplane) (wanted $on): this image refused both ways of switching it"; return 1; }
  # The radios follow the setting a beat later, and coming back takes a DHCP round: the answer is
  # given once the network the app would use is gone, or is back, so the next step sees that state.
  local i net; net="$(mnet_default_network)"
  for i in $(seq 1 40); do
    if [ "$on" = 1 ]; then [ "$net" = none ] && break; else [ "$net" != none ] && break; fi
    sleep 0.5; net="$(mnet_default_network)"
  done
  if [ "$on" = 1 ]; then
    mstate_set android net offline
    [ "$net" = none ] || { mctl_why "android: airplane mode on, but network $net is still the default after 20s"; return 1; }
    echo "android: offline (airplane mode on · no default network)"
  else
    mstate_set android net ""
    [ "$net" != none ] || { mctl_why "android: airplane mode off, but no default network after 20s (the emulator's Wi-Fi may need a moment more)"; return 1; }
    echo "android: online (airplane mode off · default network $net)"
  fi
}

# --- mperm ---------------------------------------------------------------------------------------

# One vocabulary for both platforms: the seven names a test asks for, each mapped to what the
# platform calls it. Anything else is passed through as the platform's own name.
MPERM_NAMES="notifications camera photos location microphone contacts calendar"
mperm_android_name() { # name sdk → android.permission.X
  case "$1" in
    notifications) printf 'android.permission.POST_NOTIFICATIONS';;
    camera) printf 'android.permission.CAMERA';;
    # Photos split from storage in API 33: READ_MEDIA_IMAGES there, READ_EXTERNAL_STORAGE before.
    photos) if [ "$2" -ge 33 ]; then printf 'android.permission.READ_MEDIA_IMAGES'; else printf 'android.permission.READ_EXTERNAL_STORAGE'; fi;;
    location) printf 'android.permission.ACCESS_FINE_LOCATION';;
    microphone) printf 'android.permission.RECORD_AUDIO';;
    contacts) printf 'android.permission.READ_CONTACTS';;
    calendar) printf 'android.permission.READ_CALENDAR';;
    *.*) printf '%s' "$1";;
    *) printf 'android.permission.%s' "$1";;
  esac
}
# The runtime line of that permission in `dumpsys package`, as « granted=… flags … »: only the flags
# that decide what the app sees next (user-set = refused once, the app may ask again; user-fixed =
# « don't ask again », the system answers for the user). Empty when the app does not request it.
mperm_android_state() { # package permission
  local line granted flags
  line="$(adb shell dumpsys package "$1" 2>/dev/null | tr -d '\r' | grep -m1 -F "$2: granted=" || true)"
  [ -n "$line" ] || return 0
  granted="$(printf '%s' "$line" | sed -n 's/.*granted=\([a-z]*\).*/\1/p')"
  flags="$(printf '%s' "$line" | sed -n 's/.*flags=\[\(.*\)\].*/\1/p' | tr '|' '\n' | tr -d ' ' \
    | grep -E '^(USER_SET|USER_FIXED|POLICY_FIXED|SYSTEM_FIXED|GRANTED_BY_DEFAULT|ONE_TIME)$' | paste -sd'|' - || true)"
  printf 'granted=%s%s' "$granted" "${flags:+ $flags}"
}
mperm_android() { # name action
  local name="$1" action="$2" bundle sdk perm before after was_running=0
  android_select
  bundle="$(cfg MOBILE_BUNDLE)"
  sdk="$(adb shell getprop ro.build.version.sdk 2>/dev/null | tr -d '\r')"; mctl_int "$sdk" || sdk=0
  if [ "$name" = notifications ] && [ "$sdk" -lt 33 ]; then
    # Before API 33 there is no runtime permission: notifications are on from the install, and
    # only the user's toggle in the system settings turns them off. There is no prompt to reset.
    if [ "$action" = grant ]; then
      echo "android: notifications need no permission below API 33 (this image is API $sdk): already allowed"
      return 0
    fi
    mctl_why "android: API $sdk has no notification permission (POST_NOTIFICATIONS is API 33+): the app never asks, and only the system settings toggle turns them off; nothing to $action here"
    return 1
  fi
  perm="$(mperm_android_name "$name" "$sdk")"
  before="$(mperm_android_state "$bundle" "$perm")"
  [ -n "$before" ] || { mctl_why "android: $bundle does not request $perm (not in its manifest, or not a runtime permission on API $sdk): nothing to $action"; return 1; }
  [ -z "$(adb shell pidof "$bundle" 2>/dev/null | tr -d '\r')" ] || was_running=1
  local out rc=0 noflags=0 note=""
  case "$action" in
    grant) out="$(adb shell pm grant "$bundle" "$perm" 2>&1)" || rc=$?;;
    # Denied the way a user leaves it after a second « Don't allow »: revoked and fixed, so the app
    # reads a refusal and the system shows no prompt. A single refusal is what `reset` + one « no » gives.
    deny) out="$(adb shell pm revoke "$bundle" "$perm" 2>&1)" || rc=$?
          [ "$rc" != 0 ] || mperm_android_flags set "$bundle" "$perm" || rc=$?;;
    # Back to « never asked »: revoked, and the two flags a refusal leaves cleared, so the app's next
    # request shows the system prompt again.
    reset) out="$(adb shell pm revoke "$bundle" "$perm" 2>&1)" || rc=$?
           [ "$rc" != 0 ] || mperm_android_flags clear "$bundle" "$perm" || rc=$?;;
  esac
  # `pm` answers « Exception occurred… » with a stack trace, sometimes on a zero exit.
  case "$out" in *Exception*|*Error*) rc=1;; esac
  [ "$rc" = 0 ] || { mctl_why "android: pm $action $perm: $(mperm_pm_error "$out")"; return 1; }
  after="$(mperm_android_state "$bundle" "$perm")"
  local ok=1
  case "$action:$after" in
    grant:granted=true*) ;;
    deny:granted=false*USER_FIXED*) ;;
    deny:granted=false*) [ "$noflags" = 1 ] || ok=0
      note=" · API $sdk: pm cannot set « don't ask again » (API 31+), so the app may ask once more";;
    reset:granted=false) ;;
    reset:granted=false\ *) case "$after" in *USER_SET*|*USER_FIXED*) ok=0;; esac;;
    *) ok=0;;
  esac
  if [ "$ok" = 0 ] && [ "$noflags" = 1 ] && [ "$action" = reset ]; then
    mctl_why "android: $perm is revoked, but the user's earlier refusal stays ($after): pm cannot clear it before API 31 (this image is API $sdk), so the prompt will not come back (only a reinstall, or pm reset-permissions for every app at once, clears it)"
    return 1
  fi
  [ "$ok" = 1 ] || { mctl_why "android: $name $action did not hold: $perm reads $after (was $before)"; return 1; }
  # Android kills an app whose permission is taken away; the next step has to know it relaunches.
  local stopped=""
  [ "$was_running" = 0 ] || [ -n "$(adb shell pidof "$bundle" 2>/dev/null | tr -d '\r')" ] || stopped=" · the app was stopped (a revoke kills it)"
  echo "android: $name $(mperm_word "$action") · $perm $after (was $before)$(mperm_next "$action")$stopped$note"
}
# `pm set-permission-flags` / `clear-permission-flags` exist from API 31: API 30 lists them in its
# help and answers « Unknown command ». There, $noflags says so and the caller decides what that
# costs; any other failure is the caller's error line.
mperm_android_flags() { # set|clear package permission — sets $noflags, $out
  out="$(adb shell pm "$1-permission-flags" "$2" "$3" user-set user-fixed 2>&1 | tr -d '\r')"
  case "$out" in "Unknown command"*) noflags=1; out=""; return 0;; esac
  case "$out" in *Exception*|*Error*) return 1;; esac
  return 0
}
# The line of a `pm` failure worth reading: the exception's own message, not « Exception occurred ».
mperm_pm_error() {
  local line; line="$(printf '%s\n' "$1" | tr -d '\r' | grep -m1 -E '^[a-z.]+(Exception|Error): ' || true)"
  [ -n "$line" ] || line="$(printf '%s\n' "$1" | tr -d '\r' | grep -m1 . || true)"
  printf '%s' "${line#*: }"
}
mperm_word() { case "$1" in grant) printf 'granted';; deny) printf 'denied';; reset) printf 'reset';; esac; }
mperm_next() { [ "$1" != reset ] || printf ' · the app will ask again'; }
# iOS: `simctl privacy` speaks TCC for the services it lists; the answer is read back from the
# simulator's own TCC.db, where each one has its row. Location is locationd's, not TCC's: its
# clients.plist holds « Authorization » per app (1 denied, 2 when in use, 4 always, absent = never
# asked). The camera has no simctl service at all (and a simulator no camera).
mperm_ios_tcc() { # simctl service → the TCC service name, or nothing
  case "$1" in
    photos) printf 'kTCCServicePhotos';; photos-add) printf 'kTCCServicePhotosAdd';;
    microphone) printf 'kTCCServiceMicrophone';; contacts|contacts-limited) printf 'kTCCServiceAddressBook';;
    calendar) printf 'kTCCServiceCalendar';; reminders) printf 'kTCCServiceReminders';;
    media-library) printf 'kTCCServiceMediaLibrary';; motion) printf 'kTCCServiceMotion';; siri) printf 'kTCCServiceSiri';;
  esac
}
mperm_ios_read() { # TCC service | locationd, bundle → the state
  if [ "$1" = locationd ]; then mperm_ios_location "$2"; else mperm_ios_state "$1" "$2"; fi
}
mperm_ios_state() { # TCC service bundle → granted | denied | limited | not asked
  local db v
  db="$HOME/Library/Developer/CoreSimulator/Devices/$(ios_udid)/data/Library/TCC/TCC.db"
  [ -f "$db" ] || { printf 'unknown'; return 0; }
  # Read-only: tccd owns the file (in WAL mode), a reader never has to write to it.
  v="$(sqlite3 -readonly "$db" "select auth_value from access where service = '$1' and client = '$2' limit 1" 2>/dev/null || true)"
  case "$v" in 0) printf 'denied';; 2) printf 'granted';; 3) printf 'limited';; '') printf 'not asked';; *) printf 'auth_value %s' "$v";; esac
}
mperm_ios_location() { # bundle → granted | granted always | denied | not asked
  local f; f="$HOME/Library/Developer/CoreSimulator/Devices/$(ios_udid)/data/Library/Caches/locationd/clients.plist"
  [ -f "$f" ] || { printf 'not asked'; return 0; }
  python3 -c '
import plistlib, sys
try:
    c = plistlib.load(open(sys.argv[1], "rb")).get("i%s:" % sys.argv[2]) or {}
except Exception:
    c = {}
a = c.get("Authorization")
print({None: "not asked", 1: "denied", 2: "granted", 4: "granted always"}.get(a, "authorization %s" % a))
' "$f" "$1" 2>/dev/null || printf 'unknown'
}
mperm_ios() { # name action
  local name="$1" action="$2" bundle service tcc before="" after="" was_running=0
  bundle="$(cfg MOBILE_BUNDLE)"
  case "$name" in
    notifications) mperm_ios_notifications "$action"; return;;
    camera) mctl_why "ios: simctl privacy has no camera service, and a simulator has no camera: nothing to $action (check camera flows on Android)"; return 1;;
  esac
  service="$name"
  ios_lock
  tcc="$(mperm_ios_tcc "$service")"
  case "$service" in location|location-always) tcc=locationd;; esac
  [ -z "$tcc" ] || before="$(mperm_ios_read "$tcc" "$bundle")"
  ! mctl_app_running ios "$bundle" || was_running=1
  local verb="$action" out; [ "$action" != deny ] || verb=revoke
  out="$(sim privacy "$verb" "$service" "$bundle" 2>&1)" || {
    mctl_why "ios: simctl privacy $verb $service: $(printf '%s\n' "$out" | grep -m1 . || true)"; return 1
  }
  local stopped=""
  [ "$was_running" = 0 ] || mctl_app_running ios "$bundle" || stopped=" · the app was stopped (simctl ends it on a change)"
  if [ -z "$tcc" ]; then
    echo "ios: $name $(mperm_word "$action") · simctl privacy $verb $service (no read-back known for this service)$(mperm_next "$action")$stopped"
    return 0
  fi
  local want i; case "$action" in grant) want=granted;; deny) want=denied;; reset) want="not asked";; esac
  [ "$service" != location-always ] || [ "$action" != grant ] || want="granted always"
  # locationd writes its file a beat after simctl returns; TCC.db is there at once.
  for i in 1 2 3 4 5 6; do
    after="$(mperm_ios_read "$tcc" "$bundle")"
    [ "$after" != "$want" ] || break
    sleep 0.3
  done
  [ "$after" = "$want" ] || { mctl_why "ios: $name $action did not hold: $tcc reads « $after » (was « $before »)"; return 1; }
  echo "ios: $name $(mperm_word "$action") · $tcc $after (was $before)$(mperm_next "$action")$stopped"
}
# Notifications are not TCC's: SpringBoard's BulletinBoard keeps one archived BBSectionInfo per app
# in data/Library/BulletinBoard/VersionedSectionInfo.plist, and its authorizationStatus (0 never
# asked, 1 denied, 2 granted, 3 provisional) is what UNUserNotificationCenter answers the app.
# `simctl privacy` has no service for it, so that file is the one handle: `reset` drops the app's
# section (iOS then treats it as never asked, and the next request prompts), `deny` / `grant` set
# the status. SpringBoard holds the sections in memory and writes them back: it is stopped with
# SIGKILL right after the edit (a clean exit would save its own copy over it) and launchd starts it
# again from the file, along with usernotificationsd, which caches what it last read.
# The section vysu removed or changed is kept under $STATE, so a `grant` after a `reset` puts the
# app's own section back rather than one made up.
mperm_bb() { # plist bundle read|reset|grant|deny saved-section → prints the status (read), exit 3: no section
  python3 - "$@" <<'PY'
import os
import plistlib
import sys

path, bundle, op, saved = sys.argv[1:5]
NAMES = {0: "not asked", 1: "denied", 2: "granted", 3: "provisional", 4: "ephemeral"}
with open(path, "rb") as f:
    top = plistlib.load(f)
sections = top.setdefault("sectionInfo", {})


def settings_of(blob):
    """The archive and its BBSectionInfoSettings dict (NSKeyedArchiver: objects addressed by UID)."""
    archive = plistlib.loads(blob)
    objects = archive["$objects"]
    root = objects[archive["$top"]["root"].data]
    return archive, objects[root["sectionInfoSettings"].data]


blob = sections.get(bundle)
if op == "read":
    if blob is None:
        print("not asked")
    else:
        status = settings_of(blob)[1].get("authorizationStatus")
        print(NAMES.get(status, "status %s" % status))
    sys.exit(0)
if op == "reset":
    if blob is None:
        sys.exit(0)
    open(saved, "wb").write(blob)
    del sections[bundle]
else:
    if blob is None:
        if not os.path.exists(saved):
            sys.exit(3)
        blob = open(saved, "rb").read()
    else:
        open(saved, "wb").write(blob)
    archive, settings = settings_of(blob)
    settings["authorizationStatus"] = 2 if op == "grant" else 1
    sections[bundle] = plistlib.dumps(archive, fmt=plistlib.FMT_BINARY)
tmp = path + ".vysu"
with open(tmp, "wb") as f:
    plistlib.dump(top, f, fmt=plistlib.FMT_BINARY)
os.replace(tmp, path)
PY
}
mperm_springboard_pid() { xcrun simctl spawn "$1" launchctl print user/foreground/com.apple.SpringBoard 2>/dev/null | awk '$1 == "pid" { print $3; exit }'; }
mperm_ios_notifications() { # action
  local action="$1" bundle udid file saved before after rc=0
  bundle="$(cfg MOBILE_BUNDLE)"; ios_lock; udid="$(ios_udid)"
  file="$HOME/Library/Developer/CoreSimulator/Devices/$udid/data/Library/BulletinBoard/VersionedSectionInfo.plist"
  [ -f "$file" ] || { mctl_why "ios: no BulletinBoard file on this simulator ($file): nothing to $action"; return 1; }
  mkdir -p "$STATE"; saved="$STATE/bulletin-$udid-$bundle.section"
  before="$(mperm_bb "$file" "$bundle" read "$saved" 2>/dev/null)" || { mctl_why "ios: cannot read $file"; return 1; }
  local old_pid; old_pid="$(mperm_springboard_pid "$udid")"
  mperm_bb "$file" "$bundle" "$action" "$saved" >/dev/null 2>&1 || rc=$?
  [ "$rc" != 3 ] || { mctl_why "ios: $bundle has never asked for notifications on this simulator, so there is no section to $action: let the app ask once (then deny / grant / reset work)"; return 1; }
  [ "$rc" = 0 ] || { mctl_why "ios: could not rewrite $file"; return 1; }
  xcrun simctl spawn "$udid" launchctl kill SIGKILL user/foreground/com.apple.SpringBoard >/dev/null 2>&1 || true
  xcrun simctl spawn "$udid" launchctl kill SIGKILL user/foreground/com.apple.usernotificationsd >/dev/null 2>&1 || true
  # Back when launchd has a new SpringBoard running; the home screen takes a moment more to paint.
  local i pid=""
  for i in $(seq 1 40); do
    pid="$(mperm_springboard_pid "$udid")"
    [ -z "$pid" ] || [ "$pid" = "$old_pid" ] || break
    sleep 0.5
  done
  { [ -n "$pid" ] && [ "$pid" != "$old_pid" ]; } || { mctl_why "ios: SpringBoard did not come back after the restart (pid ${pid:-none})"; return 1; }
  sleep 2
  after="$(mperm_bb "$file" "$bundle" read "$saved" 2>/dev/null || true)"
  local want; case "$action" in grant) want=granted;; deny) want=denied;; reset) want="not asked";; esac
  [ "$after" = "$want" ] || { mctl_why "ios: notifications $action did not hold: SpringBoard reads « $after » back (was « $before »)"; return 1; }
  echo "ios: notifications $(mperm_word "$action") · BulletinBoard $after (was $before)$(mperm_next "$action") · SpringBoard restarted: relaunch the app (vysu mrelaunch ios)"
}
vysu_mperm() {
  local usage="vysu mperm ios|android <permission> grant|deny|reset  (permission: ${MPERM_NAMES// /, }, or the platform's own name)"
  local platform="${1:-}" name="${2:-}" action="${3:-}"
  mctl_platform "$platform" "$usage" || return 1
  [ -n "$name" ] || { mctl_why "usage: $usage"; return 1; }
  case "$action" in grant|deny|reset) ;; *) mctl_why "usage: $usage"; return 1;; esac
  [ $# -le 3 ] || { mctl_why "usage: $usage"; return 1; }
  [ -n "$(cfg MOBILE_BUNDLE)" ] || { mctl_why "mperm: VYSU_MOBILE_BUNDLE is not set (the app id on both platforms)"; return 1; }
  if [ "$platform" = android ]; then mperm_android "$name" "$action"; else mperm_ios "$name" "$action"; fi
}

# --- mburst --------------------------------------------------------------------------------------

# A skeleton turning into content, a sheet rising, a toast: a state that lasts half a second is
# what a screenshot misses and a recording buries in 90 frames. A burst is plain screenshots, as
# fast as the platform gives them (simctl's own capture on iOS, `screencap` on Android, both far
# quicker than agent-device's), started before the step so the first frame is the screen it acts
# on. burst.py brings them to 1x and keeps the ones that differ from the last one kept, under
# diff.py's rule. The capture loop is a background subshell: it stops on a file, on its own
# deadline, and when this vysu is gone, so a failure in between never leaves it capturing.
mburst_loop() { # platform raw-dir every udid-or-serial max-seconds
  local platform="$1" raw="$2" every="$3" target="$4" max="$5" i=0 f t0 t1 deadline
  deadline="$(perl -e 'printf "%.3f", $ARGV[0] + $ARGV[1]' "$(now)" "$max")"
  while [ ! -f "$raw/stop" ] && kill -0 "$VYSU_PID" 2>/dev/null; do
    perl -e 'exit($ARGV[0] < $ARGV[1] ? 0 : 1)' "$(now)" "$deadline" || break
    f="$(printf '%s/%03d.png' "$raw" "$i")"
    t0="$(now)"
    if [ "$platform" = ios ]; then
      xcrun simctl io "$target" screenshot "$f" >/dev/null 2>&1 || true
    else
      adb -s "$target" exec-out screencap -p >"$f" 2>/dev/null || true
    fi
    t1="$(now)"
    printf '%s\t%s\t%s\n' "$i" "$t0" "$t1" >>"$raw/times.tsv"
    i=$((i + 1))
    # The cadence asked for, never faster than a capture takes: what is left of the period, if any.
    perl -e 'my $s = $ARGV[0] - ($ARGV[2] - $ARGV[1]); select(undef, undef, undef, $s) if $s > 0' "$every" "$t0" "$t1"
  done
}
vysu_mburst() {
  local usage="vysu mburst ios|android <name> [--seconds 3] [--every 0.3] [-- \"<step>\" …]"
  local platform="${1:-}" name="${2:-}"
  mctl_platform "$platform" "$usage" || return 1
  [ -n "$name" ] || { mctl_why "usage: $usage"; return 1; }
  shift 2
  local seconds=3 every=0.3
  while [ $# -gt 0 ]; do
    case "$1" in
      --seconds) mctl_num "${2:-}" || { mctl_why "mburst: --seconds is a number"; return 1; }; seconds="$2"; shift 2;;
      --every) mctl_num "${2:-}" || { mctl_why "mburst: --every is a number of seconds"; return 1; }; every="$2"; shift 2;;
      --) shift; break;;
      *) mctl_why "mburst: unknown option $1 (usage: $usage)"; return 1;;
    esac
  done
  [ -f "$PY/burst.py" ] || { mctl_why "burst.py missing ($PY/burst.py)"; return 1; }
  local target scale
  if [ "$platform" = android ]; then android_select; target="$ANDROID_SERIAL"
  else ios_lock; target="$(ios_udid)"; fi
  scale="$(mobile_scale "$platform")"
  local dir="$SHOTS/$name" raw
  raw="$dir/.burst-$platform"; rm -rf "$raw"; mkdir -p "$raw"
  # The loop's own deadline covers a step that hangs: the burst plus a minute, then it stops anyway.
  mburst_loop "$platform" "$raw" "$every" "$target" "$(perl -e 'print $ARGV[0] + 60' "$seconds")" &
  local loop=$!
  local i; for i in $(seq 1 200); do [ ! -s "$raw/times.tsv" ] || break; sleep 0.05; done
  [ -s "$raw/times.tsv" ] || { touch "$raw/stop"; wait "$loop" 2>/dev/null || true; mctl_why "$platform: the first capture never came back"; return 1; }
  local t_first; t_first="$(head -1 "$raw/times.tsv" | cut -f3)"
  local step failed=0
  for step in "$@"; do
    mobile_step "$platform" "$name" "$step" >/dev/null || { failed=1; mctl_why "mburst: step failed: $step"; }
  done
  # The burst lasts --seconds from its first frame, or until the step is done if that is later:
  # what the step causes is the point of the burst.
  perl -e 'my $s = $ARGV[0] + $ARGV[1] - $ARGV[2]; select(undef, undef, undef, $s) if $s > 0' "$t_first" "$seconds" "$(now)"
  touch "$raw/stop"; wait "$loop" 2>/dev/null || true
  local out
  out="$(python3 "$PY/burst.py" "$raw" --out-dir "$dir" --platform "$platform" --scale "$scale" 2>&1)" || {
    mctl_why "burst.py: $(printf '%s\n' "$out" | tail -1)"; return 1
  }
  rm -rf "$raw"
  printf '%s\n' "$out" | head -1 >"$dir/$platform-burst.txt"
  printf '%s\n' "$out"
  local dev="$ANDROID_AVD"; [ "$platform" = android ] || dev="$IOS_DEVICE"
  meta_write "$dir" kind=mobile platform="$platform" device="$dev" burst=true \
    "textsize=$(mstate_get "$platform" textsize normal)" "appearance=$(mstate_get "$platform" appearance light)" \
    "lang=$(mstate_get "$platform" lang "$(cfg LANG)")" "mobile_sha=$(repo_sha "${MOBILE_DIR:-$VYSU_PROJECT_DIR}")"
  return "$failed"
}
