# Changelog

## Unreleased — the TypeScript engine

The engine is TypeScript now, run as it is by Node: it runs on Windows as well as macOS and Linux,
and it stopped paying a bash fork per helper, a Python start-up per image and a Node start-up per
device call. Every command was compared with 0.5.1 on real shots folders, pages and devices; the
lock, claim, device-choice and state files are unchanged, so both versions can run side by side.

- **macOS, Linux and Windows.** Node ≥ 22.18 and `npm ci --omit=dev` in the engine folder (for
  `sharp`), nothing to build: Node strips the types. No bash, Python, numpy, Pillow, perl, openssl,
  sqlite3, lsof or curl on the engine's paths any more. `install.ps1` installs on Windows (PowerShell
  5.1, `bin\vysu.cmd`); `install.sh` checks Node and installs the dependencies; `vysu update` re-runs
  `npm ci` when the lock file changed. Android works on the three systems, iOS on macOS (one line
  says so elsewhere). CI runs the engine on the three systems with Node 22 and 24.
  `VYSU_RUNTIME=bun` runs it on Bun instead.
- **Faster.** agent-browser is called by its native binary (8 ms a call instead of ~80), agent-device
  through its library (2–6 ms instead of ~150; `VYSU_AGENT_DEVICE=cli` forces the CLI), every image
  helper in process. Medians against 0.5.1 on a loaded machine: `report` 251 → 90 ms, `check`
  529 → 166 ms, `walk` 9.2 → 4.1 s, `shots` (2 sizes) 5.6 → 3.0 s, `sheet` (8 pages) 1.0 → 0.56 s,
  `doctor` 3.1 → 0.76 s, `devices` 1.18 → 0.28 s, `claim` 1.0 → 0.48 s, `mshot` 0.93 → 0.6 s, `mdo`
  (4 steps) 5.3 → 3.9 s, `diff` 284 → 36 ms, `fields` 206 → 6 ms.
- **Auth connectors and push drivers in JavaScript.** `.vysu/auth.mjs` (or `.js`, `.ts`) exports
  `describe`, `webLogin`, `webToken`, `mobileLogin` and optionally `mobileLogout`, each given the
  primitives; `connectors/auth/example.mjs` is the template `vysu init` copies for a custom one. A
  project push driver is `.vysu/push-drivers/<name>.mjs`. Both run on every system; the bash forms
  (`.vysu/auth.sh`, `<name>.sh`) keep working on macOS and Linux through a bridge. The FCM driver
  signs with Node's own crypto.
- **The same picture on every machine.** Contact sheets, marks, compare pages and frames draw their
  text from Inter, shipped with the engine, instead of the system font. Captures that get diffed are
  resampled exactly as Pillow did.
