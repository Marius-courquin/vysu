# Auth connectors — the contract

An auth connector is one bash file. The engine sources it (never runs it) and calls the five
functions below; the connector answers with the app logged in, and prints one line saying so.
Because it may only call the primitives the engine offers, a connector written for one app runs
unchanged on another machine, another project and another agent.

Which one is used comes from `VYSU_AUTH` in the project's `.vysu/config`:

| `VYSU_AUTH` | what is sourced |
|---|---|
| unset | `none` — the engine default |
| `auth0` · `form` · `none` | `connectors/auth/<name>.sh` in the engine |
| `custom`, or nothing with a `.vysu/auth.sh` present | the project's own `.vysu/auth.sh` |
| a path (`connectors/mine.sh`) | that file, relative to the project |

## The five functions

```bash
auth_describe                          # one line for `vysu doctor`: which system, which options are set
auth_web_login     <persona> <url>     # the session is open on <url>; return with the page logged in
auth_web_token     <persona>           # print the access token, or nothing at all
auth_mobile_login  <platform> <persona>  # the app is installed; return with it logged in, on its home
auth_mobile_logout <platform>          # optional: sign whoever is signed in out, for mlogin
```

What each receives, and what it must leave behind:

- **`auth_web_login`** is given a persona name and the url the login starts at (`VYSU_ORIGIN` +
  `VYSU_LOGIN_PATH` when the caller named none). The browser session already exists and is the
  persona's own — `vysu auth test` swaps it for a throwaway one, which is invisible here. On
  return, the page is logged in **on the url's origin**, and the session's cookies and storage are
  what the next `vysu shots` will reuse. Print one line: `logged in: <persona> (<e-mail>) → <url>`.
- **`auth_web_token`** prints the API access token of the session as it stands, on stdout, nothing
  else. Printing nothing is a valid answer (`none` and a cookie-session app do exactly that) and
  never an error.
- **`auth_mobile_login`** is given `ios` or `android` and a persona. The app is installed and may be
  anywhere — on its door, already signed in as someone else, or sitting on a dev-client launcher.
  Return with it logged in as the persona and on its home screen, and record who that is:
  `mstate_set "$platform" persona "$persona"` — one install is one session, and the next agent
  reads that back through `vysu claim` instead of opening the app to find out.
- **`auth_mobile_logout`** is optional; `mlogin` calls it when another persona is signed in. Define
  it as `auth_mobile_logout() { : ; }` when the app has no way out.

Failing is `die "<what was expected, and the option that names it>"`. It ends vysu with the message
and gives every lock back — never `exit`, never a silent `return 1`.

## The primitives

Everything a connector is allowed to call, and nothing else:

| Primitive | What it does |
|---|---|
| `web <persona> <agent-browser args…>` | the persona's session, locked and restored |
| `web_click_any <persona> "<name>"…` | the first visible button by role and name |
| `mob <platform> <agent-device args…>` | the chosen simulator or emulator, locked |
| `mob_press_if <platform> "<label>"` | press by accessible label, else by visible text |
| `mob_press_any <platform> "<a>,<b>"` | press the first of those labels that is there (a system dialog) |
| `mob_press_all <platform> "<a>,<b>"` | press each of them that is there, in order |
| `mob_wait_text <platform> "<text>" <ms>` | wait for a text to show up |
| `mob_fields <platform>` | the text fields **read from a capture**, JSON boxes in points, top to bottom — for a surface the platform's accessibility cannot read (see below) |
| `mobile_app <platform>` · `mobile_load_bundle <platform>` | the app to open, and the dev-client hand-off |
| `mstate_set <platform> persona <name>` | record who the install is signed in as |
| `persona_require <persona>` | load the credentials: sets `$PERSONA_EMAIL` / `$PERSONA_PASSWORD` |
| `persona_var <persona> <KEY>` | any other key the project set (`vysu persona set alice TOTP …`) |
| `cfg <KEY> [default]` · `die "<why>"` · `log "<what>"` | the config value in force, the two ways to speak |
| `step "<what just worked>"` | one line under `vysu auth test`, silent the rest of the time |

A password goes through `web … fill` and `mob … type` / `mob … fill` only. A connector never echoes
one, never puts one in a url and never writes one to a file.

## Options

A connector's own options are `VYSU_<CONNECTOR>_<KEY>`, read through `cfg <CONNECTOR>_<KEY>
<default>`, and documented in the file's header comment with their defaults in brackets:
`VYSU_AUTH0_SIGNIN_LABELS`, `VYSU_FORM_TOKEN_JS`. A label option is a comma-separated list, written
the way a human reads it (`Se connecter,Sign in`), so one connector covers an app in two languages.
Nothing else is read from the environment: a value a connector needs is either an option or a
persona key.

## Writing one for a project

```bash
cp <engine>/connectors/auth/example.sh .vysu/auth.sh   # or: vysu init, and answer "custom"
$EDITOR .vysu/auth.sh                                  # every function is there, commented
vysu auth test alice                                   # runs it, and says which step held
```

`.vysu/auth.sh` is found on its own: a project that has one and names no `VYSU_AUTH` uses it.

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
