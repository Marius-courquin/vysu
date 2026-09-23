// compare.py against src/img/compare.ts on copies of real shots folders (baselines beside their
// captures, .prev.png from mshot, diff.txt, verdicts in meta.json): the lines printed and
// compare.html must match to the byte; compare.png the same size, its differences confined to the
// captions (Inter where Pillow used Helvetica) and the thumbnails' resampling.
//
//   node test/parity/compare.ts <inputs> <scratch>
import { cpSync, existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { main } from '../../src/img/compare.ts';
import { compareImages, dirs, py, Report, ts } from './lib.ts';

const [inputs, scratch] = process.argv.slice(2);
if (!inputs || !scratch) throw new Error('usage: node test/parity/compare.ts <inputs> <scratch>');
const [root] = dirs(scratch, `compare-${Date.now()}`) as [string];
const report = new Report();
const shots = join(inputs, 'shots');
const folders = readdirSync(shots).sort();
let n = 0;
for (const folder of folders) {
  const variants: Array<[string, string[]]> = [
    ['default', []],
    ['rows1', ['--rows', '1', '--edge', '900']],
    ['out', ['--out', 'OUT/pages']],
    ['against', ['--against', 'AGAINST']],
  ];
  for (const [v, args] of variants) {
    n++;
    const [dp, dt] = [join(root, `${n}-py`, folder), join(root, `${n}-ts`, folder)];
    cpSync(join(shots, folder), dp, { recursive: true });
    cpSync(join(shots, folder), dt, { recursive: true });
    const other = folders[(folders.indexOf(folder) + 1) % folders.length]!;
    const argv = (d: string, top: string): string[] => [d, ...args.map((a) => a.replace('OUT', top).replace('AGAINST', join(shots, other)))];
    const p = py('compare', argv(dp, join(root, `${n}-py`)));
    const t = await ts(main, argv(dt, join(root, `${n}-ts`)));
    const norm = (s: string): string => s.replaceAll(`${n}-py`, 'X').replaceAll(`${n}-ts`, 'X');
    if (!report.text(`${folder} ${v}`, p, t, norm)) continue;
    if (p.stderr !== t.stderr && norm(p.stderr) !== norm(t.stderr)) console.log(`✗ ${folder} ${v} stderr ${JSON.stringify(p.stderr)} / ${JSON.stringify(t.stderr)}`);
    for (const line of p.stdout.split('\n')) {
      const f = line.split(' ')[0]!;
      if (f.endsWith('.png') && existsSync(f)) {
        report.image(`${folder} ${v} ${f.split('/').pop()}`, await compareImages(f, f.replace(`${n}-py`, `${n}-ts`)), 0.05);
      } else if (f.endsWith('.html')) {
        const a = norm(readFileSync(f, 'utf8'));
        const b = norm(readFileSync(f.replace(`${n}-py`, `${n}-ts`), 'utf8'));
        if (a !== b) {
          report.failures.push(`${folder} ${v} html`);
          console.log(`✗ ${folder} ${v} compare.html differs`);
        }
      }
    }
  }
}
report.done('compare');
