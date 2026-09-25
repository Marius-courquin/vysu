import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { chmodSync, mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { personaRefName, personaSessionSuffix, personaSlot, webResource } from '../../src/core/personas.ts';
import { TS_FLAGS } from '../node-ts.ts';

const cli = join(import.meta.dirname, '..', '..', 'src', 'cli.ts');

test('a persona slot is <persona>@<n>, and @1 is the persona itself', () => {
  assert.deepEqual(personaSlot('alice'), { base: 'alice', slot: 1 });
  assert.deepEqual(personaSlot('tb_x@2'), { base: 'tb_x', slot: 2 });
  assert.deepEqual(personaSlot('alice@1'), { base: 'alice', slot: 1 });
  for (const bad of ['alice@0', 'alice@x', 'alice@', 'a-b@2', '@2', 'alice@100']) assert.throws(() => personaSlot(bad), /session slot/, bad);
  assert.equal(personaRefName('alice', 1), 'alice');
  assert.equal(personaRefName('alice', 3), 'alice@3');
});

// A persona's slug never holds two dashes in a row: `tb_x_2` and `tb_x@2` must not share a lock.
test("a slot's session and lock are its own", () => {
  assert.equal(webResource('alice'), 'web-alice');
  assert.equal(webResource('alice@1'), 'web-alice');
  assert.equal(webResource('tb_x@2'), 'web-tb-x--2');
  assert.notEqual(webResource('tb_x_2'), webResource('tb_x@2'));
  assert.equal(personaSessionSuffix('alice@2'), 'alice--2');
  assert.equal(personaSessionSuffix('alice'), 'alice');
});

// Three sub-agents of one session (one owner) each get a session of their own, and a fourth is told
// who holds what. A slot that never logged in does, one that did is not logged in again.
test('claim <persona> --any hands each caller a different session', { skip: process.platform === 'win32' }, () => {
  const dir = mkdtempSync(join(tmpdir(), 'vysu-slots-'));
  mkdirSync(join(dir, '.vysu'));
  writeFileSync(join(dir, '.vysu', 'config'), "VYSU_PROJECT='p'\nVYSU_ORIGIN='http://o.example'\n");
  const bin = join(dir, 'bin');
  mkdirSync(bin);
  // No browser: the session list is empty, anything else answers nothing.
  writeFileSync(join(bin, 'agent-browser'), '#!/bin/sh\n[ "$1" = session ] && echo "No active sessions"\nexit 0\n');
  chmodSync(join(bin, 'agent-browser'), 0o755);
  const sessions = join(dir, 'home', '.agent-browser', 'sessions');
  mkdirSync(sessions, { recursive: true });
  for (const s of ['p-alice--2', 'p-alice--3']) writeFileSync(join(sessions, `${s}-${s}.json`), '{}');
  const env = {
    ...process.env,
    HOME: join(dir, 'home'),
    PATH: `${bin}:${process.env.PATH}`,
    VYSU_STATE: join(dir, 'state'),
    VYSU_OWNER: 'agent',
    VYSU_WEB_SLOTS: '3',
    VYSU_NO_COLOR: '1',
  };
  const claim = (...extra: string[]) => spawnSync(process.execPath, [...TS_FLAGS, cli, 'claim', 'alice', '--any', ...extra], { cwd: dir, env, encoding: 'utf8' });

  const got: string[] = [];
  for (let i = 0; i < 3; i++) {
    const r = claim();
    assert.equal(r.status, 0, r.stderr);
    got.push(/^name it: every command of this task names (\S+)/m.exec(r.stdout)?.[1] ?? r.stdout);
    if (i === 0) assert.match(r.stderr, /alice holds no login: logging in as alice/);
    else assert.doesNotMatch(r.stderr, /holds no login/);
  }
  assert.deepEqual(got, ['alice', 'alice@2', 'alice@3']);
  const full = claim('--no-wait');
  assert.equal(full.status, 1);
  assert.match(full.stderr, /every alice session is in use[\s\S]*alice@2: claimed by agent/);

  const rel = spawnSync(process.execPath, [...TS_FLAGS, cli, 'release', 'alice@2'], { cwd: dir, env, encoding: 'utf8' });
  assert.match(rel.stdout, /released: web-alice--2/);
  assert.match(claim('--no-wait').stdout, /names alice@2/);
});
