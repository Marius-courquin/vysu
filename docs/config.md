# `.vysu/config` — every key

A project's `.vysu/config` is a list of `KEY='value'` lines, which vysu reads like a shell file with
its own reader: the three kinds of quoting, `$VAR`, `${VAR:-default}`, `export`, several assignments
on a line. Anything past that (a command substitution, a condition) goes to bash on macOS and Linux,
and is an error naming the line on Windows; a config needs none of it. An environment variable of
the same name **wins over the file**, and unknown keys are ignored. `vysu doctor` prints the values
in force and where each one came from (`env`, `config`, `machine.env`, `devices.env`, `default`).
`~/.vysu/machine.env` is what `vysu setup` writes about this machine — its simulators, its AVDs, its
browser — and sits below the project config: a machine says what it has, a project says what it
wants. It was called `devices.env` until 0.4.0, and a file of that name is still read, just below
it.

Every key is optional except `VYSU_PROJECT`, whose default is the project folder's name. A value an
app has to decide — an origin, a bundle id, a locales folder — has no sensible default and stays
empty; the command that needs one says which key is missing.

> This page and [`templates/config.example`](../templates/config.example) are kept in sync **by
> hand**. The template is what `vysu init` writes, comments and all; this page is the same list
> with the defaults spelled out. Change one, change the other.

## Identity

| Key | Meaning | Default | Example |
|---|---|---|---|
| `VYSU_PROJECT` | session prefix and state folder name. Browser sessions are `<project>-<persona>`, device sessions `<project>-<platform>-<device>` | the project folder's name | `my-project` |
| `VYSU_STATE` | where captures, logs, personas, locks and device state live | `~/.vysu/<project>` | `$HOME/.vysu/my-project` |
| `VYSU_MIN_VERSION` | the engine version this project needs; `doctor` and every command warn below it | empty (no check) | `0.1.0` |

## The web app

| Key | Meaning | Default | Example |
|---|---|---|---|
| `VYSU_ORIGIN` | default web origin: what `vysu login` opens, and what a relative flow step is read against | empty | `http://localhost:3000` |
| `VYSU_LOGIN_PATH` | the path the web login starts at, appended to the origin | `/login` | `/auth/login` |
| `VYSU_BASELINE_ORIGIN` | what `--baseline-url @` means: the same path on the deployed main | empty | `https://main.example.com` |
| `VYSU_SIZES` | the viewports `vysu shots` captures | `360x800,768x1024,1280x800,1440x900` | `390x844,1440x900` |
| `VYSU_LANGS` | the languages the app offers; `--lang` accepts nothing else | empty (no check) | `fr,en` |
| `VYSU_LANG` | the default language | empty | `en` |
| `VYSU_LANG_STORAGE_KEY` | the `localStorage` key holding the language; empty means `vysu lang` is unsupported | empty | `myapp.language` |
| `VYSU_LOCALES` | folder holding `<lang>.json`, relative to the project: what `click t:<key>` resolves a label through | empty | `packages/i18n/locales` |
| `VYSU_WEB_REPO` | the git checkout whose sha and branch go into `meta.json` | the project itself | `apps/web` |
| `VYSU_API_PATTERN` | the request path prefix that identifies the API in the network log | `/api/` | `/api/v1/` |
| `VYSU_API_HOSTS` | `host=label` pairs: what a report calls that API instead of its host | empty | `localhost:8080=local api.example.com=prod` |
| `VYSU_BROWSER_PATH` | the Chromium-based browser every web session runs in. Empty is the Chrome for Testing agent-browser downloads, headless — the same rendering on every machine, no personal profile, no extension. Also read from `~/.vysu/machine.env`, where `vysu setup --browser` writes it | empty | `/Applications/Brave Browser.app/Contents/MacOS/Brave Browser` |
| `VYSU_BROWSER_ARGS` | launch flags handed to that browser, comma-separated | empty | `--disable-blink-features=AutomationControlled` |

## Auth

