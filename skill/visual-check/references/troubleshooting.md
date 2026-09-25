# Troubleshooting

- **`restore: missing` plus a login page** -> the session state expired: `vysu login <persona>`.
  The connector named by `VYSU_AUTH` handles the sign-in; for another app on the same machine, pass
  its login URL as the second argument (`vysu login <persona> https://other.example.com/login`).
- **A diff against the baseline origin that lands on the login page** -> the persona never signed
  in on that origin: `vysu login <p> <baseline-origin>/<login path>`, once.
- **The app cannot reach its API, plus `OPTIONS … 403`** -> the dev server is on a port the API
  does not allow. Serve it on the port the deployed CORS policy accepts; that is what the `web`
  service in `.vysu/config` is for.
- **An onboarding overlay covers the screen** -> dismiss it once per persona through the app's own
  storage: `vysu <p> eval "localStorage.setItem('<key>','1')"` then `reload`.
- **`vysu box` answers "no box"** -> the ref comes from a stale snapshot: take a fresh
  `vysu <p> snapshot -i`, or give a plain CSS selector (no `:has-text`).
- **A simulator was recreated** (new UDID, different density) -> `vysu cache clear` (UDIDs and
  scales are remembered), then `vysu up ios|android`.
- **General doubt** (tools, config, connectors, personas, sessions, helpers, caches, locks) ->
  `vysu doctor`. Shots folders pile up: `vysu prune [--days 30] [--match "<glob>"] [--dry-run]`.
- **`vysu rec`: "no video written"** -> the recorder gave up on a heavy page and the whole take is
  lost. Run it again; lower `--fps` or shorten the journey if it repeats.
- **Anything else on the browser side** -> `agent-browser doctor`, then
  `agent-browser skills get core` (the full agent-browser reference, to load only when needed).
- **A new machine** -> `vysu setup` (tools, browser, simulators, AVDs), then `vysu init` in the
  project, then `vysu persona add <name>` and `vysu login <name>`. `vysu: command not found` right
  after an install -> a new terminal (the installer put the engine on the PATH of new ones);
  `vysu setup` names the install command of the machine for anything missing.
- **The engine is older than the project asks for** -> every command prints a line naming
  `VYSU_MIN_VERSION`: `vysu update` pulls the engine and shows the changelog since.
- **`<resource> busy — <agent> running "…" for Ns`** -> another agent holds that device or that
  persona session. `vysu` waits `VYSU_LOCK_WAIT` seconds (90) and then gives up: wait, take another
  device, take another session of the persona (`vysu claim <persona> --any`), or re-run with
  `VYSU_LOCK_WAIT=300`. Do not delete the lock by hand: a dead
  process's lock is cleaned up on its own.
- **`<resource> claimed by <agent> until HH:MM`** -> a reservation made by `vysu claim`, which
  outlives a single command. Wait for that time, or `vysu release <resource> --force` if the agent
  is gone. A mobile task spanning several commands starts with
  `vysu claim ios|android|<persona> [--minutes 30]` and ends with `vysu release`. `vysu doctor`
  lists the locks and the claims in force.
- **`every <persona> session is in use`** -> `claim <persona> --any` found all `VYSU_WEB_SLOTS`
  sessions (4) claimed or busy, and lists who holds each. Wait, release one of yours, or raise
  `VYSU_WEB_SLOTS` (each session is one more headless browser).
- **A `<persona>@N` session lands on the login page** -> its own login expired: `vysu login
  <persona>@N`. Never copy a persona's browser state into another session by hand: with rotating
  refresh tokens (Auth0) the first refresh of one logs both out.
- **The app stays on the Expo launcher ("Connect", "Home", "Updates") after
  `vysu mrelaunch --lang`** -> the zygote restart brought the dev-client back too late to receive
  the Metro URL: run `vysu mrelaunch <platform>` again with no option.
- Mobile gotchas (Metro, dev-client, refs, Android): `mobile.md`.
