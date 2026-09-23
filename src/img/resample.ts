// Pillow's Lanczos resampler, pure: no sharp, so a worker thread can load it alone.
import type { Raster } from './raster.ts';

// resize(size, LANCZOS), Pillow's resampler to the byte: a Lanczos-3 kernel stretched by the scale,
// coefficients normalised then rounded to 22-bit fixed point, a horizontal pass then a vertical one,
// each clipped to 8 bits. A 1x capture written here is the one every earlier version wrote, so a
// diff against an older baseline compares pictures, not resamplers (libvips' Lanczos, close as it
// is, moved edges by up to 20 levels).
const PRECISION = 22;

function sinc(x: number): number {
  if (x === 0) return 1;
  const px = x * Math.PI;
  return Math.sin(px) / px;
}
const lanczos = (x: number): number => (x >= -3 && x < 3 ? sinc(x) * sinc(x / 3) : 0);

function coeffs(inSize: number, outSize: number): { ksize: number; bounds: Int32Array; kk: Int32Array } {
  const scale = inSize / outSize;
  const filterscale = Math.max(1, scale);
  const support = 3 * filterscale;
  const ksize = Math.ceil(support) * 2 + 1;
  const bounds = new Int32Array(outSize * 2);
  const kk = new Int32Array(outSize * ksize);
  const k = new Float64Array(ksize);
  for (let xx = 0; xx < outSize; xx++) {
    const center = (xx + 0.5) * scale;
    const ss = 1 / filterscale;
    const xmin = Math.max(0, Math.trunc(center - support + 0.5));
    const xmax = Math.min(inSize, Math.trunc(center + support + 0.5)) - xmin;
    let ww = 0;
    for (let x = 0; x < xmax; x++) {
      k[x] = lanczos((x + xmin - center + 0.5) * ss);
      ww += k[x]!;
    }
    for (let x = 0; x < xmax; x++) {
      const w = ww !== 0 ? k[x]! / ww : k[x]!;
      kk[xx * ksize + x] = w < 0 ? Math.trunc(-0.5 + w * (1 << PRECISION)) : Math.trunc(0.5 + w * (1 << PRECISION));
    }
    bounds[xx * 2] = xmin;
    bounds[xx * 2 + 1] = xmax;
  }
  return { ksize, bounds, kk };
}

const clip8 = (v: number): number => (v >= 1 << (PRECISION + 8) ? 255 : v <= 0 ? 0 : v >> PRECISION);

// One output row of the horizontal pass. The passes are split per row so V8 compiles each as a whole
// function: a long loop compiled on the fly (OSR) kept deoptimising and tripled the time.
function hRow(src: Uint8Array, line: number, dst: Uint8Array, q: number, width: number, c: number, bounds: Int32Array, kk: Int32Array, ksize: number): void {
  const half = 1 << (PRECISION - 1);
  for (let xx = 0; xx < width; xx++) {
    const xmin = bounds[xx * 2]!;
    const xmax = bounds[xx * 2 + 1]!;
    const kb = xx * ksize;
    const p = line + xmin * c;
    for (let ch = 0; ch < c; ch++) {
      let ss = half;
      for (let x = 0, pp = p + ch; x < xmax; x++, pp += c) ss = (ss + Math.imul(src[pp]!, kk[kb + x]!)) | 0;
      dst[q++] = clip8(ss);
    }
  }
}

function hRow3(src: Uint8Array, line: number, dst: Uint8Array, q: number, width: number, bounds: Int32Array, kk: Int32Array, ksize: number): void {
  const half = 1 << (PRECISION - 1);
  for (let xx = 0; xx < width; xx++) {
    const xmin = bounds[xx * 2]!;
    const xmax = bounds[xx * 2 + 1]!;
    const kb = xx * ksize;
    let p = line + xmin * 3;
    let s0 = half;
    let s1 = half;
    let s2 = half;
    for (let x = 0; x < xmax; x++, p += 3) {
      const k = kk[kb + x]!;
      s0 = (s0 + Math.imul(src[p]!, k)) | 0;
      s1 = (s1 + Math.imul(src[p + 1]!, k)) | 0;
      s2 = (s2 + Math.imul(src[p + 2]!, k)) | 0;
    }
    dst[q] = clip8(s0);
    dst[q + 1] = clip8(s1);
    dst[q + 2] = clip8(s2);
    q += 3;
  }
}

function horizontal(src: Uint8Array, sw: number, c: number, first: number, rows: number, width: number, h: ReturnType<typeof coeffs>): Uint8Array {
  const tmp = new Uint8Array(width * rows * c);
  for (let y = 0; y < rows; y++) {
    if (c === 3) hRow3(src, (y + first) * sw * 3, tmp, y * width * 3, width, h.bounds, h.kk, h.ksize);
    else hRow(src, (y + first) * sw * c, tmp, y * width * c, width, c, h.bounds, h.kk, h.ksize);
  }
  return tmp;
}

function accumulate(acc: Int32Array, src: Uint8Array, row: number, k: number, stride: number): void {
  for (let i = 0; i < stride; i++) acc[i] = (acc[i]! + Math.imul(src[row + i]!, k)) | 0;
}

function clipRow(acc: Int32Array, out: Uint8Array, o: number, stride: number): void {
  for (let i = 0; i < stride; i++) out[o + i] = clip8(acc[i]!);
}

function vertical(src: Uint8Array, stride: number, offset: number, height: number, v: ReturnType<typeof coeffs>): Uint8Array {
  const out = new Uint8Array(stride * height);
  const acc = new Int32Array(stride);
  const half = 1 << (PRECISION - 1);
  for (let yy = 0; yy < height; yy++) {
    const ymin = v.bounds[yy * 2]! - offset;
    const ymax = v.bounds[yy * 2 + 1]!;
    const kb = yy * v.ksize;
    acc.fill(half);
    for (let y = 0; y < ymax; y++) accumulate(acc, src, (ymin + y) * stride, v.kk[kb + y]!, stride);
    clipRow(acc, out, yy * stride, stride);
  }
  return out;
}

export function resize(img: Raster, width: number, height: number): Raster {
  const c = img.channels;
  if (width === img.width && height === img.height) return { ...img, data: img.data.slice() };
  const v = coeffs(img.height, height);
  let src = img.data;
  let offset = 0;
  if (width !== img.width) {
    const first = v.bounds[0]!;
    const last = v.bounds[height * 2 - 2]! + v.bounds[height * 2 - 1]!;
    src = horizontal(src, img.width, c, first, last - first, width, coeffs(img.width, width));
    offset = first;
  }
  if (height === img.height) return { data: src, width, height, channels: c };
  return { data: vertical(src, width * c, offset, height, v), width, height, channels: c };
}
