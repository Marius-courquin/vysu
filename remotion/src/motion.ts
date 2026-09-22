import { Easing, interpolate } from 'remotion';

// One curve for the whole film: the site's own ease-out. Nothing here overshoots — the product is
// the moving part, the chrome only arrives.
export const EASE = Easing.bezier(0.16, 1, 0.3, 1);

export const ENTRANCE_SECONDS = 0.55;
export const CHANGE_IN_SECONDS = 0.2;
export const CHANGE_OUT_SECONDS = 0.12;
export const STAGGER_SECONDS = 0.07;
export const ENTRANCE_SHIFT = 14;
export const CHANGE_SHIFT = 8;

export type Entrance = { opacity: number; translateY: number };

export function entrance(input: {
  frame: number;
  fps: number;
  delaySeconds?: number;
  durationSeconds: number;
  shift: number;
}): Entrance {
  const { frame, fps, durationSeconds, shift } = input;
  const local = frame - (input.delaySeconds ?? 0) * fps;
  const progress = interpolate(local, [0, durationSeconds * fps], [0, 1], {
    easing: EASE,
    extrapolateLeft: 'clamp',
    extrapolateRight: 'clamp',
  });
  return { opacity: progress, translateY: (1 - progress) * shift };
}

// The launch film's own curve, for anything that happens at the scale of a SCENE: the circle
// wipes, the huge title lines, the closing card. Slower in, slower out than the chrome's ease-out.
export const SCENE_EASE = Easing.bezier(0.65, 0, 0.25, 1);

// 0 before `from`, 1 after `to`: the one shape every scene-level animation is written in.
export function tween(frame: number, from: number, to: number, easing = SCENE_EASE): number {
  return interpolate(frame, [from, to], [0, 1], {
    easing,
    extrapolateLeft: 'clamp',
    extrapolateRight: 'clamp',
  });
}
