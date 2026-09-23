// Pixels in and out, the way Pillow hands them over: `convert("RGB")` drops an
// alpha channel without blending it, `convert("L")` is Pillow's own integer luma, and an embedded
// colour profile is ignored (Pillow never applied one, and a diff of two captures must compare the
// bytes the device wrote). Decoding and resampling go through sharp; the maths runs over the raw
// buffers.
import { readFileSync } from 'node:fs';
import sharp, { type Sharp } from 'sharp';

// libvips caches an opened file by its name: a capture rewritten in place (an mshot, a burst frame)
// would come back as its previous picture to a long-lived engine calling this in-process.
sharp.cache(false);

export interface Raster {
  data: Uint8Array;
  width: number;
  height: number;
  channels: 1 | 3 | 4;
}

type Source = string | Buffer;

const input = (src: Source): Sharp => sharp(typeof src === 'string' ? readFileSync(src) : src, { ignoreIcc: true, limitInputPixels: false });

async function decode(img: Sharp, channels: 3 | 4): Promise<Raster> {
  const pipe = channels === 3 ? img.removeAlpha().toColourspace('srgb') : img.ensureAlpha().toColourspace('srgb');
  const { data, info } = await pipe.raw({ depth: 'uchar' }).toBuffer({ resolveWithObject: true });
  if (info.channels !== channels) throw new Error(`decoded ${info.channels} channels, expected ${channels}`);
  return { data: new Uint8Array(data.buffer, data.byteOffset, data.length), width: info.width, height: info.height, channels };
}

// Image.open(src).convert("RGB").
export const readRgb = (src: Source): Promise<Raster> => decode(input(src), 3);
// Image.open(src).convert("RGBA").
export const readRgba = (src: Source): Promise<Raster> => decode(input(src), 4);

export async function imageSize(src: Source): Promise<[number, number]> {
  const m = await input(src).metadata();
  return [m.width ?? 0, m.height ?? 0];
}

// convert("L"): Pillow's L24, R·19595 + G·38470 + B·7471 rounded, alpha ignored.
export function toGray(img: Raster): Uint8Array {
  const n = img.width * img.height;
  const out = new Uint8Array(n);
  const c = img.channels;
  const d = img.data;
  if (c === 1) return d.slice(0, n);
  for (let i = 0, j = 0; i < n; i++, j += c) out[i] = (d[j]! * 19595 + d[j + 1]! * 38470 + d[j + 2]! * 7471 + 0x8000) >>> 16;
  return out;
}

export const sharpOf = (img: Raster): Sharp =>
  sharp(img.data, { raw: { width: img.width, height: img.height, channels: img.channels } });

// Written the way Image.save wrote it: the format from the extension, PNG unless it says otherwise.
export async function writeImage(img: Raster | Sharp, out: string): Promise<void> {
  const s = 'data' in img ? sharpOf(img) : img;
  await s.toFile(out);
}

// resize(size, LANCZOS), Pillow's resampler to the byte (src/img/resample.ts).
export { resize } from './resample.ts';

// The same through libvips, for pictures nobody diffs (a thumbnail on a page, a zoomed mark): the
// same kernel, a few levels apart on the edges, several times faster.
export async function resizeFast(img: Raster, width: number, height: number): Promise<Raster> {
  if (width === img.width && height === img.height) return { ...img, data: img.data.slice() };
  const { data, info } = await sharpOf(img)
    .resize(width, height, { kernel: 'lanczos3', fit: 'fill' })
    .raw()
    .toBuffer({ resolveWithObject: true });
  return { data: new Uint8Array(data.buffer, data.byteOffset, data.length), width: info.width, height: info.height, channels: img.channels };
}

// Image.reduce(n): the mean of every n×n block, in Pillow's own fixed point, the last partial row and
// column averaged over the pixels they have. Byte for byte what every version has written for a 3x
// device, so a baseline captured before diffs clean.
export function reduce(img: Raster, n: number): Raster {
  const { width: w, height: h, channels: c, data } = img;
  const ow = Math.ceil(w / n);
  const oh = Math.ceil(h / n);
  const out = new Uint8Array(ow * oh * c);
  const sums = new Float64Array(c);
  for (let oy = 0; oy < oh; oy++) {
    const y0 = oy * n;
    const y1 = Math.min(h, y0 + n);
    for (let ox = 0; ox < ow; ox++) {
      const x0 = ox * n;
      const x1 = Math.min(w, x0 + n);
      const count = (y1 - y0) * (x1 - x0);
      sums.fill(0);
      for (let y = y0; y < y1; y++) {
        let p = (y * w + x0) * c;
        for (let x = x0; x < x1; x++) for (let k = 0; k < c; k++) sums[k]! += data[p++]!;
      }
      // division_UINT32(count, 8): 2^32 / (256·count), then (sum + count/2)·multiplier >> 24.
      const multiplier = Math.floor(4294967296 / (256 * count));
      const amend = Math.floor(count / 2);
      const q = (oy * ow + ox) * c;
      for (let k = 0; k < c; k++) out[q + k] = Math.floor(((sums[k]! + amend) * multiplier) / 16777216);
    }
  }
  return { data: out, width: ow, height: oh, channels: c };
}

// crop((x0, y0, x1, y1)) of a raster, the box already inside it.
export function crop(img: Raster, x0: number, y0: number, x1: number, y1: number): Raster {
  const w = Math.max(0, x1 - x0);
  const h = Math.max(0, y1 - y0);
  const c = img.channels;
  const out = new Uint8Array(w * h * c);
  for (let y = 0; y < h; y++) {
    const from = ((y0 + y) * img.width + x0) * c;
    out.set(img.data.subarray(from, from + w * c), y * w * c);
  }
  return { data: out, width: w, height: h, channels: c };
}

// Channels dropped or added as Pillow's convert does: RGBA → RGB keeps the colour, RGB → RGBA is opaque.
export function toChannels(img: Raster, channels: 3 | 4): Raster {
  if (img.channels === channels) return img;
  const n = img.width * img.height;
  const out = new Uint8Array(n * channels);
  const c = img.channels;
  for (let i = 0; i < n; i++) {
    const s = i * c;
    const d = i * channels;
    if (c === 1) out[d] = out[d + 1] = out[d + 2] = img.data[s]!;
    else {
      out[d] = img.data[s]!;
      out[d + 1] = img.data[s + 1]!;
      out[d + 2] = img.data[s + 2]!;
    }
    if (channels === 4) out[d + 3] = c === 4 ? img.data[s + 3]! : 255;
  }
  return { data: out, width: img.width, height: img.height, channels };
}