| Key | Meaning | Default | Example |
|---|---|---|---|
| `VYSU_AUTH` | a built-in connector (`auth0` · `form` · `none`), `custom` for `.vysu/auth.mjs` / `.js` / `.ts` / `.sh`, or a path | empty (and `custom` when one of those exists) | `auth0` |

Options of the `auth0` connector, all optional; the defaults live in
[`src/connectors/auth/auth0.ts`](../src/connectors/auth/auth0.ts) and the contract in
[`connectors/auth/README.md`](../connectors/auth/README.md).

| Key | Meaning | Example |
|---|---|---|
| `VYSU_AUTH0_DOMAIN` | the tenant domain (default: any `*.auth0.com`) | `my-tenant.eu.auth0.com` |
| `VYSU_AUTH0_SIGNIN_LABELS` | names of the sign-in button, comma-separated | `Se connecter,Sign in` |
| `VYSU_AUTH0_CONTINUE_LABELS` | names of the continue button of the identifier-first step | `Continuer,Continue` |
| `VYSU_AUTH0_DOOR_TEXT` | the text of the mobile door screen | `Sign in` |
| `VYSU_AUTH0_HOME_TEXT` | the mobile text that proves the login went through | `Welcome` |
| `VYSU_AUTH0_PASSWORD_TEXT` | the text that identifies the password step | `password` |
| `VYSU_AUTH0_MENU_LABEL` / `VYSU_AUTH0_LOGOUT_LABEL` | the two labels of the mobile sign-out | `Menu` / `Sign out` |
| `VYSU_AUTH0_AFTER_LOGIN_LABELS` | buttons pressed if they show up after the login | `Continue,Back home` |

Options of the `form` connector — a plain e-mail + password page — all optional; the defaults live
in [`src/connectors/auth/form.ts`](../src/connectors/auth/form.ts).

| Key | Meaning | Example |
|---|---|---|
| `VYSU_FORM_EMAIL_LABELS` | names of the e-mail field, comma-separated | `E-mail,Email,Identifiant` |
| `VYSU_FORM_PASSWORD_LABELS` | names of the password field | `Mot de passe,Password` |
| `VYSU_FORM_SUBMIT_LABELS` | names of the submit button | `Se connecter,Sign in` |
| `VYSU_FORM_TOKEN_JS` | an expression evaluated in the page whose value is the API token | `localStorage.getItem("access_token")` |
| `VYSU_FORM_HOME_TEXT` | mobile: the text that proves the login went through | `Welcome` |

## The mobile app

