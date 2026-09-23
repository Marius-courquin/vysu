// A mobile screen driven in one call: `mdo` runs a list of steps and answers each with one line (✓ /
// ✗, what it did) and what the screen shows after it, `mwait` waits for a text (or for its absence, or
// for a screen at rest) in one line. An agent used to spend a press, a sleep, a snapshot and a grep per
// action, and wrote its own step.sh / next-until.sh / scrollfind.sh around them; the verbs those
// scripts were made of are in `mobileStep`, so `mflow` and `mrec` read them too.
import { existsSync, readFileSync, rmSync, statSync } from 'node:fs';
import { basename, join } from 'node:path';
import { config } from '../core/ctx.ts';
import { SHEET_EDGE } from '../core/config.ts';
import { die, exit, VysuError } from '../core/errors.ts';
import { deviceGuard, devices, lockTake, resourceOf, type Platform } from '../core/hold.ts';
import { slug } from '../core/text.ts';
import { sheet } from '../img/sheet.ts';
import { adCall, calls } from './agent.ts';
import { androidSelect, androidSerial, forgetSerial } from './device.ts';
import { Captured, captured, quiet, say, tell } from './io.ts';
import { mobileApp, mrelaunch, sessionOpen } from './launch.ts';
import { mscreen, mscreenReset, snapFile, snapState } from './screen.ts';
import { mobileStep, mwaitGone, mwaitIdle, mwaitText, shotRun } from './steps.ts';
import { mstateGet } from './state.ts';
import { secondsOk, shellWords } from './words.ts';
import { xcrun } from './tools.ts';

// The device a command drives, taken before its first step: the « waiting for … » line of a busy
// device then reaches the caller, instead of vanishing into the output a step is read back from.
async function mdoLock(p: Platform): Promise<void> {
  deviceGuard(p);
  await lockTake(resourceOf(p));
  if (p === 'android') await androidSelect();
}
// The device every following call addresses, lock and claim included.
function mdoUse(p: Platform, device: string): void {
  if (p === 'ios') devices.ios = device;
  else {
    if (devices.android !== device) forgetSerial();
    devices.android = device;
  }
}
// A matrix names devices the machine may not be running: said before the first step, with the fix.
async function mdoReady(p: Platform, device: string): Promise<void> {
  if (p === 'ios') {
    const r = await xcrun(['simctl', 'list', 'devices', 'booted', '-j']);
    let booted = false;
    try {
      const d = (JSON.parse(r.stdout) as { devices?: Record<string, Array<{ name?: string }>> }).devices ?? {};
      booted = Object.values(d).some((list) => list.some((x) => x.name === device));
    } catch {
      booted = false;
    }
    if (!booted) die(`ios: « ${device} » is not booted`, `vysu up ios --device "${device}"`);
  } else if (!(await androidSerial())) die(`android: ${device} is not running`, `vysu up android --avd ${device}`);
}
// Reading the tree needs an agent-device session on that device; the first one on a simulator costs
// the runner's build (up to a minute), which is why it is only opened when missing.
async function mdoSession(p: Platform): Promise<void> {
  if (await sessionOpen(p)) return;
  tell(`vysu: opening an agent-device session on ${devices.of(p)} (the first one takes up to a minute)`);
  if (!(await adCall(p, calls.open(mobileApp(p), { foreground: true }))).ok) {
    die(`${p}: no agent-device session on ${devices.of(p)}`, `vysu ${p} open "${mobileApp(p)}" --foreground`);
  }
}

// A step as its ✓ line prints it: the value of a `fill` is not echoed back (it may be a password).
export function mdoEcho(step: string): string {
  if (step.startsWith('fill ')) {
    try {
      const w = shellWords(step.slice(5));
      return `fill "${w[0] ?? ''}" (${[...(w[1] ?? '')].length} chars)`;
    } catch {
      // said as written
    }
  }
  return step;
}
// Why a step failed, in the words of its last line on stderr, without the « vysu: ios: » prefix or the
// « (vysu … snapshot -i) » hint: the screen line that follows it is the better hint.
export function mdoReason(err: string[], out: string[] = []): string {
  const pick = (ls: string[], skipNext: boolean): string =>
    [...ls]
      .flatMap((l) => l.split('\n'))
      .filter((l) => l.trim() !== '' && !(skipNext && l.startsWith('next: ')))
      .pop() ?? '';
  let line = pick(err, true) || pick(out, false);
  // Twice: a die adds its own « vysu: » in front of a message that may already carry one.
  for (const pre of ['vysu: ', 'vysu: ', 'ios: ', 'android: ']) if (line.startsWith(pre)) line = line.slice(pre.length);
  if (line.endsWith(')')) {
    const at = line.lastIndexOf(' (vysu ');
    if (at >= 0) line = line.slice(0, at);
  }
  return line || 'failed';
}
// The step's last line, a capture shown by its file name.
export function mdoDetail(out: string[]): string {
  const line = out.flatMap((l) => l.split('\n')).filter((l) => l.trim() !== '').pop() ?? '';
  return /^\/.*\.png$/.test(line) ? basename(line) : line;
}

