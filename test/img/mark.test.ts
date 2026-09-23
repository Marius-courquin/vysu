import { test } from 'node:test';
import assert from 'node:assert/strict';
import { hexColor, main, render } from '../../src/img/mark.ts';
import type { Raster } from '../../src/img/raster.ts';

const white = (w: number, h: number): Raster => ({ data: new Uint8Array(w * h * 3).fill(255), width: w, height: h, channels: 3 });

test('a shape off the image or a crop of nothing is an error, not an empty mark', async () => {
  const im = white(100, 80);
  await assert.rejects(render(im, [{ kind: 'box', v: [5000, 5000, 10, 10], label: null }]), /^Error: --box 5000,5000,10,10 draws nothing on the 100x80 image$/);
  await assert.rejects(render(im, [{ kind: 'circle', v: [900, 10, 5], label: 'x' }], { crop: 'auto' }), /--circle 900,10,5 draws nothing/);
  await assert.rejects(render(im, [{ kind: 'box', v: [1, 1, 5, 5], label: null }], { crop: [500, 500, 10, 10] }), /--crop 500,500,10,10 leaves nothing of the 100x80 image/);
  // Grown back onto the image, as Pillow drew it.
  assert.equal((await render(im, [{ kind: 'box', v: [10, 10, -5, -5], label: null }])).width, 100);
  assert.equal((await render(im, [{ kind: 'box', v: [99, 0, 10, 10], label: null }], { crop: 'auto' })).width, 43);
});

test('--color takes what Pillow drew, and says so otherwise', async () => {
  assert.equal(hexColor('e11d48'), '#e11d48');
  assert.equal(hexColor('##ABC'), '#ABC');
  assert.equal(hexColor('11223344'), '#11223344');
  for (const bad of ['zzz', '12345', 'red', '']) assert.equal(hexColor(bad), null);
  const err: string[] = [];
  const code = await main(['in.png', '--out', 'out.png', '--box', '1,1,5,5', '--color', 'zzz'], { out: () => undefined, err: (s) => err.push(s) });
  assert.deepEqual([code, err.join('')], [1, 'mark: --color wants a hex colour (e11d48), got zzz\n']);
});