| Key | Meaning | Default | Example |
|---|---|---|---|
| `VYSU_MOBILE_KIND` | `expo` (a dev-client served by Metro) or `native` (Swift, Kotlin, Flutter, .NET — already built, no bundler) | `expo` when `VYSU_MOBILE_DIR` is set, else `native` | `native` |
| `VYSU_MOBILE_BUNDLE` | the app id on both platforms | empty | `com.example.app` |
| `VYSU_IOS_APP` | the app's name on the iOS simulator (what `simctl` / agent-device open by) | empty | `My App` |
| `VYSU_MOBILE_DIR` | the Expo app folder, relative to the project | empty | `apps/mobile` |
| `VYSU_IOS_APP_PATH` | native: a `.app` built for `iphonesimulator`, installed by `up ios` when the bundle is not on the device (or `up ios --reinstall`) | empty | `build/Build/Products/Debug-iphonesimulator/App.app` |
| `VYSU_ANDROID_APK` | native: the same for Android, installed by `up android` | empty | `app/build/outputs/apk/debug/app-debug.apk` |
| `VYSU_MOBILE_BUILD_IOS` | what `up ios --build` runs, in `VYSU_MOBILE_DIR` (the project root when it is unset), in the background, logged to `logs/ios-build.log` | `npx expo run:ios --device "<device>" --no-bundler` in expo mode, empty in native mode | `xcodebuild -scheme App -sdk iphonesimulator -configuration Debug -derivedDataPath build` |
| `VYSU_MOBILE_BUILD_ANDROID` | the same for `up android --build` | `npx expo run:android --device "<avd>" --no-bundler` in expo mode, empty in native mode | `./gradlew assembleDebug` |
| `VYSU_MOBILE_ENV` | environment exported to Metro and to the native build, space-separated `k=v` | empty | `APP_ENV=staging` |
| `VYSU_MOBILE_SCHEME` | the dev-client scheme handed to Metro's URL; empty skips the dev-launcher hand-off | empty | `exp+myapp` |
| `VYSU_MOBILE_DEEPLINK` | what `vysu mopen <route>` appends a route to (a leading `/` of the route is dropped); an argument holding `://` is opened as it is, and without this key only full urls are | empty | `myapp:///` |
| `VYSU_MOBILE_READY_TEXT` | texts that prove the app has booted, comma-separated: what `mrelaunch` waits for instead of a delay | empty (a fixed delay) | `Sign in,Welcome` |
| `VYSU_MOBILE_DISMISS_LABELS` | expo: the buttons that close Expo's dev menu and its first-run intro, comma-separated, in the simulator's language; `mrelaunch` presses them only while the menu's own texts are on screen | `Continue,Close` | `Continuer,Continue,Fermer,Close` |
| `VYSU_METRO_PORT` | expo: the port of the Metro every session shares. An owner with an isolated Metro (`vysu up <platform> --isolated`) uses its own port instead, unless this key is exported in the environment, which wins over both | `8081` | `8081` |
| `VYSU_MLOG_IGNORE` | lines `vysu mlog` drops, as extended regexes separated by `\|` (one ERE); the reading ends with how many were dropped | empty | `\[boot \|i18next is made possible` |
| `VYSU_IOS_DEVICE` | the recent simulator: what an owner's commands drive until it chooses another one. A choice (`vysu claim ios --device` / `--any`, `vysu up ios --device`) is remembered per owner and wins over this key; the environment wins over both | the machine's last remembered choice, else `iPhone 17 Pro` | `iPhone 17 Pro` |
| `VYSU_IOS_OLD_DEVICE` | the old simulator, created by `vysu setup` | `vysu iPhone SE (iOS 18)` | `my iPhone SE (iOS 18)` |
| `VYSU_IOS_DEVICES` | the iOS pool `vysu claim ios --any` picks from, comma-separated; the clones vysu makes of them (`<name> (vysu N)`) join it | `VYSU_IOS_DEVICE`, `VYSU_IOS_OLD_DEVICE` | `iPhone 17 Pro,my iPhone SE (iOS 18),iPhone 17 Pro B` |
| `VYSU_IOS_MAX_CLONES` | how many clones `claim ios --any` may make when no pool device is free. A clone is a whole simulator (1-2 GB of RAM once booted); `vysu devices --prune-clones` deletes the ones nobody claims | `1` | `0` |
| `VYSU_ANDROID_AVD` | the default AVD, chosen the same way as `VYSU_IOS_DEVICE` (`vysu claim android --avd` / `--any`, `vysu up android --avd`) | the machine's last remembered choice, else `vysu_pixel8_api36` | `vysu_pixel8_api36` |
| `VYSU_ANDROID_AVDS` | the specs `vysu setup` creates: `name:api:device:extra key=value`, `;` apart. Their names are the Android pool of `vysu claim android --any` | the three specs below | see below |
| `VYSU_ANDROID_MAX_RUNNING` | the emulators running past which `claim android --any` starts no other one (4 GB of RAM each) | `2` | `1` |
| `VYSU_ANDROID_LOCALE` | the locale forced on the emulator at boot; empty leaves it untouched | empty | `fr-FR` |

The default AVD specs:

```
vysu_pixel8_api36:36:pixel_8:;vysu_pixel10pro_api36:36:pixel_8_pro:hw.lcd.width=1280 hw.lcd.height=2856 hw.lcd.density=480;vysu_pixel4a_api30:30:pixel_4a:
```

