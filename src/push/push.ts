// The push drivers: which ones the project enabled (VYSU_PUSH), the presets it keeps in
// `.vysu/push/<preset>.json` with their `{{field}}` placeholders, and the one command that sends one —
// `vysu push ios <preset>` on the simulator, `vysu push <persona> <preset>` for real. A driver is the
// engine's own (connectors/push, in TypeScript) or the project's: `.vysu/push-drivers/<name>.mjs`, or
// the `.sh` form of the bash engine, run through bash with the functions it was written against.
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { config } from '../core/ctx.ts';
import { ENGINE } from '../core/config.ts';
import { die, exit, log } from '../core/errors.ts';
import type { Platform } from '../core/hold.ts';
import { isWindows, which } from '../core/host.ts';
import { personaVar } from '../core/personas.ts';
import { run, type RunResult } from '../core/proc.ts';
import { ad } from '../mobile/agent.ts';
import { say } from '../mobile/io.ts';

// What a driver is handed: the primitives the bash drivers called by name.
export interface PushContext {
  cfg(key: string, fallback?: string): string;
  need(key: string, why: string): string;
  die(message: string, next?: string): never;
  log(message: string): void;
  say(line: string): void;
  personaVar(persona: string, key: string): string;
  // The preset with its placeholders filled from `k=v` pairs.
  payload(preset: string, fields: string[]): string;
  // agent-device on the chosen simulator / emulator, under its lock.
  mob(platform: Platform, args: string[]): Promise<RunResult>;
  state: string;
  personas: string;
}
export interface PushSend {
  target: string;
  preset: string;
  platform: string;
  fields: string[];
}
export interface PushDriver {
  describe(v: PushContext): string | Promise<string>;
  send(v: PushContext, s: PushSend): Promise<void>;
}

export const context: PushContext = {
  cfg: (k, d = '') => config().get(k, d),
  need: (k, why) => config().need(k, why),
  die: (m, n) => die(m, n),
  log: (m) => log(m),
  say: (l) => say(l),
  personaVar: (p, k) => personaVar(p, k),
  payload: (preset, fields) => pushPayload(preset, fields),
  mob: (p, args) => ad(p, args),
  get state() {
    return config().state;
  },
  get personas() {
    return config().personas;
  },
};

// A preset is a file the project owns; the engine ships none. `{{field}}` placeholders are filled from
// --field, so a preset can carry an entity id without the caller repeating it every time it is the same.
export function fillPreset(text: string, fields: string[]): { out: string; missing: string[] } {
  const values = new Map<string, string>();
  for (const a of fields) {
    const eq = a.indexOf('=');
    if (eq >= 0) values.set(a.slice(0, eq), a.slice(eq + 1));
  }
  const missing: string[] = [];
  const out = text.replace(/{{\s*([A-Za-z0-9_.-]+)\s*}}/g, (m, key: string) => {
    const k = key.trim();
    if (values.has(k)) return values.get(k)!;
    missing.push(k);
    return m;
  });
  return { out, missing: [...new Set(missing)].sort() };
}

export function pushPayload(preset: string, fields: string[]): string {
  config().needProject();
  const file = join(config().vysuDir, 'push', `${preset}.json`);
  if (!existsSync(file)) die(`no push preset « ${preset} » (${file})`);
  const { out, missing } = fillPreset(readFileSync(file, 'utf8'), fields);
  if (missing.length) {
    process.stderr.write(`vysu push: no value for ${missing.join(', ')} (--field ${missing[0]}=…)\n`);
    exit(1);
  }
  return out;
}

// --- loading a driver ----------------------------------------------------------------------------

const BUILTIN: Record<string, () => Promise<PushDriver>> = {
  'apns-sim': async () => (await import('../connectors/push/apns-sim.ts')).driver,
  fcm: async () => (await import('../connectors/push/fcm.ts')).driver,
  webhook: async () => (await import('../connectors/push/webhook.ts')).driver,
};

function projectDriver(name: string): string {
  const dir = config().vysuDir;
  if (!dir) return '';
  for (const ext of ['.mjs', '.js', '.sh']) {
    const f = join(dir, 'push-drivers', `${name}${ext}`);
    if (existsSync(f)) return f;
  }
  return '';
}

