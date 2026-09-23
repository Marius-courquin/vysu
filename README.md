# vysu

Look at a real app the way a reviewer does, in tokens an agent can afford.

vysu ("visu") drives a real browser, an iOS simulator and an Android emulator against the app you
are building: one session per persona whose login survives across runs, screenshots and diffs kept
outside every repo, a 25-line text report before any image, and a recorded flow that becomes a demo
video. It works the same for Claude Code, Codex, or a human in a terminal.

## Install

One line, on a Mac or Linux box with `git`:

```bash
curl -fsSL https://raw.githubusercontent.com/Marius-courquin/vysu/main/install.sh | bash
```

**While the repository is private**, that raw URL is not reachable and a plain `git clone` asks
for a login it cannot get: log in once with the GitHub CLI, then clone with it and run the
installer from the clone.

```bash
brew install gh && gh auth login          # once; pick GitHub.com, HTTPS, login in the browser
gh repo clone Marius-courquin/vysu ~/vysu && ~/vysu/install.sh
```

It clones the engine into `~/vysu` (or updates it), makes `vysu` reachable — a link into a
directory already on your PATH when one is writable, else a PATH line in your shell's startup file
(zsh, bash or fish) — and prints `vysu version`. **Open a new terminal** afterwards if it says so.
No tool is installed at that point: that is `vysu setup`'s job, and it asks before creating any
simulator or emulator.

```bash
vysu setup                     # node tools, the browser, simulators, emulators
```

Every line of the installer and of `vysu setup` says exactly one of three things — `✓` it is fine,
with the version; `!` it is missing and optional, with what it unlocks and the command; `✗` it is
missing and required, with the command — and `setup` ends on the counts, the exact commands to run
and the two next steps. It exits 1 when something required is missing (node, `agent-browser`,
`agent-device`, python3 with numpy and Pillow), 0 otherwise, so a script can branch on it.

```
## summary
ready: 6 · optional missing: 5 · required missing: 0

run:
  brew install ffmpeg
  vysu setup --yes

next:
  cd <your project> && vysu init      the .vysu/config of that project
  vysu persona add <name>             credentials, mode 600, never printed
```

Colours go away on their own when the output is not a terminal, and `--no-color` or `NO_COLOR=1`
turns them off anywhere.

By hand, the same thing is:

```bash
git clone https://github.com/Marius-courquin/vysu ~/vysu
~/vysu/bin/vysu version        # works right away, from its path
export PATH="$HOME/vysu/bin:$PATH"   # then add that line to ~/.zshrc, ~/.bash_profile or your fish config
```

`vysu: command not found` after the install means the shell has not read the PATH line yet: open
a new terminal, or check which shell you run (`echo $SHELL`) and that the line went into its
startup file. `~/vysu/bin/vysu version` proves the engine itself is fine.

Then, in your project:

```bash
vysu init                      # writes .vysu/config, picks an auth connector, installs the agent skills
vysu persona add alice         # e-mail + password, stored under ~/.vysu/<project>/ (mode 600)
vysu login alice               # once; the session is kept
vysu walk alice home --url http://localhost:3000/
```

`vysu init` also prints [`templates/agents-snippet.md`](templates/agents-snippet.md), the paragraph
to paste into your `AGENTS.md` / `CLAUDE.md`. `vysu update` pulls the latest engine, and
`vysu doctor` says what is configured and what is missing.

## Five minutes

```bash
vysu up web                                        # the dev server your config declares
vysu walk alice feed --url http://localhost:3000/feed --baseline-url @
```

`walk` opens the page, collects the browser's complaints, captures every viewport, diffs each one
against the same path on your baseline origin and prints the report — six calls in one. The report
names **the single image worth reading**, and names the identical ones so they stay unopened:

```
web · alice · http://localhost:3000/feed · lang en · 4 sizes · vs https://main.example.com/feed · sha 1a2b3c4 (feat/x) · api staging · 2026-09-21 10:12
1440x900: changed 0.4 % (5 210 px) · 2 zones
check: clean
identical, do not read: 360x800.png, 768x1024.png, 1280x800.png
read: /Users/…/shots/feed/1440x900-changed.png
```

