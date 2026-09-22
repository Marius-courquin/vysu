# flow.sh — scripted walks and recordings, web and mobile: `flow` / `mflow` replay a file of steps
# and end on a contact sheet, `rec` / `mrec` record the screen while those steps run and read the
# clip back as text (motion report) and as data (events.json, which `vysu cut` turns into a montage).
# shellcheck shell=bash
# shellcheck disable=SC2034  # EV_* and REC_* are read by core.sh (ev_log, rec_stop)
# shellcheck disable=SC2153  # SHOTS, TAKE, MOTION and the rest are set in core.sh

# A scripted walk of the web: the steps of a file (or stdin), one per line, then the contact sheet
# of the shots taken along the way. Flows are data, not behaviour: the same runner walks any app.
vysu_flow() {
  local persona="${1:-}" file="${2:-}"; [ -n "$persona" ] && [ -n "$file" ] || die "usage: vysu flow <persona> <file|-> [--shots <name>] [--viewport WxH]"
  shift 2
  local shots="" viewport=""
  while [ $# -gt 0 ]; do
    case "$1" in
      --shots) shots="$2"; shift 2;;
      --viewport) viewport="$2"; shift 2;;
      *) die "vysu flow: unknown option $1";;
    esac
  done
  [ "$file" = - ] || [ -f "$file" ] || die "no flow file $file"
  lock_take "$(resource_of "$persona")"   # up front: the `ab` calls below drop the « waiting » line
  # This flow answers for itself: what the session collected before it is not its business.
  ab "$persona" errors --clear >/dev/null 2>&1 || true
  ab "$persona" network requests --clear >/dev/null 2>&1 || true
  web_lang_init "$persona"
  [ -z "$viewport" ] || ab "$persona" set viewport "${viewport%x*}" "${viewport#*x}" >/dev/null
  local n=0 line
  while IFS= read -r line || [ -n "$line" ]; do
    n=$((n + 1))
    echo "▸ $line"
    web_step "$persona" "$shots" "$line" </dev/null || die "vysu flow: step $n failed: $line"
  done < <(read_lines "$file")
  { [ -n "$shots" ] && [ -d "$SHOTS/$shots" ]; } || return 0
  web_meta "$SHOTS/$shots" "$persona" "viewport=${viewport:-}"
  [ -z "$(ls "$SHOTS/$shots" 2>/dev/null)" ] || vysu_sheet "$shots"
}

# The twin on mobile: the steps of a file (or stdin), one per line, then the contact sheet.
vysu_mflow() {
  local platform="${1:-}" file="${2:-}"; [ -n "$platform" ] && [ -n "$file" ] || die "usage: vysu mflow ios|android <file|-> [--shots <name>]"
  shift 2
  local shots=""
  while [ $# -gt 0 ]; do
    case "$1" in
      --shots) shots="$2"; shift 2;;
      *) die "vysu mflow: unknown option $1";;
    esac
  done
  [ "$file" = - ] || [ -f "$file" ] || die "no flow file $file"
  local n=0 line
  while IFS= read -r line || [ -n "$line" ]; do
    n=$((n + 1))
    echo "▸ $line"
    mobile_step "$platform" "$shots" "$line" </dev/null || die "vysu mflow: step $n failed: $line"
  done < <(read_lines "$file")
  [ -z "$shots" ] || [ -z "$(ls "$SHOTS/$shots" 2>/dev/null)" ] || vysu_sheet "$shots"
}

