# metro.sh: the bundler in front of an Expo dev-client: the port each owner talks to (the shared
# Metro, or an isolated one started from the owner's own checkout), the log that port writes, the
# bundling failures that log holds, and the reload of ONE device's JS through the inspector proxy.
# shellcheck shell=bash
# shellcheck disable=SC2153  # STATE, LOGS, MOBILE_DIR, IOS_DEVICE and ANDROID_AVD are set in core.sh

# --- which Metro -------------------------------------------------------------------------------

# Sharing one checkout and one Metro stays the default: several sessions on one branch, and a Mac
# short on RAM. An owner that needs its own (a phase where another session's edits must not reach
# its screen) starts one with `vysu up <platform> --isolated`, and this file remembers it: one line,
# « <port> <pid> <dir> ». The pid is the process that listened when `up` saw the Metro healthy, so
# `down metro` never kills what another owner later started on a port this one left.
metro_isolated_file() { printf '%s/metro-port.%s' "$STATE" "$(slug "$(vysu_owner)")"; }
metro_isolated_port() { local f; f="$(metro_isolated_file)"; [ -s "$f" ] && cut -d' ' -f1 "$f" || true; }
# The port every owner without an isolated Metro shares: the config's, else 8081.
metro_shared_port() { cfg METRO_PORT 8081; }
# The port this command talks to: VYSU_METRO_PORT from the environment first (one command pointed
# elsewhere by hand wins over everything), then this owner's isolated Metro, then the config.
metro_port() {
  [ "$(config_origin METRO_PORT)" != env ] || { cfg METRO_PORT; return; }
  local p; p="$(metro_isolated_port)"
  if [ -n "$p" ]; then printf '%s' "$p"; else metro_shared_port; fi
}
metro_is_isolated() { [ "$(config_origin METRO_PORT)" != env ] && [ -n "$(metro_isolated_port)" ]; }
# The line count a « since » is measured from: `from="$(metro_lines)"` before an action, then
# `metro_bundle_error_since "$from"` after it.
metro_lines() { local n; n="$(wc -l <"${1:-$(metro_log)}" 2>/dev/null | tr -d ' ')"; printf '%s' "${n:-0}"; }
# 8081 keeps the path it always had: every reader written before ports existed still finds it.
metro_log() { # [port]
  local p="${1:-$(metro_port)}"
  if [ "$p" = 8081 ]; then printf '%s/metro.log' "$LOGS"; else printf '%s/metro-%s.log' "$LOGS" "$p"; fi
}
# « <tag> Bundled », the line Metro prints when it hands a bundle over. Its platform tag is all it
# says about the device: two iPhones on one Metro print the same line, which is why a relaunch then
# also waits for the screen of its own device.
metro_tag() { [ "$1" = android ] && printf 'Android' || printf 'iOS'; }
# What a dev-client is handed to load the app from: the host side of `adb reverse` on Android, the
# simulator's own loopback on iOS: localhost either way.
metro_url() { printf 'http://localhost:%s' "${1:-$(metro_port)}"; }
# Is the process that answers on this port still the one that was recorded? A pid alone could be
# reused by anything; a port alone could be another owner's Metro.
metro_pid_listening() { # port pid
  [ -n "$2" ] || return 1
  [ "$(lsof -nP -tiTCP:"$1" -sTCP:LISTEN 2>/dev/null | grep -cx "$2" || true)" != 0 ]
}
metro_listener_pid() { lsof -nP -tiTCP:"$1" -sTCP:LISTEN 2>/dev/null | head -1 || true; }
# Dies when this owner's Metro is not there, with the one command that fixes it: an isolated Metro
# that died must not silently hand the device back to the shared one.
metro_need() { # command name, platform
  local port; port="$(metro_port)"
  listening "$port" && return 0
  if metro_is_isolated; then
    die "$1: this owner's isolated Metro on :$port is not running" \
      "vysu up $2 --isolated (restart it), or vysu down metro (back to the shared :$(metro_shared_port))"
  fi
  die "$1: Metro is not running on :$port" "vysu up $2"
}

# --- an isolated Metro -------------------------------------------------------------------------

