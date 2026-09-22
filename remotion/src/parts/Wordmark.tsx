import React from 'react';
import { WORD_PATHS } from '../brand/lockup.ts';
import type { Palette } from '../brand/palette.ts';

// The word of the LOCKUP geometry, without the mark: the solid glyphs plus their accent dot. Drawn
// in the LOCKUP viewBox, so it needs no placement of its own.
export const Wordmark: React.FC<{ palette: Palette }> = ({ palette }) => (
  <>
    {WORD_PATHS.map((path, i) => (
      <path
        // biome-ignore lint/suspicious/noArrayIndexKey: static path list, order is the identity
        key={i}
        d={path.d}
        fill={path.role === 'accent' ? palette.accent : palette.bodySolid}
      />
    ))}
  </>
);
