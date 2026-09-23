// Step words, numbers and the answers built from them, against the answers every version gave.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { firstSentence, msOf, pyG, secondsOk, shellWords, WordsError } from '../../src/mobile/words.ts';
import { mdoDetail, mdoEcho, mdoReason } from '../../src/mobile/mdo.ts';
import { cropPixels } from '../../src/mobile/rec.ts';
import { androidLocaleOf, iosLocaleOf } from '../../src/mobile/launch.ts';
import { pyFloat } from '../../src/mobile/png.ts';
import { pyRound } from '../../src/core/py.ts';
import { versionBelow } from '../../src/mobile/agent.ts';

test('step words are shlex.split', () => {
  assert.deepEqual(shellWords('"Mot de passe" "pa$$word"'), ['Mot de passe', 'pa$$word']);
  assert.deepEqual(shellWords("it's'"), ['its']);
  assert.deepEqual(shellWords('a "b c" d'), ['a', 'b c', 'd']);
  assert.deepEqual(shellWords('\'a b\' "c\\"d" e\\ f'), ['a b', 'c"d', 'e f']);
  assert.deepEqual(shellWords('x ""'), ['x', '']);
  assert.deepEqual(shellWords('tap "Continuer" --wait "Bienvenue"'), ['tap', 'Continuer', '--wait', 'Bienvenue']);
  assert.deepEqual(shellWords('a\\"b'), ['a"b']);
  assert.deepEqual(shellWords('"a\\\\b" "a\\nb"'), ['a\\b', 'a\\nb']);
  assert.throws(() => shellWords('"unclosed'), (e: unknown) => e instanceof WordsError && e.message === 'No closing quotation');
  assert.throws(() => shellWords('trail\\'), (e: unknown) => e instanceof WordsError && e.message === 'No escaped character');
});

test('%g as Python writes a tapped point', () => {
  const got = [155, 155.5, 0.1, 1234567, 0.00001, 1e-5, 12.345678, 100000, 999999.5, -3.25, 1e21, 0.0001].map(pyG);
  assert.deepEqual(got, ['155', '155.5', '0.1', '1.23457e+06', '1e-05', '1e-05', '12.3457', '100000', '1e+06', '-3.25', '1e+21', '0.0001']);
});

test('seconds a step spells', () => {
  assert.ok(secondsOk('10') && secondsOk('2.5') && secondsOk('.5'));
  assert.ok(!secondsOk('') && !secondsOk('1.2.3') && !secondsOk('-1') && !secondsOk('2s'));
  assert.equal(msOf('2.5'), 2500);
  assert.equal(msOf('0.3333'), 333);
});

test('the first sentence of an agent-device error', () => {
  assert.equal(firstSentence('Selector matched 2 distinct actionable elements: label="X". Use a ref.'), 'Selector matched 2 distinct actionable elements: label="X"');
  assert.equal(firstSentence('find did not match any element'), 'find did not match any element');
  assert.equal(firstSentence('No keyboard; try again (hint)'), 'No keyboard');
  assert.equal(firstSentence('Done.'), 'Done');
  assert.equal(firstSentence('a (b) c.'), 'a');
  assert.equal(firstSentence('x.y z'), 'x.y z');
});

test('what an mdo line says about a step', () => {
  assert.equal(mdoEcho('fill "Mot de passe" "pa$$wörd"'), 'fill "Mot de passe" (8 chars)');
  assert.equal(mdoEcho('fill "unclosed'), 'fill "unclosed');
  assert.equal(mdoEcho('tap "X"'), 'tap "X"');
  assert.equal(mdoReason(['vysu: ios: nothing labelled « Publier » (vysu ios snapshot -i)']), 'nothing labelled « Publier »');
  assert.equal(mdoReason(['vysu: vysu: « shot a » needs --shots <name>', 'next: vysu mdo …']), '« shot a » needs --shots <name>');
  assert.equal(mdoReason([], ['', 'last out line']), 'last out line');
  assert.equal(mdoReason([]), 'failed');
  assert.equal(mdoDetail(['/x/shots/a/ios-home.png']), 'ios-home.png');
  assert.equal(mdoDetail(['Tapped label="A" (1, 2)', '']), 'Tapped label="A" (1, 2)');
});

test('crop, locale and scale spellings', () => {
  assert.equal(cropPixels('0,0,402,200', '3'), '1206:600:0:0');
  assert.equal(cropPixels('10.5,20,100.7,50', '2.625'), '264:131:27:52');
  assert.equal(androidLocaleOf('fr'), 'fr-FR');
  assert.equal(androidLocaleOf('en'), 'en-US');
  assert.equal(androidLocaleOf('pt-BR'), 'pt-BR');
  assert.equal(iosLocaleOf('fr'), 'fr_FR');
  assert.deepEqual([420 / 160, 440 / 160, 480 / 160].map(pyFloat), ['2.625', '2.75', '3.0']);
  assert.deepEqual([1 / 3.0, 1 / 2.625, 1 / 2.75].map((x) => pyFloat(pyRound(x, 4))), ['0.3333', '0.381', '0.3636']);
});

test('agent-device versions against tools.env', () => {
  assert.ok(versionBelow('0.21.5', '0.21.6'));
  assert.ok(!versionBelow('0.21.6', '0.21.6'));
  assert.ok(!versionBelow('0.22.0', '0.21.6'));
  assert.ok(versionBelow('0.9.9', '0.21.0'));
});
