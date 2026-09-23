# vysu — design note

vysu (say "visu") looks at a real app the way a reviewer does, in tokens an agent can afford: one
browser session per persona whose login survives across runs, a simulator and an emulator driven by
label, screenshots and diffs written outside every repo, a 25-line text report before any image, and
a recorded flow that becomes a demo video. It grew inside the Nidz monorepo as `tools/visual/nv`;
this note was the contract for extracting it into a tool any project can adopt, with the Nidz apps as
its first consumer and no behaviour change for them, and it stays the record of why vysu is shaped
the way it is. How the engine's code is organised is [engine.md](engine.md).

Source of the extraction: `nidz-env/tools/visual/` (script `nv`, 2 400 lines of bash, seven Python
helpers, a Remotion toolkit) and the two skills `nidz-visual-check` and `nidz-demo-video`. Read them
before touching anything: the comments carry the reasons, and the reasons stay true.

## 1. Principles

- **Engine vs project.** The engine knows nothing about a given app. Everything an app decides
  (origin, auth, language key, bundle id, services, personas, push payloads, brand) lives in a
  `.vysu/` folder at the root of that project, found by walking up from the cwd like `.git`.
- **Agent-agnostic.** Claude, Codex, a human in a terminal: same commands, same reports. No hook or
  skill is required for vysu to work; they are conveniences installed by `vysu init`.
- **Text first.** A capture is read by a model only when the report says which one to read. Every
  design choice of `nv` about tokens (1x mobile captures, contact sheets under 1 568 px, `walk`
  replacing six calls) is kept as is.
- **No behaviour change for Nidz.** Every `nv` command keeps its semantics under `vysu`. The
  non-regression is the two flows `web-tour` and `mobile-tour` plus a `walk` against prep.
- **Small dependency surface.** Node ≥ 22.18, which runs the engine and `agent-browser` and
  `agent-device`, and sharp (`npm ci --omit=dev` in the engine) for the images. Remotion is
  installed on first `vysu video`. No npm package for vysu itself: install is `git clone`,
  `npm ci` + PATH.
- **Secrets never enter a repo.** Personas and service accounts live under `~/.vysu/<project>/`
  with mode 600. Nothing prints a password.

## 2. Repository layout

```
vysu/
├── bin/vysu, bin/vysu.cmd    launchers (sh, cmd) of src/cli.ts
├── src/                      the engine, TypeScript run as it is: cli, commands, cmd/ (one module per
│                             command), core/, web/, auth/, mobile/, push/, img/, services/, setup/,
│                             connectors/ (the built-in auth connectors and push drivers)
├── connectors/
│   ├── auth/                 README.md (the contract), example.mjs, example.sh (the bash form)
│   └── push/                 README.md (the contract), example.mjs
├── remotion/                 the explainer toolkit; themes/default only (neutral, Inter)
├── skill/
│   ├── visual-check/         SKILL.md + references/ (generic, English)
│   └── demo-video/           SKILL.md
├── templates/                config.example, agents-snippet.md, agents/, hooks/stop-reminder.{sh,mjs}
├── docs/                     design.md (this note), engine.md, config.md
├── test/, scripts/, assets/
├── install.sh, install.ps1
└── README.md LICENSE VERSION CHANGELOG.md tools.env package.json
```

`bin/vysu` is the single entry point. [engine.md](engine.md) has the layout of `src/` folder by
folder, the APIs the commands are built on and the contracts between the parts.

## 3. Runtime layout

Per project, under `VYSU_STATE` (default `~/.vysu/<project>/`):

```
personas.env      VYSU_PERSONA_<NAME>_EMAIL / _PASSWORD + free keys, mode 600
shots/<name>/     captures, diffs, sheets, meta.json, takes (clip, events.json, cut.json, renders)
logs/             web.log api.log metro.log <platform>-build.log emulator logs
locks/ claims/    as today (mkdir locks, claims with owner and expiry)
<device state>    ios-device, android-avd, udid caches, scale caches, state-<platform>-<device>.env
```

