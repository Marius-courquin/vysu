// What every parity script shares: run the Python helper and its TypeScript port on the same input,
// time both, compare what they printed and the images they wrote.
//
// The inputs are copies of real captures, recordings and snapshots in a scratch folder (never the
// shots folder itself): `node test/parity/<name>.ts <inputs> <scratch>`.
import { spawnSync } from 'node:child_process';
import { mkdirSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { readRgba } from '../../src/img/raster.ts';
import type { Io, ToolMain } from '../../src/img/tools.ts';

export const ENGINE = resolve(import.meta.dirname, '..', '..');

export interface Ran {
  code: number;
  stdout: string;
  stderr: string;
  ms: number;
}

export function py(script: string, args: string[], opts: { input?: Buffer; cwd?: string; env?: NodeJS.ProcessEnv } = {}): Ran {
  const t = performance.now();
  const r = spawnSync('python3', [join(ENGINE, 'py', `${script}.py`), ...args], {
    input: opts.input,
    cwd: opts.cwd,
    env: opts.env ?? process.env,
    maxBuffer: 1 << 28,
  });
  return { code: r.status ?? 1, stdout: r.stdout.toString(), stderr: r.stderr.toString(), ms: performance.now() - t };
}

// The port, in this process: what the engine pays once the module is loaded.
export async function ts(main: ToolMain, args: string[], opts: { input?: Buffer; cwd?: string } = {}): Promise<Ran> {
  const out: string[] = [];
  const err: string[] = [];
  const io: Io = { out: (s) => out.push(s), err: (s) => err.push(s), stdin: opts.input };
  const cwd = process.cwd();
  if (opts.cwd) process.chdir(opts.cwd);
  const t = performance.now();
  try {
    const code = await main(args, io);
    return { code, stdout: out.join(''), stderr: err.join(''), ms: performance.now() - t };
  } finally {
    if (opts.cwd) process.chdir(cwd);
  }
}

export interface ImageCompare {
  same: boolean;
  size: string;
  // Share of pixels with a channel more than 8 levels apart, the largest delta, the mean delta.
  over8: number;
  max: number;
  mean: number;
}

export async function compareImages(a: string, b: string): Promise<ImageCompare> {
  const [x, y] = await Promise.all([readRgba(a), readRgba(b)]);
  const size = `${x.width}x${x.height}` + (x.width === y.width && x.height === y.height ? '' : ` vs ${y.width}x${y.height}`);
  if (x.width !== y.width || x.height !== y.height) return { same: false, size, over8: 1, max: 255, mean: 255 };
  let over = 0;
  let max = 0;
  let sum = 0;
  let same = true;
  for (let i = 0; i < x.data.length; i += 4) {
    let m = 0;
    for (let k = 0; k < 4; k++) {
      const d = Math.abs(x.data[i + k]! - y.data[i + k]!);
      sum += d;
      if (d > m) m = d;
    }
    if (m) same = false;
    if (m > 8) over++;
    if (m > max) max = m;
  }
  return { same, size, over8: over / (x.width * x.height), max, mean: sum / x.data.length };
}

export const fmtImage = (c: ImageCompare): string =>
  c.same ? `${c.size} identical` : `${c.size} ${(c.over8 * 100).toFixed(2)} % px >8 levels, max ${c.max}, mean ${c.mean.toFixed(3)}`;

export function dirs(scratch: string, ...names: string[]): string[] {
  return names.map((n) => {
    const d = join(scratch, n);
    mkdirSync(d, { recursive: true });
    return d;
  });
}

// One line per case, then the totals: text mismatches are failures, images are reported.
export class Report {
  cases = 0;
  failures: string[] = [];
  pyMs: number[] = [];
  tsMs: number[] = [];
  worst: ImageCompare | null = null;

  text(name: string, p: Ran, t: Ran, normalize: (s: string) => string = (s) => s): boolean {
    this.cases++;
    this.pyMs.push(p.ms);
    this.tsMs.push(t.ms);
    const ok = p.code === t.code && normalize(p.stdout) === normalize(t.stdout);
    if (!ok) {
      this.failures.push(name);
      console.log(`✗ ${name}: exit ${p.code} / ${t.code}`);
      if (normalize(p.stdout) !== normalize(t.stdout)) console.log(`  python: ${JSON.stringify(p.stdout.slice(0, 600))}\n  ts:     ${JSON.stringify(t.stdout.slice(0, 600))}`);
      if (p.stderr || t.stderr) console.log(`  stderr: ${JSON.stringify(p.stderr.slice(0, 300))} / ${JSON.stringify(t.stderr.slice(0, 300))}`);
    }
    return ok;
  }

  image(name: string, c: ImageCompare, maxOver8: number): void {
    if (!this.worst || c.over8 > this.worst.over8 || (c.over8 === this.worst.over8 && c.max > this.worst.max)) this.worst = c;
    if (c.over8 > maxOver8 || !/^\d+x\d+ /.test(`${c.size} `) || c.size.includes('vs')) {
      this.failures.push(`${name} (image)`);
      console.log(`✗ ${name}: ${fmtImage(c)}`);
    }
  }

  done(title: string): void {
    const med = (xs: number[]): number => [...xs].sort((a, b) => a - b)[Math.floor(xs.length / 2)] ?? 0;
    console.log(
      `${title}: ${this.cases} cases, ${this.failures.length} failure(s) · median python ${med(this.pyMs).toFixed(0)} ms, ts ${med(this.tsMs).toFixed(0)} ms` +
        (this.worst ? ` · worst image: ${fmtImage(this.worst)}` : ''),
    );
    if (this.failures.length) process.exitCode = 1;
  }
}
