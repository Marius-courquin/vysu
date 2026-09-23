// diff.py against src/img/diff.ts on real pairs: every `<label>-base.png` and `<label>.prev.png` beside
// its capture, plus pairs of different sizes. Text and JSON reports must match to the byte; the red
// diff image must be identical; the marked image (labels drawn in Inter where Pillow used Helvetica)
// the same size with its differences confined to the label glyphs.
//
//   node test/parity/diff.ts <inputs> <scratch>      (<inputs>/shots/<folder>/*.png)
import { existsSync, readdirSync } from 'node:fs';
import { basename, join } from 'node:path';
import { main } from '../../src/img/diff.ts';
import { compareImages, dirs, py, Report, ts } from './lib.ts';

const [inputs, scratch] = process.argv.slice(2);
if (!inputs || !scratch) throw new Error('usage: node test/parity/diff.ts <inputs> <scratch>');
const [outPy, outTs] = dirs(scratch, 'diff/py', 'diff/ts') as [string, string];

const pairs: Array<[string, string]> = [];
const shots = join(inputs, 'shots');
for (const folder of readdirSync(shots).sort()) {
  const dir = join(shots, folder);
  for (const f of readdirSync(dir).sort()) {
    if (f.endsWith('-base.png') && existsSync(join(dir, f.replace(/-base\.png$/, '.png')))) pairs.push([join(dir, f), join(dir, f.replace(/-base\.png$/, '.png'))]);
    if (f.endsWith('.prev.png') && existsSync(join(dir, f.replace(/\.prev\.png$/, '.png')))) pairs.push([join(dir, f), join(dir, f.replace(/\.prev\.png$/, '.png'))]);
  }
}
// Different sizes: the first two captures of two folders.
const sizes = pairs.filter((_, i) => i % 7 === 0).map(([, cur]) => cur);
for (let i = 0; i + 1 < sizes.length; i += 2) pairs.push([sizes[i]!, sizes[i + 1]!]);

const report = new Report();
let n = 0;
for (const [base, cur] of pairs) {
  n++;
  const tag = `${n}-${basename(cur, '.png')}`;
  const variants: Array<[string, string[]]> = [
    ['text', ['--mark', 'M', '--out', 'O']],
    ['json', ['--json', '--mark', 'M']],
    ['scale', ['--scale', '3', '--min-area', '16', '--pad', '60']],
    ['ignore', ['--ignore', '0,0,400,120', '--ignore', '10.7,300,-5,50', '--threshold', '0.05']],
  ];
  for (const [v, args] of variants) {
    const name = `${tag} ${v}`;
    const withOut = (dir: string): string[] => args.map((a) => (a === 'M' ? join(dir, `${tag}-${v}-mark.png`) : a === 'O' ? join(dir, `${tag}-${v}-diff.png`) : a));
    const p = py('diff', [base, cur, ...withOut(outPy)]);
    const t = await ts(main, [base, cur, ...withOut(outTs)]);
    if (!report.text(name, p, t, (s) => s.replaceAll(outPy, 'OUT').replaceAll(outTs, 'OUT'))) continue;
    if (p.code !== 1) continue;
    if (args.includes('O')) {
      const c = await compareImages(join(outPy, `${tag}-${v}-diff.png`), join(outTs, `${tag}-${v}-diff.png`));
      report.image(`${name} diff.png`, c, 0);
    }
    if (args.includes('M')) {
      const c = await compareImages(join(outPy, `${tag}-${v}-mark.png`), join(outTs, `${tag}-${v}-mark.png`));
      report.image(`${name} mark.png`, c, 0.02);
    }
  }
}
// Errors: a missing file, a bad region, bad options.
for (const args of [['/nope.png', pairs[0]![1]], [pairs[0]![0], pairs[0]![1], '--ignore', '1,2,3'], ['a'], [pairs[0]![0], pairs[0]![1], '--threshold', 'x'], [pairs[0]![0], pairs[0]![1], '--m', 'x']]) {
  const p = py('diff', args);
  const t = await ts(main, args);
  report.text(`error ${args.slice(2).join(' ') || args[0]}`, p, t);
  if (p.stderr !== t.stderr) console.log(`  stderr differs: ${JSON.stringify(p.stderr)} / ${JSON.stringify(t.stderr)}`);
}
report.done('diff');
