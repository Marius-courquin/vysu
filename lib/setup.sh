# setup.sh — getting there and staying there: `setup` prepares the machine (tools, browser,
# simulators, emulators), `init` writes a project's `.vysu/config` and installs the agent skills,
# `doctor` says what is resolved and what is missing, `update` pulls the engine, `version` names it.
# shellcheck shell=bash
# shellcheck disable=SC2153  # STATE, LOGS, SHOTS, IOS_DEVICE and the helper paths are set in core.sh

vysu_version() {
  local v sha; v="$(cat "$VYSU_ENGINE/VERSION" 2>/dev/null || echo unknown)"
  sha="$(git -C "$VYSU_ENGINE" rev-parse --short HEAD 2>/dev/null || echo unknown)"
  echo "vysu $v ($sha) — $VYSU_ENGINE"
  # The two drivers are half of what vysu is: a version report that leaves them out answers the
  # wrong question when a capture behaves differently on two machines.
  local tool have
  for tool in agent-browser agent-device; do
    have="$(tool_version "$tool")"
    echo "$tool ${have:-MISSING} (needs >= $(tool_min "$tool"))"
  done
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

# --- the two node tools ------------------------------------------------------------------------

# `tools.env` in the engine root names the versions this engine was checked against: one file to
# raise when the engine starts relying on something newer, read by setup, update, doctor and
# version rather than by four copies of the same two numbers.
tools_load() {
  AGENT_BROWSER_MIN=""; AGENT_DEVICE_MIN=""
  # shellcheck disable=SC1091  # the engine's own file, beside this one
  [ ! -f "$VYSU_ENGINE/tools.env" ] || . "$VYSU_ENGINE/tools.env"
}
tool_min() { tools_load; case "$1" in agent-browser) printf '%s' "$AGENT_BROWSER_MIN";; agent-device) printf '%s' "$AGENT_DEVICE_MIN";; esac; }
tool_version() { # the three numbers, whatever the tool wraps them in
  command -v "$1" >/dev/null || return 0
  "$1" --version 2>/dev/null | head -1 | grep -oE '[0-9]+\.[0-9]+\.[0-9]+' | head -1
}
# One line per tool, in the three shapes of ui.sh. `install` upgrades what is below the minimum,
# `report` only says so — which is what an agent running setup without a terminal, and doctor,
# both want.
tools_check() { # install | report
  local mode="$1" tool have want
  for tool in agent-browser agent-device; do
    want="$(tool_min "$tool")"; have="$(tool_version "$tool")"
    if [ -z "$have" ]; then
      if [ "$mode" = install ]; then
        info "$tool: installing…"; npm i -g "$tool" >/dev/null 2>&1 || true; have="$(tool_version "$tool")"
      fi
      [ -n "$have" ] || { miss "$tool: missing — no browser or device automation without it" -- "npm i -g $tool"; continue; }
    fi
    if [ -n "$want" ] && version_below "$have" "$want"; then
      if [ "$mode" = install ]; then
        info "$tool: $have → $want or better, upgrading…"
        npm i -g "$tool@latest" >/dev/null 2>&1 || true
        have="$(tool_version "$tool")"
      fi
      if [ -n "$want" ] && version_below "$have" "$want"; then
        warn "$tool: $have, this engine expects >= $want" -- "npm i -g $tool@latest"; continue
      fi
    fi
    ok "$tool: $have"
  done
}

