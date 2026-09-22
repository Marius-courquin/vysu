import React from 'react';
import { Video } from '@remotion/media';
import { Sequence, staticFile, useVideoConfig } from 'remotion';
import { outTimeOf, segmentSeconds } from '../cut.ts';
import { Ripple, RIPPLE_SECONDS } from './Ripple.tsx';
import type { Clip as ClipData, Segment, Tap, Theme } from '../schema.ts';

function firstInstant(segments: Segment[]): number {
  const first = segments[0];
  if (!first) return 0;
  return 'freeze' in first ? first.freeze : first.from;
}

// The montage: the kept segments played back to back, freezes held, the take's ripples on top. It
// starts with the scene: the Opening's disc is still leaving over its first half second, so the
// phone rises on the shot the montage opens on.
export const Clip: React.FC<{
  clip: ClipData;
  segments: Segment[];
  taps: Tap[];
  width: number;
  height: number;
  theme: Theme;
}> = ({ clip, segments, taps, width, height, theme }) => {
  const { fps } = useVideoConfig();
  const scale = width / clip.logical.w;

  if (!clip.src) {
    return (
      <div
        style={{
          width,
          height,
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          background: theme.colors.mutedFill,
          color: theme.colors.muted,
          fontFamily: theme.fonts.body,
          fontSize: Math.round(width / 14),
          textAlign: 'center',
        }}
      >
        aucun clip
      </div>
    );
  }

  const src = staticFile(clip.src);
  const still = (at: number) => (
    <Video src={src} trimBefore={Math.round(at * fps)} muted style={{ width, height }} />
  );
  let cursor = 0;

  return (
    <>
      {segments.map((segment, i) => {
        const from = Math.round(cursor * fps);
        const length = Math.max(1, Math.round(segmentSeconds(segment) * fps));
        cursor += segmentSeconds(segment);
        const startSeconds = 'freeze' in segment ? segment.freeze : segment.from;
        return (
          <Sequence
            key={i}
            from={from}
            durationInFrames={length}
            premountFor={fps}
            freeze={'freeze' in segment ? 0 : undefined}
            name={`seg ${i}`}
          >
            {still(startSeconds)}
          </Sequence>
        );
      })}
      {taps.map((tap, i) => {
        const at = outTimeOf(segments, tap.at);
        if (at === null) return null;
        return (
          <Sequence
            key={`tap-${i}`}
            from={Math.round(at * fps)}
            durationInFrames={Math.round(RIPPLE_SECONDS * fps)}
            name={`tap ${tap.at}`}
          >
            <Ripple x={tap.x * scale} y={tap.y * scale} scale={scale} theme={theme} />
          </Sequence>
        );
      })}
    </>
  );
};
