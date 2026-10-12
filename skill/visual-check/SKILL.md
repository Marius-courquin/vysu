---
name: visual-check
description: Entry point for ANY look at a running app, web or mobile, through `vysu`. Use it before saying a UI change is done, before any merge request that touches UI, and whenever someone asks to check, see, look at, screenshot, compare, test on a phone, an iPhone, Android, a tablet, in large text or dark mode, a notification or a push, a page of the site, a Storybook story, or asks "does it look right". Covers a real browser (any URL) and iOS simulators / Android emulators - one session per persona with the login kept, recent and old device, diff against a deployed baseline, contact sheets. Device and multi-screen work is delegated to a short-context checker agent.
---

# Visual verification (`vysu`)

`vysu` drives agent-browser (web) and agent-device (mobile) against the real app: one session **per
persona** whose state is restored (no re-login on every run). Captures live outside every repo,
under the project's state folder (`vysu doctor` prints it). Turning a recording (`rec`, `mrec`)
into a demo video: skill **demo-video**.

Nothing here names a value. What this project decides - origin, personas, baseline, devices,
services, push presets, deep-link prefix - comes from `vysu doctor` (resolved values and where each
came from), the project's `.vysu/config`, and `vysu persona list`. A project may add an **overlay
skill** (its definition of done, personas, test data, merge-request rules); this skill stays the
mechanics.

## 1. Delegate first

A visual check is dozens of tool calls, and every call re-reads the whole conversation. Measured on
62 sessions: the same device round trip cost **386k tokens of context** in a long development
session and 185k in a sub-agent, and the long session also lost its thread. So:

- **Delegate** to a checker sub-agent whenever the check needs a device, more than one screen, a
  persona change, a state to set up (deep link, offline, permission, large text), or an
  interaction pass. The brief template and the report contract are in `references/delegate.md`.
  **`vysu checker`** names the model to spawn it on for the agent tool you are (the project sets
  it per tool in `VYSU_CHECKER_MODELS`: driving and capturing need no frontier model, you judge
  the design on the sheet it returns); pass it as the sub-agent's model (Claude Code's Agent tool,
  Codex's spawn_agent). Claude Code also gets a ready `visual-checker` agent from `vysu init`. An
  agent without sub-agents runs the same brief itself.
- **Inline** only for one `vysu walk` / one `mshot` you will read yourself.
- Give the checker **what changed and what should now look different**: it reports facts (what is
  on screen, what moved, what the logs say); you judge.

## 2. When (definition of done)

- **Web** - every screen the change touches:
  `vysu walk <persona> <name> --url <origin>/<path> --baseline-url @`, and `check: clean`.
- **Mobile** - every screen on the **recent and the old** device of each platform, then in `xl`
  text (`vysu mdo … --devices "<recent>,<old>" --textsize normal,xl` does the matrix in one call).
- **Interaction** - a screen that scrolls, drags, pulls to refresh, opens a sheet or animates: one
  short `mrec` (or `rec` on the web) of that gesture, read through its motion report. Static
  captures never show a drag defect.
