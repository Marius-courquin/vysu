import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const cli = join(import.meta.dirname, '..', '..', 'src', 'cli.ts');

// The prompt resolved at the first newline of a chunk and dropped the rest: both answers piped at once
// left the password question waiting on a stdin already read, and the command ended 0 writing nothing.
test('persona add reads both answers from a pipe, and a closed stdin is an empty answer', () => {
  const dir = mkdtempSync(join(tmpdir(), 'vysu-persona-'));
  mkdirSync(join(dir, '.vysu'));
  writeFileSync(join(dir, '.vysu', 'config'), "VYSU_PROJECT='p'\n");
  const env = { ...process.env, VYSU_STATE: join(dir, 'state'), VYSU_SHOTS: join(dir, 'shots'), VYSU_NO_COLOR: '1' };
  const add = (name: string, input: string) => spawnSync(process.execPath, [cli, 'persona', 'add', name], { cwd: dir, env, input, encoding: 'utf8' });

  let r = add('alice', 'a@b.c\nhunter2\n');
  assert.equal(r.status, 0, r.stderr);
  r = add('bob', 'x@y.z\r\nno newline');
  assert.equal(r.status, 0, r.stderr);
  assert.equal(
    readFileSync(join(dir, 'state', 'personas.env'), 'utf8'),
    "VYSU_PERSONA_ALICE_EMAIL='a@b.c'\nVYSU_PERSONA_ALICE_PASSWORD='hunter2'\nVYSU_PERSONA_BOB_EMAIL='x@y.z'\nVYSU_PERSONA_BOB_PASSWORD='no newline'\n",
  );
  r = add('carol', '');
  assert.equal(r.status, 1);
  assert.match(r.stderr, /persona add: no e-mail/);
  r = add('dan', 'd@e.f\n');
  assert.equal(r.status, 1);
  assert.match(r.stderr, /persona add: no password/);
});
