// The ceiling of a mobile command: how long each one gets, what it kills when it runs past it (only
// what it waits on, never what it started detached), and that the device's lock goes with it.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { ceilingSeconds, ceilingStepped, doingLine, mobileTimeoutBase, parsePs, strayChildren, streaming } from '../../src/core/ceiling.ts';
import { fakeAndroid } from '../mobile/fake-adb.ts';

test('the ceiling: the base, twice for what boots or logs in, none at 0', () => {
  assert.equal(mobileTimeoutBase(''), 300);
  assert.equal(mobileTimeoutBase('120'), 120);
  assert.equal(mobileTimeoutBase('0'), 0);
  assert.equal(mobileTimeoutBase('soon'), 300);
  assert.equal(ceilingSeconds('mshot', 300), 300);
  assert.equal(ceilingSeconds('up', 300), 600);
  assert.equal(ceilingSeconds('mlogin', 300), 600);
  assert.equal(ceilingSeconds('mshot', 0), 0);
});

test('a step runner is bounded per step, a relaunch step twice; a stream not at all', () => {
  assert.equal(ceilingStepped('mdo'), true);
  assert.equal(ceilingStepped('mshot'), false);
  assert.equal(ceilingSeconds('mdo', 300), 300);
  assert.equal(ceilingSeconds('mflow', 300, true), 600);
  assert.equal(ceilingSeconds('mrec', 0, true), 0);
  assert.equal(streaming(['simctl', 'spawn', 'booted', 'log', 'stream', '--level', 'debug']), true);
  assert.equal(streaming(['simctl', 'io', 'booted', 'recordVideo', 'a.mov']), true);
  assert.equal(streaming(['simctl', 'io', 'booted', 'screenshot', 'a.png']), false);
  assert.equal(streaming(['simctl', 'spawn', 'booted', 'log', 'show']), false);
  assert.equal(streaming(['adb', 'logcat']), true);
  assert.equal(streaming(['adb', 'logcat', '-v', 'time', 'ReactNativeJS:V', '*:S']), true);
  assert.equal(streaming(['adb', 'logcat', '-d']), false);
  assert.equal(streaming(['adb', 'logcat', '-t', '100']), false);
  assert.equal(streaming(['adb', 'shell', 'logcat', '-c']), false);
  assert.equal(streaming(['adb', 'shell', 'pm', 'list', 'packages']), false);
  assert.equal(streaming(['mdo', 'ios', '--', 'wait idle']), false);
});

test('what is killed: the processes below the command in its own group, nothing it detached, nothing beside it', () => {
  const rows = parsePs(
    [
      '  100     1   100 /bin/zsh -c vysu mshot android x | tail -3',
      '  200   100   100 node /Users/me/vysu/src/cli.ts mshot android x',
      '  201   100   100 tail -3',
      '  300   200   100 /opt/sdk/platform-tools/adb -s emulator-5554 exec-out screencap -p',
      '  301   300   100 sleep 30',
      '  400   200   400 /opt/sdk/emulator/emulator -avd pixel',
      '  401   400   400 qemu-system-aarch64 -avd pixel',
      '  500   200   500 node expo start --port 8082',
    ].join('\n'),
  );
  assert.equal(rows.length, 8);
  assert.deepEqual(
    strayChildren(rows, 200).map((r) => r.pid),
    [300, 301],
  );
  assert.deepEqual(strayChildren(rows, 999), []);
  assert.equal(doingLine('', strayChildren(rows, 200)), 'running « adb -s emulator-5554 exec-out screencap -p »');
  assert.equal(doingLine('', parsePs('  9 1 1 node /x/agent-device/bin/agent-device.mjs snapshot -i')), 'running « agent-device.mjs snapshot -i »');
  assert.equal(doingLine('booting « iPhone 17 Pro »', []), 'booting « iPhone 17 Pro »');
  assert.equal(doingLine('', []), 'waiting on the device');
});

test('a command past its ceiling: 124, what it waited on killed, the lock given back', { skip: process.platform === 'win32' }, async () => {
  const marker = '31.25';
  const f = fakeAndroid({ extra: `  *"shell sleepy"*) sleep ${marker};;` });
  writeFileSync(join(f.bin, 'xcrun'), '#!/bin/sh\necho \'{"devices":{}}\'\n', { mode: 0o755 });
  Object.assign(f.env, { VYSU_MOBILE_TIMEOUT: '1' });
  const r = await f.vysu(['adb', 'shell', 'sleepy'], 20000);
  assert.equal(r.code, 124, r.stderr);
  assert.match(r.stderr, /vysu: adb shell sleepy stopped after 1s \(VYSU_MOBILE_TIMEOUT\) while running « adb -s emulator-5598 shell sleepy »/);
  assert.ok(r.ms < 10000, `took ${r.ms} ms`);
  assert.equal(existsSync(join(f.state, 'locks', 'android-fake-avd')), false, 'the lock outlived the command');
  const left = spawnSync('ps', ['-A', '-o', 'args='], { encoding: 'utf8' }).stdout.split('\n').filter((l) => l.includes(`sleep ${marker}`));
  assert.deepEqual(left, []);
  // The use is on record, for the idle reaper.
  assert.match(spawnSync('cat', [join(f.state, 'used', 'android-fake-avd')], { encoding: 'utf8' }).stdout, /^test-owner \d+\n$/);
});

test('a stream has no ceiling: `vysu adb logcat` runs past VYSU_MOBILE_TIMEOUT', { skip: process.platform === 'win32' }, async () => {
  const f = fakeAndroid({ extra: '  *"logcat"*) sleep 2.5; echo streamed;;' });
  writeFileSync(join(f.bin, 'xcrun'), '#!/bin/sh\necho \'{"devices":{}}\'\n', { mode: 0o755 });
  Object.assign(f.env, { VYSU_MOBILE_TIMEOUT: '1' });
  const r = await f.vysu(['adb', 'logcat'], 20000);
  assert.equal(r.code, 0, r.stderr);
  assert.doesNotMatch(r.stderr, /VYSU_MOBILE_TIMEOUT/);
});
