// A call that never answers: stopped at its ceiling, and the stuck session's daemon stopped with the
// browser under it. Its own file: abRaw finds agent-browser once per process, and this one is fake.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { chmodSync, mkdirSync, mkdtempSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { abRaw, ceilingFor, stopSessionBrowser } from '../../src/web/ab.ts';
import { clickTarget, CLICK_ROLES } from '../../src/web/page.ts';
import { pidAlive } from '../../src/core/host.ts';

test('the ceiling of a call: the base, a batch by its length, a wait by what it asks, none for a recording', () => {
  assert.equal(ceilingFor(['eval', 'new Promise(() => {})'], undefined, 60), 60);
  assert.equal(ceilingFor(['batch', '--json'], JSON.stringify([['open', 'x'], ['wait', '300'], ['screenshot', 'a.png']]), 60), 150);
  assert.equal(ceilingFor(['wait', '--load', 'networkidle', '--timeout', '2500'], undefined, 60), 60);
  assert.equal(ceilingFor(['wait', '120000'], undefined, 60), 150);
  assert.equal(ceilingFor(['record', 'stop'], undefined, 60), 0);
  assert.equal(ceilingFor(['eval', '1'], undefined, 0), 0);
});

test('click: css: and @refs are elements, the rest a label; the controls before the text', () => {
  assert.equal(clickTarget('css:.va-switch input'), '.va-switch input');
  assert.equal(clickTarget('@e12'), '@e12');
  assert.equal(clickTarget('Mode sombre'), '');
  assert.equal(clickTarget('@home'), '');
  assert.deepEqual(CLICK_ROLES.slice(0, 2), ['button', 'link']);
  for (const role of ['switch', 'checkbox', 'radio']) assert.ok(CLICK_ROLES.includes(role));
});

test('a call past its ceiling ends 124, fast', { skip: process.platform === 'win32' }, async () => {
  const dir = mkdtempSync(join(tmpdir(), 'vysu-ceiling-'));
  writeFileSync(join(dir, 'agent-browser'), '#!/bin/sh\nsleep 30\n');
  chmodSync(join(dir, 'agent-browser'), 0o755);
  process.env.PATH = `${dir}:${process.env.PATH}`;
  const { Config } = await import('../../src/core/config.ts');
  const { setConfig } = await import('../../src/core/ctx.ts');
  setConfig(Config.load({ ...process.env, VYSU_STATE: join(dir, 'state') }, dir));
  const t0 = Date.now();
  const r = await abRaw(['eval', 'new Promise(() => {})'], { ceiling: 1, stderr: 'capture' });
  assert.equal(r.code, 124);
  assert.equal(r.timedOut, true);
  assert.ok(Date.now() - t0 < 5000);
});

test("a stuck session: its daemon and what runs under it stopped, anything else's pid left alone", { skip: process.platform === 'win32' }, async () => {
  const home = mkdtempSync(join(tmpdir(), 'vysu-stuck-'));
  mkdirSync(join(home, '.agent-browser'));
  // A daemon is recognised by its name: a shell under that name, with a child of its own.
  symlinkSync('/bin/sh', join(home, 'agent-browser-darwin-arm64'));
  const daemon = spawn(join(home, 'agent-browser-darwin-arm64'), ['-c', 'sleep 60 & wait'], { stdio: 'ignore' });
  const other = spawn('sleep', ['60'], { stdio: 'ignore' });
  await new Promise((r) => setTimeout(r, 300));
  const before = process.env.HOME;
  process.env.HOME = home;
  try {
    writeFileSync(join(home, '.agent-browser', 'p-other.pid'), String(other.pid));
    assert.equal(stopSessionBrowser('p-other'), false);
    assert.equal(stopSessionBrowser('p-none'), false);
    writeFileSync(join(home, '.agent-browser', 'p-alice.pid'), String(daemon.pid));
    assert.equal(stopSessionBrowser('p-alice'), true);
  } finally {
    process.env.HOME = before;
  }
  await new Promise((r) => setTimeout(r, 300));
  assert.equal(pidAlive(daemon.pid!), false);
  assert.equal(pidAlive(other.pid!), true);
  other.kill();
});

test('the other projects holding a saved session of a persona, slots apart', async () => {
  const { savedElsewhere } = await import('../../src/web/ab.ts');
  const dir = mkdtempSync(join(tmpdir(), 'vysu-elsewhere-'));
  for (const s of ['other-proxy', 'default-proxy', 'here-proxy', 'x-proxy--2', 'y-proxyx', 'z-b-proxy']) writeFileSync(join(dir, `${s}-${s}.json`), '{}');
  writeFileSync(join(dir, 'junk.json'), '{}');
  assert.deepEqual(savedElsewhere('proxy', 'here', dir), ['default', 'other', 'z-b']);
  assert.deepEqual(savedElsewhere('proxy@2', 'here', dir), ['x']);
  assert.deepEqual(savedElsewhere('proxy', 'here', join(dir, 'none')), []);
});
