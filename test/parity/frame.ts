// frame.py against src/img/frame.ts on real captures of every shape (iPhone 17 Pro and SE, iPad
// portrait and landscape, Android at 1x and raw, web at three widths, a tall full-page capture, a
// small crop) and short real clips (iPhone SE at 2x, iPhone 17 Pro at 3x, web): framed and pitch,
// each device forced, a background, a title and a caption. The lines printed must match to the
// byte; images must be the same size, the bezels now drawn antialiased and the text in Inter; a
// clip must come out with the same size and frame count, its middle frame near-identical.
//
//   node test/parity/frame.ts <inputs> <scratch>      (<inputs>/frame/*.png, <inputs>/framevid/*.mp4)
import { readdirSync } from 'node:fs';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { main } from '../../src/img/frame.ts';
import { compareImages, dirs, py, Report, ts } from './lib.ts';

const [inputs, scratch] = process.argv.slice(2);
if (!inputs || !scratch) throw new Error('usage: node test/parity/frame.ts <inputs> <scratch>');
const [outPy, outTs] = dirs(scratch, 'frame/py', 'frame/ts') as [string, string];
const report = new Report();
const norm = (s: string): string => s.replaceAll(outPy, 'OUT').replaceAll(outTs, 'OUT');

const images = readdirSync(join(inputs, 'frame')).filter((f) => f.endsWith('.png')).sort();
for (const img of images) {
  const variants: Array<[string, string[]]> = [
    ['framed', []],
    ['bg', ['--bg', '#fff']],
    ['pitch', ['--preset', 'pitch', '--title', 'Signaler un incident', '--caption', 'La résidence en un coup d’œil']],
    ['pitch-plain', ['--preset', 'pitch', '--bg', '#101010', '--size', '1081x721']],
  ];
  if (img === images[0]) for (const d of ['phone', 'phone-home', 'tablet', 'browser', 'none']) variants.push([`dev-${d}`, ['--device', d, '--caption', 'next.prep.nidz.fr/residence/12/batiments/avec-un-chemin-tres-long']]);
  for (const [v, args] of variants) {
    const out = (d: string): string => join(d, `${img.replace('.png', '')}-${v}.png`);
    const p = py('frame', [join(inputs, 'frame', img), '--out', out(outPy), ...args]);
    const t = await ts(main, [join(inputs, 'frame', img), '--out', out(outTs), ...args]);
    if (report.text(`${img} ${v}`, p, t, norm) && p.code === 0) report.image(`${img} ${v}`, await compareImages(out(outPy), out(outTs)), v.startsWith('pitch') ? 0.25 : 0.06);
  }
}

const probe = (f: string): string =>
  spawnSync('ffprobe', ['-v', 'error', '-count_frames', '-select_streams', 'v:0', '-show_entries', 'stream=width,height,nb_read_frames,pix_fmt', '-of', 'csv=p=0', f]).stdout.toString().trim();
const still = (f: string, png: string): void => void spawnSync('ffmpeg', ['-v', 'error', '-y', '-ss', '1', '-i', f, '-frames:v', '1', png]);
for (const clip of readdirSync(join(inputs, 'framevid')).sort()) {
  for (const [v, args] of [
    ['framed', []],
    ['pitch', ['--preset', 'pitch', '--title', 'Démo', '--caption', 'iPhone', '--fps', '25']],
  ] as Array<[string, string[]]>) {
    const out = (d: string): string => join(d, `${clip.replace('.mp4', '')}-${v}.mp4`);
    const p = py('frame', [join(inputs, 'framevid', clip), '--out', out(outPy), ...args]);
    const t = await ts(main, [join(inputs, 'framevid', clip), '--out', out(outTs), ...args]);
    if (!report.text(`${clip} ${v}`, p, t, norm) || p.code) continue;
    const [a, b] = [probe(out(outPy)), probe(out(outTs))];
    if (a !== b) {
      report.failures.push(`${clip} ${v} stream`);
      console.log(`✗ ${clip} ${v}: ${a} / ${b}`);
    }
    still(out(outPy), `${out(outPy)}.png`);
    still(out(outTs), `${out(outTs)}.png`);
    report.image(`${clip} ${v} frame at 1 s`, await compareImages(`${out(outPy)}.png`, `${out(outTs)}.png`), v === 'pitch' ? 0.25 : 0.06);
  }
}

const [fp, ft] = dirs(scratch, 'frame/py-folder', 'frame/ts-folder') as [string, string];
const p = py('frame', [join(inputs, 'frame'), '--out', fp]);
const t = await ts(main, [join(inputs, 'frame'), '--out', ft]);
report.text('folder', p, t, (s) => s.replaceAll(fp, 'OUT').replaceAll(ft, 'OUT'));

for (const args of [['/nope.png'], [join(inputs, 'frame', images[0]!), '--size', '12x'], [join(inputs, 'frame', images[0]!), '--bg', '#12', '--out', join(scratch, 'x.png')], [join(inputs, 'snap')], [join(inputs, 'frame', images[0]!), '--device', 'watch']]) {
  const p = py('frame', args);
  const t = await ts(main, args);
  report.text(`error ${args.slice(1).join(' ') || args[0]}`, p, t);
  if (p.stderr !== t.stderr) console.log(`✗ stderr ${JSON.stringify(p.stderr)} / ${JSON.stringify(t.stderr)}`);
}
report.done('frame');