# The branch the remote points at, for an engine checked out at a tag.
engine_default_branch() {
  local b
  b="$(git -C "$VYSU_ENGINE" symbolic-ref -q --short refs/remotes/origin/HEAD 2>/dev/null || true)"
  [ -z "$b" ] || { printf '%s' "${b#origin/}"; return; }
  for b in main master; do
    git -C "$VYSU_ENGINE" rev-parse -q --verify "refs/remotes/origin/$b" >/dev/null 2>&1 && { printf '%s' "$b"; return; }
  done
  printf 'main'
}
vysu_update() {
  local before; before="$(cat "$VYSU_ENGINE/VERSION" 2>/dev/null || echo unknown)"
  ui_head "engine"
  # An engine pinned at a tag has no branch to fast-forward: `update` is how you leave the pin,
  # so it fetches and moves onto the remote's default branch rather than reporting a git error.
  if ! git -C "$VYSU_ENGINE" symbolic-ref -q HEAD >/dev/null 2>&1; then
    local branch; branch="$(engine_default_branch)"
    info "engine: detached at $(git -C "$VYSU_ENGINE" describe --tags --always 2>/dev/null || echo '?') — moving onto $branch"
    git -C "$VYSU_ENGINE" fetch -q origin || die "update: git fetch failed in $VYSU_ENGINE" "cd $VYSU_ENGINE && git fetch origin"
    git -C "$VYSU_ENGINE" checkout -q "$branch" 2>/dev/null || git -C "$VYSU_ENGINE" checkout -q -b "$branch" "origin/$branch" \
      || die "update: cannot move onto $branch in $VYSU_ENGINE" "cd $VYSU_ENGINE && git checkout $branch"
  fi
  git -C "$VYSU_ENGINE" pull --ff-only || die "update: git pull --ff-only failed in $VYSU_ENGINE" "cd $VYSU_ENGINE && git status"
  local after; after="$(cat "$VYSU_ENGINE/VERSION" 2>/dev/null || echo unknown)"
  if [ "$before" = "$after" ]; then ok "vysu: already at $after"; else
    ok "vysu: $before → $after"
    # The CHANGELOG entries between the two, by their headings: what changed is what is printed.
    [ ! -f "$VYSU_ENGINE/CHANGELOG.md" ] || awk -v from="$before" '
      /^## / { if ($2 == from) exit; show = 1 }
      show { print }' "$VYSU_ENGINE/CHANGELOG.md"
  fi
  ui_head "tools"
  tools_check install
  ui_head "skills"
  skills_line "$after"
}
# --- setup: the machine ------------------------------------------------------------------------

# The AVD specs, as `name:api:device:extra key=value …` separated by « ; ».
# shellcheck disable=SC2046  # splitting on « ; » is the point: one spec per line
avd_specs() { local IFS=';'; printf '%s\n' $(cfg ANDROID_AVDS); }

# The Chromium-based browsers a Mac may already have. Safari and Firefox are not on the list:
# agent-browser drives Chromium through CDP and neither speaks it.
BROWSER_APPS='Brave Browser|Google Chrome|Microsoft Edge|Chromium'
browsers_found() { # one executable path per line, for those actually installed
  local app; local IFS='|'
  for app in $BROWSER_APPS; do
    [ -x "/Applications/$app.app/Contents/MacOS/$app" ] || continue
    printf '/Applications/%s.app/Contents/MacOS/%s\n' "$app" "$app"
  done
  return 0
}

