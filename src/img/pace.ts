// pace — how a person types, so a recorded take does not type like a machine.
//
// A take is watched: a field that fills in a blink reads as a paste, and a demo loses the moment the
// viewer is meant to follow. While vysu records, every `fill` and `type` goes through this pace
// instead. In a browser: an average of VYSU_TYPE_CPS characters a second (14 by default, about 11
// once the pauses are counted; 8 read as too slow on screen, the untouched driver as a paste), each
// keystroke a little early or late, a short beat after a space, a longer one after punctuation, now
// and then a hesitation. The rhythm is drawn from the text itself, so a re-take types the same way:
// CPython's own generator, seeded as random.Random seeds it, so a take typed before the port types
// the same after it.
//
//   pace js <text>       a browser script: types into the focused field, one input event a key
//   pace chunks <text>   one line per short run, « <delay ms>\t<pause after ms>\t<text> », for a
//                        device driver: each run typed at the driver's own speed (delay 0)
import { createHash } from 'node:crypto';
import { config } from '../core/ctx.ts';
import { pyRound } from '../core/py.ts';
import { pyFloat, pyInt, pyJson } from './fmt.ts';
import type { Io } from './tools.ts';

const PUNCTUATION = '.,;:!?…';

const DOC = `pace.py: how a person types, so a recorded take does not type like a machine.

A take is watched: a field that fills in a blink reads as a paste, and a demo loses the moment the
viewer is meant to follow. While vysu records, every \`fill\` and \`type\` goes through this pace
instead. In a browser: an average of VYSU_TYPE_CPS characters a second (14 by default, about 11
once the pauses are counted; 8 read as too slow on screen, the untouched driver as a paste), each
keystroke a little early or late, a short beat after a space, a longer one after
punctuation, now and then a hesitation. The rhythm is drawn from the text itself, so a re-take
types the same way.

  pace.py js <text>       a browser script: types into the focused field, one input event a key
  pace.py chunks <text>   one line per short run, « <delay ms>\\t<pause after ms>\\t<text> », for
                          a device driver: each run typed at the driver's own speed (delay 0)
`;

// random.Random(<str>): MT19937, seeded the way CPython seeds it with a string — its UTF-8 bytes and
// their SHA-512 read as one big-endian integer, handed to init_by_array in 32-bit words, least
// significant first — and random() built from two draws, 53 bits.
export class PyRandom {
  private readonly mt = new Uint32Array(624);
  private index = 624;

  constructor(seed: string) {
    const bytes = Buffer.from(seed, 'utf8');
    const all = Buffer.concat([bytes, createHash('sha512').update(bytes).digest()]);
    let first = 0;
    while (first < all.length && all[first] === 0) first++;
    const sig = all.subarray(first);
    const bits = sig.length ? (sig.length - 1) * 8 + (32 - Math.clz32(sig[0]!)) : 0;
    const used = bits === 0 ? 1 : Math.floor((bits - 1) / 32) + 1;
    const key = new Uint32Array(used);
    for (let j = 0; j < used; j++) {
      let w = 0;
      for (let b = 0; b < 4; b++) {
        const at = sig.length - 1 - (4 * j + b);
        if (at >= 0) w |= sig[at]! << (8 * b);
      }
      key[j] = w >>> 0;
    }
    this.initByArray(key);
  }

  private initGenrand(s: number): void {
    const mt = this.mt;
    mt[0] = s >>> 0;
    for (let i = 1; i < 624; i++) mt[i] = Math.imul(1812433253, mt[i - 1]! ^ (mt[i - 1]! >>> 30)) + i;
    this.index = 624;
  }

  private initByArray(key: Uint32Array): void {
    const mt = this.mt;
    this.initGenrand(19650218);
    let i = 1;
    let j = 0;
    for (let k = Math.max(624, key.length); k; k--) {
      mt[i] = ((mt[i]! ^ Math.imul(mt[i - 1]! ^ (mt[i - 1]! >>> 30), 1664525)) >>> 0) + key[j]! + j;
      i++;
      j++;
      if (i >= 624) {
        mt[0] = mt[623]!;
        i = 1;
      }
      if (j >= key.length) j = 0;
    }
    for (let k = 623; k; k--) {
      mt[i] = ((mt[i]! ^ Math.imul(mt[i - 1]! ^ (mt[i - 1]! >>> 30), 1566083941)) >>> 0) - i;
      i++;
      if (i >= 624) {
        mt[0] = mt[623]!;
        i = 1;
      }
    }
    mt[0] = 0x80000000;
  }