In **native mode** `vysu up ios|android` boots the device, applies the locale and the status bar,
installs the app when it is missing and starts a tail of its log into `logs/<platform>-app.log`
(iOS: `simctl spawn … log stream` on the app's process; Android: `logcat --uid` of the package — or,
on an image older than API 31, where `--uid` does not exist, the same uid grepped out of `-v uid` —
so the filter survives a relaunch). There is no Metro, no `adb reverse` and no bundle wait:
`vysu mrelaunch` terminates, applies text size / appearance / language, launches, and waits for
`VYSU_MOBILE_READY_TEXT` — or five seconds when the project names nothing. `vysu mlog` reads that
app log instead of `metro.log`, and `vysu down applog [ios|android]` stops the tails.

In **expo mode** Metro's log is `logs/metro.log` for port 8081 and `logs/metro-<port>.log` for any
other. `vysu mrelaunch` starts the dev-client straight into the Metro of its owner (iOS: the
`--initialUrl` launch argument; Android: the dev-client deep link), sets Expo's dev-menu
preferences so its first-run intro never opens, and starts a tail of that device's JS console
(`logs/<platform>-js-<device>.log`, read by `vysu mlog <platform> --device`). Several sessions share
one Metro by default; `vysu up <platform> --isolated [--port <n>] [--dir <folder>]` starts one for
the calling owner from its own checkout (`logs/metro-<port>.log`, remembered in
`$VYSU_STATE/metro-port.<owner>`), and `vysu down metro` stops it again.

`vysu setup` also writes `~/.vysu/devices.env` with `VYSU_IOS_DEVICE`, `VYSU_IOS_OLD_DEVICE` and
`VYSU_ANDROID_AVDS`: a machine says which devices it has, and a project config still wins over it.

## Services

| Key | Meaning | Default | Example |
|---|---|---|---|
| `VYSU_SERVICES` | the services `vysu up` / `vysu down` know, in start order; `vysu up all` runs them all | empty | `web api db` |

One service, key by key (`<name>` is a name from `VYSU_SERVICES`):

| Key | Meaning | Default |
|---|---|---|
| `VYSU_SERVICE_<name>_CMD` | the command, run through the platform's shell (`sh -c`, `cmd.exe /c` on Windows) in `_DIR`, in the background, logged to `logs/<name>.log` | required |
| `VYSU_SERVICE_<name>_DIR` | where to run it, relative to the project | the project root |
| `VYSU_SERVICE_<name>_PORT` | the port it listens on: what `down` kills, and what `HEALTH=port` waits for | none |
| `VYSU_SERVICE_<name>_HEALTH` | a url to poll, the literal `port` for a TCP listen check, or a command to succeed | `port` when `_PORT` is set, else no wait |
| `VYSU_SERVICE_<name>_ENV` | `k=v` pairs exported to it (`vysu up <name> --env K=V` adds to, and overrides, these) | empty |
| `VYSU_SERVICE_<name>_TIMEOUT` | seconds to wait for `HEALTH` | `30` |
| `VYSU_SERVICE_<name>_STOP` | how to stop it | kill whatever listens on `_PORT` |

```bash
VYSU_SERVICE_web_CMD='pnpm --filter web exec vite --port 8100 --strictPort'
VYSU_SERVICE_web_PORT=8100
VYSU_SERVICE_web_HEALTH='http://localhost:8100/'
VYSU_SERVICE_db_CMD='make -s dev-up'
VYSU_SERVICE_db_HEALTH='docker exec my-db pg_isready -q'
VYSU_SERVICE_db_STOP='make -s dev-down'
```

## Push

| Key | Meaning | Default | Example |
|---|---|---|---|
| `VYSU_PUSH` | the drivers enabled, comma-separated: `apns-sim` (iOS simulator) · `webhook` · `fcm` | empty | `apns-sim,webhook` |
| `VYSU_PUSH_WEBHOOK_URL` | the endpoint the `webhook` driver posts to | empty | `https://internal.example.com/api/dev/push` |
| `VYSU_FCM_SA` | a service account file under the state folder, for the `fcm` driver | empty | `fcm-service-account.json` |
| `VYSU_FCM_SCOPE` | the OAuth scope the `fcm` driver asks for | the Firebase messaging scope | `https://www.googleapis.com/auth/firebase.messaging` |
| `VYSU_FCM_ENDPOINT` | where a send goes instead of the real FCM endpoint — tests only | the real endpoint | `http://localhost:8099/v1/projects/demo/messages:send` |