vysu_setup() {
  local ios_device="" ios_old="" avds="" assume_yes=0 dry=0 browser="" browser_given=0
  while [ $# -gt 0 ]; do
    case "$1" in
      --ios-device) ios_device="$2"; shift 2;;
      --ios-old-device) ios_old="$2"; shift 2;;
      --android-avds) avds="$2"; shift 2;;
      --browser) browser="$2"; browser_given=1; shift 2;;
      --no-color) ui_no_color; shift;;
      --yes|-y) assume_yes=1; shift;;
      --dry-run) dry=1; shift;;
      *) die "vysu setup: unknown option $1" "vysu setup --help";;
    esac
  done
  # An agent runs setup to read the machine, not to change it: with no terminal to answer the one
  # question below, an installing run would download system images and create simulators nobody
  # asked for. Reporting is the default there, and `--yes` is how a script asks for the real thing.
  if [ "$dry" = 0 ] && [ "$assume_yes" = 0 ] && [ ! -t 0 ]; then
    dry=1
    info "no terminal, and no --yes: reporting only — nothing is installed or created"
  fi
  mkdir -p "$STATE/shots" "$LOGS" "$HOME/.vysu"

  ui_head "tools"
  if command -v node >/dev/null; then ok "node: $(node --version)"
  else miss "node: missing — every driver runs on it (>= 22)" -- "brew install node"; fi
  if command -v node >/dev/null; then tools_check "$( [ "$dry" = 1 ] && echo report || echo install )"
  else miss "agent-browser / agent-device: no node to install them on" -- "brew install node && npm i -g agent-browser agent-device"; fi
  if python3 -c 'import numpy, PIL' 2>/dev/null; then ok "python3: numpy + pillow ($(python3 --version 2>&1 | cut -d' ' -f2))"
  else miss "python3: numpy / pillow missing — no diff, no contact sheet, no export" -- "pip3 install --user numpy pillow"; fi
  if command -v ffmpeg >/dev/null; then ok "ffmpeg: $(ffmpeg -version 2>/dev/null | head -1 | cut -d' ' -f3)"
  else warn "ffmpeg: missing — optional, unlocks rec / mrec / video" -- "brew install ffmpeg"; fi

  ui_head "browser"
  # The default is deliberate: agent-browser downloads Chrome for Testing and drives it headless,
  # so a capture renders the same on every machine, no personal profile is opened and no extension
  # rewrites the page. An installed browser is a choice, with that caveat attached.
  local want_browser; want_browser="$(cfg BROWSER_PATH)"
  case "$browser" in
    '') ;;
    default) want_browser="";;
    *) [ -x "$browser" ] || die "--browser: not an executable: $browser" "ls /Applications"; want_browser="$browser";;
  esac
  local found; found="$(browsers_found)"
  if [ "$browser_given" = 0 ] && [ -n "$found" ] && [ -t 0 ] && [ "$dry" = 0 ]; then
    info "Chromium-based browsers on this machine:"
    printf '%s\n' "$found" | awk '{ printf "  %d) %s\n", NR, $0 }'
    printf 'Use one instead of Chrome for Testing? [number, or Enter to keep the default] ' >&2
    local answer; IFS= read -r answer || answer=""
    case "$answer" in
      ''|[nN]*) want_browser="";;
      *) want_browser="$(printf '%s\n' "$found" | sed -n "${answer}p")"
         [ -n "$want_browser" ] || die "no browser number $answer in that list" "vysu setup --browser default";;
    esac
  elif [ -n "$found" ]; then
    info "also installed here: $(printf '%s\n' "$found" | sed 's#.*/MacOS/##' | tr '\n' ',' | sed 's/,$//; s/,/, /g') (vysu setup --browser <path>)"
  fi
  if [ -n "$want_browser" ]; then
    ok "browser: $(basename "$want_browser") — your own; a page may render unlike a baseline captured elsewhere"
  elif [ -d "$HOME/.agent-browser/browsers" ]; then
    ok "browser: Chrome for Testing, headless (same rendering everywhere)"
  elif [ "$dry" = 1 ] || ! command -v agent-browser >/dev/null; then
    miss "browser: nothing to drive — Chrome for Testing is not downloaded" -- "agent-browser install"
  else
    info "browser: downloading Chrome for Testing…"
    if agent-browser install >/dev/null 2>&1; then ok "browser: Chrome for Testing, headless (same rendering everywhere)"
    else miss "browser: the download failed" -- "agent-browser install"; fi
  fi

  ui_head "devices"
  # Named before anything is created, and changeable: a machine that already has the simulators it
  # wants must not grow three more because vysu has its own idea of them.
  local want_ios="${ios_device:-$(cfg IOS_DEVICE "$IOS_DEFAULT_DEVICE")}"
  local want_old="${ios_old:-$(cfg IOS_OLD_DEVICE)}"
  local want_avds="${avds:-$(cfg ANDROID_AVDS)}"
  info "ios (recent): $want_ios"
  info "ios (old):    $want_old"
  local spec spec_rest
  while IFS= read -r spec; do
    [ -n "$spec" ] || continue
    spec_rest="${spec#*:}"
    info "avd:          ${spec%%:*} (api ${spec_rest%%:*})"
  done < <(VYSU_ANDROID_AVDS="$want_avds" avd_specs)
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
  if [ "$dry" = 1 ]; then
    info "machine.env: $MACHINE_ENV (unchanged — reporting only)"
  else
    { echo "# written by vysu setup — what this machine drives."
      echo "VYSU_IOS_DEVICE='$want_ios'"
      echo "VYSU_IOS_OLD_DEVICE='$want_old'"
      echo "VYSU_ANDROID_AVDS='$want_avds'"
      [ -z "$want_browser" ] || echo "VYSU_BROWSER_PATH='$want_browser'"
    } >"$MACHINE_ENV"
    ok "machine.env: $MACHINE_ENV"
    [ ! -f "$HOME/.vysu/devices.env" ] || info "devices.env: still read, and below machine.env — delete it once you have moved its keys over"
  fi

  ui_head "ios"
  if command -v xcrun >/dev/null; then
    local iphones; iphones="$(xcrun simctl list devices available 2>/dev/null | grep -c iPhone || true)"
    if [ "${iphones:-0}" -gt 0 ]; then ok "simulators: $iphones iPhone available"
    else warn "simulators: none — optional, iOS checks only" -- "open -a Simulator"; fi
    local rt; rt="$(xcrun simctl list runtimes available -j 2>/dev/null | python3 -c "import sys,json; rs=[r for r in json.load(sys.stdin)['runtimes'] if r['platform']=='iOS' and r['version'].startswith('18.')]; print(rs[-1]['identifier'] if rs else '')" 2>/dev/null || true)"
    if [ -z "$rt" ]; then warn "ios 18: runtime missing — optional, unlocks the pre-redesign iPhone (8.9 GB)" -- "xcodebuild -downloadPlatform iOS -buildVersion 18.6"
    elif xcrun simctl list devices 2>/dev/null | grep -q "$want_old"; then ok "ios: « $want_old » present"
    elif [ "$dry" = 1 ]; then warn "ios: « $want_old » missing — optional, the old-phone check" -- "vysu setup --yes"
    elif xcrun simctl create "$want_old" com.apple.CoreSimulator.SimDeviceType.iPhone-SE-3rd-generation "$rt" >/dev/null 2>&1; then
      ok "ios: « $want_old » created (iPhone SE 3rd gen, $rt)"
    else
      warn "ios: « $want_old » could not be created — optional" -- "xcrun simctl create '$want_old' com.apple.CoreSimulator.SimDeviceType.iPhone-SE-3rd-generation $rt"
    fi
  else
    warn "ios: Xcode missing — optional, unlocks every iOS check" -- "xcode-select --install"
  fi

  ui_head "android"
  if [ -d "$ANDROID_SDK" ] && [ -x "$ANDROID_SDK/cmdline-tools/latest/bin/avdmanager" ]; then
    local abi="arm64-v8a"; [ "$(uname -m)" = x86_64 ] && abi="x86_64"
    local sdkm="$ANDROID_SDK/cmdline-tools/latest/bin/sdkmanager" avdm="$ANDROID_SDK/cmdline-tools/latest/bin/avdmanager"
    while IFS= read -r spec; do
      [ -n "$spec" ] || continue
      local name="${spec%%:*}" rest="${spec#*:}"; local api="${rest%%:*}"; rest="${rest#*:}"; local device="${rest%%:*}"; local extra="${rest#*:}"
      if [ -d "$HOME/.android/avd/$name.avd" ]; then ok "avd $name: present"; continue; fi
      if [ "$dry" = 1 ]; then warn "avd $name: missing — optional, one Android device" -- "vysu setup --yes"; continue; fi
      local image="system-images;android-$api;google_apis;$abi"
      [ -d "$ANDROID_SDK/system-images/android-$api/google_apis/$abi" ] || { info "avd $name: downloading $image…"; yes | "$sdkm" --install "$image" >"$LOGS/sdk-api$api.log" 2>&1; }
      echo no | "$avdm" create avd -n "$name" -k "$image" -d "$device" --force >/dev/null 2>&1 || { warn "avd $name: creation failed — see $LOGS/sdk-api$api.log" -- "vysu setup --yes"; continue; }
      local cfg_file="$HOME/.android/avd/$name.avd/config.ini" kv
      { echo "hw.ramSize = 4096"; echo "hw.gpu.enabled = yes"; echo "hw.gpu.mode = host"; echo "hw.cpu.ncore = 4"; echo "hw.keyboard = yes"; for kv in $extra; do echo "${kv%%=*} = ${kv#*=}"; done; } >>"$cfg_file"
      ok "avd $name: created"
    done < <(VYSU_ANDROID_AVDS="$want_avds" avd_specs)
  else
    warn "android sdk: missing — optional, unlocks every Android check" -- "brew install --cask android-commandlinetools"
  fi

  summary "cd <your project> && vysu init      the .vysu/config of that project" \
          "vysu persona add <name>             credentials, mode 600, never printed"
  ui_status
}
# --- init: the project -------------------------------------------------------------------------

