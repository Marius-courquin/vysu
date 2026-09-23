// A burst of screenshots read back as the few frames that differ (vysu mburst).
//
//   burst <raw-dir> --out-dir <dir> --platform ios|android [--scale 3] [--threshold 0.1]
//         [--min-area 64] [--band 44] [--edge 1568] [--max-thumbs 12]
//
// <raw-dir> holds the device-pixel captures (000.png, 001.png…) and times.tsv (index, start, end:
// epoch seconds of each capture). Each frame is brought down to 1x (points / dp: what every other vysu
// capture is in), then compared with the last frame kept, through diff's own rule (a pixel counts when
// a channel moves past --threshold and a neighbour moved too, and a change needs a zone of --min-area
// pixels), so « near-identical » means here exactly what diff's exit 0 means. The status-bar band
// (--band pt at the top) is left out of that comparison: its clock and battery move on a still screen.
//
// Writes <platform>-burst-NN.png for every distinct frame (NN = its index in the burst, so the text
// line and the files name the same frame), <platform>-burst-strip.png (one row, no wider than --edge,
// each frame labelled with its index and time), and prints one line:
//
//     burst: 14 frames in 3.0s, 4 distinct · 00 0.0s · 03 0.9s (38 % changed) · 05 1.5s (12 %)
//
// then the strip's path. Exit 0; 2 on a read error.
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync } from 'node:fs';
import { join } from 'node:path';
import sharp, { type OverlayOptions } from 'sharp';
import { pyRound } from '../core/py.ts';
import { parseArgs, type ParserSpec } from './args.ts';
import { changedMask, zonesOf } from './diff.ts';
import { pyFixed, pyFloat, pyPath, pySplitlines } from './fmt.ts';
import { resizeAsync } from './pool.ts';
import { readRgb, resizeFast, sharpOf, writeImage, type Raster } from './raster.ts';
import { measure, svgText } from './text.ts';
import type { Io } from './tools.ts';

const GAP = 8; // px between two thumbnails of the strip
const LABEL_H = 22; // px of label band under each thumbnail
const BG = '#18181b';
const FG = '#f4f4f5';

// index → capture midpoint (epoch s): a capture shows the screen somewhere inside its call.
function readTimes(raw: string): Map<number, number> {
  const times = new Map<number, number>();
  const path = join(raw, 'times.tsv');
  if (!existsSync(path)) return times;
  for (const line of pySplitlines(readFileSync(path, 'utf8'))) {
    const parts = line.split('\t');
    if (parts.length < 3) continue;
    const i = /^\s*[+-]?\d+\s*$/.test(parts[0]!) ? Number(parts[0]) : null;
    const a = pyFloat(parts[1]!);
    const b = pyFloat(parts[2]!);
    if (i === null || a === null || b === null) continue;
    times.set(i, (a + b) / 2);
  }
  return times;
}

const sameRaster = (a: Raster, b: Raster): boolean =>
  a.width === b.width && a.height === b.height && a.channels === b.channels && Buffer.from(a.data.buffer, a.data.byteOffset, a.data.length).equals(b.data);

const to1x = (im: Raster, scale: number): Promise<Raster> =>
  scale <= 1 ? Promise.resolve(im) : resizeAsync(im, Math.max(1, pyRound(im.width / scale)), Math.max(1, pyRound(im.height / scale)));

// (distinct?, changed share of the picture) under diff's rule, the status band left out.
export function changed(before: Raster, after: Raster, threshold: number, minArea: number, band: number): [boolean, number] {
  const w = Math.min(before.width, after.width);
  const h = Math.min(before.height, after.height);
  const mask = changedMask(before, after, w, h, threshold, band ? [[0, 0, w, band]] : []);
  let px = 0;
  for (let i = 0; i < mask.length; i++) px += mask[i]!;
  if (!px) return [false, 0];
  return [zonesOf(mask, w, h, 24, minArea).length > 0, px / (w * h)];
}

