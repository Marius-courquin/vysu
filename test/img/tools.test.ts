import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { tool } from '../../src/img/tools.ts';
import { writeImage } from '../../src/img/raster.ts';

test('a diff that fails midway exits 2, never « zones found »', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'vysu-tools-'));
  const a = join(dir, 'a.png');
  const b = join(dir, 'b.png');
  const data = new Uint8Array(40 * 40 * 3).fill(255);
  await writeImage({ data, width: 40, height: 40, channels: 3 }, a);
  data.fill(0, 0, 20 * 40 * 3);
  await writeImage({ data, width: 40, height: 40, channels: 3 }, b);
  assert.equal((await tool('diff', [a, b])).code, 1);
  const r = await tool('diff', [a, b, '--mark', join(dir, 'no', 'such', 'x-changed.png')]);
  assert.equal(r.code, 2);
  assert.equal(r.stdout, '');
  assert.match(r.stderr, /^diff: /);
});
