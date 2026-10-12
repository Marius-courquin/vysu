// `vysu help [<command>]`: the usage, src/usage.txt as it is (a block of `#` lines, the shape it always
// had), or only the entries of one command. `vysu <command> --help` lands here too (src/cli.ts).
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

export function usage(): string {
  return readFileSync(join(import.meta.dirname, '..', 'usage.txt'), 'utf8');
}

// A name whose entries are spelled under another command's, or that takes another's options: a walk
// passes its options on to shots.
const ENTRIES_OF: Record<string, string[]> = { token: ['auth'], walk: ['walk', 'shots'] };

// The entries of usage.txt that document one command: an entry starts on a `#   vysu …` line and
// goes on over the lines indented further; it is one of `name`'s when its first line names it, as
// `vysu name`, `vysu ios|name` or `… | name …` (`vysu up all | down <service>` documents `down`).
// '' when no entry names it.
export function helpFor(name: string, text = usage()): string {
  const esc = (ENTRIES_OF[name] ?? [name]).map((n) => n.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|');
  const names = new RegExp(`(?:vysu (?:[\\w-]+\\|)*(?:${esc})|\\| (?:${esc}))(?=[\\s|]|$)`);
  const out: string[] = [];
  let keep = false;
  for (const line of text.split('\n')) {
    if (/^# {3}\S/.test(line)) keep = names.test(line);
    else if (!/^# {4,}\S/.test(line)) keep = false;
    if (keep) out.push(line);
  }
  return out.length ? `${out.join('\n')}\n` : '';
}

// Is help asked for anywhere among a command's own arguments? Not past a `--`: what follows is a
// step (`mdo … -- "<step>"`), and a step may say anything.
export function helpAsked(args: string[]): boolean {
  for (const a of args) {
    if (a === '--') return false;
    if (a === '-h' || a === '--help') return true;
  }
  return false;
}

export async function run(args: string[] = []): Promise<void> {
  const name = args[0];
  const lines = name ? helpFor(name) : '';
  process.stdout.write(lines || usage());
}
