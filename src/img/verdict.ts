// What an mshot found, in one line, and remembered for `vysu report`.
//
//   verdict <shots-dir> <capture> previous|baseline:<name>|new|skipped [--diff <file>|-] [--quiet]
//           [--device <name>]
//
// `<capture>` is the file name without .png (`android-home`). With `previous` or `baseline:<name>`,
// `--diff` holds what diff printed (text mode) for the two captures; the line printed is
//
//     vs previous: unchanged
//     vs previous: 3 zones changed (0,120 393x80 · 12,400 200x40 · +1) · <marked png>
//
// and `--quiet` records it without a word (--baseline prints diff's own lines, as it always did).
// `new` (nothing to compare with) and `skipped` (--no-prev) only record. The record is the capture's
// latest verdict, under `verdicts` in the folder's meta.json: `vysu report` reads it back, one line
// per capture, and names the marked image of the latest change as the one to open.
import { existsSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { isoLocal } from '../core/text.ts';
import { parseArgs, type ParserSpec } from './args.ts';
import { pyJson, pyJsonParse, pySplitlines, pyStrip } from './fmt.ts';
import type { Io } from './tools.ts';

const ZONES_SHOWN = 3;

export interface DiffSummary {
  count: number;
  zones: string[];
  marked: string | null;
  size: string | null;
}

// diff's text report → changed zones count, zone boxes, marked path, size change.
export function parseDiffText(text: string): DiffSummary {
  const out: DiffSummary = { count: 0, zones: [], marked: null, size: null };
  for (const raw of pySplitlines(text)) {
    const line = pyStrip(raw);
    let m = /^size mismatch: baseline (\d+x\d+), current (\d+x\d+)/.exec(line);
    if (m) {
      out.size = `${m[1]} → ${m[2]}`;
      continue;
    }
    m = /^changed .* · (\d+) zones?$/.exec(line);
    if (m) {
      out.count = Number(m[1]);
      continue;
    }
    m = /^\d+\. x (\d+) y (\d+) w (\d+) h (\d+) px/.exec(line);
    if (m) {
      out.zones.push(`${m[1]},${m[2]} ${m[3]}x${m[4]}`);
      continue;
    }
    if (line.startsWith('marked:')) out.marked = pyStrip(line.slice(line.indexOf(':') + 1));
  }
  return out;
}

// The capture's entry under `verdicts` in meta.json, written through a temporary file so a reader
// never sees half of it. Floats already there stay floats: the file keeps the spelling (« 30.0 ») it
// was written with.
export function recordVerdict(dir: string, capture: string, entry: Record<string, unknown>): void {
  const path = join(dir, 'meta.json');
  let meta: Record<string, unknown> = {};
  if (existsSync(path)) {
    try {
      const m = pyJsonParse(readFileSync(path, 'utf8'));
      if (m && typeof m === 'object' && !Array.isArray(m)) meta = m as Record<string, unknown>;
    } catch {
      meta = {};
    }
  }
  entry.at = isoLocal();
  const verdicts = meta.verdicts && typeof meta.verdicts === 'object' && !Array.isArray(meta.verdicts) ? (meta.verdicts as Record<string, unknown>) : {};
  meta.verdicts = verdicts;
  verdicts[capture] = entry;
  const tmp = `${path}.tmp`;
  writeFileSync(tmp, pyJson(meta, { indent: 1, ascii: false }));
  renameSync(tmp, path);
}

export interface VerdictArgs {
  shots: string;
  capture: string;
  // previous | baseline:<name> | new | skipped
  vs: string;
  diffText?: string;
  device?: string;
  quiet?: boolean;
}

// The line printed (null when there is none), or an Error for a `vs` it does not know.
export function verdict(a: VerdictArgs): string | null | Error {
  const entry: Record<string, unknown> = a.device ? { device: a.device } : {};
  if (a.vs === 'new' || a.vs === 'skipped') {
    entry.vs = null;
    entry.verdict = a.vs === 'new' ? 'new' : 'not compared (--no-prev)';
    recordVerdict(a.shots, a.capture, entry);
    return null;
  }
  if (a.vs !== 'previous' && !a.vs.startsWith('baseline:')) return new Error(`verdict: vs must be previous, baseline:<name>, new or skipped (got ${a.vs})`);
  const { count, zones, marked, size } = parseDiffText(a.diffText ?? '');
  const vs = a.vs === 'previous' ? 'previous' : `baseline ${a.vs.slice(a.vs.indexOf(':') + 1)}`;
  let verdictText: string;
  let detail: string;
  if (count) {
    const shown = zones.slice(0, ZONES_SHOWN).join(' · ') + (count > ZONES_SHOWN ? ` · +${count - ZONES_SHOWN}` : '');
    verdictText = `${count} zone${count > 1 ? 's' : ''} changed`;
    detail = shown ? `${verdictText} (${shown})` : verdictText;
  } else verdictText = detail = 'unchanged';
  if (size) detail = `size ${size}, ${detail}`;
  Object.assign(entry, { vs, verdict: verdictText, zones: zones.slice(0, ZONES_SHOWN), more: Math.max(0, count - ZONES_SHOWN), size, marked: count ? marked : null });
  recordVerdict(a.shots, a.capture, entry);
  if (a.quiet) return null;
  return `  vs ${vs}: ${detail}${count && marked ? ` · ${marked}` : ''}`;
}

const SPEC: ParserSpec = {
  prog: 'verdict',
  usage: `usage: verdict [-h] [--diff DIFF] [--device DEVICE] [--quiet]
               shots capture vs`,
  pos: [{ name: 'shots' }, { name: 'capture' }, { name: 'vs' }],
  opts: {
    '--diff': { kind: 'str' },
    '--device': { kind: 'str', def: '' },
    '--quiet': { kind: 'flag' },
  },
};

export async function main(argv: string[], io: Io): Promise<number> {
  const a = parseArgs(SPEC, argv, io);
  if (typeof a === 'number') return a;
  const vs = a.vs as string;
  let diffText = '';
  if (a.diff && vs !== 'new' && vs !== 'skipped' && (vs === 'previous' || vs.startsWith('baseline:'))) {
    try {
      diffText = a.diff === '-' ? (io.stdin ?? readFileSync(0)).toString('utf8') : readFileSync(a.diff as string, 'utf8');
    } catch (e) {
      io.err(`verdict: ${(e as Error).message}\n`);
      return 1;
    }
  }
  const r = verdict({ shots: a.shots as string, capture: a.capture as string, vs, diffText, device: a.device as string, quiet: a.quiet as boolean });
  if (r instanceof Error) {
    io.err(`${r.message}\n`);
    return 1;
  }
  if (r !== null) io.out(`${r}\n`);
  return 0;
}
