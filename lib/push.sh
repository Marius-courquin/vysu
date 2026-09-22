# push.sh — the push drivers: which ones the project enabled (VYSU_PUSH), the presets it keeps in
# `.vysu/push/<preset>.json` with their `{{field}}` placeholders, and the one command that sends
# one — `vysu push ios <preset>` on the simulator, `vysu push <persona> <preset>` for real.
# shellcheck shell=bash

push_load() { # driver name
  local file="$VYSU_ENGINE/connectors/push/$1.sh"
  [ -f "$file" ] || die "no push driver « $1 » ($file)"
  # shellcheck disable=SC1090  # the driver the project enabled, resolved at runtime
  . "$file"
}
push_enabled() { # driver → is it in VYSU_PUSH
  local d IFS=,
  for d in $(cfg PUSH); do [ "$d" != "$1" ] || return 0; done
  return 1
}
push_describe_line() { # for doctor
  local drivers; drivers="$(cfg PUSH)"
  [ -n "$drivers" ] || { echo "push: (none — VYSU_PUSH is not set)"; return; }
  local d IFS=,
  for d in $drivers; do
    ( push_load "$d"; echo "push: $d — $(push_describe)" )
  done
}
# A preset is a file the project owns; the engine ships none. `{{field}}` placeholders are filled
# from --field first, then from the persona's own variables, so a preset can carry an entity id
# without the caller repeating it.
push_payload() { # preset "k=v" …
  local preset="$1"; shift
  need_project
  local file="$VYSU_PROJECT_DIR/.vysu/push/$preset.json"
  [ -f "$file" ] || die "no push preset « $preset » ($file)"
  PUSH_FILE="$file" python3 - "$@" <<'PY'
import os, re, sys

text = open(os.environ["PUSH_FILE"]).read()
fields = dict(a.split("=", 1) for a in sys.argv[1:] if "=" in a)
missing = []


def fill(m):
    key = m.group(1).strip()
    if key in fields:
        return fields[key]
    missing.append(key)
    return m.group(0)


out = re.sub(r"{{\s*([A-Za-z0-9_.-]+)\s*}}", fill, text)
if missing:
    sys.exit("vysu push: no value for %s (--field %s=…)" % (", ".join(sorted(set(missing))), sorted(set(missing))[0]))
sys.stdout.write(out)
PY
}

vysu_push() {
  local target="${1:-}" preset="${2:-}"
  [ -n "$target" ] && [ -n "$preset" ] || die "usage: vysu push ios <preset> | vysu push <persona> <preset> [--platform ios|android] [--field k=v]…"
  shift 2
  local platform="" fields=()
  while [ $# -gt 0 ]; do
    case "$1" in
      --platform) platform="$2"; shift 2;;
      --field) fields+=("$2"); shift 2;;
      *) die "vysu push: unknown option $1";;
    esac
  done
  need_project
  if [ "$target" = ios ]; then
    # The simulator has no push service: the payload is handed to it directly.
    push_enabled apns-sim || die "vysu push ios: the driver « apns-sim » is not in VYSU_PUSH"
    push_load apns-sim
    push_send ios "$preset" ${fields[@]+"${fields[@]}"}
    return
  fi
  # A real send goes through the first enabled driver that can reach a device.
  local d IFS=,
  for d in $(cfg PUSH); do
    case "$d" in
      fcm|webhook)
        push_load "$d"
        unset IFS
        push_send "$target" "$preset" ${platform:+--platform "$platform"} ${fields[@]+"${fields[@]}"}
        return;;
    esac
  done
  die "vysu push: no real-send driver in VYSU_PUSH (fcm or webhook)"
}
