# Diff, report, contact sheet: how to read a verification

The viewports `shots` and `walk` capture are `VYSU_SIZES` (`vysu doctor` prints the value in force;
the engine default is `360x800,768x1024,1280x800,1440x900`). `--sizes` picks others, `--dark` adds
the dark-theme series, `--full` captures the whole screen.

## The whole screen: `--full`

`--full` grows the capture to the whole document - except that many app shells **never scroll the
document**: the shell is exactly the height of the window and the content scrolls inside an inner
pane, so a bare `--full` would bring back the first screenful and nothing else. Before each
`--full` capture, `vysu` therefore unfolds the panes that scroll (`overflow-y` auto/scroll taller
than their box) and their ancestors up to `<html>` (`height: auto`, `overflow: visible`), captures,
then puts the page back so the next viewport is measured on a normal layout. The unfolding is
deterministic: two captures in a row give `identical`. Left alone: panes inside a `position: fixed`
subtree (a toast, a drawer, a router devtools panel parked below the fold), panes under 200 px, and
panes that are not laid out anywhere.

- `--no-expand`: for a page that already scrolls the document - a marketing site, a Storybook
  story, a classic server-rendered app - where unfolding buys nothing, and to see a sticky section
  where it sticks.
- In an unfolded capture, sticky headers and fixed buttons are painted **once**, at their position
  in the window: a `sticky` header lands at the top, a fixed action button in the middle of the
  page, over the content. That is expected, not a layout defect.
- Each viewport prints `expand: N pane(s) unfolded, document H px`. `0 pane(s)` means the page
  scrolled by itself and `--full` alone would have been enough.
- Before each `--full` capture, `vysu` also **walks the document once** from top to bottom, one
  viewport at a time, letting frames pass between steps: a page that reveals its sections on entry
  (IntersectionObserver, lazy image, a counter that animates) paints them on the way, otherwise the
  capture takes the lower sections half-drawn - and two runs disagree about which. Each viewport
  prints `warm: N scroll step(s)`, or `warm: skipped` when the page fits in the window. `--no-warm`
  skips it.

### A marketing page

A static site that reveals its sections on scroll, scrolls a logo marquee and shows a fixed cookie
banner diffs cleanly with `--freeze` (the baseline modes turn it on by themselves) plus one
`--ignore` per element that lives its own life:

```bash
vysu walk - site --url https://example.com/ --baseline-url https://example.com/ --full --sizes 1440x900 \
  --ignore "#consent-banner" --ignore ".marquee" --ignore 'a[href*="status"]'
```

A fixed banner is painted once at its window position inside an unfolded capture; a marquee never
sits still; a status line whose label arrives asynchronously otherwise turns a thousand pixels into
a zone on one run out of two.

## Comparing: `--baseline` or `--baseline-url`

- `vysu shots|walk <p> <name> --baseline <name-before>`: diff against an **earlier shots folder**,
  typically `<screen>-before` taken on main before starting.
- `vysu shots|walk <p> <name> --url <url> --baseline-url <url>`: the same page is captured on both
  origins in the same session, viewport by viewport, then diffed. `--baseline-url @` is the
  shorthand for "the same path on `VYSU_BASELINE_ORIGIN`" - the deployed main against which a
  branch served locally is read, without a checkout. The persona must have logged in on that origin
  once: `vysu login <p> <baseline-origin>/<login path>`. The reference captures stay in the folder
  as `<size>-base.png`. A page the deployed app does not have yet (signed in, it still lands
  elsewhere on that origin) is captured as it lands, under a line `baseline: <host> has no such
  page (landed on <path>)`: every viewport then reads « changed », which is the new page itself.
- A non-empty diff on a screen the change does not touch is a **defect to explain**. Expected
  noise: relative timestamps ("3 min ago"), about 0.1 % - neutralise it with `--ignore` rather than
  excusing it.

## Stabilising: `--freeze` and `--ignore`

`--freeze` turns off animations, transitions and the caret (`animation/transition: none`,
`caret-color: transparent`, `prefers-reduced-motion`): a blinking caret or a spinner caught
mid-turn is the whole difference between "identical" and "0.2 % changed" on a page nobody touched.
Both baseline modes turn it on **by themselves**.

`--ignore <css>` (repeatable) blanks a zone in both images before comparison. Boxes are resolved
**per viewport** (a header is not the same box at 360 and at 1440), and in document coordinates for
a `--full` capture. Examples: `--ignore time`, `--ignore "[data-avatar]"`, `--ignore .badge`.

## What the diff does

