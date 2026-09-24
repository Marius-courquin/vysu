// The engine itself and the two node tools it drives: which version this is, which versions of
// agent-browser and agent-device it was checked against, and whether the machine has them.
import { copyFileSync, existsSync, mkdirSync, readFileSync, realpathSync, renameSync, rmSync, statSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { ENGINE } from '../core/config.ts';
import { config } from '../core/ctx.ts';
import { onCleanup } from '../core/errors.ts';
import { which } from '../core/host.ts';
import { run, runTool } from '../core/proc.ts';
import { parseShellEnv } from '../core/shellenv.ts';
import { sleep } from '../core/text.ts';
import { info, miss, ok, warn } from '../core/ui.ts';
import { installHint } from './hints.ts';

const readText = (p: string): string => {
  try {
    return readFileSync(p, 'utf8');
  } catch {
    return '';
  }
};

// The VERSION file, as `cat` gave it: its trailing newline dropped, and `fallback` when it is gone.
export function engineVersion(fallback = 'unknown'): string {
  const v = readText(join(ENGINE, 'VERSION'));
  return v ? v.replace(/\n+$/, '') : fallback;
}

export async function git(args: string[], opts: { inherit?: boolean } = {}): Promise<{ code: number; out: string }> {
  const r = await run(which('git') || 'git', ['-C', ENGINE, ...args], { inherit: opts.inherit });
  return { code: r.code, out: r.stdout.replace(/\n+$/, '') };
}

export async function engineSha(): Promise<string> {
  const r = await git(['rev-parse', '--short', 'HEAD']);
  return r.code === 0 && r.out ? r.out : 'unknown';
}

// Ordered version comparison on the first three numbers: is a strictly below b. Equal numbers with
// different spellings (1.0 and 1.0.0) fall back to the spellings' order, as the sort it replaces did.
export function versionBelow(a: string, b: string): boolean {
  if (a === b) return false;
  const key = (v: string): number[] => {
    const parts = v.split('.');
    return [0, 1, 2].map((i) => Number.parseInt(parts[i] ?? '', 10) || 0);
  };
  const ka = key(a);
  const kb = key(b);
  for (let i = 0; i < 3; i++) if (ka[i] !== kb[i]) return ka[i]! < kb[i]!;
  return a < b;
}

export function versionWarn(): void {
  const want = config().get('MIN_VERSION');
  if (!want) return;
  const have = engineVersion('0.0.0');
  if (!versionBelow(have, want)) return;
  process.stderr.write(`vysu: this project asks for vysu >= ${want}, this engine is ${have} (vysu update)\n`);
}

// --- the two node tools ------------------------------------------------------------------------

export const TOOLS = ['agent-browser', 'agent-device'] as const;
export type NodeTool = (typeof TOOLS)[number];

// `tools.env` in the engine root names the versions this engine was checked against: one file to
// raise when the engine starts relying on something newer, read by setup, update, doctor and
// version rather than by four copies of the same two numbers. Read each time: `update` reads the
// one it just pulled.
export function toolMin(tool: NodeTool): string {
  const text = readText(join(ENGINE, 'tools.env'));
  if (!text) return '';
  const key = tool === 'agent-browser' ? 'AGENT_BROWSER_MIN' : 'AGENT_DEVICE_MIN';
  try {
    return parseShellEnv(text, () => undefined, '').find((a) => a.key === key)?.value ?? '';
  } catch {
    return '';
  }
}

// The version an npm-installed CLI carries in its package.json, found from the command on the PATH
// (a link into the package, or on Windows a shim beside node_modules): no process to start, where
// `--version` cost one per tool.
function packageVersion(tool: string, bin: string): string {
  const candidates: string[] = [];
  try {
    let dir = dirname(realpathSync(bin));
    for (let i = 0; i < 6; i++) {
      candidates.push(join(dir, 'package.json'));
      const up = dirname(dir);
      if (up === dir) break;
      dir = up;
    }
  } catch {
    // a dangling link: the version is asked of the tool
  }
  candidates.push(join(dirname(bin), 'node_modules', tool, 'package.json'));
  for (const p of candidates) {
    if (!existsSync(p)) continue;
    try {
      const pkg = JSON.parse(readFileSync(p, 'utf8')) as { name?: string; version?: string };
      if (pkg.name === tool && pkg.version) return pkg.version;
    } catch {
      // not a package file
    }
  }
  return '';
}

// The three numbers, whatever the tool wraps them in.
export async function toolVersion(tool: string, fresh = false): Promise<string> {
  const bin = which(tool, fresh);
  if (!bin) return '';
  const fromPackage = packageVersion(tool, bin);
  if (fromPackage) return /\d+\.\d+\.\d+/.exec(fromPackage)?.[0] ?? '';
  const r = await runTool(tool, ['--version']);
  const first = r.stdout.split('\n')[0] ?? '';
  return /\d+\.\d+\.\d+/.exec(first)?.[0] ?? '';
}

async function npmGlobal(spec: string): Promise<void> {
  await runTool('npm', ['i', '-g', spec]);
}

// One line per tool, in the three shapes of ui.ts. `install` upgrades what is below the minimum,
// `report` only says so — which is what an agent running setup without a terminal, and doctor,
// both want.
export async function toolsCheck(mode: 'install' | 'report'): Promise<void> {
  const versions = await Promise.all(TOOLS.map((t) => toolVersion(t)));
  for (const [i, tool] of TOOLS.entries()) {
    const want = toolMin(tool);
    let have = versions[i]!;
    if (!have) {
      if (mode === 'install') {
        info(`${tool}: installing…`);
        await npmGlobal(tool);
        have = await toolVersion(tool, true);
      }
      if (!have) {
        miss(`${tool}: missing — no browser or device automation without it`, `npm i -g ${tool}`);
        continue;
      }
    }
    if (want && versionBelow(have, want)) {
      if (mode === 'install') {
        info(`${tool}: ${have} → ${want} or better, upgrading…`);
        await npmGlobal(`${tool}@latest`);
        have = await toolVersion(tool, true);
      }
      if (want && versionBelow(have, want)) {
        warn(`${tool}: ${have}, this engine expects >= ${want}`, `npm i -g ${tool}@latest`);
        continue;
      }
    }
    ok(`${tool}: ${have}`);
  }
}

// --- what the engine runs on -------------------------------------------------------------------

// 22.18 and later run the engine as it is; from 22.6 bin/vysu.mjs runs it with the flag that strips types.
export const NODE_MIN = '22.6.0';

// The node the drivers run on. Under Node it is this very process; under bun it is whatever `node`
// the PATH has, since agent-browser and agent-device need one.
export async function nodeVersion(): Promise<string> {
  if (!process.versions.bun) return process.version;
  if (!which('node')) return '';
  const r = await run(which('node'), ['--version']);
  return r.stdout.trim();
}

export async function nodeCheck(): Promise<void> {
  const v = await nodeVersion();
  if (!v) {
    miss(`node: missing — every driver runs on it (>= ${NODE_MIN.replace(/\.0$/, '')})`, installHint('node'));
    return;
  }
  if (versionBelow(v.replace(/^v/, ''), NODE_MIN)) {
    miss(`node: ${v}, the engine needs >= ${NODE_MIN.replace(/\.0$/, '')}`, installHint('node'));
    return;
  }
  ok(`node: ${v}`);
}

// The engine's own dependencies (`npm ci --omit=dev` in its folder): sharp, which every sheet,
// report and diff composes with. install.sh and `vysu update` put them there; a clone by hand does
// not.
export function engineDepsVersion(): string {
  try {
    const pkg = JSON.parse(readFileSync(join(ENGINE, 'node_modules', 'sharp', 'package.json'), 'utf8')) as { version?: string };
    return pkg.version ?? '';
  } catch {
    return '';
  }
}

export function engineDepsCheck(): void {
  const v = engineDepsVersion();
  if (v) ok(`engine: dependencies installed (sharp ${v})`);
  else miss('engine: dependencies missing — no sheet, no report, no diff without sharp', `cd ${ENGINE} && npm ci --omit=dev`);
}

// '' once installed, else what went wrong.
export async function npmCiEngine(): Promise<string> {
  return installStaged(ENGINE, async (cwd) => (await runTool('npm', ['ci', '--omit=dev', '--no-audit', '--no-fund'], { cwd })).code === 0);
}

// Installed beside the live node_modules, then swapped in with two renames. Other agents' vysu run from
// this folder meanwhile: `npm ci` in place deleted node_modules first (a lazy import('sharp') then
// failed), and on Windows a sharp.node another vysu had loaded stopped it half way. The bootstrap
// (bin/vysu.mjs) installs under the same lock directory when sharp is missing, so the two never
// install at once, and a command started between the two renames waits for the second.
export async function installStaged(root: string, install: (cwd: string) => Promise<boolean>): Promise<string> {
  const lock = join(root, '.install-lock');
  const taken = await installLock(lock);
  if (taken) return taken;
  const release = (): void => rmSync(lock, { recursive: true, force: true });
  const disarm = onCleanup(release, true);
  const stage = join(root, '.install-stage');
  const live = join(root, 'node_modules');
  const old = join(root, '.node_modules.old');
  try {
    rmSync(stage, { recursive: true, force: true });
    mkdirSync(stage);
    for (const f of ['package.json', 'package-lock.json']) copyFileSync(join(root, f), join(stage, f));
    if (!(await install(stage))) return 'npm ci --omit=dev failed';
    // What a previous update could not remove (Windows, a sharp.node still loaded then).
    rmSync(old, { recursive: true, force: true });
    try {
      renameSync(live, old);
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== 'ENOENT') return `node_modules could not be moved aside (${(e as NodeJS.ErrnoException).code ?? 'error'}: another vysu has it open?)`;
    }
    try {
      renameSync(join(stage, 'node_modules'), live);
    } catch (e) {
      if (existsSync(old)) renameSync(old, live);
      return `the new node_modules could not be moved in (${(e as NodeJS.ErrnoException).code ?? 'error'})`;
    }
    try {
      rmSync(old, { recursive: true, force: true });
    } catch {
      // Windows: a sharp.node another vysu still has loaded; the next update removes it.
    }
    return '';
  } catch (e) {
    return `the install stopped: ${e instanceof Error ? e.message : String(e)}`;
  } finally {
    try {
      rmSync(stage, { recursive: true, force: true });
    } catch {
      // left for the next update, which starts by removing it
    }
    disarm();
    release();
  }
}

