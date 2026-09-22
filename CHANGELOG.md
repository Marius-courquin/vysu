# Changelog

## Unreleased

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
