# What a project's `.sh` push driver was written against, defined around it: the bash engine sourced
# drivers into itself, and this is the part of it they call — the config through the exported VYSU_*
# values, the personas file, and the TypeScript engine for the preset and for agent-device.
# Run as: bash prelude.sh <driver.sh> describe | send <target> <preset> [--platform p] [k=v]…
# shellcheck shell=bash
set -euo pipefail
VYSU_PID=$$
trap 'exit 1' USR1
die() { local msg="$1"; shift || true; printf 'vysu: %s\n' "$msg" >&2; [ $# -eq 0 ] || printf 'next: %s\n' "$*" >&2; kill -USR1 "$VYSU_PID" 2>/dev/null; exit 1; }
log() { echo "vysu: $*" >&2; }
cfg() { local name="VYSU_$1" value; value="${!name:-}"; printf '%s' "${value:-${2:-}}"; }
need_project() { [ -n "${VYSU_CONFIG_FILE:-}" ] || die "no .vysu/config here (vysu init)"; }
need_cfg() { local v; v="$(cfg "$1")"; [ -n "$v" ] || { need_project; die "VYSU_$1 is not set in $VYSU_CONFIG_FILE ($2)"; }; printf '%s' "$v"; }
load_personas() { [ -f "$PERSONAS" ] || die "no $PERSONAS (vysu persona add <name>)"; set -a; . "$PERSONAS"; set +a; }
persona_var() { local key; key="VYSU_PERSONA_$(echo "$1" | tr '[:lower:]' '[:upper:]')_$2"; printf '%s' "${!key:-}"; }
vysu_ts() { case "${VYSU_RUNTIME:-node}" in bun) bun "$@";; *) node --experimental-strip-types --disable-warning=ExperimentalWarning "$@";; esac; }
push_payload() { vysu_ts "$VYSU_ENGINE/src/push/prim.ts" payload "$@"; }
ad() { vysu_ts "$VYSU_ENGINE/src/cli.ts" "$@"; }
mob() { ad "$@"; }
driver="$1"; shift
. "$driver"
case "$1" in describe) push_describe;; send) shift; push_send "$@";; esac
