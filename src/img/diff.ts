// Where two screenshots differ, in text first: the changed zones, then the images if asked.
//
//   diff <baseline.png> <current.png> [--out diff.png] [--mark marked.png] [--threshold 0.1]
//        [--ignore x,y,w,h]... [--scale N] [--min-area 64] [--pad 24] [--json]
//
// A pixel counts as changed when its largest channel delta passes `--threshold` (0..1, the meaning
// agent-browser gives `diff screenshot --threshold`) *and* at least one of its eight neighbours
// changed too: font hinting repaints single pixels, a real change never does. `--ignore` blanks a
// region of both images beforehand (a relative timestamp, an avatar). Changed pixels are then
// clustered over an 8 px grid so the report names a handful of places instead of thousands of pixels.
//
// `--out` writes the classic red-on-dimmed diff; `--mark` writes the one image worth opening: the
// current screenshot with every zone boxed and numbered, cropped around them. `--scale` also gives
// the boxes in points/dp (3 on a 3x device). Exit: 0 identical or below threshold, 1 zones, 2 error.
import { parseArgs, type ParserSpec } from './args.ts';
import { float, osError, pyFixed, pyFloat, pyJson, pyPath, pyRoundTo } from './fmt.ts';
import { render } from './mark.ts';
import { readRgb, toChannels, writeImage, type Raster } from './raster.ts';
import type { Io } from './tools.ts';

// Clustering grid: fine enough to separate a button from its row, coarse enough to stay cheap.
const CELL = 8;
export const MAX_ZONES = 12;
const RED = [225, 29, 72]; // #e11d48, mark's colour

export interface Zone {
  x: number;
  y: number;
  w: number;
  h: number;
  px: number;
  ratio: number;
}

// [x0, y0, x1, y1), pixels left out of the comparison in both images.
export type Blank = [number, number, number, number];

// Changed pixels of the w×h top-left region both images share: largest channel delta past the
// threshold, and a changed neighbour (drops 1-px anti-aliasing noise).
export function changedMask(a: Raster, b: Raster, w: number, h: number, threshold: number, blanks: Blank[] = []): Uint8Array {
  const raw = new Uint8Array(w * h);
  const limit = threshold * 255;
  const ca = a.channels;
  const cb = b.channels;
  for (let y = 0; y < h; y++) {
    let pa = y * a.width * ca;
    let pb = y * b.width * cb;
    const row = y * w;
    for (let x = 0; x < w; x++, pa += ca, pb += cb) {
      const d0 = Math.abs(a.data[pa]! - b.data[pb]!);
      const d1 = Math.abs(a.data[pa + 1]! - b.data[pb + 1]!);
      const d2 = Math.abs(a.data[pa + 2]! - b.data[pb + 2]!);
      if (Math.max(d0, d1, d2) > limit) raw[row + x] = 1;
    }
  }
  for (const [x0, y0, x1, y1] of blanks) {
    for (let y = Math.max(0, y0); y < Math.min(h, y1); y++) raw.fill(0, y * w + Math.max(0, x0), y * w + Math.max(Math.max(0, x0), Math.min(w, x1)));
  }
  return denoise(raw, w, h);
}

// Keep only changed pixels that have a changed neighbour.
export function denoise(mask: Uint8Array, w: number, h: number): Uint8Array {
  const out = new Uint8Array(w * h);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const i = y * w + x;
      if (!mask[i]) continue;
      let any = false;
      for (let dy = -1; dy <= 1 && !any; dy++) {
        const ny = y + dy;
        if (ny < 0 || ny >= h) continue;
        for (let dx = -1; dx <= 1; dx++) {
          if (!dx && !dy) continue;
          const nx = x + dx;
          if (nx >= 0 && nx < w && mask[ny * w + nx]) {
            any = true;
            break;
          }
        }
      }
      if (any) out[i] = 1;
    }
  }
  return out;
}

