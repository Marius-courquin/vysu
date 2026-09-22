import { z } from 'zod';
import {
  FINISH_SECONDS,
  FPS,
  OPENING_SECONDS,
  type Chapter,
  type Clip,
  type ExplainerProps,
  type Format,
  type Segment,
  type Tap,
  type Theme,
} from './schema.ts';

// --- The two on-disk contracts of a take ------------------------------------------------------

export const eventsSchema = z.object({
  version: z.literal(1),
  kind: z.enum(['mobile', 'web']).optional(),
  platform: z.string().optional(),
  clip: z.string().optional(),
  fps: z.number().optional(),
  duration: z.number().optional(),
  size: z.object({ w: z.number(), h: z.number(), unit: z.string().optional() }).optional(),
  t0: z.string().optional(),
  steps: z.array(
    z.object({
      i: z.number(),
      line: z.string().optional(),
      verb: z.string(),
      label: z.string().optional(),
      start: z.number(),
      end: z.number(),
      ok: z.boolean().optional(),
      file: z.string().optional(),
      target: z
        .object({ x: z.number(), y: z.number(), w: z.number().optional(), h: z.number().optional() })
        .optional(),
    }),
  ),
});

const refSchema = z.union([z.number(), z.string()]);

// Strict on purpose: a key that no longer exists (milestones) or a typo must fail the render
// rather than be silently dropped from the montage.
export const cutSchema = z.strictObject({
  version: z.literal(1),
  take: z.string().optional(),
  formats: z.array(z.enum(['landscape', 'portrait'])).optional(),
  theme: z.string().optional(),
  lang: z.string().optional(),
  clip: z
    .object({
      file: z.string().optional(),
      size: z.object({ w: z.number(), h: z.number() }).optional(),
    })
    .optional(),
  intro: z.object({ title: z.string(), subtitle: z.string() }).nullable().optional(),
  outro: z
    .object({
      title: z.string(),
      subtitle: z.string().optional(),
      cta: z.string().optional(),
      caption: z.string().optional(),
    })
    .nullable()
    .optional(),
  // A file under public/music/ of the toolkit. No soundtrack ships with the engine: drop one in
  // (and its licence) before naming it here.
  music: z.string().optional(),
  keep: z
    .array(
      z.union([
        z.object({ from: refSchema, to: refSchema }),
        z.object({ hold: refSchema, seconds: z.number() }),
      ]),
    )
    .optional(),
  chapters: z
    .array(z.object({ at: refSchema, kicker: z.string(), title: z.string(), body: z.string() }))
    .optional(),
  taps: z.array(z.object({ at: z.number(), x: z.number(), y: z.number() })).optional(),
});

// The outro's call to action and its caption are usually the same across a project's films, so they
// are defaults rather than required copy. The caption defaults to nothing: the address of the
// product is the cut's to give, never the engine's to guess.
const DEFAULT_CTA = 'En savoir plus';
const DEFAULT_CAPTION = '';

export type EventsFile = z.infer<typeof eventsSchema>;
export type CutFile = z.infer<typeof cutSchema>;
export type Ref = number | string;

// --- Ref resolution ---------------------------------------------------------------------------

// A ref is a number (clip seconds), "step:N" (start of step N), "step:N.end", or "shot:<label>"
// (start of the shot step carrying that label). Instants before the first frame are clamped to 0.
export function resolveRef(ref: Ref, events: EventsFile | null): number {
  if (typeof ref === 'number') return Math.max(0, ref);
  const step = ref.match(/^step:(\d+)(\.end)?$/);
  if (step) {
    if (!events) throw new Error(`ref "${ref}" needs an events.json`);
    const found = events.steps.find((s) => s.i === Number(step[1]));
    if (!found) throw new Error(`ref "${ref}": no step ${step[1]} in events.json`);
    return Math.max(0, step[2] ? found.end : found.start);
  }
  const shot = ref.match(/^shot:(.+)$/);
  if (shot) {
    if (!events) throw new Error(`ref "${ref}" needs an events.json`);
    const found = events.steps.find((s) => s.verb === 'shot' && s.label === shot[1]);
    if (!found) throw new Error(`ref "${ref}": no shot labelled "${shot[1]}" in events.json`);
    return Math.max(0, found.start);
  }
  throw new Error(`unknown ref "${ref}" (expected a number, step:N, step:N.end or shot:<label>)`);
}