Presets are files `.vysu/push/<preset>.json`, with `{{field}}` placeholders filled by
`--field k=v` and then by the persona's own variables.

## Video

| Key | Meaning | Default | Example |
|---|---|---|---|
| `VYSU_THEME` | the theme `vysu cut --draft` writes into the new `cut.json`: `themes/<name>/theme.json` beside the config first, then the engine's own. A render reads the theme from `cut.json`, never from this key | `default` | `my-brand` |

## Keys that live in the environment only

These are not written to `.vysu/config`; they are exported for one command or one shell.

| Key | Meaning | Default |
|---|---|---|
| `VYSU_CONFIG` | a config file to use, so one can be tried from outside its project | discovered by walking up from `$PWD` |
| `VYSU_PROJECT_DIR` | the project root, instead of discovering it | discovered |
| `VYSU_DIR` | read-only, exported by the engine: the folder the loaded config sits in, where its themes, connectors, push presets and commands are looked up. `$VYSU_PROJECT_DIR/.vysu` unless `VYSU_CONFIG` names a config elsewhere | resolved from the config |
| `VYSU_PERSONAS` | the personas file, so one can be tried without moving the state folder | `$VYSU_STATE/personas.env` |
| `VYSU_SHOTS` | the shots folder | `$VYSU_STATE/shots` |
| `VYSU_LOCK_WAIT` | seconds a command waits for a busy device or session before giving up, and `claim --any` for a free device | `90` |
| `VYSU_CHECKER_MODELS` | the model a visual-checker sub-agent runs on, per agent tool, as `family=model` pairs (`claude=sonnet,codex=gpt-5.6-luna`); the family is the caller's name as vysu detects it (`claude:41234` → `claude`). `vysu checker` answers for the caller, `vysu init` writes the Claude Code definition with it | empty: inherit the caller's model |
| `VYSU_OWNER` | who a lock, a claim and a device choice are attributed to. A detected owner is `<name>:<pid>`: once that process is gone, its claims are dropped. The sub-agents of one session run under that same process, so they are one owner: while it holds two devices of a platform, a command that does not name its device (`VYSU_IOS_DEVICE` / `VYSU_ANDROID_AVD`) is refused | the agent or terminal above the command |
| `VYSU_ENGINE` | the engine directory, exported to project commands and to the render script | resolved from `bin/vysu` |
| `VYSU_UI_GLOBS` | read by the Stop hook only (`templates/hooks/stop-reminder.sh`, or `stop-reminder.mjs` where there is no bash): which changed files count as UI | `**/*.tsx,**/*.vue,**/*.svelte,**/*.css` |
| `VYSU_RUNTIME` | what `bin/vysu` and `bin\vysu.cmd` run the engine on: `node`, or `bun` | `node` |
| `VYSU_AGENT_DEVICE` | `cli` makes every device call a run of the `agent-device` command instead of a call to its library (loaded from the package that command runs, when it is at least `AGENT_DEVICE_MIN` of `tools.env`): the same requests, one Node start-up each | empty: the library |
| `VYSU_DEBUG` | `mobile` prints, on stderr, when a relaunch handed the bundle over, what each look at Metro's log and at the screen found, and when it decided the app was on the launcher | empty |

Personas themselves are not config: they live in `personas.env` under the state folder, mode 600,
written by `vysu persona add|set|import` and read as `VYSU_PERSONA_<NAME>_<KEY>`.
A name may hold `_`, and so may a key (`FCM_TOKEN_IOS`): a persona is declared by its `_EMAIL`
key, every other key belongs to the longest declared name it starts with, and an `import` leaves
behind, and names, the keys that belong to no persona (a fixture id kept next to the credentials
belongs in `.vysu/config`). One reader does this for `persona list`, `import` and `doctor`:
`src/core/personas.ts`.
