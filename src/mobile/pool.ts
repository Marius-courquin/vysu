// The simulators and emulators several agent sessions share on one machine: which ones make up the
// pool, which one is free, a claim on any of them (booting, starting or cloning one when none is up),
// one line per device for `vysu devices`, and adb / simctl on this owner's own device, under its lock:
// a raw `adb -s emulator-5556` is how one session ended up driving another one's Pixel.
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { config } from '../core/ctx.ts';
import { IOS_DEFAULT_DEVICE } from '../core/config.ts';
import { ceilingDoing } from '../core/ceiling.ts';
import { die, exit, onCleanup } from '../core/errors.ts';
import {
  androidLock,
  claimField,
  claimFile,
  claimWhy,
  claimWrite,
  deviceRemember,
  devices,
  iosLock,
  lockAlive,
  lockDrop,
  lockTake,
  lockWho,
  owner,
  type Platform,
} from '../core/hold.ts';
import { isMac, pidAlive } from '../core/host.ts';
import { run, spawnDetached } from '../core/proc.ts';
import { hhmm, slug, sleep } from '../core/text.ts';
import { adbSerial, simctlRest } from './passargs.ts';
import { interactive, sessionClose, sessionName, sessionNames } from './agent.ts';
import { adb, adbShell, androidAvdOf, androidSelect, androidSerial, emulatorSerials, forgetSerial, iosFreezeStatusBar, iosUdid, serial } from './device.ts';
import { say, tell } from './io.ts';
import { mobileKind } from './launch.ts';
import { metroPort } from './metro.ts';
import { admit, androidMaxRunning, budgetLine, iosMaxBooted, reapIdle, reapSoon } from './reap.ts';
import { mstateFile, mstateLine } from './state.ts';
import { adbPath, emulatorPath, needMac, xcrun } from './tools.ts';

// What this machine has, read once per command: `simctl list` and one console round trip per
// emulator are cheap, but not four times per device line.
interface Sim {
  name: string;
  udid: string;
  state: string;
}
export const pool = { sims: null as Sim[] | null, emus: null as Array<{ serial: string; avd: string }> | null, avds: null as string[] | null };

async function poolSims(): Promise<Sim[]> {
  if (!isMac) return [];
  const r = await run('xcrun', ['simctl', 'list', 'devices', 'available', '-j']);
  const out: Sim[] = [];
  try {
    const devs = (JSON.parse(r.stdout) as { devices?: Record<string, Array<{ name: string; udid: string; state?: string }>> }).devices ?? {};
    const seen = new Set<string>();
    for (const [runtime, items] of Object.entries(devs)) {
      if (!runtime.includes('.SimRuntime.iOS-')) continue;
      for (const d of items) {
        if (seen.has(d.name)) continue;
        seen.add(d.name);
        out.push({ name: d.name, udid: d.udid, state: d.state ?? '' });
      }
    }
  } catch {
    // no simulators readable
  }
  return out;
}
async function poolEmulators(): Promise<Array<{ serial: string; avd: string }>> {
  const out: Array<{ serial: string; avd: string }> = [];
  for (const s of await emulatorSerials()) out.push({ serial: s, avd: await androidAvdOf(s) });
  return out;
}
export async function poolLoad(p: Platform): Promise<void> {
  if (p === 'ios') pool.sims = await poolSims();
  else {
    pool.emus = await poolEmulators();
    const r = existsSync(emulatorPath()) ? await run(emulatorPath(), ['-list-avds']) : { stdout: '' };
    pool.avds = r.stdout.split(/\r?\n/).filter(Boolean);
  }
}
export const poolSim = (name: string): Sim | undefined => pool.sims?.find((s) => s.name === name);
export const poolSerial = (avd: string): string => pool.emus?.find((e) => e.avd === avd)?.serial ?? '';
// What was just booted or stopped is read again by whoever asks next.
export function poolForget(): void {
  pool.sims = null;
  pool.emus = null;
  pool.avds = null;
}

// A clone vysu made is named after its source, « <name> (vysu N) »: that suffix is how the pool,
// `release --delete-clone` and `--prune-clones` tell it from a simulator somebody made by hand.
export const isClone = (name: string): boolean => / \(vysu [0-9].*\)$/.test(name);
const clones = (): string[] => (pool.sims ?? []).map((s) => s.name).filter(isClone);
const uniq = (xs: string[]): string[] => [...new Set(xs.filter((x) => x.trim() !== ''))];

