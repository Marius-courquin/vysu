// agent-device, the driver every device verb goes through. One agent-device session per device —
// `<project>-<platform>-<device slug>`, bound to the simulator's name or the emulator's serial — so
// several simulators and emulators run side by side, each command addressing its own.
//
// Two ways to reach it. The CLI, for the `vysu ios|android <args>` passthrough and every verb a flow
// spells in agent-device's own words. And its library, loaded from the very package the `agent-device`
// on the PATH runs (so the daemon it talks to is the one the CLI would): a command that makes a dozen
// calls — a `vysu mdo`, a relaunch waiting on the screen, a `--full` capture — no longer pays a Node
// start-up (~150 ms) for each. A library that cannot be loaded, or is older than tools.env asks, falls
// back to the CLI with the same arguments; VYSU_AGENT_DEVICE=cli forces that.
import { spawn } from 'node:child_process';
import { readFileSync, realpathSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { config } from '../core/ctx.ts';
import { ENGINE } from '../core/config.ts';
import { die } from '../core/errors.ts';
import { devices, iosLock, type Platform } from '../core/hold.ts';
import { isWindows, toolArgv, which } from '../core/host.ts';
import { run, type RunResult } from '../core/proc.ts';
import { slug } from '../core/text.ts';
import { iosNeedBooted } from './booted.ts';
import { androidSelect, serial } from './device.ts';
import { needMac } from './tools.ts';

export type Json = Record<string, unknown>;

export function agentDeviceBin(): string {
  const bin = which('agent-device');
  if (!bin) die('agent-device is not installed', 'vysu setup');
  return bin;
}

// How to start the CLI. On Windows npm installs a `.cmd` shim, which Node no longer spawns without a
// shell: the package's own script is run by node instead, the same file the shim would have run. When
// that package is not beside the shim, the shim itself goes through cmd.exe (toolArgv): spawned bare,
// it failed with EINVAL, which reached the entry point as an internal error.
function cliArgv(args: string[]): { file: string; args: string[]; verbatim: boolean } {
  const bin = agentDeviceBin();
  if (isWindows && /\.(cmd|bat)$/i.test(bin)) {
    const root = packageRoot();
    const node = which('node');
    if (root && node) return { file: node, args: [join(root, 'bin', 'agent-device.mjs'), ...args], verbatim: false };
  }
  return toolArgv(bin, args);
}
// No call waits for ever: an Android `mlogin` once sat in one agent-device call for more than ten
// minutes. The ceiling is a minute past the longest wait the call announces itself (a wait's ms, an
// open's --timeout), two minutes at least; past it the call is a failure that says so, and the
// command carries on or dies the way it would on any other failure.
export function ceilingMs(args: string[]): number {
  const announced = Math.max(0, ...args.filter((a) => /^\d+$/.test(a)).map(Number));
  return 60000 + Math.max(60000, announced);
}
const silent = (ms: number): string => `agent-device did not answer in ${Math.round(ms / 1000)}s`;

async function runCli(args: string[], o: { inherit?: boolean } = {}): Promise<RunResult> {
  const c = cliArgv(args);
  if (o.inherit) return interactive(c.file, c.args, childEnv(), c.verbatim);
  const limit = ceilingMs(args);
  const t0 = Date.now();
  const r = await run(c.file, c.args, { env: childEnv(), verbatim: c.verbatim, timeoutMs: limit });
  if (r.code === 137 && Date.now() - t0 >= limit) return { ...r, code: 1, stderr: `${r.stderr}${silent(limit)}\n` };
  return r;
}

// A tool handed the terminal whole, stdin included: a passthrough may read a steps file from `-` or
// open a shell. `verbatim`: the arguments are already a cmd.exe command line (toolArgv).
export function interactive(cmd: string, args: string[], env?: NodeJS.ProcessEnv, verbatim = false): Promise<RunResult> {
  return new Promise((resolve) => {
    const child = spawn(cmd, args, { stdio: 'inherit', env, windowsVerbatimArguments: verbatim });
    child.on('error', (e) => resolve({ code: 127, stdout: '', stderr: e.message }));
    child.on('close', (code, signal) => resolve({ code: code ?? (signal ? 128 + 9 : 1), stdout: '', stderr: '' }));
  });
}

export function sessionName(p: Platform, device = devices.of(p)): string {
  return `${config().get('PROJECT')}-${p}-${slug(device)}`;
}

// The device a call is for, locked: iOS by its name, Android by the serial its AVD runs on.
async function select(p: Platform): Promise<void> {
  if (p === 'ios') {
    needMac('ios');
    await iosLock();
    await iosNeedBooted();
  } else if (p === 'android') {
    await androidSelect();
    await dropLeftovers();
  } else die('platform must be ios or android');
}

// An emulator takes the first free port: AVDs taking turns on one machine all come up as
// emulator-5554, and each left its agent-device session bound to that serial. The next AVD's first call
// was refused (« Device is already in use by session nidz-android-<another AVD> »), and one machine
// had two of them on the same port. vysu binds a session only to the serial its own AVD runs on, so a
// session of this project named after another AVD and bound to this serial is a leftover: dropped,
// once per command, before the first call.
let leftoversChecked = false;
async function dropLeftovers(): Promise<void> {
  if (leftoversChecked || !serial.value) return;
  leftoversChecked = true;
  const mine = sessionName('android');
  const prefix = `${config().get('PROJECT')}-android-`;
  for (const s of await sessionList()) {
    if (s.id !== serial.value || s.name === mine || !s.name.startsWith(prefix)) continue;
    await sessionClose(s.name);
    process.stderr.write(`vysu: android: dropped the session ${s.name}, left over on ${serial.value} by another AVD\n`);
  }
}

// Flags after the positionals: that is the order agent-device documents.
function targetFlags(p: Platform): string[] {
  const s = ['--session', sessionName(p)];
  return p === 'ios' ? [...s, '--platform', 'ios', '--device', devices.ios] : [...s, '--platform', 'android', '--serial', serial.value];
}

function childEnv(): NodeJS.ProcessEnv {
  const env = config().childEnv();
  if (serial.value) env.ANDROID_SERIAL = serial.value;
  return env;
}

// `ad <platform> <args…>`: the CLI on the chosen device, its output handed back.
export async function ad(p: Platform, args: string[], o: { inherit?: boolean } = {}): Promise<RunResult> {
  await select(p);
  return runCli([...args, ...targetFlags(p)], o);
}

// The CLI with no device (session list, close).
export function adPlain(args: string[]): Promise<RunResult> {
  return runCli(args);
}

// --- the library -----------------------------------------------------------------------------

interface Client {
  command: Record<string, (o: Json) => Promise<unknown>>;
  sessions: { list: (o?: Json) => Promise<Array<{ name: string; id?: string; device?: { id?: string } }>>; close: (o?: Json) => Promise<unknown> };
  apps: Record<string, (o: Json) => Promise<unknown>>;
  capture: Record<string, (o: Json) => Promise<unknown>>;
  interactions: Record<string, (o: Json) => Promise<unknown>>;
}
interface Lib {
  client: Client;
  normalize: (e: unknown) => Json;
  version: string;
}

function toolsMin(key: string): string {
  try {
    const m = new RegExp(`^${key}=(.*)$`, 'm').exec(readFileSync(join(ENGINE, 'tools.env'), 'utf8'));
    return m ? m[1]!.trim() : '';
  } catch {
    return '';
  }
}

export function versionBelow(v: string, min: string): boolean {
  const a = v.split(/[.-]/).map((x) => Number.parseInt(x, 10) || 0);
  const b = min.split(/[.-]/).map((x) => Number.parseInt(x, 10) || 0);
  for (let i = 0; i < 3; i++) if ((a[i] ?? 0) !== (b[i] ?? 0)) return (a[i] ?? 0) < (b[i] ?? 0);
  return false;
}

// The package root behind the `agent-device` on the PATH: through the npm symlink on macOS and Linux,
// beside the .cmd shim on Windows (npm puts both in the prefix, the package under node_modules).
function packageRoot(): string {
  const bin = which('agent-device');
  if (!bin) return '';
  const candidates: string[] = [];
  try {
    candidates.push(dirname(dirname(realpathSync(bin))));
  } catch {
    // a dangling link: nothing to load
  }
  if (isWindows) candidates.push(join(dirname(bin), 'node_modules', 'agent-device'));
  for (const root of candidates) {
    try {
      const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')) as { name?: string };
      if (pkg.name === 'agent-device') return root;
    } catch {
      // not this one
    }
  }
  return '';
}

let libLoading: Promise<Lib | null> | undefined;
export function agentLib(): Promise<Lib | null> {
  if (!libLoading) libLoading = loadLib();
  return libLoading;
}

async function loadLib(): Promise<Lib | null> {
  if ((process.env.VYSU_AGENT_DEVICE ?? '') === 'cli') return null;
  // The client starts the daemon every agent session shares with process.execPath, which under Bun is
  // bun: the CLI starts it on node, the runtime agent-device is made for.
  if (process.versions.bun) return null;
  const root = packageRoot();
  if (!root) return null;
  try {
    const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')) as {
      version?: string;
      main?: string;
      exports?: Record<string, { import?: string } | string>;
    };
    const min = toolsMin('AGENT_DEVICE_MIN');
    if (!pkg.version || (min && versionBelow(pkg.version, min))) return null;
    const dot = pkg.exports?.['.'];
    const entry = (typeof dot === 'string' ? dot : dot?.import) ?? pkg.main;
    if (!entry) return null;
    const m = (await import(pathToFileURL(join(root, entry)).href)) as {
      createAgentDeviceClient?: (c: Json) => Client;
      normalizeAgentDeviceError?: (e: unknown) => Json;
    };
    if (typeof m.createAgentDeviceClient !== 'function' || typeof m.normalizeAgentDeviceError !== 'function') return null;
    return { client: m.createAgentDeviceClient({ cwd: process.cwd() }), normalize: m.normalizeAgentDeviceError, version: pkg.version };
  } catch {
    return null;
  }
}