  private next(): number {
    const mt = this.mt;
    if (this.index >= 624) {
      const twist = (kk: number, next: number, far: number): void => {
        const y = (mt[kk]! & 0x80000000) | (mt[next]! & 0x7fffffff);
        mt[kk] = mt[far]! ^ (y >>> 1) ^ (y & 1 ? 0x9908b0df : 0);
      };
      let kk = 0;
      for (; kk < 624 - 397; kk++) twist(kk, kk + 1, kk + 397);
      for (; kk < 623; kk++) twist(kk, kk + 1, kk + 397 - 624);
      twist(623, 0, 396);
      this.index = 0;
    }
    let y = mt[this.index++]!;
    y ^= y >>> 11;
    y ^= (y << 7) & 0x9d2c5680;
    y ^= (y << 15) & 0xefc60000;
    y ^= y >>> 18;
    return y >>> 0;
  }

  random(): number {
    const a = this.next() >>> 5;
    const b = this.next() >>> 6;
    return (a * 67108864 + b) * (1 / 9007199254740992);
  }

  uniform(a: number, b: number): number {
    return a + (b - a) * this.random();
  }
}

// VYSU_TYPE_CPS: a float, 14 when it is not one, kept within 1..40.
export function typeCps(raw = config().get('TYPE_CPS')): number {
  const v = pyFloat(raw || '14') ?? 14;
  const floor = v > 1 ? v : 1;
  return floor < 40 ? floor : 40;
}

// Milliseconds to wait AFTER each character (code point) of `text`.
export function delays(text: string, cps = typeCps()): number[] {
  const rnd = new PyRandom(text);
  const base = 1000 / cps;
  return Array.from(text, (ch) => {
    let d = base * rnd.uniform(0.65, 1.4);
    if (ch === ' ') d += base * 0.35;
    else if (PUNCTUATION.includes(ch)) d += 180;
    if (rnd.random() < 0.03) d += rnd.uniform(120, 260);
    return pyRound(d);
  });
}

// A device cannot type at a person's pace one key at a time: agent-device's own --delay-ms sends every
// character as a call of its own, about a third of a second each on an iOS simulator, which typed 20
// characters in 14 s. So a device types short runs at the driver's native speed (about 13 characters
// a second), and the round trip between two runs is the beat a person leaves between two words:
// bursts of a word or so, about 8 characters a second in all. VYSU_TYPE_RUN changes the run.
export function typeRun(raw = config().get('TYPE_RUN')): number {
  const v = pyInt(raw || '7');
  if (v === null) return 7;
  return v > 2 ? v : 2;
}

// The beat between two runs. The bash engine never slept it: it was the round trip of the CLI call
// that typed each run — a Node start-up, the device lock, a Python parse of the answer, about 0.35 s
// more than the typing itself — and the library client pays none of it: without it an Android
// emulator typed 47 characters a second (the bash engine 13.5), a paste again.
export const RUN_BEAT_MS = 350;

export interface Chunk {
  // Milliseconds between two keys of the run (0: the driver's own speed), and after the run.
  delay: number;
  pause: number;
  text: string;
}

// The text cut into runs of about `run` characters, at a space when there is one near, inside a long
// word otherwise; each run typed at the driver's own speed, with a short pause after punctuation.
export function chunks(text: string, run = typeRun()): Chunk[] {
  const s = Array.from(text);
  const lastSpace = (from: number, to: number): number => {
    for (let k = Math.min(to, s.length) - 1; k >= from; k--) if (s[k] === ' ') return k;
    return -1;
  };
  const out: Chunk[] = [];
  let start = 0;
  while (start < s.length) {
    let end = Math.min(s.length, start + run);
    if (end < s.length) {
      const space = lastSpace(start + 2, end + 3);
      end = space > start ? space : end;
    }
    out.push({ delay: 0, pause: PUNCTUATION.includes(s[end - 1]!) ? 150 : 0, text: s.slice(start, end).join('') });
    start = end;
  }
  return out;
}

export function js(text: string, cps = typeCps()): string {
  return (
    `(async () => { const s = Array.from(${pyJson(text)}); const d = ${pyJson(delays(text, cps))}; ` +
    'const el = document.activeElement; ' +
    "if (!el || !('value' in el || el.isContentEditable)) return 'no focused field'; " +
    'for (let i = 0; i < s.length; i++) { ' +
    "document.execCommand('insertText', false, s[i]); " +
    'await new Promise((r) => setTimeout(r, d[i])); } ' +
    "return 'typed ' + s.length; })()"
  );
}

export async function main(argv: string[], io: Io): Promise<number> {
  const [how, text] = argv;
  if (argv.length !== 2 || (how !== 'js' && how !== 'chunks') || text === undefined) {
    io.err(`${DOC}\n`);
    return 1;
  }
  if (how === 'js') io.out(`${js(text)}\n`);
  else io.out(`${chunks(text).map((c) => `${c.delay}\t${c.pause}\t${c.text}`).join('\n')}\n`);
  return 0;
}