// What a run leaves to be undone if vysu dies halfway through a step (a lock given up, an i18n key that
// does not exist): the devices whose text size it changed, and the one the command started on.
const run = { platform: 'ios' as Platform, home: '', changed: [] as string[], failed: 0, n: 0 };

// One step: ✓ / ✗, its number, the step as written, what it answered — then the screen after it.
async function mdoStep(p: Platform, shots: string, n: number, step: string): Promise<boolean> {
  let ok: boolean;
  let out: string[];
  let err: string[];
  try {
    const r = await captured(() => mobileStep(p, shots, step));
    ok = r.value;
    out = r.out;
    err = r.err;
  } catch (e) {
    // A die inside the step: said as the step's ✗, its « next: » on stderr, the text sizes put back.
    const inner = e instanceof Captured ? e.inner : e;
    if (!(inner instanceof VysuError)) throw inner;
    const c = e as Captured;
    say(`✗ ${n} ${mdoEcho(step)} · ${mdoReason([...c.err, `vysu: ${inner.message}`])}`);
    if (inner.next) process.stderr.write(`next: ${inner.next}\n`);
    await mdoRestore(p);
    exit(1);
  }
  if (ok) {
    const detail = step === 'screen' ? '' : mdoDetail(out);
    say(`✓ ${n} ${mdoEcho(step)}${detail ? ` · ${detail}` : ''}`);
  } else {
    say(`✗ ${n} ${mdoEcho(step)} · ${mdoReason(err, out)}`);
  }
  if (step === 'screen' && ok) say(`  ${out.flatMap((l) => l.split('\n')).pop() ?? ''}`);
  else say(`  ${await mscreen(p, snapState.fresh)}`);
  return ok;
}

// The steps once, on the device in force, numbered from 1 in every run of a matrix: « ✗ 3 » is the
// third step the caller wrote, whichever device and text size it failed on. False when the run has to
// stop there (a failure without --keep-going).
async function mdoRun(p: Platform, shots: string, keep: boolean, steps: string[]): Promise<boolean> {
  await mdoSession(p);
  await mscreenReset(p);
  let n = 0;
  for (const step of steps) {
    n++;
    run.n++;
    if (await mdoStep(p, shots, n, step)) continue;
    run.failed++;
    if (!keep) return false;
  }
  return true;
}

// Back to normal text on every device the run changed, and back to the device the command started on:
// the next command, and the next agent, find them the way they were.
async function mdoRestore(p: Platform): Promise<void> {
  if (!run.changed.length) return;
  const changed = run.changed;
  run.changed = [];
  for (const dev of changed) {
    mdoUse(p, dev);
    await quiet(() => mrelaunch(p, ['--textsize', 'normal']));
    say(`restored: ${dev} · textsize normal`);
  }
  if (run.home) mdoUse(p, run.home);
}

const trim = (s: string): string => s.replace(/^\s+/, '').replace(/\s+$/, '');

export const MDO_USAGE =
  'usage: vysu mdo ios|android [--shots <name>] [--keep-going] [--devices "<a>,<b>"] [--textsize "normal,xl"] -- "<step>" …  |  vysu mdo ios|android <file|-> [options]';

