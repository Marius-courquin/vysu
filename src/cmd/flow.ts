// `vysu flow <persona> <file|-> [--shots <name>] [--viewport WxH] [--keep-going] [--no-sheet]`: a
// scripted walk of the web, the steps of a file (or stdin) one per line, then the contact sheet of the
// shots taken along the way. Flows are data, not behaviour: the same runner walks any app. It is also the batch
// mode: a hundred `go <url>` / `shot <label>` pairs are one call, one browser, one sheet.
import { readdirSync } from 'node:fs';
import { join } from 'node:path';
import { config } from '../core/ctx.ts';
import { die, exit } from '../core/errors.ts';
import { lockTake, resourceOf } from '../core/hold.ts';
import { ab } from '../web/ab.ts';
import { isDir, isFile, readLines } from '../web/lines.ts';
import { sessionOf } from '../web/ab.ts';
import { webLangInit, webMeta, webStep } from '../web/page.ts';
import { optValue, wh } from '../web/shots.ts';
import { run as sheet } from './sheet.ts';

export async function run(args: string[]): Promise<void> {
  const [persona, file] = args;
  if (!persona || !file) die('usage: vysu flow <persona> <file|-> [--shots <name>] [--viewport WxH] [--keep-going] [--no-sheet]');
  let shots = '';
  let viewport = '';
  let keep = false;
  // A batch of hundreds of captures wants its files, not thirty pages of contact sheet (180 captures:
  // 13 s and 30 sheet paths printed).
  let noSheet = false;
  for (let i = 2; i < args.length; i++) {
    const a = args[i]!;
    if (a === '--shots') shots = optValue(args, i++, 'flow');
    else if (a === '--viewport') viewport = optValue(args, i++, 'flow');
    else if (a === '--keep-going') keep = true;
    else if (a === '--no-sheet') noSheet = true;
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
  // --keep-going: a step that fails is said and passed, as `mdo` does on a device — one window that
  // did not open must not cost the other ninety captures of a batch.
  const failed: string[] = [];
  let steps = 0;
  for (const line of readLines(file)) {
    n++;
    if (line.trim() && !line.startsWith('#')) steps++;
    print(`▸ ${line}\n`);
    if (await webStep(persona, shots, line, print)) continue;
    if (!keep) die(`vysu flow: step ${n} failed in ${sessionOf(persona)}: ${line}`);
    print(`✗ ${n} ${line}\n`);
    failed.push(`${n} ${line}`);
  }
  const dir = join(config().shots, shots);
  if (shots && isDir(dir)) {
    await webMeta(dir, persona, { viewport });
    if (!noSheet && readdirSync(dir).length) await sheet([shots]);
  }
  if (failed.length) {
    print(`flow: ${failed.length} of ${steps} step(s) failed (line, step):\n${failed.map((f) => `  ✗ ${f}\n`).join('')}`);
    exit(1);
  }
}
