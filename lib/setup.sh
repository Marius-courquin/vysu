# setup.sh — getting there and staying there: `setup` prepares the machine (tools, browser,
# simulators, emulators), `init` writes a project's `.vysu/config` and installs the agent skills,
# `doctor` says what is resolved and what is missing, `update` pulls the engine, `version` names it.
# shellcheck shell=bash
# shellcheck disable=SC2153  # STATE, LOGS, SHOTS, IOS_DEVICE and the helper paths are set in core.sh

vysu_version() {
  local v sha; v="$(cat "$VYSU_ENGINE/VERSION" 2>/dev/null || echo unknown)"
  sha="$(git -C "$VYSU_ENGINE" rev-parse --short HEAD 2>/dev/null || echo unknown)"
  echo "vysu $v ($sha) — $VYSU_ENGINE"
}
# Ordered version comparison without sort -V, which macOS only grew recently.
version_below() { # a b → is a strictly below b
  [ "$1" != "$2" ] || return 1
  local first
  first="$(printf '%s\n%s\n' "$1" "$2" | awk -F. '{ printf "%d.%05d.%05d.%05d %s\n", 0, $1, $2, $3, $0 }' | sort | head -1 | cut -d' ' -f2)"
  [ "$first" = "$1" ]
}
version_warn() {
  local want; want="$(cfg MIN_VERSION)"
  [ -n "$want" ] || return 0
  local have; have="$(cat "$VYSU_ENGINE/VERSION" 2>/dev/null || echo 0.0.0)"
  version_below "$have" "$want" || return 0
  echo "vysu: this project asks for vysu >= $want, this engine is $have (vysu update)" >&2
}
vysu_update() {
  local before; before="$(cat "$VYSU_ENGINE/VERSION" 2>/dev/null || echo unknown)"
  git -C "$VYSU_ENGINE" pull --ff-only || die "update: git pull --ff-only failed in $VYSU_ENGINE"
  local after; after="$(cat "$VYSU_ENGINE/VERSION" 2>/dev/null || echo unknown)"
  if [ "$before" = "$after" ]; then echo "vysu: already at $after"; return; fi
  echo "vysu: $before → $after"
  # The CHANGELOG entries between the two, by their headings: what changed is what is printed.
  [ ! -f "$VYSU_ENGINE/CHANGELOG.md" ] || awk -v from="$before" '
    /^## / { if ($2 == from) exit; show = 1 }
    show { print }' "$VYSU_ENGINE/CHANGELOG.md"
}

# --- setup: the machine ------------------------------------------------------------------------

# The AVD specs, as `name:api:device:extra key=value …` separated by « ; ».
# shellcheck disable=SC2046  # splitting on « ; » is the point: one spec per line
avd_specs() { local IFS=';'; printf '%s\n' $(cfg ANDROID_AVDS); }

