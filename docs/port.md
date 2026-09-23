# Porting the engine to TypeScript

The bash engine (`legacy/vysu` + `lib/*.sh`) and its Python helpers (`py/*.py`) move to TypeScript under
`src/`, run as it is by Node ≥ 22.18 (type stripping, no build step). The goals, in order:

1. **Same behaviour.** Every command prints the same lines, exits with the same code, writes the same
   files (shots folders, meta.json, events.json, verdicts, state files, locks, claims) as the bash one.
   Agents and skills read these outputs: a changed word is a regression unless it is a deliberate fix.
2. **Faster.** No bash fork storms, no Python start-up (≈ 250 ms each), `agent-browser` called by its
   native binary (10 ms instead of 116 ms through its node wrapper), `agent-device` through its library
   client (`createAgentDeviceClient`) where a command makes several calls, `ps`/`lsof` only when needed.
3. **Runs on macOS, Linux and Windows.** Everything OS-specific goes through `src/core/host.ts` (or a
   function added there). iOS stays macOS-only and says so in one line elsewhere. Paths with
   `node:path`, no `/tmp` (use `os.tmpdir()` or the state folder), no shell pipelines, executables found
   with `which()` (it knows `.exe` / `.cmd`), a command line from a config run with `runShell()`.
4. **No Python at the end.** Every `py/*.py` and every inline `python3 -c` becomes TypeScript.

The legacy engine keeps running every command not ported yet (`src/core/legacy.ts`), so the branch
works end to end at every commit. When the last command is ported, `legacy/`, `lib/` and `py/` go.

## Layout and who owns what

| Path | Lot | What |
|---|---|---|
| `src/cli.ts`, `src/commands.ts`, `src/core/*` | core (integrator) | entry, dispatch, config, locks, claims, owner, host, proc, net, rec, i18n, personas, project commands |
| `src/img/*`, `src/cmd/{mark,frame}.ts`, `sheet --compare` | **img** | every `py/*.py` as a module exporting `main(argv, io)` + typed functions |
| `src/web/*`, `src/auth/*`, `src/connectors/auth/*`, `src/cmd/{shots,walk,flow,rec,lang,check,box,login,auth,mlogin,prune,cache}.ts` | **web** | `web.sh`, `auth.sh`, web half of `flow.sh` and `shots.sh`, the auth connectors, the persona passthrough |
| `src/mobile/*`, `src/push/*`, `src/connectors/push/*`, `src/cmd/{ios,android,m*,push,textsize,appearance,claim,release,devices,adb,simctl}.ts` | **mobile** | `mobile.sh`, `mctl.sh`, `mdo.sh`, `metro.sh`, `pool.sh`, `push.sh`, mobile half of `flow.sh` and `shots.sh`, claims commands |
| `src/setup/*`, `src/services/*`, `src/video/*`, `src/cmd/{up,down,setup,init,doctor,update,version,checker,cut,video}.ts`, `install.*`, `.github/`, `templates/` | **platform** | `setup.sh`, `services.sh`, `checker.sh`, `video.sh`, installers, CI, Windows specifics |

A lot touches its own paths only. Shared files (`src/commands.ts`, `package.json`, `docs/port.md`) take
one-line additions; the integrator resolves the merges.

### Contracts between lots

`src/mobile/api.ts` and `src/web/api.ts` hold the functions another lot calls, with placeholder bodies.
The owning lot replaces the bodies and keeps the signatures; a lot that needs something more from
another adds it to that file as a placeholder with a comment, and says so in its report.

`src/img/tools.ts` runs a helper by its old script name (`tool('diff', argv)`): the TS module when the
img lot has registered it in `ported`, the Python script until then. Web and mobile code call helpers
through it only, with the same argv the bash engine passed, and parse the same stdout.

## The core you build on

- `config()` (`src/core/ctx.ts`): `get(KEY, default)` is `cfg`, `need(KEY, why)` is `need_cfg`,
  `needProject()`, `origin(KEY)`, paths (`state`, `shots`, `logs`, `locks`, `claims`, `personas`,
  `locales`, `webRepo`, `mobileDir`, `androidSdk`, `remotion`), `childEnv()` / `exportedEnv()`.
