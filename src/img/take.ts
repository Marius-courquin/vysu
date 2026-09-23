// take — a vysu recording read back as data.
//
// `events` turns the raw step rows vysu appends while it records into the take's `events.json`: the
// contract the Remotion toolkit consumes (version 1, documented in the visual-check skill). `draft`
// proposes a starting `cut.json` from that file and `motion.txt`, so an agent writes the montage in
// words — chapters, holds, what to keep — and never in frames or coordinates.
//
//   take events --dir <take> --rows <rows.tsv> --clip ios.mp4 --kind mobile --platform ios \
//               --t-stop 1758480131.412 [--scale 3] [--viewport 1440x900]
//   take draft  --dir <take> --take <name>
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { config } from '../core/ctx.ts';
import { run } from '../core/proc.ts';
import { pyRound } from '../core/py.ts';
import { parseArgs, type ParserSpec } from './args.ts';
import { float, num, pyFixed, pyFloat, pyG, pyJson, pyJsonParse, pySplit, pySplitlines, pyStrip, pyStrRepr, shlexSplit, type PyFloat } from './fmt.ts';
import type { Io } from './tools.ts';

const ACTIONS = ['tap', 'fill', 'key', 'go', 'relaunch'];
const DEAD_GAP = 1.2; // no moving frame for longer than this and the clip is cut there
const LEAD_IN = 0.3; // a segment opens just before the gesture that starts it
const SETTLE = 0.4; // and closes just after the screen stops moving
const HOLD = 2; // a `shot` is an anchor: the draft freezes on it that long

export class TakeError extends Error {}

export interface Probe {
  fps: number;
  duration: number;
  width: number;
  height: number;
}

// fps, duration and pixel size of the clip — everything the header cannot guess.
export async function probe(path: string): Promise<Probe> {
  const r = await run('ffprobe', ['-v', 'error', '-select_streams', 'v:0', '-show_entries', 'stream=r_frame_rate,width,height:format=duration', '-of', 'json', path]);
  if (r.code !== 0) {
    const last = pySplitlines(pyStrip(r.stderr)).slice(-1);
    throw new TakeError(`take: ffprobe failed on ${path}: ${last.length ? `[${last.map(pyStrRepr).join(', ')}]` : ''}`);
  }
  const d = (JSON.parse(r.stdout || '{}') || {}) as { streams?: Array<Record<string, unknown>>; format?: Record<string, unknown> };
  const stream = (d.streams ?? [{}])[0] ?? {};
  const rate = String(stream.r_frame_rate || '30/1');
  const slash = rate.indexOf('/');
  const [numer, den] = slash >= 0 ? [rate.slice(0, slash), rate.slice(slash + 1)] : [rate, ''];
  const fps = pyFloat(numer)! / pyFloat(den || '1')!;
  const duration = pyFloat(String((d.format ?? {}).duration || 0)) ?? 0;
  return { fps: Number(pyFixed(fps, 3)), duration: Number(pyFixed(duration, 3)), width: Math.trunc(Number(stream.width || 0)), height: Math.trunc(Number(stream.height || 0)) };
}

interface Step {
  verb: string;
  label: string;
  extra: Record<string, unknown>;
}

// One flow line → the verb the toolkit knows, and the label a chapter can be hung on.
export function parseStep(line: string, kind: string, platform: string, override: string): Step {
  let words: string[];
  try {
    words = shlexSplit(line);
  } catch {
    words = pySplit(line);
  }
  const head = (words[0] ?? '').toLowerCase();
  const first = words[1] ?? '';
  const label = override || '';
  const extra: Record<string, unknown> = {};
  if (head === 'sleep') return { verb: 'sleep', label: '', extra };
  if (head === 'tap' || head === 'click' || head === 'longpress') return { verb: 'tap', label: label || first, extra };
  if (head === 'press') {
    // `press <key>` on the web is a keystroke; on a device it is a tap, by selector or by point.
    if (kind === 'web') return { verb: 'key', label: label || first, extra };
    return { verb: 'tap', label: label || (/^-?[\p{Nd}.]+$/u.test(first) ? '' : first), extra };
  }
  if (head === 'fill') return { verb: 'fill', label: label || first, extra };
  if (head === 'go') return { verb: 'go', label: first, extra };
  if (head === 'shot') {
    extra.file = `${kind === 'web' ? 'web' : platform}-${first}.png`;
    return { verb: 'shot', label: first, extra };
  }
  if (head === 'check' || head === 'viewport' || head === 'relaunch') return { verb: head, label: head === 'viewport' ? first : '', extra };
  return { verb: 'other', label, extra };
}

