// A device-pixel screen capture brought down to 1x: `adb exec-out screencap -p | screencap`.
//
//   screencap --scale <px per dp> --out <capture.png> [<raw.png>]
//
// The raw PNG comes on stdin (or from a file). `adb exec-out` may put a warning line before it, so
// the image is read from its PNG signature on. It is resized by 1/scale (2.625 on a Pixel 8: 1080x2400
// becomes 411x914 dp), the size every other vysu capture and box is counted in: a quarter of the
// pixels, a quarter of the tokens, and the boxes of a diff come out in the dp a press is given in.
// Exit 0 written, 2 no image.
import { readFileSync } from 'node:fs';
import { pyRound } from '../core/py.ts';
import { parseArgs, type ParserSpec } from './args.ts';
import { readRgb, reduce, resize, writeImage, type Raster } from './raster.ts';
import type { Io } from './tools.ts';

const SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

// The 1x picture of a device-pixel one. reduce() averages whole pixel blocks first (cheap, no
// ringing), Lanczos does the fraction.
export function to1x(im: Raster, scale: number): Raster {
  if (!(scale > 1)) return im;
  if (Number.isInteger(scale)) return reduce(im, scale);
  return resize(im, Math.max(1, pyRound(im.width / scale)), Math.max(1, pyRound(im.height / scale)));
}

export class ScreencapError extends Error {}

// Raw screencap output (a warning line may come first) → the 1x capture at `out`.
export async function screencap(data: Buffer, scale: number, out: string): Promise<void> {
  const start = data.indexOf(SIGNATURE);
  if (start < 0) throw new ScreencapError(`screencap: no PNG in ${data.length} bytes of output`);
  let im: Raster;
  try {
    im = await readRgb(data.subarray(start));
  } catch (e) {
    throw new ScreencapError(`screencap: ${(e as Error).message}`);
  }
  await writeImage(to1x(im, scale), out);
}

const SPEC: ParserSpec = {
  prog: 'screencap.py',
  usage: 'usage: screencap.py [-h] --scale SCALE --out OUT [raw]',
  pos: [{ name: 'raw', nargs: '?' }],
  opts: {
    '--scale': { kind: 'float', required: true },
    '--out': { kind: 'str', required: true },
  },
};

export async function main(argv: string[], io: Io): Promise<number> {
  const a = parseArgs(SPEC, argv, io);
  if (typeof a === 'number') return a;
  const data = a.raw ? readFileSync(a.raw as string) : (io.stdin ?? readFileSync(0));
  try {
    await screencap(data, a.scale as number, a.out as string);
  } catch (e) {
    if (!(e instanceof ScreencapError)) throw e;
    io.err(`${e.message}\n`);
    return 2;
  }
  return 0;
}
