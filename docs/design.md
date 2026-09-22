# vysu — design note

vysu (say "visu") looks at a real app the way a reviewer does, in tokens an agent can afford: one
browser session per persona whose login survives across runs, a simulator and an emulator driven by
label, screenshots and diffs written outside every repo, a 25-line text report before any image, and
a recorded flow that becomes a demo video. It grew inside the Nidz monorepo as `tools/visual/nv`;
this note is the contract for extracting it into a tool any project can adopt, with the Nidz apps as
its first consumer and no behaviour change for them.

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
- **Small dependency surface.** bash ≥ 3.2 (macOS default), python3 with Pillow and numpy, node ≥ 22
  for `agent-browser` and `agent-device`. Remotion is installed on first `vysu video`. No npm
  package for vysu itself: install is `git clone` + PATH.
- **Secrets never enter a repo.** Personas and service accounts live under `~/.vysu/<project>/`
  with mode 600. Nothing prints a password.

## 2. Repository layout

```
vysu/
├── bin/vysu                  entry point: resolves its own dir, sources lib/*.sh, dispatches
├── lib/
│   ├── core.sh               paths, config discovery, die/usage/slug, owner, locks, claims, meta
│   ├── persona.sh            personas.env: add / set / list / import, persona_var
│   ├── web.sh                agent-browser wrapper (sessions, batch, open/settle/expand/warm, check, box, lang)
│   ├── mobile.sh             agent-device wrapper (ios/android select, udid, serial, state, textsize, appearance, mshot, mtap, mrelaunch)
│   ├── shots.sh              shots / walk / report / sheet / mark / frame / prune / cache
│   ├── flow.sh               flow / rec / mflow / mrec, events.json, clip normalisation
│   ├── video.sh              cut / video (Remotion), lazy npm install
│   ├── services.sh           up / down from the declared services, dev-client build and install
│   ├── auth.sh               connector loader + primitives offered to connectors, `vysu auth test`
│   ├── push.sh               push drivers loader, `vysu push`
│   └── setup.sh              setup / init / doctor / update / version
├── py/                       diff.py compare.py frame.py mark.py motion.py stitch.py take.py fields.py
├── connectors/
│   ├── auth/                 auth0.sh form.sh none.sh, README.md (the contract), example.sh
│   └── push/                 apns-sim.sh fcm.sh webhook.sh, README.md
├── remotion/                 the explainer toolkit; themes/default only (neutral, Inter)
├── skill/
│   ├── visual-check/         SKILL.md + references/ (generic, English)
│   └── demo-video/           SKILL.md
├── templates/                config.example, agents-snippet.md, hooks/stop-reminder.sh
├── docs/design.md            this note
├── README.md LICENSE VERSION CHANGELOG.md
```

`bin/vysu` stays the single entry point; `lib/` is sourced, never executed. Functions keep their
`nv_*` names renamed to `vysu_*`; internal helpers keep their names so the source comments still
match. Each `lib/*.sh` starts with a three-line header saying what it owns.

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
config                bash-sourced KEY=value, the only required file
auth.sh               optional custom auth connector (else a built-in named in config)
push/<preset>.json    push payload templates
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
| `VYSU_MOBILE_BUNDLE` | app id on both platforms | `fr.nidz.app.next.prep` |
| `VYSU_IOS_APP` | app name on the iOS simulator | `Nidz (prep)` |
| `VYSU_MOBILE_DIR` | Expo app folder (relative to the project dir) | `apps/nidz-next-apps/apps/mobile` |
| `VYSU_MOBILE_ENV` | env exported to Metro and the native build | `NIDZ_ENV=prep` |
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

A connector is a bash file sourced by the engine. It may only call the primitives below and its own
helpers, so a connector written for one app runs unchanged on another machine.

### 6.1 Auth

Contract (`connectors/auth/README.md`, with `example.sh` as a commented template):

```bash
auth_describe            # one line for doctor: which system, which options are set
auth_web_login  <persona> <url>       # session open on <url>; returns with the page logged in on the url's origin
auth_web_token  <persona>             # prints the access token, or nothing
auth_mobile_login  <platform> <persona>   # app in the foreground; returns logged in, on the app's home
auth_mobile_logout <platform>         # optional; used by mlogin when another persona is signed in
```

