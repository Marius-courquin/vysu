// `vysu prune [--days 30] [--match "<glob>"…] [--dry-run]`. Captures pile up: a month of them is
// gigabytes of PNGs nothing will ever read again. Age is the default sieve; --match names the folders
// of one task, whose captures are dead the moment it ends, whatever their age. Given both, a folder
// has to be old *and* named: « --match "*" --days 30 » is the plain prune.
import { lstatSync, readdirSync, rmSync, type Stats } from 'node:fs';
import { basename, join } from 'node:path';
import { config } from '../core/ctx.ts';
import { die } from '../core/errors.ts';
import { fnmatch } from '../core/py.ts';
import { isDir } from '../web/lines.ts';
import { optValue } from '../web/shots.ts';

// `du -sk`: the 512-byte blocks a tree holds on disk, a hard link counted once, in kilobytes.
export function duKb(root: string): number {
  const seen = new Set<string>();
  let blocks = 0;
  const walk = (p: string): void => {
    let st: Stats;
    try {
      st = lstatSync(p);
    } catch {
      return;
    }
    const id = `${st.dev}:${st.ino}`;
    if (st.nlink > 1 && !st.isDirectory()) {
      if (seen.has(id)) return;
      seen.add(id);
    }
    blocks += Number.isFinite(st.blocks) ? st.blocks : Math.ceil(st.size / 512);
    if (st.isDirectory()) {
      let names: string[] = [];
      try {
        names = readdirSync(p);
      } catch {
        // unreadable: its own blocks only, as du says
      }
      for (const n of names) walk(join(p, n));
    }
  };
  walk(root);
  return Math.ceil(blocks / 2);
}

// `find $SHOTS -mindepth 1 -maxdepth 1 -type d [-mtime +N] [\( -name g -o … \)]`: rooted at the
// shots folder, one level deep, and a glob only ever sees a basename — nothing outside can match.
export function pruneable(shots: string, days: string, match: string[], nowMs = Date.now()): string[] {
  const out: string[] = [];
  for (const n of readdirSync(shots).sort()) {
    const p = join(shots, n);
    let st: Stats;
    try {
      st = lstatSync(p);
    } catch {
      continue;
    }
    if (!st.isDirectory()) continue;
    // -mtime +N: whole days of age, the fraction dropped, strictly more than N.
    if (days && !(Math.floor((nowMs - st.mtimeMs) / 86_400_000) > Number(days))) continue;
    if (match.length && !match.some((g) => fnmatch(n, g))) continue;
    out.push(p);
  }
  return out;
}

export async function run(args: string[]): Promise<void> {
  let days = '';
  let dry = false;
  const match: string[] = [];
  for (let i = 0; i < args.length; i++) {
    const a = args[i]!;
    if (a === '--days') days = optValue(args, i++, 'prune') || '30';
    else if (a === '--dry-run') dry = true;
    // « --match "rv-* tv-*" » is two globs.
    else if (a === '--match') match.push(...optValue(args, i++, 'prune').split(/[ \t\n]+/).filter(Boolean));
    else die(`vysu prune: unknown option ${a}`);
  }
  if (!days && !match.length) days = '30';
  const shots = config().shots;
  if (!isDir(shots)) die(`no shots folder ${shots}`);
  for (const g of match) {
    // A glob that takes everything is the whole shots folder of every task running on this machine.
    if (g === '*' && !days) die(`vysu prune: --match « ${g} » takes every folder — give --days too to bound it`);
    if (g.includes('/')) die(`vysu prune: --match matches a folder name, not a path (${g})`);
  }
  let what = match.length ? ` matching ${match.join(' ')}` : '';
  if (days) what += ` older than ${days} days`;
  const dirs = pruneable(shots, days, match);
  let kb = 0;
  for (const d of dirs) {
    if (dry) console.log(d);
    kb += duKb(d);
  }
  if (dry) {
    console.log(`would prune: ${dirs.length} folder(s)${what}, ${Math.floor(kb / 1024)} MB freed (${shots})`);
    return;
  }
  for (const d of dirs) {
    // `vysu video` copies the take's clip under the toolkit's public/ so staticFile() can serve it.
    // Nothing else ever reclaims that copy, and it is the take's whole clip: it goes with the take.
    rmSync(d, { recursive: true, force: true });
    rmSync(join(config().remotion, 'public', 'takes', basename(d)), { recursive: true, force: true });
  }
  console.log(`pruned: ${dirs.length} folder(s)${what}, ${Math.floor(kb / 1024)} MB freed (${shots})`);
}