// The bootstrap's lock: a directory, taken by whoever creates it; one older than ten minutes is an
// install that died. '' once held, else why not.
async function installLock(lock: string): Promise<string> {
  for (let i = 0; i < 600; i++) {
    try {
      mkdirSync(lock);
      return '';
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== 'EEXIST') return `cannot create ${lock} (${(e as NodeJS.ErrnoException).code ?? 'error'})`;
    }
    try {
      if (Date.now() - statSync(lock).mtimeMs > 600_000) rmSync(lock, { recursive: true, force: true });
    } catch {
      // gone meanwhile: the next mkdir takes it
    }
    if (i === 0) process.stderr.write(`vysu: another vysu is installing the engine's dependencies (${lock}) — waiting\n`);
    await sleep(500);
  }
  return `${lock} was held for five minutes`;
}

export async function ffmpegVersion(): Promise<string> {
  if (!which('ffmpeg')) return '';
  const r = await run(which('ffmpeg'), ['-version']);
  return (r.stdout.split('\n')[0] ?? '').split(' ')[2] ?? '';
}

export function ffmpegReport(version: string): void {
  if (which('ffmpeg')) ok(`ffmpeg: ${version}`);
  else warn('ffmpeg: missing — optional, unlocks rec / mrec / video', installHint('ffmpeg'));
}
