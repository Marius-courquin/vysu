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
import { pyInt, pyStrRepr } from '../img/fmt.ts';
import { sheet } from '../img/sheet.ts';

const USAGE = 'usage: vysu sheet <name>… [--cols N] [--max N] [--only "<glob>,…"] [--strip] [--open] [--compare [--against <name>]]';

// A whole number, or a die naming the option in argparse's words, as sheet.py answered: through
// Number() a missing --max became 0 (one capture per page) and « abc » died on something unrelated.
export function intOption(flag: string, raw: string | undefined): number {
  if (raw === undefined || /^-\D/.test(raw) || raw === '-') die(`vysu sheet: argument ${flag}: expected one argument`);
  const n = pyInt(raw);
  if (n === null) die(`vysu sheet: argument ${flag}: invalid int value: ${pyStrRepr(raw)}`);
  return n;
}

export async function run(args: string[]): Promise<void> {
  // Several folders, one sheet each: `vysu sheet a b c` read « b » as an unknown option.
  const names: string[] = [];
  let first = 0;
  while (first < args.length && !args[first]!.startsWith('--')) names.push(args[first++]!);
  const name = names[0];
  if (!name) die(USAGE);
  let cols = 0;
  let max = 6;
  let only = '';
  let strip = false;
  let wantOpen = false;
  let compare = false;
  let against = '';
  for (let i = first; i < args.length; i++) {
    const a = args[i];
    const value = (): string => args[++i] ?? '';
    switch (a) {
      case '--cols':
        cols = intOption(a, args[++i]);
        break;
      case '--max':
        max = intOption(a, args[++i]);
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
  for (const n of names) {
    const dir = join(config().shots, n);
    if (!existsSync(dir) || !statSync(dir).isDirectory()) die(`no shots folder ${dir}`);
  }
  // A grid answers « what do these screens look like »; a comparison answers « what moved ». compare
  // owns both of its outputs: the triptych an agent reads, the slider page a human drags.
  if (compare) {
    if (names.length > 1) die('vysu sheet --compare: one folder at a time (--against names the other)');
    const dir = join(config().shots, name);
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
      // What it printed before failing stays unsaid: a failed compare answers with its error alone.
      process.stderr.write(`${e.message}\n`);
      exit(1);
    }
    process.stdout.write(`${lines.join('\n')}\n`);
    const html = lines.find((l) => l.endsWith('.html'));
    if (wantOpen && html) openForHuman(html);
    return;
  }
  for (const n of names) {
    const out = await sheet(join(config().shots, n), { name: n, cols, max, only, strip, edge: SHEET_EDGE });
    process.stdout.write(`${out.join('\n')}\n`);
    if (wantOpen) openForHuman(out[0]!);
  }
}
