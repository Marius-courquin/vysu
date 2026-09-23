// stitch.py against src/img/stitch.ts on the real `full-frames/` of mshot --full walks: the bands,
// every offset (and which captures are dropped or ambiguous), the JSON, and the tall image, which
// is rows copied from the captures and must be identical.
//
//   node test/parity/stitch.ts <inputs> <scratch>      (<inputs>/stitch/<walk>/fNN.png)
import { readdirSync } from 'node:fs';
import { join } from 'node:path';
import { main } from '../../src/img/stitch.ts';
import { compareImages, dirs, py, Report, ts } from './lib.ts';

const [inputs, scratch] = process.argv.slice(2);
if (!inputs || !scratch) throw new Error('usage: node test/parity/stitch.ts <inputs> <scratch>');
const [outPy, outTs] = dirs(scratch, 'stitch/py', 'stitch/ts') as [string, string];
const report = new Report();
for (const walk of readdirSync(join(inputs, 'stitch')).sort()) {
  const dir = join(inputs, 'stitch', walk);
  const files = readdirSync(dir).filter((f) => f.endsWith('.png')).sort().map((f) => join(dir, f));
  const variants: Array<[string, string[]]> = [
    ['dir', [dir]],
    ['json', [dir, '--json']],
    ['bands', [dir, '--top', '100', '--bottom', '40']],
    ['reversed', [...files].reverse()],
    ['one', [files[0]!]],
  ];
  for (const [v, args] of variants) {
    const out = (d: string): string => join(d, `${walk}-${v}.png`);
    const p = py('stitch', [...args, '--out', out(outPy)]);
    const t = await ts(main, [...args, '--out', out(outTs)]);
    const norm = (s: string): string => s.replaceAll(outPy, 'OUT').replaceAll(outTs, 'OUT');
    if (report.text(`${walk} ${v}`, p, t, norm) && p.code === 0) report.image(`${walk} ${v}`, await compareImages(out(outPy), out(outTs)), 0);
  }
}
for (const args of [['/nope/x.png'], [join(inputs, 'stitch')], [join(inputs, 'raw', 'android-first.png'), join(inputs, 'stitch', readdirSync(join(inputs, 'stitch'))[0]!, 'f00.png')]]) {
  const p = py('stitch', [...args, '--out', join(outPy, 'err.png')]);
  const t = await ts(main, [...args, '--out', join(outTs, 'err.png')]);
  report.text(`error ${args.join(' ').slice(-40)}`, p, t);
  if (p.stderr !== t.stderr) console.log(`✗ stderr ${JSON.stringify(p.stderr)} / ${JSON.stringify(t.stderr)}`);
}
report.done('stitch');
