# vysu

Look at a real app the way a reviewer does, in tokens an agent can afford.

vysu ("visu") drives a real browser, an iOS simulator and an Android emulator against the app you
are building: one session per persona whose login survives across runs, screenshots and diffs kept
outside every repo, a 25-line text report before any image, and a recorded flow that becomes a demo
video. It works the same for Claude Code, Codex, or a human in a terminal.

## Install

```bash
git clone https://github.com/Marius-courquin/vysu ~/vysu
echo 'export PATH="$HOME/vysu/bin:$PATH"' >> ~/.zshrc && exec zsh
vysu setup                     # tools, browser, simulators, emulators (asks before creating devices)
```

Then, in your project:

```bash
vysu init                      # writes .vysu/config, picks an auth connector, installs the agent skills
vysu persona add alice         # e-mail + password, stored under ~/.vysu/<project>/ (mode 600)
vysu login alice               # once; the session is kept
vysu walk alice home --url http://localhost:3000/
```

`vysu init` also prints [`templates/agents-snippet.md`](templates/agents-snippet.md), the paragraph
to paste into your `AGENTS.md` / `CLAUDE.md`. `vysu update` pulls the latest engine, and
`vysu doctor` says what is configured and what is missing.

## Five minutes

```bash
vysu up web                                        # the dev server your config declares
vysu walk alice feed --url http://localhost:3000/feed --baseline-url @
```

`walk` opens the page, collects the browser's complaints, captures every viewport, diffs each one
against the same path on your baseline origin and prints the report — six calls in one. The report
names **the single image worth reading**, and names the identical ones so they stay unopened:

```
web · alice · http://localhost:3000/feed · lang en · 4 sizes · vs https://main.example.com/feed · sha 1a2b3c4 (feat/x) · api staging · 2026-09-21 10:12
1440x900: changed 0.4 % (5 210 px) · 2 zones
check: clean
identical, do not read: 360x800.png, 768x1024.png, 1280x800.png
read: /Users/…/shots/feed/1440x900-changed.png
```

```bash
vysu report feed --md                              # the same, fenced, for the ## Tests of a merge request
vysu sheet feed                                    # several states on one contact sheet, <= 1568 px
vysu up ios && vysu mlogin ios alice               # Metro + simulator, one login per install
vysu mshot ios feed-ios                            # 1x capture, frozen status bar, diffable
vysu textsize ios xl                               # the check nobody does by hand
vysu rec alice feed-clip -- "go http://localhost:3000/feed" "sleep 1" "click \"Issues\""
vysu cut feed-clip --draft                         # the montage script; you write the words
vysu video feed-clip --check && vysu video feed-clip
```

Nothing above was committed to your repo: captures, clips and renders live under
`~/.vysu/<project>/shots/`.

## Concepts

- **Persona** — a named browser (or device) session whose login is restored on every run. `-` is an
  anonymous one, for a public page. Credentials live in `personas.env` under the state folder,
  mode 600, and are never printed.
- **Session** — one agent-browser session per persona (`<project>-<persona>`), one agent-device
  session per device (`<project>-<platform>-<device>`). Several agents share a machine: every
  command locks what it drives, and `vysu claim` holds a device across a whole task.
- **Shots folder** — `~/.vysu/<project>/shots/<name>/`: the captures, the diffs, `meta.json` (which
  branch, which API, which viewports), `check.txt`, the contact sheets, and for a recording the
  clip, `events.json`, `motion.txt` and the render. `vysu prune` clears it out.
- **Connector** — the bash file that knows how your app signs a persona in: a built-in named by
  `VYSU_AUTH`, or `.vysu/auth.sh`. It is the only place that knows about your identity provider.
- **Service** — a command, a port and a health check, declared in the config. `vysu up web`,
  `vysu up all`, `vysu down db` — the engine knows no stack.
- **Project command** — an executable `.vysu/commands/<name>`, run by `vysu <name>` with every
  resolved `VYSU_*` exported: where seeding and other app-specific chores live.
- **Theme** — the brand of the explainer video: `.vysu/themes/<name>/theme.json` in your project,
  otherwise the engine's neutral `default`.

## Configuration

`.vysu/config` at the root of your project, written by `vysu init` from
[`templates/config.example`](templates/config.example), which documents every key. The full list
with defaults and examples is in [docs/config.md](docs/config.md).

