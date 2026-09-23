// numpy's sums, to the last bit. A stitch offset or a flashing row is chosen by comparing scores
// against thresholds and each other; summed in another order, two scores that tied under numpy may
// not, and the report would name another offset. numpy adds pairwise (eight accumulators up to 128
// items, halves above), a reduction working through its 8192-item buffer one chunk at a time.

const BUFSIZE = 8192;

function pairwise(a: Float64Array, off: number, n: number, stride: number): number {
  if (n < 8) {
    let r = 0;
    for (let i = 0; i < n; i++) r += a[off + i * stride]!;
    return r;
  }
  if (n <= 128) {
    let r0 = a[off]!;
    let r1 = a[off + stride]!;
    let r2 = a[off + 2 * stride]!;
    let r3 = a[off + 3 * stride]!;
    let r4 = a[off + 4 * stride]!;
    let r5 = a[off + 5 * stride]!;
    let r6 = a[off + 6 * stride]!;
    let r7 = a[off + 7 * stride]!;
    let i = 8;
    for (; i < n - (n % 8); i += 8) {
      const p = off + i * stride;
      r0 += a[p]!;
      r1 += a[p + stride]!;
      r2 += a[p + 2 * stride]!;
      r3 += a[p + 3 * stride]!;
      r4 += a[p + 4 * stride]!;
      r5 += a[p + 5 * stride]!;
      r6 += a[p + 6 * stride]!;
      r7 += a[p + 7 * stride]!;
    }
    let res = r0 + r1 + (r2 + r3) + (r4 + r5 + (r6 + r7));
    for (; i < n; i++) res += a[off + i * stride]!;
    return res;
  }
  let n2 = Math.floor(n / 2);
  n2 -= n2 % 8;
  return pairwise(a, off, n2, stride) + pairwise(a, off + n2 * stride, n - n2, stride);
}

// arr.sum() of a contiguous float64 array (or a contiguous run of one).
export function sum64(a: Float64Array, off = 0, n = a.length - off): number {
  let r = 0;
  for (let i = 0; i < n; i += BUFSIZE) r += pairwise(a, off + i, Math.min(BUFSIZE, n - i), 1);
  return r;
}

// The sum of rows that do not follow each other in memory (a[::4]): one inner loop per row.
export function sumRows(a: Float64Array, starts: number[], len: number): number {
  let r = 0;
  for (const s of starts) r += pairwise(a, s, len, 1);
  return r;
}

// arr.std() given the values in a contiguous copy and the mean numpy computed first.
export function std64(values: Float64Array, mean: number): number {
  const dev = new Float64Array(values.length);
  for (let i = 0; i < values.length; i++) {
    const d = values[i]! - mean;
    dev[i] = d * d;
  }
  return Math.sqrt(sum64(dev) / values.length);
}

// A float32 array's own sum, in float32 (mean() of float32 keeps float32), `stride` apart.
export function sum32(a: Float32Array, off: number, n: number, stride: number): number {
  const f = Math.fround;
  if (n < 8) {
    let r = 0;
    for (let i = 0; i < n; i++) r = f(r + a[off + i * stride]!);
    return r;
  }
  if (n <= 128) {
    const r = [0, 1, 2, 3, 4, 5, 6, 7].map((k) => a[off + k * stride]!);
    let i = 8;
    for (; i < n - (n % 8); i += 8) for (let k = 0; k < 8; k++) r[k] = f(r[k]! + a[off + (i + k) * stride]!);
    let res = f(f(f(r[0]! + r[1]!) + f(r[2]! + r[3]!)) + f(f(r[4]! + r[5]!) + f(r[6]! + r[7]!)));
    for (; i < n; i++) res = f(res + a[off + i * stride]!);
    return res;
  }
  let n2 = Math.floor(n / 2);
  n2 -= n2 % 8;
  return f(sum32(a, off, n2, stride) + sum32(a, off + n2 * stride, n - n2, stride));
}
