// The bundler in front of an Expo dev-client: the port each owner talks to (the shared Metro, or an
// isolated one started from the owner's own checkout), the log that port writes, the bundling
// failures that log holds, and the reload of ONE device's JS through the inspector proxy.
import { closeSync, existsSync, mkdirSync, openSync, readdirSync, readFileSync, readSync, realpathSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { isAbsolute, join, relative } from 'node:path';
import { spawnSync } from 'node:child_process';
import { config } from '../core/ctx.ts';
import { die } from '../core/errors.ts';
import { devices, lockDrop, lockTake, owner, type Platform } from '../core/hold.ts';
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
// The owner itself rides on a second line (« owner=claude:41234 »): the file is named after its slug,
// and a slug cannot be read back into an owner (VYSU_OWNER=checker-2 read as pid 2, « Code
// Helper (Plugin):123 » never matched again), which is how the idle reaper took a live sub-agent's
// Metro for an orphan. 0.9.2 reads the first line's words and shows the rest as the folder.
export interface MetroRecord {
  port: string;
  pid: string;
  dir: string;
  owner: string; // '' in a record an older vysu wrote
}
export function parseMetroRecord(text: string): MetroRecord {
  const [first = '', ...rest] = text.split('\n');
  const [port = '', pid = '', ...dir] = first.split(' ');
  const who = rest.find((l) => l.startsWith('owner='))?.slice('owner='.length) ?? '';
  return { port, pid, dir: dir.join(' '), owner: who };
}
export const metroRecordText = (port: string, pid: string, dir: string, who = owner()): string => `${port} ${pid} ${dir}\nowner=${who}\n`;
function isolatedRecord(): MetroRecord | null {
  const t = read(isolatedFile());
  return t ? parseMetroRecord(t) : null;
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

// The ports other owners have on record: their Metro may be down for a minute, or still starting,
// and the port is still theirs.
function othersPorts(): Set<string> {
  const state = config().state;
  const mine = `metro-port.${slug(owner())}`;
  const recorded = new Set<string>();
  try {
    for (const f of readdirSync(state)) if (f.startsWith('metro-port.') && f !== mine) recorded.add(read(join(state, f)).split(' ')[0] ?? '');
  } catch {
    // no state yet
  }
  return recorded;
}

// 8082 upward: a port nothing listens on and no other owner has on record.
async function freePort(): Promise<string> {
  const recorded = othersPorts();
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

// The port of this owner's isolated Metro, picked and put on record under one lock before Metro starts
// (pid 0 until it answers): two owners starting together both found 8082 free, a Metro taking seconds
// to listen and the record being written only then, and the one whose Metro lost the port stopped the
// other's with `down metro`. A port asked for that another owner has on record is refused for the
// same reason.
export async function metroReserve(p: Platform, portIn: string, dir: string): Promise<string> {
  let port = portIn;
  await lockTake('metro-ports');
  try {
    if (!port) port = (await freePort()) || die(`vysu up ${p} --isolated: no free port between 8082 and 8099`);
    else if (othersPorts().has(port)) die(`vysu up ${p} --isolated: :${port} is another owner's isolated Metro (another --port, or none to have one picked)`);
    if (await listening(Number(port))) die(`vysu up ${p} --isolated: :${port} is taken (another --port)`);
    if (!existsSync(dir) || !statSync(dir).isDirectory()) die(`vysu up ${p} --isolated: no such folder ${dir}`);
    if (!existsSync(join(dir, 'package.json'))) die(`vysu up ${p} --isolated: ${dir} holds no package.json (the Expo app folder)`);
    mkdirSync(config().logs, { recursive: true });
    mkdirSync(config().state, { recursive: true });
    writeFileSync(isolatedFile(), metroRecordText(port, '0', dir));
    return port;
  } finally {
    lockDrop('metro-ports');
  }
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
  port = await metroReserve(p, port, dir);
  const log = metroLog(port);
  startMetro(dir, port, menv);
  try {
    await waitHttp(`http://localhost:${port}/status`, 180, `metro :${port} (see ${log})`);
  } catch (e) {
    // A Metro that never answered keeps no port on record, as before the record came first.
    if (read(isolatedFile()) === metroRecordText(port, '0', dir)) rmSync(isolatedFile(), { force: true });
    throw e;
  }
  writeFileSync(isolatedFile(), metroRecordText(port, metroListenerPid(port), dir));
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

export interface InspectorPage {
  appId?: string;
  deviceName?: string;
  webSocketDebuggerUrl?: string;
}

// The one page of this app on this device in the proxy's /json/list, as its debugger websocket on
// 127.0.0.1, or '' when there is none or more than one. One device with the app running registers
// exactly one page, « React Native Bridgeless [C++ connection] » with `nativePageReloads`: the proxy
// hands Page.reload to the device, which reloads its own JS and nothing else (checked on an API 30
// emulator and an iOS 18 simulator side by side, 2026-09-24: the other device's page was untouched).
// There is no other target to aim at: the app has no second page, and the proxy's synthetic
// « React Native Experimental (Improved Chrome Reloads) » page only stands in for legacy pages.
export function pagePick(pages: unknown, appId: string, deviceName: string): string {
  if (!Array.isArray(pages)) return '';
  const hits = (pages as Array<InspectorPage | null>).filter((x) => x?.appId === appId && x.deviceName === deviceName);
  const url = hits.length === 1 ? hits[0]!.webSocketDebuggerUrl : '';
  return url ? url.replace('ws://localhost:', 'ws://127.0.0.1:') : '';
}

export async function metroPageWs(p: Platform, port: string): Promise<string> {
  const name = await pageName(p);
  if (!name) return '';
  try {
    const r = await fetch(`http://127.0.0.1:${port}/json/list`, { signal: AbortSignal.timeout(5000) });
    return pagePick(await r.json(), config().get('MOBILE_BUNDLE'), name);
  } catch {
    return '';
  }
}

// What the page said about a reload, as Date.now() stamps (0: not yet). The acknowledgement alone
// proves nothing: the device answers Page.reload as soon as it has queued the reload, so an app that
// then never fetched a bundle looked, to the old wait, like a Metro slow to print « Bundled », for
// the whole 60 s budget. With the Runtime domain enabled first, the page also says what its JS did:
// its context goes away when the reload starts, on this device and no other, where Metro's
// « Bundled » line is shared by every device of a platform. The two together are the proof. A new
// context proves no bundle: Android creates it once the bundle is in (after Metro's line), iOS
// before fetching it; it is kept for the trace. Measured on a warm Metro (2026-09-24): API 30
// emulator, context gone with the acknowledgement, « Bundled » 1 s later; iOS 18 simulator, the
// acknowledgement, the old context gone and the new one all within 0.1 s of the send.
export interface ReloadSeen {
  t0: number; // when the watch began: the start budget counts from here
  runtime: boolean | null; // did Runtime.enable work (null: no answer yet)
  sentAt: number;
  acked: number;
  refused: boolean;
  started: number; // the JS context went away: the app is reloading
  created: number; // a new context after that
  closed: number; // the socket closed: the page, the app or its connection to Metro went away
}

export const RUNTIME_ID = 1;
export const RELOAD_ID = 2;

export function reloadSeenNew(now: number): ReloadSeen {
  return { t0: now, runtime: null, sentAt: 0, acked: 0, refused: false, started: 0, created: 0, closed: 0 };
}

// One CDP message, read into what it says about the reload. Nothing else is kept: the page streams
// network events, bearer tokens included, and none of it is printed or stored. The context the
// Runtime domain announces when it is enabled is the old one: only what follows the send counts.
export function reloadSeenMessage(s: ReloadSeen, raw: string, now: number): void {
  let d: { id?: number; error?: unknown; method?: string };
  try {
    d = JSON.parse(raw) as typeof d;
  } catch {
    return;
  }
  if (d.id === RUNTIME_ID) s.runtime = !d.error;
  else if (d.id === RELOAD_ID) {
    if (d.error) s.refused = true;
    else if (!s.acked) s.acked = now;
  } else if (!s.sentAt) return;
  else if (d.method === 'Runtime.executionContextDestroyed' || d.method === 'Runtime.executionContextsCleared') {
    if (!s.started) s.started = now;
  } else if (d.method === 'Runtime.executionContextCreated' && s.started && !s.created) s.created = now;
}

// How long each phase may take before the reload is given up for a relaunch. The start: the proxy
// round trip and the page's answer, well under a second on both platforms. The bundle: from the start
// of the reload to Metro's « Bundled », about a second on a warm Metro; ten seconds leave room for an
// edit Metro has to transform first on a loaded Mac. Past either, the relaunch is quicker than
// waiting out the old 60 s for a bundle that is not coming.
export const RELOAD_START_MS = 5000;
export const RELOAD_BUNDLE_MS = 10000;
// A page that cannot report its contexts (no Runtime domain) has Metro's line as its only proof, and
// the budget the reload always had.
export const RELOAD_BUDGET_MS = 60000;

export type ReloadVerdict = { kind: 'wait' } | { kind: 'landed' } | { kind: 'fallback'; why: string };

// `bundled`: Metro printed « <tag> Bundled » since the send. The lines are the ones `vysu mreload`
// prints before it relaunches.
export function reloadVerdict(s: ReloadSeen, now: number, bundled: boolean): ReloadVerdict {
  const wait: ReloadVerdict = { kind: 'wait' };
  const fallback = (why: string): ReloadVerdict => ({ kind: 'fallback', why });
  // Does the page report its JS contexts? Without that, Metro's line is the only proof there is.
  const tells = s.runtime === true;
  if (s.refused || (s.closed && !s.sentAt)) return fallback('the inspector page refused the reload');
  if (bundled && (s.started || !tells)) return { kind: 'landed' };
  // The proxy drops a debugger when its device goes: the app was killed, crashed, or lost Metro.
  if (s.closed) return fallback('the app left Metro during the reload (it closed or crashed)');
  if (s.started) return now - s.started < RELOAD_BUNDLE_MS ? wait : fallback(`no new bundle ${RELOAD_BUNDLE_MS / 1000}s after the reload started`);
  if (s.acked && !tells) return now - s.t0 < RELOAD_BUDGET_MS ? wait : fallback(`no bundle ${RELOAD_BUDGET_MS / 1000}s after the reload`);
  if (now - s.t0 < RELOAD_START_MS) return wait;
  return fallback(s.acked ? 'the page took the reload but the app never started it' : 'the inspector page refused the reload');
}

export interface ReloadWatch {
  seen: ReloadSeen;
  close(): void;
}

// The proxy only takes a debugger whose Origin is its own (http://127.0.0.1:<port>), which a browser
// sends and a script has to. The socket stays open until the caller has its verdict: the proxy
// allows one debugger per page, so this one also stands in for a DevTools window left open on it,
// which the proxy disconnects, as it always did. Page.reload goes once Runtime.enable has answered,
// or after a second without an answer (a page with no Runtime domain).
export function metroPageReload(url: string): ReloadWatch | null {
  const WS = (globalThis as { WebSocket?: new (u: string, o?: unknown) => WebSocket }).WebSocket;
  if (!WS) return null;
  const seen = reloadSeenNew(Date.now());
  let ws: WebSocket;
  try {
    ws = new WS(url, { headers: { Origin: `http://127.0.0.1:${new URL(url).port}` } });
  } catch {
    return null;
  }
  let timer: ReturnType<typeof setTimeout> | undefined;
  const send = (): void => {
    if (seen.sentAt || seen.closed) return;
    clearTimeout(timer);
    seen.sentAt = Date.now();
    try {
      ws.send(JSON.stringify({ id: RELOAD_ID, method: 'Page.reload', params: {} }));
    } catch {
      seen.closed = Date.now();
    }
  };
  ws.onopen = () => {
    try {
      ws.send(JSON.stringify({ id: RUNTIME_ID, method: 'Runtime.enable', params: {} }));
    } catch {
      seen.closed = Date.now();
      return;
    }
    timer = setTimeout(send, 1000);
  };
  ws.onmessage = (m: MessageEvent) => {
    reloadSeenMessage(seen, String(m.data), Date.now());
    if (seen.runtime !== null) send();
  };
  const gone = (): void => {
    if (!seen.closed) seen.closed = Date.now();
  };
  ws.onerror = gone;
  ws.onclose = gone;
  return {
    seen,
    close() {
      clearTimeout(timer);
      ws.onclose = null;
      ws.onerror = null;
      try {
        ws.close();
      } catch {
        // already closed
      }
    },
  };
}