// The box hugging the changed pixels inside a region (inclusive), plus how many there are.
function tighten(changed: Uint8Array, w: number, x0: number, y0: number, x1: number, y1: number): { box: number[]; count: number } | null {
  let count = 0;
  let bx0 = Infinity;
  let by0 = Infinity;
  let bx1 = -1;
  let by1 = -1;
  for (let y = y0; y <= y1; y++) {
    const row = y * w;
    for (let x = x0; x <= x1; x++) {
      if (!changed[row + x]) continue;
      count++;
      if (x < bx0) bx0 = x;
      if (x > bx1) bx1 = x;
      if (y < by0) by0 = y;
      by1 = y;
    }
  }
  return count ? { box: [bx0, by0, bx1, by1], count } : null;
}

// Bounding boxes [x0, y0, x1, y1] of the 4-connected groups of on-cells, in cell coordinates, in the
// order their first cell comes reading row by row.
function components(cells: Uint8Array, rows: number, cols: number): number[][] {
  const seen = new Uint8Array(rows * cols);
  const boxes: number[][] = [];
  for (let s = 0; s < cells.length; s++) {
    if (!cells[s] || seen[s]) continue;
    seen[s] = 1;
    let y0 = Math.floor(s / cols);
    let x0 = s % cols;
    let y1 = y0;
    let x1 = x0;
    const stack = [s];
    while (stack.length) {
      const i = stack.pop()!;
      const y = Math.floor(i / cols);
      const x = i % cols;
      if (y < y0) y0 = y;
      if (y > y1) y1 = y;
      if (x < x0) x0 = x;
      if (x > x1) x1 = x;
      const next: Array<[number, number]> = [
        [y - 1, x],
        [y + 1, x],
        [y, x - 1],
        [y, x + 1],
      ];
      for (const [ny, nx] of next) {
        if (ny < 0 || ny >= rows || nx < 0 || nx >= cols) continue;
        const n = ny * cols + nx;
        if (cells[n] && !seen[n]) {
          seen[n] = 1;
          stack.push(n);
        }
      }
    }
    boxes.push([x0, y0, x1, y1]);
  }
  return boxes;
}

// Fuse boxes separated by less than `pad` px of untouched picture, until nothing moves.
export function merge(input: number[][], pad: number): number[][] {
  let boxes = input;
  let moved = true;
  while (moved) {
    moved = false;
    const kept: number[][] = [];
    for (const box of boxes) {
      const other = kept.find((o) => box[0]! - pad <= o[2]! && box[2]! + pad >= o[0]! && box[1]! - pad <= o[3]! && box[3]! + pad >= o[1]!);
      if (other) {
        other[0] = Math.min(other[0]!, box[0]!);
        other[1] = Math.min(other[1]!, box[1]!);
        other[2] = Math.max(other[2]!, box[2]!);
        other[3] = Math.max(other[3]!, box[3]!);
        moved = true;
      } else kept.push([...box]);
    }
    boxes = kept;
  }
  return boxes;
}

// Changed pixels grouped into zones, biggest first.
export function zonesOf(changed: Uint8Array, width: number, height: number, pad: number, minArea: number): Zone[] {
  const rows = Math.ceil(height / CELL);
  const cols = Math.ceil(width / CELL);
  const cells = new Uint8Array(rows * cols);
  for (let y = 0; y < height; y++) {
    const r = Math.floor(y / CELL) * cols;
    for (let x = 0; x < width; x++) if (changed[y * width + x]) cells[r + Math.floor(x / CELL)] = 1;
  }
  const boxes: number[][] = [];
  for (const [x0, y0, x1, y1] of components(cells, rows, cols)) {
    // Cells are 8 px coarse: hug the changed pixels themselves so the box points precisely.
    const t = tighten(changed, width, x0! * CELL, y0! * CELL, Math.min((x1! + 1) * CELL, width) - 1, Math.min((y1! + 1) * CELL, height) - 1);
    if (t) boxes.push(t.box);
  }
  const found: Zone[] = [];
  for (const [x0, y0, x1, y1] of merge(boxes, pad)) {
    const t = tighten(changed, width, x0!, y0!, x1!, y1!)!;
    if (t.count < minArea) continue;
    const w = t.box[2]! - t.box[0]! + 1;
    const h = t.box[3]! - t.box[1]! + 1;
    found.push({ x: t.box[0]!, y: t.box[1]!, w, h, px: t.count, ratio: t.count / (w * h) });
  }
  return found.sort((a, b) => b.px - a.px);
}

