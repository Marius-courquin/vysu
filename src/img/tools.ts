// The image and recording helpers, by name: each is a module of this folder exporting
// `main(argv, io)`, run in this process with a command line and answering on its own stdout and
// stderr, the way the web and mobile code and `vysu mark` / `vysu frame` call it. The module is
// loaded only when its helper is asked for.
import { VysuError } from '../core/errors.ts';
import type { RunResult } from '../core/proc.ts';

export interface Io {
  out(s: string): void;
  err(s: string): void;
  stdin?: Buffer;
}
export type ToolMain = (argv: string[], io: Io) => Promise<number>;
export type Tool =
  | 'burst'
  | 'compare'
  | 'diff'
  | 'fields'
  | 'frame'
  | 'mark'
  | 'motion'
  | 'pace'
  | 'screen'
  | 'screencap'
  | 'stitch'
  | 'take'
  | 'verdict';

const helpers: Record<Tool, () => Promise<{ main: ToolMain }>> = {
  burst: () => import('./burst.ts'),
  compare: () => import('./compare.ts'),
  diff: () => import('./diff.ts'),
  fields: () => import('./fields.ts'),
  frame: () => import('./frame.ts'),
  mark: () => import('./mark.ts'),
  motion: () => import('./motion.ts'),
  pace: () => import('./pace.ts'),
  screen: () => import('./screen.ts'),
  screencap: () => import('./screencap.ts'),
  stitch: () => import('./stitch.ts'),
  take: () => import('./take.ts'),
  verdict: () => import('./verdict.ts'),
};

// A helper that fails on something it did not foresee (an unreadable file, a disk full) exits 1 with
// the reason on stderr, prefixed with its name, and its caller reads that like any other failure. A
// VysuError still crosses to the entry point.
async function guarded(name: Tool, main: ToolMain, argv: string[], io: Io): Promise<number> {
  try {
    return await main(argv, io);
  } catch (e) {
    if (e instanceof VysuError) throw e;
    io.err(`${name}: ${e instanceof Error ? e.message : String(e)}\n`);
    return 1;
  }
}

export async function tool(name: Tool, argv: string[], opts: { input?: Buffer | string } = {}): Promise<RunResult> {
  const out: string[] = [];
  const err: string[] = [];
  const io: Io = {
    out: (s) => out.push(s),
    err: (s) => err.push(s),
    stdin: opts.input === undefined ? undefined : Buffer.isBuffer(opts.input) ? opts.input : Buffer.from(opts.input),
  };
  const code = await guarded(name, (await helpers[name]()).main, argv, io);
  return { code, stdout: out.join(''), stderr: err.join('') };
}

// The same, straight to this process's own streams: `vysu mark`, `vysu frame`.
export async function toolPassthrough(name: Tool, argv: string[]): Promise<number> {
  return guarded(name, (await helpers[name]()).main, argv, { out: (s) => process.stdout.write(s), err: (s) => process.stderr.write(s) });
}
