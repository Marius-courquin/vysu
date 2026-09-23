// The size of a PNG, read from its header: 24 bytes, no decoder.
import { closeSync, openSync, readSync } from 'node:fs';

export function pngSize(file: string): { width: number; height: number } {
  const fd = openSync(file, 'r');
  try {
    const b = Buffer.alloc(24);
    readSync(fd, b, 0, 24, 0);
    if (b.readUInt32BE(0) !== 0x89504e47 || b.toString('ascii', 12, 16) !== 'IHDR') throw new Error(`${file} is not a PNG`);
    return { width: b.readUInt32BE(16), height: b.readUInt32BE(20) };
  } finally {
    closeSync(fd);
  }
}

// A float the way Python's repr() writes it: « 3.0 » where JavaScript says « 3 ». The scale cache
// and every --scale handed to a helper are written that way, and every version reads them back.
export function pyFloat(x: number): string {
  if (Number.isInteger(x)) return `${x}.0`;
  return String(x);
}
