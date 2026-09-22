import React from 'react';
import { useCurrentFrame } from 'remotion';
import type { Layout } from '../layouts/geometry.ts';
import { SCENE_EASE, tween } from '../motion.ts';
import { Lockup, lockupHeightForMark } from './Lockup.tsx';
import type { Theme } from '../schema.ts';

// The lockup, and nothing else: the elapsed / total clock is gone — the progress line already says
// where the film is, and a clock on a 40 s explainer read as a stopwatch.
//
// It is the SAME lockup the Opening's loader has just finished weaving, at the same anchor: over
// the wipe it settles from the Opening's size down to the header's, so the brand is one continuous
// object across the cut rather than two lockups swapped under a disc.
export const Header: React.FC<{
  theme: Theme;
  layout: Layout;
  wipeFrames: number;
}> = ({ theme, layout, wipeFrames }) => {
  const frame = useCurrentFrame();
  const { header, opening } = layout;
  // A theme with no logo has no lockup to settle: the header is then simply empty, and the progress
  // line under it carries the chrome on its own.
  if (!theme.logo) return null;
  const from = lockupHeightForMark(opening.markHeight) / header.lockupHeight;
  const settle = tween(frame, 0, wipeFrames, SCENE_EASE);
  const scale = from + (1 - from) * settle;

  return (
    <Lockup
      theme={theme}
      height={header.lockupHeight}
      uid="header"
      style={{
        position: 'absolute',
        left: header.left,
        top: header.top,
        transformOrigin: 'left top',
        transform: `scale(${scale})`,
      }}
    />
  );
};