Primitives available to a connector, defined in `lib/auth.sh` and `lib/web.sh` / `lib/mobile.sh`:
`web <persona> <agent-browser args…>`, `web_click_any <persona> "<name>" "<name>"…` (first visible
button by role and name), `mob <platform> <agent-device args…>`, `mob_press_if <platform> "<label>"`,
`mob_wait_text <platform> "<text>" <ms>`, `mob_fields <platform>` (§ 6.3), `persona_var <persona>
<KEY>`, `cfg <KEY> [default]`, `die`, `log`. Passwords go through `web … fill` and `mob … type`
only; a connector never echoes them.

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
- `none` — no login; `auth_web_login` just opens the url and `auth_web_token` prints nothing. For
  static sites and Storybooks, and the engine's default: without a config, or with no `VYSU_AUTH`
  in one, that is the connector in force, and `doctor` says `auth: none (default)`.

`vysu auth test <persona> [ios|android]` runs the connector once with a throwaway session name
(`<project>-authtest`), prints each step as it passes, and closes the session. Its exit code is the
verdict.

### 6.2 Push

Contract (`connectors/push/README.md`): `push_describe`, `push_send <persona> <preset> [--platform
ios|android] [--field k=v]…`. Presets are files `.vysu/push/<preset>.json`; the driver substitutes
`{{field}}` placeholders from `--field` and from the persona's variables.

