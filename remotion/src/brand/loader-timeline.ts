// Vendored from the product's own UI package (brand/loader-timeline): the smoothed choreography,
// pure functions of t in [0,1].
// The `'worklet'` directives are dropped (no Reanimated here) and the idle loop is left behind:
// the film builds the mark once and holds it.

const clamp01 = (x: number): number => {
  return x < 0 ? 0 : x > 1 ? 1 : x;
};

const span = (t: number, a: number, b: number): number => {
  return clamp01((t - a) / (b - a));
};

// Zero velocity and acceleration at both ends: overlapping gestures join without a kick.
const easeInOut = (x: number): number => {
  return x * x * x * (x * (x * 6 - 15) + 10);
};

const bump = (t: number, a: number, b: number): number => {
  const p = span(t, a, b);
  return (1 - Math.cos(2 * Math.PI * p)) / 2;
};

/** Duration of the one-off weave, including the dot settling into place. */
export const LOADER_DURATION_MS = 1600;

const PHASE = {
  seedEnd: 0.1,
  rootsStart: 0.025,
  rootsEnd: 0.54,
  closeStart: 0.44,
  closeEnd: 0.64,
  inhaleEnd: 0.73,
  exhaleEnd: 1,
  stemStart: 0.4,
  stemEnd: 0.63,
  dotStart: 0.6,
  dotEnd: 1,
} as const;

const STRAND_SHARE = 0.62;
const SWELL_DELAY = 0.045;
const FILL_LAG = 0.18;

/** Fraction of a strand grown; `order` is its normalised rank, and negative `lead` delays it. */
export function strandAt(t: number, order: number, lead = 0): number {
  const total = PHASE.rootsEnd - PHASE.rootsStart;
  const grow = total * STRAND_SHARE;
  const start = PHASE.rootsStart + (total - grow) * order;
  return easeInOut(span(t + lead, start, start + grow));
}

/** Stroke weight follows the growth front with a short delay. */
export function strandWidthAt(t: number, order: number, thin: number, thick: number): number {
  return thin + (thick - thin) * strandAt(t, order, -SWELL_DELAY);
}

/** Coverage of the final, exact silhouette over the construction. */
export function fillAt(t: number): number {
  return easeInOut(span(t, PHASE.closeStart, PHASE.closeEnd));
}

/** Linear front follows the linearly staggered strands, rather than overtaking the last ones. */
export function fillFrontAt(t: number): number {
  return clamp01((span(t, PHASE.rootsStart, PHASE.rootsEnd) - FILL_LAG) / (1 - FILL_LAG));
}

/** The seed grows into the first strand without an overshoot or a separate fade-out. */
export function seedScaleAt(t: number): number {
  return easeInOut(span(t, 0, PHASE.seedEnd));
}

/** The weave settles, then takes a small breath as the dot emerges. */
export function houseScaleAt(t: number): number {
  if (t < PHASE.closeStart) {
    return 0.985 + 0.015 * easeInOut(span(t, PHASE.rootsStart, PHASE.closeStart));
  }
  if (t < PHASE.inhaleEnd) {
    return 1 + 0.025 * easeInOut(span(t, PHASE.closeStart, PHASE.inhaleEnd));
  }
  return 1.025 - 0.025 * easeInOut(span(t, PHASE.inhaleEnd, PHASE.exhaleEnd));
}

const DOT_TRAVEL = 34;
const DOT_OVERSHOOT = 10;
const DOT_FADE_FROM = 6;
const DOT_FADE_TO = 20;

// Position-based visibility keeps the dot hidden behind the translucent, diagonal chimney.
function dotVisibility(ty: number): number {
  return 1 - easeInOut(clamp01((ty - DOT_FADE_FROM) / (DOT_FADE_TO - DOT_FADE_FROM)));
}

export interface ChimneyState {
  /** Vertical scale of the stem, pivoting on its base. */
  stem: number;
  dot: { scale: number; opacity: number; ty: number };
}

/** The dot rises out of the stem, rounds its apex, then gently settles at rest. */
export function chimneyAt(t: number): ChimneyState {
  const grow = easeInOut(span(t, PHASE.stemStart, PHASE.stemEnd));
  const p = span(t, PHASE.dotStart, PHASE.dotEnd);
  const rise = easeInOut(clamp01(p / 0.6));
  const settle = easeInOut(span(p, 0.6, 1));
  const ty = DOT_TRAVEL - (DOT_TRAVEL + DOT_OVERSHOOT) * rise + DOT_OVERSHOOT * settle;
  return {
    stem: grow * (1 - 0.07 * bump(t, PHASE.dotStart, PHASE.dotEnd)),
    dot: {
      scale: 0.84 + 0.16 * rise,
      opacity: dotVisibility(ty),
      ty,
    },
  };
}
