// `vysu flow <persona> <file|-> [--shots <name>] [--viewport WxH]`: a scripted walk of the web, the
// steps of a file (or stdin) one per line, then the contact sheet of the shots taken along the way.
// Flows are data, not behaviour: the same runner walks any app.
import { readdirSync } from 'node:fs';
import { join } from 'node:path';
import { config } from '../core/ctx.ts';
import { die, exit } from '../core/errors.ts';
import { lockTake, resourceOf } from '../core/hold.ts';
import { ab } from '../web/ab.ts';
import { isDir, isFile, readLines } from '../web/lines.ts';
import { webLangInit, webMeta, webStep } from '../web/page.ts';
import { optValue, wh } from '../web/shots.ts';
import { run as sheet } from './sheet.ts';

export async function run(args: string[]): Promise<void> {
  const [persona, file] = args;
  if (!persona || !file) die('usage: vysu flow <persona> <file|-> [--shots <name>] [--viewport WxH]');
  let shots = '';
  let viewport = '';
  for (let i = 2; i < args.length; i++) {
    const a = args[i]!;
    if (a === '--shots') shots = optValue(args, i++, 'flow');
    else if (a === '--viewport') viewport = optValue(args, i++, 'flow');
    else die(`vysu flow: unknown option ${a}`);
  }
  if (file !== '-' && !isFile(file)) die(`no flow file ${file}`);
  await lockTake(resourceOf(persona));
  // This flow answers for itself: what the session collected before it is not its business.
  await ab(persona, ['errors', '--clear'], { stderr: 'drop' });
  await ab(persona, ['network', 'requests', '--clear'], { stderr: 'drop' });
  await webLangInit(persona);
  if (viewport) {
    const r = await ab(persona, ['set', 'viewport', ...wh(viewport)]);
    if (r.code !== 0) exit(r.code);
  }
  const print = (s: string): void => void process.stdout.write(s);
  let n = 0;
  for (const line of readLines(file)) {
    n++;
    print(`▸ ${line}\n`);
    if (!(await webStep(persona, shots, line, print))) die(`vysu flow: step ${n} failed: ${line}`);
  }
  const dir = join(config().shots, shots);
  if (!shots || !isDir(dir)) return;
  await webMeta(dir, persona, { viewport });
  if (readdirSync(dir).length) await sheet([shots]);
}