// One row of thumbnails, each labelled, the whole row no wider than `edge`.
async function strip(frames: Raster[], labels: string[], edge: number, out: string): Promise<void> {
  const n = frames.length;
  const { width: fw, height: fh } = frames[0]!;
  const width = Math.min(fw, Math.floor((edge - GAP * (n + 1)) / n));
  const height = pyRound((fh * width) / fw);
  const size = Math.max(11, Math.min(15, Math.floor(width / 9)));
  const W = GAP + n * (width + GAP);
  const H = GAP + height + LABEL_H + Math.floor(GAP / 2);
  const layers: OverlayOptions[] = [];
  const text: string[] = [];
  for (let i = 0; i < n; i++) {
    const x = GAP + i * (width + GAP);
    const thumb = await resizeFast(frames[i]!, width, height);
    layers.push({ input: await sharpOf(thumb).png({ compressionLevel: 0 }).toBuffer(), left: x, top: GAP });
    text.push(svgText(labels[i]!, x + (width - measure(labels[i]!, size)) / 2, GAP + height + 4, size, FG));
  }
  layers.push({ input: Buffer.from(`<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}">${text.join('')}</svg>`), left: 0, top: 0 });
  await sharp({ create: { width: W, height: H, channels: 3, background: BG } }).composite(layers).png().toFile(out);
}

export interface BurstOptions {
  outDir: string;
  platform: string;
  scale?: number;
  threshold?: number;
  minArea?: number;
  // pt of status bar left out (-1: from the screen's shape)
  band?: number;
  edge?: number;
  maxThumbs?: number;
}

export class BurstError extends Error {}

// The two lines burst printed: the frames kept, then the strip's path.
export async function burst(raw: string, o: BurstOptions): Promise<[string, string]> {
  const scale = o.scale ?? 1;
  const threshold = o.threshold ?? 0.1;
  const minArea = o.minArea ?? 64;
  const edge = o.edge ?? 1568;
  const maxThumbs = o.maxThumbs ?? 12;
  const names = (existsSync(raw) ? readdirSync(raw) : [])
    .filter((f) => /^[0-9]{3}\.png$/.test(f))
    .filter((f) => {
      try {
        return statSync(join(raw, f)).size > 0;
      } catch {
        return false;
      }
    })
    .sort();
  if (!names.length) throw new BurstError('burst: no frame was captured');
  const times = readTimes(raw);
  const indexOf = (f: string): number => Number(f.slice(0, 3));
  const t0 = times.get(indexOf(names[0]!));

  type Kept = { index: number; seconds: number | null; pct: number | null; im: Raster };
  const kept: Kept[] = [];
  let last: Raster | null = null;
  let lastRaw: Raster | null = null;
  // Frames are decoded (libuv's threads) and resampled (the pool's) a few ahead, while this thread
  // compares them in order with the last one kept.
  const ahead = new Map<number, Promise<[Raster, Raster | null] | null>>();
  const load = (i: number): Promise<[Raster, Raster | null] | null> | undefined => {
    if (i >= names.length) return undefined;
    if (!ahead.has(i)) {
      ahead.set(
        i,
        readRgb(join(raw, names[i]!)).then(
          // The same bytes as the last frame kept make the same 1x picture: not distinct, and not
          // worth resampling (a still screen is most of a burst).
          async (d) => [d, lastRaw && sameRaster(d, lastRaw) ? null : await to1x(d, scale)] as [Raster, Raster | null],
          () => null,
        ),
      );
    }
    return ahead.get(i);
  };
  for (let i = 0; i < names.length; i++) {
    for (let k = 1; k <= 4; k++) void load(i + k);
    const got = await load(i)!;
    ahead.delete(i);
    // A capture cut short when the burst stopped: nothing to read in it.
    if (!got) continue;
    const decoded = got[0];
    if (lastRaw && sameRaster(decoded, lastRaw)) continue;
    // Skipped ahead against a frame kept since: resampled now.
    const im = got[1] ?? (await to1x(decoded, scale));
    const index = indexOf(names[i]!);
    let band = o.band ?? -1;
    // 44 pt under a notch or a punch-hole, 20 on a home-button phone: mshot's own rule.
    if (band < 0) band = im.height > 2 * im.width ? 44 : 20;
    const t = times.get(index);
    const seconds = t0 !== undefined && t !== undefined ? t - t0 : null;
    if (last === null) {
      kept.push({ index, seconds, pct: null, im });
      last = im;
      lastRaw = decoded;
      continue;
    }
    const [distinct, share] = changed(last, im, threshold, minArea, band);
    if (distinct) {
      kept.push({ index, seconds, pct: share * 100, im });
      last = im;
      lastRaw = decoded;
    }
  }
  const total = names.length;
  const lastT = times.get(indexOf(names.at(-1)!));
  const span = lastT !== undefined && t0 !== undefined ? lastT - t0 : 0;

  mkdirSync(o.outDir, { recursive: true });
  for (const old of readdirSync(o.outDir)) if (old.startsWith(`${o.platform}-burst-`) && old.endsWith('.png')) rmSync(join(o.outDir, old), { force: true });
  const digits = Math.max(2, String(indexOf(names.at(-1)!)).length);
  const pad = (i: number): string => String(i).padStart(digits, '0');
  const parts: string[] = [];
  await Promise.all(kept.map((k) => writeImage(k.im, join(o.outDir, `${o.platform}-burst-${pad(k.index)}.png`))));
  kept.forEach(({ index, seconds, pct }, n) => {
    const when = seconds !== null ? `${pyFixed(seconds, 1)}s` : '?s';
    if (pct === null) parts.push(`${pad(index)} ${when}`);
    else {
      // The first distinct frame says what the number is; the rest just give it. Under 1 %, one
      // decimal: a distinct frame never reads « 0 % » (a tab pill sliding over).
      const share = pct < 1 ? pyFixed(pct, 1) : pyFixed(pct, 0);
      parts.push(`${pad(index)} ${when} (${share} %${n === 1 ? ' changed' : ''})`);
    }
  });

  // Past a dozen thumbnails a 1568 px row stops being readable: an even sample, first and last kept.
  let shown = kept;
  if (kept.length > maxThumbs) {
    const step = (kept.length - 1) / (maxThumbs - 1);
    shown = Array.from({ length: maxThumbs }, (_, i) => kept[pyRound(i * step)]!);
  }
  const labels = shown.map(({ index, seconds }) => (seconds !== null ? `${pad(index)} · ${pyFixed(seconds, 1)}s` : pad(index)));
  const stripPath = join(o.outDir, `${o.platform}-burst-strip.png`);
  await strip(
    shown.map((k) => k.im),
    labels,
    edge,
    stripPath,
  );
  const sampled = shown.length < kept.length ? ` (${shown.length} of ${kept.length})` : '';
  return [`burst: ${total} frames in ${pyFixed(span, 1)}s, ${kept.length} distinct · ${parts.join(' · ')}`, `${pyPath(stripPath)}${sampled}`];
}

