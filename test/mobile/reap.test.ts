// The idle reaper and the room to boot: when a device was last used, what memory the machine has, and
// against a fake adb, what `vysu down idle` stops and what it leaves alone.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { chmodSync, existsSync, mkdirSync, renameSync, utimesSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  bootedByVysu,
  budgetBlock,
  deviceStarts,
  deviceVerdict,
  etimeSeconds,
  journalsOf,
  stopInOrder,
  linuxMemory,
  macMemory,
  memoryBlock,
  type DeviceSeen,
} from '../../src/mobile/reap.ts';
import { metroRecordText, parseMetroRecord } from '../../src/mobile/metro.ts';
import { emulatorArgs } from '../../src/mobile/pool.ts';
import { fakeAndroid } from './fake-adb.ts';

test('ps etime, as macOS and Linux print it', () => {
  assert.equal(etimeSeconds('00:07'), 7);
  assert.equal(etimeSeconds('   06:27:27'), 6 * 3600 + 27 * 60 + 27);
  assert.equal(etimeSeconds('04-20:33:57'), 4 * 86400 + 20 * 3600 + 33 * 60 + 57);
  assert.equal(etimeSeconds('12:05'), 725);
  assert.equal(etimeSeconds('soon'), -1);
});

test('when each device started: an emulator by its AVD, a simulator by its UDID', () => {
  const ps = [
    '04-20:33:57 /sbin/launchd',
    '02:10:49 launchd_sim /Users/me/Library/Developer/CoreSimulator/Devices/edae8bf1-9df8-4637-a9e2-ad471bd0b869/data/var/run/launchd_bootstrap.plist',
    '02:02:41 /sdk/emulator/qemu/darwin-aarch64/qemu-system-aarch64 -avd nidz_pixel4a_api30 -gpu host -memory 3072',
    '   00:03 grep -avd nidz_pixel4a_api30',
  ].join('\n');
  const s = deviceStarts(ps, 100000);
  assert.equal(s.get('udid:EDAE8BF1-9DF8-4637-A9E2-AD471BD0B869'), 100000 - (2 * 3600 + 10 * 60 + 49));
  assert.equal(s.get('avd:nidz_pixel4a_api30'), 100000 - (2 * 3600 + 2 * 60 + 41));
  assert.equal(s.size, 2);
});

test('a Metro record keeps its owner whole on a line of its own; one an older vysu wrote has none', () => {
  const t = metroRecordText('8083', '4242', '/a b/apps/mobile', 'Code Helper (Plugin):123');
  assert.equal(t, '8083 4242 /a b/apps/mobile\nowner=Code Helper (Plugin):123\n');
  assert.deepEqual(parseMetroRecord(t), { port: '8083', pid: '4242', dir: '/a b/apps/mobile', owner: 'Code Helper (Plugin):123' });
  assert.deepEqual(parseMetroRecord('8082 0 /x/y\n'), { port: '8082', pid: '0', dir: '/x/y', owner: '' });
  assert.equal(parseMetroRecord(metroRecordText('8084', '1', '/d', 'checker-2')).owner, 'checker-2');
});

test("a boot marker matches only the boot it was written for", () => {
  assert.equal(bootedByVysu([1000], 1003), true);
  assert.equal(bootedByVysu([1000], 995), true);
  assert.equal(bootedByVysu([1000], 1000 + 241), false);
  assert.equal(bootedByVysu([1000], 900), false);
  assert.equal(bootedByVysu([], 1000), false);
  assert.equal(bootedByVysu([1000], 0), false);
  assert.equal(bootedByVysu([500, 1000], 1010), true);
});

test("agent-device's journals of a device, whatever project opened them", () => {
  const all = ['nidz-ios-iphone-17-pro', 'veilleuse-ios-iphone-17-pro', 'nidz-ios-nidz-iphone-17-pro-b', 'nidz-ios', 'nidz-android-iphone-17-pro'];
  assert.deepEqual(journalsOf(all, 'ios', 'iPhone 17 Pro'), ['nidz-ios-iphone-17-pro', 'veilleuse-ios-iphone-17-pro']);
});

