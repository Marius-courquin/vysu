// Who holds what. Several agent sessions share one machine's simulators, emulators and browser
// sessions, and two of them driving the same one interleave their taps. Each command takes the lock
// of what it is about to touch — lazily, in the wrappers everything goes through — and holds it
// until it exits. A claim holds one across several commands.
//
// The files keep the format of every earlier version, byte for byte (a lock directory holding owner,
// pid, since and cmd; a claim file of key=value lines; one device-choice file per owner), so two
// versions installed side by side (an agent on an older checkout) wait on each other's locks.
import { appendFileSync, existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { config, commandLine } from './ctx.ts';
import { die, log, onCleanup } from './errors.ts';
import { isWindows, pidAlive, processEntry, processName } from './host.ts';
import { ANDROID_DEFAULT_AVD, IOS_DEFAULT_DEVICE } from './config.ts';
import { webResource } from './personas.ts';
import { hhmm, nowSeconds, sleep, slug } from './text.ts';
import { armCeiling } from './ceiling.ts';

export type Platform = 'ios' | 'android';

// --- the owner ---------------------------------------------------------------------------------

// The same session runs dozens of vysu commands from as many shells: what they have in common is the
// process that drives them — an agent CLI, or the terminal a human typed in. It is the first ancestor
// that is not plumbing: a shell, an interpreter, a wrapper. Hence « claude:41234 », « codex:5120 »,
// « Terminal:882 ». A CLI shipped as a node script is named after its own binary, so only a bare
// « node » counts as plumbing. A wrapper that times or detaches a command (`/usr/bin/time vysu …`,
// `nice`, `caffeinate`) owns nothing either: it would otherwise be an owner of its own, with no device
// remembered, and the command would drive the config's device instead of the one just claimed.
const PLUMBING = new Set(
  (
    'bash zsh sh dash fish vysu nv rtk python3 python node env xargs timeout script tmux login cmd conhost powershell pwsh wsl ' +
    'time nice nohup caffeinate stdbuf unbuffer sudo'
  ).split(' '),
);
let ownerId = '';

export function owner(): string {
  if (ownerId) return ownerId;
  if (process.env.VYSU_OWNER) return (ownerId = process.env.VYSU_OWNER);
  let pid = process.pid;
  for (let i = 0; i < 20; i++) {
    // This process's own parent needs no question.
    const ppid = pid === process.pid ? process.ppid : (processEntry(pid)?.ppid ?? 0);
    if (!(ppid > 1)) break;
    pid = ppid;
    const name = processEntry(pid)?.name ?? '';
    if (!name || PLUMBING.has(name)) continue;
    ownerId = `${name}:${pid}`;
    break;
  }
  if (!ownerId) ownerId = `shell:${process.ppid}`;
  return ownerId;
}

// An owner detected from its process is « <name>:<pid> »: when that process is gone (the agent
// session ended, crashed, was closed), whatever it holds is held by nobody. A pid handed to another
// program since counts as gone too. « shell:<pid> » names a shell, whose command is zsh or bash.
export function ownerGone(who: string): boolean {
  const at = who.lastIndexOf(':');
  if (at < 0) return false;
  const name = who.slice(0, at);
  const pidText = who.slice(at + 1);
  if (!/^\d+$/.test(pidText)) return false;
  const comm = processName(Number(pidText));
  if (!comm) return true;
  if (name === 'shell') return false;
  return comm !== name;
}

// --- the device a command drives ---------------------------------------------------------------

type ChoiceKind = 'ios-device' | 'android-avd';
const keyOf = (k: ChoiceKind): string => (k === 'ios-device' ? 'IOS_DEVICE' : 'ANDROID_AVD');

// The remembered device choice is per owner: one session running `vysu up android --avd <other>`
// must not move another session's next command onto that AVD. The machine-wide file is still read as
// the fallback, for an owner that never chose and for whatever an older run left behind.
export function deviceFile(kind: ChoiceKind, who = owner()): string {
  return join(config().state, `${kind}.${slug(who)}`);
}

const readTrim = (p: string): string => {
  try {
    return readFileSync(p, 'utf8');
  } catch {
    return '';
  }
};

export function deviceRemember(kind: ChoiceKind, value: string): void {
  mkdirSync(config().state, { recursive: true });
  writeFileSync(deviceFile(kind), value);
}

function deviceChoice(kind: ChoiceKind, fallback: string): string {
  return readTrim(deviceFile(kind)) || readTrim(join(config().state, kind)) || fallback;
}

// The device a command drives, in this order: the environment (one command, on purpose), the choice
// this owner made (`vysu claim ios --device|--any`, `vysu up ios --device`), the config, the
// machine's last choice, the engine's default. The owner's choice sits above the config because a
// config names one device for everybody, and several sessions on one machine each need their own.
function devicePick(kind: ChoiceKind, fallback: string): string {
  const c = config();
  const key = keyOf(kind);
  if (c.origin(key) === 'env') return c.get(key);
  const own = readTrim(deviceFile(kind));
  if (own) return own;
  return c.get(key) || deviceChoice(kind, fallback);
}

// Where the value in force comes from, for `vysu doctor`.
export function deviceOrigin(kind: ChoiceKind): string {
  const c = config();
  if (c.origin(keyOf(kind)) === 'env') return ' (env)';
  if (readTrim(deviceFile(kind))) return ` (remembered for ${owner()})`;
  if (!c.get(keyOf(kind)) && readTrim(join(c.state, kind))) return ' (remembered)';
  return '';
}

// The sub-agents of one session are one owner: the same agent CLI process above them, the same
// environment, nothing that tells them apart. Each claims its own device, each claim becomes the
// owner's choice, and the last one is everybody's: on 23/09 the checker of a Pixel 4a sent a restart
// to the Pixel 8 a sibling checker had claimed. While an owner holds two devices of a platform, a
// command that does not name its device is therefore refused rather than aimed at whichever was
// claimed last.
class Devices {
  private resolved = false;
  private _ios = '';
  private _android = '';
  iosNamed = false;
  androidNamed = false;

  private resolve(): void {
    if (this.resolved) return;
    this.resolved = true;
    this._ios = devicePick('ios-device', IOS_DEFAULT_DEVICE);
    this._android = devicePick('android-avd', ANDROID_DEFAULT_AVD);
    if (config().origin('IOS_DEVICE') === 'env') this.iosNamed = true;
    if (config().origin('ANDROID_AVD') === 'env') this.androidNamed = true;
  }
  get ios(): string {
    this.resolve();
    return this._ios;
  }
  set ios(v: string) {
    this.resolve();
    this._ios = v;
  }
  get android(): string {
    this.resolve();
    return this._android;
  }
  set android(v: string) {
    this.resolve();
    this._android = v;
  }
  of(p: Platform): string {
    return p === 'ios' ? this.ios : this.android;
  }
  // This command says which device (environment, --device, --avd, a pick).
  named(p: Platform): void {
    this.resolve();
    if (p === 'ios') this.iosNamed = true;
    else this.androidNamed = true;
  }
  isNamed(p: Platform): boolean {
    this.resolve();
    return p === 'ios' ? this.iosNamed : this.androidNamed;
  }
}
export const devices = new Devices();

export function deviceEnv(p: Platform, device: string): string {
  return p === 'ios' ? `VYSU_IOS_DEVICE="${device}"` : `VYSU_ANDROID_AVD=${device}`;
}

// The devices this owner holds a live claim on.
export function ownerDevices(p: Platform): string[] {
  const out: string[] = [];
  const dir = config().claims;
  for (const f of listDir(dir)) {
    if (!f.startsWith(`${p}-`)) continue;
    const file = join(dir, f);
    if (claimField(file, 'owner') !== owner()) continue;
    if (!(nowSeconds() < Number(claimField(file, 'until') || 0))) continue;
    // A claim written before 0.5.1 has no device= line: its resource says which one it is.
    out.push(claimField(file, 'device') || f);
  }
  return out;
}

export function deviceGuard(p: Platform): void {
  if (devices.isNamed(p)) return;
  const held = ownerDevices(p);
  // Settled once per command: every device call goes through the lock, and reading the claims each
  // time would cost more than the call.
  if (held.length < 2) {
    devices.named(p);
    return;
  }
  die(
    `${p}: ${owner()} holds ${held.length} devices (${held.join(', ')}) and this command names none. The sub-agents of one session are one owner, and the device it remembers is the last one any of them claimed`,
    `${deviceEnv(p, '<yours>')} ${commandLine()}   (on every command while this owner holds several)`,
  );
}

export function resourceOf(what: string): string {
  if (what === 'ios') return `ios-${slug(devices.ios)}`;
  if (what === 'android') return `android-${slug(devices.android)}`;
  if (/^(ios|android|web)-/.test(what)) return what;
  return webResource(what);
}

// --- locks ---------------------------------------------------------------------------------------

function listDir(dir: string): string[] {
  try {
    return readdirSync(dir);
  } catch {
    return [];
  }
}

const lockPid = (dir: string): number => Number(readTrim(join(dir, 'pid')).trim() || 0);
// A lock is alive while its process is. One with no pid yet is being taken this very moment — its
// holder made the directory and writes the pid next — so it counts as alive for a few seconds: two
// agents starting within a few milliseconds of each other otherwise both deleted it as a dead one and
// both drove the same session. On Windows a pid comes back quickly after a vysu is killed without its
// cleanups, so the process must also still be a vysu (node or bun).
export function lockAlive(dir: string): boolean {
  const pid = lockPid(dir);
  if (!pid) {
    try {
      return Date.now() - statSync(dir).mtimeMs < 5000;
    } catch {
      return false;
    }
  }
  if (!pidAlive(pid)) return false;
  return !isWindows || ['node', 'bun'].includes(processName(pid).toLowerCase());
}

// Who holds it, doing what, for how long. The holder writes its identity just after the mkdir that
// publishes the lock, and a waiter that started at the same moment lands in between: one beat is all
// it takes to read a full lock.
export async function lockWho(dir: string): Promise<string> {
  if (!readTrim(join(dir, 'since'))) await sleep(200);
  const since = Number(readTrim(join(dir, 'since')).trim() || nowSeconds());
  return `${readTrim(join(dir, 'owner')) || '?'} running « ${readTrim(join(dir, 'cmd')) || '?'} » for ${nowSeconds() - since}s`;
}

// Who is driving a resource at this moment without a claim on it: '' when nobody, or this process, is.
export async function lockBusy(r: string): Promise<string> {
  const dir = join(config().locks, r);
  if (!isDir(dir) || !lockAlive(dir) || lockPid(dir) === holder()) return '';
  return lockWho(dir);
}

const held = new Set<string>();
let releaseRegistered = false;

// Whose pid a lock carries. A vysu that another one starts for the length of a call — the
// primitives a bash auth connector calls back into, one process each — takes its locks in the name
// of that parent: a lock the parent holds is its own, one it takes outlives it and goes when the
// parent exits, and nothing it holds is left free between two of the connector's calls.
let holderPid = 0;
function holder(): number {
  if (holderPid) return holderPid;
  const parent = Number(process.env.VYSU_LOCK_HOLDER);
  holderPid = parent > 0 && parent !== process.pid && pidAlive(parent) ? parent : process.pid;
  return holderPid;
}

// Every lock carrying this pid, and only those, whichever way the command ends.
function releaseAll(): void {
  const dir = config().locks;
  for (const r of listDir(dir)) {
    const d = join(dir, r);
    if (lockPid(d) !== process.pid) continue;
    rmSync(d, { recursive: true, force: true });
    if (isDevice(r)) usedMark(r);
  }
}
// For a process whose children take locks in its name: it may take none itself and still has theirs
// to give back. What their locks say is running is its command, not the child's internal one.
export function releaseOnExit(): { VYSU_LOCK_HOLDER: string; VYSU_LOCK_CMD: string } {
  if (!releaseRegistered) {
    releaseRegistered = true;
    onCleanup(releaseAll, true, true);
  }
  return { VYSU_LOCK_HOLDER: String(process.pid), VYSU_LOCK_CMD: commandLine() };
}

// Every state folder that ever held a lock or a claim, one per line in ~/.vysu/states: a project may
// keep its state anywhere (VYSU_STATE), and the idle reaper of another project has to read its claims
// before it stops a simulator they share.
export const STATES_FILE = join(homedir(), '.vysu', 'states');
let stateKnown = false;
export function stateRegister(dir = config().state): void {
  if (stateKnown) return;
  stateKnown = true;
  try {
    const known = existsSync(STATES_FILE) ? readFileSync(STATES_FILE, 'utf8').split('\n') : [];
    if (known.includes(dir)) return;
    mkdirSync(dirname(STATES_FILE), { recursive: true });
    appendFileSync(STATES_FILE, `${dir}\n`);
  } catch {
    // a read-only home: the reaper then reads ~/.vysu/* alone
  }
}

// Waits for a foreign lock or claim, then holds the resource until this process exits.
export async function lockTake(r: string): Promise<void> {
  if (held.has(r)) return;
  stateRegister();
  const c = config();
  const dir = join(c.locks, r);
  mkdirSync(c.locks, { recursive: true });
  if (!releaseRegistered) {
    releaseRegistered = true;
    onCleanup(releaseAll, true, true);
  }
  if (lockPid(dir) === holder()) {
    held.add(r);
    return;
  }
  const wait = c.lockWait;
  // Everything the lock will say is known before the mkdir that publishes it: finding the owner walks
  // the process tree, and a lock left without its pid meanwhile looked dead to a waiter.
  const me = owner();
  const pid = String(holder());
  const cmd = holder() === process.pid ? commandLine() : (process.env.VYSU_LOCK_CMD ?? commandLine());
  let i = 0;
  for (;;) {
    let why = claimWhy(r);
    if (!why) {
      // A lock whose process is gone is an agent that crashed: it must not hold the device for good.
      if (isDir(dir) && !lockAlive(dir)) rmSync(dir, { recursive: true, force: true });
      if (mkdirOnce(dir)) {
        writeFileSync(join(dir, 'pid'), pid);
        writeFileSync(join(dir, 'owner'), me);
        writeFileSync(join(dir, 'since'), `${nowSeconds()}\n`);
        writeFileSync(join(dir, 'cmd'), cmd);
        held.add(r);
        claimRenew(r);
        if (isDevice(r)) {
          usedMark(r);
          claimsKeep();
          armCeiling();
        }
        if (i > 0) process.stderr.write(`vysu: ${r} taken after ${Math.floor(i / 2)}s\n`);
        return;
      }
      why = `busy — ${await lockWho(dir)} (VYSU_LOCK_WAIT=${wait} to wait longer)`;
    }
    if (i >= wait * 2) die(`${r} ${why}`);
    if (i === 0) process.stderr.write(`vysu: ${r} ${why} — waiting\n`);
    i++;
    await sleep(500);
  }
}

// The lock, taken only if nobody holds it or claims it right now: the idle reaper stops a device
// under it, and never waits for one somebody is driving.
export function lockTry(r: string): boolean {
  if (held.has(r)) return true;
  const c = config();
  const dir = join(c.locks, r);
  mkdirSync(c.locks, { recursive: true });
  if (!releaseRegistered) {
    releaseRegistered = true;
    onCleanup(releaseAll, true, true);
  }
  if (claimWhy(r)) return false;
  if (isDir(dir) && !lockAlive(dir)) rmSync(dir, { recursive: true, force: true });
  if (!mkdirOnce(dir)) return false;
  writeFileSync(join(dir, 'pid'), String(process.pid));
  writeFileSync(join(dir, 'owner'), owner());
  writeFileSync(join(dir, 'since'), `${nowSeconds()}\n`);
  writeFileSync(join(dir, 'cmd'), commandLine());
  held.add(r);
  return true;
}

// One lock given back before the command ends (the pool lock of claim --any).
export function lockDrop(r: string): void {
  const d = join(config().locks, r);
  if (lockPid(d) === process.pid) rmSync(d, { recursive: true, force: true });
  held.delete(r);
}

export async function iosLock(): Promise<void> {
  deviceGuard('ios');
  await lockTake(`ios-${slug(devices.ios)}`);
}
export async function androidLock(): Promise<void> {
  deviceGuard('android');
  await lockTake(`android-${slug(devices.android)}`);
}
export const platformLock = (p: Platform): Promise<void> => (p === 'ios' ? iosLock() : androidLock());

function isDir(p: string): boolean {
  try {
    return statSync(p).isDirectory();
  } catch {
    return false;
  }
}

// `mkdir` is the acquire: atomic everywhere, and it leaves the holder readable inside.
function mkdirOnce(p: string): boolean {
  try {
    mkdirSync(p);
    return true;
  } catch {
    return false;
  }
}

// What is held right now: a lock whose process is gone is left out, the next command that waits
// drops it.
export async function locksReport(): Promise<string[]> {
  const c = config();
  const lines: string[] = [];
  for (const r of listDir(c.locks)) {
    const d = join(c.locks, r);
    if (!isDir(d) || !lockAlive(d)) continue;
    lines.push(`lock: ${r} — ${await lockWho(d)}`);
  }
  for (const r of listDir(c.claims)) {
    const f = join(c.claims, r);
    if (r.startsWith('.') || !isFileSync(f)) continue;
    claimWhy(r);
    if (!isFileSync(f)) continue;
    const u = Number(claimField(f, 'until') || 0);
    const note = claimField(f, 'note');
    lines.push(`claim: ${r} — ${claimField(f, 'owner')} until ${hhmm(u)} (${Math.trunc((u - nowSeconds()) / 60)} min left)${note ? ` « ${note} »` : ''}`);
  }
  return lines;
}

function isFileSync(p: string): boolean {
  try {
    return statSync(p).isFile();
  } catch {
    return false;
  }
}

// --- last use ------------------------------------------------------------------------------------

export const isDevice = (r: string): boolean => /^(ios|android)-/.test(r);

// When each device was last driven, and by whom: what the idle reaper (mobile/reap.ts) measures from.
// Written when a command takes the device and again when it lets it go, so a command killed without
// its cleanups still leaves the time it started. A file per device, « <owner> <seconds> ».
export const usedFile = (r: string): string => join(config().state, 'used', r);

export function usedMark(r: string): void {
  try {
    mkdirSync(join(config().state, 'used'), { recursive: true });
    writeFileSync(usedFile(r), `${owner()} ${nowSeconds()}\n`);
  } catch {
    // a state folder gone read-only must not fail the command that only wanted to note the time
  }
}

export function usedRead(r: string): { who: string; at: number } {
  const [who = '', at = '0'] = readTrim(usedFile(r)).trim().split(' ');
  return { who, at: Number(at) || 0 };
}

// --- claims --------------------------------------------------------------------------------------

// A lock lasts one command; a mobile task lasts twenty. A claim says « this device is mine until
// then », and every other agent's command waits on it exactly as it waits on a lock.
export const CLAIM_MINUTES = 20;

export function claimField(file: string, key: string): string {
  for (const line of readTrim(file).split('\n')) if (line.startsWith(`${key}=`)) return line.slice(key.length + 1);
  return '';
}

// Own claims are transparent, expired ones are gone, and so is one whose owner's process is: 14
// claims of the 21-23/09 sessions outlived their agent and held a device until their hour came.
export function claimWhy(r: string): string {
  const dir = config().claims;
  const f = join(dir, r);
  if (!isFileSync(f)) return '';
  const who = claimField(f, 'owner');
  const until = Number(claimField(f, 'until') || 0);
  if (who === owner()) return '';
  if (!(nowSeconds() < until)) {
    // Kept aside under a dot name, so its owner's `release` says it had expired instead of « no
    // claim »: 50 releases of the audit (25/09-12/10) answered that to a checker whose claim had run
    // out under it, and it could not tell whether it had ever held the device.
    try {
      renameSync(f, expiredFile(r));
    } catch {
      rmSync(f, { force: true });
    }
    return '';
  }
  if (ownerGone(who)) {
    // Moved aside before it is removed: of two commands finding the same orphan, one says so.
    const aside = join(dir, `.${r}.gone.${process.pid}`);
    try {
      renameSync(f, aside);
      rmSync(aside, { force: true });
      ownerForget(who);
      log(`claim of ${who} on ${r} dropped: its process is gone`);
    } catch {
      // the other command got there first
    }
    return '';
  }
  return `claimed by ${who} until ${hhmm(until)} (vysu release ${r} --force to take it over)`;
}

export const expiredFile = (r: string): string => join(config().claims, `.${r}.expired`);

// An owner's device choices, which nobody will read again.
export function ownerForget(who: string): void {
  rmSync(deviceFile('ios-device', who), { force: true });
  rmSync(deviceFile('android-avd', who), { force: true });
}

// A claim lives as long as its owner uses it: each command that takes the device pushes the end
// `minutes=` further, so a long task never loses its device halfway, and a forgotten claim still ends
// that long after its last use. Never shortened: a claim renewed by hand for longer keeps it.
export function claimRenew(r: string): void {
  const dir = config().claims;
  const f = join(dir, r);
  if (!isFileSync(f) || claimField(f, 'owner') !== owner()) return;
  const minutes = Number(claimField(f, 'minutes') || CLAIM_MINUTES);
  const until = Number(claimField(f, 'until') || 0);
  const next = nowSeconds() + minutes * 60;
  if (!(next > until)) return;
  const lines = readTrim(f)
    .split('\n')
    .filter((l) => l && !l.startsWith('until='));
  const tmp = join(dir, `.${r}.renew.${process.pid}`);
  writeFileSync(tmp, `${[...lines, `until=${next}`].join('\n')}\n`);
  renameSync(tmp, f);
}

// A claim is renewed when a command takes the device, and a command can run longer than the claim has
// left: a 25-minute `mdo` outlived its claim, and the sibling checker that claimed the device meanwhile
// drove it under the first one's steps. While this process holds a device, its claim is renewed every
// minute.
let keeping: ReturnType<typeof setInterval> | undefined;
function claimsKeep(): void {
  if (keeping) return;
  keeping = setInterval(() => {
    for (const r of held) if (isDevice(r)) claimRenew(r);
  }, 60000);
  keeping.unref();
}

export function claimWrite(r: string, minutes: number, note: string, device = ''): void {
  stateRegister();
  const dir = config().claims;
  mkdirSync(dir, { recursive: true });
  const lines = [`owner=${owner()}`, `until=${nowSeconds() + minutes * 60}`, `minutes=${minutes}`, `note=${note}`];
  // The device by its own name (the resource is a slug of it): what a refused command lists.
  if (device) lines.push(`device=${device}`);
  const tmp = join(dir, `.${r}.new.${process.pid}`);
  writeFileSync(tmp, `${lines.join('\n')}\n`);
  renameSync(tmp, join(dir, r));
}

export function claimFile(r: string): string {
  return join(config().claims, r);
}
