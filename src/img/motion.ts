// Motion report over a recording (vysu mrec): where the picture moves, and what flashes.
//
//   motion <frames-dir | video.mp4> [--fps 60] [--scale 3] [--crop w:h:x:y]
//          [--flash-min 4] [--flash-max 12] [--min-change 0.5] [--dump <dir>]
//
// Two readings of the frames, both in plain text so an agent can act on them without looking:
//
// - **timeline** — runs of consecutive frames that differ from the previous one (a transition, a
//   scroll, a reveal), with how much of the picture moved and the box it moved in;
// - **transients** — pixel rows that leave their resting value for `--flash-min` to `--flash-max`
//   frames and come back to it, their neighbours holding still: a hairline at a seam, a flash, a
//   control that shows for a few frames. Those are what a screenshot never catches and what the eye
//   reports as « something blinked » (the edges of a cross-fading label flicker for a frame or two
//   too — `--flash-min` keeps them out).
//
// A video is read straight from ffmpeg as a grayscale pipe: no PNG sequence on disk (9 s at 60 fps is
// 550 files and 100+ MB), and `--crop w:h:x:y` is ffmpeg's own order, in pixels. A directory is read
// as its PNGs in name order instead. Frames are numbered from f00001 either way, matching the
// `f%05d.png` a manual `ffmpeg -vf fps=…` would write. `--scale` turns pixel rows into points/dp for
// the report (3 on a 3x iPhone); without it rows are reported in pixels. `--dump <dir>` writes just
// the frames the report names, so an agent reads three pictures instead of five hundred.
import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, readdirSync, renameSync, rmSync, statSync } from 'node:fs';
import { extname, join } from 'node:path';
import { which } from '../core/host.ts';
import { run } from '../core/proc.ts';
import { pyRound } from '../core/py.ts';
import { parseArgs, type ParserSpec } from './args.ts';
import { byCodePoint, pyFixed, pyG, pyPath, pySigned } from './fmt.ts';
import { sum32 } from './np.ts';
import { readRgb, resize, toGray, writeImage } from './raster.ts';
import type { Io } from './tools.ts';

// A pixel counts as changed past this luminance delta; a row as departed past this delta of its mean.
const PIXEL_DELTA = 16;
const ROW_DELTA = 4;
// A transient is a thin thing: its neighbours this many rows out must hold still meanwhile — a
// cross-fading label or a scrolling list moves whole bands of rows, a seam or a hairline does not.
const NEIGHBOUR_REACH = 3;

const VIDEO_SUFFIXES = new Set(['.mp4', '.mov', '.webm', '.m4v']);

export class MotionError extends Error {}

// 0-based frame index → the f00001 name the report and the dumps use.
export const frameName = (index: number): string => `f${String(index + 1).padStart(5, '0')}`;

// `exact=1`: on yuv420p ffmpeg otherwise rounds an odd crop down to even (1179 px wide on a 3x iPhone
// → 1178) while the frames are read at the size asked, each one a row further off than the last: a
// still clip read as moving.
export const videoFilter = (fps: number, crop: string): string => `fps=${pyG(fps)}${crop ? `,crop=${crop}:exact=1` : ''}`;

async function videoSize(path: string, crop: string): Promise<[number, number]> {
  if (crop) {
    const [w, h] = crop.split(':');
    const n = [Number(w), Number(h)];
    if (!n.every((v) => Number.isInteger(v))) throw new MotionError(`motion: --crop wants w:h:x:y in pixels, got ${crop}`);
    return n as [number, number];
  }
  const r = await run('ffprobe', ['-v', 'error', '-select_streams', 'v:0', '-show_entries', 'stream=width,height', '-of', 'csv=p=0', path]);
  const [w, h] = r.stdout.trim().split(',');
  if (!w || !h || !/^\d+$/.test(w) || !/^\d+$/.test(h)) throw new MotionError(`motion: ffprobe found no video stream in ${pyPath(path)}\n${r.stderr.trim()}`);
  return [Number(w), Number(h)];
}