test('a device is stopped only when vysu booted it this boot and nothing anywhere used it for the idle time', () => {
  const now = 100000;
  const base: DeviceSeen = { claimedBy: '', locked: false, bootAt: now - 7200, marks: [now - 7201], uses: [{ at: now - 3600, by: 'claude:1' }] };
  const v = deviceVerdict(base, now, 900);
  assert.equal(v.stop, true);
  assert.match(v.why, /^idle 60 min, last used by claude:1 at \d\d:\d\d$/);
  assert.equal(deviceVerdict({ ...base, claimedBy: 'codex:9' }, now, 900).why, 'claimed by codex:9');
  assert.equal(deviceVerdict({ ...base, locked: true }, now, 900).stop, false);
  // No marker, or one of an earlier boot: somebody else's boot, however quiet.
  assert.match(deviceVerdict({ ...base, marks: [] }, now, 900).why, /not by vysu/);
  assert.equal(deviceVerdict({ ...base, marks: [now - 20000] }, now, 900).stop, false);
  assert.match(deviceVerdict({ ...base, bootAt: 0 }, now, 900).why, /cannot be read/);
  // Any use, a journal of another project's session included, keeps it.
  assert.equal(deviceVerdict({ ...base, uses: [...base.uses, { at: now - 60, by: '' }] }, now, 900).stop, false);
  assert.match(deviceVerdict({ ...base, uses: [] }, now, 900).why, /booted at \d\d:\d\d, unused since/);
});

test('under pressure: the longest idle first, and nothing more once there is room', async () => {
  const done: string[] = [];
  const due = [
    { name: 'b', last: 300 },
    { name: 'a', last: 100 },
    { name: 'c', last: 200 },
  ];
  const stop = async (x: { name: string }): Promise<boolean> => (done.push(x.name), x.name !== 'a');
  // « a » would not stop (a claim came meanwhile): « c » next, then there is room.
  assert.equal(await stopInOrder(due, stop, async () => done.length >= 2), 1);
  assert.deepEqual(done, ['a', 'c']);
  done.length = 0;
  assert.equal(await stopInOrder(due, stop), 2);
  assert.deepEqual(done, ['a', 'c', 'b']);
});

test('memory: the kernel level and pressure on macOS, MemAvailable on Linux, and the floor', () => {
  assert.deepEqual(macMemory('58\n1\n'), { free: 58, pressure: 'normal' });
  assert.deepEqual(macMemory('12\n4\n'), { free: 12, pressure: 'critical' });
  assert.equal(macMemory(''), null);
  assert.deepEqual(linuxMemory('MemTotal:       16000000 kB\nMemFree:  100 kB\nMemAvailable:    4000000 kB\n'), { free: 25, pressure: '' });
  assert.equal(linuxMemory('MemTotal: 10 kB\n'), null);
  assert.equal(memoryBlock({ free: 58, pressure: 'normal' }, 20), '');
  assert.match(memoryBlock({ free: 14, pressure: 'normal' }, 20), /14% of memory free, under VYSU_MEMORY_MIN_FREE=20%/);
  assert.match(memoryBlock({ free: 40, pressure: 'warn' }, 20), /memory pressure warn/);
  assert.equal(memoryBlock({ free: 5, pressure: 'critical' }, 0), '');
  assert.equal(memoryBlock(null, 20), '');
});

test('the budget: full at the max, 0 is none', () => {
  assert.equal(budgetBlock('ios', 1, 2), '');
  assert.match(budgetBlock('ios', 2, 2), /2 simulators of the pool booted \(VYSU_IOS_MAX_BOOTED=2\)/);
  assert.match(budgetBlock('android', 3, 2), /3 emulators running \(VYSU_ANDROID_MAX_RUNNING=2\)/);
  assert.equal(budgetBlock('android', 5, 0), '');
});

