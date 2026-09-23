#!/usr/bin/env bash
# Every image parity script, one after the other, against the reference's Python helpers
# (VYSU_REF, test/parity/README.md): VYSU_REF=<bash vysu> test/parity/img.sh <inputs> <scratch>
# (inputs built by test/parity/img-inputs.sh). Exit 1 when any of them found a difference.
set -uo pipefail
cd "$(dirname "$0")/../.."
. test/parity/ref.sh
rc=0
for t in diff verdict screencap compare stitch fields burst motion take screen frame; do
  node "test/parity/$t.ts" "$1" "$2" | grep -v '^  ' | tail -3 || rc=1
  [ "${PIPESTATUS[0]}" = 0 ] || rc=1
done
exit "$rc"
