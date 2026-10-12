// `vysu prune [--days|--older 30] [--match "<glob>"…] [--dry-run] [--force]`. Captures pile up: a month
// of them is gigabytes of PNGs nothing will ever read again. Age is the default sieve; --match names
// the folders of one task, whose captures are dead the moment it ends, whatever their age. Given both,
// a folder has to be old *and* named: « --match "*" --days 30 » is the plain prune.
//
// A glob is wider than the task it was written for: `--match "feeds-*"` took the folders of another
// session working at the same time (audit, 25/09 → 12/10). A folder touched in the last
// RECENT_HOURS, or last written by another owner whose process still runs, is kept unless --force.
import { lstatSync, readdirSync, rmSync, type Stats } from 'node:fs';
import { basename, join } from 'node:path';
import { config } from '../core/ctx.ts';
import { die } from '../core/errors.ts';
import { owner, ownerGone } from '../core/hold.ts';
import { metaRead } from '../core/meta.ts';
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

export const RECENT_HOURS = 6;

// The newest time anything in a folder was written, one level down: a capture rewritten in place
// moves its own mtime, not the folder's.
export function lastTouched(dir: string): number {
  let t = 0;
  try {
    t = lstatSync(dir).mtimeMs;
    for (const n of readdirSync(dir)) {
      try {
        t = Math.max(t, lstatSync(join(dir, n)).mtimeMs);
      } catch {
        // gone meanwhile
      }
    }
  } catch {
    // unreadable: its age alone
  }
  return t;
}

// A session that runs for days (a human's terminal, a long-lived agent) is still alive long after
// its captures stopped mattering: with an age asked for, it protects only what it wrote today.
export const LIVE_OWNER_HOURS = 24;

// Why a folder is kept although it matched, or '' to drop it. `aged`: the prune is bounded by age.
export function keptBecause(dir: string, me: string, nowMs = Date.now(), gone = ownerGone, aged = false): string {
  const age = nowMs - lastTouched(dir);
  if (age < RECENT_HOURS * 3_600_000) return `touched ${Math.max(1, Math.round(age / 60_000))} min ago`;
  if (aged && age >= LIVE_OWNER_HOURS * 3_600_000) return '';
  const who = metaRead(dir).owner;
  if (typeof who === 'string' && who && who !== me && !gone(who)) return `written by ${who}, still running`;
  return '';
}

export async function run(args: string[]): Promise<void> {
  let days = '';
  let dry = false;
  let force = false;
  const match: string[] = [];
  for (let i = 0; i < args.length; i++) {
    const a = args[i]!;
    if (a === '--days' || a === '--older') days = optValue(args, i++, 'prune') || '30';
    else if (a === '--dry-run') dry = true;
    else if (a === '--force') force = true;
    // « --match "rv-* tv-*" » is two globs.
    else if (a === '--match') match.push(...optValue(args, i++, 'prune').split(/[ \t\n]+/).filter(Boolean));
    else die(`vysu prune: unknown option ${a}`);
  }
  if (!days && !match.length) days = '30';
  if (days && !/^\d+$/.test(days)) die(`vysu prune: --days takes a whole number of days (got « ${days} »)`);
  const shots = config().shots;
  if (!isDir(shots)) die(`no shots folder ${shots}`);
  for (const g of match) {
    // A glob that takes everything is the whole shots folder of every task running on this machine.
    if (g === '*' && !days) die(`vysu prune: --match « ${g} » takes every folder — give --days too to bound it`);
    if (g.includes('/')) die(`vysu prune: --match matches a folder name, not a path (${g})`);
  }
  let what = match.length ? ` matching ${match.join(' ')}` : '';
  if (days) what += ` older than ${days} days`;
  const me = owner();
  const dirs: string[] = [];
  let kept = 0;
  for (const d of pruneable(shots, days, match)) {
    const why = force ? '' : keptBecause(d, me, Date.now(), ownerGone, !!days);
    if (!why) dirs.push(d);
    else {
      kept++;
      if (dry || match.length) console.log(`kept: ${basename(d)} (${why}; --force to take it)`);
    }
  }
  let kb = 0;
  for (const d of dirs) {
    if (dry) console.log(d);
    kb += duKb(d);
  }
  if (dry) {
    console.log(`would prune: ${dirs.length} folder(s)${what}, ${Math.floor(kb / 1024)} MB freed (${shots})${kept ? `, ${kept} kept` : ''}`);
    return;
  }
  for (const d of dirs) {
    // `vysu video` copies the take's clip under the toolkit's public/ so staticFile() can serve it.
    // Nothing else ever reclaims that copy, and it is the take's whole clip: it goes with the take.
    rmSync(d, { recursive: true, force: true });
    rmSync(join(config().remotion, 'public', 'takes', basename(d)), { recursive: true, force: true });
  }
  console.log(`pruned: ${dirs.length} folder(s)${what}, ${Math.floor(kb / 1024)} MB freed (${shots})${kept ? `, ${kept} kept` : ''}`);
}