test('emulator flags: memory, cores, no audio, a cold boot unless quickboot, no window when headless', () => {
  const cold = emulatorArgs('pixel', { memory: '3072', cores: '2', headless: false, quickboot: false });
  assert.deepEqual(cold, ['-avd', 'pixel', '-gpu', 'host', '-memory', '3072', '-cores', '2', '-dns-server', '1.1.1.1,8.8.8.8', '-no-snapshot', '-no-boot-anim', '-no-audio']);
  const quick = emulatorArgs('pixel', { memory: '4096', cores: '4', headless: true, quickboot: true });
  assert.ok(!quick.includes('-no-snapshot'));
  assert.ok(quick.includes('-no-window'));
  assert.equal(quick[quick.indexOf('-memory') + 1], '4096');
});

const posix = { skip: process.platform === 'win32' ? 'the fake adb is a shell script' : false };

// A fake adb whose emulator goes away once killed, and a fake xcrun with no simulator: the reaper must
// never see this Mac's real ones.
function machine(): ReturnType<typeof fakeAndroid> {
  const f = fakeAndroid();
  renameSync(join(f.bin, 'adb'), join(f.bin, 'adb.real'));
  writeFileSync(
    join(f.bin, 'adb'),
    `#!/bin/sh
D='${f.dir}'
case "$*" in
  *"emu kill"*) echo "$*" >> "$D/adb.log"; touch "$D/killed"; exit 0;;
  devices) if [ -f "$D/killed" ]; then printf 'List of devices attached\\n'; exit 0; fi;;
esac
exec "$D/bin/adb.real" "$@"
`,
  );
  chmodSync(join(f.bin, 'adb'), 0o755);
  writeFileSync(join(f.bin, 'xcrun'), '#!/bin/sh\necho \'{"devices":{}}\'\n', { mode: 0o755 });
  // The emulator's qemu, started 70 minutes ago; every other `ps` is the real one.
  writeFileSync(
    join(f.bin, 'ps'),
    `#!/bin/sh\nif [ "$*" = "-A -o etime=,args=" ]; then echo '01:10:00 /sdk/emulator/qemu/darwin-aarch64/qemu-system-aarch64 -avd fake_avd -gpu host'; exit 0; fi\nexec /bin/ps "$@"\n`,
    { mode: 0o755 },
  );
  Object.assign(f.env, { VYSU_ANDROID_AVDS: 'fake_avd:36:pixel_8:', VYSU_IOS_DEVICES: 'No Such Phone', VYSU_IDLE_MINUTES: '15' });
  mkdirSync(join(f.state, 'used'), { recursive: true });
  // vysu booted it: its marker, written the moment it asked.
  writeFileSync(join(f.state, 'booted-android-fake-avd'), `${Math.floor(Date.now() / 1000) - 4201} test-owner\n`);
  return f;
}
const kills = (f: ReturnType<typeof fakeAndroid>): string[] => f.calls().filter((l) => l.includes('emu kill'));