// The pool as the config names it. VYSU_IOS_DEVICES empty means the two simulators a project already
// declares (the recent one and the old one), so a project that says nothing still has a pool of two.
function iosConfigNames(): string[] {
  let list = config().get('IOS_DEVICES');
  if (!list) list = `${config().get('IOS_DEVICE', IOS_DEFAULT_DEVICE)},${config().get('IOS_OLD_DEVICE')}`;
  return uniq(list.split(',').map((x) => x.trim()));
}
export const iosNames = (): string[] => uniq([...iosConfigNames(), ...clones()]);
export const androidNames = (): string[] => uniq(config().get('ANDROID_AVDS').split(';').map((s) => s.split(':')[0] ?? ''));

// Where a device is at: booted · running on emulator-NNNN · shut down · not on this machine.
export async function poolPower(p: Platform, name = devices.of(p)): Promise<string> {
  if (p === 'ios') {
    if (!pool.sims) pool.sims = await poolSims();
    const st = poolSim(name)?.state ?? '';
    if (st === 'Booted') return 'booted';
    if (st === 'Shutdown') return 'shut down';
    if (st === '') return 'not on this machine';
    return st.toLowerCase();
  }
  if (!pool.emus && !pool.avds) await poolLoad('android');
  const s = poolSerial(name);
  if (s) return `running on ${s}`;
  if (pool.avds?.includes(name)) return 'shut down';
  return 'not on this machine';
}
export const poolIsUp = (power: string): boolean => power === 'booted' || power.startsWith('running on ');

// Taken by nobody but this owner: « mine », « theirs » or ''. claimWhy drops an expired or an
// orphaned claim on the way, so what is left is a claim somebody alive still holds.
export function claimState(r: string): string {
  if (claimWhy(r)) return 'theirs';
  return existsSync(claimFile(r)) ? 'mine' : '';
}
// A command of somebody else running on it right now: a device with no claim is not free while an
// agent is halfway through an `mrelaunch` on it, and it would only wait for it anyway.
export function locked(r: string): boolean {
  const d = join(config().locks, r);
  try {
    if (!statSync(d).isDirectory()) return false;
  } catch {
    return false;
  }
  if (!lockAlive(d)) return false;
  const pid = Number(readFileSync(join(d, 'pid'), 'utf8').trim() || 0);
  return pid !== process.pid;
}

// One line per device, the same for `vysu devices` and for the list a busy `claim --any` prints:
// ios « iPhone 17 Pro » booted · claimed by codex:5120 until 15:40 (login flow) · textsize xl · by …
export async function poolLine(p: Platform, name: string, power: string): Promise<string> {
  const r = `${p}-${slug(name)}`;
  const f = claimFile(r);
  claimWhy(r); // an expired or orphaned claim is gone before it is printed
  let held = 'free';
  if (existsSync(f)) {
    const who = claimField(f, 'owner');
    const note = claimField(f, 'note');
    held = `claimed by ${who}${who === owner() ? ' (you)' : ''} until ${hhmm(Number(claimField(f, 'until') || 0))}${note ? ` (${note})` : ''}`;
  }
  // The command cut at 48 characters: a `vysu mdo` line runs to 120, and the device is what the line
  // is about.
  let lock = '';
  if (locked(r)) lock = ` · lock: ${(await lockWho(join(config().locks, r))).replace(/« (.{48}).+ »/u, '« $1… »')}`;
  let st = (await mstateLine(mstateFile(p, name), '', mobileKind() === 'expo')).replace(/^state[^:]*: /, '');
  if (st.startsWith('(')) st = '';
  const mine = name === devices.of(p) ? ' · your device' : '';
  return `${p} « ${name} » ${power} · ${held}${lock}${st ? ` · ${st}` : ''}${mine}`;
}

// The devices of this machine somebody claims, out of the pool or not: a claim names a resource, so
// each name is matched through its slug.
const claimed = (p: Platform, names: string[]): string[] => names.filter((n) => n && existsSync(claimFile(`${p}-${slug(n)}`)));

