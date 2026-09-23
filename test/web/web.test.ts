import { test } from 'node:test';
import assert from 'node:assert/strict';
import { chmodSync, mkdirSync, mkdtempSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { abCandidates, abRaw, bboxes, evalValue, lastLine, lastResult, quiet } from '../../src/web/ab.ts';
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

// npm on Windows: the shim in the prefix, the binaries in the package's bin folder, and no arm64 build
// published — the x64 one runs under emulation there.
test('where the native agent-browser is looked for', () => {
  const shim = 'C:\\Users\\me\\AppData\\Roaming\\npm\\agent-browser.cmd';
  const bin = 'C:\\Users\\me\\AppData\\Roaming\\npm\\node_modules\\agent-browser\\bin';
  assert.deepEqual(abCandidates(shim, shim, 'agent-browser-win32-x64.exe', true), [
    'C:\\Users\\me\\AppData\\Roaming\\npm\\agent-browser-win32-x64.exe',
    `${bin}\\agent-browser-win32-x64.exe`,
  ]);
  assert.deepEqual(abCandidates(shim, shim, 'agent-browser-win32-arm64.exe', true).slice(-2), [
    'C:\\Users\\me\\AppData\\Roaming\\npm\\agent-browser-win32-x64.exe',
    `${bin}\\agent-browser-win32-x64.exe`,
  ]);
  const js = '/usr/local/lib/node_modules/agent-browser/bin/agent-browser.js';
  assert.deepEqual(abCandidates('/usr/local/bin/agent-browser', js, 'agent-browser-darwin-arm64', false), [
    '/usr/local/lib/node_modules/agent-browser/bin/agent-browser-darwin-arm64',
  ]);
  const patched = '/usr/local/lib/node_modules/agent-browser/bin/agent-browser-linux-x64';
  assert.equal(abCandidates('/usr/local/bin/agent-browser', patched, 'agent-browser-linux-x64', false)[0], patched);
});

// An agent-browser that exits before reading its batch (a bad option, a crash) closed the pipe under
// a large write, and the EPIPE took vysu down with a stack trace instead of its exit code.
test('a batch agent-browser never read ends with its code, not with EPIPE', { skip: process.platform === 'win32' }, async () => {
  const dir = mkdtempSync(join(tmpdir(), 'vysu-epipe-'));
  writeFileSync(join(dir, 'agent-browser'), '#!/bin/sh\nexit 3\n');
  chmodSync(join(dir, 'agent-browser'), 0o755);
  process.env.PATH = `${dir}:${process.env.PATH}`;
  const { Config } = await import('../../src/core/config.ts');
  const { setConfig } = await import('../../src/core/ctx.ts');
  setConfig(Config.load({ ...process.env, VYSU_STATE: join(dir, 'state') }, dir));
  const r = await abRaw(['batch', '--json'], { input: 'x'.repeat(8 * 1024 * 1024), stderr: 'capture' });
  assert.equal(r.code, 3);
});
