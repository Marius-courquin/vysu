import React from 'react';
import { interpolate, useCurrentFrame, useVideoConfig } from 'remotion';
import type { Layout } from '../layouts/geometry.ts';
import {
  CHANGE_IN_SECONDS,
  CHANGE_OUT_SECONDS,
  CHANGE_SHIFT,
  EASE,
  ENTRANCE_SECONDS,
  ENTRANCE_SHIFT,
  STAGGER_SECONDS,
  entrance,
} from '../motion.ts';
import { parseAccent } from '../text.ts';
import { Title } from './Title.tsx';
import type { Chapter, Theme } from '../schema.ts';

const hasAccent = (title: string) => parseAccent(title).some((segment) => segment.accent);

const UNDERLINE_DELAY = 0.15;
const UNDERLINE_DRAW = 0.45;

// One chapter at a time in the Demo's text column. The first arrives with the scene (0.55 s); every
// later one is a change (the outgoing fades in place, the incoming rises 8 px).
export const Chapters: React.FC<{
  theme: Theme;
  layout: Layout;
  chapters: Chapter[];
  // Montage seconds at which each chapter takes over.
  starts: number[];
  fontsReady: boolean;
}> = ({ theme, layout, chapters, starts, fontsReady }) => {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();
  if (chapters.length === 0) return null;

  const frames = starts.map((seconds) => Math.round(seconds * fps));
  const index = frames.reduce((acc, start, i) => (frame >= start ? i : acc), -1);
  if (index < 0) return null;

  const outgoing = index > 0 && frame < frames[index] + CHANGE_OUT_SECONDS * fps ? index - 1 : null;

  return (
    <>
      {outgoing === null ? null : (
        <ChapterView
          key={`out-${outgoing}`}
          theme={theme}
          layout={layout}
          chapter={chapters[outgoing]}
          index={outgoing}
          fontsReady={fontsReady}
          local={frame - frames[outgoing]}
          first={outgoing === 0}
          fade={interpolate(frame - frames[index], [0, CHANGE_OUT_SECONDS * fps], [1, 0], {
            easing: EASE,
            extrapolateLeft: 'clamp',
            extrapolateRight: 'clamp',
          })}
        />
      )}
      <ChapterView
        key={index}
        theme={theme}
        layout={layout}
        chapter={chapters[index]}
        index={index}
        fontsReady={fontsReady}
        local={frame - frames[index]}
        first={index === 0}
        fade={1}
      />
    </>
  );
};

const ChapterView: React.FC<{
  theme: Theme;
  layout: Layout;
  chapter: Chapter;
  index: number;
  fontsReady: boolean;
  local: number;
  first: boolean;
  fade: number;
}> = ({ theme, layout, chapter, index, fontsReady, local, first, fade }) => {
  const { fps } = useVideoConfig();
  const duration = first ? ENTRANCE_SECONDS : CHANGE_IN_SECONDS;
  const shift = first ? ENTRANCE_SHIFT : CHANGE_SHIFT;
  const style = (order: number): React.CSSProperties => {
    const { opacity, translateY } = entrance({
      frame: local,
      fps,
      delaySeconds: order * STAGGER_SECONDS,
      durationSeconds: duration,
      shift,
    });
    return { opacity: opacity * fade, transform: `translateY(${translateY}px)` };
  };

  const { type } = layout;
  // The drawn underline hangs below the title's box, so an accented title needs more air under it
  // than a plain one.
  const underTitle =
    Math.round(type.title * 0.42) + (hasAccent(chapter.title) ? Math.round(type.title * 0.1) : 0);
  const underlineStart = (STAGGER_SECONDS + duration + UNDERLINE_DELAY) * fps;
  const underline = interpolate(
    local,
    [underlineStart, underlineStart + UNDERLINE_DRAW * fps],
    [0, 1],
    { easing: EASE, extrapolateLeft: 'clamp', extrapolateRight: 'clamp' },
  );

  return (
    <div
      style={{
        position: 'absolute',
        left: layout.column.left,
        top: layout.column.top,
        width: layout.column.width,
        height: layout.column.height ?? undefined,
      }}
    >
      <div
        style={{
          ...style(0),
          fontFamily: theme.fonts.body,
          fontWeight: 700,
          fontSize: type.kicker,
          letterSpacing: '0.08em',
          textTransform: 'uppercase',
          color: theme.colors.muted,
          marginBottom: Math.round(type.kicker * 1.2),
        }}
      >
        <span style={{ color: theme.colors.subtle }}>{String(index + 1).padStart(2, '0')}</span>
        {' · '}
        {chapter.kicker}
      </div>
      <div style={style(1)}>
        <Title
          theme={theme}
          text={chapter.title}
          maxSize={type.title}
          minSize={type.titleMin}
          maxLines={type.titleLines}
          width={layout.column.width}
          fontsReady={fontsReady}
          underline={underline}
        />
      </div>
      <div
        style={{
          ...style(2),
          marginTop: underTitle,
          fontFamily: theme.fonts.body,
          fontWeight: 400,
          fontSize: type.body,
          lineHeight: type.bodyLineHeight,
          color: theme.colors.muted,
          maxWidth: '34ch',
          display: '-webkit-box',
          WebkitBoxOrient: 'vertical',
          WebkitLineClamp: type.bodyLines,
          overflow: 'hidden',
        }}
      >
        {chapter.body}
      </div>
    </div>
  );
};
