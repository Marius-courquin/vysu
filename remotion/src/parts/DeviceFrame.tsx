import React from 'react';
import { interpolate, spring, useCurrentFrame, useVideoConfig } from 'remotion';
import type { Clip, Theme } from '../schema.ts';

export type DeviceKind = 'phone' | 'browser';

// Same rule as tools/visual/frame.py --device auto: a tall portrait capture is a phone, anything
// else is a browser window.
export function deviceKind(clip: Clip): DeviceKind {
  const { w, h } = clip.logical;
  return h / w > 1.9 ? 'phone' : 'browser';
}

const BROWSER_BAR = 44;
const ENTRANCE_SECONDS = 0.6;

export function frameChrome(kind: DeviceKind, bezel: number, radius: number, theme: Theme) {
  return kind === 'phone'
    ? { top: bezel, side: bezel, bottom: bezel, radius }
    : { top: BROWSER_BAR, side: 2, bottom: 2, radius: theme.radius.browser };
}

export const DeviceFrame: React.FC<{
  kind: DeviceKind;
  theme: Theme;
  left: number;
  top: number;
  width: number;
  height: number;
  bezel: number;
  radius: number;
  children: React.ReactNode;
}> = ({ kind, theme, left, top, width, height, bezel, radius, children }) => {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();
  const enter = spring({
    frame,
    fps,
    durationInFrames: Math.round(ENTRANCE_SECONDS * fps),
    config: { damping: 200 },
  });
  const rise = interpolate(enter, [0, 1], [60, 0]);
  const chrome = frameChrome(kind, bezel, radius, theme);

  return (
    <div
      style={{
        position: 'absolute',
        left: left - chrome.side,
        top: top - chrome.top + rise,
        width: width + 2 * chrome.side,
        height: height + chrome.top + chrome.bottom,
        borderRadius: chrome.radius + chrome.side,
        background: kind === 'phone' ? '#111111' : theme.colors.card,
        border: kind === 'browser' ? `1px solid ${theme.colors.border}` : undefined,
        boxShadow: theme.shadow.device,
        opacity: enter,
      }}
    >
      {kind === 'browser' ? <BrowserBar theme={theme} width={width} /> : null}
      <div
        style={{
          position: 'absolute',
          left: chrome.side,
          top: chrome.top,
          width,
          height,
          borderRadius: kind === 'phone' ? chrome.radius : 0,
          overflow: 'hidden',
          background: '#000',
        }}
      >
        {children}
      </div>
    </div>
  );
};

const BrowserBar: React.FC<{ theme: Theme; width: number }> = ({ theme, width }) => (
  <div
    style={{
      position: 'absolute',
      left: 2,
      top: 0,
      width,
      height: BROWSER_BAR,
      display: 'flex',
      alignItems: 'center',
      gap: 10,
      paddingLeft: 18,
    }}
  >
    {[theme.colors.border, theme.colors.border, theme.colors.border].map((color, i) => (
      <div key={i} style={{ width: 12, height: 12, borderRadius: 6, background: color }} />
    ))}
    <div
      style={{
        marginLeft: 14,
        width: width * 0.45,
        height: 22,
        borderRadius: 11,
        background: theme.colors.background,
        border: `1px solid ${theme.colors.border}`,
      }}
    />
  </div>
);
