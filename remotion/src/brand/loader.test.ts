import assert from 'node:assert/strict';
import test from 'node:test';
import { STRANDS } from './loader-geometry.ts';
import { MARK_IN_LOCKUP, WORD_PATHS } from './lockup.ts';
import { paletteFromColors } from './palette.ts';
import {
  chimneyAt,
  fillAt,
  fillFrontAt,
  houseScaleAt,
  seedScaleAt,
  strandAt,
} from './loader-timeline.ts';

// The Opening lands ON the finished mark: if any of these drifts, the film ends its weave on
// something that is not the logo.
test('the weave is finished at t = 1', () => {
  assert.equal(strandAt(1, 0), 1, 'the first strand is fully grown');
  assert.equal(strandAt(1, 1), 1, 'and so is the last');
  assert.equal(fillAt(1), 1, 'the exact silhouette has closed over the construction');
  assert.equal(fillFrontAt(1), 1);
  assert.equal(seedScaleAt(1), 1);
  assert.ok(Math.abs(houseScaleAt(1) - 1) < 1e-9, 'the breath ends where it started');
  const chimney = chimneyAt(1);
  assert.equal(chimney.stem, 1);
  assert.equal(chimney.dot.opacity, 1, 'the accent dot is out and visible');
  assert.equal(chimney.dot.scale, 1);
  assert.ok(Math.abs(chimney.dot.ty) < 1e-9, 'and it has settled at rest');
});

test('nothing is drawn at t = 0', () => {
  assert.equal(strandAt(0, 0), 0);
  assert.equal(fillAt(0), 0);
  assert.equal(seedScaleAt(0), 0);
  assert.equal(chimneyAt(0).stem, 0);
  assert.equal(chimneyAt(0).dot.opacity, 0, 'the dot is hidden inside the chimney');
});

test('the strands fire in order', () => {
  const mid = 0.3;
  assert.ok(strandAt(mid, 0) > strandAt(mid, 1), 'the first strand leads the last');
  assert.equal(STRANDS.length, 7, 'the nest is one path of 7 subpaths');
});

test('the lockup is the mark plus the word', () => {
  assert.equal(WORD_PATHS.length, 5, 'four glyphs plus the accent dot of the wordmark');
  assert.ok(Math.abs(MARK_IN_LOCKUP.x + 36.209) < 1e-6);
  assert.ok(Math.abs(MARK_IN_LOCKUP.y + 37.0986) < 1e-3);
});

test('the palette is derived from the theme, not from literals', () => {
  const palette = paletteFromColors('#488EDB', '#FA811E');
  // The same ramp the product ships in its own reference lockup SVG.
  assert.deepEqual(palette.gradients[0], ['#70A7E3', '#2876CC']);
  assert.equal(palette.bodySolid, '#488EDB');
  assert.equal(palette.accent, '#FA811E');
});
