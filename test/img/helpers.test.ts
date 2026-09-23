import { test } from 'node:test';
import assert from 'node:assert/strict';
import { float, pyJson, pyJsonParse, shlexSplit } from '../../src/img/fmt.ts';
import { parseSnapshot, screenField, screenHas, screenLine, screenSig } from '../../src/img/screen.ts';
import { isoMillis, parseStep } from '../../src/img/take.ts';
import { parseDiffText } from '../../src/img/verdict.ts';
import { bands, offsetBetween } from '../../src/img/stitch.ts';
import { detect, geometry, rgba } from '../../src/img/frame.ts';
import { changed } from '../../src/img/burst.ts';
import type { Raster } from '../../src/img/raster.ts';

test('shlex and a Python-faithful JSON round trip', () => {
  assert.deepEqual(shlexSplit(`tap "Se connecter" 'a b'c d\\ e ""`), ['tap', 'Se connecter', 'a bc', 'd e', '']);
  assert.throws(() => shlexSplit('tap "open'));
  const text = '{\n "fps": 30.0,\n "n": 3,\n "r": [\n  1.5e-05,\n  -0.0\n ]\n}';
  assert.equal(pyJson(pyJsonParse(text), { indent: 1 }), text);
  assert.equal(pyJson({ a: float(2), b: 2 }), '{"a": 2.0, "b": 2}');
});

const snap = (nodes: object[], data: object = {}): ReturnType<typeof parseSnapshot> => parseSnapshot(JSON.stringify({ data: { nodes, ...data } }));
const app = { type: 'Application', depth: 0, index: 0, label: 'App', rect: { x: 0, y: 0, width: 400, height: 800 } };

test('the screen line: reading order, icons and initials out, keyboard, focus', () => {
  const s = snap([
    app,
    { type: 'StaticText', depth: 1, index: 1, parentIndex: 0, label: 'Deuxième', rect: { x: 10, y: 300, width: 200, height: 20 } },
    { type: 'StaticText', depth: 1, index: 2, parentIndex: 0, label: 'Premier', rect: { x: 10, y: 100, width: 200, height: 20 } },
    { type: 'Button', depth: 1, index: 3, parentIndex: 0, label: 'Fermer', rect: { x: 360, y: 20, width: 30, height: 30 } },
    { type: 'StaticText', depth: 1, index: 4, parentIndex: 0, label: 'SH', rect: { x: 10, y: 20, width: 30, height: 30 } },
    { type: 'TextField', depth: 1, index: 5, parentIndex: 0, label: 'E-mail', focused: true, rect: { x: 10, y: 400, width: 380, height: 44 } },
    { type: 'Keyboard', depth: 1, index: 6, parentIndex: 0, rect: { x: 0, y: 500, width: 400, height: 300 } },
  ]);
  assert.deepEqual(screenLine(snap([])), { line: 'screen: (no label) (0 nodes)', code: 0 });
  assert.equal(screenLine(s).line, 'screen: Premier · Deuxième · E-mail (5 nodes, keyboard, focus "E-mail")');
  assert.equal(screenLine(parseSnapshot('')).code, 2);
  assert.equal(screenHas(s, 'premi'), 0);
  assert.equal(screenHas(s, 'absent'), 1);
  assert.equal(screenField(s, 'e-mail').out, '200 422');
  assert.equal(screenSig(s, true), 'Deuxième@10,300\x1fE-mail@10,400\x1fFermer@360,20\x1fPremier@10,100\x1fSH@10,20');
});

test('take reads a flow line the way the toolkit names it', () => {
  assert.deepEqual(parseStep('press 173 822', 'mobile', 'ios', ''), { verb: 'tap', label: '', extra: {} });
  assert.deepEqual(parseStep('press Enter', 'web', 'web', ''), { verb: 'key', label: 'Enter', extra: {} });
  assert.deepEqual(parseStep('shot home', 'mobile', 'android', ''), { verb: 'shot', label: 'home', extra: { file: 'android-home.png' } });
  assert.deepEqual(parseStep('tap "Se connecter"', 'mobile', 'ios', 'Connexion'), { verb: 'tap', label: 'Connexion', extra: {} });
  assert.match(isoMillis(1758480131.4129), /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.412[+-]\d\d:\d\d$/);
});

test('verdict reads diff back', () => {
  const d = parseDiffText('size mismatch: baseline 393x852, current 393x900 — compared on 393x852\nchanged 1.2 % (400 px) · 2 zones\n1. x 0 y 1 w 2 h 3 px = x 0 y 0 w 1 h 1 pt  (50 % of the zone)\n2. x 9 y 9 w 9 h 9 px\nmarked: /a/b.png\n');
  assert.deepEqual(d, { count: 2, zones: ['0,1 2x3', '9,9 9x9'], marked: '/a/b.png', size: '393x852 → 393x900' });
});

function scroller(offset: number): Raster {
  const w = 40;
  const h = 200;
  const data = new Uint8Array(w * h * 3);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const band = y < 20 || y >= 180;
      const v = band ? 50 : (Number((BigInt((y - 20 + offset) * 131 + x) * 2654435761n) & 0xffffffffn) >>> 13) % 256;
      data.fill(v, (y * w + x) * 3, (y * w + x) * 3 + 3);
    }
  }
  return { data, width: w, height: h, channels: 3 };
}

test('stitch finds the fixed bands and the scroll offset', () => {
  const a = scroller(0);
  const b = scroller(48);
  assert.deepEqual(bands([a, b]), [20, 20]);
  const luma = (f: Raster): { rows: number; width: number; v: Float64Array } => {
    const v = new Float64Array(160 * 40);
    for (let i = 0; i < v.length; i++) v[i] = f.data[(20 * 40 + i) * 3]!;
    return { rows: 160, width: 40, v };
  };
  const [offset, score, ambiguous] = offsetBetween(luma(a) as never, luma(b) as never);
  assert.equal(offset, 48);
  assert.equal(score, 0);
  assert.equal(ambiguous, false);
});

test('frame reads a capture shape', () => {
  assert.equal(detect(402, 874), 'phone');
  assert.equal(detect(375, 667), 'phone-home');
  assert.equal(detect(1206, 2000), 'phone-home');
  assert.equal(detect(1640, 2360), 'tablet');
  assert.equal(detect(1440, 900), 'browser');
  assert.equal(detect(300, 200), 'none');
  assert.deepEqual(geometry('phone', 402).margins, [14, 14, 14, 14]);
  assert.deepEqual(rgba('#abc'), [170, 187, 204, 255]);
  assert.throws(() => rgba('#12'));
});

test('burst leaves the status band out', () => {
  const a: Raster = { data: new Uint8Array(100 * 200 * 3).fill(200), width: 100, height: 200, channels: 3 };
  const b: Raster = { ...a, data: a.data.slice() };
  for (let y = 0; y < 30; y++) b.data.fill(0, y * 300, y * 300 + 300);
  assert.deepEqual(changed(a, b, 0.1, 64, 44), [false, 0]);
  assert.equal(changed(a, b, 0.1, 64, 0)[0], true);
});