const SPEC: ParserSpec = {
  prog: 'burst',
  usage: `usage: burst [-h] --out-dir OUT_DIR --platform PLATFORM [--scale SCALE]
             [--threshold THRESHOLD] [--min-area MIN_AREA] [--band BAND]
             [--edge EDGE] [--max-thumbs MAX_THUMBS]
             raw`,
  pos: [{ name: 'raw' }],
  opts: {
    '--out-dir': { kind: 'str', required: true },
    '--platform': { kind: 'str', required: true },
    '--scale': { kind: 'float', def: 1 },
    '--threshold': { kind: 'float', def: 0.1 },
    '--min-area': { kind: 'int', def: 64 },
    '--band': { kind: 'int', def: -1 },
    '--edge': { kind: 'int', def: 1568 },
    '--max-thumbs': { kind: 'int', def: 12 },
  },
};

export async function main(argv: string[], io: Io): Promise<number> {
  const a = parseArgs(SPEC, argv, io);
  if (typeof a === 'number') return a;
  try {
    const lines = await burst(a.raw as string, {
      outDir: a.out_dir as string,
      platform: a.platform as string,
      scale: a.scale as number,
      threshold: a.threshold as number,
      minArea: a.min_area as number,
      band: a.band as number,
      edge: a.edge as number,
      maxThumbs: a.max_thumbs as number,
    });
    io.out(`${lines.join('\n')}\n`);
  } catch (e) {
    if (!(e instanceof BurstError)) throw e;
    io.err(`${e.message}\n`);
    return 2;
  }
  return 0;
}