// The device choices an agent session left behind (`ios-device.claude-41234`): once its process is
// gone nobody reads that file again, until a new process is handed the same pid and inherits a device
// it never chose. Only the « <name>-<pid> » shape an owner detected from its process has, and only a
// pid that no longer exists: an owner named by hand is never touched.
function sweepChoices(): void {
  const state = config().state;
  let files: string[] = [];
  try {
    files = readdirSync(state);
  } catch {
    return;
  }
  for (const f of files) {
    if (!f.startsWith('ios-device.') && !f.startsWith('android-avd.')) continue;
    const suffix = f.slice(f.indexOf('.') + 1);
    const dash = suffix.lastIndexOf('-');
    if (dash < 0) continue;
    const pid = suffix.slice(dash + 1);
    const name = suffix.slice(0, dash);
    if (!/^[0-9]+$/.test(pid) || !/^[A-Za-z0-9._]+$/.test(name)) continue;
    if (!pidAlive(Number(pid))) rmSync(join(state, f), { force: true });
  }
}

// `vysu devices`: every device of the pool, every clone, every simulator booted and every emulator
// running, whoever started it. No snapshot and no agent-device session: it answers in a second.
export async function devicesCommand(args: string[]): Promise<void> {
  if (args[0] === '--prune-clones') return pruneClones(args.slice(1));
  if (args.length) die('usage: vysu devices [--prune-clones [--dry-run]]');
  await reapSoon();
  poolForget();
  await poolLoad('ios');
  await poolLoad('android');
  const simNames = (pool.sims ?? []).map((s) => s.name);
  const iosList = uniq([...iosNames(), ...(pool.sims ?? []).filter((s) => s.state === 'Booted').map((s) => s.name), ...claimed('ios', simNames), devices.ios]);
  for (const n of iosList) say(await poolLine('ios', n, await poolPower('ios', n)));
  const androidList = uniq([...androidNames(), ...(pool.emus ?? []).map((e) => e.avd), ...claimed('android', pool.avds ?? []), devices.android]);
  for (const n of androidList) say(await poolLine('android', n, await poolPower('android', n)));
  say(await budgetLine());
  sweepChoices();
}

// --- claim --any -------------------------------------------------------------------------------

// The device a `claim --any` takes, in this order: one this owner already claims (a second `--any` in
// the same task must not collect a second device), a free booted one, a free shut-down one it boots
// (while fewer than VYSU_ANDROID_MAX_RUNNING emulators run, or VYSU_IOS_MAX_BOOTED simulators of the
// pool are booted), and on iOS a clone of a shut-down pool member, up to VYSU_IOS_MAX_CLONES. Within each rank the owner's current
// device first: the app, its login and its state are already there.
interface Pick {
  action: '' | 'own' | 'booted' | 'boot' | 'start' | 'clone';
  name: string;
  src: string;
  why: string;
}
const rank = (best: string, cand: string, current: string): string => (!best || cand === current ? cand : best);

