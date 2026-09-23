#!/usr/bin/env bash
# Parity of a recording between the bash engine of feat/video-camera and this one: the same `vysu rec`
# or `vysu mrec` command, run by each engine in turn into its own scratch shots folder, then compared
# on what does not depend on the screen's own timing:
#   - stdout and stderr, the motion report aside (which frames move is the page's business), with the
#     scratch paths and the numbers of the summary lines normalised;
#   - the exit code;
#   - events.json: its header (version, kind, platform, clip, fps, size) and, per step, i, line, verb,
#     label, ok, target, file and which keys it holds (`at` included) — not the seconds;
#   - meta.json but its date and the sha, and the files the take folder holds.
# A step's duration is printed side by side for the typed ones (fill / type), which is where the two
# engines are meant to keep the same pace.
#
#   cd <a project with .vysu/config>
#   PARITY_RESET="<command putting the screen back>" test/parity/rec-camera.sh <scratch> <bash vysu> <name> -- <rec|mrec args…>
#
# `<name>` is the take's name, given in the args as `@NAME@`. PARITY_RESET runs before each engine.
set -uo pipefail

ENGINE="$(cd "$(dirname "$0")/../.." && pwd)"
W="${1:?usage: rec-camera.sh <scratch> <bash vysu> <name> -- <args…>}"
A="${2:?usage: rec-camera.sh <scratch> <bash vysu> <name> -- <args…>}"
NAME="${3:?usage: rec-camera.sh <scratch> <bash vysu> <name> -- <args…>}"
shift 3
[ "${1:-}" = -- ] && shift
mkdir -p "$W/bash/shots" "$W/ts/shots"
W="$(cd "$W" && pwd -P)"

args=()
for a in "$@"; do args+=("${a//@NAME@/$NAME}"); done

run() { # side command…
  local side="$1"; shift
  [ -z "${PARITY_RESET:-}" ] || bash -c "$PARITY_RESET" >/dev/null 2>&1
  PYTHONDONTWRITEBYTECODE=1 VYSU_SHOTS="$W/$side/shots" "$@" "${args[@]}" >"$W/$side/out" 2>"$W/$side/err"
  echo $? >"$W/$side/code"
}
run bash bash "$A"
run ts "$ENGINE/bin/vysu"

norm() { # file side
  sed -E -e "s#$W/$2/shots#<SHOTS>#g" \
    -e '/^## timeline/,/^$/d' -e '/^## transients/,/^$/d' \
    -e 's/^[0-9]+ frames @ [0-9.]+ fps \([0-9.]+ s\)$/N frames @ F fps (D s)/' \
    -e 's/^dumped [0-9]+ frames/dumped N frames/' \
    -e 's/· [0-9.]+ s @/· D s @/' \
    -e 's/re-anchored on the screen.s own reactions, [-+][0-9.]+ s/re-anchored on the screen’s own reactions, ±N s/' \
    "$1"
}

summary() { # side
  node -e '
    const fs = require("fs");
    const dir = process.argv[1];
    const read = (f) => { try { return JSON.parse(fs.readFileSync(dir + "/" + f, "utf8")); } catch { return null; } };
    const ev = read("events.json");
    const meta = read("meta.json");
    const out = { files: fs.readdirSync(dir).filter((f) => f !== "frames").sort() };
    if (ev) {
      out.events = { version: ev.version, kind: ev.kind, platform: ev.platform, clip: ev.clip, fps: ev.fps, size: ev.size };
      out.steps = ev.steps.map((s) => ({ i: s.i, line: s.line, verb: s.verb, label: s.label, ok: s.ok, target: s.target, file: s.file, keys: Object.keys(s).join(",") }));
    }
    if (meta) { for (const k of ["date", "mobile_sha", "web_sha", "sha"]) delete meta[k]; out.meta = meta; }
    console.log(JSON.stringify(out, null, 1));
  ' "$W/$1/shots/$NAME"
}

FAILED=0
for f in out err; do
  if ! diff <(norm "$W/bash/$f" bash) <(norm "$W/ts/$f" ts) >"$W/$f.diff"; then
    FAILED=1; echo "✗ $f differs:"; sed 's/^/  /' "$W/$f.diff" | head -30
  fi
done
if [ "$(cat "$W/bash/code")" != "$(cat "$W/ts/code")" ]; then FAILED=1; echo "✗ exit $(cat "$W/bash/code") / $(cat "$W/ts/code")"; fi
summary bash >"$W/bash/summary.json"
summary ts >"$W/ts/summary.json"
if ! diff "$W/bash/summary.json" "$W/ts/summary.json" >"$W/summary.diff"; then
  FAILED=1; echo "✗ take differs:"; sed 's/^/  /' "$W/summary.diff" | head -40
fi
node -e '
  const fs = require("fs");
  const [a, b] = process.argv.slice(1).map((d) => { try { return JSON.parse(fs.readFileSync(d + "/events.json", "utf8")).steps; } catch { return []; } });
  for (const s of a) {
    const t = b.find((x) => x.i === s.i);
    if (t && (s.verb === "fill" || /^type /.test(s.line))) console.log(`  pace: ${s.line.slice(0, 50)} · bash ${(s.end - s.start).toFixed(2)} s, ts ${(t.end - t.start).toFixed(2)} s`);
  }
' "$W/bash/shots/$NAME" "$W/ts/shots/$NAME"
if [ "$FAILED" = 0 ]; then echo "✓ $NAME: same output, exit code, events and meta ($(cat "$W/ts/code"))"; else echo "✗ $NAME (see $W)"; fi
exit "$FAILED"