- **Fixed on the way.**
  - `shots` stops with exit 1 when a step of its batch fails; it used to carry on to exit 0 with a
    capture of the error page.
  - A label list is searched as whole labels: « Se connecter » was searched as « Se » and « connecter ».
  - `vysu claim <persona>` prints the page's url: the script that read it had a syntax error.
  - A `t:<key>` that does not resolve ends the flow instead of clicking an empty label; flow steps
    are no longer shell-expanded (`$VAR`, globs).
  - `rec` stops its recorder when vysu dies mid-take.
  - An unreachable push webhook says so, a failing iOS text size or appearance says why, and
    `vysu push <persona>` uses any project driver `VYSU_PUSH` lists.
  - `init` copies the connector template when « custom » is answered, and quotes an answer holding
    a `'`; `up` names a service folder that does not exist instead of timing out.
  - `persona add|set` write quoted values: a password holding a `$` or a quote reads back as typed.
  - `/usr/bin/time`, `nice`, `caffeinate` and the like in front of vysu are no longer taken for its
    owner (the command drove the config's device instead of the one just claimed); on Linux a Node
    process is named by its command, not « MainThread ».
  - `vysu adb shell` is interactive; `cache clear` skips a directory instead of dying on it; a
    missing option value is named instead of « unbound variable »; `vysu doctor | head` ends quietly;
    a helper that fails prints one line instead of a Python traceback.
- **Expo's floating tools button is hidden** on the devices vysu launches, with the dev menu's intro
  and its opening at launch: it sat in every capture over the app's top-right corner and took the
  taps meant for what lay under it (`tap Notifications` opened the dev menu). A shake still opens
  the menu.
- `VYSU_DEBUG=mobile` traces what a relaunch waited for.

## 0.5.1 — 2026-09-23

Two checker sub-agents of one session, one on a Pixel 4a and one on a Pixel 8: the 4a's commands
landed on the Pixel 8, a restart and an ANR dialog included, and the other checker nearly took them
for a regression.

- **One owner, two devices of a platform: every command names its device.** The owner is the agent
  process, and a session's sub-agents run under that same process, with the same environment:
  nothing tells them apart. Each claim became the owner's remembered device, so the last one any of
  them made was everybody's, and a claim, transparent to its own owner, kept no sibling out. While
  an owner holds two claims on a platform, a command that names no device (`VYSU_IOS_DEVICE` /
  `VYSU_ANDROID_AVD`, `--device` / `--avd`, `claim --any`, `mdo --devices`) is now refused, with
  the devices held and the prefix to add, instead of being sent to whichever was claimed last.
  `release` and `claim` without a name are refused the same way: they would have handed back or
  renewed a sibling's device.
- The claim of the second device says it on a `name it:` line, and its release hint carries the
  prefix. A claim records its device by name (`device=`), which is what a refusal lists.
- A project command (`vysu <name>`) passes on only the devices its call named: one resolved from
  memory used to travel in the environment as if named, and past the check.
- `visual-check` (SKILL, `references/mobile.md`, `references/delegate.md`) and the `visual-checker`
  agent say so: parallel checkers each get their own device in the brief and name it.

## 0.5.0 — 2026-09-23

From an audit of 62 agent sessions on one project (21-23/09): a third of their requests went to
driving devices, one press, one sleep, one snapshot at a time, inside contexts of 300-900k tokens;
agents wrote 63 helper scripts for what the engine lacked, ran 300 raw `adb` / `simctl` commands
outside its locks, and four of them at once fought over the same devices and the same Metro.

- **Delegate first.** The `visual-check` skill becomes the entry point of every look at the app,
  web or mobile, and starts with delegation to a short-context checker sub-agent:
  `references/delegate.md` holds the brief template and the report contract. `vysu checker` names
  the model to spawn it on for the agent tool that asks (`VYSU_CHECKER_MODELS='claude=…,codex=…'`,
  keyed by the caller vysu detects), and `vysu init [--agents-dir]` installs a Claude Code
  `visual-checker` definition built from it.
- **`vysu mdo`**: a screen driven in one call, one ✓ / ✗ line per step and the screen after it
  (labels, node delta, keyboard, focus). New steps, also in `mflow` and `mrec`: `wait`, `wait gone`,
  `wait idle`, `tap … --wait`, `fill`, `type`, `key`, `scroll-to`, `expect [no]`, `screen`, `open`,
  `net`, `perm`. `--devices` × `--textsize` runs the matrix and makes one sheet. `vysu mwait` and
  `vysu mtap --wait` replace sleeps.
- **A device pool.** `vysu claim ios|android --any` takes a free device (booted, then shut down,
  then an iOS clone), `--device` / `--avd` a named one; either becomes the owner's device, above the
  config. Claims last 20 minutes, are renewed by every use and dropped when their agent's process
  is gone. `vysu devices` lists who holds what; `vysu adb` / `vysu simctl` run the raw tools on your
  device under its lock; `release ios --delete-clone`, `devices --prune-clones`.
- **State as verbs.** `vysu mopen` (deep links, cold apps launched first, the open-in alert handled),
  `vysu mnet android offline|online`, `vysu mperm` (grant / deny / reset, iOS notifications
  included), `vysu mburst` (a transition as distinct 1x frames and a strip).
- **Relaunch, reload, logs.** `vysu mreload` reloads one device's JS in place; `mrelaunch` reopens a
  lost session, clears Expo's dev menu and intro, prints its time, and stops in seconds on a bundle
  that fails to build. `vysu mlog --errors` collapses repeats, `--device` reads this device's JS log,
  `VYSU_MLOG_IGNORE` drops known noise, and a bundling failure since the mark is printed first.
- **One Metro, or your own.** `VYSU_METRO_PORT` replaces every hard-coded 8081; `vysu up <platform>
  --isolated` gives an owner its own Metro from its own worktree; `vysu down metro` stops only the
  owner's.
- **Captures.** A capture under the same label is diffed against the one it replaces
  (`vs previous: unchanged` / zones changed); Android captures show the keyboard and system dialogs
  at 1x; `vysu report` reads mobile folders; `vysu sheet` is drawn with Pillow (no blank page),
  with `--only` and `--strip`.
- `bin/vysu` is parsed in one go: an engine edited while a command runs no longer runs a stray
  fragment (the old `r: unbound variable`).
- New keys: `VYSU_CHECKER_MODELS`, `VYSU_IOS_DEVICES`, `VYSU_IOS_MAX_CLONES`,
  `VYSU_ANDROID_MAX_RUNNING`, `VYSU_MOBILE_DEEPLINK`, `VYSU_METRO_PORT`,
  `VYSU_MOBILE_DISMISS_LABELS`, `VYSU_MLOG_IGNORE`.

## 0.4.1 — 2026-09-23

- **A persona name may hold `_`.** `vysu persona add tb_non_verifie` always wrote
  `VYSU_PERSONA_TB_NON_VERIFIE_*` and the login always found it, but `persona list`, `doctor` and
  `import` split names on the first `_`: twenty personas read back as one called `tb`. One reader
  now serves all three (`py/personas.py`): a persona is declared by its `_EMAIL` key, every other
  key belongs to the longest declared name it starts with, and an `_EMAIL` field under a declared
  name without a `_PASSWORD` of its own (`RESIDENT_BACKUP_EMAIL`) stays that persona's field.
- **`persona import` leaves behind what is nobody's.** A key that belongs to no persona (a fixture
  id kept next to the credentials, such as `E2E_RESIDENCE_ID`) used to become a persona `residence`;
  it is now skipped and named, never its value. The converted file is created mode 600 rather than
  chmod-ed after the write, and the command prints the personas it read.
