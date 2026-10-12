import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { helpAsked, helpFor } from '../../src/cmd/help.ts';
import { browserAlias } from '../../src/core/aliases.ts';
import { TS_FLAGS } from '../node-ts.ts';

test('a command\'s help is the usage entries that name it, continuation lines included', () => {
  const up = helpFor('up');
  assert.match(up, /^# {3}vysu up <service>/m);
  assert.match(up, /^# {3}vysu up ios\|android --isolated/m);
  assert.match(up, /^# {20,}front of the app/m);
  assert.doesNotMatch(up, /vysu mshot/);
  // `vysu up all | down <service>` documents down, `vysu ios|android` documents android.
  assert.match(helpFor('down'), /\| down <service>/);
  assert.match(helpFor('android'), /^# {3}vysu ios\|android <agent-device args/m);
  assert.doesNotMatch(helpFor('android'), /vysu mtap/);
  assert.match(helpFor('version'), /vysu update \| vysu version/);
  assert.match(helpFor('token'), /vysu auth token/);
  // A walk takes the options of shots.
  assert.match(helpFor('walk'), /--baseline-url/);
  assert.equal(helpFor('no-such-command'), '');
});

test('help is asked anywhere among the arguments, never past --', () => {
  assert.equal(helpAsked(['--help']), true);
  assert.equal(helpAsked(['alice', 'home', '-h']), true);
  assert.equal(helpAsked(['ios', '--', 'tap "--help"', '--help']), false);
  assert.equal(helpAsked(['web']), false);
});

test('`vysu <command> --help` prints that command\'s entry and exits 0, for a service, a persona and an option alike', () => {
  const dir = mkdtempSync(join(tmpdir(), 'vysu-help-'));
  mkdirSync(join(dir, '.vysu'));
  writeFileSync(join(dir, '.vysu', 'config'), "VYSU_PROJECT='p'\nVYSU_SERVICES='web'\n");
  const cli = join(import.meta.dirname, '..', '..', 'src', 'cli.ts');
  const env = { ...process.env, VYSU_STATE: join(dir, 'state'), VYSU_OWNER: 'test:1' };
  for (const [args, want] of [
    [['up', '--help'], /vysu up <service>/],
    [['persona', '--help'], /vysu persona add/],
    [['prune', '--help'], /vysu prune/],
    [['help', 'sheet'], /vysu sheet <name>/],
  ] as const) {
    const r = spawnSync(process.execPath, [...TS_FLAGS, cli, ...args], { cwd: dir, env, encoding: 'utf8' });
    assert.equal(r.status, 0, `${args.join(' ')}: ${r.stderr}`);
    assert.match(r.stdout, want);
    assert.doesNotMatch(r.stdout, /vysu mrec/);
  }
  // A usage error points at the entry.
  const r = spawnSync(process.execPath, [...TS_FLAGS, cli, 'prune', '--bogus'], { cwd: dir, env, encoding: 'utf8' });
  assert.equal(r.status, 1);
  assert.match(r.stderr, /unknown option --bogus\nnext: vysu prune --help/);
});

test('the passthrough reads viewport / resize / go / nav as agent-browser spells them', () => {
  assert.deepEqual(browserAlias(['viewport', '390', '844']), ['set', 'viewport', '390', '844']);
  assert.deepEqual(browserAlias(['resize', '390x844']), ['set', 'viewport', '390', '844']);
  assert.deepEqual(browserAlias(['go', 'http://localhost:8100/']), ['open', 'http://localhost:8100/']);
  assert.deepEqual(browserAlias(['nav', '/x']), ['open', '/x']);
  assert.deepEqual(browserAlias(['open', 'http://a']), ['open', 'http://a']);
  assert.deepEqual(browserAlias(['viewport']), ['viewport']);
});