// --- one call, either way ----------------------------------------------------------------------

// What `agent-device … --json` prints: `{ success, data }` or `{ success: false, error }`.
export interface Answer {
  ok: boolean;
  data: Json;
  error: { code?: string; message?: string; [k: string]: unknown };
}

// A call is stated twice: the CLI arguments (the fallback, and what a reader recognises) and the
// library call that makes the same daemon request.
export interface Call {
  cli: string[];
  lib: (c: Client, base: Json) => Promise<unknown>;
}

function base(p: Platform): Json {
  return p === 'ios'
    ? { session: sessionName(p), platform: 'ios', device: devices.ios }
    : { session: sessionName(p), platform: 'android', serial: serial.value };
}

export async function adCall(p: Platform, call: Call): Promise<Answer> {
  await select(p);
  const lib = await agentLib();
  if (lib) {
    const limit = ceilingMs(call.cli);
    let timer: NodeJS.Timeout | undefined;
    const late = new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(Object.assign(new Error(silent(limit)), { code: 'TIMEOUT' })), limit);
    });
    try {
      const data = (await Promise.race([call.lib(lib.client, base(p)), late])) as Json | undefined;
      return { ok: true, data: data ?? {}, error: {} };
    } catch (e) {
      if ((e as { code?: unknown }).code === 'TIMEOUT') return { ok: false, data: {}, error: { code: 'TIMEOUT', message: (e as Error).message } };
      // An error agent-device raised is its answer, as the CLI would print it; anything else is the
      // library itself failing, and the CLI is still there.
      if (e && typeof e === 'object' && typeof (e as { code?: unknown }).code === 'string') {
        return { ok: false, data: {}, error: lib.normalize(e) as Answer['error'] };
      }
    } finally {
      clearTimeout(timer);
    }
  }
  const r = await runCli([...call.cli, '--json', ...targetFlags(p)]);
  return parseAnswer(r.stdout, r.code);
}

