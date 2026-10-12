// What the machine can still run. vysu booted devices and never shut one down: on 12/10 two
// simulators (~7 GB together) and two emulators (4 GB each) stayed up with nobody holding them, on an
// 18 GB Mac carrying ~33 GB of footprint and 11 GB of swap, while up to nine agent sessions drove
// vysu in the same ten minutes, and the emulators crashed with ANRs. There is no daemon to watch the
// devices: the idle ones are stopped on the way, by the commands that need room (`claim`, `up`,
// `devices`, any boot), and by `vysu down idle`. A boot then waits for room: a budget of devices per
// platform and a floor of free memory.
import { readdirSync, readFileSync, rmSync, statSync, writeFileSync, mkdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { config } from '../core/ctx.ts';
import { die } from '../core/errors.ts';
import { claimField, lockAlive, lockDrop, lockTry, owner, usedRead, type Platform } from '../core/hold.ts';
import { isLinux, isMac, isWindows, processName } from '../core/host.ts';
import { killPort } from '../core/net.ts';
import { run } from '../core/proc.ts';
import { hhmm, nowSeconds, sleep, slug } from '../core/text.ts';
import { sessionName } from './agent.ts';
import { adbRaw, emulatorSerials } from './device.ts';
import { say, tell } from './io.ts';
import { metroLog, metroPidListening } from './metro.ts';
import { androidNames, claimState, iosNames, pool, poolForget, poolLine, poolLoad, poolSerial, poolSim } from './pool.ts';
import { mstateField, mstateFile } from './state.ts';
import { xcrun } from './tools.ts';

// --- the settings ------------------------------------------------------------------------------

const whole = (raw: string, fallback: number): number => {
  const n = Number(raw);
  return raw.trim() !== '' && Number.isInteger(n) && n >= 0 ? n : fallback;
};
// Minutes a device or a Metro may sit unused before it is stopped; 0: never.
export const idleMinutes = (): number => whole(config().get('IDLE_MINUTES'), 15);
export const iosMaxBooted = (): number => whole(config().get('IOS_MAX_BOOTED'), 2);
export const androidMaxRunning = (): number => whole(config().get('ANDROID_MAX_RUNNING'), 2);
// Percent of memory free below which no device boots; 0: no floor. See memoryBlock for the number.
export const memoryFloor = (): number => whole(config().get('MEMORY_MIN_FREE'), 20);
// A boot that has no room stops sooner what nobody uses: a device released two minutes ago is not
// coming back, and the one waiting is.
export const PRESSURE_IDLE_SECONDS = 120;

// --- when a device was last used ---------------------------------------------------------------

// `ps -o etime`: « [[dd-]hh:]mm:ss ».
export function etimeSeconds(s: string): number {
  const m = /^\s*(?:(\d+)-)?(?:(\d+):)?(\d+):(\d+)\s*$/.exec(s);
  if (!m) return -1;
  return Number(m[1] ?? 0) * 86400 + Number(m[2] ?? 0) * 3600 + Number(m[3]) * 60 + Number(m[4]);
}

// When each device started, from one `ps -A -o etime=,args=`: an emulator by the AVD its qemu runs
// (`-avd <name>`), a simulator by the UDID in its launchd_sim's path. A device nobody has driven since
// it booted (or only an older vysu, which leaves no record of use) is idle from its boot.
export function deviceStarts(ps: string, now: number): Map<string, number> {
  const out = new Map<string, number>();
  const keep = (key: string, at: number): void => {
    if (!out.has(key) || at < out.get(key)!) out.set(key, at);
  };
  for (const line of ps.split('\n')) {
    const m = /^\s*(\S+)\s+(.*)$/.exec(line);
    if (!m) continue;
    const age = etimeSeconds(m[1]!);
    if (age < 0) continue;
    const args = m[2]!;
    const avd = /(?:^|\/)qemu-system-\S*\s.*?-avd\s+(\S+)/.exec(args);
    if (avd) keep(`avd:${avd[1]}`, now - age);
    const sim = /launchd_sim\s.*\/Devices\/([0-9A-Fa-f-]{36})\//.exec(args);
    if (sim) keep(`udid:${sim[1]!.toUpperCase()}`, now - age);
  }
  return out;
}

async function starts(): Promise<Map<string, number>> {
  if (isWindows) return new Map();
  const r = await run('ps', ['-A', '-o', 'etime=,args=']);
  return deviceStarts(r.stdout, nowSeconds());
}

const mtime = (p: string): number => {
  try {
    return Math.floor(statSync(p).mtimeMs / 1000);
  } catch {
    return 0;
  }
};
const read = (p: string): string => {
  try {
    return readFileSync(p, 'utf8');
  } catch {
    return '';
  }
};
const list = (dir: string): string[] => {
  try {
    return readdirSync(dir);
  } catch {
    return [];
  }
};
const minutes = (s: number): string => `${Math.max(0, Math.round(s / 60))} min`;

// An owner by the slug its files carry (« claude-41234 »): gone when its pid is, or runs something
// else now. An owner named by hand has no pid to look at, and is never gone.
export function slugOwnerGone(s: string, nameOf: (pid: number) => string = processName): boolean {
  const m = /^(.+)-(\d+)$/.exec(s);
  if (!m) return false;
  const now = nameOf(Number(m[2]));
  if (!now) return true;
  if (m[1] === 'shell') return false;
  return slug(now) !== m[1];
}
const slugOwnerText = (s: string): string => s.replace(/-(\d+)$/, ':$1');

// A claim alive right now, of this owner (by slug) or of anybody's on a device.
function liveClaims(): Array<{ r: string; who: string }> {
  const dir = config().claims;
  const out: Array<{ r: string; who: string }> = [];
  for (const r of list(dir)) {
    if (r.startsWith('.')) continue;
    const f = join(dir, r);
    if (!(nowSeconds() < Number(claimField(f, 'until') || 0))) continue;
    out.push({ r, who: claimField(f, 'owner') });
  }
  return out;
}
const deviceLocked = (r: string): boolean => {
  const d = join(config().locks, r);
  try {
    return statSync(d).isDirectory() && lockAlive(d);
  } catch {
    return false;
  }
};
// The last use of every device, or of one owner's.
function lastUseBy(ownerSlug = ''): number {
  let at = 0;
  for (const r of list(join(config().state, 'used'))) {
    const u = usedRead(r);
    if (ownerSlug && slug(u.who) !== ownerSlug) continue;
    at = Math.max(at, u.at);
  }
  return at;
}

// What any version of vysu leaves on every device call, the installed one included: agent-device's
// journal of the device's session, and the last screen read. The record of use only exists from this
// version on, and an agent still on an older one drives the device without writing it.
function lastTouched(p: Platform, name: string): number {
  const ad = process.env.AGENT_DEVICE_STATE_DIR || join(homedir(), '.agent-device');
  return Math.max(mtime(join(ad, 'sessions', sessionName(p, name), 'events.ndjson')), mtime(join(config().state, `.snap-${p}-${slug(name)}.json`)));
}

// --- stopping what nobody uses -----------------------------------------------------------------

export interface ReapOptions {
  dry?: boolean;
  minutes?: number;
  pressure?: boolean;
  // Also say what is kept, and why (the dry run).
  verbose?: boolean;
  print: (line: string) => void;
}

interface Up {
  p: Platform;
  name: string;
  id: string; // the UDID, or the emulator's serial
}

async function upDevices(): Promise<Up[]> {
  const out: Up[] = [];
  if (isMac) {
    await poolLoad('ios');
    for (const name of iosNames()) {
      const s = poolSim(name);
      if (s?.state === 'Booted') out.push({ p: 'ios', name, id: s.udid });
    }
  }
  await poolLoad('android');
  for (const name of androidNames()) {
    const s = poolSerial(name);
    if (s) out.push({ p: 'android', name, id: s });
  }
  return out;
}

// A simulator is shut down, never Simulator.app quit: quitting it shuts every booted simulator down,
// other owners' included. An emulator is killed through its console, which lets it close cleanly; the
// memory is back once its serial has left adb.
async function stopDevice(d: Up): Promise<boolean> {
  if (d.p === 'ios') return (await xcrun(['simctl', 'shutdown', d.id])).code === 0;
  await adbRaw(['-s', d.id, 'emu', 'kill']);
  for (let i = 0; i < 30; i++) {
    if (!(await emulatorSerials()).includes(d.id)) return true;
    await sleep(1000);
  }
  return false;
}

export async function reapIdle(o: ReapOptions): Promise<number> {
  const idle = o.minutes ?? idleMinutes();
  if (!idle) return 0;
  const limit = o.pressure ? Math.min(idle * 60, PRESSURE_IDLE_SECONDS) : idle * 60;
  const now = nowSeconds();
  const started = await starts();
  let stopped = 0;
  for (const d of await upDevices()) {
    const r = `${d.p}-${slug(d.name)}`;
    const label = `${d.p} « ${d.name} »`;
    const cs = claimState(r);
    if (cs) {
      if (o.verbose) say(`kept: ${label} claimed by ${claimField(join(config().claims, r), 'owner')}`);
      continue;
    }
    if (deviceLocked(r)) {
      if (o.verbose) say(`kept: ${label} in use right now`);
      continue;
    }
    const used = usedRead(r);
    const f = mstateFile(d.p, d.name);
    const stateAt = Number(mstateField(f, 'at')) || 0;
    const bootAt = started.get(d.p === 'ios' ? `udid:${d.id.toUpperCase()}` : `avd:${d.name}`) ?? 0;
    const touched = lastTouched(d.p, d.name);
    const last = Math.max(used.at, stateAt, bootAt, touched);
    // Nothing says when it was used, nor when it booted (Windows has no `ps`): it is left alone.
    if (!last) {
      if (o.verbose) say(`kept: ${label} (no record of its last use)`);
      continue;
    }
    const by = used.at >= Math.max(stateAt, touched) ? used.who : stateAt >= touched ? mstateField(f, 'by') : '';
    const since = last === bootAt && last > Math.max(used.at, stateAt, touched) ? `booted at ${hhmm(last)}, unused since` : `last used${by ? ` by ${by}` : ''} at ${hhmm(last)}`;
    if (now - last < limit) {
      if (o.verbose) say(`kept: ${label} (${since}, idle ${minutes(now - last)})`);
      continue;
    }
    if (o.dry) {
      o.print(`would stop: ${label} (idle ${minutes(now - last)}, ${since})`);
      continue;
    }
    // Under its lock, so a command starting on it meanwhile waits rather than finds it gone.
    if (!lockTry(r)) continue;
    try {
      if (await stopDevice(d)) {
        stopped++;
        o.print(`stopped: ${label} (idle ${minutes(now - last)}, ${since})`);
      }
    } finally {
      lockDrop(r);
    }
  }
  if (stopped) poolForget();
  // A Metro is not what a boot waits for: it keeps the plain idle time even then.
  stopped += await reapMetros(o, idle * 60, now);
  return stopped;
}

// An isolated Metro (1-1.5 GB) whose owner is gone, or whose owner has held no claim and used no
// device for the idle time; the shared Metro, when vysu started it and no device has been claimed or
// used for that long. An owner still there keeps its record, so its next command says its Metro is
// not running instead of moving it silently onto the shared one. The owner running this command is
// using vysu right now: its own Metro is never idle.
async function reapMetros(o: ReapOptions, limit: number, now: number): Promise<number> {
  const state = config().state;
  const me = slug(owner());
  const claims = liveClaims();
  let stopped = 0;
  for (const f of list(state)) {
    if (!f.startsWith('metro-port.')) continue;
    const s = f.slice('metro-port.'.length);
    if (s === me) continue;
    const file = join(state, f);
    const [port = '', pid = '', ...dir] = read(file).replace(/\n$/, '').split(' ');
    // pid 0: being started this very moment.
    if (pid === '0' && now - mtime(file) < 300) continue;
    const gone = slugOwnerGone(s);
    const running = metroPidListening(port, pid);
    const who = slugOwnerText(s);
    let why = 'its owner is gone';
    if (!gone) {
      if (!running) continue;
      if (claims.some((c) => slug(c.who) === s)) continue;
      const last = Math.max(mtime(file), mtime(metroLog(port)), lastUseBy(s));
      if (now - last < limit) continue;
      why = `no claim and no use for ${minutes(now - last)}`;
    }
    const what = `metro :${port} (isolated, of ${who}, from ${dir.join(' ')}; ${why})`;
    if (o.dry) {
      // A record whose Metro is no longer running is only a file: it goes without a line of its own.
      if (running) o.print(`would stop: ${what}`);
      else if (o.verbose) say(`would drop: the record of metro :${port} of ${who} (not running, its owner is gone)`);
      continue;
    }
    if (running) await killPort(Number(port), Number(pid));
    if (gone) rmSync(file, { force: true });
    if (running) {
      stopped++;
      o.print(`stopped: ${what}`);
    }
  }
  for (const f of list(state)) {
    if (!f.startsWith('metro-started.')) continue;
    const port = f.slice('metro-started.'.length);
    const file = join(state, f);
    const [who = '', pid = ''] = read(file).trim().split(' ');
    if (!metroPidListening(port, pid)) continue;
    if (claims.some((c) => /^(ios|android)-/.test(c.r))) continue;
    if (list(config().locks).some((r) => /^(ios|android)-/.test(r) && deviceLocked(r))) continue;
    const last = Math.max(mtime(file), mtime(metroLog(port)), lastUseBy());
    if (now - last < limit) continue;
    const what = `metro :${port} (shared, started by ${who}; no device claimed or used for ${minutes(now - last)})`;
    if (o.dry) {
      o.print(`would stop: ${what}`);
      continue;
    }
    await killPort(Number(port), Number(pid));
    rmSync(file, { force: true });
    stopped++;
    o.print(`stopped: ${what}`);
  }
  return stopped;
}

// The opportunistic pass, from the commands that need room anyway: at most once a minute for the
// whole machine, and never the reason a command fails.
export async function reapSoon(): Promise<void> {
  if (!idleMinutes()) return;
  const stamp = join(config().state, 'reap-at');
  if (nowSeconds() - mtime(stamp) < 60) return;
  try {
    mkdirSync(config().state, { recursive: true });
    writeFileSync(stamp, `${nowSeconds()}\n`);
    await reapIdle({ print: (l) => tell(`vysu: ${l}`) });
  } catch {
    // the next command tries again
  }
}

// `vysu down idle [--minutes N] [--dry-run]`.
export async function downIdle(args: string[]): Promise<void> {
  let dry = false;
  let m: number | undefined;
  for (let i = 0; i < args.length; i++) {
    const a = args[i]!;
    if (a === '--dry-run') dry = true;
    else if (a === '--minutes') {
      m = whole(args[++i] ?? '', -1);
      if (m < 1) die('vysu down idle: --minutes takes a whole number of minutes, 1 or more');
    } else die(`vysu down idle: unknown option ${a}`, 'vysu down idle [--minutes N] [--dry-run]');
  }
  const idle = m ?? idleMinutes();
  if (!idle) die('VYSU_IDLE_MINUTES=0: the idle reaper is off', 'vysu down idle --minutes 15');
  const n = await reapIdle({ dry, minutes: idle, verbose: dry, print: say });
  if (!n && !dry) say(`idle: nothing unused for ${idle} min (VYSU_IDLE_MINUTES)`);
}

// --- room to boot ------------------------------------------------------------------------------

export interface Memory {
  free: number; // percent
  pressure: string; // normal, warn, critical, or '' when the system does not say
}

// `sysctl -n kern.memorystatus_level kern.memorystatus_vm_pressure_level`: the share of memory the
// kernel counts as available, then its pressure level (1 normal, 2 warn, 4 critical).
export function macMemory(out: string): Memory | null {
  const m = /^\s*(\d+)\s+(\d+)?/.exec(out);
  if (!m) return null;
  const level = Number(m[1]);
  const pressure = Number(m[2] ?? 0);
  const p = pressure === 4 ? 'critical' : pressure === 2 ? 'warn' : pressure === 1 ? 'normal' : '';
  return { free: level, pressure: p };
}

export function linuxMemory(meminfo: string): Memory | null {
  const kb = (k: string): number => Number(new RegExp(`^${k}:\\s+(\\d+)`, 'm').exec(meminfo)?.[1] ?? NaN);
  const total = kb('MemTotal');
  const avail = kb('MemAvailable');
  if (!(total > 0) || !Number.isFinite(avail)) return null;
  return { free: Math.round((avail / total) * 100), pressure: '' };
}

export async function readMemory(): Promise<Memory | null> {
  if (isMac) return macMemory((await run('sysctl', ['-n', 'kern.memorystatus_level', 'kern.memorystatus_vm_pressure_level'])).stdout);
  if (isLinux) return linuxMemory(read('/proc/meminfo'));
  return null;
}

// The floor is the kernel's own measure, not swap: on 12/10 this Mac carried 10-11 GB of swap at
// 51-64 % « free » and pressure normal, and swap stays used long after the pressure has gone, so a
// swap gate would have refused every boot for days. Healthy, this Mac reads 50-80 %; 20 % is a
// machine where one more 3-4 GB device is what tips it, and the kernel's warn level says the same
// from its side.
export function memoryBlock(m: Memory | null, floor: number): string {
  if (!m || !floor) return '';
  if (m.pressure === 'warn' || m.pressure === 'critical') return `memory pressure ${m.pressure} (${m.free}% free)`;
  if (m.free < floor) return `${m.free}% of memory free, under VYSU_MEMORY_MIN_FREE=${floor}%`;
  return '';
}

export function budgetBlock(p: Platform, up: number, max: number): string {
  if (!max || up < max) return '';
  return p === 'ios' ? `${up} simulators of the pool booted (VYSU_IOS_MAX_BOOTED=${max})` : `${up} emulators running (VYSU_ANDROID_MAX_RUNNING=${max})`;
}

// What stands in the way of booting this device, or ''.
async function blocked(p: Platform, name: string): Promise<string> {
  poolForget();
  await poolLoad(p);
  const up =
    p === 'ios'
      ? iosNames().filter((n) => n !== name && poolSim(n)?.state === 'Booted').length
      : (pool.emus ?? []).filter((e) => e.avd !== name).length;
  return budgetBlock(p, up, p === 'ios' ? iosMaxBooted() : androidMaxRunning()) || memoryBlock(await readMemory(), memoryFloor());
}

// Everything up on the machine, in the pool or not: whatever counts against the budget or the memory.
async function upReport(): Promise<void> {
  if (isMac) {
    await poolLoad('ios');
    for (const s of pool.sims ?? []) if (s.state === 'Booted') tell(`  ${await poolLine('ios', s.name, 'booted')}`);
  }
  await poolLoad('android');
  for (const e of pool.emus ?? []) tell(`  ${await poolLine('android', e.avd, `running on ${e.serial}`)}`);
}

// Before any boot: room in the budget and in memory, else what nobody uses is stopped, else the boot
// waits VYSU_LOCK_WAIT for a device to stop, then fails naming what runs and who holds it.
export async function admit(p: Platform, name: string): Promise<void> {
  const wait = config().lockWait;
  const t0 = Date.now();
  let said = false;
  let reapedAt = 0;
  for (;;) {
    const why = await blocked(p, name);
    if (!why) return;
    if (Date.now() - reapedAt >= 30000) {
      reapedAt = Date.now();
      if (await reapIdle({ pressure: true, print: (l) => tell(`vysu: ${l}`) })) continue;
    }
    const waited = Math.floor((Date.now() - t0) / 1000);
    if (waited >= wait) {
      tell(`vysu: no room to boot ${p} « ${name} » after ${waited}s: ${why}. What runs:`);
      await upReport();
      die(`${p}: « ${name} » not booted: ${why}`, 'vysu devices (who holds what), then vysu release <platform> / vysu down idle');
    }
    if (!said) {
      tell(`vysu: ${why}: « ${name} » waits up to ${wait}s (VYSU_LOCK_WAIT) for a device to stop. What runs:`);
      await upReport();
      said = true;
    }
    await sleep(5000);
  }
}

// The line `vysu devices` ends on.
export async function budgetLine(): Promise<string> {
  const parts: string[] = [];
  if (isMac) parts.push(`ios ${iosNames().filter((n) => poolSim(n)?.state === 'Booted').length}/${iosMaxBooted()} booted (VYSU_IOS_MAX_BOOTED)`);
  parts.push(`android ${(pool.emus ?? []).length}/${androidMaxRunning()} running (VYSU_ANDROID_MAX_RUNNING)`);
  const m = await readMemory();
  const floor = memoryFloor();
  if (m) parts.push(`memory ${m.free}% free${m.pressure ? `, pressure ${m.pressure}` : ''} (no boot under ${floor}%: VYSU_MEMORY_MIN_FREE)`);
  const idle = idleMinutes();
  parts.push(idle ? `unused devices stop after ${idle} min (VYSU_IDLE_MINUTES)` : 'idle stop off (VYSU_IDLE_MINUTES=0)');
  return `budget: ${parts.join(' · ')}`;
}
