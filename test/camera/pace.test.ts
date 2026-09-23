import { test } from 'node:test';
import assert from 'node:assert/strict';
import { chunks, delays, js, PyRandom, typeCps, typeRun } from '../../src/img/pace.ts';

test('the generator draws what random.Random(<str>) draws', () => {
  const r = new PyRandom('abc');
  assert.equal(r.random(), 0.7720246314157545);
  assert.equal(r.random(), 0.5581691373899791);
  assert.equal(r.uniform(0.65, 1.4), 1.1821494019624166);
  assert.equal(new PyRandom('').random(), 0.9602256525641875);
  assert.equal(new PyRandom('é👋').random(), 0.8050879166185664);
});

test('a delay per code point, drawn from the text itself', () => {
  assert.deepEqual(delays('ok, go', 14), [57, 195, 245, 103, 86, 98]);
  assert.equal(delays('👋!', 14).length, 2);
  assert.deepEqual(delays('same text', 14), delays('same text', 14));
});

test('VYSU_TYPE_CPS and VYSU_TYPE_RUN read as the Python helper read them', () => {
  assert.equal(typeCps(''), 14);
  assert.equal(typeCps('abc'), 14);
  assert.equal(typeCps('0.5'), 1);
  assert.equal(typeCps('100'), 40);
  assert.equal(typeCps('nan'), 1);
  assert.equal(typeCps(' 20 '), 20);
  assert.equal(typeRun(''), 7);
  assert.equal(typeRun('3.5'), 7);
  assert.equal(typeRun('1'), 2);
  assert.equal(typeRun(' 5 '), 5);
});

test('a device types runs of about a word, cut at a space when one is near', () => {
  const lines = (text: string, run?: number): string[] => chunks(text, run).map((c) => `${c.delay}\t${c.pause}\t${c.text}`);
  assert.deepEqual(lines('anticonstitutionnellement', 7), ['0\t0\tanticon', '0\t0\tstituti', '0\t0\tonnelle', '0\t0\tment']);
  assert.deepEqual(lines('Fin… vraiment ? Oui !', 5), ['0\t150\tFin…', '0\t0\t vrai', '0\t150\tment ?', '0\t0\t Oui', '0\t150\t !']);
  assert.deepEqual(lines('hello world', 7), ['0\t0\thello', '0\t0\t world']);
  assert.deepEqual(chunks(''), []);
  assert.equal(chunks('Bonjour, je voudrais signaler une fuite.', 7).map((c) => c.text).join(''), 'Bonjour, je voudrais signaler une fuite.');
});

test('the browser script types into the focused field, the text escaped as json.dumps does', () => {
  const s = js('é!', 14);
  assert.match(s, /^\(async \(\) => \{ const s = Array\.from\("\\u00e9!"\); const d = \[\d+, \d+\]; /);
  assert.match(s, /return 'typed ' \+ s\.length; \}\)\(\)$/);
});
