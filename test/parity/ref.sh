# Sourced by the parity scripts: the reference engine they compare this one against, a bash vysu
# named by VYSU_REF (test/parity/README.md). ref.ts says the same to the TypeScript ones.
# shellcheck shell=bash
if [ -z "${VYSU_REF:-}" ]; then
  echo 'VYSU_REF is not set: the bash vysu to compare against (git archive v0.5.1 | tar -x -C <dir>, then VYSU_REF=<dir>/bin/vysu)' >&2
  exit 2
fi
[ -x "$VYSU_REF" ] || { echo "VYSU_REF: $VYSU_REF is not an executable vysu" >&2; exit 2; }
REF="$(cd "$(dirname "$VYSU_REF")" && pwd -P)/$(basename "$VYSU_REF")"
REF_DIR="$(cd "$(dirname "$REF")/.." && pwd -P)"
# The reference's helpers named themselves <name>.py; this engine's say <name>.
PY_NAMES='s/(^|[^[:alnum:]_])(burst|compare|diff|fields|frame|mark|motion|screen|screencap|stitch|take|verdict)\.py/\1\2/g'

