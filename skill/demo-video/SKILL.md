---
name: demo-video
description: A demo, explainer or feature-presentation video built from a `vysu` recording (`rec` on the web, `mrec` on iOS / Android) - the montage is written as `cut.json` and rendered by `vysu video` in 16:9 1920x1080 (YouTube, a site, a merge request) and 9:16 1080x1920 (Shorts, TikTok, Reels), with no narration. Use on "make a video of the feature", "demo video", "explainer video", "a short", "a montage", "film the journey".
---

# Demo video (`vysu rec` -> `cut.json` -> `vysu video`)

The agent writes **the montage script**, never frames and never coordinates: the take gives the
timings, `cut.json` gives the meaning. Renders and outputs live outside every repo, in the take's
folder under the state folder (`vysu doctor` prints it).

## The chain, six steps

1. **Film** the journey with `vysu` (skill **visual-check** for the step grammar, the flows, the
   personas and the devices):
   `vysu rec <persona> <take> --flow <file>` (web) · `vysu mrec ios|android <take> -- "<step>"…`
   (mobile). The take writes the clip (`web.mp4`, `ios.mp4` or `android.mp4`, normalised H.264),
   `events.json` (the timed steps), `meta.json` and `motion.txt`.
   A `shot <label>` step in the flow drops a **named anchor**: hang the chapters on those.
2. **Draft the montage**: `vysu cut <take> --draft` -> `cut.json` (one segment per run of action
   steps, dead time cut, an empty chapter per `shot`). Always start there when `events.json` exists.
3. **Write the script** in `cut.json`: `intro`, `chapters` (kicker / title / body, one idea per
   chapter, body of 12 words or fewer), `keep` as references (`step:N`, `step:N.end`,
   `shot:<label>`, or source seconds), `hold` to freeze a screen that goes by too fast, `outro`
   (`title`, `subtitle`, `cta`, `caption`), `music` (a file under `public/music/` of the toolkit).
   A title may carry **one** `*emphasised*` phrase. The copy is written in the app's own UI
   language; take names and keys stay in English.
4. **Control sheet**: `vysu video <take> --check` -> a few key stills per format on one sheet, with
   no mp4 (about 5 s); **read it**. That is where botched cuts, overflowing text and a missing
   screen show up.
5. **Fix** `cut.json` and redo `--check` until the sheet is right.
6. **Render**: `vysu video <take>` (both formats by default, `--format landscape|portrait|all`,
   `--draft` for a fast render, `--out <dir>` elsewhere) -> `<take>/video/`. Deliver **the paths**:
   those files live outside the repo.

Under `vysu video` / `vysu cut`: `node <engine>/remotion/scripts/render.ts --take <dir> [--format
landscape|portrait|all] [--check] [--draft] [--out <dir>]`. Call it by hand only when debugging the
toolkit. The toolkit installs its dependencies on the first render that needs it, once, and says so.

## The two contracts

- **`events.json`** (written by the take): `t0`, `fps`, `duration`, `size`, then `steps[]` - `i`,
  `line`, `verb` (`tap` for any tap or click, `fill`, `key`, `go`, `sleep`, `shot`, `check`,
  `viewport`, `relaunch`, `other`), `label`, `start`/`end` in clip seconds, `ok`, and `target` (the
  tapped point `x`,`y` in points on mobile; the box `x`,`y`,`w`,`h` in CSS pixels on the web) when
  it is known. Any recorder can produce one: `vysu` is only a producer.
- **`cut.json`** (written by the agent): the montage. Tap ripples are not declared - every
  `tap`/`click` kept by `keep` produces one, at its target box.

```json
{ "version": 1, "take": "demo-report-ios", "formats": ["landscape", "portrait"], "theme": "default", "lang": "en",
  "intro": { "title": "Report an issue *in a minute*", "subtitle": "without calling anyone" },
  "keep": [ { "from": "step:1", "to": "step:3.end" }, { "hold": "shot:step-1", "seconds": 2.2 } ],
  "chapters": [
    { "at": "step:1", "kicker": "Add", "title": "Pick “Issue”",
      "body": "The report goes straight to the managers." } ],
  "outro": { "title": "Your turn to explore.", "subtitle": "It takes a minute.",
             "cta": "Learn more", "caption": "example.com" },
  "music": "digital-clouds.mp3" }
```