A pixel counts as changed when its largest channel gap exceeds `--threshold` (0.1 by default, the
same 0..1 scale as agent-browser) **and** at least one of its eight neighbours changed too: font
hinting repaints isolated pixels, a real change never does. Changed pixels are then grouped on an
8 px grid, boxes closer than 24 px merged, and each zone tightened onto its pixels - **the largest
first**, 12 at most, zones under 64 changed pixels dropped. Text output: `identical`, or
`changed X % (N px) · n zones` followed by one line per zone (`x y w h px`, and in points when a
scale is given, which is the case for mobile captures) and `marked: <path>`. Exit codes: `0`
identical or under the threshold, `1` zones found, `2` error. `--mark` writes **the only image
worth opening**: the current capture with the zones boxed and numbered, the rest dimmed, cropped
around them.

## `meta.json`

Written into every shots folder: `kind` (web / mobile), `persona`, `url` (or `device` and
`platform`), `lang`, `sizes`, `schemes`, `baseline` / `baseline_url`, `freeze`, `full`, `expand`,
`warm`, `ignore`, `textsize`, `appearance`, `web_sha` / `mobile_sha` + `web_branch`, `api`, `date`.
A capture from a fortnight ago still says which branch and which API it came from.

## `vysu report <name>`, line by line

```
web · alice · http://localhost:3000/feed · lang en · 4 sizes · vs https://main.example.com/… · sha 1a2b3c4 (feat/x) · api staging · 2026-09-21 10:12
1440x900: changed 0.4 % (5 210 px) · 2 zones
  1440x900 1. x 320 y 180 w 420 h 96 px  (38 % of the zone)
check: clean
identical, do not read: 360x800.png, 768x1024.png, 1280x800.png
read: /Users/…/shots/feed/1440x900-changed.png
```

- **Header**: all of `meta.json` on one line.
- **One line per capture**: `identical`, or `changed X % · n zones`, then the boxes indented
  (truncated past 25 lines, the rest staying in `diff.txt`).
- **`check:`**: `clean`, or the count per category and the first three errors. `vysu walk` calls
  `vysu check --save <name>`, which writes `check.txt` into the folder.
- **`identical, do not read:`**: the captures that did not move. Naming them is precisely how they
  stay unopened.
- **`read:`**: one `...-changed.png` per changed viewport - the only image worth its tokens. With
  no diff at all, `report` points at the contact sheet (or reminds you of `vysu sheet <name>`).

`vysu report <name> --md` wraps all of it in a code block: that is what goes into the `## Tests`
section of the merge request.

## `vysu sheet <name>`

Renders `index.html` (for a human) and one or more `sheet-N.png` contact sheets (`sheet.png` when
there is only one), **1 568 px per side at most** so they stay legible after the model's
downscaling, 6 thumbnails per page by default (`--max`), columns chosen automatically (`--cols`).
Order: the marked diffs first, then each baseline next to its current capture. `--open` opens the
page locally.

## Annotating and delivering

`vysu box <persona> <selector|@ref> [--page]` gives the `x,y,w,h` of an element (viewport, 1x;
`--page` gives document coordinates, for a `--full` capture). Refs are only valid after a
`vysu <p> snapshot -i`; otherwise use a plain CSS selector, no `:has-text`. Then:

```bash
vysu mark <in.png> --out <out.png> --box "x,y,w,h:label" [--box …] --grow 10 --dim --crop auto --pad 60 --zoom 1.5
```

boxes (10 px of margin with `--grow`), labels, dims the rest, crops, enlarges. The capture and the
`box` must be taken in the **same state** (same viewport, same scroll). A native crop with no
drawing: `agent-browser screenshot <selector> <path>` on the web, `agent-device screenshot
--crop-on <sel>` / `--overlay-refs` on mobile. In zsh, write `"${B}:label"` - `$B:l` is a zsh
modifier.

**Delivering**: `open <dir>/index.html` locally, or hand over the contact sheet / annotated PNG
when the user is following from elsewhere. Say what was verified **and what was not**.

## The token cost

| image | approx. tokens |
|---|---|
| web capture 1440x900 | ~1 700 |
| mobile capture 1x (402x874) | ~470 |
| Android capture in device pixels (1080x2400) | ~1 500 |
| contact sheet `sheet-N.png` (<= 1568 px) | ~1 800-2 900 |
| `vysu report` (text) | ~150 |

Models downscale an image before tokenising it (Claude: 1 568 px on the long side, then about
`w x h / 750` tokens; OpenAI: 512 px tiles, same order of magnitude): past that, a contact sheet
costs as much and is no longer readable. A tool call costs about 200 tokens plus the reasoning
between two calls - hence `vysu walk` (open + check + shots + diff + report in one call).
