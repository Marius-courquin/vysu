import { deviceKind, type DeviceKind } from '../parts/DeviceFrame.tsx';
import { FORMAT_SIZES, type Clip, type Format } from '../schema.ts';

// Where everything sits, per format. The composition itself never holds a coordinate: it reads
// one of these boxes, so a new format is an entry here and nothing else.

export type Box = { left: number; top: number; width: number; height: number };

export type Layout = {
  device: Box & { kind: DeviceKind; bezel: number; radius: number };
  header: { left: number; top: number; right: number; lockupHeight: number };
  progress: { left: number; top: number; width: number };
  column: { left: number; top: number; width: number; height: number | null };
  // The Opening: the loader lands on the header's lockup, the title owns the rest of the frame.
  opening: {
    markHeight: number;
    titleLeft: number;
    titleTop: number;
    titleWidth: number;
    titleSize: number;
    subtitleLeft: number;
    // Anchored to the frame's bottom (landscape), or left to flow under the title (portrait, where
    // the title sits low enough that a fixed anchor would open a hole under it).
    subtitleBottom: number | null;
    subtitleSize: number;
  };
  // The Finish: one centred column, the launch film's closing card.
  finish: {
    // Distance from the top, or null to centre the card in the frame.
    top: number | null;
    lockupWidth: number;
    titleSize: number;
    titleWidth: number;
    subtitleSize: number;
    ctaSize: number;
    ctaPadding: { x: number; y: number };
    captionSize: number;
  };
  type: {
    kicker: number;
    title: number;
    titleMin: number;
    titleLines: number;
    body: number;
    bodyLineHeight: number;
    bodyLines: number;
  };
};

function landscape(clip: Clip): Layout {
  const kind = deviceKind(clip);
  const { height } = FORMAT_SIZES.landscape;
  const device =
    kind === 'phone'
      ? (() => {
          const h = 960;
          const w = Math.round((h * clip.logical.w) / clip.logical.h);
          return { left: 1240, top: (height - h) / 2, width: w, height: h };
        })()
      : (() => {
          const w = 800;
          const h = Math.round((w * clip.logical.h) / clip.logical.w);
          return { left: 1060, top: Math.round((height - h) / 2), width: w, height: h };
        })();
  return {
    device: { ...device, kind, bezel: 12, radius: 92 },
    header: { left: 120, top: 80, right: 1020, lockupHeight: 44 },
    progress: { left: 120, top: 150, width: 900 },
    column: { left: 120, top: 380, width: 900, height: null },
    opening: {
      markHeight: 120,
      titleLeft: 120,
      titleTop: 360,
      titleWidth: 1600,
      titleSize: 120,
      subtitleLeft: 124,
      subtitleBottom: 205,
      subtitleSize: 34,
    },
    finish: {
      top: 175,
      lockupWidth: 245,
      titleSize: 118,
      titleWidth: 1500,
      subtitleSize: 33,
      ctaSize: 28,
      ctaPadding: { x: 37, y: 20 },
      captionSize: 26,
    },
    type: {
      kicker: 22,
      title: 88,
      titleMin: 64,
      titleLines: 2,
      body: 34,
      bodyLineHeight: 1.5,
      bodyLines: 3,
    },
  };
}

// Safe areas of the short-video players: nothing above 140 or below 1440, x 60 -> 900. The text
// block has a FIXED height so the phone never moves when a chapter runs one line longer.
function portrait(clip: Clip): Layout {
  const kind = deviceKind(clip);
  const device =
    kind === 'phone'
      ? (() => {
          const h = 820;
          const w = Math.round((h * clip.logical.w) / clip.logical.h);
          return { left: Math.round(540 - w / 2), top: 590, width: w, height: h };
        })()
      : (() => {
          const w = 840;
          const h = Math.min(820, Math.round((w * clip.logical.h) / clip.logical.w));
          return { left: 60, top: 590, width: w, height: h };
        })();
  return {
    device: { ...device, kind, bezel: 10, radius: 80 },
    header: { left: 60, top: 150, right: 900, lockupHeight: 40 },
    progress: { left: 60, top: 216, width: 840 },
    column: { left: 60, top: 262, width: 840, height: 300 },
    opening: {
      markHeight: 96,
      titleLeft: 60,
      titleTop: 660,
      // Nothing sits on the right of the Opening, so the title may use the full safe width.
      titleWidth: 960,
      titleSize: 84,
      subtitleLeft: 60,
      subtitleBottom: null,
      subtitleSize: 30,
    },
    finish: {
      top: null,
      lockupWidth: 220,
      titleSize: 84,
      titleWidth: 900,
      subtitleSize: 30,
      ctaSize: 26,
      ctaPadding: { x: 32, y: 18 },
      captionSize: 24,
    },
    type: {
      kicker: 20,
      title: 60,
      titleMin: 52,
      titleLines: 2,
      body: 28,
      bodyLineHeight: 1.45,
      bodyLines: 2,
    },
  };
}

export function layoutOf(format: Format, clip: Clip): Layout {
  return format === 'portrait' ? portrait(clip) : landscape(clip);
}
