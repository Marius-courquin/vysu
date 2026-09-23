// The text fields of a mobile screen, read from the picture rather than from the tree.
//
//   fields <screenshot.png> [--scale N] [--json] [--min-width 0.5] [--min-height 36]
//          [--max-height 72] [--edge 10]
//
// A login form inside a system web surface — SafariViewService on iOS 18, a Chrome Custom Tab — is
// invisible to the platform's accessibility, and a connector that cannot read it used to tap at
// constants ("the e-mail sits at 57 % of the height"). This finds the boxes instead: a text field is a
// rounded rectangle with a continuous border, wider than half the screen, 36 to 72 pt tall, light
// inside. Boxes come back top to bottom, in points — `--scale` is the pixels per point of the capture
// (1 for what `vysu mshot` writes, which is already 1x).
//
// Plain output is one `x,y,w,h` per line, the spelling `vysu box` and `vysu mark` use; `--json` is the
// array of `{x, y, w, h}` objects `mob_fields` hands a connector. Exit: 0 with boxes, 1 with none, 2 on
// an error.
import { pyRound } from '../core/py.ts';
import { parseArgs, type ParserSpec } from './args.ts';
import { osError, pyJson } from './fmt.ts';
import { std64, sum64 } from './np.ts';
import { readRgb, toGray } from './raster.ts';
import type { Io } from './tools.ts';

export interface FieldBox {
  x: number;
  y: number;
  w: number;
  h: number;
}

export interface FieldsOptions {
  scale?: number;
  minWidth?: number;
  minHeight?: number;
  maxHeight?: number;
  edge?: number;
}

interface Gray {
  g: Uint8Array;
  w: number;
  h: number;
}

// Rows that hold a horizontal line: a run of columns differing from the row above. Per candidate row
// the (x0, x1) of its longest such run. A 2 px border answers on both of its rows; the caller keeps
// the first of each streak.
function borderRows({ g, w, h }: Gray, edge: number, minRun: number): Map<number, [number, number]> {
  const rows = new Map<number, [number, number]>();
  for (let y = 0; y < h - 1; y++) {
    let count = 0;
    let best: [number, number] | null = null;
    let runStart = -1;
    let last = -2;
    const close = (): void => {
      if (runStart >= 0 && (best === null || last - runStart > best[1] - best[0])) best = [runStart, last];
    };
    for (let x = 0, p = y * w; x < w; x++, p++) {
      if (Math.abs(g[p + w]! - g[p]!) <= edge) continue;
      count++;
      // The longest contiguous run of edge columns: a rounded corner leaves the first and last few
      // columns out, a background gradient leaves gaps everywhere.
      if (x !== last + 1) {
        close();
        runStart = x;
      }
      last = x;
    }
    close();
    if (count < minRun) continue;
    const b = best as [number, number] | null;
    if (b && b[1] - b[0] + 1 >= minRun) rows.set(y, b);
  }
  return rows;
}

// One representative per streak of consecutive border rows, widest run first.
function streaks(rows: Map<number, [number, number]>): number[] {
  const kept: number[] = [];
  let streak: number[] = [];
  const widest = (s: number[]): number => s.reduce((a, b) => (rows.get(b)![1] - rows.get(b)![0] > rows.get(a)![1] - rows.get(a)![0] ? b : a));
  for (const y of [...rows.keys()].sort((a, b) => a - b)) {
    if (streak.length && y === streak.at(-1)! + 1) {
      streak.push(y);
      continue;
    }
    if (streak.length) kept.push(widest(streak));
    streak = [y];
  }
  if (streak.length) kept.push(widest(streak));
  return kept;
}

// gray[y0:y1, x0:x1] with Python's slice clamping, as a contiguous float64 copy.
function region({ g, w, h }: Gray, y0: number, y1: number, x0: number, x1: number): Float64Array {
  const c = (v: number, n: number): number => (v < 0 ? Math.max(0, n + v) : Math.min(v, n));
  const [ya, yb, xa, xb] = [c(y0, h), c(y1, h), c(x0, w), c(x1, w)];
  if (yb <= ya || xb <= xa) return new Float64Array(0);
  const out = new Float64Array((yb - ya) * (xb - xa));
  let k = 0;
  for (let y = ya; y < yb; y++) for (let x = xa; x < xb; x++) out[k++] = g[y * w + x]!;
  return out;
}

// A field's interior: light and even. A button, an image or a block of text is neither.
function lightInside(gray: Gray, top: number, bottom: number, x0: number, x1: number): boolean {
  const inner = region(gray, top + 3, bottom - 2, x0 + 4, x1 - 3);
  if (!inner.length) return false;
  const mean = sum64(inner) / inner.length;
  return mean > 170 && std64(inner, mean) < 42;
}

