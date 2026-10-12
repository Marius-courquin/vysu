// How long a mobile command may hold a device. A command waits on a device that never answers as
// long as the device takes: an `mshot` held the Android lock for 45 minutes, an `up android
// --isolated` for 21, a checker's `mwait` for seven hours (audit of 25/09-12/10), and every other
// agent queued behind the lock. Agents reached for `timeout 300 vysu …` 83 times, on a Mac that has no
// `timeout`. The ceiling is armed when the command takes its first device, and past it the command
// stops what it started, gives its locks back and exits 124, the status `timeout` itself uses.
//
// A script of steps (`mdo`, `mflow`, `mrec`) is bounded per step rather than as a whole: a 25-minute
// `mdo` of the audit was working all along, and a wall clock cut it as if it hung. Each step starts
// the count again. A stream (`simctl … log stream`, `simctl io … recordVideo`, `adb logcat`) runs
// until the person stops it, and has no ceiling at all.
import { spawnSync } from 'node:child_process';
import { commandArgs, commandLine, config } from './ctx.ts';
import { runCleanups } from './errors.ts';
import { descendants, isWindows } from './host.ts';
import { killTree } from './proc.ts';
import { sleep } from './text.ts';

// What boots a device or logs a persona in gets twice the base: their p99 in the audit was 200-460 s on
// a loaded machine, against under 100 s for a capture or a tap. A step runner gets the base per step,
// and twice that for a step that relaunches the app.
const LONG = new Set(['up', 'claim', 'mlogin', 'mrelaunch', 'release']);
const STEPPED = new Set(['mdo', 'mflow', 'mrec']);
export const MOBILE_TIMEOUT_DEFAULT = 300;

export function mobileTimeoutBase(raw: string): number {
  const n = Number(raw);
  return raw.trim() !== '' && Number.isFinite(n) && n >= 0 ? n : MOBILE_TIMEOUT_DEFAULT;
}

// Seconds this command may run once it holds a device (a step runner: one step may run); 0: no
// ceiling.
export function ceilingSeconds(cmd: string, base: number, long = false): number {
  if (!(base > 0)) return 0;
  if (STEPPED.has(cmd)) return long ? base * 2 : base;
  return LONG.has(cmd) ? base * 2 : base;
}
export const ceilingStepped = (cmd: string): boolean => STEPPED.has(cmd);

// A passthrough that streams until it is stopped: `vysu simctl spawn booted log stream`, `vysu simctl
// io booted recordVideo out.mov`, `vysu adb logcat` (not `-d`, `-c`, `-t`, `-g`, which print and end).
export function streaming(args: string[]): boolean {
  const [cmd, ...rest] = args;
  if (cmd === 'simctl') return rest.includes('recordVideo') || rest.some((a, i) => a === 'log' && rest[i + 1] === 'stream');
  if (cmd === 'adb') {
    const at = rest.indexOf('logcat');
    if (at < 0) return false;
    return !rest.slice(at + 1).some((a) => /^(-[dctgS]|--dump|--clear|--buffer-size|--statistics)$/.test(a) || /^-t\d/.test(a));
  }
  return false;
}

export interface ProcRow {
  pid: number;
  ppid: number;
  pgid: number;
  args: string;
}

export function parsePs(text: string): ProcRow[] {
  const out: ProcRow[] = [];
  for (const line of text.split('\n')) {
    const m = /^\s*(\d+)\s+(\d+)\s+(\d+)\s?(.*)$/.exec(line);
    if (m) out.push({ pid: Number(m[1]), ppid: Number(m[2]), pgid: Number(m[3]), args: m[4] ?? '' });
  }
  return out;
}