// --- The montage timeline ---------------------------------------------------------------------

export function segmentSeconds(s: Segment): number {
  return 'freeze' in s ? s.hold : s.to - s.from;
}

export function totalSeconds(segments: Segment[]): number {
  return segments.reduce((sum, s) => sum + segmentSeconds(s), 0);
}

// Output seconds (inside the montage, intro excluded) of a clip instant, or null when the instant
// was cut. A freeze covers exactly its own instant.
export function outTimeOf(segments: Segment[], src: number): number | null {
  let out = 0;
  for (const s of segments) {
    if ('freeze' in s) {
      if (Math.abs(src - s.freeze) < 1e-6) return out;
    } else if (src >= s.from && src < s.to) {
      return out + (src - s.from);
    }
    out += segmentSeconds(s);
  }
  return null;
}

// Like outTimeOf, but an instant that falls in a cut snaps to the start of the next kept segment,
// so a chapter placed in dead time still appears.
export function outTimeOrNext(segments: Segment[], src: number): number {
  let out = 0;
  for (const s of segments) {
    if ('freeze' in s) {
      if (src <= s.freeze) return out;
    } else {
      if (src < s.from) return out;
      if (src < s.to) return out + (src - s.from);
    }
    out += segmentSeconds(s);
  }
  return out;
}

export function durationInFrames(props: {
  segments: Segment[];
  openingSeconds: number;
  finishSeconds: number;
}): number {
  const seconds = props.openingSeconds + totalSeconds(props.segments) + props.finishSeconds;
  return Math.max(1, Math.round(seconds * FPS));
}

// --- Resolution: cut.json + events.json + clip metadata -> composition props -------------------

export function resolveSegments(cut: CutFile, events: EventsFile | null, clipDuration: number): Segment[] {
  const keep = cut.keep ?? [];
  if (keep.length === 0) return [{ from: 0, to: clipDuration }];
  return keep.map((entry) => {
    if ('hold' in entry) {
      return { freeze: resolveRef(entry.hold, events), hold: entry.seconds };
    }
    const from = resolveRef(entry.from, events);
    const to = resolveRef(entry.to, events);
    if (to <= from) throw new Error(`keep segment ends (${to}s) before it starts (${from}s)`);
    return { from, to };
  });
}

// Every tap step of the take that survived the cut becomes a ripple at its target; `cut.taps` is
// the explicit fallback for takes recorded without an events.json.
export function resolveTaps(cut: CutFile, events: EventsFile | null, segments: Segment[]): Tap[] {
  const fromEvents: Tap[] = (events?.steps ?? [])
    .filter((s) => s.verb === 'tap' && s.target)
    .map((s) => {
      const t = s.target!;
      return {
        at: Math.max(0, s.start),
        x: t.w ? t.x + t.w / 2 : t.x,
        y: t.h ? t.y + t.h / 2 : t.y,
      };
    });
  return [...fromEvents, ...(cut.taps ?? [])].filter(
    (tap) => outTimeOf(segments, tap.at) !== null,
  );
}

export function resolveCut(input: {
  cut: CutFile;
  events: EventsFile | null;
  theme: Theme;
  format: Format;
  clip: Clip;
  clipDuration: number;
  name: string;
}): ExplainerProps {
  const { cut, events, theme, format, clip, clipDuration, name } = input;
  const segments = resolveSegments(cut, events, clipDuration);
  const chapters: Chapter[] = (cut.chapters ?? []).map((c) => ({
    at: resolveRef(c.at, events),
    kicker: c.kicker,
    title: c.title,
    body: c.body,
  }));
  const intro = cut.intro ?? null;
  const outro = cut.outro
    ? {
        title: cut.outro.title,
        subtitle: cut.outro.subtitle ?? null,
        cta: cut.outro.cta ?? DEFAULT_CTA,
        caption: cut.outro.caption ?? DEFAULT_CAPTION,
      }
    : null;
  return {
    format,
    lang: cut.lang ?? 'fr',
    theme,
    clip,
    segments,
    chapters,
    taps: resolveTaps(cut, events, segments),
    intro,
    outro,
    music: cut.music ? `music/${cut.music}` : null,
    openingSeconds: intro ? OPENING_SECONDS : 0,
    finishSeconds: outro ? FINISH_SECONDS : 0,
    name,
  };
}
