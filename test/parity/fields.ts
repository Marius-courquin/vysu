// fields.py against src/img/fields.ts: login screens with their fields (iOS, Android, iPad, SE), then
// every other capture of the inputs, where the answer is mostly « none »; plain and JSON output, the
// raw device captures at their scale, and looser thresholds.
//
//   node test/parity/fields.ts <inputs> <scratch>
import { readdirSync } from 'node:fs';
import { join } from 'node:path';
import { main } from '../../src/img/fields.ts';
import { py, Report, ts } from './lib.ts';

const [inputs] = process.argv.slice(2);
if (!inputs) throw new Error('usage: node test/parity/fields.ts <inputs> <scratch>');
const report = new Report();
const images: string[] = readdirSync(join(inputs, 'fields')).sort().map((f) => join(inputs, 'fields', f));
for (const folder of readdirSync(join(inputs, 'shots')).sort()) {
  for (const f of readdirSync(join(inputs, 'shots', folder)).sort()) if (f.endsWith('.png') && !f.startsWith('sheet') && !f.startsWith('compare')) images.push(join(inputs, 'shots', folder, f));
}
let hits = 0;
for (const img of images) {
  for (const args of [[], ['--json'], ['--edge', '20', '--min-width', '0.4', '--min-height', '30']]) {
    const p = py('fields', [img, ...args]);
    const t = await ts(main, [img, ...args]);
    report.text(`${img.split('/').slice(-2).join('/')} ${args.join(' ')}`, p, t);
    if (p.code === 0 && !args.length) hits++;
  }
}
for (const f of readdirSync(join(inputs, 'raw')).sort()) {
  const p = py('fields', [join(inputs, 'raw', f), '--scale', '2.625', '--json']);
  const t = await ts(main, [join(inputs, 'raw', f), '--scale', '2.625', '--json']);
  report.text(`raw/${f}`, p, t);
}
const p = py('fields', ['/nope.png']);
const t = await ts(main, ['/nope.png']);
report.text('missing', p, t);
if (p.stderr !== t.stderr) console.log(`✗ stderr ${JSON.stringify(p.stderr)} / ${JSON.stringify(t.stderr)}`);
console.log(`${hits} captures with fields`);
report.done('fields');