# The skills, and which version of the engine wrote them. `init` stamps every SKILL.md it copies
# with `<!-- vysu-skill <version> -->` right after the frontmatter, so `doctor` can say that a
# project is running last month's instructions against this month's engine — the failure mode
# nobody notices, because nothing breaks: the agent simply does the old thing.
skills_target() { printf '%s/.claude/skills' "${VYSU_PROJECT_DIR:-$(pwd -P)}"; }
skill_stamp() { # SKILL.md version
  local f="$1" tmp="$1.vysu-tmp"
  awk -v mark="<!-- vysu-skill $2 -->" '
    NR == 1 && $0 == "---" { print; fm = 1; next }
    fm && $0 == "---" { print; print ""; print mark; fm = 0; done = 1; next }
    { print }
    END { if (!done) exit 3 }' "$f" >"$tmp" 2>/dev/null     || { printf '%s\n\n' "<!-- vysu-skill $2 -->" >"$tmp"; cat "$f" >>"$tmp"; }
  mv "$tmp" "$f"
}
skills_install() { # target dir — every skill of this engine, stamped; says nothing when it has none
  local target="$1" v s name
  v="$(cat "$VYSU_ENGINE/VERSION" 2>/dev/null || echo 0.0.0)"
  [ -d "$VYSU_ENGINE/skill" ] && [ -n "$(ls "$VYSU_ENGINE/skill" 2>/dev/null)" ] || return 0
  mkdir -p "$target"
  for s in "$VYSU_ENGINE"/skill/*/; do
    [ -d "$s" ] || continue
    name="$(basename "$s")"
    rm -rf "${target:?}/$name"
    cp -R "$s" "$target/$name"
    [ ! -f "$target/$name/SKILL.md" ] || skill_stamp "$target/$name/SKILL.md" "$v"
    echo "installed skill: $target/$name ($v)"
  done
}
# The oldest marker among the installed skills: one stale copy is what the reminder is about.
skills_installed_version() { # target dir
  local s f v
  for s in "$VYSU_ENGINE"/skill/*/; do
    [ -d "$s" ] || continue
    f="$1/$(basename "$s")/SKILL.md"
    [ -f "$f" ] || continue
    v="$(sed -n 's/^<!-- vysu-skill \([^ ]*\) -->$/\1/p' "$f" | head -1)"
    printf '%s\n' "${v:-0.0.0}"
  done | sort | head -1
}
skills_line() { # engine version — the doctor / update line about this project's installed skills
  local target; target="$(skills_target)"
  local have; have="$(skills_installed_version "$target")"
  if [ -z "$have" ]; then
    if [ -d "$target" ]; then warn "skills: none of this engine's skills in $target" -- "vysu init --refresh-skills"
    else info "skills: none installed here (no $target)"; fi
  elif [ "$have" != "$1" ]; then
    warn "skills: installed $have · engine $1" -- "vysu init --refresh-skills"
  else
    ok "skills: $have ($target)"
  fi
}