async function poolPick(p: Platform): Promise<Pick> {
  const current = devices.of(p);
  const names = p === 'ios' ? iosNames() : androidNames();
  let own = '';
  let ownDown = '';
  let up = '';
  let down = '';
  for (const n of names) {
    const power = await poolPower(p, n);
    if (power === 'not on this machine') continue;
    const r = `${p}-${slug(n)}`;
    const cs = claimState(r);
    if (cs === 'mine') {
      // One this owner holds already, up first: a second `--any` in the same task gets the device of
      // the first one back instead of a second device.
      if (poolIsUp(power)) own = rank(own, n, current);
      else ownDown = rank(ownDown, n, current);
      continue;
    }
    if (cs === 'theirs') continue;
    if (locked(r)) continue;
    if (poolIsUp(power)) up = rank(up, n, current);
    else if (power === 'shut down') down = rank(down, n, current);
  }
  const pick: Pick = { action: '', name: '', src: '', why: '' };
  if (own) return { ...pick, action: 'own', name: own };
  const running = (pool.emus ?? []).length;
  const maxRunning = androidMaxRunning();
  const booted = names.filter((n) => poolSim(n)?.state === 'Booted').length;
  const maxBooted = iosMaxBooted();
  if (ownDown) {
    // Held but stopped, and no room to start it: said on the device line.
    const room = p === 'ios' ? booted < maxBooted : running < maxRunning;
    return { ...pick, name: ownDown, action: room ? (p === 'ios' ? 'boot' : 'start') : 'own' };
  }
  if (up) return { ...pick, action: 'booted', name: up };
  // Every simulator booted is 2-4 GB: past the budget, a free one is waited for rather than another
  // booted or cloned.
  if (p === 'ios' && booted >= maxBooted) {
    return { ...pick, why: `boot: ${booted} simulators of the pool already booted (VYSU_IOS_MAX_BOOTED=${maxBooted})` };
  }
  if (p === 'android') {
    if (down && running < maxRunning) return { ...pick, action: 'start', name: down };
    if (down) return { ...pick, why: `start: « ${down} » is free but ${running} emulators already run (VYSU_ANDROID_MAX_RUNNING=${maxRunning})` };
    return { ...pick, why: 'start: no AVD of the pool is both free and stopped (VYSU_ANDROID_AVDS)' };
  }
  if (down) return { ...pick, action: 'boot', name: down };
  // A clone copies the source's disk (the app installed, its login, its settings), which is the whole
  // point, and `simctl clone` only copies a simulator that is shut down.
  const maxClones = Number(config().get('IOS_MAX_CLONES', '1'));
  const have = clones().length;
  if (have >= maxClones) return { ...pick, why: `clone: VYSU_IOS_MAX_CLONES=${maxClones} reached (${have} on this machine)` };
  let src = '';
  for (const n of iosConfigNames()) {
    if ((await poolPower('ios', n)) !== 'shut down') continue;
    if (locked(`ios-${slug(n)}`)) continue;
    src = n;
    break;
  }
  if (!src) return { ...pick, why: 'clone: a clone needs a shut-down source, and every pool device is booted (its holder shuts one down: vysu simctl shutdown)' };
  let i = 1;
  while (poolSim(`${src} (vysu ${i})`)) i++;
  return { ...pick, action: 'clone', src, name: `${src} (vysu ${i})` };
}

async function busyReport(p: Platform, why: string): Promise<void> {
  for (const n of p === 'ios' ? iosNames() : androidNames()) tell(`  ${await poolLine(p, n, await poolPower(p, n))}`);
  if (why) tell(`  ${why}`);
}

export async function claimAny(p: Platform, minutes: number, note: string, nowait: boolean, report: (p: Platform, r: string, done: string) => Promise<void>): Promise<void> {
  // Elsewhere the iOS pool reads as empty, which would be waited on for VYSU_LOCK_WAIT, then said as
  // « every pool device is booted ».
  if (p === 'ios') needMac('vysu claim ios --any');
  const start = Date.now();
  const wait = config().lockWait;
  let said = false;
  let reapedAt = 0;
  let pick: Pick;
  for (;;) {
    // Two `--any` at the same moment would pick the same free device: the choice and the claim that
    // seals it are made under one pool-wide lock, dropped as soon as the claim is written.
    await lockTake(`pool-${p}`);
    await poolLoad(p);
    pick = await poolPick(p);
    if (pick.action) break;
    lockDrop(`pool-${p}`);
    // No room: what nobody uses is stopped, at most every 30 s, and the pick made again.
    if (Date.now() - reapedAt >= 30000) {
      reapedAt = Date.now();
      if (await reapIdle({ pressure: true, print: (l) => tell(`vysu: ${l}`) })) {
        poolForget();
        continue;
      }
    }
    const waited = Math.floor((Date.now() - start) / 1000);
    if (nowait || waited >= wait) {
      tell(`vysu: no free ${p} device in the pool${said ? ` after ${waited}s` : ''}:`);
      await busyReport(p, pick.why);
      die(`no free ${p} device`, `vysu claim ${p} --any (waits VYSU_LOCK_WAIT=${wait}s for one)`);
    }
    if (!said) {
      tell(`vysu: no free ${p} device, waiting up to ${wait}s (VYSU_LOCK_WAIT):`);
      await busyReport(p, pick.why);
      said = true;
    }
    await sleep(3000);
  }
  const name = pick.name;
  const r = `${p}-${slug(name)}`;
  claimWrite(r, minutes, note, name);
  // A claim on a device that never came up is no claim: whichever way the boot ends (a die, the
  // command's ceiling, a signal), it goes with it.
  const keep = onCleanup(() => rmSync(claimFile(r), { force: true }), true);
  let done = '';
  if (pick.action === 'clone') {
    const srcUdid = poolSim(pick.src)?.udid ?? '';
    tell(`vysu: cloning « ${pick.src} » into « ${name} »…`);
    if ((await xcrun(['simctl', 'clone', srcUdid, name])).code !== 0) {
      rmSync(claimFile(r), { force: true });
      die(`ios: could not clone « ${pick.src} » (xcrun simctl clone)`);
    }
    done = `cloned from « ${pick.src} », booted`;
  }
  lockDrop(`pool-${p}`);
  if (p === 'ios') {
    devices.ios = name;
    deviceRemember('ios-device', name);
  } else {
    devices.android = name;
    forgetSerial();
    deviceRemember('android-avd', name);
  }
  devices.named(p);
  if (pick.action === 'boot' || pick.action === 'clone') {
    tell(`vysu: booting « ${name} »…`);
    if (!(await iosBoot())) {
      rmSync(claimFile(r), { force: true });
      die(`ios: « ${name} » did not boot`, 'vysu devices');
    }
    done ||= 'booted (it was shut down)';
  } else if (pick.action === 'start') {
    tell(`vysu: starting « ${name} »…`);
    if (!(await androidStart())) {
      rmSync(claimFile(r), { force: true });
      die(`android: « ${name} » did not start (see ${join(config().logs, 'android-emulator.log')})`, 'vysu devices');
    }
    done = `started on ${serial.value}`;
  }
  keep();
  // What was just booted is read again by the report.
  poolForget();
  await report(p, r, done);
  await reapSoon();
}

