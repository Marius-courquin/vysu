#!/usr/bin/env bash
# The inputs of the img parity scripts, COPIED from a real state folder (never written into):
#   test/parity/img-inputs.sh [<state, default ~/.nidz/visual>] <inputs>
# shots/   folders with baselines, .prev.png, diff.txt, verdicts   (diff, verdict, compare, fields)
# stitch/  mshot --full walks                                        (stitch)
# raw/     device-pixel Android captures                             (screencap, fields)
# fields/  login screens                                             (fields)
# snap/    agent-device snapshots + their .keys                      (screen)
# rec/     recordings with events.json, motion.txt, frames/          (motion, take)
# takes/   every take's events.json, motion.txt, meta.json           (take draft)
# burst/   raw bursts cut from the recordings, times.tsv             (burst)
# frame/, framevid/  captures of every shape, 2 s clips              (frame)
set -euo pipefail
state="${2:+$1}"; state="${state:-$HOME/.nidz/visual}"; in="${2:-$1}"
shots="$state/shots"
mkdir -p "$in"/{shots,stitch,raw,fields,snap,rec,takes,burst,frame,framevid}
for d in $(cd "$shots" && ls */*-base.png */*.prev.png */diff.txt 2>/dev/null | cut -d/ -f1 | sort -u); do cp -Rp "$shots/$d" "$in/shots/"; done
for d in $(cd "$shots" && ls -d */full-frames 2>/dev/null | cut -d/ -f1); do
  [ "$(ls "$shots/$d/full-frames" | wc -l)" -ge 2 ] || continue
  mkdir -p "$in/stitch/$d"; cp -p "$shots/$d"/full-frames/*.png "$in/stitch/$d/"
done
# A device-pixel capture is one at least 1000 px wide: the width is the PNG header's, bytes 16-19.
first_raw="$(cd "$shots" && ls */android-*.png 2>/dev/null | while read -r f; do node -e 'process.exit(require("fs").readFileSync(process.argv[1]).readUInt32BE(16) >= 1000 ? 0 : 1)' "$shots/$f" && echo "$f"; done | head -12)"  || true  # head closes the pipe early: SIGPIPE under pipefail
for f in $first_raw; do cp -p "$shots/$f" "$in/raw/$(echo "$f" | tr / _)"; done
for f in $(cd "$shots" && ls */*.png | grep -i -E 'login|email|auth' | head -40); do cp -p "$shots/$f" "$in/fields/$(echo "$f" | tr / _)"; done
cp -p "$state"/.snap-*.json "$state"/.snap-*.json.keys "$in/snap/" 2>/dev/null || true
n=0; for d in $(cd "$shots" && ls -d */events.json | cut -d/ -f1); do
  mkdir -p "$in/takes/$d"; for f in events.json motion.txt meta.json; do [ ! -f "$shots/$d/$f" ] || cp -p "$shots/$d/$f" "$in/takes/$d/"; done
  if [ "$n" -lt 4 ] && [ "$(du -k "$shots/$d"/*.mp4 | awk '{s+=$1} END {print s}')" -lt 3000 ]; then cp -Rp "$shots/$d" "$in/rec/"; n=$((n + 1)); fi
done
burst() { # name clip fps seconds
  local d="$in/burst/$1" i=0 f; mkdir -p "$d"; ffmpeg -v error -y -i "$2" -vf "fps=$3" -t "$4" "$d/%03d.png"
  : >"$d/times.tsv"
  for f in $(ls "$d"/*.png | sort); do mv "$f" "$d/$(printf '%03d' "$i").png"; printf '%d\t%s\t%s\n' "$i" "$((1758480000 + i)).000" "$((1758480000 + i)).050" >>"$d/times.tsv"; i=$((i + 1)); done
}
for clip in "$in"/rec/*/*.mp4; do burst "$(basename "$(dirname "$clip")")" "$clip" 6 3; done
for f in $(cd "$shots" && ls */*.png | grep -v -E 'sheet|compare|-changed' | awk 'NR % 97 == 1' | head -14); do cp -p "$shots/$f" "$in/frame/$(echo "$f" | tr / _)"; done
for clip in $(ls "$in"/rec/*/*.mp4 | head -3); do ffmpeg -v error -y -i "$clip" -t 2 -c copy "$in/framevid/$(basename "$(dirname "$clip")").mp4"; done
du -sh "$in"