export async function mdo(argv: string[]): Promise<number> {
  const p = argv[0] ?? '';
  if (p !== 'ios' && p !== 'android') die(MDO_USAGE);
  let shots = '';
  let keep = false;
  let devList = '';
  let sizes = '';
  let file = '';
  let given = false;
  let steps: string[] = [];
  for (let i = 1; i < argv.length; i++) {
    const a = argv[i]!;
    const v = (): string => argv[++i] ?? '';
    if (a === '--shots') shots = v();
    else if (a === '--keep-going') keep = true;
    else if (a === '--devices') devList = v();
    else if (a === '--textsize') sizes = v();
    else if (a === '--') {
      given = true;
      steps = argv.slice(i + 1);
      break;
    } else if (a === '-') file = '-';
    else if (a.startsWith('-')) die(`vysu mdo: unknown option ${a} (steps go after --)`);
    else {
      if (file) die(MDO_USAGE);
      file = a;
    }
  }
  if (given && file) die('vysu mdo: steps after -- or a file, not both');
  if (devList) devices.named(p); // a matrix says which devices, every one of them
  if (file) {
    if (file !== '-' && !(existsSync(file) && statSync(file).isFile())) die(`no step file « ${file} » (steps go after --: vysu mdo ${p} -- "<step>" …)`);
    const text = file === '-' ? readFileSync(0, 'utf8') : readFileSync(file, 'utf8');
    steps = text.split('\n');
    if (steps[steps.length - 1] === '') steps.pop();
  }
  // Blank lines and comments are not steps: the numbers an agent reads are the ones it wrote.
  const todo = steps.map(trim).filter((s) => s !== '' && !s.startsWith('#'));
  if (!todo.length) die(MDO_USAGE);
  // A capture needs a folder: one is named for the run when the caller did not give one.
  if (!shots && todo.some((s) => s.startsWith('shot '))) {
    const d = new Date();
    const pad = (x: number): string => String(x).padStart(2, '0');
    shots = `mdo-${p}-${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}-${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}`;
  }
  for (const t of sizes.split(',').filter((x) => x.trim() !== '')) {
    if (!['normal', 'large', 'xl'].includes(t.trim())) die(`vysu mdo: --textsize takes normal, large and xl (not « ${t.trim()} »)`);
  }
  run.platform = p;
  run.home = devices.of(p);
  run.changed = [];
  run.failed = 0;
  run.n = 0;
  shotRun.taken = [];
  shotRun.prefix = '';
  const matrix = !!(devList || sizes);
  if (!devList) devList = run.home;
  const devs = devList.split(',').map(trim).filter(Boolean);
  // Every device named is checked before the first step runs: a matrix that dies on its third device
  // has already spent the first two.
  if (devList !== run.home) {
    for (const d of devs) {
      mdoUse(p, d);
      await mdoReady(p, d);
    }
  }
  // `-`: the text size the device already has, left alone.
  const tsizes = sizes ? sizes.split(',').map(trim).filter(Boolean) : ['-'];
  let stop = false;
  for (const d of devs) {
    mdoUse(p, d);
    await mdoLock(p);
    const dslug = slug(d).replace(/-$/, '');
    for (const size of tsizes) {
      let nowSize = mstateGet(p, 'textsize', 'normal');
      let note = '';
      if (size !== '-' && size !== nowSize) {
        await mdoSession(p);
        await quiet(() => mrelaunch(p, ['--textsize', size]));
        if (!run.changed.includes(d)) run.changed.push(d);
        note = ' (relaunched)';
        nowSize = size;
      }
      if (matrix) {
        say(`▸ ${d} · textsize ${nowSize}${note}`);
        shotRun.prefix = `${dslug}-${nowSize}-`;
      }
      if (!(await mdoRun(p, shots, keep, todo))) {
        stop = true;
        break;
      }
    }
    if (stop) break;
  }
  await mdoRestore(p);
  for (const s of shotRun.taken) say(`shot: ${s}`);
  if (shotRun.taken.length >= 2) {
    const out = await sheet(join(config().shots, shots), { name: shots, cols: 0, max: 6, only: '', strip: false, edge: SHEET_EDGE });
    for (const l of out) if (l.endsWith('.png')) say(`sheet: ${l}`);
  }
  if (run.failed) {
    say(`mdo: ${run.failed} of ${run.n} step(s) failed`);
    return 1;
  }
  return 0;
}

// One wait, one line: « ✓ « text » after 1.2s », or « ✗ » with why and what the screen shows.
export const MWAIT_USAGE = 'usage: vysu mwait ios|android "<text>" [--gone] [--timeout <s>]  |  vysu mwait ios|android --idle [--timeout <s>]';

export async function mwait(argv: string[]): Promise<number> {
  const p = argv[0] ?? '';
  if (p !== 'ios' && p !== 'android') die(MWAIT_USAGE);
  let text = '';
  let gone = false;
  let idle = false;
  let timeout = '10';
  for (let i = 1; i < argv.length; i++) {
    const a = argv[i]!;
    if (a === '--gone') gone = true;
    else if (a === '--idle') idle = true;
    else if (a === '--timeout') timeout = argv[++i] ?? '';
    else if (a.startsWith('-')) die(`vysu mwait: unknown option ${a}`);
    else {
      if (text) die(MWAIT_USAGE);
      text = a;
    }
  }
  if (!((idle && !text) || (!idle && text))) die(MWAIT_USAGE);
  if (!secondsOk(timeout)) die(`vysu mwait: --timeout takes seconds (not « ${timeout} »)`);
  await mdoLock(p);
  const r = await captured(() => (idle ? mwaitIdle(p, timeout) : gone ? mwaitGone(p, text, timeout) : mwaitText(p, text, timeout)));
  if (r.value) {
    say(`✓ ${mdoDetail(r.out)}`);
    return 0;
  }
  // No delta on a line of its own: the previous screen this device was read at is another command's.
  rmSync(`${snapFile(p)}.keys`, { force: true });
  // gone and idle end on a snapshot of their own; `wait text` polled agent-device's.
  say(`✗ ${mdoReason(r.err)} · ${await mscreen(p, idle || gone)}`);
  return 1;
}

export const MFLOW_USAGE = 'usage: vysu mflow ios|android <file|-> [--shots <name>] [--keep-going]';

// The steps of a file (or stdin), one per line, read back the way `vysu mdo` reads them (one ✓ / ✗
// line per step, then the screen), then the contact sheet of the shots.
export async function mflow(argv: string[]): Promise<number> {
  const [p = '', file = ''] = argv;
  if (!p || !file) die(MFLOW_USAGE);
  const opts: string[] = [];
  for (let i = 2; i < argv.length; i++) {
    const a = argv[i]!;
    if (a === '--shots') opts.push('--shots', argv[++i] ?? '');
    else if (a === '--keep-going') opts.push('--keep-going');
    else die(`vysu mflow: unknown option ${a}`);
  }
  if (file !== '-' && !(existsSync(file) && statSync(file).isFile())) die(`no flow file ${file}`);
  return mdo([p, file, ...opts]);
}