// A machine with no screen, or a person who does not want windows opening under their work: the
// devices run just the same without one — captures, taps, logs and recordings all go through
// simctl, adb and agent-device, never through the window. Only the start differs, so a device
// started with a window keeps it until it is shut down.
export function mobileHeadless(): boolean {
  const v = config().get('MOBILE_HEADLESS');
  if (!['0', '1', ''].includes(v)) die(`VYSU_MOBILE_HEADLESS is 0 or 1 (got « ${v} »)`);
  return v === '1';
}
// Simulator.app is a viewer: it shows every booted simulator, and a device boots without it.
export async function simulatorWindow(): Promise<void> {
  if (!mobileHeadless()) await run('open', ['-a', 'Simulator']);
}

// A shut-down simulator, booted the way `vysu up ios` does it (the Simulator window, the status bar),
// and waited for up to the springboard (`bootstatus`, not just the « Booted » flag). Bounded: a
// simulator that never comes up must not hold the claim forever.
async function iosBoot(): Promise<boolean> {
  await iosLock();
  const udid = await iosUdid(true);
  if (udid === 'booted') return false;
  await admit('ios', devices.ios);
  ceilingDoing(`booting « ${devices.ios} »`);
  await xcrun(['simctl', 'boot', udid]);
  await simulatorWindow();
  await xcrun(['simctl', 'bootstatus', udid], { timeoutMs: 180000 });
  const list = (await xcrun(['simctl', 'list', 'devices'])).stdout;
  if (!list.split('\n').some((l) => l.includes(udid) && l.includes('(Booted)'))) return false;
  await iosFreezeStatusBar();
  return true;
}

// The flags an AVD is started with. It ships with the GPU off and 1.5 GB: software rendering, ANRs at
// boot. Host GPU and explicit DNS servers, so the guest does not inherit a VPN resolver it cannot
// reach. Memory and cores were 4096 MB and 4 until 0.9.2: two emulators then asked for 8 GB and 8
// cores of an 18 GB, 11-core Mac that also ran two simulators and nine agent sessions, which is where
// the ANRs came from; 3 GB and 2 cores run the app as well. No audio: nothing listens, and the host's
// audio stack costs a thread per emulator. A cold boot by default (`-no-snapshot` loads none and saves
// none, where `-no-snapshot-load` still wrote a 2-4 GB RAM image at every shutdown that nothing ever
// read back); VYSU_ANDROID_QUICKBOOT=1 loads the AVD's quickboot snapshot and saves it again on exit.
export function emulatorArgs(avd: string, o: { memory: string; cores: string; headless: boolean; quickboot: boolean }): string[] {
  return [
    '-avd',
    avd,
    '-gpu',
    'host',
    '-memory',
    o.memory,
    '-cores',
    o.cores,
    '-dns-server',
    '1.1.1.1,8.8.8.8',
    ...(o.quickboot ? [] : ['-no-snapshot']),
    '-no-boot-anim',
    '-no-audio',
    ...(o.headless ? ['-no-window'] : []),
  ];
}

