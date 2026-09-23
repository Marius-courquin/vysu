# Changelog

## 0.4.1 — 2026-09-23

- **A persona name may hold `_`.** `vysu persona add tb_non_verifie` always wrote
  `VYSU_PERSONA_TB_NON_VERIFIE_*` and the login always found it, but `persona list`, `doctor` and
  `import` split names on the first `_`: twenty personas read back as one called `tb`. One reader
  now serves all three (`py/personas.py`): a persona is declared by its `_EMAIL` key, every other
  key belongs to the longest declared name it starts with, and an `_EMAIL` field under a declared
  name without a `_PASSWORD` of its own (`RESIDENT_BACKUP_EMAIL`) stays that persona's field.
- **`persona import` leaves behind what is nobody's.** A key that belongs to no persona — a fixture
  id kept next to the credentials, `E2E_RESIDENCE_ID` — used to become a persona `residence`; it is
  now skipped and named (never its value). The converted file is created mode 600 rather than
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
