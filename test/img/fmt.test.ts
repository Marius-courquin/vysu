import { test } from 'node:test';
import assert from 'node:assert/strict';
import { byCodePoint, float, pyFixed, pyFloat, pyG, pyJson, pyPath, pyRepr, pyRoundTo, pySigned, pySplit, pySplitlines, stripChars } from '../../src/img/fmt.ts';

test('f-string rounding is half to even on a true tie only', () => {
  assert.equal(pyFixed(0.25, 1), '0.2');
  assert.equal(pyFixed(0.35, 1), '0.3'); // 0.34999… in binary
  assert.equal(pyFixed(0.75, 1), '0.8');
  assert.equal(pyFixed(2.5, 0), '2');
  assert.equal(pyFixed(3.5, 0), '4');
  assert.equal(pyFixed(12.25, 1), '12.2');
  assert.equal(pyFixed(-0.4, 0), '-0');
  assert.equal(pyFixed(1 / 3, 3), '0.333');
  assert.equal(pySigned(0.4, 0), '+0');
  assert.equal(pySigned(-12.6, 0), '-13');
  assert.equal(pyRoundTo(2.675, 2), 2.67);
  assert.equal(pyRoundTo(0.125, 2), 0.12);
});

test('float repr and %g', () => {
  assert.equal(pyRepr(30), '30.0');
  assert.equal(pyRepr(0.1), '0.1');
  assert.equal(pyRepr(1e-5), '1e-05');
  assert.equal(pyRepr(1.5e16), '1.5e+16');
  assert.equal(pyRepr(-0), '-0.0');
  assert.equal(pyRepr(123456.789), '123456.789');
  assert.equal(pyG(30), '30');
  assert.equal(pyG(29.97), '29.97');
  assert.equal(pyG(0.5), '0.5');
  assert.equal(pyG(1234567), '1.23457e+06');
  assert.equal(pyG(0.00001), '1e-05');
});

test('json.dumps spelling', () => {
  assert.equal(pyJson({ a: 1, b: float(2), c: [0.5, 'é'], d: null, e: true }), '{"a": 1, "b": 2.0, "c": [0.5, "\\u00e9"], "d": null, "e": true}');
  assert.equal(pyJson({ a: [], b: {} }, { indent: 1 }), '{\n "a": [],\n "b": {}\n}');
  assert.equal(pyJson({ t: 'é😀"' }, { ascii: false }), '{"t": "é😀\\""}');
  assert.equal(pyJson('😀'), '"\\ud83d\\ude00"');
});

test('python strings', () => {
  assert.deepEqual(pySplit(' a b\x1fc  '), ['a', 'b', 'c']);
  assert.deepEqual(pySplitlines('a\r\nb\rc\n'), ['a', 'b', 'c']);
  assert.equal(stripChars(' ,a, ', ' ,'), 'a');
  assert.equal(pyFloat(' 1_0.5 '), 10.5);
  assert.equal(pyFloat('abc'), null);
  assert.equal(pyFloat('-inf'), -Infinity);
  assert.ok(byCodePoint('\u{1F600}', '！') > 0);
  assert.equal(pyPath('/a//b/./c/'), '/a/b/c');
  assert.equal(pyPath('./x'), 'x');
});
