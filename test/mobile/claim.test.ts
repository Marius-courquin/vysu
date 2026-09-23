// Claims: what `vysu claim` refuses, and the pool lock around a claim's check and write.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

const CLI = pathToFileURL(join(import.meta.dirname, '..', '..', 'src', 'cli.ts')).href;

// vysu with process.platform set to another system: host.ts reads it once, when it loads.
function vysuOn(platform: string, args: string[], env: NodeJS.ProcessEnv): { status: number | null; stderr: string } {
  const code = `Object.defineProperty(process, 'platform', { value: ${JSON.stringify(platform)} }); await import(${JSON.stringify(CLI)});`;
  const r = spawnSync(process.execPath, ['--disable-warning=ExperimentalWarning', '--input-type=module', '-e', code, '--', '_', ...args], { env, encoding: 'utf8', timeout: 20000 });
  return { status: r.status, stderr: r.stderr };
}

function project(): { dir: string; env: NodeJS.ProcessEnv } {
  const dir = mkdtempSync(join(tmpdir(), 'vysu-claim-'));
  mkdirSync(join(dir, 'proj', '.vysu'), { recursive: true });
  writeFileSync(join(dir, 'proj', '.vysu', 'config'), 'VYSU_PROJECT=fake\n');
  return {
    dir,
    env: { HOME: join(dir, 'home'), PATH: process.env.PATH, VYSU_STATE: join(dir, 'state'), VYSU_OWNER: 'test-owner', VYSU_PROJECT_DIR: join(dir, 'proj'), VYSU_LOCK_WAIT: '5' },
  };
}

test('claim ios --any away from a Mac says so at once, instead of waiting on an empty pool', () => {
  const { env } = project();
  const t0 = Date.now();
  const r = vysuOn('linux', ['claim', 'ios', '--any'], env);
  assert.equal(r.status, 1, r.stderr);
  assert.match(r.stderr, /iOS simulators need macOS and Xcode, and this machine runs linux/);
  assert.ok(Date.now() - t0 < 4000, 'waited on the pool');
});