- `persona add|set` refuse a name a variable cannot hold (`tb-x`): the line would not source.
- `vysu init` says, for each question, what the answer is for.

## 0.4.0 — 2026-09-22

From a first external user's first hour on a fresh Mac: they could not tell, from the output of
`vysu setup`, what was fine, what was blocking and what to run.

- **Every report line says one of three things, and shows it.** `lib/ui.sh`: `✓` fine, with the
  version · `!` missing and optional, with what it unlocks and the command · `✗` missing and
  required, with the command — green, yellow, red on a terminal, plain everywhere else
  (`NO_COLOR`, `--no-color`, a pipe). `vysu setup` ends on `ready: N · optional missing: M ·
  required missing: K`, then each command to run once, then the two next steps, and **exits 1 when
  something required is missing** (node, `agent-browser`, `agent-device`, python3 with numpy and
  Pillow). `vysu doctor` keeps its content and gets the markers; `install.sh` speaks the same
  grammar. `die` takes a second argument — the command to run next — printed on its own line.
- **A browser of your own.** `VYSU_BROWSER_PATH` (config key, environment, or `~/.vysu/machine.env`)
  drives an installed Chromium-based browser instead of the downloaded Chrome for Testing;
  `VYSU_BROWSER_ARGS` adds launch flags. `vysu setup` lists what `/Applications` holds (Brave,
  Chrome, Edge, Chromium) and offers one, `--browser <path|default>` is the scripted form, and
  `vysu doctor` names the browser in force. The default does not move: Chrome for Testing,
  headless, the same rendering on every machine and no personal profile touched — the README says
  why, and warns that a personal browser may not match a baseline captured elsewhere and that
  Brave's shields alter pages.
- **`~/.vysu/devices.env` is now `~/.vysu/machine.env`** — it holds a browser as well as devices.
  The old name is still read, just below it, so nothing breaks on an update.
- **The update path.** `tools.env` in the engine root names the `agent-browser` and `agent-device`
  versions this engine was checked against: `vysu setup` and `vysu update` install `<tool>@latest`
  when the machine is below one, `vysu doctor` warns, and `vysu version` prints both versions
  against their minimums. `vysu update` now reads: the pull, the CHANGELOG since, the tools, and a
  reminder when this project's skills are older than the engine. It also moves an engine pinned at
  a tag onto the remote's default branch instead of failing on a detached HEAD.
- **Skills carry their version.** `vysu init` stamps every `SKILL.md` it installs with
  `<!-- vysu-skill <version> -->` after the frontmatter; `vysu doctor` prints
  `skills: installed 0.3.0 · engine 0.4.0 → vysu init --refresh-skills` when they differ, and
  `vysu init --refresh-skills [--skills-dir <dir>]` re-copies them without touching `.vysu/config`.

## 0.3.0 — 2026-09-22

The validated release: every command exercised on a real Expo app, on a native release APK, on
Apple's Settings app, and a full film rendered with a project theme and the shipped soundtrack.