```bash
vysu report feed --md                              # the same, fenced, for the ## Tests of a merge request
vysu sheet feed                                    # several states on one contact sheet, <= 1568 px
vysu up ios && vysu mlogin ios alice               # Metro + simulator, one login per install
vysu mshot ios feed-ios                            # 1x capture, frozen status bar, diffable
vysu textsize ios xl                               # the check nobody does by hand
vysu rec alice feed-clip -- "go http://localhost:3000/feed" "sleep 1" "click \"Issues\""
vysu cut feed-clip --draft                         # the montage script; you write the words
vysu video feed-clip --check && vysu video feed-clip
```

Nothing above was committed to your repo: captures, clips and renders live under
`~/.vysu/<project>/shots/`.

## Concepts

- **Persona** — a named browser (or device) session whose login is restored on every run. `-` is an
  anonymous one, for a public page. Credentials live in `personas.env` under the state folder,
  mode 600, and are never printed. A name holds letters, digits and `_` (`tb_non_verifie`).
- **Session** — one agent-browser session per persona (`<project>-<persona>`), one agent-device
  session per device (`<project>-<platform>-<device>`). Several agents share a machine: every
  command locks what it drives, and `vysu claim` holds a device across a whole task.
- **Shots folder** — `~/.vysu/<project>/shots/<name>/`: the captures, the diffs, `meta.json` (which
  branch, which API, which viewports), `check.txt`, the contact sheets, and for a recording the
  clip, `events.json`, `motion.txt` and the render. `vysu prune` clears it out.
- **Connector** — the file that knows how your app signs a persona in: a built-in named by
  `VYSU_AUTH`, or `.vysu/auth.mjs` (`.vysu/auth.sh` in bash). It is the only place that knows about
  your identity provider.
- **Service** — a command, a port and a health check, declared in the config. `vysu up web`,
  `vysu up all`, `vysu down db` — the engine knows no stack.
- **Project command** — an executable `.vysu/commands/<name>`, run by `vysu <name>` with every
  resolved `VYSU_*` exported: where seeding and other app-specific chores live.
- **Theme** — the brand of the explainer video: `.vysu/themes/<name>/theme.json` in your project,
  otherwise the engine's neutral `default`.

## Configuration

`.vysu/config` at the root of your project, written by `vysu init` from
[`templates/config.example`](templates/config.example), which documents every key. The full list
with defaults and examples is in [docs/config.md](docs/config.md).

| Section | Keys | What it decides |
|---|---|---|
| identity | `VYSU_PROJECT`, `VYSU_STATE`, `VYSU_MIN_VERSION` | session prefix, state folder, the engine version you need |
| the web app | `VYSU_ORIGIN`, `VYSU_LOGIN_PATH`, `VYSU_BASELINE_ORIGIN`, `VYSU_SIZES`, `VYSU_LANGS`/`VYSU_LANG`/`VYSU_LANG_STORAGE_KEY`, `VYSU_LOCALES`, `VYSU_WEB_REPO`, `VYSU_API_PATTERN`, `VYSU_API_HOSTS`, `VYSU_BROWSER_PATH`/`VYSU_BROWSER_ARGS` | what is opened, what `--baseline-url @` points at, which viewports, which languages, what a report calls the API, which browser renders it |
| auth | `VYSU_AUTH`, `VYSU_AUTH0_*` | which connector signs a persona in, and its labels |
| the mobile app | `VYSU_MOBILE_KIND`, `VYSU_MOBILE_BUNDLE`, `VYSU_IOS_APP`, `VYSU_MOBILE_DIR`, `VYSU_MOBILE_ENV`, `VYSU_MOBILE_SCHEME`, `VYSU_MOBILE_READY_TEXT`, `VYSU_IOS_APP_PATH`/`VYSU_ANDROID_APK`, `VYSU_MOBILE_BUILD_IOS`/`_ANDROID`, `VYSU_IOS_DEVICE`/`VYSU_IOS_OLD_DEVICE`, `VYSU_ANDROID_AVD`/`VYSU_ANDROID_AVDS`, `VYSU_ANDROID_LOCALE` | which app on which devices, and how it is started |
| services | `VYSU_SERVICES`, `VYSU_SERVICE_<name>_CMD/_DIR/_PORT/_HEALTH/_ENV/_TIMEOUT/_STOP` | what `vysu up` and `vysu down` know |
| push | `VYSU_PUSH`, `VYSU_PUSH_WEBHOOK_URL`, `VYSU_FCM_SA` | which drivers, and what they need |
| video | `VYSU_THEME` | the brand of the explainer video |

