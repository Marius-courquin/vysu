// The bundler in front of an Expo dev-client: the port each owner talks to (the shared Metro, or an
// isolated one started from the owner's own checkout), the log that port writes, the bundling
// failures that log holds, and the reload of ONE device's JS through the inspector proxy.
import { closeSync, existsSync, mkdirSync, openSync, readdirSync, readFileSync, readSync, realpathSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { isAbsolute, join, relative } from 'node:path';
import { spawnSync } from 'node:child_process';
import { config } from '../core/ctx.ts';
import { die } from '../core/errors.ts';
import { devices, owner, type Platform } from '../core/hold.ts';
import { listenerPids } from '../core/host.ts';
import { killPort, listening, waitHttp } from '../core/net.ts';
import { spawnShellDetached } from '../core/proc.ts';
import { slug } from '../core/text.ts';
import { adbShell } from './device.ts';
import { say } from './io.ts';

const read = (p: string): string => {
  try {
    return readFileSync(p, 'utf8');
  } catch {
    return '';
  }
};

// --- which Metro -------------------------------------------------------------------------------

// Sharing one checkout and one Metro stays the default: several sessions on one branch, and a Mac
// short on RAM. An owner that needs its own (a phase where another session's edits must not reach
// its screen) starts one with `vysu up <platform> --isolated`, and this file remembers it: one line,
// « <port> <pid> <dir> ». The pid is the process that listened when `up` saw the Metro healthy, so
// `down metro` never kills what another owner later started on a port this one left.
export const isolatedFile = (): string => join(config().state, `metro-port.${slug(owner())}`);
function isolatedRecord(): { port: string; pid: string; dir: string } | null {
  const t = read(isolatedFile());
  if (!t) return null;
  const [port = '', pid = '', ...dir] = t.replace(/\n$/, '').split(' ');
  return { port, pid, dir: dir.join(' ') };
}
export const isolatedPort = (): string => isolatedRecord()?.port ?? '';
// The port every owner without an isolated Metro shares: the config's, else 8081.
export const sharedPort = (): string => config().get('METRO_PORT', '8081');

// The port this command talks to: VYSU_METRO_PORT from the environment first (one command pointed
// elsewhere by hand wins over everything), then this owner's isolated Metro, then the config.
export function metroPort(): string {
  if (config().origin('METRO_PORT') === 'env') return config().get('METRO_PORT');
  return isolatedPort() || sharedPort();
}
export const metroIsIsolated = (): boolean => config().origin('METRO_PORT') !== 'env' && isolatedPort() !== '';

// 8081 keeps the path it always had: every reader written before ports existed still finds it.
export function metroLog(port = metroPort()): string {
  return port === '8081' ? join(config().logs, 'metro.log') : join(config().logs, `metro-${port}.log`);
}

// The line count a « since » is measured from (`wc -l`: the newlines), read without holding the
// whole log: a Metro log runs to megabytes over a day.
export function lineCount(file: string): number {
  let fd: number;
  try {
    fd = openSync(file, 'r');
  } catch {
    return 0;
  }
  const b = Buffer.alloc(1 << 16);
  let n = 0;
  try {
    for (;;) {
      const got = readSync(fd, b, 0, b.length, null);
      if (!got) break;
      for (let i = 0; i < got; i++) if (b[i] === 10) n++;
    }
  } finally {
    closeSync(fd);
  }
  return n;
}
export const metroLines = (log = metroLog()): number => lineCount(log);

// What follows line N of a file (`tail -n +N+1`), and the byte it starts at, so a loop reading the
// same log again asks for the new bytes only.
export function offsetOfLine(file: string, n: number): number {
  if (n <= 0) return 0;
  let fd: number;
  try {
    fd = openSync(file, 'r');
  } catch {
    return 0;
  }
  const b = Buffer.alloc(1 << 16);
  let seen = 0;
  let pos = 0;
  try {
    for (;;) {
      const got = readSync(fd, b, 0, b.length, pos);
      if (!got) return pos;
      for (let i = 0; i < got; i++) {
        if (b[i] === 10 && ++seen === n) return pos + i + 1;
      }
      pos += got;
    }
  } finally {
    closeSync(fd);
  }
}
export function readFrom(file: string, offset: number): string {
  let fd: number;
  try {
    fd = openSync(file, 'r');
  } catch {
    return '';
  }
  try {
    const size = statSync(file).size;
    if (size <= offset) return '';
    const b = Buffer.alloc(size - offset);
    readSync(fd, b, 0, b.length, offset);
    return b.toString('utf8');
  } finally {
    closeSync(fd);
  }
}
export const linesAfter = (file: string, n: number): string => readFrom(file, offsetOfLine(file, n));

// « <tag> Bundled », the line Metro prints when it hands a bundle over. Its platform tag is all it
// says about the device: two iPhones on one Metro print the same line, which is why a relaunch then
// also waits for the screen of its own device.
export const metroTag = (p: Platform): string => (p === 'android' ? 'Android' : 'iOS');
// What a dev-client is handed to load the app from: the host side of `adb reverse` on Android, the
// simulator's own loopback on iOS: localhost either way.
export const metroUrl = (port = metroPort()): string => `http://localhost:${port}`;

// Is the process that answers on this port still the one that was recorded? A pid alone could be
// reused by anything; a port alone could be another owner's Metro.
export function metroPidListening(port: string, pid: string): boolean {
  return pid !== '' && listenerPids(Number(port)).includes(Number(pid));
}
const metroListenerPid = (port: string): string => String(listenerPids(Number(port))[0] ?? '');

// Dies when this owner's Metro is not there, with the one command that fixes it: an isolated Metro
// that died must not silently hand the device back to the shared one.
export async function metroNeed(cmd: string, p: Platform): Promise<void> {
  const port = metroPort();
  if (await listening(Number(port))) return;
  if (metroIsIsolated()) {
    die(`${cmd}: this owner's isolated Metro on :${port} is not running`, `vysu up ${p} --isolated (restart it), or vysu down metro (back to the shared :${sharedPort()})`);
  }
  die(`${cmd}: Metro is not running on :${port}`, `vysu up ${p}`);
}

// --- an isolated Metro -------------------------------------------------------------------------

function git(dir: string, args: string[]): string | null {
  const r = spawnSync('git', ['-C', dir, ...args], { encoding: 'utf8' });
  return r.status === 0 ? r.stdout.trim() : null;
}
const physical = (p: string): string => {
  try {
    return realpathSync(p);
  } catch {
    return p;
  }
};
function gitCommonDir(dir: string): string | null {
  const d = git(dir, ['rev-parse', '--git-common-dir']);
  return d === null ? null : physical(isAbsolute(d) ? d : join(dir, d));
}

// Without --dir: the checkout the command is run from, when it is a worktree of the repository that
// holds VYSU_MOBILE_DIR. An agent working in `.worktrees/feat-x` serves `.worktrees/feat-x/<the same
// relative folder>`. Anything else is a guess, and a guess here serves the wrong branch.
export function worktreeMobileDir(): string | null {
  const md = config().mobileDir;
  if (!md || !existsSync(md)) return null;
  const mobile = physical(md);
  const mainCommon = gitCommonDir(mobile);
  const hereCommon = gitCommonDir(process.cwd());
  if (!mainCommon || !hereCommon || mainCommon !== hereCommon) return null;
  const mainTop = git(mobile, ['rev-parse', '--show-toplevel']);
  const hereTop = git(process.cwd(), ['rev-parse', '--show-toplevel']);
  if (!mainTop || !hereTop) return null;
  const rel = relative(physical(mainTop), mobile);
  return rel ? join(physical(hereTop), rel) : physical(hereTop);
}

// 8082 upward: a port nothing listens on and no other owner has on record (its Metro may be down for
// a minute, its port is still its own).
async function freePort(): Promise<string> {
  const state = config().state;
  const recorded = new Set<string>();
  try {
    for (const f of readdirSync(state)) if (f.startsWith('metro-port.')) recorded.add(read(join(state, f)).split(' ')[0] ?? '');
  } catch {
    // no state yet
  }
  for (let p = 8082; p <= 8099; p++) {
    if (await listening(p)) continue;
    if (recorded.has(String(p))) continue;
    return String(p);
  }
  return '';
}

function startMetro(dir: string, port: string, menv: string[]): void {
  const env = config().childEnv();
  for (const pair of menv) {
    const eq = pair.indexOf('=');
    if (eq > 0) env[pair.slice(0, eq)] = pair.slice(eq + 1);
  }
  spawnShellDetached(`npx expo start --port ${port}`, { cwd: dir, env, log: metroLog(port) });
}

export async function metroIsolatedUp(p: Platform, portIn: string, dir: string, menv: string[]): Promise<void> {
  let port = portIn;
  const rec = isolatedRecord();
  if (rec?.port) {
    if (port && port !== rec.port) die(`vysu up ${p} --isolated: ${owner()} already has an isolated Metro on :${rec.port}`, 'vysu down metro');
    if (metroPidListening(rec.port, rec.pid)) {
      say(`metro: isolated on :${rec.port} for ${owner()}, already running (from ${rec.dir})`);
      return;
    }
    port = rec.port;
  }
  if (/[^0-9]/.test(port)) die(`vysu up ${p} --isolated: --port takes a number (got « ${port} »)`);
  if (!port) port = (await freePort()) || die(`vysu up ${p} --isolated: no free port between 8082 and 8099`);
  if (await listening(Number(port))) die(`vysu up ${p} --isolated: :${port} is taken (another --port)`);
  if (!existsSync(dir) || !statSync(dir).isDirectory()) die(`vysu up ${p} --isolated: no such folder ${dir}`);
  if (!existsSync(join(dir, 'package.json'))) die(`vysu up ${p} --isolated: ${dir} holds no package.json (the Expo app folder)`);
  mkdirSync(config().logs, { recursive: true });
  mkdirSync(config().state, { recursive: true });
  const log = metroLog(port);
  startMetro(dir, port, menv);
  await waitHttp(`http://localhost:${port}/status`, 180, `metro :${port} (see ${log})`);
  writeFileSync(isolatedFile(), `${port} ${metroListenerPid(port)} ${dir}\n`);
  say(`metro: isolated on :${port} for ${owner()}, from ${dir} (log: ${log})`);
  say('metro: an isolated Metro costs ~1-1.5 GB of RAM (vysu down metro once the phase is over)');
}

// The shared Metro, when `up` is the one that starts it: its starter is written down, so that owner
// (and only that one) can `down metro` it again.
export async function metroSharedUp(dir: string, port: string, menv: string[]): Promise<void> {
  mkdirSync(config().logs, { recursive: true });
  mkdirSync(config().state, { recursive: true });
  startMetro(dir, port, menv);
  await waitHttp(`http://localhost:${port}/status`, 120, 'metro');
  writeFileSync(join(config().state, `metro-started.${port}`), `${owner()} ${metroListenerPid(port)}\n`);
}

// `vysu down metro`: this owner's isolated Metro, else the shared one when this owner started it.
// Never a Metro another session is bundling from without knowing it was someone else's to stop.
export async function metroDown(): Promise<void> {
  const rec = isolatedRecord();
  if (rec) {
    if (metroPidListening(rec.port, rec.pid)) {
      await killPort(Number(rec.port), Number(rec.pid));
      say(`metro: isolated :${rec.port} stopped`);
    } else say(`metro: isolated :${rec.port} was no longer running`);
    rmSync(isolatedFile(), { force: true });
    say(`metro: ${owner()} is back on the shared :${sharedPort()} from the next vysu mrelaunch`);
    return;
  }
  const port = sharedPort();
  const started = join(config().state, `metro-started.${port}`);
  const [who = '', pid = ''] = read(started).trim().split(' ');
  if (who && who === owner() && metroPidListening(port, pid)) {
    await killPort(Number(port), Number(pid));
    rmSync(started, { force: true });
    say(`metro: :${port} stopped`);
  } else {
    say(`metro: nothing of ${owner()}'s to stop: :${port} is the shared Metro${who ? ` (started by ${who})` : ''}, left running`);
  }
}

// --- what Metro logged -------------------------------------------------------------------------

// A bundling failure since a line of the log: the edit that broke it may be another session's on the
// same checkout, and a screen that stopped updating tells an agent nothing about why. Answers
// « <first line of the error> (<file>) » for the last failure, with « · bundled fine since » when a
// later bundle went through, and '' when there is none. Two shapes are known: Metro's « <tag> Bundling
// failed … » followed by the error, and an error of its own (a SyntaxError or an unresolved import
// reported on a Fast Refresh).
export function bundleErrorSince(from: number, log = metroLog(), text?: string): string {
  if (!existsSync(log)) return '';
  const body = text ?? linesAfter(log, from);
  // The cheap test first: this runs in the relaunch loop, and the walk below does more per line.
  if (!/Bundling failed|SyntaxError|Unable to resolve|TransformError/.test(body)) return '';
  return bundleErrorOf(body, `${config().projectDir || '/nonexistent'}/`);
}

export function bundleErrorOf(body: string, root: string): string {
  let msg = '';
  let file = '';
  let ok = false;
  let want = false;
  const take = (raw: string): void => {
    let line = raw.replace(/^[ \t]*(ERROR|error:?)[ \t]+/, '');
    let f = '';
    const from = /from "[^"]+"/.exec(line);
    if (from) {
      f = from[0].slice(6, -1);
      line = line.slice(0, Math.max(0, from.index - 1));
    } else {
      const m = /\/[^ :"]+\.(tsx|ts|jsx|js|mjs|cjs|json)(: |$)/.exec(line);
      if (m) {
        f = m[0].replace(/: $/, '');
        line = line.slice(0, m.index) + line.slice(m.index + f.length + 2);
      }
    }
    if (f.startsWith(root)) f = f.slice(root.length);
    if (line.length > 160) line = `${line.slice(0, 157)}...`;
    msg = line;
    file = f;
    ok = false;
  };
  for (const rawLine of body.split('\n')) {
    const l = rawLine.replace(/\x1b\[[0-9;]*m/g, '');
    if (/ Bundled [0-9]+ms /.test(l)) {
      if (msg !== '') ok = true;
      continue;
    }
    if (/Bundling failed/.test(l)) {
      want = true;
      continue;
    }
    if (want && l.trim() !== '') {
      take(l);
      want = false;
      continue;
    }
    if (/SyntaxError:|Unable to resolve|TransformError/.test(l) && !/^[ \t]+at /.test(l)) take(l);
  }
  if (msg === '') return '';
  return `${msg}${file ? ` (${file})` : ''}${ok ? ' · bundled fine since' : ''}`;
}

// --- one device's JS, reloaded -----------------------------------------------------------------

// Metro's /reload and `agent-device metro reload` broadcast to every app on that Metro: with three
// devices on one bundler, one agent's reload reloads the other two sessions' screens. React Native
// DevTools reloads a single page through the inspector proxy (`Page.reload`), and every app registers
// one page per device there: the iOS simulator under its own name, an Android emulator as « <model>
// - <release> - API <sdk> ». Two emulators with the same image read the same, and then the page is
// ambiguous: the caller falls back to a relaunch rather than guess.
async function pageName(p: Platform): Promise<string> {
  if (p === 'ios') return devices.ios;
  return (await adbShell(['echo "$(getprop ro.product.model) - $(getprop ro.build.version.release) - API $(getprop ro.build.version.sdk)"'])).replace(/\n$/, '');
}

export async function metroPageWs(p: Platform, port: string): Promise<string> {
  const name = await pageName(p);
  if (!name) return '';
  let pages: Array<{ appId?: string; deviceName?: string; webSocketDebuggerUrl?: string }>;
  try {
    const r = await fetch(`http://127.0.0.1:${port}/json/list`, { signal: AbortSignal.timeout(5000) });
    pages = (await r.json()) as typeof pages;
  } catch {
    return '';
  }
  if (!Array.isArray(pages)) return '';
  const hits = pages.filter((x) => x.appId === config().get('MOBILE_BUNDLE') && x.deviceName === name);
  if (hits.length !== 1 || !hits[0]!.webSocketDebuggerUrl) return '';
  return hits[0]!.webSocketDebuggerUrl.replace('ws://localhost:', 'ws://127.0.0.1:');
}

// The proxy only takes a debugger whose Origin is its own (http://127.0.0.1:<port>), which a browser
// sends and a script has to. Nothing the page sends back is printed: it streams network events,
// bearer tokens included. True when the page acknowledged the reload.
export function metroPageReload(url: string): Promise<boolean> {
  return new Promise((resolve) => {
    const WS = (globalThis as { WebSocket?: new (u: string, o?: unknown) => WebSocket }).WebSocket;
    if (!WS) return resolve(false);
    let ws: WebSocket;
    try {
      ws = new WS(url, { headers: { Origin: `http://127.0.0.1:${new URL(url).port}` } });
    } catch {
      return resolve(false);
    }
    const done = (ok: boolean): void => {
      clearTimeout(t);
      try {
        ws.close();
      } catch {
        // already closed
      }
      resolve(ok);
    };
    const t = setTimeout(() => done(false), 5000);
    ws.onopen = () => ws.send(JSON.stringify({ id: 1, method: 'Page.reload', params: {} }));
    ws.onmessage = (m: MessageEvent) => {
      let d: { id?: number; error?: unknown };
      try {
        d = JSON.parse(String(m.data)) as typeof d;
      } catch {
        return;
      }
      if (d.id === 1) done(!d.error);
    };
    ws.onerror = () => done(false);
  });
}