// Grayscale frames streamed from ffmpeg, one at a time, rather than extracted as PNGs: `format=gray`
// is the same yuv→luma conversion, within a level of a PNG's Pillow-style `convert("L")`.
async function* videoFrames(path: string, width: number, height: number, fps: number, crop: string, io: Io): AsyncGenerator<Uint8Array> {
  const chain = `${videoFilter(fps, crop)},format=gray`;
  const child = spawn('ffmpeg', ['-v', 'error', '-i', path, '-vf', chain, '-f', 'rawvideo', '-pix_fmt', 'gray', '-'], {
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: true,
  });
  child.stderr.on('data', (b: Buffer) => io.err(b.toString('utf8')));
  const done = new Promise<void>((resolve) => {
    child.on('close', () => resolve());
    child.on('error', () => resolve());
  });
  const size = width * height;
  let frame = new Uint8Array(size);
  let filled = 0;
  try {
    for await (const chunk of child.stdout as AsyncIterable<Buffer>) {
      let off = 0;
      while (off < chunk.length) {
        const n = Math.min(size - filled, chunk.length - off);
        frame.set(chunk.subarray(off, off + n), filled);
        filled += n;
        off += n;
        if (filled === size) {
          yield frame;
          frame = new Uint8Array(size);
          filled = 0;
        }
      }
    }
  } finally {
    child.stdout.destroy();
    await done;
  }
}

async function* dirFrames(files: string[]): AsyncGenerator<[Uint8Array, number, number]> {
  let next = files.length ? readRgb(files[0]!) : null;
  for (let i = 0; i < files.length; i++) {
    const im = await next!;
    next = i + 1 < files.length ? readRgb(files[i + 1]!) : null;
    yield [toGray(im), im.width, im.height];
  }
}

interface MotionRun {
  start: number;
  end: number;
  ratio: number;
  box: [number, number, number, number];
}

interface Scan {
  runs: MotionRun[];
  // frames × rows, each a row's mean in float32, as numpy kept it.
  means: Float32Array;
  count: number;
  height: number;
}

// A row of integers sums exactly in float32 too; the division rounds once, as numpy's did.
function rowMeansOnly(frame: Uint8Array, w: number, h: number, m: Float32Array): void {
  for (let y = 0; y < h; y++) {
    let sum = 0;
    for (let x = 0, p = y * w; x < w; x++, p++) sum += frame[p]!;
    m[y] = Math.fround(sum / w);
  }
}

// The row means of a frame, and how it moved since the previous one: [changed pixels, x0, y0, x1,
// y1]. A function of its own, called per frame: V8 compiles it whole, where the same loop inside the
// streaming one ran three times slower. A row the previous frame already had (most of them: a still
// screen, or a 30 fps clip read at 60) is found by one memcmp and keeps its mean.
function frameStats(frame: Uint8Array, previous: Uint8Array, w: number, h: number, m: Float32Array, pm: Float32Array): [number, number, number, number, number] {
  let count = 0;
  let x0 = w;
  let y0 = h;
  let x1 = -1;
  let y1 = -1;
  const a = Buffer.from(frame.buffer, frame.byteOffset, frame.length);
  const b = Buffer.from(previous.buffer, previous.byteOffset, previous.length);
  for (let y = 0; y < h; y++) {
    if (a.compare(b, y * w, y * w + w, y * w, y * w + w) === 0) {
      m[y] = pm[y]!;
      continue;
    }
    let sum = 0;
    let rowCount = 0;
    let first = -1;
    let last = -1;
    for (let x = 0, p = y * w; x < w; x++, p++) {
      const v = frame[p]!;
      sum += v;
      const d = v - previous[p]!;
      if (d > PIXEL_DELTA || d < -PIXEL_DELTA) {
        if (first < 0) first = x;
        last = x;
        rowCount++;
      }
    }
    m[y] = Math.fround(sum / w);
    if (rowCount) {
      count += rowCount;
      if (first < x0) x0 = first;
      if (last > x1) x1 = last;
      if (y < y0) y0 = y;
      y1 = y;
    }
  }
  return [count, x0, y0, x1, y1];
}