An environment variable of the same name wins over the file, so `VYSU_ORIGIN=… vysu shots …`
overrides a value for one command. `vysu doctor` prints what is in force and where each value came
from.

## The browser

`agent-browser install` downloads **Chrome for Testing** and every session runs it headless. That
is the default, and it is deliberate: one pinned browser renders a page the same way on your
machine, on a colleague's and in CI, so a diff means a change in the app — and it opens no personal
profile, so no extension, no theme and no logged-in tab of your own ends up in a capture.

When you would rather see your own browser, name its executable:

```bash
vysu setup --browser "/Applications/Brave Browser.app/Contents/MacOS/Brave Browser"
vysu setup --browser default          # back to Chrome for Testing
```

`vysu setup` lists the Chromium-based browsers it finds in `/Applications` (Brave, Chrome, Edge,
Chromium — not Safari, not Firefox: agent-browser drives Chromium) and, with a terminal to answer,
offers to use one. The choice is written into `~/.vysu/machine.env`; a project can override it in
`.vysu/config` and a single command through the environment:

```bash
VYSU_BROWSER_PATH='/Applications/Google Chrome.app/Contents/MacOS/Google Chrome' vysu walk - home --url https://example.com/
VYSU_BROWSER_ARGS='--disable-blink-features=AutomationControlled'   # optional launch flags
```

**A personal browser may render a page differently from a baseline captured elsewhere** — a
different major version, different fonts, a different GPU path — so a `--baseline-url` diff is only
trustworthy when both sides ran the same browser. **Brave's shields alter pages** (blocked scripts,
stubbed APIs, changed layout): a capture taken through it is Brave's view of your app, not a
reviewer's. `vysu doctor` names the browser in force, and where the value came from.

## Native apps

The mobile side is not Expo-only. agent-device drives whatever is on the simulator or the emulator
through accessibility, so `mshot`, `mtap`, `mflow`, `mrec`, `textsize`, `appearance` and
`push ios` work on a Swift, Kotlin, Flutter or .NET app out of the box. `VYSU_MOBILE_KIND='native'`
(the default as soon as no `VYSU_MOBILE_DIR` is set) tells `up`, `mrelaunch` and `mlog` that there
is no Metro in front of the app: `up` boots the device, installs the app and tails its log,
`mrelaunch` launches and waits for a screen, and `mlog` reads that log instead of `metro.log`.

Four keys, all optional:

```bash
VYSU_MOBILE_KIND='native'
VYSU_IOS_APP_PATH='build/Build/Products/Debug-iphonesimulator/App.app'   # installed when missing
VYSU_ANDROID_APK='app/build/outputs/apk/debug/app-debug.apk'
VYSU_MOBILE_BUILD_IOS='xcodebuild -scheme App -sdk iphonesimulator -configuration Debug -derivedDataPath build'
VYSU_MOBILE_BUILD_ANDROID='./gradlew assembleDebug'
```

A smoke test that needs no app of your own — Apple's Settings is on every simulator:

```bash
mkdir -p /tmp/native-demo/.vysu && cd /tmp/native-demo
cat > .vysu/config <<'EOF'
VYSU_PROJECT='native-demo'
VYSU_MOBILE_KIND='native'
VYSU_MOBILE_BUNDLE='com.apple.Preferences'
VYSU_IOS_APP='Settings'
VYSU_MOBILE_READY_TEXT='General,Général'
VYSU_AUTH='none'
EOF
vysu up ios                              # boots the simulator, tails the app log
vysu ios open "Settings" --foreground     # the agent-device session
vysu mshot ios settings                   # a 1x capture, diffable
vysu mtap ios "General"
vysu mshot ios general --baseline settings
vysu mlog --tail 5                        # the Settings process's own log
vysu down applog && vysu prune --match 'settings' --match 'general'
```

## Writing an auth connector

