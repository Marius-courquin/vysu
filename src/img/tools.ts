// The image and recording helpers, by the name the bash engine called them (py/<name>.py), with the
// same arguments and the same output. A ported helper is a module of this folder exporting
// `main(argv, io)` and runs in this process; one not ported yet still runs its Python script. Callers
// never know which: that is what lets the web and mobile code move before the last script does.
import { join } from 'node:path';
import { ENGINE } from '../core/config.ts';
import { VysuError } from '../core/errors.ts';
import { run, type RunResult } from '../core/proc.ts';

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
  | 'screen'
  | 'screencap'
  | 'stitch'
  | 'take'
  | 'verdict';

// name → the module, once it is ported.
const ported: Partial<Record<Tool, () => Promise<{ main: ToolMain }>>> = {
  compare: () => import('./compare.ts'),
  burst: () => import('./burst.ts'),
  diff: () => import('./diff.ts'),
  fields: () => import('./fields.ts'),
  mark: () => import('./mark.ts'),
  screencap: () => import('./screencap.ts'),
  stitch: () => import('./stitch.ts'),
  verdict: () => import('./verdict.ts'),
};

// What a Python traceback was: the helper failed on something it did not foresee (an unreadable
// file, a disk full), exit 1 and the reason on stderr. A VysuError still crosses to the entry point.
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
  const load = ported[name];
  if (!load) return run('python3', [join(ENGINE, 'py', `${name}.py`), ...argv], { input: opts.input });
  const out: string[] = [];
  const err: string[] = [];
  const io: Io = {
    out: (s) => out.push(s),
    err: (s) => err.push(s),
    stdin: opts.input === undefined ? undefined : Buffer.isBuffer(opts.input) ? opts.input : Buffer.from(opts.input),
  };
  const code = await guarded(name, (await load()).main, argv, io);
  return { code, stdout: out.join(''), stderr: err.join('') };
}

// The same, straight to this process's own streams: `vysu mark`, `vysu frame`.
export async function toolPassthrough(name: Tool, argv: string[]): Promise<number> {
  const load = ported[name];
  if (!load) return (await run('python3', [join(ENGINE, 'py', `${name}.py`), ...argv], { inherit: true })).code;
  return guarded(name, (await load()).main, argv, { out: (s) => process.stdout.write(s), err: (s) => process.stderr.write(s) });
}
