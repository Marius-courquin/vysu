// One tall image out of the captures of a scrolling mobile screen (vysu mshot --full).
//
//   stitch <frames-dir | f00.png f01.png …> --out <tall.png> [--top N] [--bottom N] [--json]
//
// agent-device captures the viewport of a native app, never the page: a long screen comes back as a
// sequence of captures taken while scrolling, each one carrying the same fixed chrome (status bar +
// top bar, and often a tab bar or a CTA at the bottom). This puts them back together.
//
// The fixed bands are found, not configured: the leading rows that are identical across *all* the
// captures are the top band, the trailing ones the bottom band; `--top`/`--bottom` (px) override the
// detection when the content itself happens to repeat. Between two captures the overlap gives the
// scroll offset — the last rows of one located in the next, coarse then refined at full resolution,
// then every surviving candidate re-judged on the whole shared region: a list of same-height rows
// matches at every multiple of its row period, and only the full overlap separates the true offset
// from its harmonics. Real ties are that period, so the smallest offset wins — it skips no content.
// An offset of zero, or no plausible match at all, means the scroller had already hit the end: the
// capture is a duplicate and gets dropped. A region with nothing in it (a blank stretch) matches
// everywhere, so there the largest plausible offset wins and the line says `ambiguous`.
//
// Output is one PNG at 1x: the top band once, every capture's new rows, the bottom band once.
// Exit: 0 stitched, 2 error (no capture, mismatched widths).
import { mkdirSync, readdirSync, statSync } from 'node:fs';
import { basename, dirname, join } from 'node:path';
import { parseArgs, type ParserSpec } from './args.ts';
import { byCodePoint, osError, pyJson, pyPath } from './fmt.ts';
import { std64, sum64, sumRows } from './np.ts';
import { readRgb, writeImage, type Raster } from './raster.ts';
import type { Io } from './tools.ts';

const BAND_DELTA = 8; // max channel delta for two pixels of a fixed band to count as the same
const BAND_RATIO = 0.995; // … on this share of the row, the rest being a spinner or an antialiased glyph
const TAIL = 120; // rows of capture i looked up in capture i+1
const TAIL_FRACTION = 0.25; // … unless the scrolling region is short, then a quarter of it
const MIN_OVERLAP = 24; // a long scroll leaves less than the tail in common: still enough rows to judge
const DOWN = 4; // coarse search: every 4th row and column, then full resolution around the candidates
const MATCH_MAX = 0.05; // mean abs luma delta (0..1) above which the two captures share nothing
// A tail score is sampled evidence: everything within this much of the best stays a candidate for the
// full-overlap judgement, which is the one that decides.
const CANDIDATE_RATIO = 2;
// Two offsets tie on the full overlap when their scores are this close: the ratio leaves room for a
// match softened by resampling, the floor for a pixel-exact one, whose score is 0 and would otherwise
// tie with nothing else. Wider than this and a harmonic of a repeating list — visibly worse, just not
// by much — passes for the real offset.
const MATCH_RATIO = 1.05;
const MATCH_FLOOR = 1e-4;
const COARSE_SLACK = 0.01; // a coarse score is a sampled one: refine every candidate this close to the best
const DUP_MAX = 0.002; // mean abs luma delta over the whole region: under it the captures are one picture
const DETAIL_MIN = 2.0; // levels of standard deviation under which a strip is blank, so it proves nothing

export class StitchError extends Error {}

// (top, bottom): leading and trailing rows identical across every capture.
export function bands(frames: Raster[]): [number, number] {
  const { width: w, height: h } = frames[0]!;
  const f0 = frames[0]!.data;
  const fixed: boolean[] = [];
  for (let y = 0; y < h; y++) {
    let worst = 1;
    for (const f of frames) {
      let same = 0;
      for (let x = 0, p = y * w * 3; x < w; x++, p += 3) {
        const d = Math.max(Math.abs(f.data[p]! - f0[p]!), Math.abs(f.data[p + 1]! - f0[p + 1]!), Math.abs(f.data[p + 2]! - f0[p + 2]!));
        if (d <= BAND_DELTA) same++;
      }
      worst = Math.min(worst, same / w);
    }
    fixed.push(worst >= BAND_RATIO);
  }
  if (fixed.every(Boolean)) return [h, 0];
  const top = fixed.indexOf(false);
  const bottom = [...fixed].reverse().indexOf(false);
  return [top, bottom];
}

interface Region {
  rows: number;
  width: number;
  v: Float64Array;
}

function luma(f: Raster, top: number, bottom: number): Region {
  const rows = Math.max(0, f.height - bottom - top);
  const v = new Float64Array(rows * f.width);
  for (let i = 0, p = top * f.width * 3; i < v.length; i++, p += 3) v[i] = f.data[p]! * 0.299 + f.data[p + 1]! * 0.587 + f.data[p + 2]! * 0.114;
  return { rows, width: f.width, v };
}

