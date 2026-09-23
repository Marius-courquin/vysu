// The app's log, from the last mark: `vysu mlog mark` before an action, `vysu mlog` after it: the
// console.error / warnings of that window only. In expo mode that log is Metro's (the port this owner
// talks to), which mixes every device bundling from it; `--device` reads this device's own JS console
// instead. In native mode it is the platform tail `vysu up` started (logs/<platform>-app.log), and
// `vysu mlog ios|android` says which one when both are running. Marks are per owner: two sessions
// marking the same Metro log no longer move each other's window.
import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { basename, dirname, join } from 'node:path';
import { config } from '../core/ctx.ts';
import { die } from '../core/errors.ts';
import { owner, type Platform } from '../core/hold.ts';
import { hhmm, slug } from '../core/text.ts';
import { applogAlive, applogFile, applogPlatform, applogStart } from './applog.ts';
import { androidSelect } from './device.ts';
import { quiet, say, tell } from './io.ts';
import { mobileKind } from './launch.ts';
import { bundleErrorSince, lineCount, linesAfter, metroLog, metroPort } from './metro.ts';

const markFile = (log: string): string => join(config().state, 'marks', slug(owner()), basename(log));

// « <name> at line N ».
function mark(log: string): string {
  const f = markFile(log);
  mkdirSync(dirname(f), { recursive: true });
  const n = lineCount(log);
  writeFileSync(f, `${n}\n`);
  return `${basename(log, '.log')} at line ${n}`;
}

// The first line after this owner's mark (a mark past the end: a restarted tail).
function since(log: string): number {
  let from = 0;
  try {
    from = Number(readFileSync(markFile(log), 'utf8').trim()) || 0;
  } catch {
    from = 0;
  }
  return from <= lineCount(log) ? from : 0;
}

