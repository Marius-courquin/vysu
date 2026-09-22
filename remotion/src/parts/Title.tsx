import React from 'react';
import { fitText } from '@remotion/layout-utils';
import { parseAccent, plainTitle } from '../text.ts';
import type { Theme } from '../schema.ts';

const TRACKING = -0.03;
const LINE_HEIGHT = 1.02;

// The site's hand-drawn underline, stretched to the accent word (preserveAspectRatio="none").
const UNDERLINE_PATH = 'M3 9C25 3.5 60 2.5 117 6.5';

// A chapter title is ONE line. `fitText` says what size the line needs to be; the title shrinks
// from `maxSize` down to `minSize` to stay on it, and only a title that still does not fit at
// `minSize` is allowed to wrap — a two-line chapter title is the exception, not the layout.
export const Title: React.FC<{
  theme: Theme;
  text: string;
  maxSize: number;
  minSize: number;
  maxLines: number;
  width: number;
  // Fonts are measured, so nothing is measured before they are there.
  fontsReady: boolean;
  underline: number;
}> = ({ theme, text, maxSize, minSize, maxLines, width, fontsReady, underline }) => {
  const plain = plainTitle(text);
  const fitted = fontsReady
    ? fitText({
        text: plain,
        withinWidth: width,
        fontFamily: theme.fonts.display,
        fontWeight: 800,
        letterSpacing: `${TRACKING}em`,
      }).fontSize
    : maxSize;
  const wraps = fitted < minSize;
  const size = Math.min(maxSize, wraps ? minSize : fitted);

  return (
    <div
      style={{
        fontFamily: theme.fonts.display,
        fontWeight: 800,
        fontSize: size,
        lineHeight: LINE_HEIGHT,
        letterSpacing: `${TRACKING}em`,
        color: theme.colors.foreground,
        // `overflow: hidden` is deliberately absent: the drawn underline hangs below the box.
        whiteSpace: wraps ? 'normal' : 'nowrap',
        maxHeight: size * LINE_HEIGHT * (wraps ? maxLines : 1),
      }}
    >
      {parseAccent(text).map((segment, i) =>
        segment.accent ? (
          <span
            // biome-ignore lint/suspicious/noArrayIndexKey: segments have no identity beyond order
            key={i}
            style={{
              position: 'relative',
              display: 'inline-block',
              color: theme.colors.secondary,
            }}
          >
            {segment.text}
            <svg
              viewBox="0 0 120 12"
              preserveAspectRatio="none"
              fill="none"
              style={{
                position: 'absolute',
                left: 0,
                right: 0,
                width: '100%',
                bottom: -Math.round(size * 0.09),
                height: Math.round(size * 0.136),
                overflow: 'visible',
              }}
            >
              <path
                d={UNDERLINE_PATH}
                stroke="currentColor"
                strokeWidth={4}
                strokeLinecap="round"
                pathLength={1}
                strokeDasharray={1}
                strokeDashoffset={1 - underline}
              />
            </svg>
          </span>
        ) : (
          // biome-ignore lint/suspicious/noArrayIndexKey: segments have no identity beyond order
          <span key={i}>{segment.text}</span>
        ),
      )}
    </div>
  );
};
