import { outTimeOrNext, totalSeconds } from './cut.ts';
import { FPS, WIPE_SECONDS, type ExplainerProps } from './schema.ts';

// Where the three scenes sit on the film's own clock. Everything downstream reads this: no
// component computes a scene boundary of its own.
//
// The two wipes OVERLAP the boundaries rather than adding to them: the Opening's cream surface
// leaves over the montage's first half second, and the Finish's disc grows over its last, so the
// film lasts exactly opening + montage + finish and the montage's own timing never changes.

export type Timeline = {
  /** Montage seconds at which each chapter takes over (0 = the first montage frame). */
  chapterStarts: number[];
  montageSeconds: number;
  totalSeconds: number;
  /** First frame of the montage, and of the Finish. */
  demoStart: number;
  finishStart: number;
  wipeFrames: number;
  durationInFrames: number;
};

export function timelineOf(props: ExplainerProps, fps: number = FPS): Timeline {
  const montageSeconds = totalSeconds(props.segments);
  const total = props.openingSeconds + montageSeconds + props.finishSeconds;
  const demoStart = Math.round(props.openingSeconds * fps);
  const wipeFrames = Math.round(WIPE_SECONDS * fps);
  return {
    chapterStarts: props.chapters.map((chapter) => outTimeOrNext(props.segments, chapter.at)),
    montageSeconds,
    totalSeconds: total,
    demoStart,
    finishStart: demoStart + Math.round(montageSeconds * fps),
    wipeFrames,
    durationInFrames: Math.max(1, Math.round(total * fps)),
  };
}