Browser sessions belong to agent-browser (`~/.agent-browser/sessions/`) and are named
`<project>-<persona>`; device sessions `<project>-<platform>-<device>`. For Nidz, `VYSU_PROJECT=nidz`
and `VYSU_STATE=~/.nidz/visual` keep every session, shot and login in place.

Per consumer project, `.vysu/`:

```
config                KEY=value lines read like a shell file, the only required file
auth.mjs              optional custom auth connector, or .js / .ts / .sh (else a built-in named in config)
push/<preset>.json    push payload templates
push-drivers/<n>.mjs  optional project push drivers, or .sh; a name shared with a built-in wins over it
commands/<name>       executables: `vysu <name>` runs them when the engine has no such command
themes/<name>/        theme.json + brand/ + fonts/ for the video toolkit
flows/                scripted flows, any extension
```

Discovery: `VYSU_PROJECT_DIR` if set, else the first ancestor of `$PWD` holding `.vysu/config`.
Without one, vysu still works for anonymous web captures (`vysu - open <url>`, `shots`, `sheet`,
`walk` on public pages) with project `default`; every command needing a persona, a service or a
connector dies with "no .vysu/config here (vysu init)".

## 4. Config contract

All keys are `VYSU_*`; an environment variable of the same name wins over the file. Unknown keys
are ignored. `vysu doctor` prints the resolved values and where each comes from.

| Key | Meaning | Nidz value |
|---|---|---|
| `VYSU_PROJECT` | session prefix and state folder name | `nidz` |
| `VYSU_STATE` | state folder | `~/.nidz/visual` |
| `VYSU_ORIGIN` | default web origin | `http://localhost:8100` |
| `VYSU_LOGIN_PATH` | path the web login starts at | `/auth/login` |
| `VYSU_BASELINE_ORIGIN` | `--baseline-url` shorthand: `--baseline-url @` means same path there | `https://next.prep.nidz.fr` |
| `VYSU_SIZES` | default viewports | `360x800,768x1024,1280x800,1440x900` |
| `VYSU_LANGS` / `VYSU_LANG` | languages the app offers, the default one | `fr,en` / `fr` |
| `VYSU_LANG_STORAGE_KEY` | localStorage key holding the language; empty = `lang` unsupported | `nidz.language` |
| `VYSU_LOCALES` | folder with `<lang>.json` for `t:<key>` labels (relative to the project dir) | `apps/nidz-next-apps/packages/i18n/locales` |
| `VYSU_WEB_REPO` | git checkout whose sha and branch go into `meta.json` | `apps/nidz-next-apps` |
| `VYSU_API_PATTERN` | request path prefix that identifies the API in the network log | `/api/v1/` |
| `VYSU_API_HOSTS` | `host=label` pairs for the API label in reports | `localhost:8080=local api.prep.nidz.fr=prep` |
| `VYSU_AUTH` | built-in connector name, or a path; default `none` (no login) | `auth0` |
| `VYSU_AUTH_*` | connector options, documented by each connector | see § 6 |
| `VYSU_MOBILE_KIND` | `expo` (dev-client + Metro) or `native` (already built, no bundler); default `expo` when `VYSU_MOBILE_DIR` is set, else `native` | `expo` |
| `VYSU_MOBILE_BUNDLE` | app id on both platforms | `fr.nidz.app.next.prep` |
| `VYSU_IOS_APP` | app name on the iOS simulator | `Nidz (prep)` |
| `VYSU_MOBILE_DIR` | Expo app folder (relative to the project dir) | `apps/nidz-next-apps/apps/mobile` |
| `VYSU_MOBILE_ENV` | env exported to Metro and the native build | `NIDZ_ENV=prep` |
| `VYSU_IOS_APP_PATH` / `VYSU_ANDROID_APK` | native: the `.app` (built for `iphonesimulator`) and the `.apk` `up` installs when the device has none | — |
| `VYSU_MOBILE_BUILD_IOS` / `_ANDROID` | what `up <platform> --build` runs; in expo mode they default to the `npx expo run:` commands | — |
| `VYSU_MOBILE_SCHEME` | dev-client scheme handed to Metro's URL | `exp+nidz` |
| `VYSU_MOBILE_READY_TEXT` | texts that prove the app has booted, comma-separated: what `mrelaunch` and a mobile login wait for instead of a delay | `Se connecter,Bienvenue,Menu,…` |
| `VYSU_IOS_DEVICE` / `VYSU_IOS_OLD_DEVICE` | simulators, recent and old | `iPhone 17 Pro` / `Nidz iPhone SE (iOS 18)` |
| `VYSU_ANDROID_AVD` / `VYSU_ANDROID_AVDS` | default AVD, and the specs `vysu setup` creates | `nidz_pixel8_api36` / the three specs of `nv setup` |
| `VYSU_ANDROID_LOCALE` | locale forced on the emulator at boot; empty = untouched | `fr-FR` |
| `VYSU_SERVICES` | names of the services `up`/`down` know | `web api db` |
| `VYSU_SERVICE_<name>_CMD/_DIR/_PORT/_HEALTH/_ENV/_STOP` | one service, § 7 | |
| `VYSU_PUSH` | push drivers enabled, comma-separated | `apns-sim,webhook` |
| `VYSU_PUSH_WEBHOOK_URL` / `VYSU_FCM_SA` | driver options, § 6 | |
| `VYSU_THEME` | video theme name | `nidz` |
| `VYSU_MIN_VERSION` | the engine version this project needs; `doctor` and every command warn below it | `0.1.0` |

