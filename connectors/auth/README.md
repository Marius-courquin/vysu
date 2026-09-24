# Auth connectors — the contract

An auth connector answers four questions (five with the optional logout) for one kind of login:
it takes a persona to the logged-in app and prints one line saying so. Because it may only call the
primitives the engine hands it, a connector written for one app runs unchanged on another machine,
another project and another agent.

It comes in two forms, with the same functions and the same primitives:

- **a module** — `.vysu/auth.mjs` (or `.js`, `.ts`) exporting the functions, each given the
  primitives as its first argument. It runs wherever vysu runs, Windows included. The built-ins
  (`none`, `auth0`, `form`) are written this way, in `src/connectors/auth/`; the template is
  `connectors/auth/example.mjs`.
- **a bash file** — `.vysu/auth.sh`, the form projects wrote first, which keeps working on macOS
  and Linux: vysu runs each function in a bash that sources the file under `set -euo pipefail`,
  with every primitive defined as a call back into vysu. The template is
  `connectors/auth/example.sh`.

Which one is used comes from `VYSU_AUTH` in the project's `.vysu/config`:

| `VYSU_AUTH` | what is loaded |
|---|---|
| unset | `none` — the engine default |
| `auth0` · `form` · `none` | the built-in of that name |
| `custom`, or nothing with a `.vysu/auth.mjs`, `.js`, `.ts` or `.sh` present | the project's own, the first of those four that exists |
| a path (`connectors/mine.mjs`, `connectors/mine.sh`) | that file, relative to the project: a module by its extension, bash otherwise |

## The functions

```js
// .vysu/auth.mjs
export function describe(v)                        // one line for `vysu doctor`: which system, which options are set
export async function webLogin(v, persona, url)     // the session is open on <url>; return with the page logged in
export async function webToken(v, persona)          // the access token, or undefined
export async function mobileLogin(v, platform, persona)  // the app is installed; return with it logged in, on its home
export async function mobileLogout(v, platform)     // optional: sign whoever is signed in out; true when it did
```

```bash
# .vysu/auth.sh
auth_describe                          # printf the line
auth_web_login     <persona> <url>
auth_web_token     <persona>           # print the access token, or nothing at all
auth_mobile_login  <platform> <persona>
auth_mobile_logout <platform>          # optional; `auth_mobile_logout() { : ; }` when the app has no way out
```

A module may also export them as the properties of a default object.

What each receives, and what it must leave behind:

- **`webLogin`** is given a persona name and the url the login starts at (`VYSU_ORIGIN` +
  `VYSU_LOGIN_PATH` when the caller named none). The browser session already exists and is the
  persona's own — `vysu auth test` swaps it for a throwaway one, which is invisible here. On
  return, the page is logged in **on the url's origin**, and the session's cookies and storage are
  what the next `vysu shots` will reuse. Print one line: `logged in: <persona> (<e-mail>) → <url>`.
- **`webToken`** hands back the API access token of the session as it stands (a bash connector
  prints it on stdout, nothing else). No token is a valid answer (`none` and a cookie-session app
  give exactly that: `undefined`, or nothing printed) and never an error.
- **`mobileLogin`** is given `ios` or `android` and a persona. The app is installed and may be
  anywhere — on its door, already signed in as someone else, or sitting on a dev-client launcher;
  `mobileRelaunch` starts from its root screen whichever it was. Return with it logged in as the
  persona and on its home screen, and record who that is:
  `v.mstateSet(platform, 'persona', persona)` (bash: `mstate_set "$platform" persona "$persona"`)
  — one install is one session, and the next agent reads that back through `vysu claim` instead of
  opening the app to find out.
- **`mobileLogout`** is optional; a connector calls its own when another persona is signed in. Open
  the menu that holds the logout before pressing it (a drawer's rows can sit in the tree while it is
  closed, and a press there lands on whatever lies under them), confirm a dialog if the app asks, and
  when the way out is not on the screen the app was left on, `mobileRelaunch` and try again from its
  root.

Failing is `v.die('<what was expected, and the option that names it>')` (bash: `die "…"`). It ends
vysu with the message and gives every lock back — never `process.exit`, never a silent return.

## The primitives

Everything a connector is allowed to call, and nothing else. A module gets them as `v`; a bash
connector as functions.