- **Notifications** - if the change touches one, trigger it for real (`vysu push`, or the
  project's own command).
- **"Fixed" needs evidence**: after a fix, the capture of that screen says
  `vs previous: N zones changed` on the zone in question. `unchanged` means the fix is not on
  screen (stale bundle, a style class that was not compiled, the wrong device): `vysu mlog --errors`,
  `vysu mreload`, then capture again. Never announce a fix on an unchanged capture.
- `vysu report <name> --md` goes into the `## Tests` section of the merge request.

## 3. The loop, in tokens

Images are cheap when small (a 1x mobile capture is about 470 tokens, a web capture about 1 700,
an Android capture in device pixels three times more); round trips are what cost. Text first,
one call instead of five, image last.

**Web**: `vysu up <service>` if needed, then `vysu walk` per screen -> a report of 25 lines or fewer:
what moved, what the browser complained about, **the single image to read**. Read only the
`read: ...-changed.png`. Interaction: `vysu <persona> snapshot -i -c`, act by refs, `vysu check`.
Several checkers as the **same persona** at once: each starts with `vysu claim <persona> --any`, which
hands it a session nobody uses (`<persona>`, else `<persona>@2`, `@3`…, logged in on first use), and
names that session on every command (`vysu walk <persona>@2 …`, printed on the `name it:` line).

**Mobile**:

1. `vysu claim ios|android --any` (or `--device` / `--avd`): a free device becomes yours for the
   task, and every next command aims at it. `vysu devices` says who holds what. Holding two
   devices of a platform (two checkers of one session are one owner), every command names its own:
   the claim prints the prefix on a `name it:` line (`VYSU_ANDROID_AVD=<avd> vysu …`).
2. `vysu mdo <platform> --shots <name> -- "<step>" …`: the steps run in one call, one line each,
   with the screen after each step (labels, node delta, keyboard). Steps: `open <route>`,
   `tap "<label>" [--wait "<text>"]`, `fill "<label>" "<value>"`, `type`, `key return|dismiss|back`,
   `wait "<text>"`, `wait gone "<text>"`, `wait idle`, `scroll-to "<label>"`, `expect [no] "<text>"`,
   `net offline|online`, `perm <name> grant|deny|reset`, `relaunch [--textsize …]`, `shot <label>`,
   `screen`. **Never `sleep` to wait for the app**: wait for what you expect to see.
3. Read the sheet (`sheet:` line) or the one capture that changed (`vs previous:` line).
4. `vysu mlog --errors` (`--device` for this device only) before concluding: a red bundle or an
   API error is a defect even when the capture looks fine. `metro: bundle failed` means the code
   on disk does not compile right now, possibly because of another session's edit.
5. `vysu release <platform> --reset` at the end.

## 4. Commands

```bash
vysu doctor --brief · <command> --help              # problems only · one command's options
# web
vysu walk <p> <name> --url <url> [--baseline-url @|<url> | --baseline <name>] [--sizes WxH,…] [--dark] [--full]
vysu shots <p> <name> … · report <name> [--md] · sheet <name>… [--only <glob>] [--strip] · check <p>
vysu up <web service> --isolated                  # your worktree's web, same origin, for your sessions only
vysu flow <p> <file|-> --shots <name> [--keep-going]   # also the batch mode: many go/shot lines, one call
vysu rec <p> <name> -- "<step>"… · login <p> · <p> <agent-browser args…>
vysu claim <p> --any                              # a free session of <p>: <p>, <p>@2… (VYSU_WEB_SLOTS)
# devices
vysu devices · claim ios|android [--any | --device <name> | --avd <name>] [--minutes 20] · release … [--reset]
vysu up ios|android [--device <name>] [--avd <name>] [--isolated [--port N] [--dir <mobile dir>]]
vysu adb <args…> · simctl <verb> [args…]          # raw tools on YOUR device, under its lock
# mobile
vysu mdo ios|android [--shots <name>] [--devices "<a>,<b>"] [--textsize normal,xl] [--keep-going] -- "<step>"…
vysu mopen ios|android <route|url> [--wait "<text>"] · mwait ios|android "<text>" [--gone] [--timeout s]
vysu mtap ios|android "<label>" [--wait "<text>"] · mshot ios|android <name> [label] [--full] [--no-prev]
vysu mreload ios|android · mrelaunch ios|android [--textsize …] [--appearance …] [--lang …]
vysu mnet android offline|online · mperm ios|android <name> grant|deny|reset
vysu mburst ios|android <name> [--seconds 3] -- "<step>" · mrec ios|android <name> -- "<step>"…
vysu mlog [mark | --errors | --device | --tail N] · mlogin ios|android <p> · textsize|appearance …
vysu ios|android <agent-device args…>             # the raw driver, when a verb above does not fit
```

`click` (web) and `tap` (mobile) take the **exact** label; `--partial` opts into « contains ».
`VYSU_WEB_HIDE` hides a dev build's overlays (a devtools button) from every web capture. Give a
long call (`mlogin`, `up`, `mrelaunch`, `claim --any`) a 5-minute timeout on the shell tool call
itself, never a `timeout` prefix: vysu bounds its own calls.

`-` as the persona is an anonymous session (a public page, a marketing site, a Storybook story).
`<p>@2` is `<p>` in a second browser session of its own (its own login, its own page): what
`claim <p> --any` hands out when `<p>` is busy. The anonymous session has them too: `claim - --any`
hands out `-`, `-@2`… for checkers of public pages side by side.

## 5. Sharing one machine

Several agents (and the developer) share the simulators, the emulators and, by default, **one
Metro serving one checkout**: every command locks what it touches, a claim holds a device or a
persona session for a task. A persona is not one browser: `claim <persona> --any` gives each agent
its own session of it, so web checks as the same persona run side by side. In the shared mode an edit anywhere in the checkout reloads every device: judge after
`vysu mreload`, and read `mlog` before blaming the screen. For a phase that must not be disturbed,
`vysu up <platform> --isolated` from your own worktree gives you your own Metro on your own port
(about 1-1.5 GB of RAM: a mode for isolated phases, not the default). The web dev server is shared
the same way: never stop someone else's; `vysu up <web service> --isolated` serves your worktree to
your browser sessions under the same address (`vysu down <service>` when done).

## 6. Reporting to the person

A contact sheet with a **numbered legend** (1: before, 2: after, 3: xl text…) and one question
when a decision is theirs. Keep process out of the answer (commit ids, which device was released,
lint results): that belongs in the merge request.

## Do not

- Build a Playwright / MSW harness or a fake auth context just to "see" a screen.
- `sleep` to wait for the app (`wait idle`, `wait "<text>"`), or write a helper script or a shell loop
  for a sequence `mdo` or `flow` can run.
- Run `adb` / `xcrun simctl` directly: another agent's device may answer. `vysu adb` / `vysu simctl`.
- Open a capture listed after `identical, do not read:`, or a full-size one when a `-changed.png`
  exists.
- Re-run `login` / `mlogin` without a reason: a login consumes the SSO session.
- Write captures into a repo, or use the default agent-browser session (no `--session`).
- Work around a `busy` / `claimed by` line: wait, `claim --any`, or ask.

## References

`Read skill/visual-check/references/<file>` (installed copy: `.claude/skills/visual-check/references/`).

- `delegate.md` - the checker brief template, the report contract, the agent definition.
- `mobile.md` - devices, pool and claims, `mdo`, sessions, deep links, offline, permissions,
  bursts, large text, isolated mode, logs.
- `diff.md` - reading a diff, a report, a sheet, `meta.json`; `--full`, `--ignore`, `box` + `mark`.
- `demo.md` - web flows, `rec`, `events.json`, `cut.json`, `frame`, `sheet --compare`.
- `notifications.md` - in-app, e-mail, push through `vysu push`.
- `local-stack.md` - a local stack through `vysu up`, a known state, data the environment lacks.
- `troubleshooting.md` - when `vysu` misbehaves.