export function parseRegion(spec: string): Blank | null {
  const parts = spec.split(',').map(pyFloat);
  if (parts.length !== 4 || parts.some((p) => p === null || !Number.isFinite(p))) return null;
  const [x, y, w, h] = parts.map((p) => Math.trunc(p!)) as [number, number, number, number];
  return [x, y, x + w, y + h];
}

export interface DiffOptions {
  out?: string | null;
  mark?: string | null;
  threshold?: number;
  ignore?: Blank[];
  minArea?: number;
  pad?: number;
}

export interface DiffResult {
  baseline: [number, number];
  current: [number, number];
  mismatch: boolean;
  width: number;
  height: number;
  changedPx: number;
  // Percent of the compared region.
  ratio: number;
  zones: Zone[];
  marked: string | null;
}

// The current screenshot at 35 % brightness with the changed pixels painted red.
function diffImage(current: Raster, changed: Uint8Array, w: number, h: number): Raster {
  const c = current.channels;
  const out = new Uint8Array(current.width * current.height * 3);
  for (let i = 0, j = 0; j < out.length; i += c, j += 3) {
    out[j] = Math.floor((current.data[i]! * 35) / 100);
    out[j + 1] = Math.floor((current.data[i + 1]! * 35) / 100);
    out[j + 2] = Math.floor((current.data[i + 2]! * 35) / 100);
  }
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      if (!changed[y * w + x]) continue;
      const j = (y * current.width + x) * 3;
      out[j] = RED[0]!;
      out[j + 1] = RED[1]!;
      out[j + 2] = RED[2]!;
    }
  }
  return { data: out, width: current.width, height: current.height, channels: 3 };
}

// The one image an agent should read: zones boxed and numbered on the current screenshot.
async function writeMark(current: Raster, zones: Zone[], pad: number, path: string): Promise<void> {
  const shapes = zones.map((z, i) => ({ kind: 'box' as const, v: [z.x, z.y, z.w, z.h], label: String(i + 1) }));
  const covered = zones.reduce((s, z) => s + z.w * z.h, 0) / (current.width * current.height);
  const im = await render(current, shapes, { grow: 4, dim: true, crop: covered <= 0.6 ? 'auto' : null, pad });
  await writeImage(toChannels(im, 3), path);
}

// Both images decoded: the comparison, and the files asked for.
export async function diffRasters(baseline: Raster, current: Raster, o: DiffOptions = {}): Promise<DiffResult> {
  const width = Math.min(baseline.width, current.width);
  const height = Math.min(baseline.height, current.height);
  const changed = changedMask(baseline, current, width, height, o.threshold ?? 0.1, o.ignore ?? []);
  let changedPx = 0;
  for (let i = 0; i < changed.length; i++) changedPx += changed[i]!;
  const zones = changedPx ? zonesOf(changed, width, height, o.pad ?? 24, o.minArea ?? 64) : [];
  let marked: string | null = null;
  if (zones.length) {
    if (o.out) await writeImage(diffImage(current, changed, width, height), o.out);
    if (o.mark) {
      await writeMark(current, zones.slice(0, MAX_ZONES), o.pad ?? 24, o.mark);
      marked = pyPath(o.mark);
    }
  }
  return {
    baseline: [baseline.width, baseline.height],
    current: [current.width, current.height],
    mismatch: baseline.width !== current.width || baseline.height !== current.height,
    width,
    height,
    changedPx,
    ratio: (100 * changedPx) / (width * height),
    zones,
    marked,
  };
}

export class DiffReadError extends Error {}

// Two files: the baseline read first, so its error is the one named when both fail.
export async function diff(baseline: string, current: string, o: DiffOptions = {}): Promise<DiffResult> {
  const [a, b] = await Promise.allSettled([readRgb(baseline), readRgb(current)]);
  if (a.status === 'rejected') throw new DiffReadError(osError(a.reason, baseline));
  if (b.status === 'rejected') throw new DiffReadError(osError(b.reason, current));
  return diffRasters(a.value, b.value, o);
}

