import { test } from 'node:test';
import assert from 'node:assert/strict';
import { denoise, diffRasters, diffReport, merge, parseRegion, zonesOf } from '../../src/img/diff.ts';
import { reduce, resize, type Raster } from '../../src/img/raster.ts';
import { parseArgs, type ParserSpec } from '../../src/img/args.ts';

const blank = (w: number, h: number, v = 255): Raster => ({ data: new Uint8Array(w * h * 3).fill(v), width: w, height: h, channels: 3 });
function paint(img: Raster, x0: number, y0: number, x1: number, y1: number, v = 0): void {
  for (let y = y0; y < y1; y++) for (let x = x0; x < x1; x++) img.data.fill(v, (y * img.width + x) * 3, (y * img.width + x) * 3 + 3);
}

test('a lone pixel is noise, a pair is a change', () => {
  const m = new Uint8Array(25);
  m[6] = 1;
  assert.equal(denoise(m, 5, 5).reduce((a, b) => a + b, 0), 0);
  m[12] = 1;
  assert.equal(denoise(m, 5, 5).reduce((a, b) => a + b, 0), 2);
});

test('boxes closer than the pad fuse, until nothing moves', () => {
  assert.deepEqual(merge([[0, 0, 10, 10], [30, 0, 40, 10], [15, 0, 20, 10]], 6), [[0, 0, 20, 10], [30, 0, 40, 10]]);
  assert.deepEqual(merge([[0, 0, 10, 10], [30, 0, 40, 10], [15, 0, 20, 10]], 10), [[0, 0, 40, 10]]);
  assert.deepEqual(merge([[0, 0, 10, 10], [50, 0, 60, 10]], 6), [[0, 0, 10, 10], [50, 0, 60, 10]]);
});

test('zones come biggest first, hugging their pixels', () => {
  const m = new Uint8Array(100 * 100);
  for (let y = 10; y < 20; y++) for (let x = 10; x < 20; x++) m[y * 100 + x] = 1;
  for (let y = 60; y < 90; y++) for (let x = 50; x < 70; x++) m[y * 100 + x] = 1;
  const z = zonesOf(m, 100, 100, 24, 64);
  assert.deepEqual(z.map((q) => [q.x, q.y, q.w, q.h, q.px]), [[50, 60, 20, 30, 600], [10, 10, 10, 10, 100]]);
});

test('the report names the zones and says the size changed', async () => {
  const a = blank(200, 100);
  const b = blank(200, 120);
  paint(b, 20, 20, 60, 40);
  const r = await diffRasters(a, b, {});
  const { text, code } = diffReport(r, 2);
  assert.equal(code, 1);
  assert.equal(
    text,
    'size mismatch: baseline 200x100, current 200x120 — compared on 200x100\nchanged 4.0 % (800 px) · 1 zone\n1. x 20 y 20 w 40 h 20 px = x 10 y 10 w 20 h 10 pt  (100 % of the zone)\n',
  );
  assert.deepEqual(parseRegion('1.9,2,-3,4'), [1, 2, -2, 6]);
  assert.equal(parseRegion('1,2,3'), null);
});

test('reduce averages whole blocks, then the partial ones', () => {
  const img: Raster = { data: new Uint8Array([0, 0, 0, 255, 255, 255, 30, 30, 30, 10, 10, 10, 20, 20, 20, 90, 90, 90]), width: 3, height: 2, channels: 3 };
  const r = reduce(img, 2);
  assert.equal(r.width, 2);
  assert.equal(r.height, 1);
  assert.deepEqual([...r.data], [71, 71, 71, 60, 60, 60]);
  const up = resize(blank(4, 4, 100), 2, 2);
  assert.deepEqual([...up.data], new Array(12).fill(100));
});

test('argparse errors', () => {
  const spec: ParserSpec = { prog: 'x.py', usage: 'usage: x.py a', pos: [{ name: 'a' }, { name: 'rest', nargs: '+' }], opts: { '--num': { kind: 'int' }, '--mark': { kind: 'str' }, '--min': { kind: 'str' } } };
  const err: string[] = [];
  const io = { out: () => undefined, err: (s: string) => err.push(s) };
  assert.equal(parseArgs(spec, ['a', '--num', '3.5'], io), 2);
  assert.match(err.pop()!, /argument --num: invalid int value: '3.5'/);
  assert.equal(parseArgs(spec, ['a', 'b', '--m', 'x'], io), 2);
  assert.match(err.pop()!, /ambiguous option: --m could match --mark, --min/);
  assert.equal(parseArgs(spec, ['a', 'b', '--num', '1', 'c'], io), 2);
  assert.match(err.pop()!, /unrecognized arguments: c/);
  assert.deepEqual(parseArgs(spec, ['--num=4', 'a', 'b', 'c'], io), { num: 4, mark: null, min: null, a: 'a', rest: ['b', 'c'] });
});