export function parseAnswer(stdout: string, code = 0): Answer {
  try {
    const d = JSON.parse(stdout || '{}') as { success?: boolean; data?: Json; error?: Answer['error'] };
    const ok = d.success ?? code === 0;
    return { ok, data: d.data ?? {}, error: d.error ?? {} };
  } catch {
    return { ok: false, data: {}, error: { message: 'agent-device answered no JSON' } };
  }
}

// The same answer as the file the CLI would have written: `snapshot -i --json > .snap-….json`.
export function answerJson(a: Answer): string {
  return JSON.stringify(a.ok ? { success: true, data: a.data } : { success: false, error: a.error }, null, 2);
}

// The sessions and the device each one is bound to (a simulator's UDID, an emulator's serial).
export async function sessionList(): Promise<Array<{ name: string; id: string }>> {
  const lib = await agentLib();
  if (lib) {
    try {
      // The library nests the device (`device.id`) where the CLI's JSON puts it flat (`id`).
      return (await lib.client.sessions.list()).map((s) => ({ name: s.name, id: s.device?.id ?? s.id ?? '' }));
    } catch {
      // the CLI below says the same, or nothing
    }
  }
  const r = await adPlain(['session', 'list', '--json']);
  const a = parseAnswer(r.stdout, r.code);
  const list = (a.data.sessions as Array<{ name?: string; id?: string }> | undefined) ?? [];
  return list.map((s) => ({ name: s.name ?? '', id: s.id ?? '' })).filter((s) => s.name);
}