// Both sides carry a vertical border, which is what makes the rectangle a box. Two horizontal lines
// with whitespace between them — the gap under a field, the room above a button — otherwise read as
// a field twice as often as a field does. The border is looked for a few pixels out from the ends of
// the horizontal run, since a rounded corner cuts that run short.
function closedSides(gray: Gray, top: number, bottom: number, x0: number, x1: number, edge: number): boolean {
  const inner = region(gray, top + 3, bottom - 2, x0 + 4, x1 - 3);
  const r0 = top + 4;
  const r1 = bottom - 3;
  if (!inner.length || r0 >= r1) return false;
  const level = sum64(inner) / inner.length;
  for (let [lo, hi] of [
    [x0 - 14, x0 + 5],
    [x1 - 4, x1 + 15],
  ] as Array<[number, number]>) {
    lo = Math.max(lo, 0);
    hi = Math.min(hi, gray.w);
    if (lo >= hi) return false;
    const ya = Math.min(Math.max(0, r0), gray.h);
    const yb = Math.min(r1, gray.h);
    if (yb <= ya) return false;
    let best = 0;
    for (let x = lo; x < hi; x++) {
      let dark = 0;
      for (let y = ya; y < yb; y++) if (gray.g[y * gray.w + x]! < level - edge) dark++;
      best = Math.max(best, dark / (yb - ya));
    }
    if (best < 0.6) return false;
  }
  return true;
}

export function findFields(gray: Gray, o: FieldsOptions = {}): FieldBox[] {
  const scale = o.scale ?? 1;
  const minHeight = o.minHeight ?? 36;
  const maxHeight = o.maxHeight ?? 72;
  const edge = o.edge ?? 10;
  const minRun = Math.trunc(gray.w * (o.minWidth ?? 0.5));
  const rows = borderRows(gray, edge, minRun);
  const candidates = streaks(rows);
  const boxes: Array<[number, number, number, number]> = [];
  candidates.forEach((top, i) => {
    const [x0, x1] = rows.get(top)!;
    for (const bottom of candidates.slice(i + 1)) {
      const span = bottom - top;
      if (span < minHeight * scale) continue;
      if (span > maxHeight * scale) break;
      const [bx0, bx1] = rows.get(bottom)!;
      // The same rectangle: both borders start and end together, give or take a corner.
      if (Math.abs(bx0 - x0) > gray.w * 0.05 || Math.abs(bx1 - x1) > gray.w * 0.05) continue;
      if (!lightInside(gray, top, bottom, x0, x1)) continue;
      if (!closedSides(gray, top, bottom, x0, x1, edge)) continue;
      boxes.push([x0, top, x1 - x0 + 1, span + 1]);
      break;
    }
  });
  // A field found twice is one field: its border answered on two rows a pixel apart, or a line above
  // it paired with its own bottom and wrapped it. The inner box is the field itself.
  const unique: Array<[number, number, number, number]> = [];
  for (const box of [...boxes].sort((a, b) => a[1] - b[1] || b[3] - a[3])) {
    const last = unique.at(-1);
    if (last) {
      const overlap = Math.min(last[1] + last[3], box[1] + box[3]) - Math.max(last[1], box[1]);
      if (Math.abs(last[1] - box[1]) <= 4 || overlap > 0.5 * Math.min(last[3], box[3])) {
        if (box[3] < last[3]) unique[unique.length - 1] = box;
        continue;
      }
    }
    unique.push(box);
  }
  return unique.map(([x, y, w, h]) => ({ x: pyRound(x / scale), y: pyRound(y / scale), w: pyRound(w / scale), h: pyRound(h / scale) }));
}

export async function fields(image: string, o: FieldsOptions = {}): Promise<FieldBox[]> {
  const im = await readRgb(image);
  return findFields({ g: toGray(im), w: im.width, h: im.height }, o);
}

const SPEC: ParserSpec = {
  prog: 'fields',
  usage: `usage: fields [-h] [--scale SCALE] [--json] [--min-width MIN_WIDTH]
              [--min-height MIN_HEIGHT] [--max-height MAX_HEIGHT]
              [--edge EDGE]
              image`,
  pos: [{ name: 'image' }],
  opts: {
    '--scale': { kind: 'float', def: 1 },
    '--json': { kind: 'flag' },
    '--min-width': { kind: 'float', def: 0.5 },
    '--min-height': { kind: 'float', def: 36 },
    '--max-height': { kind: 'float', def: 72 },
    '--edge': { kind: 'float', def: 10 },
  },
};

export async function main(argv: string[], io: Io): Promise<number> {
  const a = parseArgs(SPEC, argv, io);
  if (typeof a === 'number') return a;
  let boxes: FieldBox[];
  try {
    boxes = await fields(a.image as string, {
      scale: a.scale as number,
      minWidth: a.min_width as number,
      minHeight: a.min_height as number,
      maxHeight: a.max_height as number,
      edge: a.edge as number,
    });
  } catch (e) {
    io.err(`fields: ${osError(e, a.image as string)}\n`);
    return 1;
  }
  if (a.json) io.out(`${pyJson(boxes)}\n`);
  else for (const b of boxes) io.out(`${b.x},${b.y},${b.w},${b.h}\n`);
  return boxes.length ? 0 : 1;
}