metro_git_common_dir() { # dir → the physical path of its repository's shared .git, or status 1
  local d; d="$(git -C "$1" rev-parse --git-common-dir 2>/dev/null)" || return 1
  (cd "$1" && cd "$d" && pwd -P)
}
# Without --dir: the checkout the command is run from, when it is a worktree of the repository that
# holds VYSU_MOBILE_DIR. An agent working in `.worktrees/feat-x` serves `.worktrees/feat-x/<the same
# relative folder>`. Anything else is a guess, and a guess here serves the wrong branch.
metro_worktree_mobile_dir() {
  [ -n "$MOBILE_DIR" ] && [ -d "$MOBILE_DIR" ] || return 1
  local mobile main_common here_common main_top here_top rel
  mobile="$(cd "$MOBILE_DIR" && pwd -P)"
  main_common="$(metro_git_common_dir "$mobile")" || return 1
  here_common="$(metro_git_common_dir "$PWD")" || return 1
  [ "$main_common" = "$here_common" ] || return 1
  main_top="$(cd "$(git -C "$mobile" rev-parse --show-toplevel)" && pwd -P)"
  here_top="$(cd "$(git rev-parse --show-toplevel)" && pwd -P)"
  rel="${mobile#"$main_top"}"
  printf '%s%s' "$here_top" "$rel"
}
# 8082 upward: a port nothing listens on and no other owner has on record (its Metro may be down
# for a minute, its port is still its own).
metro_free_port() {
  local p
  for p in $(seq 8082 8099); do
    listening "$p" && continue
    grep -qs "^$p " "$STATE"/metro-port.* && continue
    printf '%s' "$p"; return 0
  done
  return 1
}
metro_isolated_up() { # platform port dir menv…: start this owner's Metro and remember it
  local platform="$1" port="$2" dir="$3"; shift 3
  local current; current="$(metro_isolated_port)"
  if [ -n "$current" ]; then
    [ -z "$port" ] || [ "$port" = "$current" ] \
      || die "vysu up $platform --isolated: $(vysu_owner) already has an isolated Metro on :$current" "vysu down metro"
    if metro_pid_listening "$current" "$(cut -d' ' -f2 "$(metro_isolated_file)")"; then
      echo "metro: isolated on :$current for $(vysu_owner), already running (from $(cut -d' ' -f3- "$(metro_isolated_file)"))"
      return 0
    fi
    port="$current"
  fi
  case "$port" in *[!0-9]*) die "vysu up $platform --isolated: --port takes a number (got « $port »)";; esac
  [ -n "$port" ] || port="$(metro_free_port)" || die "vysu up $platform --isolated: no free port between 8082 and 8099"
  ! listening "$port" || die "vysu up $platform --isolated: :$port is taken (another --port)"
  [ -d "$dir" ] || die "vysu up $platform --isolated: no such folder $dir"
  [ -f "$dir/package.json" ] || die "vysu up $platform --isolated: $dir holds no package.json (the Expo app folder)"
  mkdir -p "$LOGS" "$STATE"
  local log; log="$(metro_log "$port")"
  ( cd "$dir" && env "$@" nohup npx expo start --port "$port" >"$log" 2>&1 </dev/null & )
  wait_http "http://localhost:$port/status" 180 "metro :$port (see $log)"
  printf '%s %s %s\n' "$port" "$(metro_listener_pid "$port")" "$dir" >"$(metro_isolated_file)"
  echo "metro: isolated on :$port for $(vysu_owner), from $dir (log: $log)"
  echo "metro: an isolated Metro costs ~1-1.5 GB of RAM (vysu down metro once the phase is over)"
}
# The shared Metro, when `up` is the one that starts it: its starter is written down, so that owner
# (and only that one) can `down metro` it again.
metro_shared_up() { # dir port menv…
  local dir="$1" port="$2"; shift 2
  mkdir -p "$LOGS" "$STATE"
  ( cd "$dir" && env "$@" nohup npx expo start --port "$port" >"$(metro_log "$port")" 2>&1 </dev/null & )
  wait_http "http://localhost:$port/status" 120 metro
  printf '%s %s\n' "$(vysu_owner)" "$(metro_listener_pid "$port")" >"$STATE/metro-started.$port"
}
# `vysu down metro`: this owner's isolated Metro, else the shared one when this owner started it.
# Never a Metro another session is bundling from without knowing it was someone else's to stop.
metro_down() {
  local f; f="$(metro_isolated_file)"
  if [ -s "$f" ]; then
    local port pid; port="$(cut -d' ' -f1 "$f")"; pid="$(cut -d' ' -f2 "$f")"
    if metro_pid_listening "$port" "$pid"; then kill_port "$port" "$pid"; echo "metro: isolated :$port stopped"
    else echo "metro: isolated :$port was no longer running"; fi
    rm -f "$f"
    echo "metro: $(vysu_owner) is back on the shared :$(metro_shared_port) from the next vysu mrelaunch"
    return
  fi
  local port started owner pid; port="$(metro_shared_port)"; started="$STATE/metro-started.$port"
  owner="$(cut -d' ' -f1 "$started" 2>/dev/null || true)"; pid="$(cut -d' ' -f2 "$started" 2>/dev/null || true)"
  if [ "$owner" = "$(vysu_owner)" ] && metro_pid_listening "$port" "$pid"; then
    kill_port "$port" "$pid"; rm -f "$started"; echo "metro: :$port stopped"
  else
    echo "metro: nothing of $(vysu_owner)'s to stop: :$port is the shared Metro${owner:+ (started by $owner)}, left running"
  fi
}