init_ask() { # variable prompt default — interactive with a default, or the default under --yes
  local __var="$1" prompt="$2" default="$3" answer=""
  if [ "$INIT_YES" = 1 ]; then
    printf -v "$__var" '%s' "$default"; return
  fi
  printf '%s [%s]: ' "$prompt" "$default" >&2
  # The answers may also be piped in (an agent, a test): an empty line or a closed stdin is the
  # default, exactly as under --yes.
  IFS= read -r answer || answer=""
  printf -v "$__var" '%s' "${answer:-$default}"
}
vysu_init() {
  INIT_YES=0
  local skills_dir="" refresh=0
  while [ $# -gt 0 ]; do
    case "$1" in
      --yes|-y) INIT_YES=1; shift;;
      --skills-dir) skills_dir="$2"; shift 2;;
      --refresh-skills) refresh=1; shift;;
      --no-color) ui_no_color; shift;;
      *) die "vysu init: unknown option $1" "vysu --help";;
    esac
  done
  # An engine update brings new skills; the copies in a project do not follow on their own.
  # `--refresh-skills` re-copies them and touches nothing else — not the config, not the personas.
  if [ "$refresh" = 1 ]; then
    local target="${skills_dir:-$(skills_target)}"
    skills_install "$target" || true
    [ -n "$(skills_installed_version "$target")" ] || die "init --refresh-skills: this engine ships no skill to install" "vysu update"
    return 0
  fi
  local root; root="${VYSU_PROJECT_DIR:-$(pwd -P)}"
  # A `.vysu` found above is another project's: init is about the folder it was run in.
  [ -f "$root/.vysu/config" ] || root="$(pwd -P)"
  local template="$VYSU_ENGINE/templates/config.example"
  [ -f "$template" ] || die "init: $template missing"
  [ ! -f "$root/.vysu/config" ] || die "init: $root/.vysu/config already exists (edit it, or delete it first)"

  local project origin login_path baseline auth mobile kind bundle ios_app mobile_dir push webhook
  local ios_app_path android_apk
  [ "$INIT_YES" = 1 ] || info "Enter keeps the value in brackets; every answer can be changed later in .vysu/config"
  init_ask project "project name (session prefix and state folder)" "$(basename "$root")"
  init_ask origin "web origin — where the app runs locally" "http://localhost:3000"
  init_ask login_path "login path — the page on that origin where a user signs in (/ if the home page has the login; anything if there is no login)" "/login"
  init_ask baseline "baseline origin — the deployed main, that a branch is diffed against (empty for none)" ""
  init_ask auth "auth connector — auth0 | form (an e-mail + password form on the login page) | none (no login) | custom" "none"
  init_ask mobile "mobile app — none | expo (Metro dev-client) | native (Swift, Kotlin, Flutter…)" "none"
  kind=""; bundle=""; ios_app=""; mobile_dir=""; ios_app_path=""; android_apk=""
  case "$mobile" in
    [eE]*|[yY]*)
      kind="expo"
      init_ask bundle "mobile bundle id" ""
      init_ask ios_app "app name on the iOS simulator" ""
      init_ask mobile_dir "Expo app folder, relative to the project" "apps/mobile";;
    [nN][aA]*)
      kind="native"
      init_ask bundle "mobile bundle id" ""
      init_ask ios_app "app name on the iOS simulator" ""
      # Both may be left empty: a device that already has the app needs neither, and the build
      # commands (VYSU_MOBILE_BUILD_IOS / _ANDROID) are documented in the config they are written to.
      init_ask ios_app_path "the .app built for iphonesimulator, relative to the project (empty: none)" ""
      init_ask android_apk "the debug .apk, relative to the project (empty: none)" "";;
  esac
  init_ask push "push drivers (apns-sim,webhook,fcm — empty for none)" ""
  webhook=""
  case ",$push," in *,webhook,*) init_ask webhook "webhook url" "";; esac

  mkdir -p "$root/.vysu/push" "$root/.vysu/commands" "$root/.vysu/themes"
  # The template is the documentation: it is copied whole, and only the answers are substituted, so
  # every key a project may ever want is in front of whoever opens the file next.
  PROJECT="$project" ORIGIN="$origin" LOGIN_PATH="$login_path" BASELINE="$baseline" AUTH="$auth" \
  BUNDLE="$bundle" IOS_APP="$ios_app" MOBILE_DIR="$mobile_dir" PUSH="$push" WEBHOOK="$webhook" \
  MOBILE_KIND="$kind" IOS_APP_PATH="$ios_app_path" ANDROID_APK="$android_apk" \
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
    "VYSU_MOBILE_KIND": os.environ["MOBILE_KIND"],
    "VYSU_IOS_APP_PATH": os.environ["IOS_APP_PATH"],
    "VYSU_ANDROID_APK": os.environ["ANDROID_APK"],
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
  if [ -n "$skills_dir" ] || [ -d "$root/.claude" ]; then skills_install "$target"; fi
  [ ! -f "$VYSU_ENGINE/templates/agents-snippet.md" ] || {
    echo; echo "--- paste this into AGENTS.md / CLAUDE.md ---"
    cat "$VYSU_ENGINE/templates/agents-snippet.md"
    echo "--- end ---"
  }
  echo
  echo "## what only you can do now"
  echo "vysu persona add <name>             credentials, mode 600"
  echo "vysu login <name>                   the browser session, once"
  case "$kind" in
    expo) echo "vysu up ios --build                 the native dev-client (5-20 min)";;
    native) echo "VYSU_IOS_APP_PATH / VYSU_ANDROID_APK  the built app, or VYSU_MOBILE_BUILD_IOS / _ANDROID";;
  esac
  case ",$push," in *,fcm,*) echo "VYSU_FCM_SA                         the service account, under $STATE";; esac
}

