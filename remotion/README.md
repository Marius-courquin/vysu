# vysu explainer videos (Remotion)

Turns a raw screen recording into a branded explainer video: a light ground, a dot grid, huge ink
display titles with one accented phrase, circle wipes between scenes. `primary` is time (the
progress line), `secondary` is attention (the tap ripples, the accent word). 16:9 (1920x1080,
YouTube) and 9:16 (1080x1920, Shorts / TikTok / Reels). The montage is **data**: a `cut.json` next
to the clip, never a hand-written timeline.

Three scenes and two wipes:

```
Opening (3.2 s)        wipe 0.5 s    Demo (the montage, N s)     wipe 0.5 s   Finish (3.4 s)
the brand loader       the ground    header (lockup) + progress  a disc of    lockup · title
weaves the mark,       surface       line + one chapter at a     the ground   · subtitle · ink
the wordmark joins     shrinks       time + the phone            grows out    pill · caption
it · title · subtitle  away from                                 of the phone
                       the centre
```

The phone belongs to the Demo alone: it rises 60 px and fades in as the Opening's disc leaves, and
it goes under the Finish's. Each wipe **overlaps** a boundary instead of adding to it — the
Opening's surface leaves over the montage's first half second, the Finish's disc grows over its
last — so the film lasts exactly `opening + montage + finish` and the montage's own timing never
changes.

```
vysu rec | vysu mrec  ──►   the take            ──►   the cut          ──►   vysu video
                            <take>/clip.mp4           <take>/cut.json        scripts/render.ts
                            <take>/events.json        (written by the        16:9 · 9:16 · poster
                            (optional)                 agent)                · contact sheet
```

Nothing here is project-specific except the theme (`themes/<name>/`, or the project's own under
`$VYSU_PROJECT_DIR/.vysu/themes/<name>/`), `src/brand/` (the mark geometry vendored from the
product's UI package, drawn only when a theme declares a `logo`) and the copy inside a `cut.json`.

## The take

A take is a folder under the vysu shots directory (`<shots>/<take>/`) holding the clip, optionally
`events.json` (written by the recorder), and `cut.json` (the montage script).

### `events.json` (version 1, optional)

What the recorder logged, every instant in **clip seconds** from the first frame:

```json
{ "version": 1, "kind": "mobile", "platform": "ios", "clip": "ios.mp4", "fps": 30, "duration": 48.7,
  "size": { "w": 402, "h": 874, "unit": "pt" },
  "t0": "2026-09-21T19:02:11.412+02:00",
  "steps": [
    { "i": 1, "verb": "tap", "label": "Incident", "start": 10.41, "end": 10.93, "ok": true,
      "target": { "x": 193, "y": 470 } },
    { "i": 2, "verb": "sleep", "start": 10.93, "end": 12.43, "ok": true },
    { "i": 3, "verb": "shot", "label": "step-1", "start": 12.43, "end": 12.90, "ok": true,
      "file": "ios-step-1.png" }
  ] }
```

- verbs: `tap` (tap or click, both platforms), `fill`, `key`, `go`, `sleep`, `shot`, `check`,
  `viewport`, `relaunch`, `other`.
- `size` is the **logical** size of the recorded surface — points on mobile, CSS pixels on web.
  `target` is in those same units: a point on mobile, the element box on web (its centre carries
  the ripple). The pixel scale is `clip pixel width / size.w`.
- `start` may be negative (a step that began before the first frame): it is clamped to 0.
- Every `tap` step with a target that survives the cut becomes a ripple. Ripples are never
  declared by hand when the take has an `events.json`.

### `cut.json` (version 1, required)

```json
{ "version": 1, "take": "demo-incident-ios", "formats": ["landscape", "portrait"],
  "theme": "default", "lang": "fr",
  "clip": { "file": "ios.mp4", "size": { "w": 402, "h": 874 } },
  "intro": { "title": "Signaler un incident *en une minute*", "subtitle": "sans appeler personne" },
  "outro": { "title": "À vous de *l’essayer*.", "subtitle": "La suite se passe dans l’application.",
             "cta": "En savoir plus", "caption": "example.com" },
  "music": "a-track.mp3",
  "keep": [ { "from": "step:1", "to": "step:3.end" },
            { "hold": "shot:step-1", "seconds": 2.2 },
            { "from": 12.9, "to": 15.0 } ],
  "chapters": [ { "at": "shot:step-1", "kicker": "Étape 1 sur 3", "title": "La catégorie",
                  "body": "Ascenseur, éclairage, eau, propreté… Ici : Éclairage." } ],
  "taps": [ { "at": 4.55, "x": 360, "y": 822 } ] }
```

**Ref grammar** — anywhere a `from`, `to`, `hold` or `at` is expected:

| Ref | Means |
|---|---|
| `12.9` | clip seconds |
| `"step:4"` | start of step 4 of `events.json` |
| `"step:4.end"` | end of step 4 |
| `"shot:<label>"` | start of the `shot` step carrying that label |

- `keep` is played in order; `{ "hold": <ref>, "seconds": n }` freezes that instant for `n`
  seconds (a screen that flashes by). An empty or missing `keep` keeps the whole clip.
- A chapter whose instant fell in a cut snaps to the **next kept instant**, so it still gets its
  moment on screen. The whole file is validated strictly: an unknown key (`milestones`, a typo)
  fails the render rather than being silently dropped.
- `intro.title`, `outro.title` and a chapter `title` may carry ONE accented phrase,
  `*between asterisks*`. In a chapter it is `secondary` under a hand-drawn underline, drawn in as
  the title lands; in the Opening it is a plain `secondary` word (no underline); in the Finish it is
  `primary` (the film ends on the brand, not on an instruction).
- `outro` is `{ title, subtitle?, cta?, caption? }`: `cta` is the ink pill's label (followed by a
  ↗), defaulting to the theme's own `cta` and then to nothing, and `caption` the line under it
  (empty by default — the product's address is the cut's to give).
