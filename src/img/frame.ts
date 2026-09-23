// Demo-ready exports: a drawn device frame around a capture, alone or on a pitch canvas.
//
//   frame <in.png | in.mp4 | in.webm | folder> [--out <file | dir>]
//         [--device auto|phone|phone-home|tablet|browser|none] [--preset framed|pitch]
//         [--bg '#hex' | brand] [--title "…"] [--caption "…"] [--size 1920x1080] [--fps 30]
//
// Bezels are drawn, generic and brand-neutral, no image asset: `phone` a rounded bezel with a
// dynamic-island pill, `phone-home` the same with a speaker band and a home button, `tablet` a wider
// rounded bezel, `browser` a light window chrome (three dots, a URL pill carrying `--caption`) above
// the capture, `none` nothing. The capture's own corners are masked to the bezel's radius, so they
// disappear under it instead of poking out square.
//
// `--device auto` reads the capture's shape, its scale included — a 3x device clip frames like the
// phone it came from: portrait taller than 1.9:1 → `phone`; portrait 1.45–1.9:1 and no wider than
// 480 px once divided by its likely scale (2 past 600 px, 3 past 900) → `phone-home`; any other
// portrait → `tablet`; landscape at least 700 px wide → `browser`; anything else → `none`.
//
// `--preset framed` (default) writes the framed capture at its own pixel size plus the bezel, on a
// transparent background (`--bg` fills it instead). `--preset pitch` centres it on a `--size` canvas
// — 80 % of the height for a device, 90 % of the width for a browser — over `--bg` (default `brand`:
// a soft gradient from the Nidz primary tint to white), `--title` top-left and `--caption` under it.
//
// A video in gives an H.264 mp4 out at `--fps`: the frame is drawn once as two PNGs (the background,
// then the bezel with the screen punched out) and ffmpeg overlays the scaled video between them. A
// folder in frames every capture and clip it holds into `<folder>/demo/`.
import { mkdirSync, mkdtempSync, readdirSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, extname, join } from 'node:path';
import sharp, { type Sharp } from 'sharp';
import { which } from '../core/host.ts';
import { run } from '../core/proc.ts';
import { pyRound } from '../core/py.ts';
import { parseArgs, type ParserSpec } from './args.ts';
import { byCodePoint, pyG, pyPath } from './fmt.ts';
import { readRgba, type Raster } from './raster.ts';
import { inkBox, measure, svgText } from './text.ts';
import type { Io } from './tools.ts';

type Rgba = [number, number, number, number];
const PRIMARY_TINT: Rgba = [230, 240, 255, 255]; // tokens: primary.tint #E6F0FF
const INK = '#2a1e14'; // tokens: foreground #2A1E14
const MUTED = '#6b5b4a'; // tokens: muted.foreground #6B5B4A
const ACCENT = '#fa811e'; // tokens: secondary #FA811E
const BEZEL = '#0d0d0f';
const GLASS = '#3e3e46'; // the hairline where a bezel meets the screen, and the hardware bits
const CHROME = '#edeae4';
const CHROME_LINE = '#d6cec3';
const DOT = '#c6beb3';
const WHITE = '#ffffff';

const VIDEO_SUFFIXES = new Set(['.mp4', '.webm', '.mov', '.m4v']);
export const DEVICES = ['auto', 'phone', 'phone-home', 'tablet', 'browser', 'none'] as const;
export type Device = (typeof DEVICES)[number];

export class FrameError extends Error {}

const fdiv = (a: number, b: number): number => Math.floor(a / b);

