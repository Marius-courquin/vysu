// verdict.py against src/img/verdict.ts: the diff reports of real pairs recorded into copies of real
// meta.json files (with their earlier verdicts and floats), every `vs` form, quiet or not. The line
// printed and the meta.json written must match to the byte, the `at` stamp aside.
//
//   node test/parity/verdict.ts <inputs> <scratch>
import { cpSync, existsSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { main } from '../../src/img/verdict.ts';
import { dirs, py, Report, ts } from './lib.ts';

const [inputs, scratch] = process.argv.slice(2);
if (!inputs || !scratch) throw new Error('usage: node test/parity/verdict.ts <inputs> <scratch>');
const [base] = dirs(scratch, `verdict-${Date.now()}`) as [string];
const report = new Report();
const stamp = (s: string): string => s.replace(/"at": "[^"]+"/g, '"at": "…"');

const shots = join(inputs, 'shots');
let n = 0;
for (const folder of readdirSync(shots).sort()) {
  const src = join(shots, folder);
  const pngs = readdirSync(src).filter((f) => f.endsWith('.png') && !f.includes('-base') && !f.includes('.prev') && !f.includes('-changed')).sort();
  const bases = readdirSync(src).filter((f) => f.endsWith('-base.png') || f.endsWith('.prev.png')).sort();
  if (!bases.length) continue;
  const pairBase = join(src, bases[0]!);
  const pairCur = join(src, bases[0]!.replace(/-base\.png$|\.prev\.png$/, '.png'));
  if (!existsSync(pairCur)) continue;
  const d = py('diff', [pairBase, pairCur, '--mark', join(base, `${folder}-m.png`)]).stdout;
  const texts = [d, 'identical\n', 'size mismatch: baseline 393x852, current 393x900 — compared on 393x852\nchanged 1.2 % (400 px) · 5 zones\n1. x 0 y 1 w 2 h 3 px\n2. x 9 y 9 w 9 h 9 px\n3. x 1 y 1 w 1 h 1 px\n4. x 2 y 2 w 2 h 2 px\n5. x 3 y 3 w 3 h 3 px\nmarked: /x/é.png\n'];
  const cases: Array<[string, string[], string | undefined]> = [
    ['previous', ['previous', '--diff', '-', '--device', 'iPhone 17 Pro'], texts[0]],
    ['baseline', ['baseline:prep', '--diff', '-', '--quiet'], texts[2]],
    ['identical', ['previous', '--diff', '-'], texts[1]],
    ['new', ['new', '--device', 'Pixel 8'], undefined],
    ['skipped', ['skipped'], undefined],
    ['bad', ['sideways', '--diff', '-'], texts[0]],
    ['file', ['baseline:', '--diff', 'DIFF'], texts[0]],
  ];
  for (const [v, args, input] of cases) {
    n++;
    const [dp, dt] = [join(base, `${n}-py`), join(base, `${n}-ts`)];
    cpSync(src, dp, { recursive: true, filter: (f) => !f.endsWith('.png') });
    cpSync(src, dt, { recursive: true, filter: (f) => !f.endsWith('.png') });
    const diffFile = join(base, `${n}.txt`);
    writeFileSync(diffFile, texts[0]!);
    const argv = (dir: string): string[] => [dir, pngs[0]?.replace(/\.png$/, '') ?? 'x', ...args.map((a) => (a === 'DIFF' ? diffFile : a))];
    const p = py('verdict', argv(dp), { input: input === undefined ? undefined : Buffer.from(input) });
    const t = await ts(main, argv(dt), { input: input === undefined ? undefined : Buffer.from(input) });
    report.text(`${folder} ${v}`, p, t);
    if (p.stderr !== t.stderr) console.log(`✗ ${folder} ${v} stderr: ${JSON.stringify(p.stderr)} / ${JSON.stringify(t.stderr)}`);
    const mp = existsSync(join(dp, 'meta.json')) ? stamp(readFileSync(join(dp, 'meta.json'), 'utf8')) : '';
    const mt = existsSync(join(dt, 'meta.json')) ? stamp(readFileSync(join(dt, 'meta.json'), 'utf8')) : '';
    if (mp !== mt) {
      report.failures.push(`${folder} ${v} meta.json`);
      console.log(`✗ ${folder} ${v} meta.json differs\n--- python\n${mp.slice(0, 800)}\n--- ts\n${mt.slice(0, 800)}`);
    }
  }
}
report.done('verdict');
