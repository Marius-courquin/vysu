// motion.py against src/img/motion.ts on real recordings (iOS 3x and 2x, Android, web): read as mrec
// reads them (60 fps, --scale, --dump), as rec does (the clip's fps, --scale 1), cropped with looser
// thresholds, and a frames folder read as a directory. The report must match to the byte and every
// dumped frame be identical.
//
//   node test/parity/motion.ts <inputs> <scratch>      (<inputs>/rec/<take>/<clip>.mp4 [+ frames/])
import { existsSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { main } from '../../src/img/motion.ts';
import { compareImages, dirs, py, Report, ts } from './lib.ts';

const [inputs, scratch] = process.argv.slice(2);
if (!inputs || !scratch) throw new Error('usage: node test/parity/motion.ts <inputs> <scratch>');
const report = new Report();
for (const take of readdirSync(join(inputs, 'rec')).sort()) {
  const dir = join(inputs, 'rec', take);
  const clip = readdirSync(dir).find((f) => f.endsWith('.mp4'))!;
  const scale = clip.startsWith('ios') ? (take.includes('SE') ? '2' : '3') : clip.startsWith('android') ? '2.75' : '1';
  const variants: Array<[string, string, string[]]> = [
    ['mrec', join(dir, clip), ['--fps', '60', '--scale', scale, '--dump', 'DUMP']],
    ['rec', join(dir, clip), ['--fps', '30', '--scale', '1']],
    ['crop', join(dir, clip), ['--crop', '600:800:100:200', '--flash-min', '2', '--flash-max', '20', '--min-change', '0.2', '--dump', 'DUMP']],
  ];
  if (existsSync(join(dir, 'frames'))) variants.push(['dir', join(dir, 'frames'), ['--scale', '2', '--flash-min', '1', '--dump', 'DUMP']]);
  for (const [v, src, args] of variants) {
    const [dp, dt] = dirs(scratch, `motion/py/${take}-${v}`, `motion/ts/${take}-${v}`) as [string, string];
    const p = py('motion', [src, ...args.map((a) => (a === 'DUMP' ? dp : a))]);
    const t = await ts(main, [src, ...args.map((a) => (a === 'DUMP' ? dt : a))]);
    const norm = (s: string): string => s.replaceAll(dp, 'DUMP').replaceAll(dt, 'DUMP');
    if (!report.text(`${take} ${v}`, p, t, norm) || !args.includes('DUMP')) continue;
    const a = readdirSync(dp).sort();
    const b = readdirSync(dt).sort();
    if (a.join() !== b.join()) {
      report.failures.push(`${take} ${v} dump`);
      console.log(`✗ ${take} ${v}: dumped ${a.join()} / ${b.join()}`);
      continue;
    }
    for (const f of a) report.image(`${take} ${v} ${f}`, await compareImages(join(dp, f), join(dt, f)), 0);
  }
}
for (const args of [['/nope.mp4'], [join(inputs, 'raw')], [join(inputs, 'raw'), '--crop', '1:1:0:0']]) {
  const p = py('motion', args);
  const t = await ts(main, args);
  report.text(`error ${args.join(' ').slice(-30)}`, p, t);
  if (p.stderr !== t.stderr) console.log(`✗ stderr ${JSON.stringify(p.stderr)} / ${JSON.stringify(t.stderr)}`);
}
report.done('motion');
