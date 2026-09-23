// Point at what matters in a screenshot: boxes, labels, a dimmed surrounding, a padded crop, a zoom.
//
//   mark <in.png> --out <out.png> [--box x,y,w,h[:label]]... [--circle cx,cy,r[:label]]...
//        [--grow 10] [--crop x,y,w,h | --crop auto] [--pad 32] [--zoom 2] [--dim] [--color e11d48]
//
// Coordinates are pixels of the input image (a 1x screenshot: what `vysu box` prints for the web).
// `--crop auto` crops around every box/circle with `--pad` margin; `--dim` darkens everything outside
// them; `--zoom` upscales the result (small crops read better at 2x). `--grow` widens every shape by
// N px on each side before drawing: element boxes hug the text, and a full-page capture (no
// scrollbar) lands a few pixels off, so the dimming would otherwise bite the first letters.
import { pyRound } from '../core/py.ts';
import { pyFloat, pyInt } from './fmt.ts';
import { crop as cropRaster, readRgba, resizeFast, sharpOf, toChannels, writeImage, type Raster } from './raster.ts';
import { escapeXml, measure, svgText } from './text.ts';
import type { Io } from './tools.ts';

export const COLOR = '#e11d48';

export const DOC = `Point at what matters in a screenshot: boxes, labels, a dimmed surrounding, a padded crop, a zoom.

Usage: mark <in.png> --out <out.png> [--box x,y,w,h[:label]]... [--circle cx,cy,r[:label]]...
             [--grow 10] [--crop x,y,w,h | --crop auto] [--pad 32] [--zoom 2] [--dim] [--color e11d48]

Coordinates are pixels of the input image (a 1x screenshot: what \`vysu box\` prints for the web). \`--crop
auto\` crops around every box/circle with \`--pad\` margin; \`--dim\` darkens everything outside them;
\`--zoom\` upscales the result (small crops read better at 2x). \`--grow\` widens every shape by N px on
each side before drawing: element boxes hug the text, and a full-page capture (no scrollbar) lands a
few pixels off, so the dimming would otherwise bite the first letters.
`;

export interface Shape {
  kind: 'box' | 'circle';
  // x,y,w,h for a box, cx,cy,r for a circle.
  v: number[];
  label: string | null;
}

export interface RenderOptions {
  grow?: number;
  dim?: boolean;
  color?: string;
  crop?: 'auto' | number[] | null;
  pad?: number;
  zoom?: number;
}

type Rect = [number, number, number, number];

export function parseShape(spec: string): { nums: number[]; label: string | null } {
  let label: string | null = null;
  const at = spec.indexOf(':');
  if (at >= 0) {
    label = spec.slice(at + 1);
    spec = spec.slice(0, at);
  }
  const nums = spec.split(',').map((v) => {
    const f = pyFloat(v);
    if (f === null || !Number.isFinite(f)) throw new Error(`could not convert string to float: '${v}'`);
    return Math.trunc(f);
  });
  return { nums, label };
}

// The label size Pillow's font gave: FreeType at `size` px.
const fontSize = (w: number, h: number): number => Math.max(13, pyRound(Math.min(w, h) / 60));

// Inside a rounded rectangle (x0..x1, y0..y1 inclusive, radius r): what Pillow's fill covers.
function insideRounded(px: number, py: number, r: Rect, radius: number): boolean {
  const [x0, y0, x1, y1] = r;
  if (px < x0 || px > x1 || py < y0 || py > y1) return false;
  const rad = Math.min(radius, (x1 - x0) / 2, (y1 - y0) / 2);
  const cx = px < x0 + rad ? x0 + rad : px > x1 - rad ? x1 - rad : px;
  const cy = py < y0 + rad ? y0 + rad : py > y1 - rad ? y1 - rad : py;
  const dx = px - cx;
  const dy = py - cy;
  return dx * dx + dy * dy <= rad * rad + rad;
}

// SHIFTFORDIV255: a / 255, rounded, without a division.
const div255 = (a: number): number => (((a >>> 8) + a) >>> 8);