- Fixed: a project whose `.vysu/` does not sit inside `VYSU_PROJECT_DIR` — a config kept in a
  worktree while the project dir stays the checkout its relative paths point into — lost its theme,
  its `auth.sh`, its push drivers and presets and its `commands/`. The engine now exports
  `VYSU_DIR`, the folder the loaded config sits in, and everything of the project is looked up
  there; `render.ts` tries it before `$VYSU_PROJECT_DIR/.vysu`.
- Fixed: `vysu setup` with no terminal to answer its one question installed and created anyway —
  npm globals, a browser, an iOS simulator, a system image and an AVD per spec. With no tty it now
  reports and creates nothing; `--yes` asks for the installing run, `--dry-run` for a report.
- Fixed: `vysu doctor` ended on its `cache:` line, exit 1, whenever the state folder held no cache
  file — `grep` finding nothing is not a failure, and a fresh project is where doctor has most
  to say.
- Fixed: `vysu prune` left the toolkit's copy of every rendered take behind in
  `remotion/public/takes/`, which nothing else ever reclaimed — a whole clip per take.
- `vysu up <platform> --build` ends its log with `vysu: <platform> build exited <rc>`, so a `tail`
  answers « did it build? » without reading the build tool's own wording.
- Fixed: the AVD line of `vysu setup` printed the whole spec tail where the API level belongs.
- Docs: the `form` connector options, `VYSU_FCM_SCOPE` / `VYSU_FCM_ENDPOINT` and `VYSU_DIR` are in
  `docs/config.md`, `VYSU_UI_GLOBS` in `templates/config.example`, and `VYSU_THEME` is described
  where it acts — `vysu cut --draft` writes it into `cut.json`, a render reads it from there.

## 0.2.1 — 2026-09-22

- First Android run of the native mode, on an API 30 image: the app-log tail falls back to `-v uid`
  where `logcat --uid` does not exist, `up` waits for the system services after the locale change,
  and `VYSU_MOBILE_READY_TEXT` with several screens now matches (it never did, in expo mode too).
- A bare `--lang en` maps to `en-US` on Android and iOS, no longer `en-EN`.
- Known: Android honours one locale change per emulator; the second `mrelaunch --lang` is ignored.

## 0.2.0 — 2026-09-22

- **A soundtrack ships with the engine.** `digital-clouds.mp3` (Mixkit licence, see
  `remotion/public/music/LICENSE.md`) plays in every film whose cut names no `music`; `"music": null`
  keeps a film silent; another track needs its licence line first.
- **Native mobile apps.** `VYSU_MOBILE_KIND` is `expo` (a dev-client served by Metro) or `native`
  (Swift, Kotlin, Flutter, .NET — already built); the default is `expo` when `VYSU_MOBILE_DIR` is
  set and `native` otherwise, and `vysu doctor` prints it. Everything above agent-device — `mshot`,
  `mtap`, `mflow`, `mrec`, `textsize`, `appearance`, `push ios`, the auth connectors — already
  worked on any app and is untouched.
  - In native mode `vysu up ios|android` boots the device as before (locale, frozen status bar, GPU
    flags, the same locks), installs the app from `VYSU_IOS_APP_PATH` / `VYSU_ANDROID_APK` when the
    bundle is not on it (`--reinstall` forces it), starts a tail of the app's own log and ends on
    `→ vysu ios open "<app>" --foreground`: no Metro, no `adb reverse`.
  - `VYSU_MOBILE_BUILD_IOS` / `_ANDROID` are what `up <platform> --build` runs, in
    `VYSU_MOBILE_DIR` (the project root when it is unset), in the background, logged to
    `logs/<platform>-build.log`; in expo mode they default to the `npx expo run:` commands, so the
    two kinds share one code path.
  - `vysu mrelaunch` in native mode terminates, applies text size / appearance / language (iOS
    still takes `-AppleLanguages` per launch), launches and waits for `VYSU_MOBILE_READY_TEXT`, or
    five seconds when the project names none. It writes no `metro` field, and the `claim` /
    `doctor` state lines leave it out.
  - `vysu mlog [ios|android] [mark | --tail N]` reads `logs/<platform>-app.log` in native mode and
    `logs/metro.log` in expo mode: on iOS `simctl spawn … log stream` matched on the app's
    executable path, on Android `logcat --uid` of the package — both survive a relaunch, where a
    pid filter would not. `vysu down applog [ios|android]` stops the tails; `down metro` stays.
  - `vysu init` asks "mobile app: none / expo (Metro dev-client) / native" and writes the matching
    keys; `init_ask` now also accepts answers piped in, instead of silently taking every default
    when stdin is not a TTY.
