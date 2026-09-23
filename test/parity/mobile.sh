#!/usr/bin/env bash
# Parity of the mobile lot on a real device: the bash engine (legacy/vysu) and the TypeScript one
# (bin/vysu) run the same command on the same simulator / emulator, one after the other, their stdout,
# stderr and exit codes compared once the scratch paths and the timings are normalised. Captures go to
# mirrored scratch shots folders, never to the project's own.
#
#   cd <a project with .vysu/config>
#   VYSU_OWNER=<you> test/parity/mobile.sh <scratch dir> <case file>
#
# The case file holds one command per line, as it is typed after `vysu` (shell quoting), `#` for a
# comment. A line starting with `!` is run once, by the TS engine only, to put the device back between
# cases (`! mrelaunch ios`). The device must be claimed by $VYSU_OWNER first (`vysu claim ios --any`),
# and released after: this script takes nothing and leaves nothing behind but the scratch dir.
# PARITY_FIRST=ts runs the TypeScript engine first: a command that changes the device (a permission,
# the network) is then read from the same starting state by the engine that ran second before.
set -uo pipefail

ENGINE="$(cd "$(dirname "$0")/../.." && pwd)"
W="${1:?usage: test/parity/mobile.sh <scratch dir> <case file>}"
CASES="${2:?usage: test/parity/mobile.sh <scratch dir> <case file>}"
[ -n "${VYSU_OWNER:-}" ] || { echo "set VYSU_OWNER to the owner holding the device" >&2; exit 2; }
mkdir -p "$W"
W="$(cd "$W" && pwd -P)/run-$$"
mkdir -p "$W/legacy/shots" "$W/ts/shots"
FAILED=0 PASSED=0 N=0

# What moves from one run to the next and says nothing about the engine: durations, line numbers of a
# log that grew in between, the minute a claim ends, the scratch folders, the pids and ports of a
# lock, and agent-device's own settle counts.
norm() { # file side
  sed -E \
    -e "s#$W/$2/shots#<SHOTS>#g" -e "s#$W#<W>#g" \
    -e 's/(after|in|within|for) [0-9]+(\.[0-9]+)?s/\1 Ns/g' \
    -e 's/at line [0-9]+/at line N/g' \
    -e 's/[0-2][0-9]:[0-5][0-9]/HH:MM/g' \
    -e 's/\([0-9]+ min left\)/(N min left)/g' \
    -e 's/mdo-(ios|android)-[0-9]{8}-[0-9]{6}/mdo-\1-STAMP/g' \
    "$1"
}

while IFS= read -r line || [ -n "$line" ]; do
  case "$line" in ''|\#*) continue;; esac
  if [ "${line#!}" != "$line" ]; then
    eval "set -- ${line#!}"
    "$ENGINE/bin/vysu" "$@" >/dev/null 2>&1 </dev/null || true
    continue
  fi
  N=$((N + 1))
  eval "set -- $line"
  order="legacy ts"; [ "${PARITY_FIRST:-legacy}" = ts ] && order="ts legacy"
  for side in $order; do
    bin=("$ENGINE/bin/vysu")
    [ "$side" = legacy ] && bin=(bash "$ENGINE/legacy/vysu")
    t0=$(date +%s)
    VYSU_SHOTS="$W/$side/shots" "${bin[@]}" "$@" >"$W/$side/$N.out" 2>"$W/$side/$N.err" </dev/null
    echo "exit $?" >>"$W/$side/$N.out"
    echo "$(( $(date +%s) - t0 ))" >"$W/$side/$N.time"
  done
  ok=1
  diff <(norm "$W/legacy/$N.out" legacy) <(norm "$W/ts/$N.out" ts) >"$W/$N.diff" || ok=0
  diff <(norm "$W/legacy/$N.err" legacy) <(norm "$W/ts/$N.err" ts) >>"$W/$N.diff" || ok=0
  if [ "$ok" = 1 ]; then
    PASSED=$((PASSED + 1))
    printf 'same  %-60s bash %ss · ts %ss\n' "$line" "$(cat "$W/legacy/$N.time")" "$(cat "$W/ts/$N.time")"
  else
    FAILED=$((FAILED + 1))
    printf 'DIFF  %-60s (%s)\n' "$line" "$W/$N.diff"
    sed 's/^/      /' "$W/$N.diff" | head -20
  fi
done <"$CASES"

echo "parity: $PASSED same, $FAILED different ($W)"
[ "$FAILED" = 0 ]
