// `up` and `down` know no stack: a service is a CMD, a DIR, a PORT, a HEALTH check and a STOP,
// declared in the project's config. The two mobile targets are Expo and simulator mechanics, not app
// logic: they belong to the mobile code, which `up ios|android` and `down metro|applog` hand over to.
import { mkdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { config } from '../core/ctx.ts';
import { die, VysuError } from '../core/errors.ts';
import { killPort, listening, waitHttp } from '../core/net.ts';
import { runShell, spawnShellDetached } from '../core/proc.ts';
import { sleep } from '../core/text.ts';
import { mobileDown, mobileUp } from '../mobile/api.ts';
import { forget, myRecord, parsePorts, recordPid, reservePort, withPort, worktreeOf } from './isolated.ts';

const words = (s: string): string[] => s.split(/\s+/).filter(Boolean);

export const serviceKey = (name: string, key: string, fallback = ''): string => config().get(`SERVICE_${name}_${key}`, fallback);
const services = (): string[] => words(config().get('SERVICES'));
const serviceKnown = (name: string): boolean => services().includes(name);

// Where a service runs: its DIR, relative to the project, else the project, else here.
function serviceDir(name: string): string {
  const c = config();
  return c.projectPath(serviceKey(name, 'DIR')) || c.projectDir || process.cwd();
}

// A health check is a url when it holds « :// », the literal `port` when a TCP listen is all there is
// to wait for, and a command otherwise.
async function serviceWait(name: string, timeout: number, port = serviceKey(name, 'PORT')): Promise<void> {
  let health = withPort(serviceKey(name, 'HEALTH'), serviceKey(name, 'PORT'), port);
  if (!health) {
    if (!port) return;
    health = 'port';
  }
  if (health.includes('://')) return waitHttp(health, timeout, name);
  if (health === 'port') {
    if (!port) die(`vysu up ${name}: HEALTH is « port » but VYSU_SERVICE_${name}_PORT is not set`);
    for (let i = 0; i < timeout; i++) {
      if (await listening(Number(port))) return;
      await sleep(1000);
    }
    die(`${name}: nothing listening on ${port} after ${timeout}s`);
  }
  const env = config().childEnv();
  for (let i = 0; i < timeout; i++) {
    if ((await runShell(health, { env, discard: true })).code === 0) return;
    await sleep(1000);
  }
  die(`${name}: « ${health} » never succeeded in ${timeout}s`);
}

// What a report calls the API the app talks to, when `up` is the one that decided it: an --env value
// that is a url is mapped through VYSU_API_HOSTS exactly as a request from the network log would be.
export function apiLabel(pairs: string[], apiHosts: string): string {
  let label = '';
  for (const pair of pairs) {
    const value = pair.slice(pair.indexOf('=') + 1);
    if (!value.includes('://')) continue;
    const host = value.replace(/^https?:\/\//, '').replace(/\/.*$/s, '');
    label = host;
    for (const entry of words(apiHosts)) {
      const eq = entry.indexOf('=');
      if ((eq < 0 ? entry : entry.slice(0, eq)) !== host) continue;
      label = eq < 0 ? entry : entry.slice(eq + 1);
      break;
    }
  }
  return label;
}

export function serviceRecordApi(pairs: string[]): void {
  const c = config();
  const file = join(c.state, 'web.api');
  const label = apiLabel(pairs, c.get('API_HOSTS'));
  if (!pairs.some((p) => p.slice(p.indexOf('=') + 1).includes('://'))) {
    rmSync(file, { force: true });
    return;
  }
  mkdirSync(c.state, { recursive: true });
  writeFileSync(file, label);
}

const USAGE_UP = 'usage: vysu up <service> [--env k=v]… [--isolated [--dir <folder>]] | all | ios | android';
const USAGE_DOWN = 'usage: vysu down <service> | all | metro | applog [ios|android]';

export async function up(args: string[]): Promise<void> {
  const [what, ...rest] = args;
  if (!what) die(USAGE_UP);
  const c = config();
  mkdirSync(c.logs, { recursive: true });
  if (what === 'all') {
    c.needProject();
    for (const s of services()) await up([s]);
    return;
  }
  if (what === 'ios' || what === 'android') return mobileUp(what, rest);
  c.needProject();
  if (!serviceKnown(what)) die(`vysu up: unknown service '${what}' (VYSU_SERVICES = ${c.get('SERVICES')})`);
  const envPairs: string[] = [];
  let isolated = false;
  let isoDir = '';
  for (let i = 0; i < rest.length; i++) {
    if (rest[i] === '--env' && i + 1 < rest.length) envPairs.push(rest[++i]!);
    else if (rest[i] === '--isolated') isolated = true;
    else if (rest[i] === '--dir' && i + 1 < rest.length) isoDir = rest[++i]!;
    else die(`vysu up ${what}: unknown option ${rest[i]}`, `vysu up ${what} [--env k=v]… [--isolated [--dir <folder>]]`);
  }
  if (isoDir && !isolated) die(`vysu up ${what}: --dir goes with --isolated`);
  const cmd = serviceKey(what, 'CMD');
  if (!cmd) die(`vysu up ${what}: VYSU_SERVICE_${what}_CMD is not set`);
  if (isolated) return upIsolated(what, cmd, envPairs, isoDir);
  const dir = serviceDir(what);
  const port = serviceKey(what, 'PORT');
  const timeout = Number(serviceKey(what, 'TIMEOUT', '30')) || 30;
  // Already up is not a failure: the point of `up` is that the service is there afterwards.
  if (port && (await listening(Number(port)))) {
    console.log(`${what}: already listening on ${port} (vysu down ${what} to restart it)`);
    return;
  }
  if (!isDir(dir)) die(`vysu up ${what}: no folder ${dir} (VYSU_SERVICE_${what}_DIR)`);
  const { all, extra } = envOf(what, envPairs);
  // Detached, in its own session: the service outlives this vysu, and its log is the one place its
  // output goes.
  const log = join(c.logs, `${what}.log`);
  spawnShellDetached(withPort(cmd, '', port), { cwd: dir, env: c.childEnv(extra), log });
  serviceRecordApi(all);
  await serviceWait(what, timeout);
  const where = port ? `http://localhost:${port}` : what;
  console.log(`${what}: ${where}${all.length ? ` — ${all.join(' ')}` : ''} (log: ${log})`);
}

export async function down(args: string[]): Promise<void> {
  const [what, ...rest] = args;
  if (!what) die(USAGE_DOWN);
  const c = config();
  if (what === 'all') {
    c.needProject();
    // In reverse: a dependency is stopped after what depends on it.
    for (const s of services().reverse()) await down([s]);
    return;
  }
  // This owner's isolated Metro, or the shared one when this owner is the one that started it.
  if (what === 'metro') return mobileDown('metro', rest);
  // The log tails vysu started: the native app's, and each device's JS console in expo mode. No
  // platform named: both, whichever are running.
  if (what === 'applog') return mobileDown('applog', rest.length ? rest : ['ios', 'android']);
  c.needProject();
  if (!serviceKnown(what)) die(`vysu down: unknown service '${what}' (VYSU_SERVICES = ${c.get('SERVICES')})`);
  // This owner's isolated one first, and only it: the shared one is everyone's, and a second
  // `down` stops it as before.
  if (await downIsolated(what)) return;
  const stop = serviceKey(what, 'STOP');
  const port = serviceKey(what, 'PORT');
  if (stop) {
    const dir = serviceDir(what);
    if (isDir(dir)) await runShell(stop, { cwd: dir, env: c.childEnv(), discard: true });
  } else if (port) {
    await killPort(Number(port));
  } else {
    die(`vysu down ${what}: neither VYSU_SERVICE_${what}_STOP nor _PORT is set`);
  }
  console.log(`${what}: stopped`);
}

// The pairs of the config's ENV, then the command line's: `--env` overrides a declared default.
function envOf(name: string, envPairs: string[]): { all: string[]; extra: Record<string, string> } {
  const all = [...words(serviceKey(name, 'ENV')), ...envPairs];
  const extra: Record<string, string> = {};
  for (const pair of all) {
    const eq = pair.indexOf('=');
    if (eq > 0) extra[pair.slice(0, eq)] = pair.slice(eq + 1);
  }
  return { all, extra };
}

// `vysu up <service> --isolated [--dir <folder>]`: the service's CMD run from this owner's checkout
// (src/services/isolated.ts), on a port of VYSU_SERVICE_<name>_ISOLATED_PORTS, beside the shared one.
async function upIsolated(name: string, cmd: string, envPairs: string[], dirIn: string): Promise<void> {
  const c = config();
  const shared = serviceKey(name, 'PORT');
  const ports = parsePorts(serviceKey(name, 'ISOLATED_PORTS'));
  if (!ports.length) {
    die(
      `vysu up ${name} --isolated: VYSU_SERVICE_${name}_ISOLATED_PORTS is not set in ${c.configFile}`,
      `declare the ports the app may be served on (e.g. VYSU_SERVICE_${name}_ISOLATED_PORTS='8101-8105'; an auth provider must accept them as origins)`,
    );
  }
  const dir = dirIn
    ? c.projectPath(dirIn)
    : (worktreeOf(serviceDir(name)) ??
      die(
        `vysu up ${name} --isolated: ${process.cwd()} is not a checkout of the repository of ${serviceDir(name)} (VYSU_SERVICE_${name}_DIR)`,
        `run it from your worktree, or vysu up ${name} --isolated --dir <folder>`,
      ));
  if (!isDir(dir)) die(`vysu up ${name} --isolated: no folder ${dir}`);
  const rec = myRecord(c, name);
  if (rec && rec.pid !== '0' && (await listening(Number(rec.port)))) {
    console.log(`${name}: :${rec.port} — isolated for this owner, already running (from ${rec.dir}; vysu down ${name} to stop it)`);
    return;
  }
  const port = await reservePort(c, name, ports, dir);
  if (!port) die(`vysu up ${name} --isolated: every port of VYSU_SERVICE_${name}_ISOLATED_PORTS (${serviceKey(name, 'ISOLATED_PORTS')}) is taken`, 'vysu doctor (who holds which)');
  const { all, extra } = envOf(name, envPairs);
  extra.PORT = port;
  const log = join(c.logs, `${name}-${port}.log`);
  spawnShellDetached(withPort(cmd, shared, port), { cwd: dir, env: c.childEnv(extra), log });
  try {
    await serviceWait(name, Number(serviceKey(name, 'TIMEOUT', '30')) || 30, port);
  } catch (e) {
    // A server that never answered keeps no port on record.
    forget(c, name);
    if (e instanceof VysuError) die(`${e.message} (log: ${log})`, e.next);
    throw e;
  }
  recordPid(c, name, port, dir);
  console.log(`${name}: :${port} — isolated for this owner, from ${dir}${all.length ? ` — ${all.join(' ')}` : ''} (log: ${log})`);
  if (shared) {
    console.log(
      `${name}: this owner's browser sessions now get http://localhost:${shared} from it (same origin: logins, cookies and callbacks unchanged; other owners keep the shared one); vysu down ${name} goes back`,
    );
  }
}

async function downIsolated(name: string): Promise<boolean> {
  const c = config();
  const rec = myRecord(c, name);
  if (!rec) return false;
  if (rec.pid !== '0' && (await listening(Number(rec.port)))) {
    await killPort(Number(rec.port), Number(rec.pid));
    console.log(`${name}: isolated :${rec.port} stopped${serviceKey(name, 'PORT') ? ` (this owner is back on the shared :${serviceKey(name, 'PORT')})` : ''}`);
  } else {
    console.log(`${name}: isolated :${rec.port} was no longer running`);
  }
  forget(c, name);
  return true;
}

function isDir(p: string): boolean {
  try {
    return statSync(p).isDirectory();
  } catch {
    return false;
  }
}