test('down idle: an emulator unused for the idle time is stopped, said on one line; --dry-run only says so', posix, async () => {
  const f = machine();
  writeFileSync(join(f.state, 'used', 'android-fake-avd'), `claude:41234 ${Math.floor(Date.now() / 1000) - 3600}\n`);
  const dry = await f.vysu(['down', 'idle', '--dry-run']);
  assert.equal(dry.code, 0, dry.stderr);
  assert.match(dry.stdout, /^would stop: android « fake_avd » \(idle 60 min, last used by claude:41234 at \d\d:\d\d\)$/m);
  assert.deepEqual(kills(f), []);
  const r = await f.vysu(['down', 'idle']);
  assert.equal(r.code, 0, r.stderr);
  assert.match(r.stdout, /^stopped: android « fake_avd » \(idle 60 min/m);
  assert.deepEqual(kills(f), ['-s emulator-5598 emu kill']);
  assert.equal(existsSync(join(f.state, 'locks', 'android-fake-avd')), false);
});

test('down idle: a device claimed, or used a minute ago, is left alone', posix, async () => {
  const f = machine();
  const now = Math.floor(Date.now() / 1000);
  writeFileSync(join(f.state, 'used', 'android-fake-avd'), `claude:41234 ${now - 3600}\n`);
  mkdirSync(join(f.state, 'claims'), { recursive: true });
  writeFileSync(join(f.state, 'claims', 'android-fake-avd'), `owner=someone\nuntil=${now + 600}\nminutes=20\nnote=\n`);
  const claimed = await f.vysu(['down', 'idle', '--dry-run']);
  assert.match(claimed.stdout, /^kept: android « fake_avd » claimed by someone$/m);
  writeFileSync(join(f.state, 'claims', 'android-fake-avd'), `owner=someone\nuntil=${now - 60}\nminutes=20\nnote=\n`);
  writeFileSync(join(f.state, 'used', 'android-fake-avd'), `claude:41234 ${now - 60}\n`);
  const recent = await f.vysu(['down', 'idle']);
  assert.equal(recent.code, 0, recent.stderr);
  assert.match(recent.stdout, /^idle: nothing unused for 15 min/m);
  assert.deepEqual(kills(f), []);
});

test('down idle: a device vysu did not boot, or that another project or agent-device used lately, is kept', posix, async () => {
  const f = machine();
  const now = Math.floor(Date.now() / 1000);
  writeFileSync(join(f.state, 'used', 'android-fake-avd'), `claude:41234 ${now - 3600}\n`);
  // Booted by somebody else: no marker of this boot.
  writeFileSync(join(f.state, 'booted-android-fake-avd'), `${now - 90000} test-owner\n`);
  const other = await f.vysu(['down', 'idle', '--dry-run']);
  assert.match(other.stdout, /^kept: android « fake_avd » \(booted at \d\d:\d\d, not by vysu: left to whoever started it\)$/m);
  writeFileSync(join(f.state, 'booted-android-fake-avd'), `${now - 4201} test-owner\n`);
  // A claim in another project's state folder.
  const home = f.env.HOME!;
  mkdirSync(join(home, '.vysu', 'veilleuse', 'claims'), { recursive: true });
  writeFileSync(join(home, '.vysu', 'veilleuse', 'claims', 'android-fake-avd'), `owner=codex:5120\nuntil=${now + 600}\nminutes=20\nnote=\n`);
  const claimed = await f.vysu(['down', 'idle', '--dry-run']);
  assert.match(claimed.stdout, /^kept: android « fake_avd » claimed by codex:5120$/m);
  writeFileSync(join(home, '.vysu', 'veilleuse', 'claims', 'android-fake-avd'), `owner=codex:5120\nuntil=${now - 60}\nminutes=20\nnote=\n`);
  // An agent-device journal of another project, written a minute ago (an older vysu records no use).
  const journal = join(home, '.agent-device', 'sessions', 'veilleuse-android-fake-avd');
  mkdirSync(journal, { recursive: true });
  writeFileSync(join(journal, 'events.ndjson'), '{}\n');
  utimesSync(join(journal, 'events.ndjson'), now - 60, now - 60);
  const touched = await f.vysu(['down', 'idle']);
  assert.equal(touched.code, 0, touched.stderr);
  assert.match(touched.stdout, /^idle: nothing unused for 15 min/m);
  assert.deepEqual(kills(f), []);
});

test('down idle: an isolated Metro record is judged by the owner it holds, never by its file name', posix, async () => {
  const f = machine();
  const old = Math.floor(Date.now() / 1000) - 3600;
  const put = (name: string, text: string): string => {
    const p = join(f.state, `metro-port.${name}`);
    writeFileSync(p, text);
    utimesSync(p, old, old);
    return p;
  };
  // Not running: a live owner named by hand keeps it; a gone one, and an older vysu's record, lose it.
  const named = put('checker-2', metroRecordText('8097', '999999', '/w', 'checker-2'));
  const gone = put('ghost-999999', metroRecordText('8098', '999999', '/w', 'ghost:999999'));
  const older = put('claude-2', '8099 999999 /w\n');
  const r = await f.vysu(['down', 'idle']);
  assert.equal(r.code, 0, r.stderr);
  assert.equal(existsSync(named), true);
  assert.equal(existsSync(gone), false);
  assert.equal(existsSync(older), false);
});

test('down idle: off at VYSU_IDLE_MINUTES=0 unless --minutes says otherwise', posix, async () => {
  const f = machine();
  f.env.VYSU_IDLE_MINUTES = '0';
  const r = await f.vysu(['down', 'idle']);
  assert.equal(r.code, 1);
  assert.match(r.stderr, /the idle reaper is off/);
  const m = await f.vysu(['down', 'idle', '--minutes', '5', '--dry-run']);
  assert.equal(m.code, 0, m.stderr);
});

test('release: a claim that ran out under its owner is said to have expired, not « no claim »', posix, async () => {
  const f = machine();
  mkdirSync(join(f.state, 'claims'), { recursive: true });
  writeFileSync(join(f.state, 'claims', 'android-fake-avd'), `owner=test-owner\nuntil=${Math.floor(Date.now() / 1000) - 120}\nminutes=20\nnote=\ndevice=fake_avd\n`);
  // Another owner's command meets the expired claim and sets it aside.
  f.env.VYSU_OWNER = 'other-owner';
  const other = await f.vysu(['devices']);
  f.env.VYSU_OWNER = 'test-owner';
  assert.equal(other.code, 0, other.stderr);
  assert.match(other.stdout, /^budget: /m);
  assert.equal(existsSync(join(f.state, 'claims', 'android-fake-avd')), false);
  const r = await f.vysu(['release', 'android']);
  assert.equal(r.code, 0, r.stderr);
  assert.match(r.stdout, /^release: the claim of test-owner on android-fake-avd had already expired at \d\d:\d\d, nothing to release$/m);
  const again = await f.vysu(['release', 'android']);
  assert.match(again.stdout, /^release: no claim on android-fake-avd$/m);
});

test('up android with the budget full: waits VYSU_LOCK_WAIT, then fails naming what runs, and starts nothing', posix, async () => {
  const f = fakeAndroid({ emulators: { 'emulator-5596': 'other_avd', 'emulator-5598': 'busy_avd' } });
  writeFileSync(join(f.bin, 'xcrun'), '#!/bin/sh\necho \'{"devices":{}}\'\n', { mode: 0o755 });
  Object.assign(f.env, { VYSU_ANDROID_AVD: 'target_avd', VYSU_ANDROID_AVDS: 'target_avd:36:pixel_8:', VYSU_MOBILE_BUNDLE: 'com.example', VYSU_LOCK_WAIT: '1' });
  const r = await f.vysu(['up', 'android'], 30000);
  assert.equal(r.code, 1, r.stderr);
  assert.match(r.stderr, /vysu: 2 emulators running \(VYSU_ANDROID_MAX_RUNNING=2\): « target_avd » waits up to 1s/);
  assert.match(r.stderr, /^  android « busy_avd » running on emulator-5598 · free/m);
  assert.match(r.stderr, /vysu: android: « target_avd » not booted: 2 emulators running/);
  assert.equal(existsSync(join(f.state, 'locks', 'android-target-avd')), false);
});

test("a simulator's state from its device.plist: 1 shut down, 3 booted, anything unreadable 0", async () => {
  const { simState, SIM_SHUTDOWN } = await import('../../src/mobile/booted.ts');
  assert.equal(simState({ state: 1, name: 'x' }), SIM_SHUTDOWN);
  assert.equal(simState({ state: 3n }), 3);
  assert.equal(simState(null), 0);
  assert.equal(simState([1]), 0);
});
