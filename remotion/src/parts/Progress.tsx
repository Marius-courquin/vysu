import React from 'react';
import { interpolate, spring, useCurrentFrame, useVideoConfig } from 'remotion';
import type { Layout } from '../layouts/geometry.ts';
import type { Theme } from '../schema.ts';

const TRACK = 6;
const DOT = 14;
const HALO = 24;

// Blue is time. The fill is a clock over the DEMO alone — 0 on the first montage frame, 1 on the
// last — so it measures what the viewer is being shown, not the cards around it. Each chapter is a
// dot on it. It sits under the header, never at the frame's bottom edge where the players draw
// their own.
export const Progress: React.FC<{
  theme: Theme;
  layout: Layout;
  // Montage seconds at which each chapter takes over.
  chapterStarts: number[];
  montageSeconds: number;
  enter: number;
}> = ({ theme, layout, chapterStarts, montageSeconds, enter }) => {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();
  const { left, top, width } = layout.progress;
  const elapsed = frame / fps;
  const totalSeconds = montageSeconds;
  const current = chapterStarts.reduce((acc, start, i) => (elapsed >= start ? i : acc), -1);

  return (
    <div style={{ position: 'absolute', left, top, width, height: TRACK, opacity: enter }}>
      <div
        style={{
          width,
          height: TRACK,
          borderRadius: TRACK / 2,
          background: theme.colors.border,
        }}
      />
      <div
        style={{
          position: 'absolute',
          left: 0,
          top: 0,
          width: width * Math.min(1, Math.max(0, elapsed) / Math.max(totalSeconds, 0.001)),
          height: TRACK,
          borderRadius: TRACK / 2,
          background: theme.colors.primary,
        }}
      />
      {chapterStarts.map((start, i) => {
        const x = (width * start) / Math.max(totalSeconds, 0.001);
        const reached = elapsed >= start;
        const pop = reached
          ? spring({ frame: frame - start * fps, fps, durationInFrames: Math.round(0.3 * fps), config: { damping: 200 } })
          : 0;
        const scale = interpolate(pop, [0, 1], [0.6, 1]);
        return (
          <React.Fragment key={i}>
            {i === current ? (
              <div
                style={{
                  position: 'absolute',
                  left: x - HALO / 2,
                  top: TRACK / 2 - HALO / 2,
                  width: HALO,
                  height: HALO,
                  borderRadius: HALO / 2,
                  background: theme.colors.primaryTint,
                }}
              />
            ) : null}
            <div
              style={{
                position: 'absolute',
                left: x - DOT / 2,
                top: TRACK / 2 - DOT / 2,
                width: DOT,
                height: DOT,
                borderRadius: DOT / 2,
                background: reached ? theme.colors.primary : theme.colors.card,
                boxShadow: reached ? undefined : `inset 0 0 0 2px ${theme.colors.border}`,
                transform: reached ? `scale(${scale})` : undefined,
              }}
            />
          </React.Fragment>
        );
      })}
    </div>
  );
};
