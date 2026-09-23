// `vysu sheet <name> [--cols N] [--max N] [--only "<glob>,…"] [--strip] [--open]`: the one image an
// agent reads back. Composed from the captures on disk, not rendered in a browser: it used to wait on
// a shared `render` session and come back blank when an image had not loaded yet.
import { existsSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { config } from '../core/ctx.ts';
import { SHEET_EDGE } from '../core/config.ts';
import { die, exit } from '../core/errors.ts';
import { openForHuman } from '../core/host.ts';
import { compare as compareShots, CompareError } from '../img/compare.ts';
import { sheet } from '../img/sheet.ts';

const USAGE = 'usage: vysu sheet <name> [--cols N] [--max N] [--only "<glob>,…"] [--strip] [--open] [--compare [--against <name>]]';

export async function run(args: string[]): Promise<void> {
  const name = args[0];
  if (!name) die(USAGE);
  let cols = 0;
  let max = 6;
  let only = '';
  let strip = false;
  let wantOpen = false;
  let compare = false;
  let against = '';
  for (let i = 1; i < args.length; i++) {
    const a = args[i];
    const value = (): string => args[++i] ?? '';
    switch (a) {
      case '--cols':
        cols = Number(value());
        break;
      case '--max':
        max = Number(value());
        break;
      case '--only':
        only = value();
        break;
      case '--strip':
        strip = true;
        break;
      case '--open':
        wantOpen = true;
        break;
      case '--compare':
        compare = true;
        break;
      case '--against':
        against = value();
        break;
      default:
        die(`vysu sheet: unknown option ${a}`);
    }
  }
  const dir = join(config().shots, name);
  if (!existsSync(dir) || !statSync(dir).isDirectory()) die(`no shots folder ${dir}`);
  // A grid answers « what do these screens look like »; a comparison answers « what moved ». compare
  // owns both of its outputs: the triptych an agent reads, the slider page a human drags.
  if (compare) {
    let againstDir: string | null = null;
    if (against) {
      againstDir = join(config().shots, against);
      if (!existsSync(againstDir) || !statSync(againstDir).isDirectory()) die(`no shots folder ${againstDir}`);
    }
    const lines: string[] = [];
    try {
      await compareShots(dir, { against: againstDir, edge: SHEET_EDGE }, (l) => lines.push(l));
    } catch (e) {
      if (!(e instanceof CompareError)) throw e;
      // What it printed before failing stays unsaid, as under the bash engine's `set -e`.
      process.stderr.write(`${e.message}\n`);
      exit(1);
    }
    process.stdout.write(`${lines.join('\n')}\n`);
    const html = lines.find((l) => l.endsWith('.html'));
    if (wantOpen && html) openForHuman(html);
    return;
  }
  const out = await sheet(dir, { name, cols, max, only, strip, edge: SHEET_EDGE });
  process.stdout.write(`${out.join('\n')}\n`);
  if (wantOpen) openForHuman(out[0]!);
}