# --- doctor ------------------------------------------------------------------------------------

vysu_doctor() {
  while [ $# -gt 0 ]; do
    case "$1" in --no-color) ui_no_color; shift;; *) die "vysu doctor: unknown option $1" "vysu doctor";; esac
  done
  version_warn
  local engine_version; engine_version="$(cat "$VYSU_ENGINE/VERSION" 2>/dev/null || echo unknown)"
  echo "vysu $engine_version ($(git -C "$VYSU_ENGINE" rev-parse --short HEAD 2>/dev/null || echo unknown)) — $VYSU_ENGINE"
  echo "project: $(cfg PROJECT)${VYSU_PROJECT_DIR:+ · $VYSU_PROJECT_DIR}${VYSU_CONFIG_FILE:+ · $VYSU_CONFIG_FILE}"
  [ -n "$VYSU_CONFIG_FILE" ] || warn "config: none found — anonymous web captures only" -- "vysu init"
  tools_check report
  # Which browser a capture will actually render in: the engine's headless Chrome for Testing, or
  # the one this machine chose. A diff against a baseline captured elsewhere depends on it.
  ok "browser: $(browser_name)$( [ -n "$(cfg BROWSER_PATH)" ] && printf ' (%s)' "$(config_origin BROWSER_PATH)")"
  skills_line "$engine_version"
  local key
  # The values in force, and where each comes from: a surprise in a report is nearly always a key
  # set in an environment nobody remembers exporting.
  for key in STATE ORIGIN LOGIN_PATH BASELINE_ORIGIN BROWSER_PATH BROWSER_ARGS SIZES LANGS LANG LANG_STORAGE_KEY LOCALES \
             WEB_REPO API_PATTERN API_HOSTS AUTH MOBILE_KIND MOBILE_BUNDLE IOS_APP MOBILE_DIR \
             MOBILE_ENV MOBILE_SCHEME MOBILE_READY_TEXT IOS_APP_PATH ANDROID_APK MOBILE_BUILD_IOS \
             MOBILE_BUILD_ANDROID ANDROID_LOCALE SERVICES PUSH THEME MIN_VERSION; do
    local value; value="$(cfg "$key")"
    [ -n "$value" ] || continue
    # A project with no mobile app has no mobile kind either: the default reads « native », which
    # says nothing true about it.
    [ "$key" != MOBILE_KIND ] || [ -n "$(cfg MOBILE_BUNDLE)" ] || continue
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
  if command -v ffmpeg >/dev/null; then ok "ffmpeg: $(ffmpeg -version 2>/dev/null | head -1 | cut -d' ' -f3)"
  else warn "ffmpeg: missing — optional, unlocks rec / mrec / video" -- "brew install ffmpeg"; fi
  if python3 -c 'import numpy, PIL' 2>/dev/null; then ok "python3: numpy + pillow"
  else miss "python3: numpy / pillow missing — no diff, no contact sheet, no export" -- "pip3 install --user numpy pillow"; fi
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
  # An empty cache is an answer, not a failure: `grep` finding nothing ends the pipeline under
  # pipefail, and doctor would stop here — on a fresh project, exactly where it has most to say.
  cached="$(ls "$STATE" 2>/dev/null | grep -E '^(ios-udid-|android-serial-|scale-|state-)' | tr '\n' ' ' || true)"
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
