// screencap.py against src/img/screencap.ts: raw Android captures (1080x2400) brought to 1x at the
// scales real devices have (2.625 Pixel 8, 2.75 Pixel 4a, 3 Pixel 10 Pro, 2, 1), from stdin with and
// without the warning line adb may print first, and from a file. The PNG written must be identical.
//
//   node test/parity/screencap.ts <inputs> <scratch>      (<inputs>/raw/*.png)
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { main } from '../../src/img/screencap.ts';
import { compareImages, dirs, py, Report, ts } from './lib.ts';

const [inputs, scratch] = process.argv.slice(2);
if (!inputs || !scratch) throw new Error('usage: node test/parity/screencap.ts <inputs> <scratch>');
const [outPy, outTs] = dirs(scratch, 'screencap/py', 'screencap/ts') as [string, string];
const report = new Report();
const raws = readdirSync(join(inputs, 'raw')).filter((f) => f.endsWith('.png')).sort();
for (const f of raws) {
  const raw = readFileSync(join(inputs, 'raw', f));
  for (const scale of ['2.625', '2.75', '3', '2', '1']) {
    for (const warn of [false, true]) {
      const name = `${f} ${scale}${warn ? ' warn' : ''}`;
      const input = warn ? Buffer.concat([Buffer.from('WARNING: linker: unused DT entry\n'), raw]) : raw;
      const out = (d: string): string => join(d, `${f}-${scale}-${warn}.png`);
      const p = py('screencap', ['--scale', scale, '--out', out(outPy)], { input });
      const t = await ts(main, ['--scale', scale, '--out', out(outTs)], { input });
      if (report.text(name, p, t) && p.code === 0) report.image(name, await compareImages(out(outPy), out(outTs)), 0);
    }
  }
  const p = py('screencap', ['--scale', '2.625', '--out', join(outPy, 'file.png'), join(inputs, 'raw', f)]);
  const t = await ts(main, ['--scale', '2.625', '--out', join(outTs, 'file.png'), join(inputs, 'raw', f)]);
  if (report.text(`${f} file`, p, t)) report.image(`${f} file`, await compareImages(join(outPy, 'file.png'), join(outTs, 'file.png')), 0);
}
const p = py('screencap', ['--scale', '3', '--out', join(outPy, 'x.png')], { input: Buffer.from('error: no devices/emulators found\n') });
const t = await ts(main, ['--scale', '3', '--out', join(outTs, 'x.png')], { input: Buffer.from('error: no devices/emulators found\n') });
report.text('no png', p, t);
if (p.stderr !== t.stderr) console.log(`✗ stderr ${JSON.stringify(p.stderr)} / ${JSON.stringify(t.stderr)}`);
report.done('screencap');