// « x y » from a device press, « x y w h » from a web box. Absent is an answer, not a failure.
function targetOf(raw: string): Record<string, number> | null {
  const nums: number[] = [];
  for (const p of pySplit(raw)) {
    const f = pyFloat(p);
    if (f === null || !Number.isFinite(f)) return null;
    nums.push(pyRound(f));
  }
  if (nums.length === 2) return { x: nums[0]!, y: nums[1]! };
  if (nums.length === 4) return { x: nums[0]!, y: nums[1]!, w: nums[2]!, h: nums[3]! };
  return null;
}

const pad = (n: number, w = 2): string => String(n).padStart(w, '0');

// datetime.fromtimestamp(t).astimezone().isoformat(timespec="milliseconds"): microseconds rounded
// half to even, then cut to milliseconds, with the local offset.
export function isoMillis(t: number): string {
  let sec = Math.trunc(t);
  let us = pyRound((t - sec) * 1e6);
  if (us >= 1e6) {
    us -= 1e6;
    sec += 1;
  } else if (us < 0) {
    us += 1e6;
    sec -= 1;
  }
  const d = new Date(sec * 1000);
  const off = -d.getTimezoneOffset();
  const a = Math.abs(off);
  return (
    `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}` +
    `.${pad(Math.floor(us / 1000), 3)}${off >= 0 ? '+' : '-'}${pad(Math.floor(a / 60))}:${pad(a % 60)}`
  );
}

export interface EventsArgs {
  dir: string;
  rows: string;
  clip: string;
  kind: 'mobile' | 'web';
  platform: string;
  tStop: number;
  scale?: number;
  viewport?: string;
}

// events.json written, and the line that says so.
export async function takeEvents(a: EventsArgs): Promise<string> {
  const { fps, duration, width: pxW, height: pxH } = await probe(join(a.dir, a.clip));
  // The recorder starts asynchronously — simctl, screenrecord and the browser all take an unknown
  // moment to write their first frame — while its end is an instant we hold: the call that stops it
  // has returned. The take is therefore anchored on that end, t0 walking back by the clip's own
  // duration. Steps that ran before the first frame keep the negative seconds that says so.
  const t0 = a.tStop - duration;
  let w: number;
  let h: number;
  let unit: string;
  if (a.viewport) {
    const parts = a.viewport.toLowerCase().split('x').map((v) => {
      const n = /^\s*[+-]?\d+\s*$/.test(v) ? Number(v) : NaN;
      if (Number.isNaN(n)) throw new TakeError(`take: --viewport wants WxH, got ${a.viewport}`);
      return n;
    });
    if (parts.length !== 2) throw new TakeError(`take: --viewport wants WxH, got ${a.viewport}`);
    [w, h] = parts as [number, number];
    unit = 'px';
  } else {
    const scale = a.scale || 1;
    w = pyRound(pxW / scale);
    h = pyRound(pxH / scale);
    unit = 'pt';
  }

  const steps: Array<Record<string, unknown>> = [];
  for (const raw of pySplitlines(readFileSync(a.rows, 'utf8'))) {
    if (!pyStrip(raw)) continue;
    const cells = raw.split('\t');
    while (cells.length < 7) cells.push('');
    const [i, start, end, ok, target, override, line] = cells as [string, string, string, string, string, string, string];
    const { verb, label, extra } = parseStep(line, a.kind, a.platform, override);
    const step: Record<string, unknown> = { i: Number(pyStrip(i)), line, verb };
    if (label) step.label = label;
    step.start = float(Number(pyFixed(pyFloat(start)! - t0, 2)));
    step.end = float(Number(pyFixed(pyFloat(end)! - t0, 2)));
    step.ok = ok !== 'false';
    Object.assign(step, extra);
    const box = targetOf(target);
    if (box) step.target = box;
    steps.push(step);
  }

  const events = {
    version: 1,
    kind: a.kind,
    platform: a.platform,
    clip: a.clip,
    fps: float(fps),
    duration: float(duration),
    size: { w, h, unit },
    t0: isoMillis(t0),
    steps,
  };
  writeFileSync(join(a.dir, 'events.json'), pyJson(events, { indent: 1, ascii: false }));
  return `events.json: ${steps.length} step(s) · clip ${a.clip} · ${pyFixed(duration, 1)} s @ ${pyG(fps)} fps · ${w}×${h} ${unit}`;
}

