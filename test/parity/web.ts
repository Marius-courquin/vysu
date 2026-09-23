// Parity of the web commands: each case runs on the reference engine (A: VYSU_REF, or --a) then on
// this one (B), from a real project, each engine with its own scratch shots folder; stdout, stderr,
// the exit code and the files a case names are normalized (paths, dates, durations) and compared.
// Images are compared by size only: a live page is not the same picture twice.
//
//   node test/parity/web-cases.ts [--project <dir>] [--a "<reference vysu command>"] [--only <case,…>] [--skip <case,…>] [--list]
//
// Cases that log in or touch a real session are marked; `--only` picks some. Nothing here writes
// into the project's own shots folder.
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, readdirSync, realpathSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import sharp from 'sharp';
import { ref } from './ref.ts';

const ENGINE = resolve(import.meta.dirname, '..', '..');
const argv = process.argv.slice(2);
const opt = (name: string, def: string): string => {
  const i = argv.indexOf(name);
  return i >= 0 ? argv[i + 1]! : def;
};
const project = opt('--project', join(process.env.HOME ?? '', 'Documents/Projects/Nidz/nidz-env'));
const q = (s: string): string => `'${s.replaceAll("'", `'"'"'`)}'`;
// The reference, as a command line: --a is one already, VYSU_REF a path.
const engineA = argv.includes('--a') ? opt('--a', '') : argv.includes('--list') ? '' : q(ref());
const engineB = join(ENGINE, 'bin', 'vysu');
const refEngine = process.env.VYSU_REF && existsSync(process.env.VYSU_REF) ? realpathSync(resolve(dirname(process.env.VYSU_REF), '..')) : '';
const only = opt('--only', '').split(',').filter(Boolean);
const skip = opt('--skip', '').split(',').filter(Boolean);
const scratch = opt('--scratch', join(process.env.VYSU_PARITY_DIR ?? tmpdir(), `vysu-parity-${process.pid}`));

export interface Case {
  name: string;
  args: string[];
  env?: Record<string, string>;
  stdin?: string;
  // Files of the case's shots folder to compare (text), and images to compare by size.
  files?: string[];
  images?: string[];
  // The shots folder the case writes into, when it writes one.
  shots?: string;
  // A line that differs for a reason outside the engine (a live page's errors, a clock).
  ignore?: RegExp[];
  cwd?: string;
  // Commands run by the same engine before the case (their output dropped): the session put back
  // where the case expects it, since the engine that ran first left it elsewhere.
  setup?: string[][];
  // Files laid out before each engine's run (a scratch state folder for `cache clear`).
  prepare?: () => void;
}

function normalize(text: string, shots: string, extra: RegExp[] = []): string {
  let t = text.replaceAll(shots, '<SHOTS>').replaceAll(ENGINE, '<ENGINE>').replaceAll(scratch, '<SCRATCH>');
  if (refEngine) t = t.replaceAll(refEngine, '<ENGINE>');
  // The reference's helpers named themselves <name>.py; this engine's say <name>.
  t = t.replace(/\b(burst|compare|diff|fields|frame|mark|motion|screen|screencap|stitch|take|verdict)\.py\b/g, '$1');
  t = t.replace(/\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}[+-]\d{2}:\d{2}/g, '<DATE>');
  t = t.replace(/\d{4}-\d{2}-\d{2} \d{2}:\d{2}/g, '<DATE>');
  t = t.replace(/for \d+s\b/g, 'for Ns').replace(/after \d+s\b/g, 'after Ns');
  t = t.replace(/"date": "[^"]*"/g, '"date": "<DATE>"');
  const lines = t.split('\n').filter((l) => !extra.some((re) => re.test(l)));
  return lines.join('\n');
}

