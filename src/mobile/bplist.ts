// Binary property lists (bplist00), read and written the way Python's plistlib does: locationd's
// clients.plist to read a location permission back, SpringBoard's BulletinBoard file and the
// NSKeyedArchiver sections inside it to grant, deny or reset notifications. Integers, reals, dates,
// data, strings, UIDs, arrays and dictionaries; a real stays a real and a UID a UID through a round
// trip.
import { readFileSync } from 'node:fs';
import { runBuffer } from '../core/proc.ts';

export class Real {
  readonly value: number;
  constructor(value: number) {
    this.value = value;
  }
}
export class Uid {
  readonly value: number;
  constructor(value: number) {
    this.value = value;
  }
}
export type PValue = null | boolean | number | bigint | Real | Date | Uint8Array | string | Uid | PValue[] | PDict;
export interface PDict {
  [key: string]: PValue;
}

const EPOCH_2001 = Date.UTC(2001, 0, 1);

export function isBinaryPlist(b: Uint8Array): boolean {
  return b.length >= 40 && Buffer.from(b.subarray(0, 8)).toString('latin1') === 'bplist00';
}

export function parseBplist(input: Uint8Array): PValue {
  const b = Buffer.from(input.buffer, input.byteOffset, input.byteLength);
  if (!isBinaryPlist(b)) throw new Error('not a binary plist');
  const t = b.length - 32;
  const offsetSize = b[t + 6]!;
  const refSize = b[t + 7]!;
  const numObjects = Number(b.readBigUInt64BE(t + 8));
  const top = Number(b.readBigUInt64BE(t + 16));
  const tableAt = Number(b.readBigUInt64BE(t + 24));
  const uint = (at: number, size: number): number => {
    let v = 0;
    for (let i = 0; i < size; i++) v = v * 256 + b[at + i]!;
    return v;
  };
  const offsets: number[] = [];
  for (let i = 0; i < numObjects; i++) offsets.push(uint(tableAt + i * offsetSize, offsetSize));
  const seen = new Set<number>();
  const read = (ref: number): PValue => {
    if (seen.has(ref)) throw new Error('recursive plist');
    seen.add(ref);
    try {
      return readAt(offsets[ref]!);
    } finally {
      seen.delete(ref);
    }
  };
  // A count in the low nibble, or 0xF and an integer object after the marker.
  const count = (at: number): [number, number] => {
    const low = b[at]! & 0x0f;
    if (low !== 0x0f) return [low, at + 1];
    const size = 1 << (b[at + 1]! & 0x0f);
    return [uint(at + 2, size), at + 2 + size];
  };
  const readAt = (at: number): PValue => {
    const m = b[at]!;
    const hi = m >> 4;
    const lo = m & 0x0f;
    switch (hi) {
      case 0x0:
        if (m === 0x00) return null;
        if (m === 0x08) return false;
        if (m === 0x09) return true;
        throw new Error(`unknown plist marker 0x${m.toString(16)}`);
      case 0x1: {
        const size = 1 << lo;
        if (size === 8) {
          const v = b.readBigInt64BE(at + 1);
          return v >= BigInt(Number.MIN_SAFE_INTEGER) && v <= BigInt(Number.MAX_SAFE_INTEGER) ? Number(v) : v;
        }
        if (size === 16) return BigInt(`0x${b.subarray(at + 1, at + 17).toString('hex')}`);
        return uint(at + 1, size);
      }
      case 0x2:
        return new Real(lo === 2 ? b.readFloatBE(at + 1) : b.readDoubleBE(at + 1));
      case 0x3:
        return new Date(EPOCH_2001 + b.readDoubleBE(at + 1) * 1000);
      case 0x4: {
        const [n, from] = count(at);
        return new Uint8Array(b.subarray(from, from + n));
      }
      case 0x5: {
        const [n, from] = count(at);
        return b.toString('latin1', from, from + n);
      }
      case 0x6: {
        const [n, from] = count(at);
        const u = Buffer.from(b.subarray(from, from + n * 2));
        u.swap16();
        return u.toString('utf16le');
      }
      case 0x8:
        return new Uid(uint(at + 1, lo + 1));
      case 0xa:
      case 0xc: {
        const [n, from] = count(at);
        const out: PValue[] = [];
        for (let i = 0; i < n; i++) out.push(read(uint(from + i * refSize, refSize)));
        return out;
      }
      case 0xd: {
        const [n, from] = count(at);
        const out: PDict = {};
        for (let i = 0; i < n; i++) {
          const k = read(uint(from + i * refSize, refSize));
          out[String(k)] = read(uint(from + (n + i) * refSize, refSize));
        }
        return out;
      }
      default:
        throw new Error(`unknown plist marker 0x${m.toString(16)}`);
    }
  };
  return read(top);
}