// What the command started and still waits on: the processes below it in its own process group. What
// it started detached (an emulator, Metro, a log tail) leads a group of its own, and so does all that
// runs under it: those outlive the command on purpose and are left alone. The shell a command runs in
// shares its group but sits above it, and a pipe's other end beside it: neither is below.
export function strayChildren(rows: ProcRow[], self: number): ProcRow[] {
  const me = rows.find((r) => r.pid === self);
  if (!me) return [];
  const out: ProcRow[] = [];
  const walk = (parent: number): void => {
    for (const r of rows) {
      if (r.ppid !== parent || r.pgid !== me.pgid || out.includes(r)) continue;
      out.push(r);
      walk(r.pid);
    }
  };
  walk(self);
  return out;
}

// What the command was doing, for the line that says it was stopped: the phase it announced, else the
// first thing it was waiting on.
let doing = '';
export function ceilingDoing(what: string): void {
  doing = what;
}
export function doingLine(phase: string, waiting: ProcRow[]): string {
  if (phase) return phase;
  const first = waiting[0];
  if (!first) return 'waiting on the device';
  const words = first.args.trim().split(/\s+/);
  // A script is named after itself, not after the interpreter that runs it (node, sh).
  if (/(^|\/)(node|bun|sh|bash|zsh|python3?)$/.test(words[0] ?? '') && (words[1] ?? '').includes('/')) words.shift();
  words[0] = (words[0] ?? '').replace(/.*\//, '');
  let cmd = words.join(' ');
  if (cmd.length > 80) cmd = `${cmd.slice(0, 77)}...`;
  return `running « ${cmd} »`;
}

function children(): ProcRow[] {
  if (isWindows) return descendants(process.pid).map((pid) => ({ pid, ppid: 0, pgid: 0, args: '' }));
  const r = spawnSync('ps', ['-A', '-o', 'pid=,ppid=,pgid=,args='], { encoding: 'utf8' });
  // The `ps` reading the table is in it, our child too: between two polls it was all a step had
  // running, and the stop line named it.
  return strayChildren(parsePs(r.stdout ?? ''), process.pid).filter((c) => c.pid !== r.pid);
}

let armed: ReturnType<typeof setTimeout> | undefined;
let perStep = false;

function arm(seconds: number): void {
  if (armed) clearTimeout(armed);
  armed = setTimeout(() => void stop(seconds), seconds * 1000);
  armed.unref();
}

const cmdName = (): string => commandArgs()[0] ?? commandLine().split(' ')[1] ?? '';

export function armCeiling(): void {
  if (armed) return;
  if (streaming(commandArgs())) return;
  const name = cmdName();
  const seconds = ceilingSeconds(name, mobileTimeoutBase(config().get('MOBILE_TIMEOUT')));
  if (!seconds) return;
  perStep = ceilingStepped(name);
  arm(seconds);
}

// A step runner moved on to its next step (`long`: one that relaunches the app): the count starts
// again. Nothing to do for a command whose ceiling is not armed yet, or is a wall clock.
export function ceilingStep(long = false): void {
  if (!armed || !perStep) return;
  arm(ceilingSeconds(cmdName(), mobileTimeoutBase(config().get('MOBILE_TIMEOUT')), long));
}

async function stop(seconds: number): Promise<void> {
  const waiting = children();
  let cmd = commandLine().replace(/^vysu /, '');
  if (cmd.length > 60) cmd = `${cmd.slice(0, 57)}...`;
  const after = perStep ? `stopped: one step ran ${seconds}s` : `stopped after ${seconds}s`;
  process.stderr.write(`vysu: ${cmd} ${after} (VYSU_MOBILE_TIMEOUT) while ${doingLine(doing, waiting)}\n`);
  // The command's own code resumes as soon as what it waited on is killed, and ends with its own
  // status: the exit is 124 whichever way it gets there.
  const exit = process.exit.bind(process);
  process.exit = ((_code?: number) => exit(124)) as typeof process.exit;
  for (const c of waiting) killTree(c.pid, 'SIGTERM');
  await sleep(1500);
  for (const c of children()) killTree(c.pid, 'SIGKILL');
  // The locks are a sync cleanup the exit hook runs anyway: a recorder's stop that hangs in turn must
  // not keep the device held past the ceiling that was meant to free it.
  await Promise.race([runCleanups(), sleep(15000)]);
  exit(124);
}