# --- what Metro logged -------------------------------------------------------------------------

# A bundling failure since a line of the log: the edit that broke it may be another session's on the
# same checkout, and a screen that stopped updating tells an agent nothing about why. Prints
# « <first line of the error> (<file>) » for the last failure, with « · bundled fine since » when a
# later bundle went through, and answers 1 when there is none. Two shapes are known: Metro's
# « <tag> Bundling failed … » followed by the error, and an error of its own (a SyntaxError or an
# unresolved import reported on a Fast Refresh).
metro_bundle_error_since() { # line [log]
  local from="${1:-0}" log="${2:-$(metro_log)}"
  [ -f "$log" ] || return 1
  # The cheap test first: this runs in the relaunch loop, and the awk below reads every line.
  tail -n "+$((from + 1))" "$log" 2>/dev/null | grep -qE 'Bundling failed|SyntaxError|Unable to resolve|TransformError' || return 1
  tail -n "+$((from + 1))" "$log" 2>/dev/null | LC_ALL=C awk -v root="${VYSU_PROJECT_DIR:-/nonexistent}/" '
    function take(line,   f) {
      sub(/^[ \t]*(ERROR|error:?)[ \t]+/, "", line)
      f = ""
      if (match(line, /from "[^"]+"/)) {
        f = substr(line, RSTART + 6, RLENGTH - 7); line = substr(line, 1, RSTART - 2)
      } else if (match(line, /\/[^ :"]+\.(tsx|ts|jsx|js|mjs|cjs|json)(: |$)/)) {
        f = substr(line, RSTART, RLENGTH); sub(/: $/, "", f)
        line = substr(line, 1, RSTART - 1) substr(line, RSTART + length(f) + 2)
      }
      if (index(f, root) == 1) f = substr(f, length(root) + 1)
      if (length(line) > 160) line = substr(line, 1, 157) "..."
      msg = line; file = f; ok = 0
    }
    { gsub(/\033\[[0-9;]*m/, "") }
    / Bundled [0-9]+ms / { if (msg != "") ok = 1; next }
    /Bundling failed/ { want = 1; next }
    want && NF { take($0); want = 0; next }
    /SyntaxError:|Unable to resolve|TransformError/ && !/^[ \t]+at / { take($0) }
    END {
      if (msg == "") exit 1
      printf "%s%s%s\n", msg, (file != "" ? " (" file ")" : ""), (ok ? " · bundled fine since" : "")
    }
  '
}

# --- one device's JS, reloaded -----------------------------------------------------------------

# Metro's /reload and `agent-device metro reload` broadcast to every app on that Metro: with three
# devices on one bundler, one agent's reload reloads the other two sessions' screens. React Native
# DevTools reloads a single page through the inspector proxy (`Page.reload`), and every app
# registers one page per device there: the iOS simulator under its own name, an Android emulator as
# « <model> - <release> - API <sdk> ». Two emulators with the same image read the same, and then the
# page is ambiguous: the caller falls back to a relaunch rather than guess.
metro_page_name() { # platform
  if [ "$1" = ios ]; then printf '%s' "$IOS_DEVICE"; return; fi
  # shellcheck disable=SC2016  # expanded by the device's shell, in one round trip
  adb shell 'echo "$(getprop ro.product.model) - $(getprop ro.build.version.release) - API $(getprop ro.build.version.sdk)"' 2>/dev/null | tr -d '\r'
}
metro_page_ws() { # platform port → the inspector websocket of this device's page, or nothing
  local name; name="$(metro_page_name "$1")"
  [ -n "$name" ] || return 0
  curl -s -m 5 "http://127.0.0.1:$2/json/list" 2>/dev/null | python3 -c '
import json, sys
try:
    pages = json.load(sys.stdin)
except ValueError:
    sys.exit(0)
hits = [p for p in pages if p.get("appId") == sys.argv[1] and p.get("deviceName") == sys.argv[2]]
if len(hits) == 1 and hits[0].get("webSocketDebuggerUrl"):
    print(hits[0]["webSocketDebuggerUrl"].replace("ws://localhost:", "ws://127.0.0.1:", 1))
' "$(cfg MOBILE_BUNDLE)" "$name" 2>/dev/null || true
}
# The proxy only takes a debugger whose Origin is its own (http://127.0.0.1:<port>), which a browser
# sends and a script has to. Node's WebSocket (Node >= 22, the one agent-device already runs on) is
# the client; nothing it receives is printed (the page streams network events, bearer tokens
# included).
metro_page_reload() { # ws url → 0 when the page acknowledged the reload
  node -e '
const u = process.argv[1];
if (typeof WebSocket === "undefined") process.exit(3);
let ws;
try { ws = new WebSocket(u, { headers: { Origin: "http://127.0.0.1:" + new URL(u).port } }); } catch (e) { process.exit(3); }
const t = setTimeout(() => process.exit(2), 5000);
ws.onopen = () => ws.send(JSON.stringify({ id: 1, method: "Page.reload", params: {} }));
ws.onmessage = (m) => {
  let d; try { d = JSON.parse(m.data); } catch (e) { return; }
  if (d.id === 1) { clearTimeout(t); process.exit(d.error ? 1 : 0); }
};
ws.onerror = () => process.exit(1);
' "$1" >/dev/null 2>&1
}

# `vysu mreload <platform>`: the JS of this device, reloaded in place: no process kill, no launcher,
# no other device touched. The app's native state (text size, appearance, language) is what it was;
# anything that only a launch applies wants `vysu mrelaunch`.
vysu_mreload() {
  local platform="${1:-}"
  case "$platform" in ios|android) ;; *) die "usage: vysu mreload ios|android";; esac
  shift
  [ $# -eq 0 ] || die "vysu mreload: unknown option $1"
  need_cfg MOBILE_BUNDLE "the app id on both platforms" >/dev/null
  if [ "$(mobile_kind)" != expo ]; then
    echo "$platform: a native app has no JS to reload on its own, relaunching instead"
    vysu_mrelaunch "$platform"; return
  fi
  [ "$platform" != android ] || android_select
  [ "$platform" != ios ] || ios_lock
  metro_need "vysu mreload" "$platform"
  local port log from start ws
  port="$(metro_port)"; log="$(metro_log "$port")"; start="$(date +%s)"
  from="$(metro_lines "$log")"
  ws="$(metro_page_ws "$platform" "$port")"
  if [ -z "$ws" ] || ! metro_page_reload "$ws"; then
    # No page of its own (the app is on the launcher, crashed, or shares its name with another
    # emulator), or the proxy refused: a relaunch is the one reload that is surely this device's.
    echo "$platform: no inspector page of its own on :$port, relaunching instead"
    vysu_mrelaunch "$platform"; return
  fi
  mobile_wait_bundled "$platform" "$log" "$from" 60 "vysu mreload"
  local note=""; mobile_wait_ready "$platform" 30 || note=", ready text not seen (vysu $platform snapshot -i)"
  echo "$platform: reloaded in $(( $(date +%s) - start ))s$note"
}