export function rgba(value: string): Rgba {
  let v = value.replace(/^#+/, '');
  if (v.length === 3) v = [...v].map((c) => c + c).join('');
  if (v.length === 6) v += 'ff';
  if (v.length !== 8 || !/^[0-9a-f]{8}$/i.test(v)) throw new FrameError(`frame: --bg wants 'brand' or a #hex colour, got ${value}`);
  return [0, 2, 4, 6].map((i) => parseInt(v.slice(i, i + 2), 16)) as Rgba;
}

// The frame a capture asks for, from its shape and its likely device scale.
export function detect(w: number, h: number): Exclude<Device, 'auto'> {
  if (h > w) {
    const ratio = h / w;
    if (ratio >= 1.9) return 'phone';
    const scale = w >= 900 ? 3 : w >= 600 ? 2 : 1;
    return ratio >= 1.45 && w / scale <= 480 ? 'phone-home' : 'tablet';
  }
  return w >= 700 ? 'browser' : 'none';
}

type Corners = [boolean, boolean, boolean, boolean];
interface Geometry {
  margins: [number, number, number, number];
  rOut: number;
  rIn: number;
  corners: Corners;
}

// (left, top, right, bottom) bezel margins, outer radius, screen radius, rounded screen corners.
export function geometry(device: string, w: number): Geometry {
  const all: Corners = [true, true, true, true];
  if (device === 'phone') {
    const b = Math.max(6, pyRound(0.035 * w));
    const r = pyRound(0.115 * w);
    return { margins: [b, b, b, b], rOut: r + b, rIn: r, corners: all };
  }
  if (device === 'phone-home') {
    const b = Math.max(5, pyRound(0.032 * w));
    return { margins: [b, pyRound(0.135 * w), b, pyRound(0.185 * w)], rOut: pyRound(0.1 * w), rIn: 0, corners: all };
  }
  if (device === 'tablet') {
    const b = Math.max(8, pyRound(0.05 * w));
    const r = pyRound(0.022 * w);
    return { margins: [b, b, b, b], rOut: r + b, rIn: r, corners: all };
  }
  if (device === 'browser') {
    const c = Math.min(56, Math.max(26, pyRound(0.03 * w)));
    const s = Math.max(1, pyRound(w / 700));
    const r = pyRound(c * 0.3);
    // Only the bottom corners are rounded: the top two sit under the chrome bar.
    return { margins: [s, c, s, s], rOut: r, rIn: Math.max(2, r - s), corners: [false, false, true, true] };
  }
  return { margins: [0, 0, 0, 0], rOut: 0, rIn: 0, corners: all };
}

// A rounded rectangle's outline from pixel edge x0,y0 to x1,y1, some corners square.
function rounded(x0: number, y0: number, x1: number, y1: number, r: number, c: Corners = [true, true, true, true]): string {
  const rr = Math.max(0, Math.min(r, (x1 - x0) / 2, (y1 - y0) / 2));
  const [tl, tr, br, bl] = c.map((on) => (on ? rr : 0)) as [number, number, number, number];
  const arc = (rad: number, x: number, y: number): string => (rad ? `A${rad} ${rad} 0 0 1 ${x} ${y}` : '');
  return (
    `M${x0 + tl} ${y0}H${x1 - tr}${arc(tr, x1, y0 + tr)}V${y1 - br}${arc(br, x1 - br, y1)}` +
    `H${x0 + bl}${arc(bl, x0, y1 - bl)}V${y0 + tl}${arc(tl, x0 + tl, y0)}Z`
  );
}

// ImageDraw's shapes, their box inclusive of its last pixel: filled, or outlined `width` px inward.
const fillRounded = (b: number[], r: number, fill: string, c?: Corners): string => `<path d="${rounded(b[0]!, b[1]!, b[2]! + 1, b[3]! + 1, r, c)}" fill="${fill}"/>`;
const strokeRounded = (b: number[], r: number, stroke: string, width: number, c?: Corners): string => {
  const h = width / 2;
  return `<path d="${rounded(b[0]! + h, b[1]! + h, b[2]! + 1 - h, b[3]! + 1 - h, Math.max(0, r - h), c)}" fill="none" stroke="${stroke}" stroke-width="${width}"/>`;
};
const ellipse = (b: number[], fill: string, stroke = '', width = 0): string => {
  const h = width / 2;
  return `<ellipse cx="${(b[0]! + b[2]! + 1) / 2}" cy="${(b[1]! + b[3]! + 1) / 2}" rx="${(b[2]! - b[0]! + 1) / 2 - h}" ry="${(b[3]! - b[1]! + 1) / 2 - h}" fill="${fill}"${stroke ? ` stroke="${stroke}" stroke-width="${width}"` : ''}/>`;
};

// Text placed by its ink box, as the Python did (no font anchor): align is horizontal l|c|r then
// vertical t|m. Returns the SVG and the ink box's size.
function inkText(text: string, x: number, y: number, size: number, fill: string, align = 'lt'): { svg: string; w: number; h: number } {
  const [x0, y0, x1, y1] = inkBox(text, size);
  if (align[0] === 'c') x -= (x1 - x0) / 2;
  else if (align[0] === 'r') x -= x1 - x0;
  if (align[1] === 'm') y -= (y1 - y0) / 2;
  return { svg: svgText(text, x - x0, y - y0, size, fill), w: x1 - x0, h: y1 - y0 };
}

function fit(text: string, size: number, width: number): string {
  if (measure(text, size) <= width) return text;
  let chars = Array.from(text);
  while (chars.length && measure(`${chars.join('')}…`, size) > width) chars = chars.slice(0, -1);
  return `${chars.join('')}…`;
}

function browserChrome(fw: number, side: number, chrome: number, caption: string): string[] {
  const out: string[] = [];
  const cy = fdiv(chrome, 2);
  const rad = Math.max(2, pyRound(chrome * 0.1));
  let x = side + pyRound(chrome * 0.55);
  for (let i = 0; i < 3; i++) {
    out.push(ellipse([x - rad, cy - rad, x + rad, cy + rad], DOT));
    x += pyRound(chrome * 0.4);
  }
  const ph = pyRound(chrome * 0.52);
  const x0 = side + pyRound(chrome * 2.1);
  const x1 = fw - side - pyRound(chrome * 0.6);
  if (x1 - x0 < 2 * ph) return out;
  const pill = [x0, cy - fdiv(ph, 2), x1, cy + fdiv(ph, 2)];
  out.push(fillRounded(pill, fdiv(ph, 2), WHITE), strokeRounded(pill, fdiv(ph, 2), CHROME_LINE, 1));
  if (caption) {
    const size = Math.max(9, pyRound(ph * 0.55));
    out.push(inkText(fit(caption, size, x1 - x0 - ph), x0 + ph * 0.45, cy, size, MUTED, 'lm').svg);
  }
  return out;
}

function homeDetails(fw: number, fh: number, g: Geometry, w: number): string[] {
  const [, top, , bottom] = g.margins;
  const sw = pyRound(0.17 * w);
  const sh = Math.max(3, pyRound(0.016 * w));
  const cx = fdiv(fw, 2);
  const cy = pyRound(top * 0.55);
  const rad = Math.max(2, pyRound(0.012 * w));
  const dx = cx - fdiv(sw, 2) - pyRound(0.05 * w);
  const hr = pyRound(0.055 * w);
  const hy = fh - fdiv(bottom, 2);
  return [
    fillRounded([cx - fdiv(sw, 2), cy - fdiv(sh, 2), cx + fdiv(sw, 2), cy + fdiv(sh, 2)], fdiv(sh, 2), GLASS),
    ellipse([dx - rad, cy - rad, dx + rad, cy + rad], GLASS),
    ellipse([cx - hr, hy - hr, cx + hr, hy + hr], 'none', GLASS, Math.max(2, pyRound(0.006 * w))),
  ];
}

interface Overlay {
  svg: string;
  width: number;
  height: number;
  g: Geometry;
}

// A transparent canvas the size of the framed capture: bezel painted, screen punched out.
export function overlayOf(device: string, w: number, h: number, caption = ''): Overlay {
  const g = geometry(device, w);
  const [left, top, right, bottom] = g.margins;
  const fw = w + left + right;
  const fh = h + top + bottom;
  const parts: string[] = [];
  if (device !== 'none') {
    // The screen is a hole in the body, not a transparent shape drawn over it.
    const body = rounded(0, 0, fw, fh, g.rOut);
    const hole = rounded(left, top, left + w, top + h, g.rIn, g.corners);
    parts.push(`<path d="${body}${hole}" fill-rule="evenodd" fill="${device === 'browser' ? CHROME : BEZEL}"/>`);
    if (device === 'browser') {
      const edge = Math.max(1, left);
      parts.push(`<path d="${rounded(edge / 2, edge / 2, fw - edge / 2, fh - edge / 2, Math.max(0, g.rOut - edge / 2))}" fill="none" stroke="${CHROME_LINE}" stroke-width="${edge}"/>`);
      parts.push(...browserChrome(fw, left, top, caption));
    } else {
      const edge = Math.max(1, pyRound(Math.min(...g.margins) * 0.2));
      parts.push(strokeRounded([left - edge, top - edge, left + w - 1 + edge, top + h - 1 + edge], g.rIn + edge, GLASS, edge, g.corners));
      if (device === 'phone') {
        const pw = pyRound(0.3 * w);
        const ph = pyRound(0.088 * w);
        const x = left + fdiv(w - pw, 2);
        const y = top + pyRound(0.027 * w);
        parts.push(fillRounded([x, y, x + pw, y + ph], fdiv(ph, 2), BEZEL));
      } else if (device === 'phone-home') parts.push(...homeDetails(fw, fh, g, w));
      else {
        const rad = Math.max(2, pyRound(0.005 * w));
        const cx = fdiv(fw, 2);
        const cy = fdiv(top, 2);
        parts.push(ellipse([cx - rad, cy - rad, cx + rad, cy + rad], GLASS));
      }
    }
  }
  return { svg: `<svg xmlns="http://www.w3.org/2000/svg" width="${fw}" height="${fh}">${parts.join('')}</svg>`, width: fw, height: fh, g };
}

const png = (s: Sharp): Promise<Buffer> => s.png({ compressionLevel: 1 }).toBuffer();
const blank = (width: number, height: number): Sharp => sharp({ create: { width, height, channels: 4, background: { r: 0, g: 0, b: 0, alpha: 0 } } });

// The capture under its bezel, on a transparent canvas, as a PNG buffer.
async function frameImage(im: Raster, device: string, caption: string): Promise<{ buf: Buffer; width: number; height: number; g: Geometry }> {
  const o = overlayOf(device, im.width, im.height, caption);
  const [left, top] = o.g.margins;
  let shot = sharp(im.data, { raw: { width: im.width, height: im.height, channels: 4 } });
  if (o.g.rIn) {
    const mask = `<svg xmlns="http://www.w3.org/2000/svg" width="${im.width}" height="${im.height}"><path d="${rounded(0, 0, im.width, im.height, o.g.rIn, o.g.corners)}" fill="#fff"/></svg>`;
    shot = sharp(await png(shot)).composite([{ input: Buffer.from(mask), blend: 'dest-in' }]);
  }
  const buf = await png(blank(o.width, o.height).composite([{ input: await png(shot), left, top }, { input: Buffer.from(o.svg), left: 0, top: 0 }]));
  return { buf, width: o.width, height: o.height, g: o.g };
}

// The brand gradient, in float32 as numpy computed it: t = (x + y) / 2 over [0, 1], smoothstepped so
// the tint fades out without a visible band, then truncated to bytes.
function gradient(width: number, height: number, start: Rgba, end: Rgba): Raster {
  const f = Math.fround;
  const lin = (n: number): Float32Array => {
    const a = new Float32Array(n);
    const step = n > 1 ? 1 / (n - 1) : 0;
    for (let i = 0; i < n; i++) a[i] = i * step;
    if (n > 1) a[n - 1] = 1;
    return a;
  };
  const xs = lin(width);
  const ys = lin(height);
  const a = start.slice(0, 3).map(f);
  const d = [0, 1, 2].map((k) => f(f(end[k]!) - a[k]!));
  const out = new Uint8Array(width * height * 4);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const t0 = f(f(xs[x]! + ys[y]!) / 2);
      const t = f(f(t0 * t0) * f(3 - f(2 * t0)));
      const p = (y * width + x) * 4;
      for (let k = 0; k < 3; k++) out[p + k] = Math.trunc(f(a[k]! + f(d[k]! * t)));
      out[p + 3] = 255;
    }
  }
  return { data: out, width, height, channels: 4 };
}

