// take.py against src/img/take.ts. `events`: the raw step rows of real takes rebuilt from their
// events.json (plus lines that exercise every verb, quoting and a tap target), for a mobile clip with
// --scale and a web one with --viewport, against the real clips; events.json and the line must match
// to the byte. `draft`: every real take's events.json + motion.txt + meta.json, with a theme and a
// language in the environment; the cut.json printed must match to the byte.
//
//   node test/parity/take.ts <inputs> <scratch>      (<inputs>/takes/<take>/, <inputs>/rec/<take>/)
import { cpSync, existsSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { main } from '../../src/img/take.ts';
import { dirs, py, Report, ts } from './lib.ts';

const [inputs, scratch] = process.argv.slice(2);
if (!inputs || !scratch) throw new Error('usage: node test/parity/take.ts <inputs> <scratch>');
process.env.VYSU_THEME = 'nidz';
process.env.VYSU_LANG = 'fr';
const report = new Report();

const extra = [
  ['tap "Se connecter"', '120.4 640.6', ''],
  ['press 173 822', '173 822', ''],
  ['press Enter', '', ''],
  ['press -12.5 30', '-12.5 30', ''],
  ["longpress 'Mon profil'", '10 20 30 40', 'Mon profil'],
  ['click #submit', '1 2 3 4.5', ''],
  ['fill email a@b.c', '', 'E-mail'],
  ['go https://next.prep.nidz.fr/community', '', ''],
  ['shot home', '', ''],
  ['check', '', ''],
  ['viewport 390x844', '', ''],
  ['relaunch', '', ''],
  ['sleep 1.5', '', ''],
  ['swipe 540 900 540 1900', '1 2 3', ''],
  ['tap "Open', 'x y', ''],
  ['t:auth.login', 'nan 3', 'Connexion'],
];
for (const take of readdirSync(join(inputs, 'rec')).sort()) {
  const src = join(inputs, 'rec', take);
  const clip = readdirSync(src).find((f) => f.endsWith('.mp4'))!;
  const events = existsSync(join(src, 'events.json')) ? (JSON.parse(readFileSync(join(src, 'events.json'), 'utf8')) as { steps: Array<Record<string, unknown>> }) : { steps: [] };
  const tStop = 1758480131.412;
  const rows = [
    ...events.steps.map((s) => [s.line as string, s.target ? Object.values(s.target as object).join(' ') : '', (s.label as string) ?? '']),
    ...extra,
  ].map(([line, target, label], i) => `${i + 1}\t${(tStop - 5 + i * 0.37).toFixed(3)}\t${(tStop - 4.8 + i * 0.37).toFixed(3)}\t${i % 5 ? 'true' : 'false'}\t${target}\t${label}\t${line}`);
  for (const [v, args] of [
    ['mobile', ['--kind', 'mobile', '--platform', clip.replace('.mp4', ''), '--scale', clip.startsWith('ios') ? '3' : '2.625']],
    ['web', ['--kind', 'web', '--platform', 'web', '--viewport', '1440x900']],
  ] as Array<[string, string[]]>) {
    const [dp, dt] = dirs(scratch, `take/py/${take}-${v}`, `take/ts/${take}-${v}`) as [string, string];
    for (const d of [dp, dt]) {
      cpSync(join(src, clip), join(d, clip));
      writeFileSync(join(d, 'rows.tsv'), `${rows.join('\n')}\n`);
    }
    const argv = (d: string): string[] => ['events', '--dir', d, '--rows', join(d, 'rows.tsv'), '--clip', clip, '--t-stop', String(tStop), ...args];
    const p = py('take', argv(dp));
    const t = await ts(main, argv(dt));
    report.text(`${take} events ${v}`, p, t);
    const a = readFileSync(join(dp, 'events.json'), 'utf8');
    const b = readFileSync(join(dt, 'events.json'), 'utf8');
    if (a !== b) {
      report.failures.push(`${take} events.json ${v}`);
      console.log(`✗ ${take} ${v} events.json\n--- python\n${a.slice(0, 1500)}\n--- ts\n${b.slice(0, 1500)}`);
    }
  }
}
for (const take of readdirSync(join(inputs, 'takes')).sort()) {
  const dir = join(inputs, 'takes', take);
  const p = py('take', ['draft', '--dir', dir, '--take', take]);
  const t = await ts(main, ['draft', '--dir', dir, '--take', take]);
  report.text(`${take} draft`, p, t);
}
for (const args of [[], ['nope'], ['events', '--dir', 'x'], ['events', '--dir', 'x', '--rows', 'r', '--clip', 'c.mp4', '--kind', 'tv', '--platform', 'p', '--t-stop', '1'], ['events', '--dir', '/nope', '--rows', 'r', '--clip', 'c.mp4', '--kind', 'web', '--platform', 'p', '--t-stop', '1']]) {
  const p = py('take', args);
  const t = await ts(main, args);
  report.text(`error ${args.join(' ')}`, p, t);
  if (p.stderr !== t.stderr) console.log(`✗ stderr ${JSON.stringify(p.stderr)} / ${JSON.stringify(t.stderr)}`);
}
report.done('take');