- `music` names a file under `public/music/`. Left out, the film plays the track the engine ships
  (`digital-clouds.mp3`, licence in `public/music/LICENSE.md`); `null` plays it silent; another
  file needs its licence line there first. It plays at 55 %, fades in over 0.7 s, fades out over
  the last 2 s, loops if shorter than the film and is trimmed to it. No narration, no captions.
- `taps` is the explicit fallback for a take with no `events.json`: clip seconds plus logical
  units. It is merged with whatever `events.json` yields.
- `clip.size` supplies the logical size when there is no `events.json`. Pixel size and duration
  always come from the file itself (mediabunny).
- `theme` names a theme folder (see **Themes**), default `default`; `formats` is the default of
  `--format all`.

## Layouts

`Explainer` is one composition; `calculateMetadata` picks the size from `format`, and the layout
places the device from the clip's aspect ratio (portrait taller than 1.9:1 → phone bezel,
otherwise a browser window; both drawn in CSS, no image asset).

The Demo carries four things, and only the chapter block ever changes:

1. **Header** — the lockup on the column's left rule. No clock: the progress line already says
   where the film is. A theme with no `logo` draws no header at all.
2. **Progress line** — a 6 px track under the header (never at the frame's bottom edge, where the
   players draw their own), filled linearly over the **montage** (0 on its first frame, 1 on its
   last), with a 14 px dot at each chapter's start: hollow until reached, `primary` filled after, a
   `primaryTint` halo on the current one.
3. **Chapter block** — chapter index + kicker, the title, the body. The title is ONE line:
   `fitText` shrinks it from 88 px down to 64 px to keep it there, and only a title that still does
   not fit at 64 px wraps to a second.
4. **Device** — drawn bezel, no image asset, static once it has risen.

**The lockup is drawn, not loaded**: `src/brand/` vendors the product's own mark geometry, loader
timeline and palette derivation, and `src/parts/Lockup.tsx` assembles mark + wordmark at any size,
in the theme's own `primary` and `secondary` — the video has no colour of its own. The Opening
weaves that mark over 1.6 s (per-frame SVG attributes — a CSS animation would be stuck on its first
keyframe in every still), the wordmark joins when the accent dot fires, and the same lockup settles
into the header over the wipe. When the theme declares no `logo`, the loader block, the header
lockup and the Finish lockup are all skipped and the scenes keep their timing.