function background(width: number, height: number, bg: string): Sharp {
  if (bg === 'brand') {
    const g = gradient(width, height, PRIMARY_TINT, [255, 255, 255, 255]);
    return sharp(g.data, { raw: { width, height, channels: 4 } });
  }
  const [r, g, b, a] = rgba(bg);
  return sharp({ create: { width, height, channels: 4, background: { r, g, b, alpha: a / 255 } } });
}

// The pitch canvas without the device, plus the (x, y, w, h) box the framed device goes in.
async function pitchLayout(size: [number, number], bg: string, title: string, caption: string, framed: [number, number], device: string): Promise<{ canvas: Buffer; box: [number, number, number, number] }> {
  const [width, height] = size;
  const svg: string[] = [];
  const margin = pyRound(width * 0.055);
  let top = margin;
  if (title) {
    const t = inkText(title, margin, margin, pyRound(height * 0.058), INK);
    svg.push(t.svg);
    // A short brand rule under the headline: the one place the pitch says Nidz, the bezel being
    // deliberately anonymous.
    const rule = pyRound(height * 0.007);
    const ry = margin + t.h + pyRound(height * 0.028);
    svg.push(fillRounded([margin, ry, margin + Math.max(64, pyRound(t.w * 0.18)), ry + rule], fdiv(rule, 2), ACCENT));
    top = margin + t.h + pyRound(height * 0.075);
  }
  const bottom = height - margin - (caption ? pyRound(height * 0.06) : 0);
  const boxW = width - 2 * margin;
  const boxH = bottom - top;
  const [fw, fh] = framed;
  const target = device === 'browser' ? (0.9 * width) / fw : (0.8 * height) / fh;
  const scale = Math.min(target, boxW / fw, boxH / fh);
  const dw = Math.max(2, pyRound(fw * scale));
  const dh = Math.max(2, pyRound(fh * scale));
  const dx = fdiv(width - dw, 2);
  const dy = top + fdiv(boxH - dh, 2);
  if (caption) svg.push(inkText(caption, fdiv(width, 2), dy + dh + pyRound(height * 0.028), pyRound(height * 0.024), MUTED, 'ct').svg);
  const canvas = await png(
    background(width, height, bg).composite([{ input: Buffer.from(`<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}">${svg.join('')}</svg>`), left: 0, top: 0 }]),
  );
  return { canvas, box: [dx, dy, dw, dh] };
}