// The project's own driver first, then the engine's.
export async function loadDriver(name: string): Promise<PushDriver> {
  const own = projectDriver(name);
  if (own.endsWith('.sh')) return bashDriver(own);
  if (own) {
    const m = (await import(pathToFileURL(own).href)) as Partial<PushDriver>;
    if (typeof m.send !== 'function') die(`push driver ${own} exports no send()`);
    return { describe: m.describe ?? (() => own), send: m.send };
  }
  const builtin = BUILTIN[name];
  if (!builtin) die(`no push driver « ${name} » (${join(ENGINE, 'connectors', 'push', `${name}.ts`)})`);
  return builtin();
}

// A `.sh` driver, sourced by bash as it always was, with the functions it calls defined around it: the
// config through the exported VYSU_* values, the personas file, and the engine itself for the preset
// and for agent-device.
const PRELUDE = join(import.meta.dirname, 'prelude.sh');

function bashDriver(file: string): PushDriver {
  const bash = isWindows ? '' : which('bash');
  const call = async (args: string[], inherit: boolean): Promise<RunResult> => {
    if (!bash) die(`${file} is a bash push driver, and this machine has no bash (write it as ${file.replace(/\.sh$/, '.mjs')})`);
    const env = config().exportedEnv({ VYSU_CONFIG_FILE: config().configFile, PERSONAS: config().personas, STATE: config().state, VYSU_ENGINE: ENGINE });
    return run(bash, [PRELUDE, file, ...args], { env, inherit });
  };
  return {
    describe: async () => (await call(['describe'], false)).stdout.replace(/\n$/, ''),
    send: async (_v, s) => {
      const r = await call(['send', s.target, s.preset, ...(s.platform ? ['--platform', s.platform] : []), ...s.fields], true);
      if (r.code !== 0) exit(r.code);
    },
  };
}

// --- the command ---------------------------------------------------------------------------------

const enabled = (): string[] => config().get('PUSH').split(',').filter(Boolean);

export const PUSH_USAGE = 'usage: vysu push ios <preset> | vysu push <persona> <preset> [--platform ios|android] [--field k=v]…';

export async function push(args: string[]): Promise<void> {
  const [target = '', preset = ''] = args;
  if (!target || !preset) die(PUSH_USAGE);
  let platform = '';
  const fields: string[] = [];
  for (let i = 2; i < args.length; i += 2) {
    if (args[i] === '--platform') platform = args[i + 1] ?? '';
    else if (args[i] === '--field') fields.push(args[i + 1] ?? '');
    else die(`vysu push: unknown option ${args[i]}`);
  }
  config().needProject();
  if (target === 'ios') {
    // The simulator has no push service: the payload is handed to it directly.
    if (!enabled().includes('apns-sim')) die('vysu push ios: the driver « apns-sim » is not in VYSU_PUSH');
    await (await loadDriver('apns-sim')).send(context, { target: 'ios', preset, platform: '', fields });
    return;
  }
  // A real send goes through the first enabled driver that can reach a device: fcm, webhook, or one
  // the project wrote itself.
  for (const d of enabled()) {
    if (d === 'fcm' || d === 'webhook' || (d !== 'apns-sim' && projectDriver(d))) {
      await (await loadDriver(d)).send(context, { target, preset, platform, fields });
      return;
    }
  }
  die('vysu push: no real-send driver in VYSU_PUSH (fcm or webhook)');
}

// For `vysu doctor`: one line per driver VYSU_PUSH enables.
export async function pushDescribeLines(): Promise<string[]> {
  const drivers = enabled();
  if (!drivers.length) return ['push: (none — VYSU_PUSH is not set)'];
  const out: string[] = [];
  for (const d of drivers) {
    try {
      out.push(`push: ${d} — ${await (await loadDriver(d)).describe(context)}`);
    } catch (e) {
      out.push(`push: ${d} — ${e instanceof Error ? e.message : String(e)}`);
    }
  }
  return out;
}
