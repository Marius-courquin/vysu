import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { tool } from '../../src/img/tools.ts';
import { writeImage } from '../../src/img/raster.ts';
import { ignoreArgs } from '../../src/web/shots.ts';

test('a box left of the page is blanked, not read as an option', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'vysu-ignore-'));
  const a = join(dir, 'a.png');
  const b = join(dir, 'b.png');
  const data = new Uint8Array(40 * 40 * 3).fill(255);
  await writeImage({ data, width: 40, height: 40, channels: 3 }, a);
  data.fill(0, 0, 20 * 40 * 3);
  await writeImage({ data, width: 40, height: 40, channels: 3 }, b);
  assert.deepEqual(ignoreArgs(' -5,0,60,20 3,4,5,6'), ['--ignore=-5,0,60,20', '--ignore=3,4,5,6']);
  const r = await tool('diff', [a, b, ...ignoreArgs('-5,0,60,20')]);
  assert.equal(r.stderr, '');
  assert.deepEqual([r.code, r.stdout], [0, 'identical\n']);
});