export function buildBplist(root: PValue): Buffer {
  // Objects in the order they are first met, scalars shared: what plistlib writes too.
  const objects: PValue[] = [];
  const scalarIds = new Map<string, number>();
  const refs = new Map<object, number>();
  const scalarKey = (v: PValue): string | null => {
    if (v === null) return 'null';
    if (typeof v === 'boolean') return `b:${v}`;
    if (typeof v === 'number' || typeof v === 'bigint') return `i:${v}`;
    if (typeof v === 'string') return `s:${v}`;
    if (v instanceof Real) return `r:${v.value}`;
    if (v instanceof Uid) return `u:${v.value}`;
    return null;
  };
  const flatten = (v: PValue): number => {
    const key = scalarKey(v);
    if (key !== null) {
      const hit = scalarIds.get(key);
      if (hit !== undefined) return hit;
      scalarIds.set(key, objects.length);
      objects.push(v);
      return objects.length - 1;
    }
    const o = v as object;
    const hit = refs.get(o);
    if (hit !== undefined) return hit;
    const id = objects.length;
    refs.set(o, id);
    objects.push(v);
    if (Array.isArray(v)) v.forEach(flatten);
    else if (!(v instanceof Date) && !(v instanceof Uint8Array)) {
      const d = v as PDict;
      Object.keys(d).forEach((k) => flatten(k));
      Object.values(d).forEach(flatten);
    }
    return id;
  };
  flatten(root);
  const refSize = objects.length < 256 ? 1 : objects.length < 65536 ? 2 : 4;
  const idOf = (v: PValue): number => {
    const key = scalarKey(v);
    return key !== null ? scalarIds.get(key)! : refs.get(v as object)!;
  };
  const chunks: Buffer[] = [Buffer.from('bplist00', 'latin1')];
  let pos = 8;
  const offsets: number[] = [];
  const push = (buf: Buffer): void => {
    chunks.push(buf);
    pos += buf.length;
  };
  const intBytes = (n: number): Buffer => {
    if (n < 0) {
      const x = Buffer.alloc(9);
      x[0] = 0x13;
      x.writeBigInt64BE(BigInt(n), 1);
      return x;
    }
    if (n < 0x100) return Buffer.from([0x10, n]);
    if (n < 0x10000) {
      const x = Buffer.alloc(3);
      x[0] = 0x11;
      x.writeUInt16BE(n, 1);
      return x;
    }
    if (n < 0x100000000) {
      const x = Buffer.alloc(5);
      x[0] = 0x12;
      x.writeUInt32BE(n, 1);
      return x;
    }
    const x = Buffer.alloc(9);
    x[0] = 0x13;
    x.writeBigInt64BE(BigInt(n), 1);
    return x;
  };
  const marker = (hi: number, n: number): Buffer => (n < 15 ? Buffer.from([(hi << 4) | n]) : Buffer.concat([Buffer.from([(hi << 4) | 0x0f]), intBytes(n)]));
  const refBytes = (ids: number[]): Buffer => {
    const x = Buffer.alloc(ids.length * refSize);
    ids.forEach((id, i) => {
      if (refSize === 1) x.writeUInt8(id, i);
      else if (refSize === 2) x.writeUInt16BE(id, i * 2);
      else x.writeUInt32BE(id, i * 4);
    });
    return x;
  };
  for (const v of objects) {
    offsets.push(pos);
    if (v === null) push(Buffer.from([0x00]));
    else if (v === false) push(Buffer.from([0x08]));
    else if (v === true) push(Buffer.from([0x09]));
    else if (typeof v === 'number') push(intBytes(v));
    else if (typeof v === 'bigint') {
      const x = Buffer.alloc(17);
      x[0] = 0x14;
      x.writeBigUInt64BE(v >> 64n, 1);
      x.writeBigUInt64BE(v & 0xffffffffffffffffn, 9);
      push(x);
    } else if (v instanceof Real) {
      const x = Buffer.alloc(9);
      x[0] = 0x23;
      x.writeDoubleBE(v.value, 1);
      push(x);
    } else if (v instanceof Date) {
      const x = Buffer.alloc(9);
      x[0] = 0x33;
      x.writeDoubleBE((v.getTime() - EPOCH_2001) / 1000, 1);
      push(x);
    } else if (v instanceof Uint8Array) push(Buffer.concat([marker(0x4, v.length), Buffer.from(v)]));
    else if (typeof v === 'string') {
      if (/^[\x00-\x7f]*$/.test(v)) push(Buffer.concat([marker(0x5, v.length), Buffer.from(v, 'latin1')]));
      else {
        const u = Buffer.from(v, 'utf16le');
        u.swap16();
        push(Buffer.concat([marker(0x6, u.length / 2), u]));
      }
    } else if (v instanceof Uid) {
      const n = v.value;
      const size = n < 0x100 ? 1 : n < 0x10000 ? 2 : 4;
      const x = Buffer.alloc(1 + size);
      x[0] = 0x80 | (size - 1);
      if (size === 1) x.writeUInt8(n, 1);
      else if (size === 2) x.writeUInt16BE(n, 1);
      else x.writeUInt32BE(n, 1);
      push(x);
    } else if (Array.isArray(v)) push(Buffer.concat([marker(0xa, v.length), refBytes(v.map(idOf))]));
    else {
      const d = v as PDict;
      const keys = Object.keys(d);
      push(Buffer.concat([marker(0xd, keys.length), refBytes(keys.map(idOf)), refBytes(Object.values(d).map(idOf))]));
    }
  }
  const tableAt = pos;
  const offsetSize = tableAt < 0x100 ? 1 : tableAt < 0x10000 ? 2 : tableAt < 0x100000000 ? 4 : 8;
  const table = Buffer.alloc(offsets.length * offsetSize);
  offsets.forEach((o, i) => {
    if (offsetSize === 1) table.writeUInt8(o, i);
    else if (offsetSize === 2) table.writeUInt16BE(o, i * 2);
    else if (offsetSize === 4) table.writeUInt32BE(o, i * 4);
    else table.writeBigUInt64BE(BigInt(o), i * 8);
  });
  push(table);
  const trailer = Buffer.alloc(32);
  trailer[6] = offsetSize;
  trailer[7] = refSize;
  trailer.writeBigUInt64BE(BigInt(objects.length), 8);
  trailer.writeBigUInt64BE(0n, 16);
  trailer.writeBigUInt64BE(BigInt(tableAt), 24);
  push(trailer);
  return Buffer.concat(chunks);
}

// A plist file of either kind: XML ones go through plutil first (the files read here live on a Mac:
// a simulator's own), binary ones are read as they are.
export async function readPlistFile(file: string): Promise<PValue> {
  const raw = readFileSync(file);
  if (isBinaryPlist(raw)) return parseBplist(raw);
  const r = await runBuffer('plutil', ['-convert', 'binary1', '-o', '-', file]);
  if (r.code !== 0) throw new Error(`plutil: ${r.stderr.trim()}`);
  return parseBplist(r.stdout);
}
