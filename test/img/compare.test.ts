import { test } from 'node:test';
import assert from 'node:assert/strict';
import { thumbnails } from '../../src/img/compare.ts';

test('cells decode side by side up to the pixel budget, a big one alone', async () => {
  let inFlight = 0;
  let peak = 0;
  const alone: boolean[] = [];
  const job = (px: number, v: number) => ({
    px,
    run: async (): Promise<number> => {
      inFlight += px;
      peak = Math.max(peak, inFlight);
      alone.push(inFlight === px);
      await new Promise((r) => setTimeout(r, 5 + (v % 3)));
      inFlight -= px;
      return v;
    },
  });
  const out = await thumbnails([job(3, 0), job(3, 1), job(3, 2), job(40, 3), job(3, 4), job(40, 5), job(3, 6)], 10);
  assert.deepEqual(out, [0, 1, 2, 3, 4, 5, 6]);
  assert.equal(peak, 40);
  assert.deepEqual([alone[3], alone[5]], [true, true]);
  await assert.rejects(thumbnails([job(3, 0), { px: 3, run: () => Promise.reject(new Error('unreadable')) }], 10), /unreadable/);
});
