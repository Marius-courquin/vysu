// Vendored from the product's own UI package: the strands, their
// measured lengths, the seed, the chimney and the fill front, all in MARK viewBox units. The nest
// weaves itself from the bottom up, then the chimney (stem + dot) fires the accent dot out of it.
import { type LogoPath, MARK } from './logo-paths.ts';

export const LOADER_MARK_HEIGHT = MARK.viewBox.h;
export const LOADER_VIEWBOX = { x: 0, y: 0, w: MARK.viewBox.w, h: MARK.viewBox.h };
export const LOADER_GRADIENTS = MARK.gradients;

/** Pivot the whole mark breathes around. */
export const HOUSE_ORIGIN = { x: 140, y: 175 };
/** Centre of the accent dot — also the pivot it is fired from. */
export const DOT_ORIGIN = { x: 211.2, y: 49.5 };
/** Bottom of the chimney stem: it grows upward from here. */
export const STEM_BASE = { x: 211, y: 105.918 };

/** Stroke weights in viewBox units: the thin draw, and the thick weight the branch swells to. */
export const STROKE_THIN = 5;
export const STROKE_THICK = 13;

/** Opacity the nest is painted at, so the screen's decorative background reads through it. */
export const NEST_OPACITY = 0.72;

function markPath(what: string, match: (path: LogoPath) => boolean): LogoPath {
  const found = MARK.paths.find(match);
  // Loud on purpose: logo-paths.ts is generated, and a regeneration that reshapes it must not fail
  // silently into a loader that renders half a logo.
  if (!found) throw new Error(`loader-geometry: MARK no longer contains the ${what}`);
  return found;
}

const NEST = markPath('nest body', (p) => (p.gradientId ?? '').includes('paint0'));
const STEM = markPath('chimney stem', (p) => (p.gradientId ?? '').includes('paint2'));
const DOT_SHADOW = markPath('chimney disc', (p) => (p.gradientId ?? '').includes('paint1'));
const DOT_ACCENT = markPath('accent dot', (p) => p.role === 'accent');

export const NEST_D = NEST.d;
export const NEST_GRADIENT_ID = NEST.gradientId ?? '';

/**
 * The chimney, back to front: the disc and the accent dot travel together, while the stem grows on
 * its own and occludes them for as long as the dot is still inside.
 */
export const CHIMNEY = { stem: STEM, dot: [DOT_SHADOW, DOT_ACCENT] as const };

export interface Strand {
  /** One subpath of the nest. */
  d: string;
  /** Arc length, measured once in a browser and frozen — see below. */
  length: number;
  /** Arc position the strand grows out from. */
  anchor: number;
  /** Rank in the firing sequence, 0 = first. */
  order: number;
}

/**
 * Measured once in a browser with getTotalLength() / getPointAtLength() and frozen here, in the order
 * the subpaths appear in `NEST_D`. react-native-svg exposes no reliable getTotalLength() and does not
 * support the SVG 2 `pathLength` attribute, so a dash-based reveal that measures at runtime works on
 * web and silently breaks on mobile.
 *
 * `anchor` is the point of each strand nearest the growth origin: the dash pattern is centred there,
 * so a strand spreads in both directions from it instead of unrolling from wherever the path data
 * happens to start. That is what separates a branch from a wipe.
 *
 * `order` ranks by the height of each strand's own anchor — not by distance to the origin (which
 * bunches almost every strand into the same instant), and not by the centre of its bounding box
 * (which puts the silhouette, spanning the whole mark, in the middle of the order, so the bottom of
 * the logo would not be among the first things drawn).
 */
const MEASURED: readonly Omit<Strand, 'd'>[] = [
  { length: 636.54, anchor: 416.41, order: 0 },
  { length: 402.08, anchor: 194.34, order: 1 },
  { length: 262.7, anchor: 60.2, order: 0.63 },
  { length: 173.62, anchor: 103.45, order: 0.49 },
  { length: 96.52, anchor: 96.12, order: 0.4 },
  { length: 195.93, anchor: 95.52, order: 0.15 },
  { length: 312.56, anchor: 131.53, order: 0.26 },
];

/**
 * The nest is a single path holding 7 subpaths: #0 is the house silhouette, #1–#6 are the cut-outs
 * that carve the weave (nonzero fill rule). Splitting on `M` is safe — the source uses absolute
 * commands only and no `m`.
 */
export const STRANDS: readonly Strand[] = MEASURED.map((measured, i) => {
  const d = NEST_D.split(/(?=M)/).filter(Boolean)[i];
  if (d === undefined) throw new Error('loader-geometry: nest subpaths no longer match MEASURED');
  return { ...measured, d };
});

/** Vertical extent of the strands, for the rising fill front. */
const STRAND_EXTENT = { top: 68.15, bottom: 278.67 };

/** Anchor of the first strand to fire: growth leaves from here, and so does the seed. */
export const SEED_POINT = { x: 144.34, y: 278.62 };
export const SEED_RADIUS = STROKE_THIN * 0.75;

/**
 * The rising fill front, as a plain rect whose top edge sweeps up through the mark.
 *
 * It is deliberately *not* a group holding a wavy path. On Android, a `<G>` inside a `<ClipPath>` is
 * resolved through `GroupView.getPath(canvas, paint)`, which caches its result (`if (mPath != null)
 * return mPath;`) — an animated group inside a clip path would freeze on its first frame. `RectView`
 * builds a fresh path on every call, so a rect is the one construction certain to animate. The
 * organic reading comes from the strands anyway; this edge is mostly hidden behind them.
 */
export const FILL_FRONT_RECT = {
  x: -20,
  width: LOADER_VIEWBOX.w + 40,
  height: LOADER_VIEWBOX.h + 160,
};
/** Travel of the front's top edge, from fully below the mark to fully above it. */
export const FILL_FRONT_FROM = STRAND_EXTENT.bottom + 30;
export const FILL_FRONT_TO = STRAND_EXTENT.top - 30;
