import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { TS_FLAGS } from '../node-ts.ts';

test('report --md keeps the Markdown beside the captures, or where --out says, and names the file on stderr', () => {
  const dir = mkdtempSync(join(tmpdir(), 'vysu-report-'));
  mkdirSync(join(dir, '.vysu'));
  writeFileSync(join(dir, '.vysu', 'config'), "VYSU_PROJECT='p'\n");
  mkdirSync(join(dir, 'shots', 'home'), { recursive: true });
  writeFileSync(join(dir, 'shots', 'home', 'meta.json'), JSON.stringify({ kind: 'web', persona: 'alice', url: 'http://x/' }));
  const cli = join(import.meta.dirname, '..', '..', 'src', 'cli.ts');
  const env = { ...process.env, VYSU_STATE: join(dir, 'state'), VYSU_SHOTS: join(dir, 'shots'), VYSU_OWNER: 'test:1' };
  const r = spawnSync(process.execPath, [...TS_FLAGS, cli, 'report', 'home', '--md'], { cwd: dir, env, encoding: 'utf8' });
  assert.equal(r.status, 0, r.stderr);
  const file = join(dir, 'shots', 'home', 'report.md');
  assert.equal(readFileSync(file, 'utf8'), r.stdout);
  assert.match(r.stdout, /^```\n/);
  assert.equal(r.stderr, `report: ${file}\n`);
  const out = join(dir, 'r.md');
  const r2 = spawnSync(process.execPath, [...TS_FLAGS, cli, 'report', 'home', '--md', '--out', out], { cwd: dir, env, encoding: 'utf8' });
  assert.equal(r2.status, 0, r2.stderr);
  assert.ok(existsSync(out));
  const plain = spawnSync(process.execPath, [...TS_FLAGS, cli, 'report', 'home'], { cwd: dir, env, encoding: 'utf8' });
  assert.equal(plain.stderr, '');
});
