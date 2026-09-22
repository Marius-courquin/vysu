import React from 'react';
import { AbsoluteFill, useCurrentFrame, useVideoConfig } from 'remotion';
import type { Layout } from '../layouts/geometry.ts';
import { tween } from '../motion.ts';
import { parseAccent } from '../text.ts';
import { Backdrop } from './Backdrop.tsx';
import { Lockup, LOCKUP_RATIO } from './Lockup.tsx';
import { Pill } from './Pill.tsx';
import type { Theme } from '../schema.ts';

const CONTENT_IN = 0.6;
const CONTENT_RISE = 40;
const FADE_OUT = 0.4;

// The last scene: a disc of the background grows out of the phone until it covers the frame, then
// the closing card rises into it. The accent word is `primary` here, not the secondary accent: the
// film ends on the brand, not on an instruction.
export const Finish: React.FC<{
  theme: Theme;
  layout: Layout;
  title: string;
  subtitle: string | null;
  cta: string;
  caption: string;
  finishFrames: number;
  wipeFrames: number;
}> = ({ theme, layout, title, subtitle, cta, caption, finishFrames, wipeFrames }) => {
  const frame = useCurrentFrame();
  const { fps, width, height } = useVideoConfig();
  const { finish, device } = layout;

  const origin = {
    x: ((device.left + device.width / 2) / width) * 100,
    y: ((device.top + device.height / 2) / height) * 100,
  };
  const grow = tween(frame, 0, wipeFrames);
  const arrive = tween(frame, wipeFrames, wipeFrames + CONTENT_IN * fps);
  const leave = tween(frame, finishFrames - FADE_OUT * fps, finishFrames);
  const lockupHeight = finish.lockupWidth / LOCKUP_RATIO;

  return (
    <AbsoluteFill
      style={{
        backgroundColor: theme.colors.background,
        clipPath: `circle(${grow * 130}% at ${origin.x}% ${origin.y}%)`,
      }}
    >
      <Backdrop theme={theme} focus={{ x: 0.5, y: 0.5 }} />
      <AbsoluteFill
        style={{
          paddingTop: finish.top ?? undefined,
          display: 'flex',
          flexDirection: 'column',
          alignItems: 'center',
          justifyContent: finish.top === null ? 'center' : 'flex-start',
          textAlign: 'center',
          color: theme.colors.foreground,
          opacity: arrive,
          transform: `translateY(${(1 - arrive) * CONTENT_RISE}px)`,
        }}
      >
        {theme.logo ? <Lockup theme={theme} height={lockupHeight} uid="finish" /> : null}
        <div
          style={{
            // The title's top margin is the gap UNDER the lockup: with no lockup drawn it would
            // push the whole card off its optical centre, so it goes away with it.
            marginTop: theme.logo ? Math.round(finish.titleSize * 0.55) : 0,
            width: finish.titleWidth,
            fontFamily: theme.fonts.display,
            fontWeight: 800,
            fontSize: finish.titleSize,
            lineHeight: 1.04,
            letterSpacing: '-0.035em',
          }}
        >
          {parseAccent(title).map((segment, i) => (
            <span
              // biome-ignore lint/suspicious/noArrayIndexKey: segments have no identity beyond order
              key={i}
              style={{ color: segment.accent ? theme.colors.primary : undefined }}
            >
              {segment.text}
            </span>
          ))}
        </div>
        {subtitle ? (
          <div
            style={{
              marginTop: Math.round(finish.subtitleSize * 1.35),
              fontFamily: theme.fonts.body,
              fontWeight: 400,
              fontSize: finish.subtitleSize,
            }}
          >
            {subtitle}
          </div>
        ) : null}
        <div style={{ marginTop: Math.round(finish.ctaSize * 1.55) }}>
          <Pill theme={theme} label={cta} fontSize={finish.ctaSize} padding={finish.ctaPadding} />
        </div>
        <div
          style={{
            marginTop: Math.round(finish.captionSize),
            fontFamily: theme.fonts.body,
            fontWeight: 400,
            fontSize: finish.captionSize,
          }}
        >
          {caption}
        </div>
      </AbsoluteFill>
      {/* The film closes on the cream itself. */}
      <AbsoluteFill style={{ backgroundColor: theme.colors.background, opacity: leave }} />
    </AbsoluteFill>
  );
};
