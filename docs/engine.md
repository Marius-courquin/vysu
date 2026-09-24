# The engine

vysu is TypeScript that Node ≥ 22.6 runs as it is (type stripping, no build step; below 22.18
`bin/vysu.mjs` adds the flag that turns it on). This page is for
whoever changes it: where things live, the few APIs everything is built on, the contracts between
the parts, and how a change is checked. What vysu does for its users is in the
[README](../README.md), the design choices in [design.md](design.md), every config key in
[config.md](config.md).

## What the engine keeps

1. **The same observable behaviour.** A command prints the same lines, exits with the same code and
   writes the same files (shots folders, `meta.json`, `events.json`, verdicts, state files, locks,
   claims) from one version to the next. Agents and skills read these outputs: a changed word is a
   regression unless it is a deliberate change, said in the commit and in the CHANGELOG. The files
   keep the format every earlier version wrote, byte for byte, so two versions installed side by
   side (an agent on an older checkout) share one state folder and wait on each other's locks.
2. **Cheap calls.** No process where a function does: helpers run in process, `agent-browser` is
   called by its native binary rather than its node wrapper, `agent-device` through its library
   client where a command makes several calls, the process table and the port listeners read only
   when a question needs them, independent questions asked at once.
3. **macOS, Linux and Windows.** Everything that differs by system is in `src/core/host.ts`. iOS
   needs a Mac and says so in one line (`needMac()`, `src/mobile/tools.ts`).

## Layout

| Path | What |
|---|---|
| `bin/vysu`, `bin/vysu.cmd` | the launchers: POSIX `sh` (macOS, Linux, Git Bash, through every symlink of a PATH entry) and `cmd` (Windows); both start `src/cli.ts` on Node, or on Bun under `VYSU_RUNTIME=bun` |
| `src/cli.ts` | the entry: the leading `--no-color`, the config, the command, the cleanups on exit and on a signal |
| `src/commands.ts` | every command by name, each module loaded only when it is the one asked for |
| `src/usage.txt` | what `vysu help` prints, as it is |
| `src/cmd/` | one module per command: `run(args)` → exit code |
| `src/core/` | config and ctx (discovery, values, where each came from), errors (`die`, cleanups), ui (the three report shapes), hold (owner, locks, claims, device choices), host (everything OS-specific) and winps (the Windows process table), proc (running tools), net (ports, health), shellenv (the settings-file reader), meta, rec, i18n, personas, project commands, text, py (the Python behaviours an output is defined by) |
| `src/web/` | agent-browser: sessions, batches, the page verbs of a flow, shots, the persona passthrough |
| `src/auth/`, `src/connectors/auth/` | the auth connector contract, its loader and bash bridge, and the built-ins `none`, `auth0`, `form` |
| `src/mobile/` | agent-device and the platform tools: devices, pool and claims, Metro, launch and relaunch, `mshot`, `mdo` and the step runner, recordings, logs, device conditions |
| `src/push/`, `src/connectors/push/` | the push drivers' loader and contract, the prelude of the bash form, and the built-ins `apns-sim`, `fcm`, `webhook` |
| `src/img/` | the image and recording helpers (`diff`, `compare`, `sheet`, `stitch`, `mark`, `frame`, `take`, `motion`, `burst`, `screen`, `screencap`, `fields`, `verdict`), and what they draw with: raster I/O through sharp, a Lanczos resampler and its worker pool, text from `assets/glyphs/` |
| `src/services/` | `up` / `down` of the services a config declares |
| `src/setup/` | what setup, init, doctor, update, version and checker share: the node tools, browsers, devices, skills, install hints |
| `connectors/` | the contracts of auth connectors and push drivers (`README.md`) and the templates a project copies (`example.mjs`, and `auth/example.sh` for the bash form) |
| `templates/` | `config.example` (what `vysu init` writes), the agents snippet, the checker agent, the Stop hooks |
| `skill/` | the skills `vysu init` installs into a project |
| `remotion/` | the video toolkit `vysu video` renders with, installed on its first run |
| `assets/` | the Inter faces and the glyph outlines drawn from them (`node scripts/build-glyphs.ts` when a font changes) |
| `test/` | unit tests, the platform smoke, the parity scripts, fixtures |
| `scripts/` | `bench.ts` (paired timings of two engines), `build-glyphs.ts` |
| `install.sh`, `install.ps1` | the installers: clone, Node check, `npm ci --omit=dev`, PATH |

## A command, from the launcher to its exit code

`bin/vysu` finds the engine through the symlinks of its PATH entry and runs `src/cli.ts`. The entry
takes a leading `--no-color`, loads the config (`Config.load()`, then `setConfig`), and looks the
first word up in `commands`:

