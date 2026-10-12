// A service served for one owner alone, from its own checkout: `vysu up <service> --isolated`.
//
// The shared web server sits on one port (8100 for Nidz), and every worktree fought over it: an agent
// stopped another's Vite to serve its branch, or hand-rolled one on a port of its own that nothing
// else knew of (about 25 checker reports, 25/09 → 12/10). An isolated service runs the service's CMD
// from the worktree the command is run in, on a free port of VYSU_SERVICE_<name>_ISOLATED_PORTS, and
// is put on record per owner: the owner's browser sessions are pointed at it while the page keeps the
// shared address (see resolverRule), every other owner keeps the shared server.
//
// Kept apart from services.ts on purpose: the entry point reads the record on every command, and
// services.ts brings the mobile code with it.
import { existsSync, mkdirSync, readdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { isAbsolute, join, relative, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import type { Config } from '../core/config.ts';
import { lockDrop, lockTake, owner, ownerGone } from '../core/hold.ts';
import { listenerPids, processName } from '../core/host.ts';
import { listening } from '../core/net.ts';
import { sleep, slug } from '../core/text.ts';

export interface IsolatedRecord {
  service: string;
  port: string;
  pid: string;
  owner: string;
  dir: string;
}

const PREFIX = 'service-port.';
const fileOf = (c: Config, service: string, who = owner()): string => join(c.state, `${PREFIX}${service}.${slug(who)}`);

const read = (p: string): string => {
  try {
    return readFileSync(p, 'utf8');
  } catch {
    return '';
  }
};

// « key=value » lines: a folder may hold spaces.
export function parseRecord(service: string, text: string): IsolatedRecord | null {
  const v: Record<string, string> = {};
  for (const line of text.split('\n')) {
    const eq = line.indexOf('=');
    if (eq > 0) v[line.slice(0, eq)] = line.slice(eq + 1);
  }
  if (!v.port) return null;
  return { service, port: v.port, pid: v.pid ?? '0', owner: v.owner ?? '', dir: v.dir ?? '' };
}
export const formatRecord = (r: Omit<IsolatedRecord, 'service'>): string => `port=${r.port}\npid=${r.pid}\nowner=${r.owner}\ndir=${r.dir}\n`;

function stateNames(c: Config): string[] {
  try {
    return readdirSync(c.state).filter((f) => f.startsWith(PREFIX));
  } catch {
    return [];
  }
}

// Every record on this machine, whoever's it is.
export function allRecords(c: Config): Array<IsolatedRecord & { file: string }> {
  const out: Array<IsolatedRecord & { file: string }> = [];
  for (const f of stateNames(c)) {
    const rest = f.slice(PREFIX.length);
    const service = rest.slice(0, rest.indexOf('.'));
    const r = parseRecord(service, read(join(c.state, f)));
    if (service && r) out.push({ ...r, file: join(c.state, f) });
  }
  return out;
}

export function myRecord(c: Config, service: string): IsolatedRecord | null {
  return parseRecord(service, read(fileOf(c, service)));
}

// « 8101-8105 », « 8101,8102 », « 8101-8103 8110 »: the ports in that order.
export function parsePorts(spec: string): number[] {
  const out: number[] = [];
  for (const part of spec.split(/[\s,]+/).filter(Boolean)) {
    const m = /^(\d+)(?:-(\d+))?$/.exec(part);
    if (!m) continue;
    const from = Number(m[1]);
    const to = m[2] ? Number(m[2]) : from;
    for (let p = from; p <= to && p - from < 1000; p++) if (!out.includes(p)) out.push(p);
  }
  return out;
}

// The command line on another port: `{port}` where the config wrote it, else the shared port where
// the command spells it (`vite --port 8100 --strictPort`), else as it is (PORT is exported too).
export function withPort(command: string, shared: string, port: string): string {
  if (command.includes('{port}')) return command.replaceAll('{port}', port);
  if (!shared) return command;
  return command.replace(new RegExp(`(?<![\\d.])${shared}(?!\\d)`, 'g'), port);
}

// --- which checkout --------------------------------------------------------------------------

function git(dir: string, args: string[]): string | null {
  const r = spawnSync('git', ['-C', dir, ...args], { encoding: 'utf8' });
  return r.status === 0 ? r.stdout.trim() : null;
}
// The native resolution, and on Windows one spelling: git answers `C:/Users/RUNNER~1/…` with forward
// slashes and the short 8.3 name where the shell gave one, node's own realpath keeps what it is given.
const physical = (p: string): string => {
  try {
    return realpathSync.native(resolve(p));
  } catch {
    return resolve(p);
  }
};
const samePath = (a: string, b: string): boolean => (process.platform === 'win32' ? a.toLowerCase() === b.toLowerCase() : a === b);
function commonDir(dir: string): string | null {
  const d = git(dir, ['rev-parse', '--git-common-dir']);
  return d === null ? null : physical(isAbsolute(d) ? d : join(dir, d));
}

// The service's folder, in the checkout `here` belongs to, when that checkout is a worktree of the
// repository holding the service's folder: an agent in `.worktrees/feat-x` serves `.worktrees/feat-x/
// <the same relative folder>`. The way `up ios --isolated` finds its Metro's folder; anything else is
// a guess, and a guess serves the wrong branch.
export function worktreeOf(serviceDir: string, here = process.cwd()): string | null {
  if (!serviceDir || !existsSync(serviceDir)) return null;
  const main = physical(serviceDir);
  const mainCommon = commonDir(main);
  const hereCommon = commonDir(here);
  if (!mainCommon || !hereCommon || !samePath(mainCommon, hereCommon)) return null;
  const mainTop = git(main, ['rev-parse', '--show-toplevel']);
  const hereTop = git(here, ['rev-parse', '--show-toplevel']);
  if (!mainTop || !hereTop) return null;
  const rel = relative(physical(mainTop), main);
  return rel ? join(physical(hereTop), rel) : physical(hereTop);
}

// --- reservation -----------------------------------------------------------------------------

const alive = (r: IsolatedRecord): boolean => (r.pid !== '0' && listenerPids(Number(r.port)).includes(Number(r.pid))) || !ownerGone(r.owner);

// A port of the list nothing listens on and no live owner has on record, put on record under one lock
// before the server starts (pid 0 until it answers): two owners starting together would otherwise both
// find the first port free. A record whose owner is gone and whose server is not running is dropped.
export async function reservePort(c: Config, service: string, ports: number[], dir: string): Promise<string> {
  await lockTake('service-ports');
  try {
    const taken = new Set<string>();
    for (const r of allRecords(c)) {
      if (r.file === fileOf(c, service)) continue;
      if (alive(r)) taken.add(r.port);
      else rmSync(r.file, { force: true });
    }
    for (const p of ports) {
      if (taken.has(String(p)) || (await listening(p))) continue;
      mkdirSync(c.state, { recursive: true });
      writeFileSync(fileOf(c, service), formatRecord({ port: String(p), pid: '0', owner: owner(), dir }));
      return String(p);
    }
    return '';
  } finally {
    lockDrop('service-ports');
  }
}

export function recordPid(c: Config, service: string, port: string, dir: string): void {
  writeFileSync(fileOf(c, service), formatRecord({ port, pid: String(listenerPids(Number(port))[0] ?? 0), owner: owner(), dir }));
}

export function forget(c: Config, service: string): void {
  rmSync(fileOf(c, service), { force: true });
}

// --- the owner's commands --------------------------------------------------------------------

// The shared port → isolated port pairs of this owner. Free when nobody isolates anything: one
// readdir, and the owner (a walk up the process tree) is only asked for when a record exists.
export function myPorts(c: Config): Array<{ service: string; shared: string; port: string; dir: string }> {
  if (!stateNames(c).length) return [];
  const out: Array<{ service: string; shared: string; port: string; dir: string }> = [];
  for (const service of c.get('SERVICES').split(/\s+/).filter(Boolean)) {
    const r = myRecord(c, service);
    const shared = c.get(`SERVICE_${service}_PORT`);
    if (r && shared && r.port !== shared) out.push({ service, shared, port: r.port, dir: r.dir });
  }
  return out;
}

// The page keeps its address: the API's CORS and the identity provider's callbacks accept
// http://localhost:8100 and nothing else (Nidz's prep API and Auth0 tenant), so an isolated server
// on another origin could not sign anyone in. The browser is told where that address is served
// instead: Chromium's host resolver rules map `localhost:<shared>` to the isolated port, which leaves
// every other port alone (an API on :8080) and keeps urls, cookies, storage and callbacks on the
// shared origin. The replacement is `localhost`, not an address: a Vite on [::1] and one on
// 127.0.0.1 are both reached. One rule only: agent-browser splits its --args on commas, and Chromium
// reads a list of rules from one comma-separated switch.
export function resolverRule(shared: string, port: string): string {
  return `--host-resolver-rules=MAP localhost:${shared} localhost:${port}`;
}

export function isolatedRule(c: Config): string {
  const p = myPorts(c)[0];
  return p ? resolverRule(p.shared, p.port) : '';
}

// Called once by the entry point, after the config: this owner's browser sessions launch with the
// rule (VYSU_BROWSER_ARGS gains it, newline-separated, which agent-browser reads as a separate arg).
export function pointAtIsolated(c: Config): string {
  const rule = isolatedRule(c);
  if (rule) {
    const args = c.get('BROWSER_ARGS');
    c.set('BROWSER_ARGS', args ? `${args}\n${rule}` : rule);
  }
  return rule;
}

// A persona's browser is one per persona, shared by every owner: launched with one owner's rule, it
// shows that owner's worktree to the next owner, and launched without it, it ignores the rule a later
// `up --isolated` asked for (launch args are read at launch only). What it was launched with is kept
// beside the state (session-rule.<session>); when this command wants another, the browser is closed
// (its login saved and restored by the next call) and the next call relaunches it with the right one.
const ruleFile = (c: Config, session: string): string => join(c.state, `session-rule.${slug(session)}`);

// Two owners on one persona, one isolated and one not, close each other's browser at every turn: the
// page each was on is gone, and the other one's next call opens on its home. Said whole, so it is not
// a silent loss: whose view it was, the page it showed, and that it is not reopened there. vysu 0.9.2
// knows nothing of these rules: a browser it launched or drives shows whatever the browser was
// launched with, the isolated worktree included, until it is closed.
export function followLine(session: string, had: string, by: string, url: string, rule: string): string {
  const view = (r: string): string => {
    const m = /MAP (\S+) \S+:(\d+)$/.exec(r);
    return m ? `${m[1]} served from :${m[2]}` : 'the shared server';
  };
  const showing = url && url !== 'about:blank' ? `, showing ${url}` : '';
  const reopen = showing ? ', its login kept but not that page (open it again)' : ' (login kept)';
  return `vysu: ${session} was open on ${view(had)}${by ? ` for ${by}` : ''}${showing}: closed, the next call reopens it on ${view(rule)}${reopen}`;
}

export async function sessionFollows(c: Config, persona: string, rule: string): Promise<void> {
  const { ab, daemonPidFile, sessionOf, stopSessionBrowser, webLockOf } = await import('../web/ab.ts');
  const session = sessionOf(persona);
  const file = ruleFile(c, session);
  const [had = '', ...rest] = read(file).trim().split('\n');
  const by = rest.find((l) => l.startsWith('by='))?.slice(3) ?? '';
  if (had === rule) return;
  if (!rule && !existsSync(file)) return;
  await lockTake(webLockOf(persona));
  const pid = Number(read(daemonPidFile(session)).trim());
  if (pid > 0 && processName(pid).includes('agent-browser')) {
    const url = (await ab(persona, ['get', 'url'], { stderr: 'drop' })).stdout.trim().split('\n').pop() ?? '';
    await ab(persona, ['close'], { stderr: 'drop' });
    // The daemon answers `close` before it is gone, and a call made in between still finds the old
    // browser: its end is waited for, and forced past five seconds.
    for (let i = 0; i < 50 && processName(pid).includes('agent-browser'); i++) await sleep(100);
    if (processName(pid).includes('agent-browser')) stopSessionBrowser(session);
    process.stderr.write(`${followLine(session, had, by, url, rule)}\n`);
  }
  if (rule) {
    mkdirSync(c.state, { recursive: true });
    writeFileSync(file, `${rule}\nby=${owner()}\n`);
  } else rmSync(file, { force: true });
}

// The checkout a page on this machine is served from, for the sha a capture is attributed to: this
// owner's isolated service when the url is on a port it maps, else the folder the process listening
// on that port runs in (a Vite started by hand from a worktree is that worktree). '' when it cannot
// be told.
export function servedDir(c: Config, url: string): string {
  const m = /^https?:\/\/(?:localhost|127\.0\.0\.1|\[::1\]):(\d+)/.exec(url);
  if (!m) return '';
  let port = m[1]!;
  for (const p of myPorts(c)) {
    if (p.shared === port && /^https?:\/\/localhost:/.test(url)) {
      if (p.dir) return p.dir;
      port = p.port;
    }
  }
  const pid = listenerPids(Number(port))[0];
  if (!pid || process.platform === 'win32') return '';
  const r = spawnSync('lsof', ['-a', '-p', String(pid), '-d', 'cwd', '-Fn'], { encoding: 'utf8' });
  const cwd = (r.stdout ?? '').split('\n').find((l) => l.startsWith('n'))?.slice(1) ?? '';
  return cwd && git(cwd, ['rev-parse', '--show-toplevel']) !== null ? cwd : '';
}