vysu_setup() {
  local ios_device="" ios_old="" avds=""
  while [ $# -gt 0 ]; do
    case "$1" in
      --ios-device) ios_device="$2"; shift 2;;
      --ios-old-device) ios_old="$2"; shift 2;;
      --android-avds) avds="$2"; shift 2;;
      *) die "vysu setup: unknown option $1";;
    esac
  done
  mkdir -p "$STATE/shots" "$LOGS" "$HOME/.vysu"
  echo "## tools"
  command -v node >/dev/null || die "node missing (>= 22)"
  echo "node: $(node --version)"
  local tool
  for tool in agent-browser agent-device; do
    if command -v "$tool" >/dev/null; then echo "$tool: $($tool --version 2>/dev/null | head -1)"
    else echo "$tool: installing…"; npm i -g "$tool" >/dev/null 2>&1 && echo "$tool: $($tool --version 2>/dev/null | head -1)"; fi
  done
  [ -d "$HOME/.agent-browser/browsers" ] || { echo "agent-browser: downloading Chrome for Testing…"; agent-browser install >/dev/null 2>&1; }
  python3 -c 'import numpy, PIL' 2>/dev/null && echo "python3: numpy + pillow ok" \
    || echo "python3: numpy / pillow missing — pip3 install --user numpy pillow"
  command -v ffmpeg >/dev/null && echo "ffmpeg: $(ffmpeg -version 2>/dev/null | head -1 | cut -d' ' -f1-3)" \
    || echo "ffmpeg: missing (brew install ffmpeg) — needed by rec / mrec / video"

  echo "## devices"
  # Named before anything is created, and changeable: a machine that already has the simulators it
  # wants must not grow three more because vysu has its own idea of them.
  local want_ios="${ios_device:-$(cfg IOS_DEVICE "$IOS_DEFAULT_DEVICE")}"
  local want_old="${ios_old:-$(cfg IOS_OLD_DEVICE)}"
  local want_avds="${avds:-$(cfg ANDROID_AVDS)}"
  echo "ios (recent): $want_ios"
  echo "ios (old):    $want_old"
  local spec
  while IFS= read -r spec; do [ -z "$spec" ] || echo "avd:          ${spec%%:*} (api ${spec#*:}, ${spec})"; done < <(VYSU_ANDROID_AVDS="$want_avds" avd_specs)
  if [ -z "$ios_device$ios_old$avds" ] && [ -t 0 ]; then
    local answer; printf 'Keep these? [Y/n] ' >&2; IFS= read -r answer
    case "$answer" in
      [nN]*)
        printf 'recent iPhone [%s]: ' "$want_ios" >&2; IFS= read -r answer; [ -z "$answer" ] || want_ios="$answer"
        printf 'old iPhone [%s]: ' "$want_old" >&2; IFS= read -r answer; [ -z "$answer" ] || want_old="$answer"
        printf 'AVD specs [%s]: ' "$want_avds" >&2; IFS= read -r answer; [ -z "$answer" ] || want_avds="$answer"
        ;;
    esac
  fi
  # Below the project config in precedence: a machine says what it has, a project says what it wants.
  { echo "# written by vysu setup — the devices this machine drives."
    echo "VYSU_IOS_DEVICE='$want_ios'"
    echo "VYSU_IOS_OLD_DEVICE='$want_old'"
    echo "VYSU_ANDROID_AVDS='$want_avds'"
  } >"$HOME/.vysu/devices.env"
  echo "devices.env: $HOME/.vysu/devices.env"

  echo "## ios"
  if command -v xcrun >/dev/null; then
    echo "simulators: $(xcrun simctl list devices available 2>/dev/null | grep -c iPhone) iPhone"
    local rt; rt="$(xcrun simctl list runtimes available -j 2>/dev/null | python3 -c "import sys,json; rs=[r for r in json.load(sys.stdin)['runtimes'] if r['platform']=='iOS' and r['version'].startswith('18.')]; print(rs[-1]['identifier'] if rs else '')")"
    if [ -z "$rt" ]; then echo "ios 18: runtime missing — xcodebuild -downloadPlatform iOS -buildVersion 18.6 (8.9 GB) for the pre-redesign iPhone"
    elif xcrun simctl list devices 2>/dev/null | grep -q "$want_old"; then echo "ios: « $want_old » present"
    else xcrun simctl create "$want_old" com.apple.CoreSimulator.SimDeviceType.iPhone-SE-3rd-generation "$rt" >/dev/null 2>&1 && echo "ios: « $want_old » created (iPhone SE 3rd gen, $rt)"; fi
  else
    echo "ios: Xcode missing — iOS checks unavailable"
  fi

  echo "## android"
  if [ -d "$ANDROID_SDK" ] && [ -x "$ANDROID_SDK/cmdline-tools/latest/bin/avdmanager" ]; then
    local abi="arm64-v8a"; [ "$(uname -m)" = x86_64 ] && abi="x86_64"
    local sdkm="$ANDROID_SDK/cmdline-tools/latest/bin/sdkmanager" avdm="$ANDROID_SDK/cmdline-tools/latest/bin/avdmanager"
    while IFS= read -r spec; do
      [ -n "$spec" ] || continue
      local name="${spec%%:*}" rest="${spec#*:}"; local api="${rest%%:*}"; rest="${rest#*:}"; local device="${rest%%:*}"; local extra="${rest#*:}"
      if [ -d "$HOME/.android/avd/$name.avd" ]; then echo "avd $name: present"; continue; fi
      local image="system-images;android-$api;google_apis;$abi"
      [ -d "$ANDROID_SDK/system-images/android-$api/google_apis/$abi" ] || { echo "avd $name: downloading $image…"; yes | "$sdkm" --install "$image" >"$LOGS/sdk-api$api.log" 2>&1; }
      echo no | "$avdm" create avd -n "$name" -k "$image" -d "$device" --force >/dev/null 2>&1 || { echo "avd $name: creation failed"; continue; }
      local cfg_file="$HOME/.android/avd/$name.avd/config.ini" kv
      { echo "hw.ramSize = 4096"; echo "hw.gpu.enabled = yes"; echo "hw.gpu.mode = host"; echo "hw.cpu.ncore = 4"; echo "hw.keyboard = yes"; for kv in $extra; do echo "${kv%%=*} = ${kv#*=}"; done; } >>"$cfg_file"
      echo "avd $name: created"
    done < <(VYSU_ANDROID_AVDS="$want_avds" avd_specs)
  else
    echo "android sdk: missing (\$ANDROID_HOME, cmdline-tools) — Android checks unavailable"
  fi

  echo "## next"
  echo "cd <your project> && vysu init      (the .vysu/config of that project)"
  echo "vysu persona add <name>             (credentials, mode 600, never printed)"
  echo "vysu login <name>                   (the browser session, once)"
  echo "vysu up ios --build                 (the native dev-client, when the project has a mobile app)"
}