| Section | Keys | What it decides |
|---|---|---|
| identity | `VYSU_PROJECT`, `VYSU_STATE`, `VYSU_MIN_VERSION` | session prefix, state folder, the engine version you need |
| the web app | `VYSU_ORIGIN`, `VYSU_LOGIN_PATH`, `VYSU_BASELINE_ORIGIN`, `VYSU_SIZES`, `VYSU_LANGS`/`VYSU_LANG`/`VYSU_LANG_STORAGE_KEY`, `VYSU_LOCALES`, `VYSU_WEB_REPO`, `VYSU_API_PATTERN`, `VYSU_API_HOSTS` | what is opened, what `--baseline-url @` points at, which viewports, which languages, what a report calls the API |
| auth | `VYSU_AUTH`, `VYSU_AUTH0_*` | which connector signs a persona in, and its labels |
| the mobile app | `VYSU_MOBILE_BUNDLE`, `VYSU_IOS_APP`, `VYSU_MOBILE_DIR`, `VYSU_MOBILE_ENV`, `VYSU_MOBILE_SCHEME`, `VYSU_MOBILE_READY_TEXT`, `VYSU_IOS_DEVICE`/`VYSU_IOS_OLD_DEVICE`, `VYSU_ANDROID_AVD`/`VYSU_ANDROID_AVDS`, `VYSU_ANDROID_LOCALE` | which app on which devices, and how it is started |
| services | `VYSU_SERVICES`, `VYSU_SERVICE_<name>_CMD/_DIR/_PORT/_HEALTH/_ENV/_TIMEOUT/_STOP` | what `vysu up` and `vysu down` know |
| push | `VYSU_PUSH`, `VYSU_PUSH_WEBHOOK_URL`, `VYSU_FCM_SA` | which drivers, and what they need |
| video | `VYSU_THEME` | the brand of the explainer video |

An environment variable of the same name wins over the file, so `VYSU_ORIGIN=… vysu shots …`
overrides a value for one command. `vysu doctor` prints what is in force and where each value came
from.

## Writing an auth connector

The built-ins cover a hosted identity provider (`auth0`), a same-origin form (`form`) and no login
at all (`none`). For anything else, `vysu init` copies a commented template to `.vysu/auth.sh` and
`VYSU_AUTH='custom'` picks it up. The contract — the five functions to define, the primitives a
connector may call, and how to test it — is in
[`connectors/auth/README.md`](connectors/auth/README.md).

## Agent skills

`vysu init` installs two skills into `.claude/skills/` (or `--skills-dir <dir>`):

- **`visual-check`** — the token-aware loop, the commands, how to read a diff / report / contact
  sheet, mobile devices and large text, notifications, a local stack, troubleshooting.
- **`demo-video`** — a recording turned into an explainer video: `rec`/`mrec` → `cut.json` →
  `vysu video`, in 16:9 and 9:16.

They hold no project value: they point at `vysu doctor`, `.vysu/config` and `vysu persona list`. A
project that has its own definition of done writes a thin overlay skill on top.

## Requirements

- **macOS** for the mobile side (agent-device drives the iOS simulator through Xcode). The web side
  should work anywhere bash and node do.
- **bash >= 3.2** (the macOS default), **node >= 22** for `agent-browser` and `agent-device`.
- **python3** with **Pillow** and **numpy** (`pip3 install --user numpy pillow`) for the diffs,
  contact sheets, stitching and exports.
- **ffmpeg** for `rec`, `mrec` and `video`.
- **Xcode** (iOS simulators, plus an older iOS runtime for the old phone) and the **Android SDK**
  with `cmdline-tools` — both optional, and only for the platform you actually check.
- Remotion is installed on the first `vysu video`, not before. There is no npm package for vysu
  itself: the install is `git clone` plus PATH.

`vysu setup` checks all of it and installs what it can; `vysu doctor` says what is still missing.

## Status

Pre-1.0, tagged per release. The engine is in: every command, the config contract, personas,
services, devices, `setup` / `init` / `doctor` / `update`, the `auth0` connector, the `apns-sim`
and `webhook` push drivers, and the two agent skills. The design note is
[docs/design.md](docs/design.md); the lots are listed at its end.

## License

MIT — see [LICENSE](LICENSE).