- `apns-sim` — `simctl push` on the running iOS simulator with the preset as the APNs payload
  (today's `ipush`). The three Nidz presets move to `nidz-env/.vysu/push/`.
- `fcm` — a real FCM HTTP v1 send with a service account (`VYSU_FCM_SA`, a path under the state
  folder) to the token held by the persona (`VYSU_PERSONA_<NAME>_FCM_TOKEN_IOS` / `_ANDROID`). The
  JWT is signed with `openssl`, no Python package. The preset holds the FCM message body, and the
  driver adds the `token`. `VYSU_FCM_ENDPOINT` replaces the endpoint, for tests only.
- `webhook` — POST `{email, preset, platform, fields}` to `VYSU_PUSH_WEBHOOK_URL`, prints the
  results the endpoint returns (today's `apush`, the Nidz cockpit being the endpoint).

`vysu push ios <preset>` selects `apns-sim`; `vysu push <persona> <preset>` selects the first of
`fcm` / `webhook` enabled in `VYSU_PUSH`.

### 6.3 Mobile field detection

`py/fields.py <screenshot.png> [--scale N]` prints the text fields it sees, as JSON boxes in points,
top to bottom: rounded rectangles with a continuous border, wider than 50 % of the screen, 36 to
72 pt tall, light interior. It is the replacement for the "57 % / 65 %" blind flow on the iOS 18
simulator, where agent-device cannot read the SafariViewService sheet. `mob_fields <platform>` wraps
it (capture, scale, print). The `auth0` connector uses the accessibility path first and falls back
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

1. node ≥ 22, python3 with Pillow and numpy (prints the `pip3 install --user` line when missing);
2. `agent-browser` and `agent-device` installed globally through npm, Chrome for Testing downloaded;
3. Xcode: simulators present, iOS 18 runtime present or the `xcodebuild -downloadPlatform` line;
4. Android SDK: cmdline-tools present, system images downloaded, AVDs created with the device
   dialog of § 8;
5. prints what remains for the user: personas, `vysu init` in the project, the dev-client builds.

`vysu init` (in a project, interactive with defaults, `--yes` to accept them):

1. project name (folder name), web origin, login path, baseline origin;
2. auth connector among the built-ins, or "custom" which copies `example.sh` to `.vysu/auth.sh`;
3. mobile: yes/no, then bundle id, app name, Expo folder;
4. push: drivers, and the webhook url when chosen;
5. writes `.vysu/config` from the template, `.vysu/push/example.json`, `.vysu/commands/README`;
6. installs the skills where an agent will find them: `.claude/skills/visual-check` and
   `demo-video` when `.claude/` exists (or `--skills-dir <dir>`), prints the `templates/agents-snippet.md`
   paragraph to paste into `AGENTS.md` / `CLAUDE.md`, and the Stop hook line for those who want it;
7. ends with the four things only the user can do: `vysu persona add <name>`, `vysu login <name>`,
   `vysu up ios --build` when mobile, the service account for `fcm`.

`vysu doctor`: tools and versions, engine version against `VYSU_MIN_VERSION`, resolved config with
origins, connector `auth_describe`, push `push_describe`, personas by name, sessions, devices,
locks and claims, state folder size. `vysu update`: `git pull --ff-only` in the engine dir, then
prints the CHANGELOG entries since the previous version. `vysu version`: the VERSION file and the
short sha.

## 10. Video toolkit

`remotion/` moves whole. `themes/default/theme.json` is neutral: Inter only, no logo (the header and
the outro hide the logo block when `logo` is absent, `schema.ts` makes it optional), a grey-blue
palette. A project theme lives in `.vysu/themes/<name>/` and is resolved first by `render.ts`
(`VYSU_PROJECT_DIR`), then in the engine. `take.py` writes `VYSU_THEME` into `cut.json`. The
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
git clone https://github.com/Marius-courquin/vysu ~/vysu
echo 'export PATH="$HOME/vysu/bin:$PATH"' >> ~/.zshrc && exec zsh
vysu setup
cd ~/my-project && vysu init
vysu persona add alice && vysu login alice
vysu walk alice home --url http://localhost:3000/
```

`vysu update` pulls. A tag per release (`v0.1.0`), CHANGELOG kept by hand.

## 13. Lots

Each lot is one or more commits on `main` of the vysu repo (this repo has no MR rule), with the
verification of the lot in the commit body. Lot 5 is a merge request in `nidz-env`.

1. **Engine port.** `bin/vysu` + `lib/*.sh` + `py/` + `remotion/` from `nv`, config discovery and
   the config contract, personas, services, devices, `setup` / `init` / `doctor` / `update`, the
   `default` theme. Auth and push are ported as the `auth0` connector and the `apns-sim` +
   `webhook` drivers so the engine already runs the Nidz case end to end. Verification: `bash -n`
   on every file, `shellcheck` clean at its default level, a `.vysu/config` written by hand for
   Nidz in a scratch copy, then `vysu doctor`, `vysu - open https://nidz.fr` + `walk`, `vysu login
   resident` reusing the existing `nidz-resident` session (no re-login), `vysu walk resident news
   --url http://localhost:8100/community/news --baseline-url @`, `vysu mshot ios <name>` on the
   booted simulator.
2. **Connectors.** `form` and `none`, `fcm`, `vysu auth test`, the contract READMEs and
   `example.sh`, `fields.py` and the `auth0` fallback, project commands. Verification: `auth test`
   on `none` against nidz.fr, on `auth0` against prep for the web (one login on the throwaway
   session), `fields.py` on captures of both iPhones as in § 6.3.
3. **Skills and docs.** The two generic skills, `templates/`, README with the install and a
   five-minute tour, `docs/` for connectors and config.
4. **Nidz consumer** (`nidz-env`, merge request): `.vysu/config`, `.vysu/push/*.json`,
   `.vysu/commands/seed`, `.vysu/themes/nidz`, `tools/visual/nv` reduced to `exec vysu "$@"` with
   a one-line notice, `nidz-visual-check` and `nidz-demo-video` reduced to overlays, `setup.js`,
   hooks and `AGENTS.md` mentioning `vysu`, `personas.env` imported once with `vysu persona import
   --prefix E2E_`. Verification: the two tour flows and a `walk` against prep, identical reports.
5. **Release** `v0.1.0`: CHANGELOG, tag, the README's badge line.

Lots 2 and 3 can run in parallel after lot 1; lot 4 after 2.

## 14. Out of scope for 0.1

- Windows and Linux support beyond "should work for web" (agent-device needs macOS for iOS).
- A Playwright or MSW harness of any kind: vysu looks at the real app only.
- Publishing to npm or Homebrew. Clone and PATH is the install until someone asks.
- Multi-project state sharing, cloud rendering, a web UI over the shots.
