// The mobile commands against a fake adb (fake-adb.ts): what they do to a device, and when they stop
// doing it, with no device at all.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
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

// A bash connector's primitives are processes of their own: each must find its emulator by itself.
test('__prim mobile_load_bundle android addresses the emulator of the AVD, two being attached', posix, async () => {
  const f = fakeAndroid({ emulators: { 'emulator-5596': 'other_avd', 'emulator-5598': 'fake_avd' } });
  Object.assign(f.env, { VYSU_ANDROID_AVD: 'fake_avd', VYSU_MOBILE_SCHEME: 'myapp', VYSU_MOBILE_KIND: 'expo' });
  const r = await f.vysu(['__prim', 'mobile_load_bundle', 'android']);
  assert.equal(r.code, 0, r.stderr);
  const focus = f.calls().filter((l) => l.includes('dumpsys window'));
  assert.equal(focus.length, 1, f.calls().join('\n'));
  assert.match(focus[0]!, /-s emulator-5598 shell dumpsys window/);
});

test('mobileScale: a density adb does not give is asked again, then a die, never a 0.0 remembered', posix, async () => {
  const f = fakeAndroid({ density: '' });
  const cache = join(f.state, 'scale-android-fake-avd');
  writeFileSync(cache, '0.0');
  const r = await f.vysu(['mshot', 'android', 's1']);
  assert.equal(r.code, 1, r.stderr);
  assert.match(r.stderr, /no screen density/);
  assert.equal(f.calls().filter((l) => l.includes('wm density')).length, 2);
  assert.equal(readFileSync(cache, 'utf8'), '0.0');
  assert.equal(f.calls().filter((l) => l.includes('screencap')).length, 0);
});

// The second device of a matrix is claimed by another agent: the run dies before its steps, and the
// first device, already relaunched in xl text, is put back first.
test('mdo: a die between devices still puts the text size back', posix, async () => {
  const f = fakeAndroid({ emulators: { 'emulator-5596': 'fake_avd', 'emulator-5598': 'other_avd' }, agentDevice: true });
  Object.assign(f.env, { VYSU_MOBILE_BUNDLE: 'com.example', VYSU_MOBILE_KIND: 'native', VYSU_MOBILE_READY_TEXT: 'Home', VYSU_LOCK_WAIT: '1' });
  mkdirSync(join(f.state, 'claims'), { recursive: true });
  const until = Math.floor(Date.now() / 1000) + 600;
  writeFileSync(join(f.state, 'claims', 'android-other-avd'), `owner=shell:${process.pid}\nuntil=${until}\nminutes=10\nnote=\ndevice=other_avd\n`);
  const r = await f.vysu(['mdo', 'android', '--devices', 'fake_avd,other_avd', '--textsize', 'xl', '--', 'sleep 0.1'], 60000);
  assert.equal(r.code, 1, r.stderr);
  assert.match(r.stderr, /android-other-avd claimed by shell:/);
  assert.match(r.stdout, /^restored: fake_avd · textsize normal$/m, r.stdout);
  const scales = f.calls().filter((l) => l.includes('font_scale')).map((l) => l.replace(/.* font_scale /, ''));
  assert.deepEqual(scales, ['1.3', '1.0']);
});

test('mwait: a die inside the wait is said with its next line, not as an internal error', posix, async () => {
  const f = fakeAndroid();
  const r = await f.vysu(['mwait', 'android', 'Home']);
  assert.equal(r.code, 1, r.stderr);
  assert.match(r.stderr, /^vysu: agent-device is not installed\nnext: vysu setup\n$/);
});

// An API 30 image has no `logcat --uid`: the app log goes through vysu's own filter, run from a file
// (a detached process starts from a cmd.exe line on Windows, where `node -e` stopped at a newline).
test('up android, native, API 30: the app log is filtered by uid from a script file', posix, async () => {
  const f = fakeAndroid({
    extra: `  *"getprop sys.boot_completed"*) echo 1;;
  *"pm list packages"*) echo "package:com.example";;
  *"dumpsys package"*) echo "    userId=10166";;
  *"logcat --help"*) echo "Usage: logcat [options]";;
  *"logcat -v time -v uid -T 1"*) printf '01-01 00:00:00.000 I/App( 10166: 2291): from the app\\n01-01 00:00:00.000 I/Sys( 1000: 99): from the system\\n';;`,
  });
  Object.assign(f.env, { VYSU_MOBILE_BUNDLE: 'com.example', VYSU_MOBILE_KIND: 'native' });
  const r = await f.vysu(['up', 'android']);
  assert.equal(r.code, 0, r.stderr);
  assert.match(r.stdout, /app log → /);
  const log = join(f.state, 'logs', 'android-app.log');
  let text = '';
  for (let i = 0; i < 30 && !text.includes('from the app'); i++) {
    await sleep(100);
    text = readFileSync(log, 'utf8');
  }
  assert.equal(text, '01-01 00:00:00.000 I/App( 10166: 2291): from the app\n');
  assert.ok(existsSync(join(f.state, 'applog-uid-filter.cjs')));
});

// `adb shell pm grant <bundle> <name>` reaches the device's shell as one line.
test('mperm android: a name that is not a permission name never reaches adb', posix, async () => {
  const f = fakeAndroid();
  Object.assign(f.env, { VYSU_MOBILE_BUNDLE: 'com.example' });
  const r = await f.vysu(['mperm', 'android', 'CAMERA;reboot', 'grant']);
  assert.equal(r.code, 1, r.stderr);
  assert.match(r.stderr, /« CAMERA;reboot » is not an android permission name/);
  assert.deepEqual(f.calls(), []);
  const ok = await f.vysu(['mperm', 'android', 'android.permission.CAMERA', 'grant']);
  assert.match(ok.stderr, /does not request android\.permission\.CAMERA/);
});

// --force takes another owner's claim over: the relaunch of the reset takes the device's lock, which
// waits on any other owner's claim, the one being released included.
test('release --force --reset of another owner\'s claim resets the device, then releases it', posix, async () => {
  const f = fakeAndroid({ agentDevice: true });
  Object.assign(f.env, { VYSU_MOBILE_BUNDLE: 'com.example', VYSU_MOBILE_KIND: 'native', VYSU_MOBILE_READY_TEXT: 'Home', VYSU_LOCK_WAIT: '1' });
  mkdirSync(join(f.state, 'claims'), { recursive: true });
  const claim = join(f.state, 'claims', 'android-fake-avd');
  writeFileSync(claim, `owner=shell:${process.pid}\nuntil=${Math.floor(Date.now() / 1000) + 600}\nminutes=10\nnote=\ndevice=fake_avd\n`);
  writeFileSync(join(f.state, 'state-android-fake-avd.env'), 'textsize=xl\n');
  const r = await f.vysu(['release', 'android', '--force', '--reset'], 30000);
  assert.equal(r.code, 0, r.stderr);
  assert.match(r.stdout, /^reset: vysu mrelaunch android --textsize normal$/m);
  assert.match(r.stdout, new RegExp(`^released: android-fake-avd \\(was shell:${process.pid}\\)$`, 'm'));
  assert.ok(!existsSync(claim));
  assert.ok(f.calls().some((l) => l.includes('font_scale 1.0')));
});