Engine-wide defaults (the current `nv` values) apply when a key is missing: sizes, devices, AVD
specs, iPhone SE runtime, fps, sheet edge. `templates/config.example` lists every key with its
default and a one-line comment; `vysu init` writes a config from it.

## 5. Command surface

Every `nv` command exists under `vysu` with the same arguments and output. Renames, all with the old
spelling accepted for one minor version and a deprecation line on stderr:

| nv | vysu | Note |
|---|---|---|
| `nv <persona> …` | `vysu <persona> …` | passthrough to agent-browser, unchanged |
| `nv ipush` | `vysu push ios <preset>` | driver `apns-sim` |
| `nv apush` | `vysu push <persona> <preset>` | driver `webhook` or `fcm` |
| `nv seed` | project command `.vysu/commands/seed` | Nidz only |
| `nv token` | `vysu auth token <persona>` | connector |
| `nv login` / `mlogin` | unchanged, dispatched to the connector | |
| `nv lang` | unchanged; dies when `VYSU_LANG_STORAGE_KEY` is empty | |

New commands: `vysu init`, `vysu persona add|set|list|import`, `vysu auth test <persona> [ios|android]`,
`vysu push …`, `vysu update`, `vysu version`. `vysu setup` and `vysu doctor` change as in § 9.

Flow files keep their grammar (`go`, `click`, `fill`, `press`, `sleep`, `shot`, `check`, `viewport`,
`tap`, `relaunch`, any raw agent-browser or agent-device line). `t:<key>` resolves through
`VYSU_LOCALES`.

## 6. Connectors

A connector is a module (`.mjs`, `.js`, `.ts`) exporting its functions, each handed the primitives
as its first argument, or a bash file defining the same functions, run through a bridge where there
is a bash. It may only call the primitives below and its own helpers, so a connector written for
one app runs unchanged on another machine.

### 6.1 Auth

Contract (`connectors/auth/README.md`, with `example.mjs` as a commented template, `example.sh` for
the bash form, whose functions are `auth_describe`, `auth_web_login` and so on):

```js
describe(v)                          // one line for doctor: which system, which options are set
webLogin(v, persona, url)            // session open on <url>; returns with the page logged in on the url's origin
webToken(v, persona)                 // the access token, or undefined
mobileLogin(v, platform, persona)    // app in the foreground; returns logged in, on the app's home
mobileLogout(v, platform)            // optional; used by mlogin when another persona is signed in
```

