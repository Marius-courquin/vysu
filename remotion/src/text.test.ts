import assert from 'node:assert/strict';
import test from 'node:test';
import { parseAccent, plainTitle } from './text.ts';

test('a title without markup is one plain segment', () => {
  assert.deepEqual(parseAccent('La catégorie'), [{ text: 'La catégorie', accent: false }]);
});

test('the accented phrase is split out, keeping what surrounds it', () => {
  assert.deepEqual(parseAccent('Signaler *en une minute*'), [
    { text: 'Signaler ', accent: false },
    { text: 'en une minute', accent: true },
  ]);
  assert.deepEqual(parseAccent('*Tout* le reste'), [
    { text: 'Tout', accent: true },
    { text: ' le reste', accent: false },
  ]);
  assert.deepEqual(parseAccent('Votre résidence, gérée *simplement*.'), [
    { text: 'Votre résidence, gérée ', accent: false },
    { text: 'simplement', accent: true },
    { text: '.', accent: false },
  ]);
});

test('only the first pair is markup, a stray asterisk stays a character', () => {
  assert.deepEqual(parseAccent('*un* deux * trois'), [
    { text: 'un', accent: true },
    { text: ' deux * trois', accent: false },
  ]);
  assert.deepEqual(parseAccent('rien * ici'), [{ text: 'rien * ici', accent: false }]);
});

test('the plain title is what gets measured', () => {
  assert.equal(plainTitle('Signaler *en une minute*'), 'Signaler en une minute');
});