# Record the page while the steps run, then read the clip back as text. The motion report names the
# frames that move and the rows that flash for three frames only; agent-browser's contact sheet
# holds the distinct states the page went through; `frames/` keeps the frames the report names.
# What no screenshot catches — a transition, a scroll, a handoff — lives here.
vysu_rec() {
  local persona="${1:-}" name="${2:-}"; [ -n "$persona" ] && [ -n "$name" ] || die "usage: vysu rec <persona> <name> [--fps 30] [--viewport 1440x900] [--mp4] [--cursor] [--flow <file>] -- \"<step>\" …"
  shift 2
  local fps=30 viewport="1440x900" ext=webm cursor="" flow=""
  while [ $# -gt 0 ]; do
    case "$1" in
      --fps) fps="$2"; shift 2;;
      --viewport) viewport="$2"; shift 2;;
      # Kept for the flows that still pass it: the take is normalized to web.mp4 either way.
      --mp4) ext=mp4; shift;;
      --cursor) cursor="--cursor"; shift;;
      --flow) flow="$2"; shift 2;;
      --) shift; break;;
      *) die "vysu rec: unknown option $1 (steps go after --)";;
    esac
  done
  local steps=() line
  if [ -n "$flow" ]; then
    [ "$flow" = - ] || [ -f "$flow" ] || die "no flow file $flow"
    while IFS= read -r line || [ -n "$line" ]; do steps+=("$line"); done < <(read_lines "$flow")
  else
    steps=("$@")
  fi
  [ ${#steps[@]} -gt 0 ] || die "vysu rec: no step after -- (e.g. \"go $(cfg ORIGIN)/\" \"sleep 1\"), or --flow <file>"
  command -v ffmpeg >/dev/null || die "ffmpeg missing (brew install ffmpeg)"
  [ -f "$MOTION" ] || die "motion.py missing ($MOTION)"
  local dir="$SHOTS/$name"; mkdir -p "$dir"; rm -rf "$dir/frames"
  local video="$dir/web.$ext"
  lock_take "$(resource_of "$persona")"
  web_lang_init "$persona"
  ab "$persona" set viewport "${viewport%x*}" "${viewport#*x}" >/dev/null
  # Capture starts on the page already open — no cold hydration in the first frames — so a recording
  # that wants a fresh page opens it itself, as its first step.
  ab "$persona" record start "$video" --fps "$fps" ${cursor:+"$cursor"} --contact-sheet >/dev/null
  EV_ROWS="$dir/events.jsonl"; : >"$EV_ROWS"; EV_I=0
  local step t0 t1 ok
  for step in "${steps[@]}"; do
    echo "▸ $step"
    EV_TARGET=""; EV_LABEL=""; ok=true
    t0="$(now)"
    # A failed step must not leave ffmpeg recording for good: the clip is stopped either way.
    web_step "$persona" "$name" "$step" || { ok=false; echo "vysu rec: step failed: $step" >&2; }
    t1="$(now)"
    ev_log "$step" "$t0" "$t1" "$ok"
  done
  # `record stop` fails on its own now and then — a contact-sheet analyzer falling behind a heavy
  # page drops the whole take — so what it said is worth more than a bare non-zero exit.
  # Anchored on the moment the last frame is asked for: `record stop` costs a node start-up before
  # agent-browser even hears it, and the take is anchored on its end (see take.py).
  local t_stop; t_stop="$(now)"
  local stopped rc=0; stopped="$(ab "$persona" record stop 2>&1)" || rc=$?
  [ -s "$video" ] || die "vysu rec: no video written — $(printf '%s' "$stopped" | tail -1)"
  [ "$rc" = 0 ] || printf '%s\n' "$stopped" | sed 's/^/vysu rec: /' >&2
  local clip="$dir/web.mp4"
  clip_normalize "$clip" "$video" "$fps"
  echo "$clip"
  # agent-browser writes the contact sheet next to the video, under the same stem.
  [ ! -f "$dir/web.contact-sheet.png" ] || echo "$dir/web.contact-sheet.png"
  python3 "$TAKE" events --dir "$dir" --rows "$EV_ROWS" --clip web.mp4 \
    --kind web --platform web --t-stop "$t_stop" --viewport "$viewport"
  rm -f "$EV_ROWS"; EV_ROWS=""
  web_meta "$dir" "$persona" "viewport=$viewport" "fps=$fps" events=true clip=web.mp4
  python3 "$MOTION" "$clip" --fps "$fps" --scale 1 --dump "$dir/frames" | tee "$dir/motion.txt"
}

# Record the screen while steps run, then read the video back as text: which frames move, and
# which rows flash for a few frames only — a hairline at a seam, a control that blinks — the things
# no screenshot catches (a 60 fps read finds a 3-frame line; agent-device's captures never will).
# The frames are streamed out of ffmpeg, not written: only the ones the report names land in
# `<name>/frames/` (`--crop x,y,w,h` in points narrows the scan).
vysu_mrec() {
  local platform="${1:-}" name="${2:-}"; [ -n "$platform" ] && [ -n "$name" ] || die "usage: vysu mrec ios|android <name> [--fps 60] [--crop x,y,w,h] -- \"<step>\" …"
  shift 2
  local fps=60 crop=""
  while [ $# -gt 0 ]; do
    case "$1" in
      --fps) fps="$2"; shift 2;;
      --crop) crop="$2"; shift 2;;
      --) shift; break;;
      *) die "vysu mrec: unknown option $1 (steps go after --)";;
    esac
  done
  [ $# -gt 0 ] || die "vysu mrec: no step after -- (e.g. \"press 173 822\" \"sleep 1.5\")"
  [ "$platform" != android ] || android_select
  command -v ffmpeg >/dev/null || die "ffmpeg missing (brew install ffmpeg)"
  [ -f "$MOTION" ] || die "motion.py missing ($MOTION)"
  local dir="$SHOTS/$name"; mkdir -p "$dir"; rm -rf "$dir/frames"
  local video="$dir/$platform.mp4" scale; scale="$(mobile_scale "$platform")"
  if [ "$platform" = android ]; then
    adb shell screenrecord --bit-rate 8000000 --time-limit 180 /sdcard/vysu-rec.mp4 >/dev/null 2>&1 & REC_PID=$!
  else
    xcrun simctl io "$(ios_udid)" recordVideo --codec h264 --force "$video" >"$LOGS/mrec.log" 2>&1 & REC_PID=$!
  fi
  REC_PLATFORM="$platform"
  sleep 3
  EV_ROWS="$dir/events.jsonl"; : >"$EV_ROWS"; EV_I=0
  local step t0 t1 ok
  for step in "$@"; do
    echo "▸ $step"
    EV_TARGET=""; EV_LABEL=""; ok=true
    t0="$(now)"
    # A step that fails — a label that is not on screen — is worth saying, not worth losing the take
    # for: the rest is played, and the clip is read back as usual.
    mobile_step "$platform" "$name" "$step" || { ok=false; echo "vysu mrec: step failed: $step" >&2; }
    t1="$(now)"
    ev_log "$step" "$t0" "$t1" "$ok"
  done
  sleep 1
  # The instant the last frame is asked for, not the one the recorder finishes writing: simctl and
  # screenrecord take a few hundred ms to close the file, and the take is anchored on its end.
  local t_stop; t_stop="$(now)"
  rec_stop
  if [ "$platform" = android ]; then
    sleep 2   # screenrecord closes the file after its SIGINT; pulling it earlier gets a truncated one
    adb pull /sdcard/vysu-rec.mp4 "$video" >/dev/null && adb shell rm /sdcard/vysu-rec.mp4 >/dev/null 2>&1
  fi
  [ -s "$video" ] || die "vysu mrec: no video written (see $LOGS/mrec.log)"
  local args=(--fps "$fps" --scale "$scale" --dump "$dir/frames")
  if [ -n "$crop" ]; then
    # Points → pixels, and motion.py takes ffmpeg's order: w:h:x:y.
    args+=(--crop "$(python3 -c "import sys; x,y,w,h=map(float, sys.argv[1].split(',')); s=float(sys.argv[2]); print('%d:%d:%d:%d' % (w*s, h*s, x*s, y*s))" "$crop" "$scale")")
  fi
  echo "$video"
  # The motion report reads the RAW take, at its own --fps: the recorder stamps each frame at the
  # instant the screen changed, which is what finds a three-frame hairline. The clip is normalized
  # only afterwards, to the rate the montage renders at, and that is what events.json describes.
  python3 "$MOTION" "$video" "${args[@]}" | tee "$dir/motion.txt"
  clip_normalize "$video" "$video" "$CLIP_FPS"
  python3 "$TAKE" events --dir "$dir" --rows "$EV_ROWS" --clip "$platform.mp4" \
    --kind mobile --platform "$platform" --t-stop "$t_stop" --scale "$scale"
  rm -f "$EV_ROWS"; EV_ROWS=""
  local dev="$ANDROID_AVD"; [ "$platform" = android ] || dev="$IOS_DEVICE"
  meta_write "$dir" kind=mobile platform="$platform" device="$dev" events=true "clip=$platform.mp4" \
    "lang=$(mstate_get "$platform" lang "$(cfg LANG)")" "textsize=$(mstate_get "$platform" textsize normal)" \
    "mobile_sha=$(repo_sha "${MOBILE_DIR:-$VYSU_PROJECT_DIR}")"
}