Primitives a connector is handed (`src/auth/context.ts`; the README names their bash spellings):
`web(persona, …args)`, `webClickAny(persona, …names)` (first visible button by role and name),
`mob(platform, …args)`, `mobPressIf(platform, label)`, `mobWaitText(platform, text, ms)`,
`mobFields(platform)` (§ 6.3), `personaVar(persona, KEY)`, `cfg(KEY, default)`, `die`, `log`.
Passwords go through `web … fill` and `mob … type` only; a connector never echoes them.

Built-ins:

- `auth0` — the current flow, unchanged in behaviour: identifier-first Universal Login, two visible
  submit buttons found by role and name, `auth0-spa-js` cache for the token, the mobile sequence
  with its system dialogs (push permission, Safari "save password", Chrome first run, Expo dev
  menu, dev-launcher deep link). Options: `VYSU_AUTH0_DOMAIN` (default: any `*.auth0.com`),
  `VYSU_AUTH0_SIGNIN_LABELS` (default `Se connecter,Sign in`), `VYSU_AUTH0_CONTINUE_LABELS`
  (`Continuer,Continue`), `VYSU_AUTH0_DOOR_TEXT` (mobile door screen text, `Se connecter`),
  `VYSU_AUTH0_PASSWORD_TEXT` (the password page's own text, `mot de passe`),
  `VYSU_AUTH0_HOME_TEXT` (mobile text that proves the login, `Bienvenue`), `VYSU_AUTH0_MENU_LABEL`
  / `VYSU_AUTH0_LOGOUT_LABEL` for the mobile logout, `VYSU_AUTH0_AFTER_LOGIN_LABELS` (buttons
  pressed if they show up after login, `Entrer directement,Retour à l'accueil`).
- `form` — a same-origin form: fields found by label, then placeholder, then `type=email` /
  `type=password`; submit by role button and name; success = navigation away from the login url.
  Options: `VYSU_FORM_EMAIL_LABELS`, `VYSU_FORM_PASSWORD_LABELS`, `VYSU_FORM_SUBMIT_LABELS`,
  `VYSU_FORM_TOKEN_JS` (an expression evaluated in the page that prints the token, optional).
  Mobile: the same by accessibility labels.
- `none` — no login; `webLogin` just opens the url and `webToken` hands back nothing. For
  static sites and Storybooks, and the engine's default: without a config, or with no `VYSU_AUTH`
  in one, that is the connector in force, and `doctor` says `auth: none (default)`.

`vysu auth test <persona> [ios|android]` runs the connector once with a throwaway session name
(`<project>-authtest`), prints each step as it passes, and closes the session. Its exit code is the
verdict.

### 6.2 Push

Contract (`connectors/push/README.md`): `describe(v)` and `send(v, { target, preset, platform,
fields })` (`push_describe`, `push_send` in the bash form). Presets are files
`.vysu/push/<preset>.json`; the driver substitutes `{{field}}` placeholders from `--field` and from
the persona's variables.

- `apns-sim` — `simctl push` on the running iOS simulator with the preset as the APNs payload
  (today's `ipush`). The three Nidz presets move to `nidz-env/.vysu/push/`.
- `fcm` — a real FCM HTTP v1 send with a service account (`VYSU_FCM_SA`, a path under the state
  folder) to the token held by the persona (`VYSU_PERSONA_<NAME>_FCM_TOKEN_IOS` / `_ANDROID`). The
  JWT is signed with `node:crypto`, no package. The preset holds the FCM message body, and the
  driver adds the `token`. `VYSU_FCM_ENDPOINT` replaces the endpoint, for tests only.
- `webhook` — POST `{email, preset, platform, fields}` to `VYSU_PUSH_WEBHOOK_URL`, prints the
  results the endpoint returns (today's `apush`, the Nidz cockpit being the endpoint).

`vysu push ios <preset>` selects `apns-sim`; `vysu push <persona> <preset>` selects the first of
`fcm` / `webhook` enabled in `VYSU_PUSH`.

### 6.3 Mobile field detection

The `fields` helper (`src/img/fields.ts`, `<screenshot.png> [--scale N]`) prints the text fields it
sees, as JSON boxes in points, top to bottom: rounded rectangles with a continuous border, wider
than 50 % of the screen, 36 to 72 pt tall, light interior. It is the replacement for the "57 % /
65 %" blind flow on the iOS 18 simulator, where agent-device cannot read the SafariViewService
sheet. `mobFields(platform)` wraps it (capture, scale, print). The `auth0` connector uses the accessibility path first and falls back
to the detected boxes, never to constants. Validation: on the old iPhone, open the door, tap the
sign-in button, capture, and check that the first box is the e-mail field; the same on the recent
iPhone where accessibility works, to compare both answers. One real `mlogin` at most, as every login
consumes the SSO and rotates the refresh token.

### 6.4 Project commands

`vysu <name> …` with no engine command of that name runs `.vysu/commands/<name>` when it exists and
is executable, with every resolved `VYSU_*` value exported, `VYSU_ENGINE` set to the engine dir and
`VYSU_PROJECT_DIR` to the project. The Nidz `seed.py` becomes `.vysu/commands/seed`, reading its
personas through `vysu persona list --json` and tokens through `vysu auth token`.

## 7. Services

`up` and `down` know no stack. A service is declared in the config:

```bash
VYSU_SERVICES="web api db"
VYSU_SERVICE_web_CMD="pnpm --filter web exec vite --port 8100 --strictPort"
VYSU_SERVICE_web_DIR="apps/nidz-next-apps"
VYSU_SERVICE_web_PORT=8100
VYSU_SERVICE_web_HEALTH="http://localhost:8100/"       # url polled, or `port` for a TCP listen check
VYSU_SERVICE_web_ENV="VITE_API_URL=http://localhost:8080"   # only with `up web --api local`: see below
VYSU_SERVICE_web_TIMEOUT=30
VYSU_SERVICE_db_CMD="make -s dev-up"
VYSU_SERVICE_db_HEALTH="docker exec nidz-db pg_isready -U nidz -q"   # a command, when it holds no `://`
VYSU_SERVICE_db_STOP="make -s dev-down"                 # default: kill what listens on PORT
```

`vysu up <name> [--env k=v]…` starts it in the background with `nohup`, logs to `logs/<name>.log`,
waits for HEALTH up to TIMEOUT, prints the one-line summary. `vysu up all` runs them in the order of
`VYSU_SERVICES`. The `--api local` switch of `nv up web` becomes `vysu up web --env
VITE_API_URL=http://localhost:8080`, with the Nidz config documenting that spelling; the value that
`web_api` shows in reports keeps coming from the network log, then from the `web.api` state file
that `up` writes with the `--env` values.

Mobile targets stay in the engine (they are Expo and simulator mechanics, not app logic):
`vysu up ios|android [--build] [--device|--avd]` reads `VYSU_MOBILE_DIR`, `VYSU_MOBILE_ENV`,
`VYSU_MOBILE_BUNDLE`, `VYSU_IOS_APP`, `VYSU_ANDROID_LOCALE`. The dev-client search paths (Xcode
DerivedData, `android/app/build/outputs/apk/debug/app-debug.apk`) are Expo conventions and stay.

### 7.1 Native mobile apps (addendum)

`VYSU_MOBILE_KIND` splits the mobile targets in two. Everything that is Metro — the bundler
started by `up`, `adb reverse`, the dev-launcher hand-off of `mobileLoadBundle`, the « Bundled »
line `mrelaunch` waits for, `down metro` — happens in **expo** mode only. In **native** mode (a
Swift, Kotlin, Flutter or .NET app, already built) the same commands do strictly less:

- `up ios|android` boots the device exactly as before (locale, frozen status bar, GPU flags, the
  same locks), installs the app from `VYSU_IOS_APP_PATH` / `VYSU_ANDROID_APK` when the bundle is
  not on the device or `--reinstall` is given, starts the app-log tail, and ends on
  `→ vysu ios open "<app>" --foreground`. `--build` runs `VYSU_MOBILE_BUILD_IOS` / `_ANDROID` in
  the background, logged to `logs/<platform>-build.log`, the way the `expo run:` command already
  was — those two keys are what the expo default now goes through.
- `mrelaunch` terminates, applies text size / appearance / language (iOS still takes
  `-AppleLanguages` per launch), launches, then waits for `VYSU_MOBILE_READY_TEXT` or five seconds.
  It writes no `metro` field, and the `claim` / `doctor` state lines leave it out.
- `mlog [ios|android] [mark | --tail N]` reads `logs/<platform>-app.log`, written by the tail
  `up` started: on iOS `simctl spawn <udid> log stream --style compact --predicate
  'processImagePath ENDSWITH "/<executable>" AND eventType == "logEvent" AND messageType != debug'`
  (the executable comes from the app bundle's `CFBundleExecutable`; matching the path rather than
  the pid is what survives a relaunch), on Android `adb logcat -v time -T 1 --uid <uid of the
  package>` (same reason: a uid outlives every process the app starts). `down applog [ios|android]`
  stops them.

Everything above agent-device — `mshot`, `mtap`, `mflow`, `mrec`, `textsize`, `appearance`,
`push ios`, the auth connectors — is unchanged: it never knew what was behind the app.

## 8. Devices

Defaults are the current ones: `iPhone 17 Pro` and an iPhone SE 3rd gen on iOS 18 named
`vysu iPhone SE (iOS 18)` (Nidz keeps `Nidz iPhone SE (iOS 18)` through its config), AVDs
`vysu_pixel8_api36`, `vysu_pixel10pro_api36`, `vysu_pixel4a_api30` with the same specs as `nv setup`
(Nidz keeps its `nidz_*` names). `vysu setup` prints the list before creating anything and offers to
change it: interactive when stdin is a TTY (`Keep these? [Y/n]`, then one prompt per device), and
through `--ios-device`, `--ios-old-device`, `--android-avds "<spec>;<spec>"` otherwise. The answer
is written to the global file `~/.vysu/devices.env`, below the project config in precedence.

## 9. Setup, init, doctor, update

`vysu setup` (machine-wide, idempotent, ~90 % of the onboarding):

1. Node ≥ 22.18 and the engine's dependencies (prints the install line of the machine — brew, apt
   or dnf, winget — when missing);
2. `agent-browser` and `agent-device` installed globally through npm, Chrome for Testing downloaded;
3. Xcode: simulators present, iOS 18 runtime present or the `xcodebuild -downloadPlatform` line;
4. Android SDK: cmdline-tools present, system images downloaded, AVDs created with the device
   dialog of § 8;
5. prints what remains for the user: personas, `vysu init` in the project, the dev-client builds.

`vysu init` (in a project, interactive with defaults, `--yes` to accept them):

1. project name (folder name), web origin, login path, baseline origin;
2. auth connector among the built-ins, or "custom" which copies `example.mjs` to `.vysu/auth.mjs`;
3. mobile: yes/no, then bundle id, app name, Expo folder;
4. push: drivers, and the webhook url when chosen;
5. writes `.vysu/config` from the template, `.vysu/push/example.json`, `.vysu/commands/README`;
6. installs the skills where an agent will find them: `.claude/skills/visual-check` and
   `demo-video` when `.claude/` exists (or `--skills-dir <dir>`), prints the `templates/agents-snippet.md`
   paragraph to paste into `AGENTS.md` / `CLAUDE.md`, and the Stop hook line for those who want it;
7. ends with the four things only the user can do: `vysu persona add <name>`, `vysu login <name>`,
   `vysu up ios --build` when mobile, the service account for `fcm`.

`vysu doctor`: tools and versions, engine version against `VYSU_MIN_VERSION`, resolved config with
origins, the auth connector's `describe`, each push driver's `describe`, personas by name,
sessions, devices, locks and claims, state folder size. `vysu update`: `git pull --ff-only` in the engine dir, then
prints the CHANGELOG entries since the previous version. `vysu version`: the VERSION file and the
short sha.

**0.4 addendum — one report grammar, the browser, and staying up to date.**

`src/core/ui.ts` gives every report line one of three shapes and no fourth: `ok` (✓, green, with
the version), `warn` (!, yellow, optional and missing — what it unlocks, and the command), `miss`
(✗, red, required and missing — the command). `head` opens a section in bold, `summary` closes on
`ready: N · optional missing: M · required missing: K`, then each distinct command once, then the
next steps; the exit code is 1 as soon as something required is missing
(`allRequiredPresent()`). Colours
follow the tty of the stream they go to, and drop out under `NO_COLOR` or `--no-color`. `die` takes
a second argument, the command to run next, on its own line. `setup`, `doctor` and `install.sh`
(which inlines the same six functions, since it runs before the engine exists) speak only that.

The browser is a choice with a default that stays: Chrome for Testing, downloaded by agent-browser
and driven headless, because one pinned browser is what makes a diff mean a change in the app and
what keeps a personal profile out of a capture. `VYSU_BROWSER_PATH` — config key, environment, or
`~/.vysu/machine.env` — names an installed Chromium-based browser instead, passed to every session
and to the batch as `--executable-path` (`VYSU_BROWSER_ARGS` → `--args`); `vysu setup` lists what
`/Applications` holds and offers one, `--browser <path|default>` is the scripted form, `doctor`
names the one in force. `~/.vysu/devices.env` becomes `~/.vysu/machine.env` — it now holds a
browser as well as devices — and the old name is still read, just below it.

Staying up to date is three moving parts, all visible. `tools.env` in the engine root names the
`agent-browser` and `agent-device` versions this engine was checked against; `setup` and `update`
install `@latest` when the machine is below one, `doctor` and `version` only say so. `init` stamps
every skill it copies with `<!-- vysu-skill <version> -->` after the frontmatter, so `doctor` can
print `skills: installed 0.3.0 · engine 0.4.0 → vysu init --refresh-skills`; `--refresh-skills`
re-copies them and touches nothing else. `update` ends on that same line, and moves an engine
pinned at a tag onto the remote's default branch rather than failing on a detached HEAD.

## 10. Video toolkit

`remotion/` moves whole. `themes/default/theme.json` is neutral: Inter only, no logo (the header and
the outro hide the logo block when `logo` is absent, `schema.ts` makes it optional), a grey-blue
palette. A project theme lives in `themes/<name>/` beside the config the engine loaded and is
resolved first by `render.ts` (`VYSU_DIR`, which is `$VYSU_PROJECT_DIR/.vysu` unless `VYSU_CONFIG`
names a config elsewhere), then in the engine. `vysu cut --draft` writes `VYSU_THEME` into `cut.json`. The
`theme.test.ts` that mirrors `@nidz/tokens` leaves the engine: it becomes
`nidz-env/.vysu/themes/nidz/check.mjs`. `vysu video` runs `npm ci` in `remotion/` when
`node_modules` is missing, once, and says so.

## 11. Skills

`skill/visual-check/SKILL.md` is the generic version of `nidz-visual-check`, in English: the token
loop, the commands, the don'ts, the references (`diff.md`, `demo.md`, `mobile.md`, `notifications.md`,
`local-stack.md` generalised to "a local stack", `troubleshooting.md`). It holds no project value:
where the Nidz skill names personas, origins or prep, the generic one says "run `vysu doctor`" and
"the project's `.vysu/config`". `skill/demo-video/SKILL.md` likewise. A project that needs its own
DoD writes a thin skill on top (Nidz keeps `nidz-visual-check` as that overlay, reduced to personas,
prep, E2E residence and the MR rules).

## 12. Install

```bash
git clone https://github.com/Marius-courquin/vysu ~/vysu && (cd ~/vysu && npm ci --omit=dev)
echo 'export PATH="$HOME/vysu/bin:$PATH"' >> ~/.zshrc && exec zsh
vysu setup
cd ~/my-project && vysu init
vysu persona add alice && vysu login alice
vysu walk alice home --url http://localhost:3000/
```

`install.sh` does the same after its Node check. `vysu update` pulls, and runs `npm ci --omit=dev`
again whenever the pull changes `package-lock.json`. A tag per release (`v0.1.0`), CHANGELOG kept by
hand. On Windows, `install.ps1` does the same from PowerShell and adds `<engine>\bin` (where `vysu`
is `vysu.cmd`) to the user PATH:

```powershell
irm https://raw.githubusercontent.com/Marius-courquin/vysu/main/install.ps1 | iex
```

## 13. Out of scope for 0.1

- Windows and Linux support beyond "should work for web" (agent-device needs macOS for iOS) — in
  scope since the engine is TypeScript, § 14.
- A Playwright or MSW harness of any kind: vysu looks at the real app only.
- Publishing to npm or Homebrew. Clone and PATH is the install until someone asks.
- Multi-project state sharing, cloud rendering, a web UI over the shots.

## 14. The engine in TypeScript

The cost of a tool like this is in its plumbing — a fork per config value, a `ps` per level of the
owner walk, an interpreter's start-up per image helper, an `lsof` per port question — and in the
systems it cannot run on. The engine is TypeScript that Node runs as it is (type stripping, Node ≥
22.18, no build step), and keeps every observable behaviour from one version to the next: the same
commands and options, the same lines on stdout and stderr, the same exit codes, the same files
(shots folders, `meta.json`, `events.json`, verdicts, locks, claims, device choices, state files),
so two versions installed side by side share one state folder and wait on each other's locks.
[engine.md](engine.md) is the contributor's map of it.

- **One file knows the operating system.** `src/core/host.ts` answers the questions whose answer
  differs: the process table and a process's name (Linux `/proc`, macOS one `ps`, Windows a
  helper, below), which processes listen on a port (`lsof`, else `ss`, else `netstat -ano`), how a
  command line from the config runs (`/bin/sh -c`, or `cmd.exe /d /s /c "…"` handed over verbatim),
  how an npm-installed CLI starts (a `.cmd` shim on Windows goes through `cmd.exe`: Node refuses to
  spawn one directly since April 2024), where a tool is (`PATHEXT` on Windows), how a file is
  opened for a human. Everything above it is the same code everywhere; iOS says in one line that it
  needs a Mac.
