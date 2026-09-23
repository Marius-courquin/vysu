import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { bboxes, evalValue, lastLine, lastResult, quiet } from '../../src/web/ab.ts';
import { chromeJs, ignoreJs, pyJsonList, pyJsonString } from '../../src/web/js.ts';
import { shellWords, StepSyntax } from '../../src/web/words.ts';
import { wh } from '../../src/web/shots.ts';
import { pruneable } from '../../src/cmd/prune.ts';
import { commaList } from '../../src/core/text.ts';

const vars: Record<string, string> = { VYSU_X: 'x value', EMPTY: '' };
const words = (s: string): string[] => shellWords(s, (n) => vars[n] ?? '');

test('a step is cut into words the way eval cut it', () => {
  assert.deepEqual(words('"Se connecter"'), ['Se connecter']);
  assert.deepEqual(words(`"Retour à l'accueil"`), ["Retour à l'accueil"]);
  assert.deepEqual(words(`'E-mail' "a \\"b\\" \\$c"`), ['E-mail', 'a "b" $c']);
  assert.deepEqual(words('Se connecter'), ['Se', 'connecter']);
  assert.deepEqual(words('get url  # the url'), ['get', 'url']);
  assert.deepEqual(words('eval "a#b"'), ['eval', 'a#b']);
  assert.deepEqual(words('x a\\ b'), ['x', 'a b']);
  assert.deepEqual(words('"$VYSU_X" ${VYSU_X}'), ['x value', 'x', 'value']);
  assert.deepEqual(words('"" "$EMPTY" $EMPTY end'), ['', '', 'end']);
  assert.deepEqual(words('a$ "b$"'), ['a$', 'b$']);
  assert.deepEqual(words("wait --url '**/home'"), ['wait', '--url', '**/home']);
});

test('what only a shell runs is refused', () => {
  for (const s of ['a | b', 'a > f', '$(date)', '`date`', '"open', "'open", 'a; b', '${X:-y}']) {
    assert.throws(() => words(s), StepSyntax, s);
  }
});

test("agent-browser's restore line is the only one dropped", () => {
  assert.equal(quiet('[agent-browser] restore: loaded\n✗ boom\n[agent-browser] save: saved\n'), '✗ boom\n');
  assert.equal(quiet('[agent-browser] restore: missing\n'), '');
  assert.equal(quiet('[agent-browser] launched browser; restore: missing\nlast'), '[agent-browser] launched browser; restore: missing\nlast\n');
  assert.equal(quiet(''), '');
});

test('tail -1 and the value an eval printed', () => {
  assert.equal(lastLine('a\nb\n'), 'b');
  assert.equal(lastLine('a\nb'), 'b');
  assert.equal(lastLine('a\n\n'), '');
  assert.equal(lastLine(''), '');
  assert.equal(evalValue('"https://example.com/"\n'), 'https://example.com/');
  assert.equal(evalValue('"a\\"b"\n'), 'a"b');
  assert.equal(evalValue('2\n'), '2');
  assert.equal(evalValue('null\n'), 'null');
  assert.equal(evalValue('✓ Done\n'), '✓ Done');
});

test('batch results: boxes out, expand and warm to stderr, a failure named', () => {
  const lines: string[] = [];
  const json = JSON.stringify([
    { command: ['wait', '--load', 'networkidle'], success: false, error: 'timeout' },
    { command: ['eval', '/*vysuexpand*/…'], success: true, result: { result: [2, 4876.5] } },
    { command: ['eval', '/*vysuwarm*/…'], success: true, result: { result: 6 } },
    { command: ['eval', '/*vysuwarm*/…'], success: true, result: { result: 0 } },
    { command: ['eval', '/*vysubox*/…'], success: true, result: { result: [[1, 2, 3, 4], [5.7, 6, 7, 8]] } },
    { command: ['eval', '/*vysubox*/…'], success: true, result: { result: [] } },
  ]);
  assert.deepEqual(bboxes(json, (l) => lines.push(l)), ['1,2,3,4 5,6,7,8', '']);
  assert.deepEqual(lines, ['expand: 2 pane(s) unfolded, document 4876 px', 'warm: 6 scroll step(s)', 'warm: skipped, the page fits the viewport']);
  assert.throws(() => bboxes(JSON.stringify([{ command: ['open', 'x'], success: false, error: 'net::ERR' }])), /« open x » failed: net::ERR/);
  assert.throws(() => bboxes(JSON.stringify([{ command: ['click', 'x'], success: false }])), /« click x » failed: None/);
  assert.throws(() => bboxes('not json'), /agent-browser batch returned nothing/);
  assert.deepEqual(bboxes(''), []);
  assert.equal(lastResult(JSON.stringify([{ result: {} }, { result: { result: 'fr' } }])), 'fr');
  assert.equal(lastResult(JSON.stringify([{ result: null }])), '');
  assert.equal(lastResult(''), '');
});

test('the JS and the lists keep their bytes', () => {
  assert.equal(pyJsonList(['light', 'dark']), '["light", "dark"]');
  assert.equal(pyJsonString('é"'), '"\\u00e9\\""');
  assert.ok(chromeJs(true).includes("s.textContent = '*,*::before"));
  assert.ok(!chromeJs(false).includes("createElement('style')"));
  assert.ok(ignoreJs(['h1', '.b'], true).startsWith('/*vysubox*/["h1", ".b"].flatMap'));
  assert.ok(ignoreJs(['h1'], true).includes('o = [Math.round(scrollX), Math.round(scrollY)]'));
  assert.ok(ignoreJs(['h1'], false).includes('o = [0, 0]'));
});

test('a size is split the way ${size%x*} / ${size#*x} did', () => {
  assert.deepEqual(wh('1440x900'), ['1440', '900']);
  assert.deepEqual(wh('800'), ['800', '800']);
});

test('comma lists as a human wrote them', () => {
  assert.deepEqual(commaList("Se connecter,Sign in"), ['Se connecter', 'Sign in']);
  assert.deepEqual(commaList("Entrer directement,Retour à l'accueil,"), ['Entrer directement', "Retour à l'accueil"]);
});

test('prune: one level deep, old and named, never a file', () => {
  const root = mkdtempSync(join(tmpdir(), 'vysu-prune-'));
  const now = Date.now();
  const make = (name: string, days: number): void => {
    mkdirSync(join(root, name));
    const t = (now - days * 86_400_000) / 1000;
    utimesSync(join(root, name), t, t);
  };
  make('rv-old', 40);
  make('rv-new', 1);
  make('tv-x', 31.5);
  make('keep', 45);
  writeFileSync(join(root, 'rv-file'), '');
  const names = (days: string, match: string[]): string[] => pruneable(root, days, match, now).map((p) => p.slice(root.length + 1));
  assert.deepEqual(names('30', []), ['keep', 'rv-old', 'tv-x']);
  assert.deepEqual(names('', ['rv-*']), ['rv-new', 'rv-old']);
  assert.deepEqual(names('30', ['rv-*', 'tv-*']), ['rv-old', 'tv-x']);
  // -mtime +31: 31.5 days is 31 whole days, not more than 31.
  assert.deepEqual(names('31', ['tv-*']), []);
});
