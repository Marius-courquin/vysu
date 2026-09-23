// burst.py against src/img/burst.ts on raw bursts built from real recordings (iPhone 17 Pro and SE
// frames at 3x / 2x, Pixel 4a at 2.75, the raw Pixel 8 captures at 2.625) plus a broken one (an
// empty and a truncated capture, no times.tsv): the summary line must match to the byte, each
// distinct frame written must be identical (Pillow's Lanczos, reproduced), and the strip the same
// size with its labels in Inter.
//
//   node test/parity/burst.ts <inputs> <scratch>      (<inputs>/burst/<name>/NNN.png + times.tsv)
import { readdirSync } from 'node:fs';
import { join } from 'node:path';
import { main } from '../../src/img/burst.ts';
import { compareImages, dirs, py, Report, ts } from './lib.ts';

const [inputs, scratch] = process.argv.slice(2);
if (!inputs || !scratch) throw new Error('usage: node test/parity/burst.ts <inputs> <scratch>');
const report = new Report();
const scales: Record<string, [string, string]> = {
  'ios-accept': ['ios', '3'],
  'ios-approve': ['ios', '2'],
  'android-bounce': ['android', '2.75'],
  'android-boot': ['android', '2.625'],
  broken: ['ios', '2'],
};
for (const name of readdirSync(join(inputs, 'burst')).sort()) {
  const [platform, scale] = scales[name] ?? ['ios', '1'];
  for (const extra of [[], ['--max-thumbs', '4', '--band', '0', '--min-area', '16'], ['--threshold', '0.3', '--scale', '1']]) {
    const tag = `${name}${extra.length ? `-${extra[1]}` : ''}`;
    const [outPy, outTs] = dirs(scratch, `burst/py/${tag}`, `burst/ts/${tag}`) as [string, string];
    const args = (out: string): string[] => [join(inputs, 'burst', name), '--out-dir', out, '--platform', platform, '--scale', scale, ...extra];
    const p = py('burst', args(outPy));
    const t = await ts(main, args(outTs));
    const norm = (s: string): string => s.replaceAll(outPy, 'OUT').replaceAll(outTs, 'OUT');
    if (!report.text(`${tag}`, p, t, norm) || p.code) continue;
    const files = readdirSync(outPy).filter((f) => f.endsWith('.png')).sort();
    const other = readdirSync(outTs).filter((f) => f.endsWith('.png')).sort();
    if (files.join() !== other.join()) {
      report.failures.push(`${tag} files`);
      console.log(`✗ ${tag}: files ${files.join()} / ${other.join()}`);
      continue;
    }
    for (const f of files) report.image(`${tag} ${f}`, await compareImages(join(outPy, f), join(outTs, f)), f.endsWith('strip.png') ? 0.03 : 0);
  }
}
const [outPy, outTs] = dirs(scratch, 'burst/py/none', 'burst/ts/none') as [string, string];
const p = py('burst', [join(inputs, 'fields'), '--out-dir', outPy, '--platform', 'ios']);
const t = await ts(main, [join(inputs, 'fields'), '--out-dir', outTs, '--platform', 'ios']);
report.text('no frame', p, t);
if (p.stderr !== t.stderr) console.log(`✗ stderr ${JSON.stringify(p.stderr)} / ${JSON.stringify(t.stderr)}`);
report.done('burst');
