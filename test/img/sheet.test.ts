import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { sheet } from '../../src/img/sheet.ts';
import { writeImage } from '../../src/img/raster.ts';

async function capture(path: string, seed: number): Promise<void> {
  const data = new Uint8Array(120 * 200 * 3);
  for (let i = 0; i < data.length; i++) data[i] = (i * seed * 2654435761) >>> 24;
  await writeImage({ data, width: 120, height: 200, channels: 3 }, path);
}

async function stderrOf<T>(fn: () => Promise<T>): Promise<[T | Error, string]> {
  const said: string[] = [];
  const write = process.stderr.write.bind(process.stderr);
  process.stderr.write = ((s: string) => (said.push(String(s)), true)) as typeof process.stderr.write;
  try {
    return [await fn().catch((e: Error) => e), said.join('')];
  } finally {
    process.stderr.write = write;
  }
}

test('an empty or cut capture is left out of the sheet with one line each', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'vysu-sheet-'));
  await capture(join(dir, 'ios-a.png'), 3);
  await capture(join(dir, 'ios-b.png'), 5);
  writeFileSync(join(dir, 'ios-empty.png'), '');
  await capture(join(dir, 'ios-cut.png'), 7);
  const whole = readFileSync(join(dir, 'ios-cut.png'));
  writeFileSync(join(dir, 'ios-cut.png'), whole.subarray(0, whole.length >> 1));
  for (const strip of [false, true]) {
    const [out, err] = await stderrOf(() => sheet(dir, { name: 'x', strip }));
    assert.ok(Array.isArray(out), String(out));
    assert.equal(err.split('\n').filter(Boolean).length, 2);
    assert.match(err, /^vysu: sheet: ios-empty\.png left out, unreadable \(.+\)$/m);
    assert.match(err, /^vysu: sheet: ios-cut\.png left out, unreadable \(.+\)$/m);
    for (const f of out as string[]) assert.ok(existsSync(f));
  }
  assert.doesNotMatch(readFileSync(join(dir, 'index.html'), 'utf8'), /ios-(empty|cut)/);

  const none = mkdtempSync(join(tmpdir(), 'vysu-sheet-'));
  writeFileSync(join(none, 'ios-empty.png'), '');
  const [e] = await stderrOf(() => sheet(none, { name: 'x' }));
  assert.match(String(e), /no readable capture in /);
});
