# Demo: web flows, clips, exports, comparisons

Four commands, one idea: replay a real journey and get something showable out of it - a contact
sheet for the agent, a clip for the review, a slide for a demo.

## `vysu flow` - a scripted web journey

A flow file is one step per line, `#` for a comment (the same rules as mobile flows). Flows are
data, not behaviour: the same runner walks any app. A project keeps its own under `.vysu/flows/`,
with any extension.

```bash
vysu flow alice .vysu/flows/tour.txt --shots tour-web [--viewport 1440x900]
vysu flow alice - --shots tour-web <<< 'go http://localhost:3000/dashboard'   # or stdin
```

The flow stops at the **first failing step**, naming its number. Shots taken along the way are
`web-<label>.png` in the shots folder, and the contact sheet is built at the end.

| Verb | What it does |
|---|---|
| `go <url>` | opens, waits for the network to settle, hides devtools badges |
| `click "<label>"` / `tap "<label>"` | button by name, else link by name, else visible text, then a short settle |
| `click t:<i18n.key>` | the label of that key in the app's language, resolved through `VYSU_LOCALES` |
| `fill "<label>" "<value>"` | field by `<label>`, else by placeholder |
| `press <key>` | `Enter`, `Escape`, `Control+a`… |
| `sleep <s>` · `viewport WxH` | wait · change viewport |
| `shot <label> [--full] [--no-expand]` | capture -> `web-<label>.png`; `--full` unfolds inner scrollers |
| `check` | `vysu check` inline, appended to `check.txt` (so `vysu report` reads it); needs `--shots` |
| *anything else* | passed straight to agent-browser (`eval …`, `network route …`, `scroll …`) |

## `vysu rec` - filming the journey

```bash
vysu rec alice feed-clip --fps 30 -- "go http://localhost:3000/feed" "sleep 1" "click \"Incidents\"" "sleep 1"
vysu rec alice feed-clip --flow .vysu/flows/tour.txt --cursor --viewport 1440x900
```

Recording starts **on the page already open** - no cold hydration in the first frames - so a clip
that wants a fresh page opens it itself, as its first step. Outputs, in the shots folder:

- `web.mp4` - the clip, normalised (H.264 `yuv420p`, a constant 30 frames/s, one keyframe per
  second, `+faststart`). `--mp4` is a no-op: the clip is always an mp4.
- `events.json` - the take, machine-readable (below).
- `web.contact-sheet.png` - the distinct states the page went through, produced by agent-browser.
- `motion.txt` + `frames/` - the motion report (`motion.py`): a timeline of the frames that move,
  transients (a row that flashes for 4-12 frames), and only the frames the report names.
- `meta.json` - persona, viewport, fps, sha, branch, API, date.

**Read the text first**: `motion.txt` says where to look, `frames/f000NN.png` shows it. The clip
itself is not read, it is shown to a human (or handed to `vysu frame`).

## From the take to the video

`vysu rec` and `vysu mrec` do not only leave a clip: they also write **what happened, when**. From
there, two commands lead to an explainer video without ever typing a second or a coordinate.

### `events.json` - the take, machine-readable

Written in the take's folder, beside the clip, `meta.json` and `motion.txt`. A `vysu flow` or
`vysu mflow`, which film nothing, write none. Contract **version 1**:

| Field | What it is |
|---|---|
| `kind` · `platform` | `mobile`\|`web` · `ios`\|`android`\|`web` |
| `clip` · `fps` · `duration` | the clip file in the folder, its rate (30) and its duration in seconds |
| `size` | the **logical** size of the filmed surface: iOS points / Android dp (`unit: "pt"`), CSS pixels = the viewport on the web (`unit: "px"`). The pixel scale is clip width / `size.w` |
| `t0` | the clock of the clip's first frame |
| `steps[]` | `i`, `line` (the step as written), `verb`, `label`, `start`/`end` **in clip seconds**, `ok`, `file` (for a `shot`), `target` |

`verb` is normalised: `tap` (tap/click/press on a target, mobile as well as web), `fill`, `key` (a
web `press <key>`), `go` (`label` is the url), `sleep`, `shot`, `check`, `viewport`, `relaunch`,
`other`. `label` is the label as written, or the one a `t:` key resolved to.

`target` is **where the gesture landed**, in the units of `size`: `{x, y}` on mobile (the point
agent-device returned), `{x, y, w, h}` on the web (the element's box, measured just before the
click). Absent when the measurement found nothing: that costs a ripple in the montage, never a step.