function runOne(engine: 'a' | 'b', c: Case): { out: string; err: string; code: number; shots: string; ms: number } {
  const shots = join(scratch, engine, 'shots');
  mkdirSync(shots, { recursive: true });
  c.prepare?.();
  const bin = engine === 'a' ? engineA : q(engineB);
  const env = { ...process.env, VYSU_SHOTS: shots, VYSU_NO_COLOR: '1', ...c.env };
  for (const s of c.setup ?? []) spawnSync('/bin/sh', ['-c', `${bin} ${s.map(q).join(' ')}`], { cwd: c.cwd ?? project, env, stdio: 'ignore' });
  const cmd = `${bin} ${c.args.map(q).join(' ')}`;
  const t0 = performance.now();
  const r = spawnSync('/bin/sh', ['-c', cmd], {
    cwd: c.cwd ?? project,
    input: c.stdin,
    encoding: 'utf8',
    env,
    maxBuffer: 64 * 1024 * 1024,
  });
  return { out: r.stdout ?? '', err: r.stderr ?? '', code: r.status ?? -1, shots, ms: performance.now() - t0 };
}

function firstDiff(a: string, b: string): string {
  const la = a.split('\n');
  const lb = b.split('\n');
  for (let i = 0; i < Math.max(la.length, lb.length); i++) {
    if (la[i] !== lb[i]) return `line ${i + 1}:\n  A: ${la[i] ?? '(none)'}\n  B: ${lb[i] ?? '(none)'}`;
  }
  return '';
}

async function imageSize(p: string): Promise<string> {
  if (!existsSync(p)) return 'missing';
  const m = await sharp(p).metadata();
  return `${m.width}x${m.height}`;
}

export async function compare(c: Case): Promise<boolean> {
  const a = runOne('a', c);
  const b = runOne('b', c);
  const problems: string[] = [];
  const check = (what: string, x: string, y: string): void => {
    const d = firstDiff(normalize(x, a.shots, c.ignore), normalize(y, a.shots, c.ignore));
    if (d) problems.push(`${what} differs at ${d}`);
  };
  check('stdout', a.out, b.out.replaceAll(b.shots, a.shots));
  check('stderr', a.err, b.err.replaceAll(b.shots, a.shots));
  if (a.code !== b.code) problems.push(`exit code: A ${a.code} · B ${b.code}`);
  for (const f of c.files ?? []) {
    const pa = join(a.shots, c.shots ?? '', f);
    const pb = join(b.shots, c.shots ?? '', f);
    const ra = existsSync(pa) ? readFileSync(pa, 'utf8') : '(missing)';
    const rb = existsSync(pb) ? readFileSync(pb, 'utf8').replaceAll(b.shots, a.shots) : '(missing)';
    check(f, ra, rb);
  }
  for (const f of c.images ?? []) {
    const sa = await imageSize(join(a.shots, c.shots ?? '', f));
    const sb = await imageSize(join(b.shots, c.shots ?? '', f));
    if (sa !== sb) problems.push(`${f}: A ${sa} · B ${sb}`);
  }
  const dir = join(scratch, 'out', c.name);
  mkdirSync(dir, { recursive: true });
  for (const [e, r] of [['a', a], ['b', b]] as const) {
    writeFileSync(join(dir, `${e}.out`), r.out);
    writeFileSync(join(dir, `${e}.err`), r.err);
  }
  const timing = `A ${a.ms.toFixed(0)} ms · B ${b.ms.toFixed(0)} ms`;
  if (problems.length) {
    console.log(`✗ ${c.name} (${timing})\n${problems.map((p) => `  ${p}`).join('\n')}`);
    return false;
  }
  console.log(`✓ ${c.name} (${timing})`);
  return true;
}

export async function main(cases: Case[]): Promise<void> {
  if (argv.includes('--list')) {
    for (const c of cases) console.log(`${c.name}: vysu ${c.args.join(' ')}`);
    return;
  }
  mkdirSync(scratch, { recursive: true });
  console.log(`A: ${engineA}\nB: ${engineB}\nproject: ${project}\nscratch: ${scratch}`);
  let failed = 0;
  for (const c of cases) {
    const hit = (o: string): boolean => c.name === o || c.name.startsWith(`${o}/`);
    if ((only.length && !only.some(hit)) || skip.some(hit)) continue;
    if (!(await compare(c))) failed++;
  }
  console.log(failed ? `${failed} case(s) differ — outputs in ${join(scratch, 'out')}` : 'all cases match');
  process.exitCode = failed ? 1 : 0;
}

export const ls = (p: string): string[] => (existsSync(p) && statSync(p).isDirectory() ? readdirSync(p) : []);
export { scratch, project };