| Module (`v.…`) | Bash | What it does |
|---|---|---|
| `web(persona, …args)` → stdout | `web <persona> <args…>` | agent-browser in the persona's session, locked and restored; a failure ends vysu with its exit code (bash: `set -e`) |
| `webTry(persona, …args)` → `{ code, stdout, stderr }` | `web … >/dev/null 2>&1 \|\| …` | the same, never failing, saying nothing |
| `webClickAny(persona, …names)` → boolean | `web_click_any <persona> "<name>"…` | the first visible button by role and name |
| `mob(platform, …args)` · `mobTry(…)` | `mob <platform> <args…>` | agent-device on the chosen simulator or emulator, locked |
| `mobPressIf(platform, label)` | `mob_press_if <platform> "<label>"` | press by accessible label, else by visible text |
| `mobPressAny(platform, 'a,b')` | `mob_press_any <platform> "<a>,<b>"` | press the first of those labels that is there (a system dialog) |
| `mobPressAll(platform, 'a,b')` | `mob_press_all <platform> "<a>,<b>"` | press each of them that is there, in order |
| `mobWaitText(platform, text, ms)` | `mob_wait_text <platform> "<text>" <ms>` | wait for a text to show up |
| `mobFields(platform)` → `[{x, y, w, h}]` | `mob_fields <platform>` (JSON) | the text fields **read from a capture**, boxes in points, top to bottom — for a surface the platform's accessibility cannot read (see below) |
| `mobileRelaunch(platform)` | `mobile_relaunch <platform>` | the app killed and started again straight onto its bundle (this owner's Metro, never Expo's launcher), on its root screen whatever it was left on, the dev menu cleared, the agent-device session open: where a login starts. Ends vysu with the reason when the app cannot start |
| `mobileApp(platform)` · `mobileLoadBundle(platform)` | `mobile_app` · `mobile_load_bundle` | the app to open, and the dev-client hand-off for a connector that opens the app itself (an agent-device `open` starts a dev-client on Expo's launcher) |
| `mobilePrepare(platform)` | `ios_lock` · `android_select` | before the app is opened: the device locked, and on Android Metro's port reversed onto it |
| `mstateSet(platform, 'persona', name)` | `mstate_set <platform> persona <name>` | record who the install is signed in as |
| `personaRequire(persona)` → `{ email, password }` | `persona_require <persona>` (sets `$PERSONA_EMAIL` / `$PERSONA_PASSWORD`) | load the credentials |
| `personaVar(persona, KEY)` | `persona_var <persona> <KEY>` | any other key the project set (`vysu persona set alice TOTP …`) |
| `cfg(KEY, default)` · `labels('a,b')` | `cfg <KEY> [default]` | the config value in force; a comma-separated option as its labels |
| `die(why, next?)` · `log(what)` | `die "<why>"` · `log "<what>"` | the two ways to speak |
| `step(what)` | `step "<what just worked>"` | one line under `vysu auth test`, silent the rest of the time |
| `sleep(seconds)` · `lastLine(text)` · `value(text)` | `sleep` · `tail -1` · `tr -d '"'` | a pause; the last line of an answer; the value an `eval` printed, unquoted |

A password goes through `web … fill` and `mob … type` / `mob … fill` only. A connector never echoes
one, never puts one in a url and never writes one to a file.

In the bash form each primitive is a short-lived vysu of its own. It holds its locks for the vysu
that ran the connector (`VYSU_LOCK_HOLDER`): a session or a device stays held between two calls, and
is given back when the command ends, whichever way it ends. The values in force are the connector's
shell variables (`$VYSU_ORIGIN`), which `cfg` reads.

## Options

A connector's own options are `VYSU_<CONNECTOR>_<KEY>`, read through `cfg('<CONNECTOR>_<KEY>',
'<default>')`, and documented in the file's header comment with their defaults in brackets:
`VYSU_AUTH0_SIGNIN_LABELS`, `VYSU_FORM_TOKEN_JS`. A label option is a comma-separated list, written
the way a human reads it (`Se connecter,Sign in`), so one connector covers an app in two languages.
Nothing else is read from the environment: a value a connector needs is either an option or a
persona key.

## Writing one for a project

```bash
cp <engine>/connectors/auth/example.mjs .vysu/auth.mjs   # or example.sh → .vysu/auth.sh; or: vysu init, and answer "custom"
$EDITOR .vysu/auth.mjs                                   # every function is there, commented
vysu auth test alice                                     # runs it, and says which step held
```

The file is found on its own: a project that has one and names no `VYSU_AUTH` uses it.

## Testing it

```bash
vysu auth test <persona>              # the web flow, on a throwaway session of its own
vysu auth test <persona> ios|android  # the mobile flow, on the real device
```

The web test opens `<project>-authtest`, a session with its own profile and no cookies, and closes
it at the end — a failure included. Each step that holds prints `step: … ok`, and the exit code is
the verdict, so `vysu auth test alice && echo fine` is a check a CI job can run. The mobile test has
no throwaway to offer: one install is one session, so it drives the real device and says so before
it starts. Mind what a real login costs where the identity provider rotates a refresh token or
consumes an SSO session.
