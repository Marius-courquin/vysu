// take.py of feat/video-camera against src/img/take.ts, on what that branch added: the touch column
// (`at`, the 8th of a raw row) and the clock re-anchored on the screen's own reactions (motion.txt).
//
// For every real take copied under <inputs>/takes/<take>/ (clip, events.json, motion.txt, and the raw
// rows when the take left them): its own rows when there are 8 columns; rows rebuilt from its
// events.json otherwise, a tap touching 0.1 s after its start; rows placing a tap just before each
// motion onset (a take whose every touch the screen answers); each of these shifted by -3.2, -1.1,
// +0.4, +2.5 s, as a late or early recorder would leave them, and cut to two taps (too few to anchor).
// Both kinds (mobile, web). events.json and the printed lines must match to the byte.
//
//   node test/parity/take-camera.ts <dir holding take.py> <inputs> <scratch>
import { spawnSync } from 'node:child_process';
import { cpSync, existsSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { main } from '../../src/img/take.ts';
import { dirs, type Ran, Report, ts } from './lib.ts';

const [pyDir, inputs, scratch] = process.argv.slice(2);
if (!pyDir || !inputs || !scratch) throw new Error('usage: node test/parity/take-camera.ts <dir holding take.py> <inputs> <scratch>');
const report = new Report();

function py(args: string[]): Ran {
  const t = performance.now();
  const r = spawnSync('python3', [join(pyDir!, 'take.py'), ...args], { maxBuffer: 1 << 26 });
  return { code: r.status ?? 1, stdout: r.stdout.toString(), stderr: r.stderr.toString(), ms: performance.now() - t };
}

interface Step {
  i: number;
  line: string;
  verb: string;
  label?: string;
  start: number;
  end: number;
  ok: boolean;
  target?: Record<string, number>;
}

// t0 of events.json back to the epoch: « 2026-09-23T22:49:58.587+02:00 ».
const epoch = (iso: string): number => Date.parse(iso) / 1000;

function onsets(motion: string): number[] {
  const rate = /(\d+) frames @ ([\d.]+) fps/.exec(motion);
  if (!rate) return [];
  const fps = Number(rate[2]);
  return [...motion.matchAll(/^f(\d+)[–-]f\d+/gm)].map((m) => Number(m[1]) / fps);
}

const row = (i: number, start: number, end: number, ok: boolean, target: string, label: string, line: string, at: string): string =>
  [i, start.toFixed(3), end.toFixed(3), ok, target, label, line, at].join('\t');

let cases = 0;
for (const take of readdirSync(join(inputs, 'takes')).sort()) {
  const src = join(inputs, 'takes', take);
  const clip = readdirSync(src).find((f) => f.endsWith('.mp4'))!;
  const events = JSON.parse(readFileSync(join(src, 'events.json'), 'utf8')) as { t0: string; duration: number; kind: string; steps: Step[] };
  const t0 = epoch(events.t0);
  const tStop = Number((t0 + events.duration).toFixed(3));
  const motion = existsSync(join(src, 'motion.txt')) ? readFileSync(join(src, 'motion.txt'), 'utf8') : '';
  const sets: Array<[string, string[]]> = [];
  const own = existsSync(join(src, 'events.jsonl')) ? readFileSync(join(src, 'events.jsonl'), 'utf8').split('\n').filter(Boolean) : [];
  if (own.length && own[0]!.split('\t').length === 8) sets.push(['own', own]);
  sets.push([
    'rebuilt',
    events.steps.map((s) => {
      const target = s.target ? Object.values(s.target).join(' ') : '';
      const at = s.verb === 'tap' ? (t0 + s.start + 0.1).toFixed(3) : '';
      return row(s.i, t0 + s.start, t0 + s.end, s.ok, target, s.label && !s.line.includes(s.label) ? s.label : '', s.line, at);
    }),
  ]);
  const on = onsets(motion);
  if (on.length >= 3) {
    sets.push([
      'reactions',
      on.map((o, k) => row(k + 1, t0 + o - 0.5, t0 + o + 0.4, true, '100 200', '', `tap "Item ${k}"`, (t0 + o - 0.35).toFixed(3))),
    ]);
  }
  for (const [name, rows] of [...sets]) {
    for (const shift of [-3.2, -1.1, 0.4, 2.5]) {
      sets.push([
        `${name}${shift > 0 ? '+' : ''}${shift}`,
        rows.map((r) => {
          const c = r.split('\t');
          for (const k of [1, 2, 7]) if (c[k]) c[k] = (Number(c[k]) + shift).toFixed(3);
          return c.join('\t');
        }),
      ]);
    }
  }
  if (sets.find(([n]) => n === 'reactions')) {
    const two = sets.find(([n]) => n === 'reactions+2.5')![1].slice(0, 2);
    sets.push(['two-taps', two]);
  }
  for (const [set, rows] of sets) {
    for (const kind of ['mobile', 'web']) {
      const name = `${take} ${set} ${kind}`;
      const [dp, dt] = dirs(scratch, `take-camera/py/${take}-${set}-${kind}`, `take-camera/ts/${take}-${set}-${kind}`) as [string, string];
      for (const d of [dp, dt]) {
        cpSync(join(src, clip), join(d, clip));
        if (motion) writeFileSync(join(d, 'motion.txt'), motion);
        writeFileSync(join(d, 'rows.tsv'), `${rows.join('\n')}\n`);
      }
      const extra = kind === 'web' ? ['--kind', 'web', '--platform', 'web', '--viewport', '1440x900'] : ['--kind', 'mobile', '--platform', clip.replace('.mp4', ''), '--scale', '3'];
      const argv = (d: string): string[] => ['events', '--dir', d, '--rows', join(d, 'rows.tsv'), '--clip', clip, '--t-stop', String(tStop), ...extra];
      const p = py(argv(dp));
      const t = await ts(main, argv(dt));
      cases++;
      report.text(name, p, t);
      const a = readFileSync(join(dp, 'events.json'), 'utf8');
      const b = readFileSync(join(dt, 'events.json'), 'utf8');
      if (a !== b) {
        report.failures.push(`${name} events.json`);
        console.log(`✗ ${name} events.json\n--- python\n${a.slice(0, 1200)}\n--- ts\n${b.slice(0, 1200)}`);
      }
      const said = p.stdout.split('\n').find((l) => l.includes('re-anchored'));
      if (said) console.log(`  ${name}: ${said.replace('events.json: ', '')}`);
    }
  }
}
report.done(`take (camera), ${cases} takes`);