- **The Windows helper.** `owner()` walks up from vysu to the agent that drives it on every locked
  command, so the process table is read once per command — and PowerShell's CIM query costs 0.5 to
  1 s. A C# helper of a hundred lines, compiled on first use with the `csc.exe` every Windows 10 / 11
  carries (.NET Framework 4) and kept in `%LOCALAPPDATA%\vysu`, lists it through
  `CreateToolhelp32Snapshot` in about 20 ms. It also starts what outlives vysu (a service, Metro, an
  emulator) with none of vysu's handles: Node hands a child every inheritable handle, the pipe an
  agent reads vysu through included, and `vysu up` would not return before the service stopped. CIM
  and Node's own detached spawn remain the fallbacks where it cannot be built.
- **The config is read, not sourced.** `src/core/shellenv.ts` reads `KEY=value` lines the way a
  shell does (quotes, `$VAR`, `${VAR:-x}`, `export`, several per line); a line it cannot follow
  goes to a real bash on macOS and Linux, and is named where there is none.
- **Contracts between the parts.** `src/web/api.ts` and `src/mobile/api.ts` are what the rest of
  the engine calls on the browser and device code (a persona's session, a device's state, `up
  ios|android`, the doctor's lines); `src/img/tools.ts` runs an image helper by name with a command
  line, in process, the way every caller has always called it.
- **Faster where it was free.** Independent questions are asked at once (`setup` 1.9 s → 0.4 s,
  `doctor` 1.5 s → 0.5 s on the Nidz project), a driver's version is read from its `package.json`,
  a port is answered by a connection rather than `lsof`, a url by `fetch` rather than `curl`, an
  image helper costs no interpreter start-up.
- **Tested against a reference.** `test/parity/` runs a reference engine (`VYSU_REF`, a bash vysu
  such as v0.5.1) and this one on the same inputs in mirrored scratch folders and compares stdout,
  stderr, exit codes and the files written; `test/platform/smoke.ts` is what CI runs on the three
  systems.
