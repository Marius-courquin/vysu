#!/usr/bin/env bash
# Parity of the platform lot: the bash engine (legacy/vysu) and the TypeScript one (bin/vysu) on the
# same inputs, side by side in mirrored scratch folders, their stdout, stderr, exit codes and the
# files they write compared after the scratch paths are normalised.
#
#   test/parity/platform.sh <scratch dir> [--take <shots folder of a recorded take>] [--video]
#
# Nothing here touches a device, installs a tool or writes outside the scratch dir, except `setup
# --dry-run`, which creates the state folder of the scratch project as the bash one does. The known
# differences are listed in KNOWN below and filtered out: each is a deliberate change of the port.
set -uo pipefail

ENGINE="$(cd "$(dirname "$0")/../.." && pwd)"
W="${1:?usage: test/parity/platform.sh <scratch dir> [--take <dir>] [--video]}"
shift
TAKE="" VIDEO=0
while [ $# -gt 0 ]; do
  case "$1" in
    --take) TAKE="$2"; shift 2;;
    --video) VIDEO=1; shift;;
    *) echo "unknown option $1" >&2; exit 2;;
  esac
done
mkdir -p "$W"
W="$(cd "$W" && pwd -P)/run-$$"
mkdir -p "$W"
FAILED=0 PASSED=0

# Lines that differ on purpose (a check the bash engine did not have), and the job-control notice
# bash prints for a service killed by `down`: dropped from both sides.
KNOWN='^✓ engine: dependencies installed|^✓ node: v|^ready: [0-9]+ · |Terminated: 15 +env '
# The doctor lines the web and mobile code print through their contracts: compared by those lots once
# their code lands, set aside here while they are placeholders (one « not available yet » line each).
CONTRACT='^(auth|push|ios device|android avd|emulators|state [^:]*|avds|session|devices|sessions):'

norm() { # file side
  # Live locks and claims of other sessions age between the two runs.
  sed -E -e "s#$W/$2#<W>#g" -e "s#$W#<W>#g" -e 's/ for [0-9]+s$/ for Ns/' -e 's/\([0-9-]+ min left\)/(N min left)/' "$1" | grep -Ev "$KNOWN" | { if [ -n "${FILTER:-}" ]; then grep -Ev "$FILTER"; else cat; fi; } || true
}

# case name — runs "$@" in $W/<side>/<name>/proj for side in legacy and ts, compares.
# SETUP (a snippet run with $P set to the project dir) and INPUT (stdin) are read from the env.
case_() {
  local name="$1"; shift
  local side P
  for side in legacy ts; do
    P="$W/$side/$name/proj"
    mkdir -p "$P"
    [ -z "${SETUP:-}" ] || (cd "$P" && eval "$SETUP")
    local bin=("$ENGINE/bin/vysu")
    [ "$side" = legacy ] && bin=(bash "$ENGINE/legacy/vysu")
    (
      cd "$P"
      if [ -n "${INPUT:-}" ]; then printf '%b' "$INPUT" | "${bin[@]}" "$@"; else "${bin[@]}" "$@" </dev/null; fi
    ) >"$W/$side/$name/out" 2>"$W/$side/$name/err"
    echo "exit $?" >>"$W/$side/$name/out"
    [ -z "${AFTER:-}" ] || (cd "$P" && eval "$AFTER")
  done
  local ok=1
  diff <(norm "$W/legacy/$name/out" legacy) <(norm "$W/ts/$name/out" ts) >"$W/$name.diff" || ok=0
  diff <(norm "$W/legacy/$name/err" legacy) <(norm "$W/ts/$name/err" ts) >>"$W/$name.diff" || ok=0
  if [ "${TREE:-1}" = 1 ]; then
    diff -r "$W/legacy/$name/proj" "$W/ts/$name/proj" >>"$W/$name.diff" 2>&1 || ok=0
  fi
  if [ "$ok" = 1 ]; then PASSED=$((PASSED + 1)); echo "same     $name"
  else FAILED=$((FAILED + 1)); echo "DIFFERS  $name ($W/$name.diff)"; sed 's/^/    /' "$W/$name.diff" | head -20; fi
}

free_port() { node -e 'const s=require("net").createServer().listen(0,()=>{console.log(s.address().port);s.close()})'; }

# --- version, checker ------------------------------------------------------------------------------
case_ version version
case_ checker checker
case_ checker-for checker --for codex
SETUP="mkdir -p .vysu && echo \"VYSU_CHECKER_MODELS='claude=sonnet, codex = luna'\" > .vysu/config" case_ checker-models checker
SETUP="mkdir -p .vysu && echo \"VYSU_CHECKER_MODELS='claude=sonnet, codex = luna'\" > .vysu/config" case_ checker-models-codex checker --for codex