- **Landscape** (1920x1080): column x 120 → 1020 (kicker 22 / title 88→64 / body 34), phone screen
  960 px tall at x 1240, vertically centred. A web clip takes an 800 px browser window on the right.
  Opening: mark 120 px at the header's anchor, title 120 px on up to 2 lines (width 1600, top 360),
  subtitle 34 px at the bottom. Finish: lockup 245 px wide, title 118 px, all centred.
- **Portrait** (1080x1920): safe areas of the short-video players — nothing above 140 or below
  1440, x 60 → 900. Reading order is context then action: header 150, progress 216, text block
  262 → 562 at a FIXED height so the phone never moves, phone screen 820 px tall at 590 → 1410,
  centred. A web clip takes the 840 px content width at the same top. Opening: mark 96 px, title
  84 px at 520 with the subtitle under it. Finish: lockup 220 px wide, title 84 px, centred in the
  frame — everything stays above the players' own bottom chrome.

Motion: two curves. The chrome uses an ease-out, `Easing.bezier(0.16, 1, 0.3, 1)` — first entrance
0.55 s (opacity + 14 px rise, siblings staggered 70 ms); a chapter change fades the outgoing in
place over 0.12 s while the incoming rises 8 px over 0.2 s. Anything at the scale of a SCENE uses
`Easing.bezier(0.65, 0, 0.25, 1)`: the two wipes (0.5 s), the Opening title's lines (70 px rise over
0.7 s, 0.4 s apart), the Finish card (40 px rise over 0.6 s). Header and device never move once in.
Tap ripple: a `secondary` outline opening 18 → 60 pt over 0.4 s, no cursor, no fill.

## Themes

`theme.json` is the only project-specific code path: colours, font stacks, the `.woff2` faces
(loaded with `@remotion/fonts`), an optional `logo`, an optional `cta` (the outro pill's default
label, in the project's own words and language), radii and the device shadow. Porting the toolkit
to another product is a folder plus its assets, no code.

A theme name is resolved in two places, project first:

1. `$VYSU_PROJECT_DIR/.vysu/themes/<name>/theme.json` — the project's own brand. Its `fonts.faces`
   and `logo` paths are relative to that folder; the renderer copies those files into
   `public/themes/<name>/` (gitignored) and rewrites the paths, because `staticFile()` only serves
   what sits under `public/`.
2. `<engine>/remotion/themes/<name>/theme.json` — the engine's own themes, whose asset paths
   already point inside `public/` (`fonts/…`) and are used as they are.

`themes/default/` is the neutral fallback: a grey-blue palette, Inter for both the display and the
body face, "Learn more" as its `cta` and no `logo` — so a project that has not declared a brand
still renders a clean film.

## Rendering

```bash
npm install
node scripts/render.ts --take <shots>/<take> [options]
```

| Option | Effect |
|---|---|
| `--format landscape\|portrait\|all` | default `all` = the `formats` of `cut.json` |
| `--check` | a contact sheet per format instead of the mp4: 6 stills (the Opening at 2.4 s, four over the montage, the Finish 1.2 s before the end), long edge 1568 px |
| `--draft` | VideoToolbox (`hardwareAcceleration: 'if-possible'`, 8 Mb/s) instead of CRF 18 |
| `--out <dir>` | default `<take>/video/` |
| `--props-only` | writes the resolved props to `public/takes/<take>/props-<suffix>.json` and stops |

Outputs, one absolute path per line on stdout (progress and errors on stderr, exit ≠ 0 on
failure): `<take>-16x9.mp4`, `<take>-9x16.mp4`, `<take>-<suffix>-poster.jpg` (the first chapter's
frame) and, with `--check`, `<take>-<suffix>-check.png`. **Read the contact sheet before rendering
anything final.** The clip is copied into `public/takes/<take>/` (gitignored) so `staticFile()`
can serve it.

`vysu video <take>` wraps this script; it is the normal entry point.

## Studio

```bash
npm run studio                                                    # opens on a placeholder take
node scripts/render.ts --take <dir> --props-only                  # then
npm run studio -- --props=public/takes/<take>/props-16x9.json     # the real take
```

`npm test` runs the cut, text and brand-loader unit tests, `npm run typecheck` runs `tsc --noEmit`.
Studio is for previewing, not for editing: the montage lives in `cut.json`, so the composition loops
over data and the `remotion-interactivity` rules (hardcoded timelines) deliberately do not apply
here.
