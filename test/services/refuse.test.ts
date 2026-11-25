import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { TS_FLAGS } from '../node-ts.ts';

const cli = join(import.meta.dirname, '..', '..', 'src', 'cli.ts');

test('a service the machine refuses is not started, even with something listening on its port, and up all skips it', async () => {
  const home = mkdtempSync(join(tmpdir(), 'vysu-refuse-home-'));
  const dir = mkdtempSync(join(tmpdir(), 'vysu-refuse-'));
  mkdirSync(join(home, '.vysu'));
  mkdirSync(join(dir, '.vysu'));
  // Someone else's server on the shared port: without the refusal, up would call it « already listening ».
  const server = createServer().listen(0, '127.0.0.1');
  await new Promise((r) => server.once('listening', r));
  const port = (server.address() as { port: number }).port;
  writeFileSync(join(home, '.vysu', 'machine.env'), "VYSU_SERVICE_web_REFUSE='shared computer: ws new <branch>'\n");
  writeFileSync(
    join(dir, '.vysu', 'config'),
    `VYSU_PROJECT='p'\nVYSU_SERVICES='web'\nVYSU_SERVICE_web_CMD='exit 1'\nVYSU_SERVICE_web_PORT=${port}\n`,
  );
  const env = { ...process.env, HOME: home, USERPROFILE: home, VYSU_STATE: join(dir, 'state'), VYSU_OWNER: 'test:1' };
  const vysu = (...args: string[]) => spawnSync(process.execPath, [...TS_FLAGS, cli, ...args], { cwd: dir, env, encoding: 'utf8' });
  try {
    const one = vysu('up', 'web');
    assert.equal(one.status, 1);
    assert.match(one.stderr, /vysu up web: not on this machine: shared computer: ws new <branch>/);
    assert.doesNotMatch(one.stdout, /already listening/);
    const all = vysu('up', 'all');
    assert.equal(all.status, 0, all.stderr);
    assert.match(all.stdout, /web: not started here \(shared computer: ws new <branch>\)/);
  } finally {
    server.close();
  }
});
