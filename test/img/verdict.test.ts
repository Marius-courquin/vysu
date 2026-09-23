import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { recordVerdict } from '../../src/img/verdict.ts';

const verdicts = (dir: string): string[] => Object.keys(JSON.parse(readFileSync(join(dir, 'meta.json'), 'utf8')).verdicts).sort();

test('meta.json is read, changed and written back one writer at a time', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'vysu-verdict-'));
  const lock = join(dir, '.meta.json.lock');
  mkdirSync(lock);
  writeFileSync(join(lock, 'pid'), String(process.pid));
  const waiting = recordVerdict(dir, 'ios-home', { verdict: 'new' });
  await new Promise((r) => setTimeout(r, 60));
  assert.equal(existsSync(join(dir, 'meta.json')), false);
  rmSync(lock, { recursive: true });
  await waiting;
  await Promise.all(['a', 'b', 'c'].map((c) => recordVerdict(dir, `android-${c}`, { verdict: 'new' })));
  assert.deepEqual(verdicts(dir), ['android-a', 'android-b', 'android-c', 'ios-home']);

  // A lock left by a process that is gone is taken over at once.
  const dead = spawnSync(process.execPath, ['-e', '']).pid!;
  mkdirSync(lock);
  writeFileSync(join(lock, 'pid'), String(dead));
  await recordVerdict(dir, 'ios-settings', { verdict: 'new' });
  assert.deepEqual(verdicts(dir), ['android-a', 'android-b', 'android-c', 'ios-home', 'ios-settings']);
  assert.deepEqual(readdirSync(dir), ['meta.json']);
});