// The session list, for a device-less question (is there a session on this device?).
export async function sessionNames(): Promise<string[]> {
  return (await sessionList()).map((s) => s.name);
}

// `agent-device close --session <name>`: ends the session and closes no app (it only closes one it
// is named).
export async function sessionClose(name: string): Promise<void> {
  const lib = await agentLib();
  if (lib) {
    try {
      await lib.client.sessions.close({ session: name });
      return;
    } catch {
      return;
    }
  }
  await adPlain(['close', '--session', name]);
}

// A snapshot as the CLI prints it. agent-device's client serialisation leaves out a label or an
// identifier of 24 characters or more that repeats its nearest ancestor's, and marks the node
// `inheritsLabel` / `inheritsIdentifier`; its library answers with the tree as the daemon holds it.
// 0.5.1 read the CLI's shape, and so do the screen line and its delta: without this, the children of
// a wrapper that names itself after a post carry that title into « screen: … » (an iOS feed card's
// button and its full-screen scroller both said « Un logo pour le panneau de l'entrée ? »).
type TreeNode = { index?: unknown; parentIndex?: unknown; label?: unknown; identifier?: unknown };
export function asPrinted<T>(data: T): T {
  const nodes = (data as { nodes?: unknown } | null)?.nodes;
  if (!Array.isArray(nodes) || nodes.length === 0) return data;
  const byIndex = new Map((nodes as TreeNode[]).map((n) => [n?.index, n]));
  const ancestors = (n: TreeNode, pick: (a: TreeNode) => unknown): string | undefined => {
    let a = typeof n.parentIndex === 'number' ? byIndex.get(n.parentIndex) : undefined;
    while (a) {
      const v = pick(a);
      if (typeof v === 'string' && v.length > 0) return v;
      a = typeof a.parentIndex === 'number' ? byIndex.get(a.parentIndex) : undefined;
    }
    return undefined;
  };
  const printed = (nodes as TreeNode[]).map((n) => {
    if (!n || typeof n !== 'object') return n;
    const label = typeof n.label === 'string' && n.label.length >= 24 && n.label === ancestors(n, (a) => a.label);
    const id = typeof n.identifier === 'string' && n.identifier.length >= 24 && n.identifier === ancestors(n, (a) => a.identifier);
    if (!label && !id) return n;
    const o: Record<string, unknown> = { ...n };
    if (label) {
      delete o.label;
      o.inheritsLabel = true;
    }
    if (id) {
      delete o.identifier;
      o.inheritsIdentifier = true;
    }
    return o;
  });
  return { ...(data as object), nodes: printed } as T;
}

// --- the calls vysu makes most -------------------------------------------------------------------