const positive = (key: string, fallback: string): string => {
  const v = config().get(key, fallback);
  if (!/^[1-9][0-9]*$/.test(v)) die(`VYSU_${key} is a whole number (got « ${v} »)`);
  return v;
};

// A stopped AVD, started with those flags, and waited for until it has booted.
export function startEmulator(avd: string): void {
  mkdirSync(config().logs, { recursive: true });
  const quick = config().get('ANDROID_QUICKBOOT', '0');
  if (!['0', '1'].includes(quick)) die(`VYSU_ANDROID_QUICKBOOT is 0 or 1 (got « ${quick} »)`);
  const args = emulatorArgs(avd, {
    memory: positive('ANDROID_MEMORY', '3072'),
    cores: positive('ANDROID_CORES', '2'),
    headless: mobileHeadless(),
    quickboot: quick === '1',
  });
  ceilingDoing(`starting the emulator « ${avd} »`);
  spawnDetached(emulatorPath(), args, { log: join(config().logs, 'android-emulator.log') });
}
async function androidStart(): Promise<boolean> {
  await androidLock();
  await admit('android', devices.android);
  startEmulator(devices.android);
  let s = '';
  for (let i = 0; i < 60 && !s; i++) {
    s = await androidSerial();
    if (!s) await sleep(2000);
  }
  if (!s) return false;
  serial.value = s;
  process.env.ANDROID_SERIAL = s;
  const booted = async (): Promise<boolean> => (await adbShell(['getprop', 'sys.boot_completed'])).trim() === '1';
  for (let i = 0; i < 80; i++) {
    if (await booted()) break;
    await sleep(3000);
  }
  if (!(await booted())) return false;
  // Metro reachable as localhost from the emulator: an expo concern only.
  if (mobileKind() === 'expo') await adb(['reverse', `tcp:${metroPort()}`, `tcp:${metroPort()}`]);
  return true;
}

// --- clones ------------------------------------------------------------------------------------

// Everything remembered about a device that no longer exists: its UDID, scale and state caches, and
// every owner's choice naming it: the next command of that owner falls back to the config instead of
// failing on a simulator that is gone.
function forgetDevice(p: Platform, name: string): void {
  const state = config().state;
  const s = slug(name);
  for (const f of [`ios-udid-${s}`, `scale-${p}-${s}`, `state-${p}-${s}.env`]) rmSync(join(state, f), { force: true });
  let files: string[] = [];
  try {
    files = readdirSync(state);
  } catch {
    return;
  }
  for (const f of files) {
    if (f !== 'ios-device' && !f.startsWith('ios-device.')) continue;
    try {
      if (readFileSync(join(state, f), 'utf8') === name) rmSync(join(state, f), { force: true });
    } catch {
      // gone meanwhile
    }
  }
}

export async function deleteClone(name: string): Promise<void> {
  if (!isClone(name)) die(`« ${name} » is not a vysu clone: only a « <name> (vysu N) » simulator is deleted`);
  if (!pool.sims) pool.sims = await poolSims();
  const udid = poolSim(name)?.udid ?? '';
  if (!udid) {
    forgetDevice('ios', name);
    say(`deleted: ios « ${name} » was already gone`);
    return;
  }
  // Its agent-device session is bound to that UDID: a later clone of the same name would inherit a
  // session pointing at a simulator that no longer exists.
  const session = sessionName('ios', name);
  if ((await sessionNames()).includes(session)) await sessionClose(session);
  await xcrun(['simctl', 'shutdown', udid]);
  if ((await xcrun(['simctl', 'delete', udid])).code !== 0) die(`ios: could not delete « ${name} » (xcrun simctl delete ${udid})`);
  forgetDevice('ios', name);
  say(`deleted: ios « ${name} »`);
}

