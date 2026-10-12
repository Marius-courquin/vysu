import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { keptBecause, lastTouched } from '../../src/cmd/prune.ts';

const old = (p: string, hours: number): void => {
  const t = new Date(Date.now() - hours * 3_600_000);
  utimesSync(p, t, t);
};

test('a folder touched in the last hours, or written by another live owner, is kept', () => {
  const dir = mkdtempSync(join(tmpdir(), 'vysu-prune-'));
  writeFileSync(join(dir, 'a.png'), '');
  old(join(dir, 'a.png'), 48);
  old(dir, 48);
  assert.ok(Date.now() - lastTouched(dir) > 47 * 3_600_000);
  assert.equal(keptBecause(dir, 'me:1'), '');
  // A capture rewritten in place moves its own mtime, not the folder's.
  writeFileSync(join(dir, 'a.png'), 'x');
  old(dir, 48);
  assert.match(keptBecause(dir, 'me:1'), /^touched \d+ min ago$/);
  old(join(dir, 'a.png'), 48);
  writeFileSync(join(dir, 'meta.json'), JSON.stringify({ owner: 'claude:42' }));
  old(join(dir, 'meta.json'), 48);
  old(dir, 48);
  assert.equal(keptBecause(dir, 'me:1', Date.now(), () => false), 'written by claude:42, still running');
  assert.equal(keptBecause(dir, 'me:1', Date.now(), () => true), '');
  assert.equal(keptBecause(dir, 'claude:42', Date.now(), () => false), '');
});