const fmtBox = (z: Zone, scale: number): string =>
  `x ${z.x} y ${z.y} w ${z.w} h ${z.h} px` +
  (scale ? ` = x ${pyFixed(z.x / scale, 0)} y ${pyFixed(z.y / scale, 0)} w ${pyFixed(z.w / scale, 0)} h ${pyFixed(z.h / scale, 0)} pt` : '');

// The text report and its exit code: 0 identical or below threshold, 1 zones.
export function diffReport(r: DiffResult, scale = 0): { text: string; code: number } {
  const lines: string[] = [];
  if (r.mismatch) {
    lines.push(`size mismatch: baseline ${r.baseline[0]}x${r.baseline[1]}, current ${r.current[0]}x${r.current[1]} — compared on ${r.width}x${r.height}`);
  }
  if (!r.changedPx) return { text: `${[...lines, 'identical'].join('\n')}\n`, code: 0 };
  if (!r.zones.length) return { text: `${[...lines, `changed ${pyFixed(r.ratio, 1)} % · below threshold`].join('\n')}\n`, code: 0 };
  const shown = r.zones.slice(0, MAX_ZONES);
  lines.push(`changed ${pyFixed(r.ratio, 1)} % (${r.changedPx} px) · ${r.zones.length} zone${r.zones.length > 1 ? 's' : ''}`);
  shown.forEach((z, i) => lines.push(`${i + 1}. ${fmtBox(z, scale)}  (${pyFixed(z.ratio * 100, 0)} % of the zone)`));
  if (r.zones.length > shown.length) lines.push(`… and ${r.zones.length - shown.length} more`);
  if (r.marked) lines.push(`marked: ${r.marked}`);
  return { text: `${lines.join('\n')}\n`, code: 1 };
}

export function diffJson(r: DiffResult): string {
  return pyJson({
    changed_ratio: float(pyRoundTo(r.ratio / 100, 6)),
    changed_px: r.changedPx,
    zones: r.zones.slice(0, MAX_ZONES).map((z) => ({ x: z.x, y: z.y, w: z.w, h: z.h, ratio: float(pyRoundTo(z.ratio, 4)) })),
    size_mismatch: r.mismatch,
    marked: r.marked,
  });
}

const SPEC: ParserSpec = {
  prog: 'diff',
  usage: `usage: diff [-h] [--out OUT] [--mark MARKED] [--threshold THRESHOLD]
            [--ignore x,y,w,h] [--scale SCALE] [--min-area MIN_AREA]
            [--pad PAD] [--json]
            baseline current`,
  pos: [{ name: 'baseline' }, { name: 'current' }],
  opts: {
    '--out': { kind: 'str' },
    '--mark': { kind: 'str', dest: 'marked' },
    '--threshold': { kind: 'float', def: 0.1 },
    '--ignore': { kind: 'append' },
    '--scale': { kind: 'float', def: 0 },
    '--min-area': { kind: 'int', def: 64 },
    '--pad': { kind: 'int', def: 24 },
    '--json': { kind: 'flag' },
  },
};

export async function main(argv: string[], io: Io): Promise<number> {
  const a = parseArgs(SPEC, argv, io);
  if (typeof a === 'number') return a;
  let baseline: Raster;
  let current: Raster;
  try {
    baseline = await readRgb(a.baseline as string);
  } catch (e) {
    io.err(`diff: ${osError(e, a.baseline as string)}\n`);
    return 2;
  }
  try {
    current = await readRgb(a.current as string);
  } catch (e) {
    io.err(`diff: ${osError(e, a.current as string)}\n`);
    return 2;
  }
  const ignore: Blank[] = [];
  for (const spec of a.ignore as string[]) {
    const r = parseRegion(spec);
    if (!r) {
      io.err(`diff: --ignore wants x,y,w,h, got ${spec}\n`);
      return 2;
    }
    ignore.push(r);
  }
  const r = await diffRasters(baseline, current, {
    out: a.out as string | null,
    mark: a.marked as string | null,
    threshold: a.threshold as number,
    ignore,
    minArea: a.min_area as number,
    pad: a.pad as number,
  });
  if (a.json) {
    io.out(`${diffJson(r)}\n`);
    return r.zones.length ? 1 : 0;
  }
  const { text, code } = diffReport(r, a.scale as number);
  io.out(text);
  return code;
}
