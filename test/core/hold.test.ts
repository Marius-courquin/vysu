import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// Two agents starting the same command a few milliseconds apart: the second must wait for the first.
// Before the owner was resolved ahead of the mkdir, the second found a lock with no pid yet, took it
// for a dead one and drove the same session.
test('two contenders a few milliseconds apart never hold one lock together', async () => {
  const helper = join(import.meta.dirname, 'hold-helper.mjs');
  for (let n = 0; n < 6; n++) {
    const state = mkdtempSync(join(tmpdir(), 'vysu-race-'));
    const log = join(state, 'log');
    writeFileSync(log, '');
    const env = { ...process.env, VYSU_STATE: state, VYSU_PROJECT_DIR: state, VYSU_LOCK_WAIT: '10' };
    const run = (tag: string): Promise<unknown> =>
      new Promise((r) => spawn(process.execPath, [helper, tag, log], { env, stdio: 'ignore' }).on('close', r));
    const a = run('a');
    await new Promise((r) => setTimeout(r, 3));
    await Promise.all([a, run('b')]);
    const ev = readFileSync(log, 'utf8').trim().split('\n');
    assert.deepEqual(ev.map((l) => l.split(' ')[1]), ['in', 'out', 'in', 'out'], ev.join(' · '));
  }
});
