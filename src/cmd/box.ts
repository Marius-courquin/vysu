// `vysu box <persona> <selector|@ref> [--page]`: element bounds for `vysu mark`, viewport-relative
// and 1x — take the screenshot of the same viewport without scrolling in between. --page: document
// coordinates, what a `screenshot --full` capture is measured in.
import { die, exit } from '../core/errors.ts';
import { pyRound } from '../core/py.ts';
import { ab, evalValue, lastLine } from '../web/ab.ts';

export async function run(args: string[]): Promise<void> {
  const [persona, sel] = args;
  if (!persona || !sel) die('usage: vysu box <persona> <selector|@ref> [--page]');
  const page = args[2] === '--page';
  let off = '0,0';
  if (page) off = evalValue((await ab(persona, ['eval', "Math.round(window.scrollX)+','+Math.round(window.scrollY)"], { stderr: 'drop' })).stdout);
  const r = await ab(persona, ['get', 'box', sel, '--json'], { stderr: 'drop' });
  let d: Record<string, number> = {};
  try {
    d = (JSON.parse(lastLine(r.stdout)) as { data?: Record<string, number> }).data ?? {};
  } catch {
    d = {};
  }
  if (!('x' in d)) {
    process.stderr.write(`vysu box: no box for ${sel} — refs need a fresh snapshot (vysu <p> snapshot -i), or use a CSS selector\n`);
    exit(1);
  }
  const [ox, oy] = off.split(',').map((n) => Math.trunc(Number(n)) || 0);
  console.log(`${pyRound(d.x!) + ox!},${pyRound(d.y!) + oy!},${pyRound(d.width!)},${pyRound(d.height!)}`);
}