// Image.alpha_composite of black at alpha 120 over every pixel outside the holes, in Pillow's own
// integer blend: the dimmed surrounding comes out at the levels mark.py wrote.
function dimOutside(img: Raster, holes: Rect[], radius: number): void {
  const { width: w, height: h, data } = img;
  const sa = 120;
  for (let y = 0; y < h; y++) {
    const rows = holes.filter((r) => y >= r[1] && y <= r[3]);
    for (let x = 0; x < w; x++) {
      if (rows.length && rows.some((r) => insideRounded(x, y, r, radius))) continue;
      const p = (y * w + x) * 4;
      const da = data[p + 3]!;
      const blend = da * (255 - sa);
      const outa255 = sa * 255 + blend;
      const coef1 = Math.floor((sa * 255 * 255 * 128) / outa255);
      const coef2 = 255 * 128 - coef1;
      for (let k = 0; k < 3; k++) data[p + k] = div255(data[p + k]! * coef2 + (0x80 << 7)) >>> 7;
      data[p + 3] = div255(outa255 + 0x80);
    }
  }
}

// Draw `shapes` on an RGBA image: what mark.render did, and what diff.py's marked image is made of.
export async function render(src: Raster, shapes: Shape[], o: RenderOptions = {}): Promise<Raster> {
  const grow = o.grow ?? 10;
  const color = o.color ?? COLOR;
  const pad = o.pad ?? 32;
  const zoom = o.zoom ?? 1;
  let im: Raster = toChannels(src, 4);
  im = { ...im, data: im.data === src.data ? im.data.slice() : im.data };
  const { width: w, height: h } = im;
  const stroke = Math.max(3, pyRound(Math.min(w, h) / 220));
  const rects: Rect[] = shapes.map(({ kind, v }) => {
    let r: Rect;
    if (kind === 'box') {
      const [x, y, bw, bh] = v as [number, number, number, number];
      r = [x, y, x + bw, y + bh];
    } else {
      const [cx, cy, rad] = v as [number, number, number];
      r = [cx - rad, cy - rad, cx + rad, cy + rad];
    }
    return [Math.max(0, r[0] - grow), Math.max(0, r[1] - grow), Math.min(w, r[2] + grow), Math.min(h, r[3] + grow)];
  });

  if (o.dim && rects.length) dimOutside(im, rects, stroke * 3);

  const size = fontSize(w, h);
  const svg: string[] = [];
  const placed: Rect[] = [];
  const fill = escapeXml(color);
  shapes.forEach(({ kind, label }, i) => {
    const r = rects[i]!;
    const half = stroke / 2;
    if (kind === 'box') {
      svg.push(
        `<rect x="${r[0] + half}" y="${r[1] + half}" width="${Math.max(0, r[2] - r[0] + 1 - stroke)}" height="${Math.max(0, r[3] - r[1] + 1 - stroke)}" rx="${Math.max(0, stroke * 3 - half)}" fill="none" stroke="${fill}" stroke-width="${stroke}"/>`,
      );
    } else {
      svg.push(
        `<ellipse cx="${(r[0] + r[2] + 1) / 2}" cy="${(r[1] + r[3] + 1) / 2}" rx="${Math.max(0, (r[2] - r[0] + 1) / 2 - half)}" ry="${Math.max(0, (r[3] - r[1] + 1) / 2 - half)}" fill="none" stroke="${fill}" stroke-width="${stroke}"/>`,
      );
    }
    if (!label) return;
    const tw = measure(label, size) + 16;
    const th = size + 8;
    const lx = r[0];
    let ly = r[1] - th - stroke;
    if (ly < 0) ly = r[3] + stroke;
    // Labels of neighbouring shapes must not sit on each other: push down until clear.
    while (placed.some(([px0, py0, px1, py1]) => lx < px1 && lx + tw > px0 && ly < py1 && ly + th > py0)) ly += th + 4;
    placed.push([lx, ly, lx + tw, ly + th]);
    svg.push(`<rect x="${lx}" y="${ly}" width="${tw + 1}" height="${th + 1}" rx="6" fill="${fill}"/>`);
    svg.push(svgText(label, lx + 8, ly + 3, size, '#ffffff'));
  });
  if (svg.length) {
    const overlay = Buffer.from(`<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}">${svg.join('')}</svg>`);
    const { data } = await sharpOf(im).composite([{ input: overlay, left: 0, top: 0 }]).raw().toBuffer({ resolveWithObject: true });
    im = { ...im, data: new Uint8Array(data.buffer, data.byteOffset, data.length) };
  }

  // Image.crop rounds its box: a label's width is fractional.
  if (o.crop === 'auto' && rects.length) {
    const all = [...rects, ...placed];
    const x0 = pyRound(Math.max(0, Math.min(...all.map((r) => r[0])) - pad));
    const y0 = pyRound(Math.max(0, Math.min(...all.map((r) => r[1])) - pad));
    const x1 = pyRound(Math.min(w, Math.max(...all.map((r) => r[2])) + pad));
    const y1 = pyRound(Math.min(h, Math.max(...all.map((r) => r[3])) + pad));
    im = cropBox(im, x0, y0, x1, y1);
  } else if (Array.isArray(o.crop)) {
    const [x, y, cw, ch] = o.crop as [number, number, number, number];
    im = cropBox(im, Math.max(0, x), Math.max(0, y), Math.min(w, x + cw), Math.min(h, y + ch));
  }

  if (zoom !== 1) im = await resizeFast(im, pyRound(im.width * zoom), pyRound(im.height * zoom));
  return im;
}