export interface FrameOptions {
  device?: Device;
  preset?: 'framed' | 'pitch';
  bg?: string | null;
  title?: string | null;
  caption?: string | null;
  size?: [number, number];
  fps?: number;
}

// « <out> WxH <device> », once the framed capture is written.
export async function renderImage(src: string, out: string, o: FrameOptions): Promise<string> {
  const im = await readRgba(src);
  const device = !o.device || o.device === 'auto' ? detect(im.width, im.height) : o.device;
  const framed = await frameImage(im, device, o.caption ?? '');
  let result: Sharp;
  let w = framed.width;
  let h = framed.height;
  if (o.preset === 'pitch') {
    const size = o.size ?? [1920, 1080];
    const { canvas, box } = await pitchLayout(size, o.bg || 'brand', o.title ?? '', o.caption ?? '', [framed.width, framed.height], device);
    const scaled = await sharp(framed.buf).resize(box[2], box[3], { kernel: 'lanczos3', fit: 'fill' }).png().toBuffer();
    result = sharp(canvas).composite([{ input: scaled, left: box[0], top: box[1] }]);
    [w, h] = size;
  } else if (o.bg) result = background(framed.width, framed.height, o.bg).composite([{ input: framed.buf, left: 0, top: 0 }]);
  else result = sharp(framed.buf);
  await result.png().toFile(out);
  return `${pyPath(out)} ${w}x${h} ${device}`;
}

