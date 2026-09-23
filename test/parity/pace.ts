// pace.py against src/img/pace.ts: `js` and `chunks` for texts that exercise the seeding (accents,
// emoji, an empty text, a long one past a generator's first 624 words), the cuts (long words, runs of
// spaces, punctuation at a cut) and every value VYSU_TYPE_CPS / VYSU_TYPE_RUN can hold, well formed
// or not; then the usage. Output and exit code must match to the byte.
//
//   node test/parity/pace.ts <dir holding pace.py> <scratch>
import { spawnSync } from 'node:child_process';
import { join } from 'node:path';
import { Config } from '../../src/core/config.ts';
import { setConfig } from '../../src/core/ctx.ts';
import { main } from '../../src/img/pace.ts';
import { type Ran, Report, ts } from './lib.ts';

const [pyDir, scratch] = process.argv.slice(2);
if (!pyDir || !scratch) throw new Error('usage: node test/parity/pace.ts <dir holding pace.py> <scratch>');
const report = new Report();

function py(args: string[], env: NodeJS.ProcessEnv): Ran {
  const t = performance.now();
  const r = spawnSync('python3', [join(pyDir!, 'pace.py'), ...args], { env, cwd: scratch, maxBuffer: 1 << 26 });
  return { code: r.status ?? 1, stdout: r.stdout.toString(), stderr: r.stderr.toString(), ms: performance.now() - t };
}

const texts = [
  'a',
  'hello world',
  'Bonjour, je voudrais signaler une fuite d\'eau dans la cave.',
  'Héllo, wörld 👋!',
  'anticonstitutionnellement',
  'a b c d e f g h i j k l m n o p',
  '   leading and trailing   ',
  'double  spaces   here    and there',
  'Fin… vraiment ? Oui ! Non ; peut-être : ok.',
  'admin+tb_resident@nidz.fr',
  '0612345678',
  '日本語のテキストを入力します',
  '🙂🙃😉😊😇🥰😍🤩😘😗',
  'x'.repeat(700),
  'La porte du hall B ne ferme plus depuis hier soir, le groom est cassé et la gâche ne tient plus. '.repeat(4),
  '\ttab\tand\nnewline',
  ' ',
  '',
];
const cpsValues = [undefined, '', '8', '14', '0.5', '1', '40', '100', 'abc', 'nan', 'inf', '-3', '1_4', ' 20 ', '11.5'];
const runValues = [undefined, '', '2', '1', '0', '-4', '5', '12', 'x', '3.5', ' 5 ', '1_0', '+6'];

async function both(name: string, args: string[], vars: Record<string, string | undefined>): Promise<void> {
  const env: NodeJS.ProcessEnv = { ...process.env };
  delete env.VYSU_TYPE_CPS;
  delete env.VYSU_TYPE_RUN;
  for (const [k, v] of Object.entries(vars)) if (v !== undefined) env[k] = v;
  setConfig(Config.load(env, scratch));
  const p = py(args, env);
  const t = await ts(main, args);
  report.text(name, p, t);
  if (p.stderr !== t.stderr) {
    report.failures.push(`${name} (stderr)`);
    console.log(`✗ ${name} stderr ${JSON.stringify(p.stderr.slice(0, 200))} / ${JSON.stringify(t.stderr.slice(0, 200))}`);
  }
}

for (const [i, text] of texts.entries()) {
  await both(`js #${i}`, ['js', text], {});
  await both(`chunks #${i}`, ['chunks', text], {});
}
for (const cps of cpsValues) for (const i of [2, 3, 14]) await both(`js #${i} cps=${JSON.stringify(cps)}`, ['js', texts[i]!], { VYSU_TYPE_CPS: cps });
for (const run of runValues) for (const i of [2, 4, 7, 12, 14]) await both(`chunks #${i} run=${JSON.stringify(run)}`, ['chunks', texts[i]!], { VYSU_TYPE_RUN: run });
for (const args of [[], ['js'], ['type', 'x'], ['js', 'a', 'b'], ['chunks']]) await both(`usage ${args.join(' ')}`, args, {});
report.done('pace');