// A number as Python held it: an int stays an int through min() and round(), a float prints « .0 ».
interface Num {
  v: number;
  int: boolean;
}
const n = (x: unknown): Num => ({ v: num(x) ?? 0, int: typeof x === 'number' && Number.isInteger(x) });
const flt = (v: number): Num => ({ v, int: false });
const pyMax = (a: Num, b: Num): Num => (b.v > a.v ? b : a);
const pyMin = (a: Num, b: Num): Num => (b.v < a.v ? b : a);
const round2 = (x: Num): number | PyFloat => (x.int ? x.v : float(Number(pyFixed(x.v, 2))));

// motion.txt's timeline, in clip seconds: when the picture moved, and for how long.
function movements(path: string): Array<[number, number]> {
  if (!existsSync(path)) return [];
  const text = pySplitlines(readFileSync(path, 'utf8'));
  const head = /@\s*([\p{Nd}.]+)\s*fps/u.exec(text[0] ?? '');
  const fps = head ? pyFloat(head[1]!)! : 30;
  const spans: Array<[number, number]> = [];
  for (const raw of text) {
    const m = /^f(\p{Nd}+)[–-]f(\p{Nd}+):/u.exec(raw);
    if (m) spans.push([Number(m[1]) / fps, (Number(m[2]) + 1) / fps]);
  }
  return spans.sort((x, y) => x[0] - y[0] || x[1] - y[1]);
}

// The movement inside [lo, hi], dead time longer than DEAD_GAP dropped.
function clusters(spans: Array<[number, number]>, lo: number, hi: number): Array<[number, number]> {
  const out: Array<[number, number]> = [];
  for (const [a0, b0] of spans) {
    if (!(b0 > lo && a0 < hi)) continue;
    const a = Math.max(a0, lo);
    const b = Math.min(b0, hi);
    const last = out.at(-1);
    if (last && a - last[1] <= DEAD_GAP) last[1] = Math.max(last[1], b);
    else out.push([a, b]);
  }
  return out;
}

