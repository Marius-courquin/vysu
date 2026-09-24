import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { TS_FLAGS } from '../node-ts.ts';

const cli = join(import.meta.dirname, '..', '..', 'src', 'cli.ts');
const alive = (pid: number): boolean => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};

// 0.5.1 exec'ed a project command: a signal to vysu was a signal to the command. Run as a child, it
// was left running with no parent when an agent's timeout stopped vysu.
test('a signal to vysu reaches the project command, and its status is the command\'s', { skip: process.platform === 'win32' }, async () => {
  const dir = mkdtempSync(join(tmpdir(), 'vysu-project-'));
  mkdirSync(join(dir, '.vysu', 'commands'), { recursive: true });
  writeFileSync(join(dir, '.vysu', 'config'), "VYSU_PROJECT='p'\n");
  const pidFile = join(dir, 'pid');
  writeFileSync(
    join(dir, '.vysu', 'commands', 'sleeper.mjs'),
    `import { writeFileSync } from 'node:fs';\nwriteFileSync(${JSON.stringify(pidFile)}, String(process.pid));\nsetTimeout(() => {}, 30000);\n`,
  );
  const env = { ...process.env, VYSU_STATE: join(dir, 'state'), VYSU_SHOTS: join(dir, 'shots') };
  const vysu = spawn(process.execPath, [...TS_FLAGS, cli, 'sleeper'], { cwd: dir, env, stdio: 'ignore' });
  const status = new Promise<number | null>((resolve) => vysu.on('close', (code) => resolve(code)));
  for (let i = 0; i < 100 && !existsSync(pidFile); i++) await new Promise((r) => setTimeout(r, 50));
  const pid = Number(readFileSync(pidFile, 'utf8'));
  assert.ok(alive(pid));
  vysu.kill('SIGTERM');
  assert.equal(await status, 143);
  for (let i = 0; i < 40 && alive(pid); i++) await new Promise((r) => setTimeout(r, 50));
  assert.equal(alive(pid), false);
});
