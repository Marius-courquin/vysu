import React from 'react';
import { AbsoluteFill, useCurrentFrame, useVideoConfig } from 'remotion';
import type { Layout } from '../layouts/geometry.ts';
import { Backdrop } from './Backdrop.tsx';
import { Chapters } from './Chapters.tsx';
import { Clip } from './Clip.tsx';
import { DeviceFrame } from './DeviceFrame.tsx';
import { Header } from './Header.tsx';
import { Progress } from './Progress.tsx';
import { ENTRANCE_SECONDS, entrance } from '../motion.ts';
import type { ExplainerProps } from '../schema.ts';

// The montage itself: header, progress line, one chapter at a time and the phone. It is mounted a
// wipe BEFORE its first montage frame — the Opening's disc peels away to reveal it already laid
// out, and its own chrome arrives as that happens.
export const Demo: React.FC<{
  props: ExplainerProps;
  layout: Layout;
  chapterStarts: number[];
  montageSeconds: number;
  wipeFrames: number;
  fontsReady: boolean;
}> = ({ props, layout, chapterStarts, montageSeconds, wipeFrames, fontsReady }) => {
  const frame = useCurrentFrame();
  const { fps, width, height } = useVideoConfig();
  const { device } = layout;
  const enter = entrance({
    frame,
    fps,
    durationSeconds: ENTRANCE_SECONDS,
    shift: 0,
  }).opacity;
  const focus = {
    x: (device.left + device.width / 2) / width,
    y: (device.top + device.height / 2) / height,
  };

  return (
    <AbsoluteFill
      style={{
        backgroundColor: props.theme.colors.background,
        fontFamily: props.theme.fonts.body,
      }}
    >
      <Backdrop theme={props.theme} focus={focus} />
      <Header theme={props.theme} layout={layout} wipeFrames={wipeFrames} />
      <Progress
        theme={props.theme}
        layout={layout}
        chapterStarts={chapterStarts}
        montageSeconds={montageSeconds}
        enter={enter}
      />
      <Chapters
        theme={props.theme}
        layout={layout}
        chapters={props.chapters}
        starts={chapterStarts}
        fontsReady={fontsReady}
      />
      <DeviceFrame
        kind={device.kind}
        theme={props.theme}
        left={device.left}
        top={device.top}
        width={device.width}
        height={device.height}
        bezel={device.bezel}
        radius={device.radius}
      >
        <Clip
          clip={props.clip}
          segments={props.segments}
          taps={props.taps}
          width={device.width}
          height={device.height}
          theme={props.theme}
        />
      </DeviceFrame>
    </AbsoluteFill>
  );
};
