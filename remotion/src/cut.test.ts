import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import {
  cutSchema,
  durationInFrames,
  eventsSchema,
  outTimeOf,
  outTimeOrNext,
  resolveCut,
  resolveRef,
  resolveSegments,
  resolveTaps,
  segmentSeconds,
  totalSeconds,
  type CutFile,
  type EventsFile,
} from './cut.ts';
import { FINISH_SECONDS, OPENING_SECONDS, themeSchema, type Clip, type Segment } from './schema.ts';

// The theme is read from disk rather than imported: `theme.ts` imports the JSON the way the
// bundler does, which node's own loader rejects.
const defaultTheme = themeSchema.parse(
  JSON.parse(
    readFileSync(path.join(import.meta.dirname, '../themes/default/theme.json'), 'utf8'),
  ),
);

const clip: Clip = {
  src: null,
  width: 1206,
  height: 2622,
  fps: 30,
  logical: { w: 402, h: 874 },
};

const close = (actual: number | null, expected: number, message?: string) => {
  assert.ok(actual !== null && Math.abs(actual - expected) < 1e-9, message ?? `${actual} != ${expected}`);
};

const events: EventsFile = eventsSchema.parse({
  version: 1,
  kind: 'mobile',
  platform: 'ios',
  clip: 'ios.mp4',
  fps: 30,
  duration: 20,
  size: { w: 402, h: 874, unit: 'pt' },
  steps: [
    { i: 1, verb: 'tap', label: 'Incident', start: 2, end: 2.5, target: { x: 193, y: 470 } },
    { i: 2, verb: 'sleep', start: 2.5, end: 4 },
    { i: 3, verb: 'shot', label: 'step-1', start: 4, end: 4.5, file: 'ios-step-1.png' },
    { i: 4, verb: 'tap', label: 'Incidents', start: 9, end: 9.4, target: { x: 14, y: 182, w: 212, h: 40 } },
    { i: 5, verb: 'tap', label: 'Before', start: -0.4, end: -0.1, target: { x: 10, y: 20 } },
  ],
});

test('refs resolve to clip seconds', () => {
  assert.equal(resolveRef(12.9, null), 12.9);
  assert.equal(resolveRef('step:1', events), 2);
  assert.equal(resolveRef('step:1.end', events), 2.5);
  assert.equal(resolveRef('shot:step-1', events), 4);
  assert.equal(resolveRef(-3, null), 0, 'instants before the first frame are clamped');
  assert.equal(resolveRef('step:5', events), 0, 'a negative step start is clamped too');
});

test('refs without the data they need fail loudly', () => {
  assert.throws(() => resolveRef('step:1', null), /events\.json/);
  assert.throws(() => resolveRef('shot:missing', events), /no shot labelled/);
  assert.throws(() => resolveRef('frame:12', events), /unknown ref/);
});

test('an empty keep is the whole clip', () => {
  const cut = cutSchema.parse({ version: 1 });
  assert.deepEqual(resolveSegments(cut, null, 48.7), [{ from: 0, to: 48.7 }]);
});

test('keep resolves refs, holds and plain seconds', () => {
  const cut: CutFile = cutSchema.parse({
    version: 1,
    keep: [
      { from: 'step:1', to: 'step:3.end' },
      { hold: 'shot:step-1', seconds: 2.2 },
      { from: 12.9, to: 15 },
    ],
  });
  const segments = resolveSegments(cut, events, 48.7);
  assert.deepEqual(segments, [
    { from: 2, to: 4.5 },
    { freeze: 4, hold: 2.2 },
    { from: 12.9, to: 15 },
  ]);
  close(totalSeconds(segments), 6.8);
  assert.equal(segmentSeconds(segments[1]), 2.2);
});

test('a backwards segment is rejected', () => {
  const cut = cutSchema.parse({ version: 1, keep: [{ from: 10, to: 4 }] });
  assert.throws(() => resolveSegments(cut, null, 48.7), /before it starts/);
});

const segments: Segment[] = [
  { from: 2, to: 4.5 },
  { freeze: 4, hold: 2.2 },
  { from: 12.9, to: 15 },
];

test('outTimeOf maps kept instants and drops cut ones', () => {
  assert.equal(outTimeOf(segments, 2), 0);
  close(outTimeOf(segments, 3), 1);
  assert.equal(outTimeOf(segments, 4.5), null, 'the end of a segment is exclusive');
  assert.equal(outTimeOf(segments, 8), null, 'dead time is cut');
  close(outTimeOf(segments, 12.9), 4.7, 'after the 2.5 s segment and the 2.2 s freeze');
});

test('outTimeOrNext snaps a cut instant to the next kept one', () => {
  assert.equal(outTimeOrNext(segments, 0), 0, 'before the first segment');
  close(outTimeOrNext(segments, 8), 4.7, 'dead time snaps to the next segment');
  close(outTimeOrNext(segments, 100), 6.8, 'past the end is the end');
});

test('ripples come from the tap steps kept by the cut', () => {
  const cut = cutSchema.parse({ version: 1, taps: [{ at: 13.5, x: 201, y: 816 }] });
  const taps = resolveTaps(cut, events, segments);
  assert.deepEqual(taps, [
    { at: 2, x: 193, y: 470 },
    { at: 13.5, x: 201, y: 816 },
  ]);
});

test('a web tap ripples at the centre of its element box', () => {
  const taps = resolveTaps(cutSchema.parse({ version: 1 }), events, [{ from: 8, to: 10 }]);
  assert.deepEqual(taps, [{ at: 9, x: 120, y: 202 }]);
});

test('milestones are no longer part of the contract', () => {
  assert.throws(
    () => cutSchema.parse({ version: 1, milestones: [{ label: 'Catégorie', at: 12.3 }] }),
    /Unrecognized key|unrecognized_keys/,
  );
});

test('the outro fills in its call to action and its caption', () => {
  const cut = cutSchema.parse({
    version: 1,
    intro: { title: 'Signaler un incident *en une minute*', subtitle: 'sans appeler personne' },
    outro: { title: 'À vous de *l’essayer*.', subtitle: 'La suite se passe dans l’application.' },
    music: 'digital-clouds.mp3',
  });
  const props = resolveCut({
    cut,
    events,
    theme: defaultTheme,
    format: 'landscape',
    clip,
    clipDuration: 48.7,
    name: 'take',
  });
  assert.deepEqual(props.outro, {
    title: 'À vous de *l’essayer*.',
    subtitle: 'La suite se passe dans l’application.',
    // A cut that names no call to action takes the theme's own: the default theme says "Learn more".
    cta: defaultTheme.cta,
    caption: '',
  });
  assert.equal(props.music, 'music/digital-clouds.mp3', 'music is resolved under public/music/');
  assert.equal(props.openingSeconds, OPENING_SECONDS);
  assert.equal(props.finishSeconds, FINISH_SECONDS);
});

test('no intro and no outro means no scene and no music', () => {
  const props = resolveCut({
    cut: cutSchema.parse({ version: 1 }),
    events,
    theme: defaultTheme,
    format: 'landscape',
    clip,
    clipDuration: 48.7,
    name: 'take',
  });
  assert.equal(props.openingSeconds, 0);
  assert.equal(props.finishSeconds, 0);
  assert.equal(props.music, null);
});

test('the film is opening + montage + finish', () => {
  assert.equal(
    durationInFrames({ segments, openingSeconds: OPENING_SECONDS, finishSeconds: FINISH_SECONDS }),
    Math.round((OPENING_SECONDS + 6.8 + FINISH_SECONDS) * 30),
  );
});