// (score, detail) of the tail of a at that offset: mean abs delta (0..1), and how textured it is.
// Past `rows - tailRows` the tail no longer fits in b, and only the part still shared is compared: a
// long scroll leaves a thin overlap, which is exactly the case that has to be measurable.
function scoreAt(a: Region, b: Region, offset: number, tailRows: number, step = 1): [number, number] {
  const { rows, width: w } = a;
  const start = Math.max(rows - tailRows, offset);
  const ys: number[] = [];
  for (let y = start; y < rows; y += step) ys.push(y);
  const wc = Math.ceil(w / step);
  const d = new Float64Array(ys.length * wc);
  let k = 0;
  for (const y of ys) {
    const pa = y * w;
    const pb = (y - offset) * w;
    for (let x = 0; x < w; x += step) d[k++] = Math.abs(a.v[pa + x]! - b.v[pb + x]!);
  }
  const score = sum64(d) / d.length / 255;
  // a[start::step].std(): all the columns of those rows.
  const n = ys.length * w;
  const mean = (step === 1 ? sum64(a.v, start * w, n) : sumRows(a.v, ys.map((y) => y * w), w)) / n;
  const values = new Float64Array(n);
  ys.forEach((y, i) => values.set(a.v.subarray(y * w, y * w + w), i * w));
  return [score, std64(values, mean)];
}

// (offsets that tie for best, their scores, whether the evidence is blank). Flat strips prove
// nothing, so texture decides first: when some candidates land on textured pixels only those are
// judged, and when none does the match is blank and says nothing at all.
function resolve(scores: Map<number, [number, number]>, ratio: number): { tied: number[]; considered: Map<number, number>; blank: boolean } {
  const textured = new Map<number, number>();
  for (const [d, [score, detail]] of scores) if (detail >= DETAIL_MIN) textured.set(d, score);
  const considered = textured.size ? textured : new Map([...scores].map(([d, [s]]) => [d, s] as [number, number]));
  const best = Math.min(...considered.values());
  const tie = best * ratio + MATCH_FLOOR;
  const tied = [...considered].filter(([, s]) => s <= tie).map(([d]) => d).sort((x, y) => x - y);
  return { tied, considered, blank: !textured.size };
}

// (offset, score, ambiguous): how far the content of b has scrolled past a.
export function offsetBetween(a: Region, b: Region): [number, number, boolean] {
  const { rows } = a;
  const all = new Float64Array(a.v.length);
  for (let i = 0; i < all.length; i++) all[i] = Math.abs(a.v[i]! - b.v[i]!);
  if (sum64(all) / all.length / 255 <= DUP_MAX) return [0, 0, false];
  const tailRows = Math.min(TAIL, Math.max(8, Math.trunc(rows * TAIL_FRACTION)));
  const limit = rows - MIN_OVERLAP;
  if (limit <= 0) return [0, 1, false];
  const coarse = new Map<number, [number, number]>();
  for (let d = 0; d <= limit; d += DOWN) coarse.set(d, scoreAt(a, b, d, tailRows, DOWN));
  const bestCoarse = Math.min(...[...coarse.values()].map(([s]) => s));
  const scores = new Map<number, [number, number]>();
  for (const [d, [s]] of coarse) {
    if (s > bestCoarse + COARSE_SLACK) continue;
    for (let fine = Math.max(0, d - DOWN + 1); fine <= Math.min(limit, d + DOWN - 1); fine++) {
      if (!scores.has(fine)) scores.set(fine, scoreAt(a, b, fine, tailRows));
    }
  }
  // The tail only nominates: on a list of same-height rows it matches at every multiple of the row
  // period, and a blank tail matches wherever it lands. Re-judge every nominee on the whole shared
  // region at full resolution — all the evidence there is — and take the best outright.
  const candidates = resolve(scores, CANDIDATE_RATIO).tied;
  const { tied, considered, blank } = resolve(new Map(candidates.map((d) => [d, scoreAt(a, b, d, rows)])), MATCH_RATIO);
  // A remaining tie on textured pixels is that row period: the smallest offset wins, it is the one
  // that skips no content. Blank pixels prove nothing, so there the longest stitch is the better
  // guess and the line says so.
  const chosen = blank ? tied.at(-1)! : tied[0]!;
  return [chosen, considered.get(chosen)!, blank && tied.at(-1)! - tied[0]! > 1];
}

// The tall image: top band, then every kept capture's new rows, then the bottom band.
function compose(frames: Raster[], kept: Array<[number, number]>, top: number, bottom: number): Raster {
  const { width: w, height: h } = frames[0]!;
  const rows = h - top - bottom;
  const total = top + rows + kept.slice(1).reduce((s, [, o]) => s + o, 0) + bottom;
  const out = new Uint8Array(total * w * 3);
  const row = w * 3;
  const first = frames[kept[0]![0]]!.data;
  out.set(first.subarray(0, (top + rows) * row), 0);
  let cursor = top + rows;
  for (const [index, offset] of kept.slice(1)) {
    out.set(frames[index]!.data.subarray((h - bottom - offset) * row, (h - bottom) * row), cursor * row);
    cursor += offset;
  }
  out.set(frames[kept.at(-1)![0]]!.data.subarray((h - bottom) * row, h * row), cursor * row);
  return { data: out, width: w, height: total, channels: 3 };
}

