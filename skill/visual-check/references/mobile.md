# Mobile (iOS simulator, Android emulator)

Same contract as the web, with agent-device as the driver, against the dev-client the project
declares (`VYSU_MOBILE_BUNDLE`, `VYSU_IOS_APP`, `VYSU_MOBILE_DIR`, `VYSU_MOBILE_ENV` - `vysu
doctor` prints them). The mobile web (`vysu shots … --sizes 390x844`) does not replace the
simulator: the primitives are not the same.

## Devices

- iOS: the recent simulator (`VYSU_IOS_DEVICE`) and the old one (`VYSU_IOS_OLD_DEVICE`, a small
  home-button iPhone on an older iOS, created by `vysu setup`). Pick one with
  `vysu up ios --device "<name>"`; the choice is remembered.
- Android: the AVDs of `VYSU_ANDROID_AVDS`, the default being `VYSU_ANDROID_AVD`, picked with
  `vysu up android --avd <name>`. A Google APIs image is what makes real FCM possible.
- **A screen is validated on the recent device AND on the old one of each platform.**
- **Several agents on one machine: take a device, do not pick one by hand.** `vysu claim ios|android
  --any` takes a free device of the pool (`VYSU_IOS_DEVICES`, the AVDs of `VYSU_ANDROID_AVDS`):
  a booted one first, then a shut-down one it boots, then on iOS a clone of a pool device
  (`<base> (vysu N)`, up to `VYSU_IOS_MAX_CLONES`). `--device "<simulator>"` / `--avd <name>` claims
  a named one. Either way the device becomes **this owner's choice**: every next command aims at it,
  above the config (the environment still wins). `vysu devices` lists who holds what, in a second.
- **Two devices of one platform under one owner: name the device on every command.** The owner is
  the agent CLI process, so a session and every sub-agent it spawns are **one** owner: one claim
  does not keep a sibling checker out, and the remembered device is the last one any of them
  claimed. While an owner holds two devices of a platform, a command that names none is refused
  (`vysu: android: claude:41234 holds 2 devices (…) and this command names none`); the claim
  of the second one says so on a `name it:` line, with the prefix to use:
  `VYSU_ANDROID_AVD=<avd> vysu mdo android …`, `VYSU_IOS_DEVICE="<simulator>" vysu mshot ios …`,
  release included. `mdo --devices "<a>,<b>"` names its devices and needs no prefix.
