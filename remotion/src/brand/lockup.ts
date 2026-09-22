import { LOCKUP, MARK, type LogoPath } from './logo-paths.ts';

// The lockup is the mark plus the word, and both geometries are generated from the same drawing:
// the nest path is identical in MARK and in LOCKUP up to a translation. Deriving that translation
// from the two `M` commands (rather than hardcoding it) keeps the assembled lockup pixel-exact
// through a regeneration of logo-paths.ts.
function firstPoint(path: LogoPath): { x: number; y: number } {
  const m = path.d.match(/^M\s*(-?[\d.]+)[\s,]+(-?[\d.]+)/);
  if (!m) throw new Error('lockup: a logo path does not start with an absolute M');
  return { x: Number(m[1]), y: Number(m[2]) };
}

const markNest = firstPoint(MARK.paths[0]);
const lockupNest = firstPoint(LOCKUP.paths[0]);

/** Translation that maps MARK viewBox coordinates into the LOCKUP viewBox. */
export const MARK_IN_LOCKUP = {
  x: lockupNest.x - markNest.x,
  y: lockupNest.y - markNest.y,
};

export const LOCKUP_VIEWBOX = LOCKUP.viewBox;

/** The word alone: everything of the lockup that is not part of the mark. */
export const WORD_PATHS: LogoPath[] = LOCKUP.paths.slice(MARK.paths.length);