export interface StitchResult {
  out: string;
  width: number;
  height: number;
  top: number;
  bottom: number;
  captures: number;
  used: number;
  offsets: number[];
  dropped: string[];
  ambiguous: number;
  // One per capture after the first: « f02 +312 px », « f03 duplicate of f02, dropped ».
  lines: string[];
}

// The captures of a frames folder, in name order.
export function framePaths(given: string[]): string[] {
  if (given.length === 1) {
    let dir = false;
    try {
      dir = statSync(given[0]!).isDirectory();
    } catch {
      dir = false;
    }
    if (dir) return readdirSync(given[0]!).filter((f) => f.endsWith('.png')).sort(byCodePoint).map((f) => join(given[0]!, f));
  }
  return given;
}

export async function stitch(paths: string[], out: string, o: { top?: number | null; bottom?: number | null } = {}): Promise<StitchResult> {
  if (!paths.length) throw new StitchError('stitch: no capture');
  const frames: Raster[] = [];
  for (const p of paths) {
    try {
      frames.push(await readRgb(p));
    } catch (e) {
      throw new StitchError(`stitch: ${osError(e, p)}`);
    }
  }
  const names = paths.map((p) => basename(p).replace(/\.[^.]*$/, ''));
  const { width, height } = frames[0]!;
  frames.forEach((f, i) => {
    if (f.width !== width || f.height !== height) throw new StitchError(`stitch: ${names[i]} is ${f.width}x${f.height}, expected ${width}x${height}`);
  });

  let [top, bottom] = frames.length === 1 ? [height, 0] : bands(frames);
  if (o.top !== undefined && o.top !== null) top = o.top;
  if (o.bottom !== undefined && o.bottom !== null) bottom = o.bottom;
  // Everything repeats: nothing scrolled, so the first capture is already the whole picture.
  if (top + bottom >= height) [top, bottom] = [height, 0];

  const regions = frames.map((f) => luma(f, top, bottom));
  const kept: Array<[number, number]> = [[0, 0]]; // (capture index, new rows it brings)
  const dropped: string[] = [];
  const lines: string[] = [];
  let ambiguities = 0;
  for (let index = 1; index < frames.length; index++) {
    const previous = kept.at(-1)![0];
    const [offset, quality, ambiguous] = top >= height ? [0, 1, false] : offsetBetween(regions[previous]!, regions[index]!);
    if (offset === 0 || quality > MATCH_MAX) {
      dropped.push(names[index]!);
      lines.push(`${names[index]} duplicate of ${names[previous]}, dropped`);
      continue;
    }
    kept.push([index, offset]);
    if (ambiguous) ambiguities++;
    lines.push(`${names[index]} +${offset} px${ambiguous ? ' · ambiguous' : ''}`);
  }
  const tall = compose(frames, kept, top, bottom);
  mkdirSync(dirname(out), { recursive: true });
  await writeImage(tall, out);
  return {
    out: pyPath(out),
    width: tall.width,
    height: tall.height,
    top,
    bottom,
    captures: frames.length,
    used: kept.length,
    offsets: kept.slice(1).map(([, o]) => o),
    dropped,
    ambiguous: ambiguities,
    lines,
  };
}

export function stitchReport(r: StitchResult): string {
  const plural = r.captures > 1 ? 's' : '';
  return [`top ${r.top} px · bottom ${r.bottom} px`, ...r.lines, `${r.out} ${r.width}x${r.height} · ${r.captures} capture${plural}, ${r.used} used`].join('\n') + '\n';
}

export function stitchJson(r: StitchResult): string {
  return pyJson({
    out: r.out,
    width: r.width,
    height: r.height,
    top: r.top,
    bottom: r.bottom,
    captures: r.captures,
    used: r.used,
    offsets: r.offsets,
    dropped: r.dropped,
    ambiguous: r.ambiguous,
  });
}

const SPEC: ParserSpec = {
  prog: 'stitch',
  usage: `usage: stitch [-h] --out OUT [--top TOP] [--bottom BOTTOM] [--json]
              frames [frames ...]`,
  pos: [{ name: 'frames', nargs: '+' }],
  opts: {
    '--out': { kind: 'str', required: true },
    '--top': { kind: 'int' },
    '--bottom': { kind: 'int' },
    '--json': { kind: 'flag' },
  },
};

export async function main(argv: string[], io: Io): Promise<number> {
  const a = parseArgs(SPEC, argv, io);
  if (typeof a === 'number') return a;
  let r: StitchResult;
  try {
    r = await stitch(framePaths(a.frames as string[]), a.out as string, { top: a.top as number | null, bottom: a.bottom as number | null });
  } catch (e) {
    if (!(e instanceof StitchError)) throw e;
    io.err(`${e.message}\n`);
    return 2;
  }
  io.out(a.json ? `${stitchJson(r)}\n` : stitchReport(r));
  return 0;
}