// One pass over the frames: the movement runs, and the row means the transients need.
async function scan(frames: AsyncIterable<[Uint8Array, number, number]>, minChange: number): Promise<Scan> {
  const runs: MotionRun[] = [];
  const rowMeans: Float32Array[] = [];
  let current: MotionRun | null = null;
  let previous: Uint8Array | null = null;
  let width = 0;
  let height = 0;
  let index = 0;
  for await (const [frame, w, h] of frames) {
    if (index && (w !== width || h !== height)) throw new MotionError(`motion: frame ${index + 1} is ${w}x${h}, the first is ${width}x${height}`);
    width = w;
    height = h;
    const m = new Float32Array(h);
    const st = previous ? frameStats(frame, previous, w, h, m, rowMeans.at(-1)!) : (rowMeansOnly(frame, w, h, m), null);
    rowMeans.push(m);
    if (st) {
      const ratio = (st[0] / (w * h)) * 100;
      if (ratio >= minChange) {
        const box: [number, number, number, number] = [st[1], st[2], st[3] - st[1] + 1, st[4] - st[2] + 1];
        if (!current) current = { start: index, end: index, ratio, box };
        else {
          current.end = index;
          current.ratio = Math.max(current.ratio, ratio);
          const [cx, cy, cw, ch] = current.box;
          const nx0 = Math.min(cx, box[0]);
          const ny0 = Math.min(cy, box[1]);
          current.box = [nx0, ny0, Math.max(cx + cw, box[0] + box[2]) - nx0, Math.max(cy + ch, box[1] + box[3]) - ny0];
        }
      } else if (current) {
        runs.push(current);
        current = null;
      }
    }
    previous = frame;
    index++;
  }
  if (current) runs.push(current);
  if (rowMeans.length < 2) throw new MotionError('motion: fewer than two frames');
  const means = new Float32Array(rowMeans.length * height);
  rowMeans.forEach((m, f) => means.set(m, f * height));
  return { runs, means, count: rowMeans.length, height };
}

const f32 = Math.fround;

// Whether the rows just outside a small band around `y` hold their value over the run.
function isolated(means: Float32Array, frames: number, height: number, y: number, start: number, end: number): boolean {
  for (const n of [y - NEIGHBOUR_REACH, y + NEIGHBOUR_REACH]) {
    if (n < 0 || n >= height) continue;
    const base = means[(start > 0 ? start - 1 : start) * height + n]!;
    let moved = 0;
    for (let f = start; f < end; f++) if (Math.abs(f32(means[f * height + n]! - base)) > ROW_DELTA) moved++;
    if (moved / (end - start) > 0.2) return false;
  }
  return true;
}

type Transient = [number, number, number, number]; // row, start, end, delta

// Rows that depart from their resting value for a short run and come back to it, alone.
function transients(s: Scan, flashMin: number, flashMax: number): Transient[] {
  const { means, count: frames, height } = s;
  const away = (f: number, y: number): boolean => f > 0 && Math.abs(f32(means[f * height + y]! - means[(f - 1) * height + y]!)) > ROW_DELTA;
  const found: Transient[] = [];
  for (let y = 0; y < height; y++) {
    let any = false;
    for (let f = 1; f < frames && !any; f++) any = away(f, y);
    if (!any) continue;
    let i = 0;
    while (i < frames) {
      if (!away(i, y)) {
        i++;
        continue;
      }
      const start = i;
      const base = means[(start > 0 ? start - 1 : start) * height + y]!;
      // The run lasts while the row stays away from the value it left.
      let j = start;
      while (j < frames && Math.abs(f32(means[j * height + y]! - base)) > ROW_DELTA) j++;
      const length = j - start;
      if (flashMin <= length && length <= flashMax && j < frames && isolated(means, frames, height, y, start, j)) {
        const mean = f32(sum32(means, start * height + y, length, height) / length);
        found.push([y, start, j - 1, f32(mean - base)]);
      }
      i = Math.max(j, start + 1);
    }
  }
  return found;
}

// Adjacent rows flashing over overlapping frames read as one line.
function groupRows(found: Transient[]): Array<{ start: number; end: number; band: Array<[number, number]> }> {
  const events = [...found].sort((a, b) => a[0] - b[0] || a[1] - b[1] || a[2] - b[2] || a[3] - b[3]);
  const grouped: Array<{ start: number; end: number; band: Array<[number, number]> }> = [];
  for (const [y, start, end, delta] of events) {
    const g = grouped.find((g) => y - g.band.at(-1)![0] <= 1 && start <= g.end && end >= g.start);
    if (g) {
      g.start = Math.min(g.start, start);
      g.end = Math.max(g.end, end);
      g.band.push([y, delta]);
    } else grouped.push({ start, end, band: [[y, delta]] });
  }
  return grouped.sort((a, b) => a.start - b.start || a.band[0]![0] - b.band[0]![0]);
}