- `die(msg, next?)` throws, `exit(code)` throws, `log()`, `onCleanup(fn, sync?)` (`src/core/errors.ts`).
- `ok/warn/miss/info/head/summary/allRequiredPresent` (`src/core/ui.ts`).
- `owner()`, `devices` (`.ios`, `.android`, `.named(p)`, `.isNamed(p)`), `deviceGuard`, `lockTake`,
  `iosLock`/`androidLock`/`platformLock`, `lockDrop`, `claimWhy`/`claimWrite`/`claimRenew`/`claimField`,
  `ownerDevices`, `deviceRemember`, `resourceOf`, `locksReport` (`src/core/hold.ts`).
- `run()` / `runBuffer()` / `runShell()` / `spawnDetached()` / `spawnShellDetached()` / `killTree()`
  (`src/core/proc.ts`); `which()`, `isListening()`, `listenerPids()`, `openForHuman()`, `processTable()`,
  `isWindows`/`isMac`/`isLinux`/`isWsl` (`src/core/host.ts`); `listening()`, `killPort()`, `waitHttp()`
  (`src/core/net.ts`).
- `metaRead/metaWrite/repoSha/repoBranch` (`src/core/meta.ts`), `ev`/`evStart`/`evLog`/`now`/
  `clipNormalize` (`src/core/rec.ts`), `i18nLabel`/`langCheck` (`src/core/i18n.ts`), personas
  (`src/core/personas.ts`), `slug`/`commaList`/`hhmm`/`isoLocal`/`sleep` (`src/core/text.ts`),
  `pyRound`/`fnmatch`/`htmlEscape` (`src/core/py.ts`).

## Rules of the port

- Port function by function, keeping the bash function's name in camelCase where it helps a reader
  find it, and keeping the substance of its comments: they are the why of every edge case (the dates
  and incidents in them are real). No new comment that says what the code does.
- A command module exports `run(args: string[])` and is registered in `src/commands.ts`.
- Output goes through `process.stdout.write` / `console.log` exactly as the bash printed it; errors
  through `die`. `die` inside a helper crosses every await: do not catch `VysuError` except to add
  context.
- Keep the bash engine's files byte-compatible (names, formats, `slug()` of device names), so both
  engines can run side by side on one machine during the transition.
- Improve where it is free: a JSON answer parsed instead of grepped, a spawn avoided, a wait bounded.
  Say what you improved in the commit body. Do not change a behaviour the skills document
  (`skill/visual-check/**`) without saying so in the report.
- Code: TypeScript strict, erasable syntax only (no enums, namespaces, parameter properties), ESM,
  imports with `.ts`, `node:` modules only (the code must also run on Bun), 2 spaces, single quotes.

## Tests

- `npx tsc --noEmit -p .` and `npm test` (`node --test`) pass at every commit.
- Unit tests in `test/<lot>/*.test.ts` for what is pure (parsers, layouts, text building).
- **Parity** is the main test: run the legacy engine and the new one on the same input and compare
  (`bash legacy/vysu <cmd> …` against `bin/vysu <cmd> …`, or the Python script against the TS module).
  Text outputs identical; images the same size with near-identical pixels. Keep the comparison
  scripts under `test/parity/` so they can be re-run.
- `node scripts/bench.ts --a <bash vysu> --b bin/vysu -- "<args>" …` for timings (paired, medians).

## The machine is shared

Other agent sessions use the installed engine (`~/Documents/Projects/vysu`, bash) on the same
simulators, emulators and browser sessions, right now. So:

- Never touch `~/Documents/Projects/vysu` (the live install) or another worktree.
- Take a device with `vysu claim ios|android --any` (either engine: the claim files are shared) and
  `vysu release` it when done; never drive a device another owner claims; never stop a service,
  Metro or an emulator you did not start; never `prune` or delete real shots (use `--dry-run`, or a
  scratch `VYSU_STATE` / `VYSU_SHOTS` in the session scratchpad).
- Real project to test against: `~/Documents/Projects/Nidz/nidz-env` (its `.vysu/config`; personas are
  there, `vysu persona list`). Read-only navigation on prep (`https://next.prep.nidz.fr`) is fine; no
  mutation of shared data.
- Commit on your lot branch only (Conventional Commits, English, lower case, no AI trailer, no
  `Co-Authored-By`). Never commit on `main`, never push, never merge.
