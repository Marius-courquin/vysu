// Where a label a step did not find is: covered, off the screen, or absent with what reads like it.
// The labels are the misses of real checker sessions (2026-09-23).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { nearWords, parseSnapshot, resemblance, screenNear } from '../../src/img/screen.ts';

const node = (label: string, y: number, extra: Record<string, unknown> = {}) => ({
  type: 'Button',
  label,
  depth: 3,
  rect: { x: 16, y, width: 360, height: 44 },
  ...extra,
});
const snap = (nodes: unknown[]) =>
  parseSnapshot(JSON.stringify({ data: { nodes: [{ type: 'Application', label: 'Nidz', depth: 0, rect: { x: 0, y: 0, width: 402, height: 874 } }, ...nodes] } }));

const incidents = snap([
  node('Récents', 120),
  node('Tuiles déplacées après la tempête', 200),
  node('Nettoyage du local vélos', 300),
  node("Ampoule grillée hall d'entrée", 400),
  node('Ampoule grillée dans le hall B', 800, { presentationHints: ['covered'] }),
  node('Infiltrations dans la cage d’escalier', 1400),
  node('Tableau de bord', 830),
]);

test('a label written from memory reads like the one on screen', () => {
  assert.ok(resemblance('Ampoule grillée dans le hall B', "Ampoule grillée hall d'entrée") >= 0.5);
  assert.ok(resemblance('Ma resi…', 'Ma résidence') >= 0.85);
  assert.ok(resemblance('J\\x27accepte', "J'accepte") >= 0.5);
  assert.equal(resemblance('Publier', 'Publier'), 1);
  assert.ok(resemblance('Publier', 'Tableau de bord') < 0.5);
  assert.equal(resemblance('', 'x'), 0);
});

test('a label on screen under the tab bar is covered, not absent', () => {
  const near = screenNear(incidents, 'Ampoule grillée dans le hall B');
  assert.equal(near?.state, 'covered');
  assert.equal(near?.label, 'Ampoule grillée dans le hall B');
  assert.match(nearWords(near), /is on screen but under a bar or a sheet/);
});

test('a label laid out below the screen is off it', () => {
  const near = screenNear(incidents, 'Infiltrations dans la cage');
  assert.equal(near?.state, 'offscreen');
  assert.match(nearWords(near), /laid out off the screen \(scroll-to it\)/);
});

test('an absent label names what reads like it, best first', () => {
  const near = screenNear(incidents, "Ampoule grillée dans l'entrée");
  assert.equal(near?.state, 'absent');
  assert.equal(near?.closest[0]?.[0], "Ampoule grillée hall d'entrée");
  assert.ok((near?.closest.length ?? 0) <= 3);
  assert.match(nearWords(near), /^closest on screen: « Ampoule grillée hall d'entrée »/);
});

test('nothing alike: the labels the screen holds', () => {
  const near = screenNear(incidents, 'Publier');
  assert.equal(near?.state, 'absent');
  assert.deepEqual(near?.closest, []);
  assert.match(nearWords(near), /^on screen: Récents · Tuiles déplacées après la tempête/);
});

test('a reachable label is in, and an unreadable snapshot says so', () => {
  assert.equal(screenNear(incidents, 'Nettoyage du local')?.state, 'in');
  assert.equal(screenNear(parseSnapshot('not json'), 'x'), null);
  assert.equal(nearWords(null), 'nothing readable on screen');
});

test('a scroll-to hands its own list of what it saw', () => {
  const near = screenNear(incidents, 'Publier');
  assert.equal(nearWords(near, [['Publier une discussion', 0.85]]), 'closest on screen: « Publier une discussion »');
});

test('under a screen line of its own, a miss adds only what that line cannot say', () => {
  assert.equal(nearWords(screenNear(incidents, 'Publier'), undefined, false), '');
  assert.equal(nearWords(null, [], false), '');
  assert.match(nearWords(screenNear(incidents, 'Ampoule grillée dans le hall B'), undefined, false), /under a bar or a sheet/);
});