export const calls = {
  snapshot: (o: { interactive?: boolean; forceFull?: boolean; timeoutMs?: number }): Call => ({
    cli: ['snapshot', ...(o.interactive ? ['-i'] : []), ...(o.forceFull ? ['--force-full'] : []), ...(o.timeoutMs ? ['--timeout', String(o.timeoutMs)] : [])],
    lib: async (c, b) => asPrinted(await c.capture.snapshot!({ ...b, interactiveOnly: o.interactive || undefined, forceFull: o.forceFull || undefined, timeoutMs: o.timeoutMs })),
  }),
  // A selector (`label="…"`, `text="…"`, `role="button" label="…"`), a ref, or a point.
  press: (target: string, o: { settle?: boolean } = {}): Call => ({
    cli: ['press', target, ...(o.settle ? ['--settle'] : [])],
    lib: (c, b) => c.interactions.press!({ ...b, ...targetOf(target), settle: o.settle || undefined }),
  }),
  findPress: (query: string): Call => ({
    cli: ['find', query, 'press', '--first'],
    lib: (c, b) => c.interactions.find!({ ...b, query, action: 'click', first: true }),
  }),
  // `delayMs`: the pause between two keys (agent-device's --delay-ms); 0 types at the driver's speed.
  fill: (target: string | [number, number], text: string, delayMs = 0): Call => ({
    cli: ['fill', ...(Array.isArray(target) ? target.map(String) : [target]), text, ...(delayMs > 0 ? ['--delay-ms', String(delayMs)] : [])],
    lib: (c, b) => c.interactions.fill!({ ...b, ...(Array.isArray(target) ? { x: target[0], y: target[1] } : targetOf(target)), text, delayMs: delayMs > 0 ? delayMs : undefined }),
  }),
  type: (text: string, delayMs = 0): Call => ({
    cli: ['type', text, ...(delayMs > 0 ? ['--delay-ms', String(delayMs)] : [])],
    lib: (c, b) => c.interactions.type!({ ...b, text, delayMs: delayMs > 0 ? delayMs : undefined }),
  }),
  keyboard: (action: 'status' | 'return' | 'dismiss'): Call => ({
    cli: ['keyboard', action],
    lib: (c, b) => c.command.keyboard!({ ...b, action }),
  }),
  back: (o: { system?: boolean; settle?: boolean }): Call => ({
    cli: ['back', ...(o.system ? ['--system'] : []), ...(o.settle ? ['--settle'] : [])],
    lib: (c, b) => c.command.back!({ ...b, mode: o.system ? 'system' : undefined, settle: o.settle || undefined }),
  }),
  waitText: (text: string, timeoutMs: number): Call => ({
    cli: ['wait', 'text', text, String(timeoutMs)],
    lib: (c, b) => c.command.wait!({ ...b, text, timeoutMs }),
  }),
  waitStable: (quietMs: number, timeoutMs: number): Call => ({
    cli: ['wait', 'stable', String(quietMs), String(timeoutMs)],
    lib: (c, b) => c.command.wait!({ ...b, stable: true, quietMs, timeoutMs }),
  }),
  scroll: (direction: 'up' | 'down' | 'top', o: { pixels?: number; settle?: boolean } = {}): Call => ({
    cli: ['scroll', direction, ...(o.pixels ? ['--pixels', String(o.pixels)] : []), ...(o.settle ? ['--settle'] : [])],
    lib: (c, b) => c.interactions.scroll!({ ...b, direction, pixels: o.pixels, settle: o.settle || undefined }),
  }),
  screenshot: (path: string, o: { scale?: string; normalizeStatusBar?: boolean } = {}): Call => ({
    cli: ['screenshot', path, ...(o.scale ? ['--scale', o.scale] : []), ...(o.normalizeStatusBar ? ['--normalize-status-bar'] : [])],
    lib: (c, b) => c.capture.screenshot!({ ...b, path, scale: o.scale ? Number(o.scale) : undefined, normalizeStatusBar: o.normalizeStatusBar || undefined }),
  }),
  open: (app: string, o: { timeoutMs?: number; foreground?: boolean } = {}): Call => ({
    cli: ['open', app, ...(o.timeoutMs ? ['--timeout', String(o.timeoutMs)] : []), ...(o.foreground ? ['--foreground'] : [])],
    lib: (c, b) => c.apps.open!({ ...b, app, timeoutMs: o.timeoutMs, foreground: o.foreground || undefined }),
  }),
  push: (app: string, payloadFile: string): Call => ({
    cli: ['push', app, payloadFile],
    lib: (c, b) => c.apps.push!({ ...b, app, payload: payloadFile }),
  }),
};

// A target as the CLI reads one: `@e12` (or `@e12~s3`) is a ref, two numbers a point, the rest a
// selector.
function targetOf(t: string): Json {
  if (t.startsWith('@')) return { ref: t };
  return { selector: t };
}