const fmtRows = (y0: number, y1: number, scale: number): string =>
  scale ? `rows ${y0}–${y1} px (${pyFixed(y0 / scale, 1)}–${pyFixed((y1 + 1) / scale, 1)} pt)` : `rows ${y0}–${y1} px`;

// The frames worth writing: the edges of every run, plus the frame just before it.
function dumpIndices(reported: Array<[number, number]>): number[] {
  const wanted = new Set<number>();
  for (const [start, end] of reported) for (const i of [Math.max(0, start - 1), start, end]) wanted.add(i);
  return [...wanted].sort((a, b) => a - b);
}

async function dumpFromDir(files: string[], indices: number[], outDir: string, scale: number): Promise<void> {
  for (const index of indices) {
    let im = await readRgb(files[index]!);
    if (scale && scale !== 1) im = resize(im, pyRound(im.width / scale), pyRound(im.height / scale));
    await writeImage(im, join(outDir, `${frameName(index)}.png`));
  }
}

// One ffmpeg pass picking the wanted frames: `select` counts frames after `fps`, as the scan does.
async function dumpFromVideo(path: string, fps: number, crop: string, indices: number[], outDir: string, scale: number, io: Io): Promise<void> {
  let chain = `${videoFilter(fps, crop)},select='${indices.map((i) => `eq(n\\,${i})`).join('+')}'`;
  // Device frames are 3x: a 1x dump costs an agent ~470 tokens to read instead of ~1500.
  if (scale && scale !== 1) chain += `,scale=iw/${pyG(scale)}:ih/${pyG(scale)}`;
  const staging = join(outDir, '.motion-dump');
  rmSync(staging, { recursive: true, force: true });
  mkdirSync(staging, { recursive: true });
  const r = await run('ffmpeg', ['-v', 'error', '-y', '-i', path, '-vf', chain, '-fps_mode', 'passthrough', join(staging, '%05d.png')]);
  if (r.stderr) io.err(r.stderr);
  if (r.code !== 0) throw new Error(`Command 'ffmpeg' returned non-zero exit status ${r.code}.`);
  const written = readdirSync(staging).filter((f) => f.endsWith('.png')).sort();
  written.forEach((f, i) => {
    if (i < indices.length) renameSync(join(staging, f), join(outDir, `${frameName(indices[i]!)}.png`));
  });
  rmSync(staging, { recursive: true, force: true });
}

export interface MotionOptions {
  fps?: number;
  scale?: number;
  crop?: string;
  flashMin?: number;
  flashMax?: number;
  minChange?: number;
  dump?: string | null;
}