# --- init: the project -------------------------------------------------------------------------

init_ask() { # variable prompt default — interactive with a default, or the default under --yes
  local __var="$1" prompt="$2" default="$3" answer=""
  if [ "$INIT_YES" = 1 ] || [ ! -t 0 ]; then
    printf -v "$__var" '%s' "$default"; return
  fi
  printf '%s [%s]: ' "$prompt" "$default" >&2
  IFS= read -r answer
  printf -v "$__var" '%s' "${answer:-$default}"
}
vysu_init() {
  INIT_YES=0
  local skills_dir=""
  while [ $# -gt 0 ]; do
    case "$1" in
      --yes|-y) INIT_YES=1; shift;;
      --skills-dir) skills_dir="$2"; shift 2;;
      *) die "vysu init: unknown option $1";;
    esac
  done
  local root; root="${VYSU_PROJECT_DIR:-$(pwd -P)}"
  # A `.vysu` found above is another project's: init is about the folder it was run in.
  [ -f "$root/.vysu/config" ] || root="$(pwd -P)"
  local template="$VYSU_ENGINE/templates/config.example"
  [ -f "$template" ] || die "init: $template missing"
  [ ! -f "$root/.vysu/config" ] || die "init: $root/.vysu/config already exists (edit it, or delete it first)"

  local project origin login_path baseline auth mobile bundle ios_app mobile_dir push webhook
  init_ask project "project name" "$(basename "$root")"
  init_ask origin "web origin" "http://localhost:3000"
  init_ask login_path "login path" "/login"
  init_ask baseline "baseline origin (the deployed main, empty for none)" ""
  init_ask auth "auth connector (auth0 | form | none | custom)" "none"
  init_ask mobile "is there a mobile app? (y/n)" "n"
  bundle=""; ios_app=""; mobile_dir=""
  case "$mobile" in
    [yY]*)
      init_ask bundle "mobile bundle id" ""
      init_ask ios_app "app name on the iOS simulator" ""
      init_ask mobile_dir "Expo app folder, relative to the project" "apps/mobile";;
  esac
  init_ask push "push drivers (apns-sim,webhook,fcm — empty for none)" ""
  webhook=""
  case ",$push," in *,webhook,*) init_ask webhook "webhook url" "";; esac

  mkdir -p "$root/.vysu/push" "$root/.vysu/commands" "$root/.vysu/themes"
  # The template is the documentation: it is copied whole, and only the answers are substituted, so
  # every key a project may ever want is in front of whoever opens the file next.
  PROJECT="$project" ORIGIN="$origin" LOGIN_PATH="$login_path" BASELINE="$baseline" AUTH="$auth" \
  BUNDLE="$bundle" IOS_APP="$ios_app" MOBILE_DIR="$mobile_dir" PUSH="$push" WEBHOOK="$webhook" \
  python3 - "$template" "$root/.vysu/config" <<'PY'
import os, re, sys