- a name in the table loads its module and runs `run(args)`; a number is the exit code, nothing is 0;
- any other name is the project's own command, `.vysu/commands/<name>` (`src/core/project.ts`), when
  one exists, and otherwise a persona: `vysu <persona> <agent-browser args…>` runs agent-browser in
  that persona's session (`src/web/passthrough.ts`), which is also what an unknown name gets.

A `die` anywhere (a `VysuError`) prints its message and the command that fixes it, and ends with its
code; `exit(code)` ends quietly. Either way, and on SIGINT / SIGTERM / SIGHUP, the cleanups run: locks
given back, a recorder stopped. A project command runs in vysu's place: a signal vysu receives is
passed on to it (`forwardSignals`), and its status is vysu's. A reader that closes the pipe early
(`vysu doctor | head`) is an end, not an error.

**Adding a command**: a module `src/cmd/<name>.ts` exporting `run(args: string[])`, one line in
`src/commands.ts`, its lines in `src/usage.txt`, and where users will look for it (README, the skill's
references). A project command of the same name becomes unreachable, so a new name is a small
breaking change for a project that had one.

## The core everything is built on

- **Config** (`src/core/config.ts`, reached through `config()` of `src/core/ctx.ts`): `get(KEY,
  default)`, `need(KEY, why)` (dies naming the key), `needProject()`, `origin(KEY)` (`env`, `config`,
  `machine.env`, `devices.env`, `default`), `projectPath(p)`, the paths (`state`, `shots`, `logs`,
  `locks`, `claims`, `personas`, `locales`, `webRepo`, `mobileDir`, `androidSdk`, `remotion`), and
  the environment of a child process (`childEnv()`, `exportedEnv()`).
- **Errors** (`src/core/errors.ts`): `die(msg, next?)` throws and crosses every await, so nothing
  catches a `VysuError` except to add context; `exit(code)`, `log()`, `onCleanup(fn, sync?)`.
- **Report lines** (`src/core/ui.ts`): `ok`, `warn`, `miss`, `info`, `head`, `summary`,
  `allRequiredPresent` — a line is fine, optional and missing, or required and missing, never a
  fourth thing.
- **Who holds what** (`src/core/hold.ts`): `owner()` (the agent that drives this vysu, found by
  walking up the process table), `devices` (`.ios`, `.android`, `.named(p)`), `deviceGuard`,
  `lockTake` / `lockDrop`, `iosLock` / `androidLock` / `platformLock`, `claimWhy` / `claimRenew` /
  `claimField`, `ownerDevices`, `deviceRemember`, `resourceOf`, `locksReport`.
- **Processes** (`src/core/proc.ts`): `run()` and `runBuffer()` wait and hand back what the process
  said, never throwing on a non-zero exit; `runTool()` for an npm-installed CLI; `runShell()` for a
  command line from a config; `spawnDetached()` / `spawnShellDetached()` for what outlives vysu;
  `killTree()`. Ports and urls: `listening()`, `killPort()`, `waitHttp()` (`src/core/net.ts`).
- **Files and text**: `metaRead` / `metaWrite`, `repoSha` / `repoBranch` (`src/core/meta.ts`);
  `ev`, `evStart`, `evLog`, `now`, `clipNormalize` for a recording's steps (`src/core/rec.ts`);
  `i18nLabel`, `langCheck` (`src/core/i18n.ts`); the personas (`src/core/personas.ts`); `slug`,
  `commaList`, `hhmm`, `isoLocal`, `sleep` (`src/core/text.ts`); `pyRound`, `fnmatch`,
  `htmlEscape` (`src/core/py.ts`).
- **Settings files** (`src/core/shellenv.ts`): `.vysu/config`, `~/.vysu/machine.env` and
  `personas.env` are read like a shell file — `KEY=value` lines, `export`, several per line, the
  three kinds of quoting, `$VAR`, `${VAR}`, `${VAR:-default}` and its siblings, a leading `~`. A
  line past that (a command substitution, a condition) goes to a real bash on macOS and Linux
  (`readShellEnv`, `src/core/config.ts`), and is named in the error where there is none.

## Contracts between the parts

- **`src/web/api.ts`** is what the rest of the engine asks of the browser side: `web(persona, args)`,
  whether a session exists, what `vysu claim` / `release --reset` read and do on it, the auth
  connector's doctor line and a persona's token, the doctor's session lines, the browser in force.
- **`src/mobile/api.ts`** is what it asks of the device side: the primitives an auth connector may
  call (`mob`, `mobPressIf` / `Any` / `All`, `mobWaitText`, `mobFields`, `mobileApp`,
  `mobileLoadBundle`, `mobilePrepare`, `mstateSet` / `mstateGet`), the Metro port, `mobileUp` /
  `mobileDown`, the doctor's device lines, the push drivers' lines.
- **`src/img/tools.ts`** runs a helper by name, the way a command line would: `tool(name, argv,
  { input })` → `{ code, stdout, stderr }`, and `toolPassthrough(name, argv)` for `vysu mark` and
  `vysu frame`. Each helper is a module of `src/img/` exporting `main(argv, io)`, parses its argv
  like argparse (`src/img/args.ts`: any order, `--opt=value`, unique prefixes, exit 2 on a bad
  option), and exports its typed functions for a caller that wants them without the text.
