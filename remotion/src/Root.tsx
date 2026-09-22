import React from 'react';
import { Composition, type CalculateMetadataFunction } from 'remotion';
import { durationInFrames } from './cut.ts';
import { Explainer } from './Explainer.tsx';
import { defaultTheme } from './theme.ts';
import {
  explainerSchema,
  FINISH_SECONDS,
  FORMAT_SIZES,
  FORMAT_SUFFIX,
  FPS,
  OPENING_SECONDS,
  type ExplainerProps,
} from './schema.ts';

const calculateMetadata: CalculateMetadataFunction<ExplainerProps> = ({ props }) => ({
  ...FORMAT_SIZES[props.format],
  fps: FPS,
  durationInFrames: durationInFrames(props),
  defaultOutName: `${props.name}-${FORMAT_SUFFIX[props.format]}`,
});

// A placeholder take so the Studio opens without a clip on disk; `vysu video` always passes the
// resolved props of a real take.
const defaultProps: ExplainerProps = {
  format: 'landscape',
  lang: 'fr',
  theme: defaultTheme,
  clip: { src: null, width: 1206, height: 2622, fps: 30, logical: { w: 402, h: 874 } },
  segments: [{ from: 0, to: 6 }],
  chapters: [
    { at: 0, kicker: 'Aperçu', title: 'Aucune prise *chargée*', body: 'Rendez une prise avec vysu video.' },
  ],
  taps: [],
  intro: { title: 'Un montage *piloté* par cut.json', subtitle: 'sans prise chargée' },
  outro: {
    title: 'À vous de *l’essayer*.',
    subtitle: 'La suite se passe dans l’application.',
    cta: 'En savoir plus',
    caption: '',
  },
  music: null,
  openingSeconds: OPENING_SECONDS,
  finishSeconds: FINISH_SECONDS,
  name: 'placeholder',
};

export const Root: React.FC = () => (
  <Composition
    id="Explainer"
    component={Explainer}
    schema={explainerSchema}
    defaultProps={defaultProps}
    calculateMetadata={calculateMetadata}
    fps={FPS}
    durationInFrames={durationInFrames(defaultProps)}
    width={FORMAT_SIZES.landscape.width}
    height={FORMAT_SIZES.landscape.height}
  />
);