// `vysu devices --prune-clones`: the clones nobody claims and nobody is driving, deleted: a clone is a
// whole simulator on disk, and one booted is 1-2 GB of RAM on a machine that has none to spare.
async function pruneClones(args: string[]): Promise<void> {
  let dry = false;
  if (args[0] === '--dry-run') dry = true;
  else if (args.length) die('usage: vysu devices --prune-clones [--dry-run]');
  await poolLoad('ios');
  const list = clones();
  for (const n of list) {
    const r = `ios-${slug(n)}`;
    claimWhy(r);
    if (existsSync(claimFile(r))) {
      say(`kept: ios « ${n} » claimed by ${claimField(claimFile(r), 'owner')}`);
      continue;
    }
    if (locked(r)) {
      say(`kept: ios « ${n} » in use (${await lockWho(join(config().locks, r))})`);
      continue;
    }
    if (dry) {
      say(`would delete: ios « ${n} » (${await poolPower('ios', n)})`);
      continue;
    }
    await lockTake(r); // nobody claims it or drives it, and nobody starts to while it goes
    await deleteClone(n);
  }
  if (!list.length) say('clones: none');
}

// --- adb and simctl on this owner's device -----------------------------------------------------

// `vysu adb …`: the owner's AVD, locked and addressed by its serial, never « the » device adb would
// pick, nor the serial of an emulator another session holds. A serial given here would defeat that
// (a leading `-s` naming the owner's own is dropped, src/mobile/passargs.ts), and `kill-server` takes every emulator's adb connection down for every session: both refused.
export async function adbCommand(all: string[]): Promise<void> {
  const { serial: named, rest: args } = adbSerial(all);
  if (!args.length) die(`usage: vysu adb <adb args…>  (on ${devices.android}, the owner's AVD)`);
  for (const a of args) {
    if (['-s', '-e', '-d', '-t', '-H', '-P', '-L'].includes(a) || /^-[st]./.test(a)) {
      die(`vysu adb runs on ${devices.android}, this owner's AVD: ${a} is not taken`, 'vysu claim android --avd <name>, then vysu adb …');
    }
    if (a === 'kill-server') die("vysu adb kill-server would cut every emulator's connection, for every session");
    if (a.startsWith('-')) continue;
    break; // the adb command: what follows is its own arguments
  }
  await androidSelect();
  if (named && named !== serial.value) die(`vysu adb runs on ${devices.android} (${serial.value}), this owner's AVD: ${named} is not it`, 'vysu claim android --avd <name>, then vysu adb …');
  exit((await interactive(adbPath(), ['-s', serial.value, ...args], config().childEnv({ ANDROID_SERIAL: serial.value }))).code);
}

// `vysu simctl <verb> …`: the owner's simulator UDID after the verb, under its lock. Run as it is:
// `spawn … log stream` and `io … recordVideo` stream, and a captured call would hold the output until
// the end. A UDID remembered for a simulator deleted since has no folder any more, and is looked up
// again before the call rather than after it failed.
export async function simctlCommand(args: string[]): Promise<void> {
  const verb = args[0] ?? '';
  if (!verb) die(`usage: vysu simctl <verb> [args…]  (on « ${devices.ios} », the owner's simulator)`);
  needMac('vysu simctl');
  // The verbs that take no device, or several: as they are.
  if (['list', 'create', 'clone', 'runtime', 'help', 'pair', 'unpair', 'pair_activate', 'diagnose'].includes(verb) || verb.startsWith('-')) {
    exit((await interactive('xcrun', ['simctl', ...args])).code);
  }
  await iosLock();
  let udid = await iosUdid();
  if (!existsSync(join(homedir(), 'Library', 'Developer', 'CoreSimulator', 'Devices', udid))) udid = await iosUdid(true);
  if (udid === 'booted') die(`ios: no simulator named « ${devices.ios} »`, 'vysu devices');
  const rest = simctlRest(args.slice(1), udid);
  if (!Array.isArray(rest)) die(`vysu simctl runs on « ${devices.ios} » (${udid}), this owner's simulator: ${rest.refused} is not it — leave the device out, vysu puts it after the verb`, 'vysu claim ios --device "<name>", then vysu simctl …');
  exit((await interactive('xcrun', ['simctl', verb, udid, ...rest])).code);
}