answers = {
    "VYSU_PROJECT": os.environ["PROJECT"],
    "VYSU_ORIGIN": os.environ["ORIGIN"],
    "VYSU_LOGIN_PATH": os.environ["LOGIN_PATH"],
    "VYSU_BASELINE_ORIGIN": os.environ["BASELINE"],
    "VYSU_AUTH": os.environ["AUTH"],
    "VYSU_MOBILE_BUNDLE": os.environ["BUNDLE"],
    "VYSU_IOS_APP": os.environ["IOS_APP"],
    "VYSU_MOBILE_DIR": os.environ["MOBILE_DIR"],
    "VYSU_PUSH": os.environ["PUSH"],
    "VYSU_PUSH_WEBHOOK_URL": os.environ["WEBHOOK"],
}
out = []
for line in open(sys.argv[1]):
    m = re.match(r"^#?\s*(VYSU_[A-Z0-9_]+)=", line)
    if m and m.group(1) in answers:
        value = answers[m.group(1)]
        # An answer that was left empty stays commented out: the key is documented, not set.
        out.append("%s%s='%s'\n" % ("" if value else "# ", m.group(1), value))
    else:
        out.append(line)
open(sys.argv[2], "w").write("".join(out))
PY
  echo "wrote $root/.vysu/config"
  [ -n "$(ls "$root/.vysu/push" 2>/dev/null)" ] || { printf '{\n "title": "{{title}}",\n "body": "{{body}}"\n}\n' >"$root/.vysu/push/example.json"; echo "wrote $root/.vysu/push/example.json"; }
  # shellcheck disable=SC2016  # the README is literal text: nothing in it is meant to expand
  [ -f "$root/.vysu/commands/README" ] || { printf 'Executables here become vysu commands: `vysu <name>` runs ./<name> with every VYSU_* exported,\nVYSU_ENGINE set to the engine dir and VYSU_PROJECT_DIR to this project.\n' >"$root/.vysu/commands/README"; }
  case "$(cfg AUTH "$auth")" in
    custom) [ -f "$root/.vysu/auth.sh" ] || { cp "$VYSU_ENGINE/connectors/auth/example.sh" "$root/.vysu/auth.sh" 2>/dev/null && echo "wrote $root/.vysu/auth.sh (from connectors/auth/example.sh)"; };;
  esac

  # The skills, where an agent will find them. They may not exist yet in a given engine version:
  # whatever `skill/` holds is copied, and nothing is said when it holds nothing.
  local target="${skills_dir:-$root/.claude/skills}"
  if [ -d "$VYSU_ENGINE/skill" ] && [ -n "$(ls "$VYSU_ENGINE/skill" 2>/dev/null)" ]; then
    if [ -n "$skills_dir" ] || [ -d "$root/.claude" ]; then
      mkdir -p "$target"
      local s
      for s in "$VYSU_ENGINE"/skill/*/; do
        [ -d "$s" ] || continue
        rm -rf "${target:?}/$(basename "$s")"
        cp -R "$s" "$target/$(basename "$s")"
        echo "installed skill: $target/$(basename "$s")"
      done
    fi
  fi
  [ ! -f "$VYSU_ENGINE/templates/agents-snippet.md" ] || {
    echo; echo "--- paste this into AGENTS.md / CLAUDE.md ---"
    cat "$VYSU_ENGINE/templates/agents-snippet.md"
    echo "--- end ---"
  }
  echo
  echo "## what only you can do now"
  echo "vysu persona add <name>             credentials, mode 600"
  echo "vysu login <name>                   the browser session, once"
  case "$mobile" in [yY]*) echo "vysu up ios --build                 the native dev-client (5-20 min)";; esac
  case ",$push," in *,fcm,*) echo "VYSU_FCM_SA                         the service account, under $STATE";; esac
}

# --- doctor ------------------------------------------------------------------------------------

vysu_doctor() {
  version_warn
  vysu_version
  echo "project: $(cfg PROJECT)${VYSU_PROJECT_DIR:+ · $VYSU_PROJECT_DIR}${VYSU_CONFIG_FILE:+ · $VYSU_CONFIG_FILE}"
  [ -n "$VYSU_CONFIG_FILE" ] || echo "config: none found (vysu init) — anonymous web captures only"
  echo "agent-browser: $(agent-browser --version 2>/dev/null || echo MISSING)"
  echo "agent-device:  $(agent-device --version 2>/dev/null || echo MISSING)"
  local key
  # The values in force, and where each comes from: a surprise in a report is nearly always a key
  # set in an environment nobody remembers exporting.
  for key in STATE ORIGIN LOGIN_PATH BASELINE_ORIGIN SIZES LANGS LANG LANG_STORAGE_KEY LOCALES \
             WEB_REPO API_PATTERN API_HOSTS AUTH MOBILE_BUNDLE IOS_APP MOBILE_DIR MOBILE_ENV \
             MOBILE_SCHEME ANDROID_LOCALE SERVICES PUSH THEME MIN_VERSION; do
    local value; value="$(cfg "$key")"
    [ -n "$value" ] || continue
    echo "  VYSU_$key = $value ($(config_origin "$key"))"
  done
  auth_describe_line
  push_describe_line
  if [ -f "$PERSONAS" ]; then
    echo "personas ($PERSONAS): $(persona_names | tr '\n' ' ')"
  else
    echo "personas: MISSING ($PERSONAS)"
  fi
  # shellcheck disable=SC2012  # a count of folders, where a capture name is never exotic
  echo "shots: $SHOTS ($(ls "$SHOTS" 2>/dev/null | wc -l | tr -d ' ') folders, $(du -sh "$SHOTS" 2>/dev/null | cut -f1))"
  local ffm=ok npy=ok; command -v ffmpeg >/dev/null || ffm="MISSING (brew install ffmpeg)"; python3 -c 'import numpy, PIL' 2>/dev/null || npy="MISSING (pip3 install numpy pillow)"
  echo "rec: ffmpeg $ffm · numpy/pillow $npy"
  echo "helpers: diff.py $( [ -f "$DIFF" ] && echo ok || echo MISSING) · take.py $( [ -f "$TAKE" ] && echo ok || echo MISSING) · motion.py $( [ -f "$MOTION" ] && echo ok || echo MISSING) · mark.py $( [ -f "$MARK" ] && echo ok || echo MISSING) · stitch.py $( [ -f "$STITCH" ] && echo ok || echo MISSING) · locales $( [ -n "$LOCALES" ] && { [ -d "$LOCALES" ] && echo ok || echo MISSING; } || echo '(none)')"
  # `agent-browser doctor` would answer this too, but it launches a browser to do it: the help page
  # is the same yes-or-no for a tenth of the time.
  local rec="MISSING (agent-browser >= 0.38)"
  agent-browser record --help >/dev/null 2>&1 && rec="ok$(command -v ffmpeg >/dev/null || printf ' (ffmpeg MISSING)')"
  echo "remotion: node_modules $( [ -d "$REMOTION/node_modules" ] && echo ok || echo 'MISSING (installed on the first vysu video)')"
  echo "demo: frame.py $( [ -f "$FRAME" ] && echo ok || echo MISSING) · compare.py $( [ -f "$COMPARE" ] && echo ok || echo MISSING) · agent-browser record $rec"
  # shellcheck disable=SC2010,SC2012  # the cache files are named by vysu itself, one prefix each
  local cached
  # shellcheck disable=SC2010  # the cache files are named by vysu itself, one prefix each
  cached="$(ls "$STATE" 2>/dev/null | grep -E '^(ios-udid-|android-serial-|scale-|state-)' | tr '\n' ' ')"
  echo "cache: ${cached:-(empty)}$( [ -n "$cached" ] && printf ' — vysu cache clear')"
  echo "ios device: $IOS_DEVICE$(device_origin ios-device)"
  local serial; serial="$(android_serial)"
  echo "android avd: $ANDROID_AVD$(device_origin android-avd) → ${serial:-not running}"
  local s attached=""
  for s in $(adb devices 2>/dev/null | awk '$1 ~ /^emulator-/ && $2 == "device" { print $1 }'); do
    attached="$attached $s=$(android_avd_of "$s")"
  done
  echo "emulators:${attached:- (none attached)}"
  # What each device was left in, the same line `vysu claim` prints.
  local sf d
  for sf in "$STATE"/state-*.env; do
    [ -f "$sf" ] || continue
    d="$(basename "$sf" .env)"; d="${d#state-}"
    case "$d" in ios-*|android-*) mstate_line "$sf" "$d";; esac
  done
  locks_report
  command -v "$ANDROID_SDK/emulator/emulator" >/dev/null 2>&1 && echo "avds: $("$ANDROID_SDK/emulator/emulator" -list-avds 2>/dev/null | tr '\n' ' ')"
  agent-browser session list 2>/dev/null | sed 's/^/session: /' || true
}