// A device log stamps every line (time, pid): the stamp goes, the level stays, so that the same error
// seen twice reads as one line « ×2 ».
const IOS_STAMP = /^[0-9]+-[0-9]+-[0-9]+ [0-9:.]+ +[A-Za-z]+ +[^ ]+\[[0-9a-fx:]+\] /;
const IOS_STRIP = /^[0-9]+-[0-9]+-[0-9]+ [0-9:.]+ +[A-Za-z]+ +[^ ]+\[[0-9a-fx:]+\] (\[[^\]]*\] )?/;
const LOGCAT_STAMP = /^[0-9]+-[0-9]+ [0-9:.]+ [VDIWEF]\/[^(]*\( *[0-9]+\): /;
function bare(l: string): string {
  if (IOS_STAMP.test(l)) {
    const lvl = l.trim().split(/\s+/)[2] ?? '';
    return `${lvl} ${l.replace(IOS_STRIP, '')}`;
  }
  if (LOGCAT_STAMP.test(l)) {
    const lvl = l[l.indexOf('/') - 1] ?? '';
    return `${lvl} ${l.replace(LOGCAT_STAMP, '')}`;
  }
  return l;
}
// Cut at 200 bytes, as the C-locale awk did; a cut inside a multi-byte character would leave invalid
// UTF-8 behind, so the trailing non-ASCII bytes of a cut line go.
function cut200(l: string): string {
  const b = Buffer.from(l, 'utf8');
  if (b.length <= 200) return l;
  let end = 200;
  while (end > 0 && b[end - 1]! >= 0x80) end--;
  return b.subarray(0, end).toString('utf8');
}
const ERRORISH = [
  /^ *(ERROR|WARN|error|warn)[ :]/,
  /Bundling failed/,
  /^Error[ :[]/,
  /(Error|Exception):/,
  /Unable to resolve/,
  / [EWF]\/[^ ]/,
  /^[0-9-]+ [0-9:.]+ +(E|F|W) /,
  /(Warning|WARNING):/,
];

// What an agent reads: ANSI colours out, VYSU_MLOG_IGNORE's lines dropped and counted (one ERE, its
// alternatives `|`-separated), and with --errors only the error and warning lines plus the first line
// of each stack, each cut at 200 characters, a line seen N times printed once with « ×N ».
export function mlogFilter(input: string, errors: boolean, ignore = config().get('MLOG_IGNORE')): string[] {
  let text = input.replace(/\x1b\[[0-9;]*m/g, '').replace(/\n+$/, '');
  let ignored = 0;
  let ls = text === '' ? [''] : text.split('\n');
  if (ignore) {
    const re = new RegExp(ignore);
    ignored = ls.filter((l) => re.test(l)).length;
    ls = ls.filter((l) => !re.test(l));
    text = ls.join('\n');
    if (!ls.length) ls = [''];
  }
  if (errors) {
    const order: string[] = [];
    const count = new Map<string, number>();
    let stack = false;
    const keep = (raw: string): void => {
      const l = cut200(bare(raw));
      if (!count.has(l)) order.push(l);
      count.set(l, (count.get(l) ?? 0) + 1);
    };
    for (const l of ls) {
      if (/^[ \t]+at /.test(l)) {
        if (stack) {
          keep(l);
          stack = false;
        }
        continue;
      }
      if (ERRORISH.some((re) => re.test(l))) {
        keep(l);
        stack = true;
        continue;
      }
      if (/^ *(LOG|INFO|DEBUG) /.test(l) || / Bundled [0-9]/.test(l)) stack = false;
    }
    text = order.map((l) => `${l}${count.get(l)! > 1 ? ` ×${count.get(l)}` : ''}`).join('\n');
  }
  const out = text === '' ? [] : text.split('\n');
  if (ignored) out.push(`(${ignored} lines ignored by VYSU_MLOG_IGNORE)`);
  return out;
}

export const MLOG_USAGE = 'usage: vysu mlog [ios|android] [--device] [--errors] [mark | --tail N]';

export async function mlog(args: string[]): Promise<void> {
  let p: Platform | '' = '';
  let device = false;
  let errors = false;
  let action = '';
  let n = 40;
  for (let i = 0; i < args.length; i++) {
    const a = args[i]!;
    if (a === 'ios' || a === 'android') p = a;
    else if (a === '--device') device = true;
    else if (a === '--errors') errors = true;
    else if (a === 'mark') action = 'mark';
    else if (a === '--tail') {
      action = 'tail';
      if (/^[0-9]+$/.test(args[i + 1] ?? '')) n = Number(args[++i]);
    } else die(MLOG_USAGE);
  }
  const kind = mobileKind();
  let log: string;
  let name: string;
  let metro = '';
  if (kind === 'expo') {
    metro = metroLog();
    if (device || (action === 'mark' && p)) {
      p ||= 'ios';
      if (p === 'android') await androidSelect();
      // This device's JS console: started on first use, and said so, since what came before it is
      // not in it.
      if (!applogAlive(p, 'js')) {
        await quiet(() => applogStart(p as Platform, 'js'));
        if (action !== 'mark') say(`${p}: JS log started now, nothing before this line (vysu mlog ${p} --device after the action)`);
      }
    }
    if (device) {
      log = applogFile(p as Platform, 'js');
      name = `${p} JS`;
    } else {
      log = metro;
      name = `metro :${metroPort()}`;
    }
  } else {
    // A native app's log is already its own device's: --device changes nothing here.
    device = false;
    p ||= applogPlatform();
    log = applogFile(p);
    name = p;
    // A dead tail and a quiet app read the same on screen (an empty answer) and the difference matters:
    // a tail dies with the adbd it was attached to (`adb root`, an emulator restart), and every line
    // after that is simply not in the file.
    if (!applogAlive(p)) {
      let at = '';
      try {
        at = hhmm(Math.floor(statSync(log).mtimeMs / 1000));
      } catch {
        at = '?';
      }
      tell(`vysu: ${p}: the app log is no longer tailing, it stops at ${at} (vysu up ${p})`);
    }
  }
  if (device && !applogAlive(p as Platform, 'js')) tell(`vysu: ${p}: the JS log is no longer tailing (vysu mlog ${p} --device restarts it)`);
  if (!existsSync(log)) die(`no ${log} (vysu up ${p || 'ios|android'} starts it)`);
  if (action === 'mark') {
    // Every log this owner may read next: Metro's, each device's JS console, each native app tail.
    const logs = config().logs;
    let js: string[] = [];
    try {
      js = readdirSync(logs)
        .filter((f) => /-js-.*\.log$/.test(f))
        .sort()
        .map((f) => join(logs, f));
    } catch {
      js = [];
    }
    const marked = [metro, ...js, join(logs, 'ios-app.log'), join(logs, 'android-app.log')].filter((f) => f && existsSync(f)).map(mark);
    say(`marked: ${marked.join(' · ')}`);
    return;
  }
  if (action === 'tail') {
    const all = readFileSync(log, 'utf8').replace(/\n$/, '').split('\n');
    const out = mlogFilter(all.slice(-n * 20).join('\n'), errors);
    for (const l of out.slice(-n)) say(l);
    return;
  }
  // A broken bundle first: the screen may be stale because an edit (maybe another session's, on the
  // same checkout) no longer compiles, and nothing else in the log says it that plainly.
  if (metro && existsSync(metro)) {
    const err = bundleErrorSince(since(metro), metro);
    if (err) say(`metro: bundle failed since the mark: ${err}`);
  }
  const out = mlogFilter(linesAfter(log, since(log)), errors);
  if (out.length) say(out.join('\n'));
  else if (errors) say(`(${name}: no error or warning since the mark)`);
  else say(`(${name}: nothing since the mark)`);
}
