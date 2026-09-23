// The command lines the Python helpers took through argparse, read the same way: options in any order,
// `--opt=value`, a unique prefix for a long option (`--thr 0.2`), `--` ending the options, and the
// same errors on stderr with exit 2 (« argument --threshold: invalid float value: 'x' »).
import type { Io } from './tools.ts';
import { pyFloat, pyInt, pyStrRepr } from './fmt.ts';

export interface OptSpec {
  kind: 'str' | 'int' | 'float' | 'flag' | 'append';
  dest?: string;
  choices?: string[];
  required?: boolean;
  metavar?: string;
  def?: unknown;
}
export interface PosSpec {
  name: string;
  nargs?: '?' | '+';
}
export interface ParserSpec {
  prog: string;
  // argparse's usage line(s), as it printed them: they head every error.
  usage: string;
  // What -h prints under the usage.
  help?: string;
  pos: PosSpec[];
  opts: Record<string, OptSpec>;
}
export type Parsed = Record<string, unknown>;

class ArgError extends Error {}

const negative = /^-\d+$|^-\d*\.\d+$/;
const isOption = (s: string): boolean => s.startsWith('-') && s !== '-' && !negative.test(s) && !s.includes(' ');

const destOf = (flag: string, o: OptSpec): string => o.dest ?? flag.replace(/^-+/, '').replace(/-/g, '_');

function convert(flag: string, o: OptSpec, raw: string): unknown {
  if (o.choices && !o.choices.includes(raw)) {
    throw new ArgError(`argument ${flag}: invalid choice: ${pyStrRepr(raw)} (choose from ${o.choices.map(pyStrRepr).join(', ')})`);
  }
  if (o.kind === 'int') {
    const n = pyInt(raw);
    if (n === null) throw new ArgError(`argument ${flag}: invalid int value: ${pyStrRepr(raw)}`);
    return n;
  }
  if (o.kind === 'float') {
    const n = pyFloat(raw);
    if (n === null) throw new ArgError(`argument ${flag}: invalid float value: ${pyStrRepr(raw)}`);
    return n;
  }
  return raw;
}

function resolveFlag(spec: ParserSpec, token: string): string | null {
  if (token in spec.opts || token === '-h' || token === '--help') return token;
  if (!token.startsWith('--')) return null;
  const hits = ['--help', ...Object.keys(spec.opts)].filter((f) => f.startsWith(token));
  if (hits.length > 1) throw new ArgError(`ambiguous option: ${token} could match ${hits.join(', ')}`);
  return hits[0] ?? null;
}

function parseOrThrow(spec: ParserSpec, argv: string[]): Parsed | 'help' {
  const out: Parsed = {};
  for (const [flag, o] of Object.entries(spec.opts)) {
    out[destOf(flag, o)] = o.kind === 'flag' ? false : o.kind === 'append' ? [] : (o.def ?? null);
  }
  const seen = new Set<string>();
  const runs: string[][] = [[]];
  const extras: string[] = [];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!;
    if (a === '--') {
      runs.at(-1)!.push(...argv.slice(i + 1));
      break;
    }
    if (!isOption(a)) {
      runs.at(-1)!.push(a);
      continue;
    }
    const eq = a.startsWith('--') ? a.indexOf('=') : -1;
    const token = eq > 0 ? a.slice(0, eq) : a;
    const flag = resolveFlag(spec, token);
    if (flag === '-h' || flag === '--help') return 'help';
    if (!flag) {
      extras.push(a);
      runs.push([]);
      continue;
    }
    const o = spec.opts[flag]!;
    const dest = destOf(flag, o);
    seen.add(flag);
    runs.push([]);
    if (o.kind === 'flag') {
      if (eq > 0) throw new ArgError(`argument ${flag}: ignored explicit argument ${pyStrRepr(a.slice(eq + 1))}`);
      out[dest] = true;
      continue;
    }
    let raw: string;
    if (eq > 0) raw = a.slice(eq + 1);
    else {
      const next = argv[i + 1];
      if (next === undefined || isOption(next)) throw new ArgError(`argument ${flag}: expected one argument`);
      raw = next;
      i++;
    }
    const v = convert(flag, o, raw);
    if (o.kind === 'append') (out[dest] as unknown[]).push(v);
    else out[dest] = v;
  }

  // Positionals the way argparse matches them: run by run, a `+` taking the rest of its run only.
  let p = 0;
  const pending = spec.pos.map(() => [] as string[]);
  const filled = spec.pos.map(() => false);
  for (const run of runs) {
    let k = 0;
    while (k < run.length && p < spec.pos.length) {
      const pos = spec.pos[p]!;
      if (pos.nargs === '+') {
        pending[p] = run.slice(k);
        k = run.length;
      } else pending[p] = [run[k++]!];
      filled[p] = true;
      p++;
    }
    extras.push(...run.slice(k));
  }
  const missing: string[] = [];
  spec.pos.forEach((pos, i) => {
    if (!filled[i] && pos.nargs !== '?') missing.push(pos.name);
    out[pos.name] = pos.nargs === '+' ? pending[i] : (pending[i]![0] ?? null);
  });
  for (const [flag, o] of Object.entries(spec.opts)) if (o.required && !seen.has(flag)) missing.push(flag);
  if (missing.length) throw new ArgError(`the following arguments are required: ${missing.join(', ')}`);
  if (extras.length) throw new ArgError(`unrecognized arguments: ${extras.join(' ')}`);
  return out;
}

// The parsed values, or the exit code once the error or the help has been printed.
export function parseArgs(spec: ParserSpec, argv: string[], io: Io): Parsed | number {
  try {
    const r = parseOrThrow(spec, argv);
    if (r === 'help') {
      io.out(`${spec.usage}\n${spec.help ? `\n${spec.help}\n` : ''}`);
      return 0;
    }
    return r;
  } catch (e) {
    if (!(e instanceof ArgError)) throw e;
    io.err(`${spec.usage}\n${spec.prog}: error: ${e.message}\n`);
    return 2;
  }
}