# --- doctor ------------------------------------------------------------------------------------------
FILTER="$CONTRACT" TREE=0 case_ doctor-none doctor
FILTER="$CONTRACT" TREE=0 SETUP='mkdir -p .vysu .claude/skills/visual-check && printf "VYSU_PROJECT=dr\nVYSU_STATE=$W/state/dr\nVYSU_BROWSER_PATH=/bin/sh\nVYSU_MIN_VERSION=99.0.0\nVYSU_LOCALES=nope\nVYSU_CHECKER_MODELS=claude=haiku\n" > .vysu/config && printf -- "---\nname: x\n---\n\n<!-- vysu-skill 0.1.0 -->\n" > .claude/skills/visual-check/SKILL.md' case_ doctor-project doctor
FILTER="$CONTRACT" TREE=0 case_ doctor-bogus doctor --bogus
if [ -d "$HOME/Documents/Projects/Nidz/nidz-env/.vysu" ]; then
  FILTER="$CONTRACT" TREE=0 VYSU_PROJECT_DIR="$HOME/Documents/Projects/Nidz/nidz-env" case_ doctor-nidz doctor
fi

# --- setup: reporting only, never an install -------------------------------------------------------
VYSU_STATE="$W/state/setup" TREE=0 case_ setup setup --dry-run
VYSU_STATE="$W/state/setup" TREE=0 case_ setup-notty setup
VYSU_STATE="$W/state/setup" TREE=0 case_ setup-opts setup --dry-run --browser default --ios-device 'iPhone 16' --ios-old-device 'Old SE' --android-avds 'a_b:34:pixel_7:hw.x=1;c:30:pixel_4a'
VYSU_STATE="$W/state/setup" TREE=0 case_ setup-bad-browser setup --dry-run --browser /nonexistent/browser
TREE=0 case_ setup-bogus setup --bogus
# On a terminal: the device questions, answered through expect.
if command -v expect >/dev/null; then
  for side in legacy ts; do
    mkdir -p "$W/$side/setup-tty"
    if [ "$side" = legacy ]; then VYSU=(bash "$ENGINE/legacy/vysu"); else VYSU=("$ENGINE/bin/vysu"); fi
    (cd "$W/$side/setup-tty" && VYSU_STATE="$W/state/setup" expect "$ENGINE/test/parity/setup-tty.exp" "${VYSU[@]}" | tr -d '\r') >"$W/$side/setup-tty/out" 2>&1
  done
  if diff <(norm "$W/legacy/setup-tty/out" legacy) <(norm "$W/ts/setup-tty/out" ts) >"$W/setup-tty.diff"; then
    PASSED=$((PASSED + 1)); echo "same     setup-tty"
  else FAILED=$((FAILED + 1)); echo "DIFFERS  setup-tty ($W/setup-tty.diff)"; sed 's/^/    /' "$W/setup-tty.diff" | head -20; fi
fi

# --- init --------------------------------------------------------------------------------------------
SETUP='mkdir -p .claude' case_ init-yes init --yes
INPUT='myapp\nhttp://localhost:5173\n/auth\nhttps://main.example.com\nform\nexpo\ncom.x.app\nMy App\napps/mob\napns-sim,webhook,fcm\nhttps://hook.example.com\n' case_ init-expo init
INPUT='n2\n\n\n\nauth0\nnative\ncom.n.app\nN App\nbuild/N.app\n\n\n' case_ init-native init
INPUT='only\n' case_ init-short init
SETUP='mkdir -p .claude' VYSU_CHECKER_MODELS='claude = opus, codex=luna' case_ init-dirs init --yes --skills-dir sk --agents-dir ag
SETUP='mkdir -p .vysu && echo VYSU_PROJECT=x > .vysu/config' case_ init-exists init --yes
SETUP='mkdir -p .claude/agents && echo old > .claude/agents/visual-checker.md' case_ init-refresh init --refresh-skills
case_ init-refresh-none init --refresh-skills
case_ init-refresh-dirs init --refresh-skills --skills-dir s2 --agents-dir a2
case_ init-bogus init --bogus

