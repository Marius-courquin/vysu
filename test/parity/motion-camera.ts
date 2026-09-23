// motion.py of feat/video-camera against src/img/motion.ts on what that branch changed: the frames a
// report names are dumped by ffmpeg passes of 40, so a long take (more than 40 frames to write) no
// longer overflows ffmpeg's expression parser. Every take copied under <inputs>/takes/<take>/, read as
// mrec reads it (60 fps, --scale, --dump) and as rec does (30 fps, --scale 1, --dump): the report must
// match to the byte, the same frames be dumped, each identical.
//
//   node test/parity/motion-camera.ts <dir holding motion.py> <inputs> <scratch>
import { spawnSync } from 'node:child_process';
import { readdirSync } from 'node:fs';
import { join } from 'node:path';
import { main } from '../../src/img/motion.ts';
import { compareImages, dirs, type Ran, Report, ts } from './lib.ts';

const [pyDir, inputs, scratch] = process.argv.slice(2);
if (!pyDir || !inputs || !scratch) throw new Error('usage: node test/parity/motion-camera.ts <dir holding motion.py> <inputs> <scratch>');
const report = new Report();

function py(args: string[]): Ran {
  const t = performance.now();
  const r = spawnSync('python3', [join(pyDir!, 'motion.py'), ...args], { maxBuffer: 1 << 28, env: { ...process.env, PYTHONDONTWRITEBYTECODE: '1' } });
  return { code: r.status ?? 1, stdout: r.stdout.toString(), stderr: r.stderr.toString(), ms: performance.now() - t };
}

let most = 0;
for (const take of readdirSync(join(inputs, 'takes')).sort()) {
  const dir = join(inputs, 'takes', take);
  const clip = readdirSync(dir).find((f) => f.endsWith('.mp4'))!;
  const scale = clip.startsWith('ios') ? '3' : clip.startsWith('android') ? '2.625' : '1';
  const variants: Array<[string, string[]]> = [
    ['mrec', ['--fps', '60', '--scale', scale, '--dump', 'DUMP']],
    ['rec', ['--fps', '30', '--scale', '1', '--dump', 'DUMP']],
  ];
  for (const [v, args] of variants) {
    const [dp, dt] = dirs(scratch, `motion-camera/py/${take}-${v}`, `motion-camera/ts/${take}-${v}`) as [string, string];
    const p = py([join(dir, clip), ...args.map((a) => (a === 'DUMP' ? dp : a))]);
    const t = await ts(main, [join(dir, clip), ...args.map((a) => (a === 'DUMP' ? dt : a))]);
    const norm = (s: string): string => s.replaceAll(dp, 'DUMP').replaceAll(dt, 'DUMP');
    if (!report.text(`${take} ${v}`, p, t, norm)) continue;
    const a = readdirSync(dp).sort();
    const b = readdirSync(dt).sort();
    most = Math.max(most, a.length);
    if (a.join() !== b.join()) {
      report.failures.push(`${take} ${v} dump`);
      console.log(`✗ ${take} ${v}: dumped ${a.length} / ${b.length} frames`);
      continue;
    }
    for (const f of a) report.image(`${take} ${v} ${f}`, await compareImages(join(dp, f), join(dt, f)), 0);
  }
}
report.done(`motion (camera), up to ${most} frames dumped by one take`);
