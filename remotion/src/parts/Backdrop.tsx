import React from 'react';
import { AbsoluteFill, useVideoConfig } from 'remotion';
import type { Theme } from '../schema.ts';

const DOT_GRID = 30;
const DOT_RADIUS = 1.1;
const WASH = 640;

// The product site's hero ground: a dot grid on the background, visible in the middle and
// dissolved at the edges by
// an ellipse of the background colour, plus two brand washes kept faint enough to read as light
// rather than as shapes.
export const Backdrop: React.FC<{ theme: Theme; focus: { x: number; y: number } }> = ({
  theme,
  focus,
}) => {
  const { width, height } = useVideoConfig();
  const centre = { x: focus.x * width, y: focus.y * height };
  const washes = [
    { color: theme.colors.decorBlue, x: centre.x - 120, y: centre.y - 260 },
    { color: theme.colors.decorPeach, x: centre.x + 140, y: centre.y + 240 },
  ];
  return (
    <AbsoluteFill style={{ overflow: 'hidden' }}>
      <AbsoluteFill
        style={{
          backgroundImage: `radial-gradient(${theme.colors.border} ${DOT_RADIUS}px, transparent ${DOT_RADIUS}px)`,
          backgroundSize: `${DOT_GRID}px ${DOT_GRID}px`,
        }}
      />
      <AbsoluteFill
        style={{
          background: `radial-gradient(ellipse 65% 75% at 45% 45%, ${theme.colors.background}33 0%, ${theme.colors.background} 80%)`,
        }}
      />
      {washes.map((wash) => (
        <div
          key={wash.color}
          style={{
            position: 'absolute',
            left: wash.x - WASH / 2,
            top: wash.y - WASH / 2,
            width: WASH,
            height: WASH,
            borderRadius: '50%',
            background: `radial-gradient(circle, ${wash.color}2E 0%, ${wash.color}00 70%)`,
          }}
        />
      ))}
    </AbsoluteFill>
  );
};
