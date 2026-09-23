import { test } from 'node:test';
import assert from 'node:assert/strict';
import { resizeAsync } from '../../src/img/pool.ts';
import { resize } from '../../src/img/resample.ts';
import type { Raster } from '../../src/img/raster.ts';

// The file ending at all is half the test: a worker left holding the process kept it running.
test('a worker that dies takes only its own jobs, and the pool goes on', { timeout: 20000 }, async () => {
  const data = new Uint8Array(30 * 30 * 3);
  for (let i = 0; i < data.length; i++) data[i] = (i * 7) % 256;
  const img: Raster = { data, width: 30, height: 30, channels: 3 };
  const want = Buffer.from(resize(img, 10, 10).data);
  const [ok, bad] = await Promise.allSettled([resizeAsync(img, 10, 10), resizeAsync(img, -1, 10)]);
  assert.equal(ok.status, 'fulfilled');
  assert.ok(want.equals((ok as PromiseFulfilledResult<Raster>).value.data));
  assert.equal(bad.status, 'rejected');
  for (let i = 0; i < 6; i++) assert.ok(want.equals((await resizeAsync(img, 10, 10)).data));
});
