import React from 'react';
import type { Theme } from '../schema.ts';

// Phosphor arrow-up-right, bold: the site's own "go there" arrow.
const ARROW_UP_RIGHT =
  'M204,64V168a12,12,0,0,1-24,0V93L72.49,200.49a12,12,0,0,1-17-17L163,76H88a12,12,0,0,1,0-24H192A12,12,0,0,1,204,64Z';

// The site's ink CTA pill, the last thing on screen: the call to action, not a caption.
export const Pill: React.FC<{
  theme: Theme;
  label: string;
  fontSize: number;
  padding: { x: number; y: number };
}> = ({ theme, label, fontSize, padding }) => (
  <div
    style={{
      display: 'inline-flex',
      alignItems: 'center',
      gap: Math.round(fontSize * 0.6),
      padding: `${padding.y}px ${padding.x}px`,
      borderRadius: 999,
      background: theme.colors.foreground,
      color: theme.colors.card,
      fontFamily: theme.fonts.body,
      fontWeight: 500,
      fontSize,
    }}
  >
    {label}
    <svg
      viewBox="0 0 256 256"
      width={Math.round(fontSize * 0.8)}
      height={Math.round(fontSize * 0.8)}
      fill="currentColor"
      aria-hidden
    >
      <path d={ARROW_UP_RIGHT} />
    </svg>
  </div>
);
