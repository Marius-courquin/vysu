import React from 'react';
import { interpolate, useCurrentFrame, useVideoConfig } from 'remotion';
import { EASE } from '../motion.ts';
import type { Theme } from '../schema.ts';

export const RIPPLE_SECONDS = 0.4;

const FROM = 18;
const TO = 60;

// Orange is attention: a thin outline opening where the finger landed, nothing filled, no cursor.
export const Ripple: React.FC<{ x: number; y: number; scale: number; theme: Theme }> = ({
  x,
  y,
  scale,
  theme,
}) => {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();
  const progress = interpolate(frame, [0, RIPPLE_SECONDS * fps], [0, 1], {
    easing: EASE,
    extrapolateRight: 'clamp',
  });
  const size = interpolate(progress, [0, 1], [FROM * scale, TO * scale]);
  // The ring opens on the ease-out curve but fades LINEARLY: eased, the opacity would be spent
  // before the circle has finished opening and the ripple would never be seen.
  const opacity = interpolate(frame, [0, RIPPLE_SECONDS * fps], [0.8, 0], {
    extrapolateRight: 'clamp',
  });
  return (
    <div
      style={{
        position: 'absolute',
        left: x - size / 2,
        top: y - size / 2,
        width: size,
        height: size,
        borderRadius: '50%',
        border: `${3 * scale}px solid ${theme.colors.secondary}`,
        opacity,
      }}
    />
  );
};
