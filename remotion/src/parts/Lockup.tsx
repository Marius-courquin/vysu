import React from 'react';
import { LOADER_MARK_HEIGHT } from '../brand/loader-geometry.ts';
import { LOCKUP_VIEWBOX, MARK_IN_LOCKUP } from '../brand/lockup.ts';
import { paletteFromColors } from '../brand/palette.ts';
import { BrandLoader } from './BrandLoader.tsx';
import { Wordmark } from './Wordmark.tsx';
import type { Theme } from '../schema.ts';

// ONE lockup for the whole film: the header's, the Opening's and the Finish's are the same drawing,
// so the mark the loader weaves lands exactly where the header's lockup sits. `word` is how far the
// wordmark has arrived (0 = the mark alone, as the loader still weaves it).

export const LOCKUP_RATIO = LOCKUP_VIEWBOX.w / LOCKUP_VIEWBOX.h;
/** Height of the whole lockup box for a given mark height (the loader's own `size`). */
export const lockupHeightForMark = (markHeight: number) =>
  (markHeight * LOCKUP_VIEWBOX.h) / LOADER_MARK_HEIGHT;

export const Lockup: React.FC<{
  theme: Theme;
  // Height of the lockup box in px; the width follows.
  height: number;
  // Loader progress, 0 to 1. 1 is the finished mark.
  t?: number;
  // Wordmark reveal, 0 to 1.
  word?: number;
  uid?: string;
  style?: React.CSSProperties;
}> = ({ theme, height, t = 1, word = 1, uid = 'lockup', style }) => {
  const palette = paletteFromColors(theme.colors.primary, theme.colors.secondary);
  return (
    <svg
      width={height * LOCKUP_RATIO}
      height={height}
      viewBox={`0 0 ${LOCKUP_VIEWBOX.w} ${LOCKUP_VIEWBOX.h}`}
      fill="none"
      style={style}
      aria-hidden
    >
      <g transform={`translate(${MARK_IN_LOCKUP.x} ${MARK_IN_LOCKUP.y})`}>
        <BrandLoader t={t} palette={palette} uid={uid} />
      </g>
      <g opacity={word} transform={`translate(${-10 * (1 - word)} 0)`}>
        <Wordmark palette={palette} />
      </g>
    </svg>
  );
};
