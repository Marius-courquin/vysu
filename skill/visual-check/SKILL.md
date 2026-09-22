---
name: visual-check
description: Visual verification of a screen in a real browser (any web app, any URL, a Storybook story, a marketing page) or on an iOS simulator / Android emulator through `vysu` - one session per persona with the login kept, accessibility snapshot, multi-viewport, recent and old device, large text, dark theme, notifications (in-app, push), diff against a deployed baseline, contact sheet, annotations. Use before any merge request touching UI, and on "check this visually", "screenshot", "what does it look like", "on mobile", "in large text", "the push notification".
---

# Visual verification (`vysu`)

`vysu` drives agent-browser (web) and agent-device (mobile) against the real app: one session **per
persona** whose state is restored (no re-login on every run). Captures live outside every repo,
under the project's state folder (`vysu doctor` prints it; default `~/.vysu/<project>/shots/`).
Turning a recording (`rec`, `mrec`) into a demo video: skill **demo-video**.

Nothing here names a value. What this project decides - origin, personas, baseline, devices,
services, push presets - comes from three places, and only from them:

| Question | Where the answer is |
|---|---|
| origin, baseline, viewports, language, devices, services, push drivers, auth connector | `vysu doctor` (the resolved values and where each came from) |
| the same, editable | the project's `.vysu/config` |
| who can log in | `vysu persona list` |

A project may add its own **overlay skill** on top of this one: its definition of done, its
personas and what they are for, its test data and its merge-request rules. This skill stays the
mechanics.

## When (definition of done)

- **Web** - every screen the change touches:
  `vysu walk <persona> <name> --url <origin>/<path> --baseline-url @`, and `check: clean`.
  `--baseline-url @` means "the same path on `VYSU_BASELINE_ORIGIN`", which is normally the
  deployed main branch: a branch is read against main without a checkout.
- **Mobile** - every screen on the **recent and the old** device of the platform, then `textsize xl`.
- **Notifications** - if the change touches one, trigger it for real (`vysu push`, or the project's
  own command).
- `vysu report <name> --md` goes into the `## Tests` section of the merge request. A contact sheet
  or an annotated PNG only when the pixels are the question.

## The loop, in tokens

Every image is downscaled before it is tokenised (Claude: 1 568 px on the long side, then about
`w x h / 750` tokens; OpenAI: 512 px tiles, same order of magnitude): a web capture is about
1 700 tokens, a 1x mobile capture about 470, an Android capture in device pixels three times more
(hence the 1x), a tall contact sheet 1 800-2 900 **and unreadable** (table in `diff.md`). A tool
call costs about 200 tokens *plus* the reasoning between two calls: one `walk` replaces six calls.
Text first, image second.

1. `vysu up <service>` if the app is not being served yet (the services this project declares are
   in `vysu doctor`; `vysu up all` starts them in order).
2. `vysu walk` per screen -> a report of 25 lines or fewer: what moved, what the browser
   complained about, **the single image to read**. `vysu report <name>` reads it back without
   re-capturing.
3. Read **only** the `read: ...-changed.png`. Never what follows `identical, do not read:`.
4. Several states: `vysu sheet <name>` -> `sheet-1.png`. One detail: `vysu box` then `vysu mark`.
   A long screen: `--full` (how it unfolds inner scrollers: `diff.md`). Full size only when the
   pixels are the question.
5. Interaction: `vysu <persona> snapshot -i -c` (about 300 tokens; never a bare `snapshot`, never
   `get html`), `-s "<css>"` to scope it, then `--delta`. Act by refs (`click @e12`).
6. `vysu check <persona>` after any screen reached outside a `walk` (a framework error or a 4xx/5xx
   on the API is a defect), and `vysu <persona> close` at the end.

## Commands

```bash
vysu up <service> | up all | down <service> | down all | down metro
vysu walk <p> <name> --url <url> [--baseline-url @|<url> | --baseline <name>] [--sizes WxH,…] [--dark] \
                                 [--full] [--no-expand] [--no-warm] [--lang <l>] [--ignore <css>]… [--freeze]
vysu shots <p> <name> …            # captures only (walk = shots + check + report)
vysu report <name> [--md] · sheet <name> [--cols N] [--max 6] [--open] · check <p> [--save <name>] · lang <p> <l>
vysu flow <p> <file|-> --shots <name> [--viewport WxH]
vysu rec <p> <name> [--fps 30] [--viewport 1440x900] [--cursor] [--flow <file>] -- "<step>"…
vysu frame <name|file> [--preset framed|pitch] · sheet <name> --compare [--against <name>] · render <args>
vysu cut <take> --draft [--force] · video <take> [--format landscape|portrait|all] [--check] [--draft]
vysu login <p> [url] · auth token <p> · box <p> <selector|@ref> [--page] · mark <png> …
vysu <p> <agent-browser args…>     # open, snapshot -i -c, click, fill, eval, network route…
vysu up ios | android [--build] [--device <name>] [--avd <name>]   # Metro + simulator / emulator
vysu mlogin ios|android <p>        # once per persona and install
vysu ios|android <agent-device args…>   # snapshot -i, press @eN~sN --settle, wait text "…" 15000
vysu mshot ios|android <name> [label] [--baseline <name>] [--full [--step 150] [--max 12] [--top <pt>] [--bottom <pt>]]
vysu mrelaunch ios|android [--textsize normal|large|xl] [--appearance light|dark] [--lang <l>]
vysu mtap ios|android "<label>" · mflow ios|android <file|-> --shots <name> · mrec … · mlog [mark|--tail N]
vysu push ios <preset> · push <p> <preset> [--platform ios|android] [--field k=v]…
vysu textsize ios|android normal|large|xl · appearance ios|android light|dark
vysu claim ios|android|<p> [--minutes 30] [--note "<why>"] · release <same> [--force] [--reset]
vysu prune [--days 30] [--match "<glob>"]… [--dry-run] · cache clear · doctor · persona list · setup · init
```

`-` as the persona is an anonymous session: a public page, a marketing site, a Storybook story.

## Personas and data

`vysu persona list` names them; `vysu doctor` says where the file is. Credentials live in
`personas.env` under the state folder, mode 600, outside every repo, and are **never printed**.
Keep mutations inside whatever scope the project reserves for them (its overlay skill says which);
a state the environment does not produce on demand is simulated with `network route`, not with a
mock harness - see `local-stack.md`.

## Do not

- Build a Playwright / MSW harness or a fake auth context just to "see" a screen.
- Open a capture listed after `identical, do not read:`, or a full-size one when the
  `-changed.png` exists.
- Re-run `login` / `mlogin` without a reason: a login consumes the SSO session and rotates the
  refresh token.
- Write captures into a repo.
- Use the default agent-browser session (no `--session`): it is shared between agents.
- Work around a `busy` line: wait, switch device or persona, or `vysu claim` at the start of a
  mobile task.

## References

`Read skill/visual-check/references/<file>` (installed copy: `.claude/skills/visual-check/references/`).

- `diff.md` - reading a diff, a report, a contact sheet, `meta.json`; `--full`, `--ignore`,
  `--freeze`, `box` + `mark`.
- `demo.md` - web flows (`flow`, `rec`), `events.json`, `cut.json`, `frame`, `sheet --compare`.
- `mobile.md` - iOS / Android: devices, `mlogin`, agent-device, large text, `mrelaunch`, flows.
- `notifications.md` - in-app, e-mail, push through `vysu push`.
- `local-stack.md` - a local stack through `vysu up`, a known state, data the environment does not
  produce.
- `troubleshooting.md` - when `vysu` misbehaves.
