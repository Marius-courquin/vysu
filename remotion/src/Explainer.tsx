import React from 'react';
import { Audio } from '@remotion/media';
import { AbsoluteFill, interpolate, Sequence, staticFile, useVideoConfig } from 'remotion';
import { layoutOf } from './layouts/geometry.ts';
import { Demo } from './parts/Demo.tsx';
import { Finish } from './parts/Finish.tsx';
import { Opening } from './parts/Opening.tsx';
import { timelineOf } from './timeline.ts';
import { useThemeFonts } from './theme.ts';
import type { ExplainerProps } from './schema.ts';

const MUSIC_VOLUME = 0.55;
const MUSIC_IN = 0.7;
const MUSIC_OUT = 2.0;

// Three scenes and two cream circle wipes, in the register of the launch film: the Opening builds
// the brand, the Demo plays the take, the Finish hands the viewer the address. Each wipe is taken
// from the scene that ENDS, so the montage's own timing is untouched.
export const Explainer: React.FC<ExplainerProps> = (props) => {
  const { fps, durationInFrames } = useVideoConfig();
  const fontsReady = useThemeFonts(props.theme);
  const layout = layoutOf(props.format, props.clip);
  const timeline = timelineOf(props, fps);
  const openingFrames = timeline.demoStart;
  const finishFrames = durationInFrames - timeline.finishStart;

  return (
    <AbsoluteFill
      style={{
        backgroundColor: props.theme.colors.background,
        fontFamily: props.theme.fonts.body,
      }}
    >
      <Sequence
        from={timeline.demoStart}
        durationInFrames={Math.max(1, timeline.finishStart - timeline.demoStart)}
        name="Demo"
      >
        <Demo
          props={props}
          layout={layout}
          chapterStarts={timeline.chapterStarts}
          montageSeconds={timeline.montageSeconds}
          wipeFrames={timeline.wipeFrames}
          fontsReady={fontsReady}
        />
      </Sequence>

      {props.intro && openingFrames > 0 ? (
        <Sequence durationInFrames={openingFrames + timeline.wipeFrames} name="Opening">
          <Opening
            theme={props.theme}
            layout={layout}
            title={props.intro.title}
            subtitle={props.intro.subtitle}
            fontsReady={fontsReady}
            openingFrames={openingFrames}
            wipeFrames={timeline.wipeFrames}
          />
        </Sequence>
      ) : null}

      {props.outro && finishFrames > 0 ? (
        <Sequence
          from={timeline.finishStart - timeline.wipeFrames}
          durationInFrames={finishFrames + timeline.wipeFrames}
          name="Finish"
        >
          <Finish
            theme={props.theme}
            layout={layout}
            title={props.outro.title}
            subtitle={props.outro.subtitle}
            cta={props.outro.cta}
            caption={props.outro.caption}
            finishFrames={finishFrames + timeline.wipeFrames}
            wipeFrames={timeline.wipeFrames}
          />
        </Sequence>
      ) : null}

      {props.music ? (
        <Audio
          src={staticFile(props.music)}
          loop
          trimAfter={durationInFrames}
          volume={(f) =>
            MUSIC_VOLUME *
            interpolate(f, [0, MUSIC_IN * fps], [0, 1], { extrapolateRight: 'clamp' }) *
            interpolate(
              f,
              [durationInFrames - MUSIC_OUT * fps, durationInFrames],
              [1, 0],
              { extrapolateLeft: 'clamp', extrapolateRight: 'clamp' },
            )
          }
          loopVolumeCurveBehavior="extend"
        />
      ) : null}
    </AbsoluteFill>
  );
};
