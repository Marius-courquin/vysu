import React from 'react';
import { AbsoluteFill, useCurrentFrame, useVideoConfig } from 'remotion';
import type { Layout } from '../layouts/geometry.ts';
import { wrapAccent } from '../lines.ts';
import { SCENE_EASE, tween } from '../motion.ts';
import { Backdrop } from './Backdrop.tsx';
import { Lockup, lockupHeightForMark } from './Lockup.tsx';
import { LOADER_SECONDS, type Theme } from '../schema.ts';

const TITLE_TRACKING = '-0.035em';
const TITLE_LINE_HEIGHT = 1.04;
const LINE_RISE = 70;
const LINE_IN = 0.7;
const LINE_STAGGER = 0.4;
const SUBTITLE_DELAY = 1.0;
// The dot fires out of the mark at this point of the weave; the word arrives with it.
const WORD_AT = 0.62;
const WORD_IN = 0.55;

// The first scene: cream, the mark weaving itself into the lockup, one huge title landing line by
// line. Its own surface is the wipe — the disc shrinks away from the centre-right and the Demo,
// already laid out underneath, is what is left.
export const Opening: React.FC<{
  theme: Theme;
  layout: Layout;
  title: string;
  subtitle: string;
  fontsReady: boolean;
  openingFrames: number;
  wipeFrames: number;
}> = ({ theme, layout, title, subtitle, fontsReady, openingFrames, wipeFrames }) => {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();
  const { opening, header } = layout;

  const t = Math.min(1, frame / (LOADER_SECONDS * fps));
  const word = tween(frame, (WORD_AT * LOADER_SECONDS) * fps, (WORD_AT * LOADER_SECONDS + WORD_IN) * fps);
  const lockupHeight = lockupHeightForMark(opening.markHeight);

  const lines = wrapAccent({
    text: title,
    fontFamily: theme.fonts.display,
    fontSize: opening.titleSize,
    fontWeight: 800,
    letterSpacing: TITLE_TRACKING,
    maxWidth: opening.titleWidth,
    fontsReady,
  });

  // The disc is the Opening's own surface leaving, over the montage's first half second: 130 %
  // covers the frame from any anchor. The card rides it out — lifting and fading — so the title is
  // gone by the time the disc would cut through the middle of a word.
  const leaving = tween(frame, openingFrames, openingFrames + wipeFrames, SCENE_EASE);
  const leave = 1 - leaving;
  const subtitleIn = tween(frame, SUBTITLE_DELAY * fps, (SUBTITLE_DELAY + LINE_IN) * fps);
  // Where there is no bottom anchor, the subtitle follows the title's own last line.
  const flowing = opening.subtitleBottom === null;
  const subtitleTop =
    opening.titleTop +
    lines.length * opening.titleSize * TITLE_LINE_HEIGHT +
    Math.round(opening.subtitleSize * 1.5);

  return (
    <AbsoluteFill
      style={{
        backgroundColor: theme.colors.background,
        clipPath: `circle(${leave * 130}% at 65% 55%)`,
      }}
    >
      <Backdrop theme={theme} focus={{ x: 0.5, y: 0.55 }} />
      <AbsoluteFill
        style={{
          opacity: 1 - tween(frame, openingFrames + wipeFrames * 0.35, openingFrames + wipeFrames),
          transform: `translateY(${-leaving * 120}px)`,
        }}
      >
      {/* Without a logo in the theme there is no mark to weave: the loader block is skipped, and
          only it. The title's own stagger is measured from the scene's first frame rather than from
          the weave, so it lands at the same instants and the Opening keeps its duration. */}
      {theme.logo ? (
        <Lockup
          theme={theme}
          height={lockupHeight}
          t={t}
          word={word}
          uid="opening"
          style={{ position: 'absolute', left: header.left, top: header.top }}
        />
      ) : null}
      <div
        style={{
          position: 'absolute',
          left: opening.titleLeft,
          top: opening.titleTop,
          width: opening.titleWidth,
          fontFamily: theme.fonts.display,
          fontWeight: 800,
          fontSize: opening.titleSize,
          lineHeight: TITLE_LINE_HEIGHT,
          letterSpacing: TITLE_TRACKING,
          color: theme.colors.foreground,
        }}
      >
        {lines.map((line, i) => {
          const from = i * LINE_STAGGER * fps;
          const inProgress = tween(frame, from, from + LINE_IN * fps);
          return (
            <div
              // biome-ignore lint/suspicious/noArrayIndexKey: lines have no identity beyond order
              key={i}
              style={{
                opacity: inProgress,
                transform: `translateY(${(1 - inProgress) * LINE_RISE}px)`,
              }}
            >
              {line.map((segment, j) => (
                // The Opening's accent is the launch film's plain orange word: the drawn underline
                // belongs to the chapter titles.
                <span
                  // biome-ignore lint/suspicious/noArrayIndexKey: segments have no identity beyond order
                  key={j}
                  style={{ color: segment.accent ? theme.colors.secondary : undefined }}
                >
                  {segment.text}
                </span>
              ))}
            </div>
          );
        })}
      </div>
      <div
        style={{
          position: 'absolute',
          left: opening.subtitleLeft,
          top: flowing ? subtitleTop : undefined,
          bottom: opening.subtitleBottom ?? undefined,
          fontFamily: theme.fonts.body,
          fontWeight: 400,
          fontSize: opening.subtitleSize,
          color: theme.colors.foreground,
          opacity: subtitleIn,
        }}
      >
        {subtitle}
      </div>
      </AbsoluteFill>
    </AbsoluteFill>
  );
};
