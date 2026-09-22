// The logo's colour ramps, derived exactly as the app derives them (the product UI package's own
// `paletteFromColors`): one light->dark
// body gradient per geometry gradient, the wordmark in the body colour, the dots in the accent.
// Only the `blue` palette exists here, and its two source colours come from the THEME, not from a
// literal — the video has no colour of its own.
import { darken, lighten } from './color.ts';
import type { LogoGradient } from './logo-paths.ts';

export type Palette = {
  // One ramp per gradient, in geometry order (paint0 = body, paint1 = dark element, paint2 = flat
  // light); each ramp's colours align positionally with that gradient's stops.
  gradients: string[][];
  bodySolid: string;
  accent: string;
};

export function paletteFromColors(body: string, accent: string): Palette {
  return {
    gradients: [
      [lighten(body, 0.22), darken(body, 0.16)],
      [darken(body, 0.26), darken(body, 0.4)],
      [lighten(body, 0.22), lighten(body, 0.22)],
    ],
    bodySolid: body,
    accent,
  };
}

export function gradientStops(palette: Palette, gradient: LogoGradient, index: number) {
  const ramp = palette.gradients[index];
  return gradient.stops.map((stop, i) => ({
    offset: stop.offset,
    color: ramp?.[i] ?? stop.color,
  }));
}
