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
import { readFileSync, realpathSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { config } from '../core/ctx.ts';
import { ENGINE } from '../core/config.ts';
import { die } from '../core/errors.ts';
import { devices, iosLock, type Platform } from '../core/hold.ts';
import { isWindows, which } from '../core/host.ts';
import { run, type RunResult } from '../core/proc.ts';
import { slug } from '../core/text.ts';
import { androidSelect, serial } from './device.ts';
import { needMac } from './tools.ts';

export type Json = Record<string, unknown>;

export function agentDeviceBin(): string {
  const bin = which('agent-device');
  if (!bin) die('agent-device is not installed', 'vysu setup');
  return bin;
}

export function sessionName(p: Platform, device = devices.of(p)): string {
  return `${config().get('PROJECT')}-${p}-${slug(device)}`;
}

// The device a call is for, locked: iOS by its name, Android by the serial its AVD runs on.
async function select(p: Platform): Promise<void> {
  if (p === 'ios') {
    needMac('ios');
    await iosLock();
  } else if (p === 'android') await androidSelect();
  else die('platform must be ios or android');
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
  return run(agentDeviceBin(), [...args, ...targetFlags(p)], { env: childEnv(), inherit: o.inherit });
}

// The CLI with no device (session list, close).
export function adPlain(args: string[]): Promise<RunResult> {
  return run(agentDeviceBin(), args, { env: childEnv() });
}

// --- the library -----------------------------------------------------------------------------

interface Client {
  command: Record<string, (o: Json) => Promise<unknown>>;
  sessions: { list: (o?: Json) => Promise<Array<{ name: string }>>; close: (o?: Json) => Promise<unknown> };
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
    try {
      const data = (await call.lib(lib.client, base(p))) as Json | undefined;
      return { ok: true, data: data ?? {}, error: {} };
    } catch (e) {
      // An error agent-device raised is its answer, as the CLI would print it; anything else is the
      // library itself failing, and the CLI is still there.
      if (e && typeof e === 'object' && typeof (e as { code?: unknown }).code === 'string') {
        return { ok: false, data: {}, error: lib.normalize(e) as Answer['error'] };
      }
    }
  }
  const r = await run(agentDeviceBin(), [...call.cli, '--json', ...targetFlags(p)], { env: childEnv() });
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

// The session list, for a device-less question (is there a session on this device?).
export async function sessionNames(): Promise<string[]> {
  const lib = await agentLib();
  if (lib) {
    try {
      return (await lib.client.sessions.list()).map((s) => s.name);
    } catch {
      // the CLI below says the same, or nothing
    }
  }
  const r = await adPlain(['session', 'list', '--json']);
  const a = parseAnswer(r.stdout, r.code);
  const list = (a.data.sessions as Array<{ name?: string }> | undefined) ?? [];
  return list.map((s) => s.name ?? '').filter(Boolean);
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

// --- the calls vysu makes most -------------------------------------------------------------------

export const calls = {
  snapshot: (o: { interactive?: boolean; forceFull?: boolean; timeoutMs?: number }): Call => ({
    cli: ['snapshot', ...(o.interactive ? ['-i'] : []), ...(o.forceFull ? ['--force-full'] : []), ...(o.timeoutMs ? ['--timeout', String(o.timeoutMs)] : [])],
    lib: (c, b) => c.capture.snapshot!({ ...b, interactiveOnly: o.interactive || undefined, forceFull: o.forceFull || undefined, timeoutMs: o.timeoutMs }),
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
  fill: (target: string | [number, number], text: string): Call => ({
    cli: ['fill', ...(Array.isArray(target) ? target.map(String) : [target]), text],
    lib: (c, b) => c.interactions.fill!({ ...b, ...(Array.isArray(target) ? { x: target[0], y: target[1] } : targetOf(target)), text }),
  }),
  type: (text: string): Call => ({
    cli: ['type', text],
    lib: (c, b) => c.interactions.type!({ ...b, text }),
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