# --- up / down: harmless node servers on free ports ------------------------------------------------
P1="$(free_port)" P2="$(free_port)" P3="$(free_port)"
services_config() {
  mkdir -p .vysu
  cat > .vysu/config <<'EOF'
VYSU_PROJECT='svc'
VYSU_STATE='@STATE@'
VYSU_SERVICES='hello tcp flag'
VYSU_API_HOSTS='api.example.com=staging localhost:8080=local'
VYSU_SERVICE_hello_CMD='node -e "require(\"http\").createServer((q,s)=>s.end(\"ok\")).listen(+process.env.PORT)"'
VYSU_SERVICE_hello_PORT=@P1@
VYSU_SERVICE_hello_HEALTH='http://localhost:@P1@/'
VYSU_SERVICE_hello_ENV='PORT=@P1@'
VYSU_SERVICE_tcp_CMD='node -e "require(\"net\").createServer().listen(@P2@)"'
VYSU_SERVICE_tcp_PORT=@P2@
VYSU_SERVICE_flag_CMD='node -e "const f=require(\"fs\");f.writeFileSync(\"flag.pid\",String(process.pid));setTimeout(()=>f.writeFileSync(\"ready.flag\",\"\"),1200);setTimeout(()=>{},60000)"'
VYSU_SERVICE_flag_HEALTH='test -f ready.flag'
VYSU_SERVICE_flag_STOP='kill $(cat flag.pid) && rm -f ready.flag flag.pid'
VYSU_SERVICE_slow_CMD='node -e "setTimeout(()=>{},4000)"'
VYSU_SERVICE_slow_HEALTH='http://localhost:@P3@/'
VYSU_SERVICE_slow_TIMEOUT=2
EOF
  sed -i.bak -e "s/@P1@/$P1/g" -e "s/@P2@/$P2/g" -e "s/@P3@/$P3/g" -e "s#@STATE@#$(cd .. && pwd -P)/state#" .vysu/config && rm -f .vysu/config.bak
}
services_seq() { # the vysu command, as words
  "$@" up hello --env API_URL=https://api.example.com/v1 --env OTHER=x; echo "[exit $?] web.api=$(cat ../state/web.api 2>/dev/null)"
  "$@" up hello; echo "[exit $?]"
  "$@" up tcp; echo "[exit $?] web.api=$(cat ../state/web.api 2>/dev/null || echo gone)"
  "$@" up flag; echo "[exit $?]"
  "$@" down all; echo "[exit $?]"
  "$@" up all; echo "[exit $?]"
  "$@" down hello; echo "[exit $?]"
  "$@" down tcp; "$@" down flag; echo "[exit $?]"
  "$@" up nosuch; echo "[exit $?]"
  "$@" up hello --bogus; echo "[exit $?]"
  "$@" up; echo "[exit $?]"
  "$@" down; echo "[exit $?]"
  "$@" down nosuch; echo "[exit $?]"
  VYSU_SERVICES=slow "$@" up slow; echo "[exit $?]"
  ls ../state/logs
}
for side in legacy ts; do
  P="$W/$side/services/proj"; mkdir -p "$P"
  if [ "$side" = legacy ]; then VYSU=(bash "$ENGINE/legacy/vysu"); else VYSU=("$ENGINE/bin/vysu"); fi
  (cd "$P" && services_config && services_seq "${VYSU[@]}") >"$W/$side/services/out" 2>"$W/$side/services/err" </dev/null
  echo "exit $?" >>"$W/$side/services/out"
  # The slow service ends on its own; the next side must not find its port taken.
  sleep 3
done
ok=1
diff <(norm "$W/legacy/services/out" legacy) <(norm "$W/ts/services/out" ts) >"$W/services.diff" || ok=0
diff <(norm "$W/legacy/services/err" legacy) <(norm "$W/ts/services/err" ts) >>"$W/services.diff" || ok=0
if [ "$ok" = 1 ]; then PASSED=$((PASSED + 1)); echo "same     services"
else FAILED=$((FAILED + 1)); echo "DIFFERS  services ($W/services.diff)"; sed 's/^/    /' "$W/services.diff" | head -30; fi

# --- cut --draft on a copy of a real take ----------------------------------------------------------
if [ -n "$TAKE" ]; then
  name="$(basename "$TAKE")"
  for side in legacy ts; do
    mkdir -p "$W/$side/shots"
    cp -R "$TAKE" "$W/$side/shots/$name"
    rm -f "$W/$side/shots/$name/cut.json"
  done
  cut_case() {
    local label="$1"; shift
    for side in legacy ts; do
      if [ "$side" = legacy ]; then VYSU=(bash "$ENGINE/legacy/vysu"); else VYSU=("$ENGINE/bin/vysu"); fi
      (cd "$W" && VYSU_SHOTS="$W/$side/shots" VYSU_THEME=parity VYSU_LANG=fr "${VYSU[@]}" "$@") >"$W/$side/$label.out" 2>"$W/$side/$label.err"
      echo "exit $?" >>"$W/$side/$label.out"
    done
    ok=1
    diff <(norm "$W/legacy/$label.out" legacy) <(norm "$W/ts/$label.out" ts) >"$W/$label.diff" || ok=0
    diff <(norm "$W/legacy/$label.err" legacy) <(norm "$W/ts/$label.err" ts) >>"$W/$label.diff" || ok=0
    diff -r "$W/legacy/shots" "$W/ts/shots" >>"$W/$label.diff" 2>&1 || ok=0
    if [ "$ok" = 1 ]; then PASSED=$((PASSED + 1)); echo "same     $label"
    else FAILED=$((FAILED + 1)); echo "DIFFERS  $label ($W/$label.diff)"; sed 's/^/    /' "$W/$label.diff" | head -20; fi
  }
  cut_case cut-draft cut "$name" --draft
  cut_case cut-exists cut "$name" --draft
  cut_case cut-force cut "$name" --draft --force
  cut_case cut-nodraft cut "$name"
  cut_case cut-none cut nosuch --draft
  cut_case cut-usage cut
  cut_case video-nocut video nosuch
  cut_case video-usage video
  if [ "$VIDEO" = 1 ]; then
    cut_case video-check video "$name" --check
  fi
fi

echo "platform parity: $PASSED same, $FAILED different — $W"
[ "$FAILED" = 0 ]