async function probeVideo(path: string): Promise<[number, number]> {
  const r = await run('ffprobe', ['-v', 'error', '-select_streams', 'v:0', '-show_entries', 'stream=width,height', '-of', 'csv=p=0', path]);
  const [w, h] = r.stdout.trim().split(',');
  if (!w || !h || !/^\d+$/.test(w) || !/^\d+$/.test(h)) throw new FrameError(`frame: ffprobe found no video stream in ${pyPath(path)}\n${r.stderr.trim()}`);
  return [Number(w), Number(h)];
}

export async function renderVideo(src: string, out: string, o: FrameOptions, io: Io): Promise<string> {
  if (!which('ffmpeg') || !which('ffprobe')) throw new FrameError('frame: ffmpeg/ffprobe missing (brew install ffmpeg)');
  const fps = o.fps ?? 30;
  const [w, h] = await probeVideo(src);
  const device = !o.device || o.device === 'auto' ? detect(w, h) : o.device;
  const overlay = overlayOf(device, w, h, o.caption ?? '');
  const overlayPng = await png(sharp(Buffer.from(overlay.svg)));
  let back: Buffer;
  let bezel: Buffer;
  let size: [number, number];
  let screen: [number, number, number, number];
  if (o.preset === 'pitch') {
    size = o.size ?? [1920, 1080];
    const { canvas, box } = await pitchLayout(size, o.bg || 'brand', o.title ?? '', o.caption ?? '', [overlay.width, overlay.height], device);
    const [dx, dy, dw, dh] = box;
    const scale = dw / overlay.width;
    const [left, top, right, bottom] = overlay.g.margins.map((m) => pyRound(m * scale)) as [number, number, number, number];
    const scaled = await sharp(overlayPng).resize(dw, dh, { kernel: 'lanczos3', fit: 'fill' }).png().toBuffer();
    back = canvas;
    bezel = await png(blank(size[0], size[1]).composite([{ input: scaled, left: dx, top: dy }]));
    screen = [dx + left, dy + top, dw - left - right, dh - top - bottom];
  } else {
    // H.264 has no alpha: the framed preset needs a real backdrop, white unless asked otherwise.
    size = [overlay.width + (overlay.width % 2), overlay.height + (overlay.height % 2)];
    back = await png(background(size[0], size[1], o.bg || '#ffffff'));
    bezel = await png(blank(size[0], size[1]).composite([{ input: overlayPng, left: 0, top: 0 }]));
    screen = [overlay.g.margins[0], overlay.g.margins[1], w, h];
  }
  const tmp = mkdtempSync(join(tmpdir(), 'vysu-frame-'));
  try {
    const backPng = join(tmp, 'back.png');
    const bezelPng = join(tmp, 'bezel.png');
    await sharp(back).removeAlpha().png().toFile(backPng);
    await sharp(bezel).png().toFile(bezelPng);
    const [sx, sy, sw, sh] = screen;
    // `shortest=1` on the overlay that carries the video: without it the looped background never
    // ends and ffmpeg encodes for ever (`-shortest` does not reach inside filter_complex).
    const chain = `[1:v]fps=${pyG(fps)},scale=${sw}:${sh}[v];[0:v][v]overlay=${sx}:${sy}:shortest=1[a];[a][2:v]overlay=0:0[o]`;
    const r = await run('ffmpeg', [
      '-v', 'error', '-y', '-loop', '1', '-framerate', pyG(fps), '-i', backPng, '-i', src, '-i', bezelPng, '-filter_complex', chain,
      '-map', '[o]', '-an', '-c:v', 'libx264', '-crf', '20', '-preset', 'veryfast', '-pix_fmt', 'yuv420p', '-movflags', '+faststart', '-shortest', out,
    ]);
    if (r.stderr) io.err(r.stderr);
    if (r.code !== 0) throw new Error(`Command 'ffmpeg' returned non-zero exit status ${r.code}.`);
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
  return `${pyPath(out)} ${size[0]}x${size[1]} ${device}`;
}

// A file worth framing: a capture or a clip, not a sheet, a baseline, a diff, a compare page or the
// capture an mshot replaced.
function isCapture(dir: string, name: string): boolean {
  const ext = extname(name).toLowerCase();
  if (VIDEO_SUFFIXES.has(ext)) return true;
  let file = false;
  try {
    file = statSync(join(dir, name)).isFile();
  } catch {
    file = false;
  }
  if (ext !== '.png' || !file) return false;
  return !(name.startsWith('sheet') || name.startsWith('compare') || name.startsWith('.') || name.endsWith('-changed.png') || name.endsWith('-base.png') || name.endsWith('.prev.png'));
}

const isDir = (p: string): boolean => {
  try {
    return statSync(p).isDirectory();
  } catch {
    return false;
  }
};
const stemOf = (p: string): string => basename(p, extname(p));

// Every line frame printed, one per file written.
export async function frame(source: string, out: string | null, o: FrameOptions, emit: (line: string) => void, io: Io): Promise<void> {
  const preset = o.preset ?? 'framed';
  const jobs: Array<[string, string, boolean]> = [];
  if (isDir(source)) {
    const outDir = out || join(source, 'demo');
    mkdirSync(outDir, { recursive: true });
    for (const name of readdirSync(source).sort(byCodePoint)) {
      if (!isCapture(source, name)) continue;
      const video = VIDEO_SUFFIXES.has(extname(name).toLowerCase());
      jobs.push([join(source, name), join(outDir, `${stemOf(name)}-${preset}${video ? '.mp4' : '.png'}`), video]);
    }
    if (!jobs.length) throw new FrameError(`frame: no capture in ${pyPath(source)}`);
  } else {
    const video = VIDEO_SUFFIXES.has(extname(source).toLowerCase());
    const name = `${stemOf(source)}-${preset}${video ? '.mp4' : '.png'}`;
    jobs.push([source, out ? (isDir(out) ? join(out, name) : out) : join(dirname(source), name), video]);
  }
  for (const [src, dest, video] of jobs) {
    mkdirSync(dirname(dest), { recursive: true });
    emit(video ? await renderVideo(src, dest, { ...o, preset }, io) : await renderImage(src, dest, { ...o, preset }));
  }
}

const SPEC: ParserSpec = {
  prog: 'frame.py',
  usage: `usage: frame.py [-h] [--out OUT]
                [--device {auto,phone,phone-home,tablet,browser,none}]
                [--preset {framed,pitch}] [--bg BG] [--title TITLE]
                [--caption CAPTION] [--size SIZE] [--fps FPS]
                source`,
  pos: [{ name: 'source' }],
  opts: {
    '--out': { kind: 'str' },
    '--device': { kind: 'str', choices: [...DEVICES], def: 'auto' },
    '--preset': { kind: 'str', choices: ['framed', 'pitch'], def: 'framed' },
    '--bg': { kind: 'str' },
    '--title': { kind: 'str' },
    '--caption': { kind: 'str' },
    '--size': { kind: 'str', def: '1920x1080' },
    '--fps': { kind: 'float', def: 30 },
  },
};

export async function main(argv: string[], io: Io): Promise<number> {
  const a = parseArgs(SPEC, argv, io);
  if (typeof a === 'number') return a;
  const fail = (msg: string): number => {
    io.err(`${msg}\n`);
    return 1;
  };
  const parts = (a.size as string).toLowerCase().split('x');
  if (parts.length !== 2 || !parts.every((p) => /^\s*[+-]?\d+\s*$/.test(p))) return fail(`frame: --size wants WxH, got ${a.size}`);
  // yuv420p wants even dimensions.
  const size = parts.map((p) => Number(p) + (((Number(p) % 2) + 2) % 2)) as [number, number];
  const source = a.source as string;
  let exists = true;
  try {
    statSync(source);
  } catch {
    exists = false;
  }
  if (!exists) return fail(`frame: no ${pyPath(source)}`);
  try {
    await frame(
      source,
      a.out as string | null,
      { device: a.device as Device, preset: a.preset as 'framed' | 'pitch', bg: a.bg as string | null, title: a.title as string | null, caption: a.caption as string | null, size, fps: a.fps as number },
      (l) => io.out(`${l}\n`),
      io,
    );
  } catch (e) {
    if (!(e instanceof FrameError)) throw e;
    return fail(e.message);
  }
  return 0;
}

