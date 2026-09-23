// Paired timings of two engines on the same commands: each command runs on engine A then engine B,
// again and again, and the medians are compared. On a machine shared with other agents the absolute
// numbers move; the pairs keep the comparison fair.
//
//   node scripts/bench.ts --a <vysu A> --b <vysu B> [--runs 15] [--cwd <dir>] -- "<args>" "<args>" …
import { spawnSync } from 'node:child_process';

const argv = process.argv.slice(2);
const opt = (name: string, def: string): string => {
  const i = argv.indexOf(name);
  return i >= 0 ? argv[i + 1]! : def;
};
const a = opt('--a', '');
const b = opt('--b', '');
const runs = Number(opt('--runs', '15'));
const cwd = opt('--cwd', process.cwd());
const cmds = argv.slice(argv.indexOf('--') + 1);
if (!a || !b || !cmds.length) {
  console.error('usage: node scripts/bench.ts --a <vysu A> --b <vysu B> [--runs 15] [--cwd <dir>] -- "<args>" …');
  process.exit(1);
}

const time = (bin: string, args: string): number => {
  const t0 = performance.now();
  const r = spawnSync('/bin/sh', ['-c', `"${bin}" ${args}`], { cwd, stdio: 'ignore' });
  const dt = performance.now() - t0;
  if (r.status !== 0) throw new Error(`${bin} ${args}: exit ${r.status}`);
  return dt;
};
const median = (xs: number[]): number => [...xs].sort((x, y) => x - y)[Math.floor(xs.length / 2)]!;

for (const c of cmds) {
  const ta: number[] = [];
  const tb: number[] = [];
  for (let i = 0; i < runs; i++) {
    ta.push(time(a, c));
    tb.push(time(b, c));
  }
  const ma = median(ta);
  const mb = median(tb);
  console.log(`${c.padEnd(48)} A ${ma.toFixed(0).padStart(6)} ms · B ${mb.toFixed(0).padStart(6)} ms · ×${(ma / mb).toFixed(1)}`);
}