- Fixed: `up ios|android` read "the app is not installed" from its own pipeline — `grep -q` leaves
  on the first match, `simctl listapps` dies of SIGPIPE and `pipefail` turned that into a missing
  app. The check is `simctl get_app_container` (which answers for a system app too) and a captured
  `pm list packages`.
- Fixed: `mrelaunch` no longer spends its fifteen snapshot tries waiting for a screen when no
  agent-device session is open on the device — there is nothing to read until `vysu <platform> open`.

## 0.1.0 — 2026-09-22

First release: the engine extracted from the Nidz monorepo's `tools/visual/nv`, project-agnostic.

- Design note and repository skeleton.
- **Lot 1 — the engine.** `bin/vysu` and `lib/*.sh` carry every `nv` command with the same
  arguments, output and semantics; `py/` holds the seven capture helpers and `remotion/` the
  explainer toolkit with a neutral `default` theme.
  - A project is a `.vysu/config` found by walking up from the cwd, with `VYSU_PROJECT_DIR` and an
    env-only `VYSU_CONFIG` override. An environment variable wins over the file; `vysu doctor`
    prints the values in force and where each came from. `templates/config.example` documents
    every key.
  - State lives under `VYSU_STATE` (default `~/.vysu/<project>`); browser sessions are
    `<project>-<persona>`, device sessions `<project>-<platform>-<device>`.
  - Personas replace the vault: `vysu persona add | set | list [--json] | import <file>
    [--prefix P] [--to file]`, mode 600, never printed.
  - Services are declarative (`VYSU_SERVICE_<name>_CMD/_DIR/_PORT/_HEALTH/_ENV/_TIMEOUT/_STOP`);
    `vysu up ios|android` stays in the engine.
  - Auth is a connector (`auth0` built in) and push is a set of drivers (`apns-sim`, `webhook`).
  - `vysu setup` asks before creating devices and writes `~/.vysu/devices.env`; `vysu init` writes
    a project config and installs the skills; `vysu update` / `vysu version`.
  - Renamed, with the old spelling still accepted and a deprecation line: `ipush` → `push ios`,
    `apush` → `push <persona>`, `token` → `auth token`. `seed` is not an engine command: an
    executable `.vysu/commands/<name>` is what `vysu <name>` runs, before the persona passthrough.
- **Lot 2 — the connectors.**
  - Auth connectors `none` (the engine default: the url is opened as it is, no token) and `form`
    (a same-origin login form — fields by label, then placeholder, then input type; submit by role
    and name; done when the page has left the login url — with `VYSU_FORM_EMAIL_LABELS`,
    `_PASSWORD_LABELS`, `_SUBMIT_LABELS`, `_TOKEN_JS`, and the same by accessibility label on
    mobile). `vysu doctor` says `auth: none (default)` when nobody chose one.
  - `vysu auth test <persona> [ios|android]` runs the connector once and prints each step that
    held; the web test uses a throwaway session (`<project>-authtest`, its own profile, no
    cookies) closed even on failure, the mobile one the real device — one install is one session.
  - `connectors/auth/README.md` is the connector contract and `example.sh` the commented template
    a project copies to `.vysu/auth.sh`; `connectors/push/README.md` the drivers' contract.
  - `py/fields.py` reads the text fields off a capture (boxes in points, top to bottom) and
    `mob_fields <platform>` is the device primitive around it: the `auth0` connector uses the
    accessibility path first and those boxes second, never the constants it used to tap at on the
    iOS 18 sign-in sheet.
  - Push driver `fcm`: FCM HTTP v1 with a service account (`VYSU_FCM_SA`), an RS256 assertion
    signed with `openssl` and no pip package, one send per platform the persona holds a token for
    (`VYSU_PERSONA_<NAME>_FCM_TOKEN_IOS` / `_ANDROID`), the preset being the FCM `message` body.
  - `vysu cut --draft` no longer writes the `milestones` key the strict montage schema rejects,
    and the engine's own defaults are neutral: the outro's call to action comes from the theme
    (optional `cta`, "Learn more" in `themes/default`) and a film's language from the take, then
    `VYSU_LANG`, then English.
  - A project may ship its own push driver in `.vysu/push-drivers/<name>.sh`; the `form`
    connector's mobile login takes `VYSU_FORM_HOME_TEXT` before `VYSU_MOBILE_READY_TEXT`.