- **Raw tools only through vysu**: `vysu adb <args…>` and `vysu simctl <verb> …` run on your device,
  under its lock (a raw `adb -s emulator-5556` once drove another agent's emulator).
- Each device has **its own** agent-device session - `<project>-ios-<slug>` addressed by UDID,
  `<project>-android-<slug>` addressed by serial - so several simulators and emulators run side by
  side. `vysu up ios --device …` / `vysu up android --avd …` **remembers** the choice: the next
  commands aim at that device without repeating it (`VYSU_IOS_DEVICE` / `VYSU_ANDROID_AVD` for a
  single command).
- An AVD's serial (`emulator-5554`, `-5556`…) is resolved **by its name** (`adb -s <serial> emu avd
  name`), cached and exported as `ANDROID_SERIAL`: every `adb` of `vysu` and of agent-device aims
  at that emulator, otherwise "more than one device/emulator". An AVD that is not running gives
  "android: <avd> is not running". Two emulators mean **4 GB of RAM each**: keep two only for the
  length of a comparison.

## Sessions

One install is **one session** (the refresh token lives in the keychain / keystore and survives a
reinstall). Changing persona means `vysu mlogin <platform> <persona>`: sign out, then sign in
through the connector, in the system web surface (SafariViewService / Chrome Custom Tab) read by
agent-device. On an older iOS simulator, agent-device may fail to read the system sign-in sheet
("requires a valid viewport"); the connector then falls back to geometry plus keyboard. The rest of
the app reads normally.

```bash
vysu claim ios --any                          # a free simulator, yours for the task (renewed on use)
vysu up ios | android                         # Metro (shared, VYSU_METRO_PORT) + device + the app on its bundle; --build: native (5-10 min)
vysu mlogin ios alice                         # once per persona and install (the state persists)
vysu mdo ios --shots s1 -- 'open notifications' 'wait idle' 'shot list' \
    'tap "Incidents" --wait "Récents"' 'expect no "Page introuvable"' 'shot incidents'
vysu mwait ios "Welcome" --timeout 15         # or --gone, --idle: instead of any sleep
vysu mtap ios "Help" --wait "FAQ"             # by label, then text, then "contains", settled
vysu mshot ios <name> [label] [--full]        # 1x; the same label again says « vs previous: … »
vysu mreload ios                              # this device's JS only, in place (3-10 s)
vysu mlog mark … vysu mlog --errors [--device]   # what the app logged since the mark, errors only
vysu ios snapshot -i | press @e21~s4 --settle # the raw driver, when no verb above fits
vysu release ios --reset
```

agent-device rules: a ref is valid for one frame only ("needs a complete snapshot" means taking the
emitted `@eN~sN` again); a button under the keyboard cannot be tapped (`keyboard return` submits
the form); a system alert or the system sign-in sheet reads like the rest.

## Picking a device back up

A device moves from one agent to the next: `vysu claim ios|android [--minutes 20]` reserves it
**and** says what state it is picked up in, instead of rediscovering it in five commands. `state:`
is what `vysu` applied to it (text size, appearance, language, persona signed in, Metro) with who
did it and when; `screen:` is the first six readable labels, when an agent-device session is
already open; `reset:` is the exact command, printed only when something differs from the defaults
(normal text, light, the default language). On a web persona, one evaluation gives
`state: url … · lang …`. The `screen:` line **names** the screen, it does not judge it: anything
asserted about a screen is asserted on a `snapshot` or a capture taken afterwards. At the end of a
task, `vysu release ios --reset` puts the device back in its defaults - only what differs, a
language already at the default avoiding an Android zygote restart; on a web persona, `--reset`
restores `media light`, the 1440x900 viewport and the default language. `vysu doctor` prints the
same `state:` line for every device that has one.

A claim is renewed by every command its owner runs on the device (the end moves to now +
`--minutes`), so a long task keeps it and a forgotten one ends 20 minutes after its last use; the
claim of an agent whose process is gone is dropped by the next command that meets it.

## Driving a screen in one call: `vysu mdo`

A dozen tool calls (press, sleep, snapshot, grep, capture) become one: each step prints one line,
`✓ 3 tap "Continuer" · Tapped …` or `✗ 3 tap "Publier" · nothing labelled « Publier »`, followed by
`screen: <up to 6 labels> (<n> nodes, +added −removed, keyboard)`; the first ✗ stops the run with
exit 1 (`--keep-going` marks it and goes on). Steps, one per argument or per line of a file (`-` for
stdin, `#` comments):

| Step | What it does |
|---|---|
| `tap "<label>" [--wait "<text>"]` | by label, then visible text, then "contains"; then waits for the text |
| `wait "<text>" [s]` · `wait gone "<text>" [s]` · `wait idle [s]` | until it shows / goes / two snapshots agree (10 s default) |
| `fill "<label>" "<value>"` · `type "<text>"` · `key return\|dismiss\|back` | fields by label (Android also shows `focus "<field>"`) |
| `scroll-to "<label>" [max]` · `expect [no] "<text>"` · `screen` | bring it on screen, assert, print the screen line |
| `open <route>` · `net offline\|online` · `perm <name> grant\|deny\|reset` | `mopen`, `mnet`, `mperm` inside a run |
| `shot <label> [--full]` · `relaunch [--textsize …]` · `sleep <s>` · any agent-device verb | as in `mflow` |

`--devices "<a>,<b>"` × `--textsize normal,xl` runs the steps once per pair, prefixes the shots
`<device>-<size>-`, makes **one** sheet and puts the text size back to normal. `mflow <file>` runs a
file the same way. iOS limits: `key back` needs an in-app back control agent-device recognises (tap
the app's own « Back » label instead), `key dismiss` needs a keyboard with a hide key, and a focused
field is not reported.

## State: deep links, network, permissions, bursts

- `vysu mopen <platform> <route|url> [--wait "<text>"]`: `VYSU_MOBILE_DEEPLINK` + the route. A cold
  app is launched first (a raw cold link parks the dev-client on its launcher), the system « Open
  in … ? » alert is pressed only when it shows, the existing task is reused on Android.
- `vysu mnet android offline|online`: airplane mode, read back; `release --reset` puts it online.
  The iOS simulator shares the Mac's network: there is no per-device switch, and vysu says so.
- `vysu mperm <platform> notifications|camera|photos|location|microphone|contacts|calendar
  grant|deny|reset`: `reset` makes the system ask again (iOS notifications through SpringBoard's
  BulletinBoard; Android through the permission flags, API 33+ for notifications). An app that
  remembers it already asked will not ask again: that is the app's state, not the device's.
- `vysu mburst <platform> <name> [--seconds 3] -- "<step>"`: frames at 1x while a step runs, the
  near-identical ones dropped, a one-row strip and a line `N distinct · 00 0.0s · 03 0.9s (38 %)…`:
  a skeleton, a flash, a transition, without a video.

## Captures and diff

**The same label twice** keeps the first capture as `<platform>-<label>.prev.png` and prints one
line under the path: `vs previous: unchanged`, or the zones that moved and the marked png. After a
fix, `unchanged` means the fix is not on screen: say so, never « fixed » (`--no-prev` to overwrite
without comparing). `vysu report <name>` reads a mobile folder back the same way as a web one.
On Android the capture holds the whole display, keyboard and system dialogs included (agent-device
selects an invisible input method to type with; the user's keyboard stands in for the capture).

`vysu mshot` captures **at 1x on both platforms**: the iOS status bar is normalised (clock, battery
and signal frozen, so the chrome stops being a diff), and Android device pixels are brought back to
1x (three times fewer tokens, boxes in dp). `--baseline <name>` diffs against the capture of the
same name in an earlier folder; both being 1x, the **zones are already in points**. Reading them:
`diff.md`.

**A long screen**: agent-device only captures the viewport - there is no full-page capture on
mobile. `vysu mshot ios|android <name> [label] --full` walks the screen instead: a capture, a
150 pt scroll (`--step`, that being the default on both platforms), the next capture, until two
identical captures (end of content) or `--max 12` - a very long screen therefore needs a larger
`--max`. The stitch detects the fixed bands (top / bottom), finds the offset between two captures
and glues everything into **one tall image, under the usual name** - `--baseline`, `vysu report`
and `vysu sheet` never notice. The screen is scrolled back to the top afterwards. The pieces stay
in `<name>/full-frames/` (1x, a few kB): that is where a doubtful seam is checked.

**When it does not stitch** (`N captures, 1 used`, or `duplicate … dropped` / `ambiguous` lines),
two settings, in this order:

- An even shorter `--step` (80-120). 150 pt is already the default, because the gesture does not
  get what it asks for: agent-device's scroll stops being proportional past about 200 pt, where the
  iOS simulator throws a *flick* that always lands in the same place, while 150 pt moves the
  content by about 100 pt. A short step advances less but leaves a clean overlap. A list of rows
  that all look alike aligns at several offsets at once, and the bigger the jump the less there is
  to decide with.
- `--top <pt> --bottom <pt>`. The stitch finds fixed bands by looking for rows identical in
  **every** capture; a bar drawn *over* the scroller has none. A shell that lets the content scroll
  under its status bar and under a floating tab bar gives `top 0 px · bottom 0 px`, and nothing
  aligns any more. `--top 60 --bottom 100` is the usual answer for such a shell.

Other limits: a **virtualised list** that recycles its rows can return two identical captures and
stop the stitching too early; a **sticky element inside** the scroller (a filter bar, a section
header) repeats from one piece to the next; a transient banner ("Refreshing…") ends up in the tall
image and shows up again at the next `--baseline`.

## Expo or native (`VYSU_MOBILE_KIND`)

An Expo app (`expo`, the default as soon as `VYSU_MOBILE_DIR` is set) runs behind Metro: `vysu up`
starts the bundler on 8081, `mrelaunch` waits for its "Bundled" line and `vysu mlog` reads
`logs/metro.log`. A **native** app (`native` — Swift, Kotlin, Flutter, .NET — and the default when
no `VYSU_MOBILE_DIR` is set) has none of that, and nothing above agent-device changes: `mshot`,
`mtap`, `mflow`, `mrec`, `textsize`, `appearance`, `push ios` and the auth connectors behave
identically. What differs: `vysu up ios|android` boots the device, installs the app from
`VYSU_IOS_APP_PATH` / `VYSU_ANDROID_APK` when it is not there (`--reinstall` to force it), starts a
tail of the app's own log and prints `→ vysu ios open "<app>" --foreground`; `--build` runs
`VYSU_MOBILE_BUILD_IOS` / `_ANDROID` in the background (`logs/<platform>-build.log`); `mrelaunch`
launches and waits for `VYSU_MOBILE_READY_TEXT` (five seconds when the project names none), with no
`metro` in the `claim` state line; and `vysu mlog [ios|android] [mark | --tail N]` reads
`logs/<platform>-app.log` — `log stream` filtered on the app's process on iOS, `logcat --uid` of
the package on Android, both surviving a relaunch. `vysu down applog` stops those tails,
`vysu down metro` stays the expo one. `vysu doctor` prints the kind in force.

## One Metro, or your own

By default every session shares **one Metro** (`VYSU_METRO_PORT`, 8081) serving **one checkout**:
an edit anywhere reloads every device, and a file that does not compile breaks every screen.
`vysu mlog` then starts with `metro: bundle failed since the mark: <error> (<file>)` and `mrelaunch`
stops in seconds with the same line instead of waiting for a bundle that will not come: the cause
may be another session's edit. Judge a screen after `vysu mreload` (this device only, 3-10 s)
rather than after whatever Fast Refresh last happened. A reload the app does not start within 5 s,
or that fetches no bundle within 10 s of starting, becomes a relaunch at once, and the line before
it says why (`the page took the reload but the app never started it, relaunching instead`).
`mrelaunch` prints its time
(`relaunched in 13s (bundled after 8s)`), reopens a lost agent-device session and clears Expo's dev
menu and its intro (`VYSU_MOBILE_DISMISS_LABELS`).

For a phase that must not be disturbed: `vysu up <platform> --isolated [--port N] [--dir <mobile
dir>]` from your own worktree starts **your** Metro on the next free port (8082+), points your
device at it, and every command of yours follows it; `vysu down metro` stops it and sends the device
back to the shared one on its next relaunch. It costs about 1-1.5 GB of RAM: a mode, not the default.

`vysu mlog --errors` keeps errors and warnings, repeats collapsed (`401 … ×8`); `--device` reads this
device's own JS log (simulator log stream, logcat) instead of Metro's, which mixes every device;
`VYSU_MLOG_IGNORE` drops the project's known noise and says how many lines it dropped.

## Android: what `vysu up android` sets (do not redo it by hand)

Host GPU, 4 GB and 4 cores (a stock AVD ships with the GPU off and 1.5 GB: software rendering, ANRs
at boot); **explicit DNS servers** (`1.1.1.1,8.8.8.8`, so the guest does not inherit a VPN resolver
it cannot reach, which makes FCM and any cloud SDK flaky); the locale of `VYSU_ANDROID_LOCALE`
(`adb root` + `persist.sys.locale` + zygote restart, about 20 s, only when it differs); `adb reverse
tcp:8081`; Metro started with `VYSU_MOBILE_ENV` (the dev-clients were built for that env, and the
app config it generates carries the auth callback scheme - a mismatch means the login callback is
rejected); and the dev-client installed on a fresh AVD from the last `--build` output. The emulator
being about twice as slow, let `--settle` do its work rather than chaining snapshots.

## Large text, theme, language

**Large text**: `vysu textsize ios|android normal|large|xl` (Dynamic Type AX XXXL / font scale
2.0). Every screen is also checked in `xl` (`mrelaunch --textsize xl` applies it and relaunches).
That mode is where truncated titles, overflowing cards and overlapping tab labels show up. Put it
back to `normal` afterwards. `vysu appearance ios|android light|dark` does the same for the system
theme.

**Language**: `mrelaunch --lang <l>` (the languages the project offers are `VYSU_LANGS`). iOS takes
it **per launch** (`AppleLanguages` / `AppleLocale` passed to `simctl launch`); Android needs the
system setting (`persist.sys.locale` plus a zygote restart, about 20 s), so only when it changes.
`vysu` remembers the language, the large text and the theme applied **per device**
(`state-<platform>-<device>.env` under the state folder, forgotten by `vysu cache clear`):
`meta.json` records them, and `tap t:<key>` reads the language back. Two emulators running in
parallel therefore share nothing - a `mrelaunch --lang en` on one leaves the other alone.

## `mrelaunch`: always before judging

**Always `mrelaunch` before judging a behaviour** (a journey, a regression, a tour): after modules
have moved or a provider changed, fast refresh leaves ghosts - two providers, cold caches, steps
computed on an incomplete persona - that a capture cannot tell from a bug. `mrelaunch` kills the
dev-client, applies textsize / appearance / lang, relaunches, waits for Metro's "Bundled" line and
then for a first screen (`VYSU_MOBILE_READY_TEXT`, about 15 s).

## Journeys (`mflow`) and motion (`mrec`)

```bash
vysu mflow ios .vysu/flows/mobile-tour.txt --shots tour-ios   # a file or -; one capture per `shot`, then the sheet
vysu mrec ios seam --crop 0,0,402,200 -- "press 173 822" "sleep 1.5" "press 258 822"
```

**Flows**: one step per line - `tap "<label>"`, `tap t:<i18n.key>`, `press …`, `longpress …`,
`sleep <s>`, `shot <label> [--full]`, `relaunch [--textsize …]`, `#` for a comment, or any
agent-device command. `tap t:` resolves the label in `VYSU_LOCALES/<lang>.json` **for the language
`vysu` applied last**: the journey survives a wording change and plays identically in every
language (an interpolated value keeps its longest literal, which the "contains" fallback finds).
`vysu` stays agnostic: the journey is data, the same runner works for any app - never code an app's
behaviour into the engine. A failing step (a label absent from the screen) stops `mflow` with its
number, but **not `mrec`**: that one reports it, plays the rest and keeps its clip.

**`mrec`** answers "it flickers / there is a very short line": agent-device captures at about 10 Hz
and misses anything under 100 ms. `vysu` films the screen, **streams the video** and only writes
into `frames/` (at 1x) the frames the report names. `motion.txt` gives the frames that move
(timeline in pt) and the **transients**: rows of pixels that leave their value for 4 to 12 frames
and come back, their neighbours still - a hairline at a seam, a control that appears for a handful
of frames. Read the incriminated frames (`frames/fNNNNN.png`) only afterwards. The steps are those
of `mflow`; `--crop x,y,w,h` in **points** narrows the area.

`mrec` also leaves enough to **edit a video**: the clip is normalised once (H.264 `yuv420p`, a
constant 30 frames/s - simctl and screenrecord only emit a frame when the screen changes, so a raw
clip has no frame rate -, one keyframe per second, `+faststart`), and `events.json` says which step
ran between which clip seconds, with the **point it touched** in points. From there:
`vysu cut <take> --draft` then `vysu video <take>` - the montage contract and grammar are in
`demo.md` and in the skill **demo-video**. An `mflow` writes none of that: it does not film.

## Gotchas

- In zsh, `for t in "173 822"; do … $t` does **not** split the argument (`${=t}`, or a bash script).
- A `Pressable` with no accessibility role reports a full-screen frame to XCTest, so `press label=`
  taps the middle of the screen. Give it the role.
- On Android, agent-device's `scroll` sometimes does nothing - fall back to
  `vysu adb shell input swipe …` (your emulator, under its lock), never a raw `adb`. The dev-launcher
  bubble can cover a tab bar item.
- A recreated simulator (new UDID, different density) means `vysu cache clear`.
- "Development Build" on screen means the dev-client is waiting for the Metro URL, which a bare
  `vysu <platform> open` never gives it: `vysu mrelaunch <platform>` (what `up`, `mdo`, `mopen` and
  `mlogin` start the app with) lands on the bundle directly; "Cannot find native module" means a stale APK / app -> `vysu up <platform> --build`;
  an `UnableToResolveError` on a file that exists means Metro is older than the file ->
  `vysu down metro` then `vysu up <platform>`.