`t0` is **anchored on the end**: a recorder starts asynchronously, only the moment its last frame
is asked for is known, so `t0 = t_stop - clip duration`. A step played before the first frame keeps
a negative `start`, which says so.

### `cut.json` - the montage, written in words

```bash
vysu cut feed-clip --draft [--force]   # a proposal, printed and written to <take>/cut.json
```

A **reference** is a number (clip seconds), `"step:N"` (the start of step N), `"step:N.end"`, or
`"shot:<label>"` (the anchor a `shot` step dropped).

- `keep[]` - what stays, in order: `{from, to}` for a segment, `{hold, seconds}` for a freeze at a
  reference (a screen that goes by too fast);
- `chapters[]` - `{at, kicker, title, body}`: the on-screen text, anchored to a reference;
- `intro` (the opening, where the logo is drawn) and `outro` (`{title, subtitle?, cta?, caption?}`,
  the end card), `music` (a file under `public/music/` of the toolkit - none ships with the
  engine), `formats` (`landscape` 1920x1080 with the text on the left, `portrait` 1080x1920 with
  the text on top), `theme`, `lang`. `taps[]` is only for takes **without** an `events.json`;
  otherwise the ripples come from the steps. A title may carry one `*emphasised*` phrase. The
  schema is strict: an unknown key fails the render.

The film runs three scenes: **opening** -> wipe -> **demo** (the montage: a header with the lockup,
a progress line over the montage alone, one chapter at a time, the device) -> wipe -> **end card**.
The wipes cover the boundaries, so the duration stays `opening + montage + end`.

The draft proposes one segment per run of action steps with the dead time cut (over 1.2 s without a
moving frame, according to `motion.txt`), a 2 s hold on every `shot`, and an empty chapter per
anchor. **The agent's work starts there**: filling in the text, nothing else.

### `vysu video` - the render

```bash
vysu video feed-clip --check                      # the stills contact sheet, read it before rendering
vysu video feed-clip --format all [--draft] [--out <dir>]
```

A pass-through to the Remotion toolkit, which installs itself on the first render that needs it
(`vysu doctor` prints `remotion: node_modules ok`). Outputs go into `<take>/video/`, one path per
line on stdout. Details and the writing rules: skill **demo-video**.

## `vysu frame` - the showable export

`frame.py` draws a device bezel or lays the capture on a 16:9 canvas. It takes a PNG, an
`.mp4`/`.webm` (a web clip from `rec` **or** a mobile clip from `mrec`), or a whole shots folder.

```bash
# 1. framed phone, from an mrec clip
vysu frame ~/.vysu/<project>/shots/mobile-home/ios.mp4 --preset framed --device phone
# 2. a titled 16:9 slide, for a demo
vysu frame feed-clip --preset pitch --title "Residence feed" --caption "example.com"
# 3. a whole shots folder at once -> <folder>/demo/
vysu frame tour-web --preset framed
```

`--device auto|phone|phone-home|tablet|browser|none` (auto is deduced from the shape of the
capture), `--preset framed|pitch`, `--bg '#hex'|brand`, `--size 1920x1080`, `--fps 30`. One output
path per line on stdout. The first argument is either a shots **folder name** or a **file path**.

## `vysu sheet --compare` - before / after

```bash
vysu walk alice feat --url http://localhost:3000/... --baseline-url @
vysu sheet feat --compare                 # the folder's own baseline (the -base.png files)
vysu sheet feat --compare --against ref   # or another shots folder
```

Two outputs, two readers:

- **`compare.png`** (`compare-2.png`… when it overflows) - a **before / after / zones** triptych
  per capture, within the 1 568 px limit: this is the *only* image to read. Column 1 the baseline,
  column 2 the current state, column 3 the marked image (`diff.py`'s rectangles over the dimmed
  background) - compare columns 1 and 2, column 3 says where to look.
- **`compare.html`** - for a human: a before/after slider, onion-skin overlay, toggleable zones.
  To open in a browser, never to read in tokens.

`vysu sheet` renders `index.html` and `compare.html` in a separate agent-browser session named
`render`. It is a session like any other: `vysu render open file://<dir>/compare.html`, then
`vysu render screenshot …` / `vysu render click …` to go and look yourself, without touching a
persona's session.

`vysu report <name>` follows suit: as long as there is no `compare*.png`, it suggests
`compare: vysu sheet <name> --compare`; once they exist they replace the `-changed.png` files in
the `read:` lines (they already contain the marked image).
