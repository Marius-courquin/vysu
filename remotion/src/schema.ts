import { z } from 'zod';

// The RESOLVED props the Explainer composition receives. Everything is already in clip seconds
// and pixels: `cut.json` refs, events and file metadata are turned into these by `cut.ts`, so the
// composition never has to know about takes, events or the file system.

export const themeSchema = z.object({
  name: z.string(),
  colors: z.object({
    background: z.string(),
    card: z.string(),
    foreground: z.string(),
    muted: z.string(),
    mutedFill: z.string(),
    tertiary: z.string(),
    subtle: z.string(),
    border: z.string(),
    divider: z.string(),
    primary: z.string(),
    primaryTint: z.string(),
    primaryText: z.string(),
    secondary: z.string(),
    secondaryTint: z.string(),
    secondaryText: z.string(),
    success: z.string(),
    successTint: z.string(),
    decorPeach: z.string(),
    decorBlue: z.string(),
  }),
  fonts: z.object({
    display: z.string(),
    body: z.string(),
    faces: z.array(
      z.object({ family: z.string(), weight: z.number(), file: z.string() }),
    ),
  }),
  // Optional: a theme that declares no logo simply renders no lockup (header, Opening, Finish).
  logo: z.object({ lockup: z.string(), mark: z.string() }).optional(),
  // The outro pill's label when a cut names none: the same words across a project's films, and in
  // the project's own language. Absent from theme and cut alike, the pill carries no label.
  cta: z.string().optional(),
  radius: z.object({ device: z.number(), browser: z.number() }),
  shadow: z.object({ device: z.string(), float: z.string() }),
});

export const formatSchema = z.enum(['landscape', 'portrait']);

export const clipSchema = z.object({
  // Path under public/, e.g. "takes/demo-incident-ios/ios.mp4". Null renders a placeholder panel
  // so the composition opens in Studio without a take.
  src: z.string().nullable(),
  width: z.number(),
  height: z.number(),
  fps: z.number(),
  // Logical size of the recorded surface (pt on mobile, CSS px on web): the unit `taps` use.
  logical: z.object({ w: z.number(), h: z.number() }),
});

export const segmentSchema = z.union([
  z.object({ from: z.number(), to: z.number() }),
  z.object({ freeze: z.number(), hold: z.number() }),
]);

export const chapterSchema = z.object({
  at: z.number(),
  kicker: z.string(),
  title: z.string(),
  body: z.string(),
});

export const tapSchema = z.object({ at: z.number(), x: z.number(), y: z.number() });

export const explainerSchema = z.object({
  format: formatSchema,
  lang: z.string(),
  theme: themeSchema,
  clip: clipSchema,
  segments: z.array(segmentSchema),
  chapters: z.array(chapterSchema),
  taps: z.array(tapSchema),
  intro: z.object({ title: z.string(), subtitle: z.string() }).nullable(),
  outro: z
    .object({
      title: z.string(),
      subtitle: z.string().nullable(),
      cta: z.string(),
      caption: z.string(),
    })
    .nullable(),
  // Path under public/, e.g. "music/<file>.mp3". Null plays the film silent, and is the default:
  // no soundtrack ships with the engine.
  music: z.string().nullable(),
  openingSeconds: z.number(),
  finishSeconds: z.number(),
  name: z.string(),
});

export type Theme = z.infer<typeof themeSchema>;
export type Format = z.infer<typeof formatSchema>;
export type Clip = z.infer<typeof clipSchema>;
export type Segment = z.infer<typeof segmentSchema>;
export type Chapter = z.infer<typeof chapterSchema>;
export type Tap = z.infer<typeof tapSchema>;
export type ExplainerProps = z.infer<typeof explainerSchema>;

export const FORMAT_SIZES: Record<Format, { width: number; height: number }> = {
  landscape: { width: 1920, height: 1080 },
  portrait: { width: 1080, height: 1920 },
};

export const FORMAT_SUFFIX: Record<Format, string> = {
  landscape: '16x9',
  portrait: '9x16',
};

export const FPS = 30;

// The three scenes. The two cream circle wipes are 0.5 s each and are taken FROM the scene that
// ends (the Opening's last half second, the montage's last half second), so adding them changed no
// duration: total = opening + montage + finish.
export const OPENING_SECONDS = 3.2;
export const FINISH_SECONDS = 3.4;
export const WIPE_SECONDS = 0.5;
/** How long the mark takes to weave itself, from the app's own loader (LOADER_DURATION_MS). */
export const LOADER_SECONDS = 1.6;
