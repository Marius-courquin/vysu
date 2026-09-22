# video.sh — a take turned into a film: `cut` proposes the montage script (cut.json) from the
# events and the motion report, `video` hands it to the Remotion toolkit. vysu owns the take, the
# toolkit owns the pixels; the toolkit installs itself on the first render that needs it.
# shellcheck shell=bash

# The montage script of a take, proposed rather than written: the segments come from the steps and
# from motion.txt (dead time dropped), a freeze from every `shot`, an empty chapter per anchor. What
# stays for the agent is the text — kicker, title, body — and nothing in frames or coordinates.
vysu_cut() {
  local name="${1:-}"; [ -n "$name" ] || die "usage: vysu cut <take> --draft [--force]"
  shift
  local draft=0 force=0
  while [ $# -gt 0 ]; do
    case "$1" in
      --draft) draft=1; shift;;
      --force) force=1; shift;;
      *) die "vysu cut: unknown option $1";;
    esac
  done
  local dir="$SHOTS/$name"; [ -d "$dir" ] || die "no shots folder $dir"
  [ "$draft" = 1 ] || die "vysu cut: --draft is the only mode (write the rest of $dir/cut.json by hand)"
  [ -f "$dir/events.json" ] || die "vysu cut: no $dir/events.json — record the take with vysu rec / vysu mrec"
  [ -f "$TAKE" ] || die "take.py missing ($TAKE)"
  local out="$dir/cut.json"
  [ ! -f "$out" ] || [ "$force" = 1 ] || { python3 "$TAKE" draft --dir "$dir" --take "$name"; die "vysu cut: $out already exists (--force to overwrite)"; }
  python3 "$TAKE" draft --dir "$dir" --take "$name" | tee "$out"
}

# The Remotion toolkit, behind one command.
vysu_video() {
  local name="${1:-}"; [ -n "$name" ] || die "usage: vysu video <take> [--format landscape|portrait|all] [--check] [--draft] [--out <dir>]"
  shift
  local dir="$SHOTS/$name"; [ -d "$dir" ] || die "no shots folder $dir"
  [ -f "$dir/cut.json" ] || die "vysu video: no $dir/cut.json — vysu cut $name --draft first"
  [ -f "$REMOTION/scripts/render.ts" ] || die "vysu video: $REMOTION/scripts/render.ts missing (the Remotion toolkit)"
  # Installed on the first render that needs it, once, and it says so: a clone of the engine is a
  # few hundred kB, and nobody pays for Remotion until they ask for a video.
  if [ ! -d "$REMOTION/node_modules" ]; then
    echo "vysu video: installing the Remotion toolkit in $REMOTION (once, a few minutes)…" >&2
    (cd "$REMOTION" && npm ci >/dev/null) || die "vysu video: npm ci failed in $REMOTION"
  fi
  # Node 24 strips the types itself, so the render script runs as it is written. VYSU_PROJECT_DIR
  # is what lets it resolve a theme the project owns before one the engine ships.
  (cd "$REMOTION" && node scripts/render.ts --take "$dir" "$@")
}