- **Connectors.** An auth connector answers the functions of `src/auth/types.ts` with the primitives
  of `src/auth/context.ts`; a push driver answers `describe` and `send` of `src/push/push.ts`. The
  bash forms of both run through bridges: `src/auth/bridge.ts` sources a `.vysu/auth.sh` with every
  primitive defined as a call back into vysu (`vysu __prim <name> …`, holding its locks for the
  vysu that started it), and `src/push/prelude.sh` sources a `.sh` driver with the functions it
  calls. The contracts users write against are `connectors/auth/README.md` and
  `connectors/push/README.md`.

## Operating systems

`src/core/host.ts` answers every question whose answer differs by system, and nothing above it
branches on the platform:

- the process table and a process's name: Linux `/proc`, macOS one `ps`, Windows a C# helper of a
  hundred lines compiled on first use with the `csc.exe` of .NET Framework 4 and kept in
  `%LOCALAPPDATA%\vysu` (`src/core/winps.ts`), about 20 ms where a CIM query costs 0.5 to 1 s; the
  same helper starts what must outlive vysu without inheriting its handles;
- which processes listen on a port: `lsof`, else `ss`, else `netstat -ano`; whether one listens at
  all is answered by a connection;
- how a command line from the config runs (`shellArgv`: `/bin/sh -c`, or `cmd.exe /d /s /c "…"`
  handed over verbatim), how an npm-installed CLI starts (`toolArgv`: a `.cmd` shim goes through
  `cmd.exe`, which Node refuses to spawn directly since April 2024), where a tool is (`which`,
  `PATHEXT` on Windows), how a file is opened for a human, which native build a package ships
  (`nativeTarget`, musl included).

Everywhere else: paths through `node:path`, temporary files under `os.tmpdir()` or the state folder,
no shell pipelines, a tool found with `which()`, a config's command line run with `runShell()`.

## Writing code here

- TypeScript strict, erasable syntax only (no enums, namespaces or parameter properties), ESM,
  imports with their `.ts`, `node:` modules only: the same files run on Node and on Bun. Two
  spaces, single quotes.
- Output goes through `process.stdout.write` / `console.log` exactly as it should read; errors
  through `die`. A helper's function name may keep the name of what it mirrors when that helps a
  reader find it.
- A comment says why: the edge case, the incident, the measured cost (the dates in them are real).
  Never what the next line does.
- Improve where it is free — a JSON answer parsed instead of grepped, a spawn avoided, a wait
  bounded — and say it in the commit body. A behaviour `skill/visual-check/**` documents changes
  with the skill in the same commit.

## Checking a change

- `npx tsc --noEmit -p .` and `npm test` (`node --test`, `test/**/*.test.ts`: parsers, layouts,
  text building, what is pure) pass at every commit.
- `node test/platform/smoke.ts` runs the launcher of the platform and every command that needs no
  device and no browser; CI runs it with the two above on macOS, Linux and Windows × Node 22 and 24,
  then each installer against the checkout.
- **Parity**: `test/parity/` runs a reference engine and this one on the same inputs and compares
  their lines, exit codes and files (images: same size, near-identical pixels). The reference is a
  bash vysu named by `VYSU_REF`; `test/parity/README.md` says how to get one and what each script
  needs.
- `node scripts/bench.ts --a <vysu A> --b bin/vysu -- "<args>" …` times two engines in pairs
  (medians), which is what holds on a machine other agents are using.
- The machine is shared: take a device with `vysu claim ios|android --any` and `vysu release` it,
  never drive one another owner claims, never stop a service, a Metro or an emulator you did not
  start, and run anything that deletes (`prune`, `cache clear`, `release --force`) with a scratch
  `VYSU_STATE` and `VYSU_SHOTS`.

## Switches for a contributor

- `VYSU_RUNTIME=bun` — the launchers run `src/cli.ts` on Bun. agent-browser, agent-device and the
  video render still need a `node` on the PATH (`nodeVersion()` in `src/setup/engine.ts`,
  `src/cmd/video.ts`).
- `VYSU_AGENT_DEVICE=cli` — every device call goes through the `agent-device` command instead of its
  library client. The client is loaded from the package the `agent-device` on the PATH runs, so it
  talks to the same daemon, and falls back to the command on its own when it is missing, older than
  `tools.env` asks, or when vysu runs on Bun (the client would start the shared daemon on bun)
  (`src/mobile/agent.ts`).
- `VYSU_DEBUG=mobile` — on stderr, stamped from the start of the command: when a relaunch handed the
  bundle over, what each look at Metro's log and at the screen found, and when it decided the app
  was on the launcher (`src/mobile/io.ts`).