The schema is **strict**: an unknown key fails the render rather than being silently dropped.
`take`, `formats`, `theme`, `lang`, `clip`, `intro`, `outro`, `music`, `keep`, `chapters` and
`taps` are the only keys, and `version` must be `1`.

## The shape of the film

```
Opening 3.2 s        wipe 0.5 s   Demo (the montage)       wipe 0.5 s   End card 3.4 s
the brand mark is    the cream    header (lockup) +        a cream      lockup, title,
drawn, title,        surface      progress line +          disc leaves  subtitle, pill, caption
subtitle             closes in    one chapter at a time    the device
                                  + the device
```

The device belongs to the demo alone: it rises as the first wipe opens, and leaves under the
closing one. The wipes **overlap** the boundaries instead of adding to them: the duration stays
`opening + montage + end`, and the montage's own timing never moves. A cut with no `intro` or no
`outro` simply drops that scene.

## Formats

| | 16:9 - 1920x1080 | 9:16 - 1080x1920 |
|---|---|---|
| For | YouTube, a site, a merge request | Shorts, TikTok, Reels |
| Length | 60 to 90 s | 15 to 30 s |
| Safe areas | 120 px margins | nothing above 140 or below 1440, 60 px left, 180 px right |
| Layout | text on the left (x 120 -> 1020), device on the right | text on top (x 60 -> 900, block 262 -> 562), device below (590 -> 1410) |

## Design rules

- **Rhythm**: opening 3.2 s, one chapter = one idea (4 to 8 s), end card 3.4 s. The product arrives
  at the end of the opening and leaves with the closing wipe.
- **Hierarchy**: chapter index plus kicker (small caps, `muted`), title (`display` 800, **one
  line** - the text is shrunk from 88 to 64 px to keep it there, a second line only if it still
  does not fit), body of 12 words or fewer (`muted`). In 9:16: title 60 px, body 28 px. A short
  title fits on one line: that is a writing rule, not just a layout one.
- **Landmarks**: a progress line under the header (one dot per chapter), filled over **the montage
  alone** (0 at its first frame, 1 at its last). **No clock**, no milestone bar, no full-screen
  text card.
- **Motion**: two curves. The chrome uses `Easing.bezier(0.16, 1, 0.3, 1)` - first entrance 0.55 s
  (opacity plus 14 px), a chapter change 0.12 s out / 0.2 s plus 8 px in, 70 ms between siblings.
  Anything at the scale of a **scene** uses `Easing.bezier(0.65, 0, 0.25, 1)`: both wipes, the
  opening title lines, the end card. A ripple is a `secondary` outline growing 18 -> 60 pt in
  0.4 s, with no cursor.
- **Brand**: colours, radii, shadows and fonts come from the theme, never from a palette invented
  for the video. The theme is `.vysu/themes/<name>/theme.json` in the project (resolved first), and
  otherwise the engine's own `themes/<name>/`; `VYSU_THEME` names it and `default` is the neutral
  one that ships - a grey-blue palette, Inter, and no logo, in which case the lockup blocks simply
  render nothing. A project theme that declares a logo has it **drawn** into the opening and set in
  the header. The device is a drawn bezel with a soft shadow, playing the clip at its native rate,
  output at 30 fps.
- **Music**: left out, the film plays the track the engine ships (`digital-clouds.mp3`, licence
  in `public/music/LICENSE.md`); `"music": null` plays it silent; another track goes under
  `public/music/` with its licence line first. 55 % volume, 0.7 s fade in, 2 s fade out, looped and
  cut to the film's length. No narration and no subtitles: the chapters carry the explanation.

## Do not

- Write a hard-coded timeline, or one Remotion composition per demo: there is a single
  composition, driven by `cut.json`.
- Put coordinates or frame numbers in `cut.json`: use references (`step:`, `shot:`) or source
  seconds.
- Render the mp4 before reading the `vysu video --check` sheet.
- Skip `vysu cut --draft` when the take has an `events.json`.
- Commit a take, a clip or a render - **no `.mp4` in a repo**; everything lives in the shots folder.
- Re-narrate what the screen already shows: a chapter says the why, not the gesture.