// The report, line by line through `emit`, as it is written.
export async function motion(source: string, o: MotionOptions, emit: (s: string) => void, io: Io = { out: emit, err: () => undefined }): Promise<void> {
  const fps = o.fps ?? 60;
  const scale = o.scale ?? 0;
  const crop = o.crop ?? '';
  const flashMin = o.flashMin ?? 4;
  const flashMax = o.flashMax ?? 12;
  const video = VIDEO_SUFFIXES.has(extname(source).toLowerCase());
  let files: string[] = [];
  let frames: AsyncIterable<[Uint8Array, number, number]>;
  if (video) {
    if (!existsSync(source)) throw new MotionError(`motion: no video ${pyPath(source)}`);
    if (!which('ffmpeg') || !which('ffprobe')) throw new MotionError('motion: ffmpeg/ffprobe missing (brew install ffmpeg)');
    const [w, h] = await videoSize(source, crop);
    frames = (async function* () {
      for await (const f of videoFrames(source, w, h, fps, crop, io)) yield [f, w, h] as [Uint8Array, number, number];
    })();
  } else {
    if (crop) throw new MotionError('motion: --crop needs a video source (crop the frames with ffmpeg instead)');
    let isDir = false;
    try {
      isDir = statSync(source).isDirectory();
    } catch {
      isDir = false;
    }
    files = isDir ? readdirSync(source).filter((f) => f.endsWith('.png')).sort(byCodePoint).map((f) => join(source, f)) : [];
    if (files.length < 2) throw new MotionError(`motion: fewer than two frames in ${pyPath(source)}`);
    frames = dirFrames(files);
  }

  const s = await scan(frames, o.minChange ?? 0.5);
  const names = files.length ? files.map((f) => f.split(/[\\/]/).pop()!.replace(/\.[^.]*$/, '')) : Array.from({ length: s.count }, (_, i) => frameName(i));
  const ms = 1000 / fps;
  emit(`${s.count} frames @ ${pyG(fps)} fps (${pyFixed((s.count * ms) / 1000, 1)} s)`);

  const reported: Array<[number, number]> = []; // (start, end) of every run named below, for --dump
  emit('\n## timeline (frames that move)');
  if (!s.runs.length) emit('(still)');
  for (const { start, end, ratio, box } of s.runs) {
    const [x, y, w, h] = box;
    let area = `x ${x} y ${y} w ${w} h ${h}`;
    if (scale) area += ` px = x ${pyFixed(x / scale, 0)} y ${pyFixed(y / scale, 0)} w ${pyFixed(w / scale, 0)} h ${pyFixed(h / scale, 0)} pt`;
    emit(`${names[start]}–${names[end]}: ${pyFixed((end - start + 1) * ms, 0)} ms, up to ${pyFixed(ratio, 0)} % of the picture, in ${area}`);
    reported.push([start, end]);
  }

  emit(`\n## transients (rows that leave their resting value for ${flashMin}–${flashMax} frames and come back)`);
  // A transition legitimately shakes every row for a few frames: keep the thin ones, drop the bands
  // taller than a tenth of the picture.
  let shown = 0;
  for (const { start, end, band } of groupRows(transients(s, flashMin, flashMax))) {
    const y0 = band[0]![0];
    const y1 = band.at(-1)![0];
    if (y1 - y0 + 1 > s.height / 10) continue;
    let total = 0;
    for (const [, d] of band) total += d;
    emit(`${fmtRows(y0, y1, scale)}: ${names[start]}–${names[end]} (${pyFixed((end - start + 1) * ms, 0)} ms), Δ ${pySigned(total / band.length, 0)} levels`);
    reported.push([start, end]);
    shown++;
  }
  if (!shown) emit('(none)');

  if (o.dump) {
    const indices = dumpIndices(reported);
    mkdirSync(o.dump, { recursive: true });
    if (indices.length) {
      if (video) await dumpFromVideo(source, fps, crop, indices, o.dump, scale, io);
      else await dumpFromDir(files, indices, o.dump, scale);
    }
    emit(`\ndumped ${indices.length} frames to ${pyPath(o.dump)}`);
  }
}

const SPEC: ParserSpec = {
  prog: 'motion',
  usage: `usage: motion [-h] [--fps FPS] [--scale SCALE] [--crop w:h:x:y]
              [--flash-min FLASH_MIN] [--flash-max FLASH_MAX]
              [--min-change MIN_CHANGE] [--dump DUMP]
              source`,
  pos: [{ name: 'source' }],
  opts: {
    '--fps': { kind: 'float', def: 60 },
    '--scale': { kind: 'float', def: 0 },
    '--crop': { kind: 'str', def: '' },
    '--flash-min': { kind: 'int', def: 4 },
    '--flash-max': { kind: 'int', def: 12 },
    '--min-change': { kind: 'float', def: 0.5 },
    '--dump': { kind: 'str' },
  },
};

export async function main(argv: string[], io: Io): Promise<number> {
  const a = parseArgs(SPEC, argv, io);
  if (typeof a === 'number') return a;
  try {
    await motion(
      a.source as string,
      {
        fps: a.fps as number,
        scale: a.scale as number,
        crop: a.crop as string,
        flashMin: a.flash_min as number,
        flashMax: a.flash_max as number,
        minChange: a.min_change as number,
        dump: a.dump as string | null,
      },
      (s) => io.out(`${s}\n`),
      io,
    );
  } catch (e) {
    if (!(e instanceof MotionError)) throw e;
    io.err(`${e.message}\n`);
    return 1;
  }
  return 0;
}