// The starting cut.json, as the text draft printed.
export function takeDraft(dir: string, take: string): string {
  const events = pyJsonParse(readFileSync(join(dir, 'events.json'), 'utf8')) as Record<string, unknown>;
  const duration = n(events.duration || 0);
  const spans = movements(join(dir, 'motion.txt'));
  let meta: Record<string, unknown> = {};
  try {
    meta = JSON.parse(readFileSync(join(dir, 'meta.json'), 'utf8')) as Record<string, unknown>;
  } catch {
    meta = {};
  }

  const segments = (lo0: Num, hi0: Num): Array<Record<string, unknown>> => {
    const lo = pyMax(flt(0), flt(lo0.v - LEAD_IN));
    const hi = pyMin(duration, hi0);
    const found = clusters(spans, lo.v, hi.v + DEAD_GAP);
    if (!found.length) return hi.v - lo.v >= 0.2 ? [{ from: round2(lo), to: round2(hi) }] : [];
    const out: Array<Record<string, unknown>> = [];
    for (const [a0, b0] of found) {
      const a = pyMax(lo, flt(a0 - LEAD_IN));
      const b = pyMin(duration, flt(b0 + SETTLE));
      if (b.v - a.v >= 0.2) out.push({ from: round2(a), to: round2(b) });
    }
    return out;
  };

  const steps = (Array.isArray(events.steps) ? events.steps : []) as Array<Record<string, unknown>>;
  const keep: Array<Record<string, unknown>> = [];
  let chapters: Array<Record<string, unknown>> = [];
  let pending: Array<Record<string, unknown>> = [];
  const flush = (): void => {
    if (pending.length) keep.push(...segments(n(pending[0]!.start), n(pending.at(-1)!.end)));
    pending = [];
  };
  for (const step of steps) {
    if (ACTIONS.includes(step.verb as string)) pending.push(step);
    else if (step.verb === 'sleep' && pending.length) pending.push(step);
    else if (step.verb === 'shot') {
      flush();
      const at = `shot:${String(step.label ?? '')}`;
      keep.push({ hold: at, seconds: HOLD });
      chapters.push({ at, kicker: '', title: '', body: '' });
    } else flush();
  }
  flush();
  if (!chapters.length) {
    chapters = steps.filter((s) => ACTIONS.includes(s.verb as string)).map((s) => ({ at: `step:${Math.trunc(num(s.i) ?? 0)}`, kicker: '', title: '', body: '' }));
  }

  const words = pyStrip(take.replace(/[-_]+/g, ' '));
  const title = words ? words[0]!.toUpperCase() + words.slice(1).toLowerCase() : '';
  const cfg = config();
  const cut = {
    version: 1,
    take,
    formats: ['landscape', 'portrait'],
    // The project's video theme, resolved by the engine: `.vysu/themes/<name>` first, then the
    // toolkit's own. Absent from the config, the neutral `default` theme is what renders.
    theme: cfg.get('THEME') || 'default',
    // The take's own language, then the project's, then English: the engine is neutral and a film
    // that says nothing about its language is not a French one.
    lang: (meta.lang as string) || cfg.get('LANG') || 'en',
    intro: { title, subtitle: '' },
    outro: { title: '', caption: '' },
    keep,
    chapters,
    taps: [],
  };
  return pyJson(cut, { indent: 1, ascii: false });
}

const EVENTS: ParserSpec = {
  prog: 'take events',
  usage: `usage: take events [-h] --dir DIR --rows ROWS --clip CLIP --kind
                   {mobile,web} --platform PLATFORM --t-stop T_STOP
                   [--scale SCALE] [--viewport VIEWPORT]`,
  pos: [],
  opts: {
    '--dir': { kind: 'str', required: true },
    '--rows': { kind: 'str', required: true },
    '--clip': { kind: 'str', required: true },
    '--kind': { kind: 'str', required: true, choices: ['mobile', 'web'] },
    '--platform': { kind: 'str', required: true },
    '--t-stop': { kind: 'float', required: true },
    '--scale': { kind: 'float', def: 0 },
    '--viewport': { kind: 'str', def: '' },
  },
};

const DRAFT: ParserSpec = {
  prog: 'take draft',
  usage: 'usage: take draft [-h] --dir DIR --take TAKE',
  pos: [],
  opts: { '--dir': { kind: 'str', required: true }, '--take': { kind: 'str', required: true } },
};

export async function main(argv: string[], io: Io): Promise<number> {
  const [command, ...rest] = argv;
  if (command !== 'events' && command !== 'draft') {
    const usage = 'usage: take [-h] {events,draft} ...';
    if (command === '-h' || command === '--help') {
      io.out(`${usage}\n`);
      return 0;
    }
    io.err(
      command === undefined
        ? `${usage}\ntake: error: the following arguments are required: command\n`
        : `${usage}\ntake: error: argument command: invalid choice: ${pyStrRepr(command)} (choose from 'events', 'draft')\n`,
    );
    return 2;
  }
  if (command === 'draft') {
    const a = parseArgs(DRAFT, rest, io);
    if (typeof a === 'number') return a;
    io.out(`${takeDraft(a.dir as string, a.take as string)}\n`);
    return 0;
  }
  const a = parseArgs(EVENTS, rest, io);
  if (typeof a === 'number') return a;
  try {
    io.out(
      `${await takeEvents({
        dir: a.dir as string,
        rows: a.rows as string,
        clip: a.clip as string,
        kind: a.kind as 'mobile' | 'web',
        platform: a.platform as string,
        tStop: a.t_stop as number,
        scale: a.scale as number,
        viewport: a.viewport as string,
      })}\n`,
    );
  } catch (e) {
    if (!(e instanceof TakeError)) throw e;
    io.err(`${e.message}\n`);
    return 1;
  }
  return 0;
}
