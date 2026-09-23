// The mobile commands against a fake adb (fake-adb.ts): what they do to a device, and when they stop
// doing it, with no device at all.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { fakeAndroid } from './fake-adb.ts';

const posix = { skip: process.platform === 'win32' ? 'the fake adb is a shell script' : false };
const screencaps = (calls: string[]): number => calls.filter((l) => l.includes('screencap')).length;

test('mburst: a step that dies stops the capture loop before vysu gives the device back', posix, async () => {
  const f = fakeAndroid();
  writeFileSync(join(f.state, 'scale-android-fake-avd'), '2.625');
  const r = await f.vysu(['mburst', 'android', 'b1', '--seconds', '1', '--every', '0.2', '--', 'tap t:common.close'], 30000);
  assert.equal(r.code, 1, r.stderr);
  assert.match(r.stderr, /VYSU_LOCALES/);
  // The loop's own deadline is --seconds + 60: a vysu still alive after a few seconds kept capturing.
  assert.ok(r.ms < 10000, `vysu took ${r.ms} ms to end`);
  const n = screencaps(f.calls());
  await sleep(800);
  assert.equal(screencaps(f.calls()), n, 'a capture after vysu ended');
});