The built-ins cover a hosted identity provider (`auth0`), a same-origin form (`form`) and no login
at all (`none`). For anything else, a commented template goes to `.vysu/auth.mjs`
(`connectors/auth/example.mjs`, which runs wherever vysu runs) or `.vysu/auth.sh`
(`connectors/auth/example.sh`, macOS and Linux), and is picked up on its own. The contract — the
functions to define, the primitives a connector may call, and how to test it — is in
[`connectors/auth/README.md`](connectors/auth/README.md).

## Updating

```bash
vysu update                    # the engine, the node tools, and what changed
```

`vysu update` fast-forwards the engine checkout (moving it off a tag onto the default branch when
it was pinned), prints the CHANGELOG entries since the version you were on, then checks
`agent-browser` and `agent-device` against `tools.env` — the versions this engine is known to work
with — and installs `<tool>@latest` when either is below. Run inside a project, it also says when
that project's copies of the skills are older than the engine:

```
! skills: installed 0.3.0 · engine 0.4.0 → vysu init --refresh-skills
```

`vysu init --refresh-skills` re-copies this engine's skills into `.claude/skills/` (or
`--skills-dir <dir>`) and touches nothing else — not `.vysu/config`, not your personas. Each
`SKILL.md` carries a `<!-- vysu-skill <version> -->` marker so `vysu doctor` can compare them.

A project that needs a given engine sets `VYSU_MIN_VERSION` in its `.vysu/config`: every command
then warns — and `vysu doctor` says so first — while the machine is below it. `vysu version` prints
the engine version, its sha, and the two tools' versions against their minimums.

## Agent skills

`vysu init` installs two skills into `.claude/skills/` (or `--skills-dir <dir>`), and
`vysu init --refresh-skills` re-copies them after an engine update:

- **`visual-check`**: the entry point of every look at the app, web or mobile. It starts with
  delegation: device work goes to a short-context checker sub-agent, with a brief and a report
  contract (`references/delegate.md`), because every device round trip re-reads the caller's whole
  context. Then the token-aware loop, `mdo` and the mobile verbs, reading a diff / report / sheet,
  notifications, a local stack, troubleshooting.
- **`demo-video`**: a recording turned into an explainer video: `rec`/`mrec` → `cut.json` →
  `vysu video`, in 16:9 and 9:16.

It also installs a **`visual-checker`** agent definition for Claude Code (`.claude/agents/`, or
`--agents-dir`). The model a checker runs on is a project setting per agent tool,
`VYSU_CHECKER_MODELS='claude=sonnet,codex=…'`, and `vysu checker` names it for whichever agent asks:
the skill itself names no model, so Claude Code, Codex and the next tool read the same text.

They hold no project value: they point at `vysu doctor`, `.vysu/config` and `vysu persona list`. A
project that has its own definition of done writes a thin overlay skill on top.

## Requirements

- **macOS** for the mobile side (agent-device drives the iOS simulator through Xcode). The web side
  should work anywhere bash and node do.
- **bash >= 3.2** (the macOS default), **node >= 22** for `agent-browser` and `agent-device`.
- **python3** with **Pillow** and **numpy** (`pip3 install --user numpy pillow`) for the diffs,
  contact sheets, stitching and exports.
- **ffmpeg** for `rec`, `mrec` and `video`.
- **Xcode** (iOS simulators, plus an older iOS runtime for the old phone) and the **Android SDK**
  with `cmdline-tools` — both optional, and only for the platform you actually check.
- Remotion is installed on the first `vysu video`, not before. There is no npm package for vysu
  itself: the install is `git clone` plus PATH.

`vysu setup` checks all of it and installs what it can; `vysu doctor` says what is still missing.
The versions of `agent-browser` and `agent-device` the engine is known to work with live in
[`tools.env`](tools.env); `setup` and `update` upgrade a machine that is below them.

## Status

`v0.5.0`: every command of the original tool, project-agnostic, Expo and native mobile apps,
validated end to end on iOS and Android; built for several agents sharing one Mac: a device pool
with claims renewed on use, `mdo` to drive a screen in one call, deep links, network, permissions
and bursts as verbs, per-device reload and logs, an isolated Metro when a phase needs one, and a
visual check that delegates to a checker sub-agent. The design note is
[docs/design.md](docs/design.md); the first consumer is the Nidz monorepo through its `.vysu/`
folder. Bugs and requests: GitHub issues.

## License

MIT — see [LICENSE](LICENSE).