// Pillow's crop pads what falls outside the image with black; a box inside it is a plain copy.
function cropBox(im: Raster, x0: number, y0: number, x1: number, y1: number): Raster {
  if (x0 >= 0 && y0 >= 0 && x1 <= im.width && y1 <= im.height && x1 >= x0 && y1 >= y0) return cropRaster(im, x0, y0, x1, y1);
  const w = Math.max(0, x1 - x0);
  const h = Math.max(0, y1 - y0);
  const out = new Uint8Array(w * h * im.channels);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const sx = x0 + x;
      const sy = y0 + y;
      if (sx < 0 || sy < 0 || sx >= im.width || sy >= im.height) continue;
      out.set(im.data.subarray((sy * im.width + sx) * im.channels, (sy * im.width + sx + 1) * im.channels), (y * w + x) * im.channels);
    }
  }
  return { data: out, width: w, height: h, channels: im.channels };
}

export interface MarkArgs {
  src: string;
  out: string;
  shapes: Shape[];
  options: RenderOptions;
}

// The written file and its size: « out.png 393x240 ».
export async function markFile(a: MarkArgs): Promise<string> {
  const im = await render(await readRgba(a.src), a.shapes, a.options);
  await writeImage(toChannels(im, 3), a.out);
  return `${a.out} ${im.width}x${im.height}`;
}

export async function main(argv: string[], io: Io): Promise<number> {
  const args = [...argv];
  if (!args.length || args[0]!.startsWith('--')) {
    io.err(DOC);
    return 1;
  }
  const src = args.shift()!;
  let out: string | null = null;
  const boxes: Shape[] = [];
  const circles: Shape[] = [];
  const options: RenderOptions = { crop: null, pad: 32, zoom: 1, dim: false, color: COLOR, grow: 10 };
  try {
    const take = (a: string): string => {
      const v = args.shift();
      if (v === undefined) throw new Error(`${a} needs a value`);
      return v;
    };
    const int = (a: string): number => {
      const v = take(a);
      const n = pyInt(v);
      if (n === null) throw new Error(`invalid literal for int() with base 10: '${v}'`);
      return n;
    };
    while (args.length) {
      const a = args.shift()!;
      if (a === '--out') out = take(a);
      else if (a === '--box') {
        const { nums, label } = parseShape(take(a));
        if (nums.length !== 4) throw new Error(`--box wants x,y,w,h, got ${nums.length} values`);
        boxes.push({ kind: 'box', v: nums, label });
      } else if (a === '--circle') {
        const { nums, label } = parseShape(take(a));
        if (nums.length !== 3) throw new Error(`--circle wants cx,cy,r, got ${nums.length} values`);
        circles.push({ kind: 'circle', v: nums, label });
      } else if (a === '--crop') {
        const v = take(a);
        options.crop = v === 'auto' ? 'auto' : parseShape(v).nums;
      } else if (a === '--pad') options.pad = int(a);
      else if (a === '--grow') options.grow = int(a);
      else if (a === '--zoom') {
        const v = take(a);
        const z = pyFloat(v);
        if (z === null) throw new Error(`could not convert string to float: '${v}'`);
        options.zoom = z;
      } else if (a === '--dim') options.dim = true;
      else if (a === '--color') options.color = `#${take(a).replace(/^#+/, '')}`;
      else {
        io.err(`unknown option ${a}\n${DOC}`);
        return 1;
      }
    }
  } catch (e) {
    io.err(`mark: ${(e as Error).message}\n`);
    return 1;
  }
  if (!out) {
    io.err('--out is required\n');
    return 1;
  }
  try {
    io.out(`${await markFile({ src, out, shapes: [...boxes, ...circles], options })}\n`);
  } catch (e) {
    io.err(`mark: ${(e as Error).message}\n`);
    return 1;
  }
  return 0;
}
